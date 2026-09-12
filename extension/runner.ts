import {
  API_PREFIX,
  normalizeScanUrl,
  SCAN_LIMITS,
  type ScanControl,
  type ScanStatus,
} from '../shared/scan';
import {
  emptyResult,
  fetchPage,
  fetchRobots,
  type RobotsPolicy,
} from './fetch-page';
import {
  readScan,
  storeScan,
  type OutboxLimit,
  type StoredScan,
} from './state';

declare const __LOCAL_ORIGINS__: string[];

const status = document.querySelector<HTMLElement>('#status')!;
const sitesList = document.querySelector<HTMLUListElement>('#sites')!;
const startButton = document.querySelector<HTMLButtonElement>('#start')!;
const pauseButton = document.querySelector<HTMLButtonElement>('#pause')!;
const progress = document.querySelector<HTMLElement>('#progress')!;
const mapLink = document.querySelector<HTMLAnchorElement>('#map')!;
let state: StoredScan | undefined;
let stopped = false;
let running = false;

class ResultLimitError extends Error {
  constructor(readonly limit: OutboxLimit) {
    super(
      limit.code === 'scan_storage_limit'
        ? 'Kapacita této mapy je vyčerpaná. Výsledek zůstává uložený v rozšíření; pro další sken založte novou mapu.'
        : 'Dosažen limit stránek pro uložení výsledku. Zvyšte limit webu v mapě a pokračujte; čekající výsledek odešleme bez nového načítání.',
    );
  }
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function render() {
  if (!state) return;
  sitesList.replaceChildren(
    ...state.scan.sites.map((site) => {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = site.origin;
      const detail = document.createElement('span');
      const count = state!.visited.filter(
        (url) => new URL(url).origin === site.origin,
      ).length;
      detail.textContent = `${count} / ${site.maxPages} stránek · interval ${site.intervalMs / 1000} s${site.paused ? ' · pozastaveno' : ''}`;
      item.append(title, detail);
      return item;
    }),
  );
  progress.textContent = `${state.visited.length} zpracovaných stránek${state.outbox ? ' · 1 výsledek čeká na odeslání' : ''}`;
  startButton.disabled =
    running || state.outboxLimit?.code === 'scan_storage_limit';
  pauseButton.disabled = !running;
}

async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  if (!state) throw new Error('No paired scan.');
  const response = await fetch(
    `${state.apiOrigin}${API_PREFIX}/runner/scans/${encodeURIComponent(state.scan.id)}${path}`,
    {
      method,
      credentials: 'omit',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${state.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (response.status === 401 || response.status === 403)
    throw new Error('Spojení vypršelo. Spárujte rozšíření znovu z mapy.');
  if (response.status === 429 && path === '/results') {
    const detail = (await response.json().catch(() => ({}))) as {
      code?: string;
      maxPages?: number;
    };
    if (detail.code === 'page_limit' || detail.code === 'scan_storage_limit') {
      const sourceOrigin = new URL(state.outbox!.sourceUrl).origin;
      const maxPages =
        Number.isInteger(detail.maxPages) &&
        detail.maxPages! >= 1 &&
        detail.maxPages! <= SCAN_LIMITS.pagesPerSite
          ? detail.maxPages!
          : state.scan.sites.find((site) => site.origin === sourceOrigin)!
              .maxPages;
      throw new ResultLimitError(
        detail.code === 'scan_storage_limit'
          ? { code: 'scan_storage_limit' }
          : { code: 'page_limit', maxPages },
      );
    }
  }
  if (!response.ok)
    throw new Error(
      `Uložení nebo načtení stavu se nepodařilo (HTTP ${response.status}). Fronta zůstala uložená; zkuste pokračovat.`,
    );
  return response.json() as Promise<T>;
}

async function report(nextStatus: ScanStatus) {
  await api('/progress', 'POST', { status: nextStatus });
  state!.scan.status = nextStatus;
  await storeScan(state!);
}

function permitted(url: string): boolean {
  try {
    return (
      normalizeScanUrl(url) === url &&
      state!.scan.sites.some((site) => site.origin === new URL(url).origin)
    );
  } catch {
    return false;
  }
}

async function flushOutbox() {
  const current = state!;
  const result = current.outbox;
  if (!result) return;
  await api('/results', 'PUT', result);
  // Persist the acknowledgement together with queue discovery, never before upload.
  current.visited = [...new Set([...current.visited, result.sourceUrl])];
  const next = [
    ...current.queue.filter((url) => url !== result.sourceUrl),
    ...result.discoveredUrls.filter(permitted),
    ...result.links.map((link) => link.targetUrl).filter(permitted),
  ];
  current.queue = [...new Set(next)].filter(
    (url) => !current.visited.includes(url),
  );
  // No scan can fetch more than 50 pages per origin; keep a bounded pending frontier.
  const counts = new Map<string, number>();
  current.queue = current.queue.filter((url) => {
    const origin = new URL(url).origin;
    const count = counts.get(origin) ?? 0;
    counts.set(origin, count + 1);
    return count < SCAN_LIMITS.pagesPerSite;
  });
  current.outbox = null;
  delete current.outboxLimit;
  await storeScan(current);
  render();
}

async function run() {
  if (!state) return;
  running = true;
  stopped = false;
  render();
  const confirmedOrigins = new Set(state.scan.sites.map((site) => site.origin));
  const robots = new Map<string, RobotsPolicy>();
  const rateLimitedOrigins = new Set<string>();
  let lastControl = 0;
  let lastHeartbeat = 0;
  const refreshControl = async (heartbeat = true) => {
    if (Date.now() - lastControl < 1000) return;
    const control = await api<ScanControl>('/control');
    if (control.sites.some((site) => !confirmedOrigins.has(site.origin)))
      throw new Error(
        'Rozsah mapy se změnil. Otevřete z mapy novou skenovací kartu a potvrďte její domény.',
      );
    state!.scan = { ...state!.scan, ...control };
    lastControl = Date.now();
    if (control.status === 'paused') stopped = true;
    if (heartbeat && Date.now() - lastHeartbeat >= 10_000 && !stopped) {
      await report('running');
      lastHeartbeat = Date.now();
    }
    render();
  };
  try {
    if (state.outbox && state.outboxLimit) {
      const limit = state.outboxLimit;
      if (limit.code === 'scan_storage_limit')
        throw new ResultLimitError(limit);
      // A refused upload is retried only after reading a genuinely higher limit
      // from the API, including after reopening a card or pairing again.
      await refreshControl(false);
      const origin = new URL(state.outbox.sourceUrl).origin;
      if (
        state.scan.sites.find((site) => site.origin === origin)!.maxPages <=
        limit.maxPages
      )
        throw new ResultLimitError(limit);
      if (stopped) {
        status.textContent =
          'Sken je pozastavený. Nejdříve jej obnovte v mapě.';
        return;
      }
      delete state.outboxLimit;
      await storeScan(state);
    }
    const requestKeys = state.scan.sites.map(
      (site) => `request:${site.origin}`,
    );
    const previousRequests = await chrome.storage.local.get(requestKeys);
    for (const site of state.scan.sites) {
      const previous = previousRequests[`request:${site.origin}`];
      if (typeof previous === 'number')
        state.lastRequest[site.origin] = Math.max(
          state.lastRequest[site.origin] ?? 0,
          previous,
        );
    }
    await report('running');
    if (state.outbox?.httpStatus === 429)
      rateLimitedOrigins.add(new URL(state.outbox.sourceUrl).origin);
    await flushOutbox();
    while (!stopped) {
      await refreshControl();
      if (stopped) break;
      state.queue = state.queue.filter(
        (url) => permitted(url) && !state!.visited.includes(url),
      );
      const eligible = state.queue.filter((url) => {
        const site = state!.scan.sites.find(
          (item) => item.origin === new URL(url).origin,
        )!;
        return (
          !site.paused &&
          !rateLimitedOrigins.has(site.origin) &&
          state!.visited.filter(
            (value) => new URL(value).origin === site.origin,
          ).length < site.maxPages
        );
      });
      if (!eligible.length) {
        const paused =
          state.queue.some(
            (url) =>
              state!.scan.sites.find(
                (site) => site.origin === new URL(url).origin,
              )?.paused,
          ) || rateLimitedOrigins.size > 0;
        const finishStatus = paused
          ? 'paused'
          : state.queue.length
            ? 'limited'
            : 'completed';
        await report(finishStatus);
        status.textContent =
          rateLimitedOrigins.size > 0
            ? 'Server omezil požadavky (HTTP 429). Tento origin už nenačítám. Před obnovením skenu v mapě zvyšte interval nebo doménu pozastavte.'
            : paused
              ? 'Sken je pozastavený. Upravte pauzu domén v mapě a pokračujte.'
              : finishStatus === 'limited'
                ? 'Dosažen limit stránek. Výsledky najdete v mapě.'
                : 'Hotovo. Všechny objevené stránky v povoleném rozsahu jsou zpracované.';
        return;
      }
      // Pick a ready origin first so a slow site's delay does not block other sites.
      const waitFor = (url: string) => {
        const origin = new URL(url).origin;
        const site = state!.scan.sites.find((item) => item.origin === origin)!;
        return (
          Math.max(
            SCAN_LIMITS.minIntervalMs,
            site.intervalMs,
            robots.get(origin)?.delayMs ?? 0,
          ) -
          (Date.now() - (state!.lastRequest[origin] ?? 0))
        );
      };
      eligible.sort((left, right) => waitFor(left) - waitFor(right));
      const sourceUrl = eligible[0];
      if (waitFor(sourceUrl) > 0) {
        status.textContent =
          'Čekám na další požadavek podle nastaveného intervalu…';
        await sleep(Math.min(waitFor(sourceUrl), 250));
        continue;
      }
      const origin = new URL(sourceUrl).origin;
      if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] })))
        throw new Error(
          'Přístup k doméně byl odebrán. Povolte jej tlačítkem Pokračovat.',
        );
      state.lastRequest[origin] = Date.now();
      await chrome.storage.local.set({
        [`request:${origin}`]: state.lastRequest[origin],
      });
      await storeScan(state);
      if (!robots.has(origin)) {
        status.textContent = `Ověřuji robots.txt: ${origin}`;
        robots.set(origin, await fetchRobots(origin));
        continue;
      }
      status.textContent = `Načítám ${sourceUrl}`;
      const result = robots.get(origin)!.allowed(sourceUrl)
        ? await fetchPage(sourceUrl)
        : emptyResult(
            sourceUrl,
            'robots_denied',
            'Access denied or robots.txt unavailable.',
          );
      state.outbox = result;
      if (result.httpStatus === 429) rateLimitedOrigins.add(origin);
      await storeScan(state);
      await flushOutbox();
    }
    await report('paused');
    status.textContent =
      'Pozastaveno. Fronta i výsledky jsou uložené. Pro pokračování nejdříve obnovte sken v mapě.';
  } catch (error) {
    if (error instanceof ResultLimitError) {
      state.scan.status = 'limited';
      state.outboxLimit = error.limit;
      // A quota refusal is not an acknowledgement: retain the exact result for
      // a retry after the owner increases the page limit.
      await storeScan(state);
    }
    status.textContent =
      error instanceof Error
        ? error.message
        : 'Sken byl přerušen. Zkuste pokračovat.';
  } finally {
    running = false;
    startButton.textContent = 'Povolit domény a pokračovat';
    render();
  }
}

startButton.addEventListener('click', () => {
  if (!state || running) return;
  const requestedOrigins = new Set(state.scan.sites.map((site) => site.origin));
  // Chrome requires the permission request directly inside a user gesture.
  const permission = chrome.permissions.request({
    origins: [...requestedOrigins].map((origin) => `${origin}/*`),
  });
  void permission
    .then(async (granted) => {
      if (!granted) {
        status.textContent = 'Přístup nebyl povolen. Sken se nespustil.';
        return;
      }
      await navigator.locks.request(
        'vizlinx:runner',
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            status.textContent =
              'Skener už běží v jiné kartě rozšíření. Pozastavte jej, než spustíte další mapu.';
            return;
          }
          // Another runner may have advanced the persisted queue since this tab opened.
          state = await readScan(state!.scan.id);
          if (
            state?.scan.sites.some((site) => !requestedOrigins.has(site.origin))
          ) {
            render();
            status.textContent =
              'Rozsah mapy se změnil. Potvrďte znovu přístup k aktuálně zobrazeným doménám.';
            return;
          }
          await run();
        },
      );
    })
    .catch(() => {
      status.textContent =
        'Oprávnění se nepodařilo načíst. Zkuste kartu znovu otevřít.';
    });
});

pauseButton.addEventListener('click', () => {
  stopped = true;
  pauseButton.disabled = true;
  status.textContent = 'Dokončuji právě načtenou stránku a ukládám frontu…';
});

void (async () => {
  const id = new URL(location.href).searchParams.get('scan');
  state = id ? await readScan(id) : undefined;
  if (!state) {
    const appOrigin = __LOCAL_ORIGINS__[0] ?? 'https://vizlinx.com';
    status.textContent = `Rozšíření zatím není spárované s mapou. Na ${appOrigin}/scan otevřete nebo založte mapu a klikněte na „Otevřít skenovací kartu“.`;
    mapLink.href = `${appOrigin}/scan`;
    mapLink.textContent = 'Otevřít seznam map ↗';
    mapLink.hidden = false;
    return;
  }
  mapLink.href = `${state.apiOrigin}/scan?id=${encodeURIComponent(state.scan.id)}`;
  mapLink.hidden = false;
  status.textContent = state.outboxLimit
    ? new ResultLimitError(state.outboxLimit).message
    : 'Připraveno. Povolte přístup pouze k níže vybraným doménám a spusťte sken.';
  render();
})().catch(() => {
  status.textContent =
    'Uložený sken se nepodařilo načíst. Spárujte rozšíření znovu z mapy.';
});
