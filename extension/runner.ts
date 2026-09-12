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
import { readScan, storeScan, type StoredScan } from './state';

const status = document.querySelector<HTMLElement>('#status')!;
const sitesList = document.querySelector<HTMLUListElement>('#sites')!;
const startButton = document.querySelector<HTMLButtonElement>('#start')!;
const pauseButton = document.querySelector<HTMLButtonElement>('#pause')!;
const progress = document.querySelector<HTMLElement>('#progress')!;
const mapLink = document.querySelector<HTMLAnchorElement>('#map')!;
let state: StoredScan | undefined;
let stopped = false;
let running = false;

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
  startButton.disabled = running;
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
  await storeScan(current);
  render();
}

async function run() {
  if (!state) return;
  running = true;
  stopped = false;
  render();
  const robots = new Map<string, RobotsPolicy>();
  const rateLimitedOrigins = new Set<string>();
  let lastControl = 0;
  let lastHeartbeat = 0;
  const refreshControl = async () => {
    if (Date.now() - lastControl < 1000) return;
    const control = await api<ScanControl>('/control');
    state!.scan = { ...state!.scan, ...control };
    lastControl = Date.now();
    if (control.status === 'paused') stopped = true;
    if (Date.now() - lastHeartbeat >= 10_000 && !stopped) {
      await report('running');
      lastHeartbeat = Date.now();
    }
    render();
  };
  try {
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
  // Chrome requires the permission request directly inside a user gesture.
  const permission = chrome.permissions.request({
    origins: state.scan.sites.map((site) => `${site.origin}/*`),
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
    status.textContent =
      'Nejdříve na vizlinx.com založte mapu a klikněte na Připojit rozšíření.';
    return;
  }
  mapLink.href = `${state.apiOrigin}/scan?id=${encodeURIComponent(state.scan.id)}`;
  mapLink.hidden = false;
  status.textContent =
    'Připraveno. Povolte přístup pouze k níže vybraným doménám a spusťte sken.';
  render();
})().catch(() => {
  status.textContent =
    'Uložený sken se nepodařilo načíst. Spárujte rozšíření znovu z mapy.';
});
