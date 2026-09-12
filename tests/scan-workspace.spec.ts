import { expect, test, type Page } from '@playwright/test';
import {
  API_PREFIX,
  type PageResult,
  type ScanSite,
  type ScanSnapshot,
} from '../shared/scan';

const site: ScanSite = {
  origin: 'https://example.com',
  seedUrl: 'https://example.com/start',
  intervalMs: 3000,
  maxPages: 100,
  paused: false,
};
const snapshot = (
  id: string,
  overrides: Partial<ScanSnapshot> = {},
): ScanSnapshot => ({
  id,
  status: 'waiting',
  sites: [{ ...site }],
  createdAt: '2026-09-12T08:00:00.000Z',
  updatedAt: '2026-09-12T08:00:00.000Z',
  pageCount: 0,
  results: [],
  ...overrides,
});

async function mockApi(page: Page, initial: ScanSnapshot[] = []) {
  const maps = new Map(initial.map((scan) => [scan.id, structuredClone(scan)]));
  const state = {
    maps,
    created: [] as { sites: ScanSite[] }[],
    additions: [] as { site: ScanSite }[],
    addFailure: 0,
    patches: [] as { status?: string; sites?: ScanSite[] }[],
    createFailure: 0,
    sessionFailure: 0,
    snapshotFailure: 0,
    startRequests: [] as string[],
    startFailure: 0,
    adminEmail: null as string | null,
    patchGate: undefined as Promise<void> | undefined,
    nextSnapshotGate: undefined as Promise<void> | undefined,
    heldSnapshotStarted: false,
  };
  await page.addInitScript(() => {
    // Server scans must work without any browser extension.
    Object.defineProperty(window, 'chrome', { configurable: true, value: {} });
  });
  await page.route(`**${API_PREFIX}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(API_PREFIX.length);
    const send = (body: unknown, status = 200) =>
      route.fulfill({ status, json: body });
    if (path === '/config')
      return send({ adminEmail: state.adminEmail, maxPagesPerSite: 100 });
    if (path === '/session')
      return send(
        state.sessionFailure ? { error: 'Unavailable' } : { ok: true },
        state.sessionFailure || 200,
      );
    if (path === '/scans' && request.method() === 'GET')
      return send(
        [...maps.values()].map(({ results: _results, ...summary }) => summary),
      );
    if (path === '/scans' && request.method() === 'POST') {
      if (state.createFailure)
        return send({ error: 'Creation failed' }, state.createFailure);
      const body = request.postDataJSON() as { sites: ScanSite[] };
      state.created.push(body);
      const scan = snapshot(
        `00000000-0000-4000-8000-${String(maps.size + 1).padStart(12, '0')}`,
        { sites: body.sites },
      );
      maps.set(scan.id, scan);
      return send(scan, 201);
    }
    const match = path.match(/^\/scans\/([^/]+)(?:\/(start|sites))?$/);
    const scan = match ? maps.get(match[1]) : undefined;
    if (!scan) return send({ error: 'Not found' }, 404);
    if (request.method() === 'GET' && state.snapshotFailure)
      return send({ error: 'Unavailable' }, state.snapshotFailure);
    if (match?.[2] === 'sites' && request.method() === 'POST') {
      const body = request.postDataJSON() as { site: ScanSite };
      state.additions.push(body);
      if (state.addFailure)
        return send({ error: 'Adding site failed' }, state.addFailure);
      scan.sites = [...scan.sites, body.site];
      scan.status = 'paused';
      return send(scan, 201);
    }
    if (match?.[2] === 'start' && request.method() === 'POST') {
      state.startRequests.push(scan.id);
      expect(request.postDataJSON()).toEqual({});
      if (state.startFailure)
        return send({ error: 'Capacity exhausted' }, state.startFailure);
      scan.status = 'running';
      delete scan.limitReason;
      return send(scan);
    }
    if (match?.[2]) return send({ error: 'Not found' }, 404);
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as {
        status?: ScanSnapshot['status'];
        sites?: ScanSite[];
      };
      state.patches.push(body);
      if (state.patchGate) await state.patchGate;
      if (body.status) scan.status = body.status;
      if (body.sites) scan.sites = body.sites;
      return send({ id: scan.id, status: scan.status, sites: scan.sites });
    }
    const responseSnapshot = structuredClone(scan);
    const gate = state.nextSnapshotGate;
    state.nextSnapshotGate = undefined;
    if (gate) {
      state.heldSnapshotStarted = true;
      await gate;
      return route.fulfill({
        json: responseSnapshot,
        headers: { 'X-Test-Snapshot': 'held' },
      });
    }
    return send(responseSnapshot);
  });
  return state;
}

test('validates and normalizes origins and starts a server scan without an extension', async ({
  page,
}) => {
  const api = await mockApi(page);
  await page.goto('/scan');
  const seeds = page.getByLabel('Weby k prozkoumání');
  const prepare = page.getByRole('button', { name: 'Spustit sken' });
  await expect(prepare).toBeEnabled();
  await seeds.fill('http://127.0.0.1/');
  await prepare.click();
  await expect(page.getByRole('alert')).toContainText(
    'Zadej 1 až 3 veřejné HTTP(S) weby',
  );
  expect(api.created).toHaveLength(0);
  await seeds.fill('one.com\ntwo.com\nthree.com\nfour.com');
  await prepare.click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(api.created).toHaveLength(0);
  await seeds.fill(
    ' EXAMPLE.com/start#section\nhttps://example.com/ignored\nhttps://second.org/path ',
  );
  await page.getByLabel('Interval požadavků (sekundy)').fill('5');
  await prepare.click();
  await expect(page).toHaveURL(/\/scan\?id=/);
  expect(api.created).toEqual([
    {
      sites: [
        {
          origin: 'https://example.com',
          seedUrl: 'https://example.com/start',
          intervalMs: 5000,
          maxPages: 100,
          paused: false,
        },
        {
          origin: 'https://second.org',
          seedUrl: 'https://second.org/path',
          intervalMs: 5000,
          maxPages: 100,
          paused: false,
        },
      ],
    },
  ]);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Skenování běží', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('link', { name: 'Stáhni rozšíření' }),
  ).toHaveCount(0);
  await expect(page.locator('.scan-install')).toHaveCount(0);
  expect(api.startRequests).toHaveLength(1);
  await page.getByRole('button', { name: 'Uložené mapy', exact: true }).click();
  const saved = page
    .locator('.scan-saved')
    .getByRole('button', { name: /example.com · second.org/ });
  await expect(saved).toBeVisible();
  await saved.click();
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Ovládání skutečného skenu' }),
  ).toBeVisible();
  expect(api.maps.size).toBe(1);
});

test('loads saved maps by URL and returns from an unavailable map to the saved list', async ({
  page,
}) => {
  const scan = snapshot('00000000-0000-4000-8000-000000000099', {
    status: 'running',
  });
  const api = await mockApi(page, [scan]);
  await page.clock.install();
  await page.goto('/scan?id=unavailable');
  await expect(page.getByRole('alert')).toContainText('Mapa není dostupná');
  await page.getByRole('button', { name: 'Zpět na seznam map' }).click();
  await expect(page).toHaveURL(/\/scan$/);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page
    .locator('.scan-saved')
    .getByRole('button', { name: /example.com/ })
    .click();
  await expect(page).toHaveURL(`/scan?id=${scan.id}`);
  await expect(
    page.getByRole('button', { name: 'Skenování běží', exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Ovládání skutečného skenu' }),
  ).toBeVisible();
  api.snapshotFailure = 503;
  await page.clock.fastForward(3000);
  await expect(page.getByRole('alert')).toContainText(
    'Server je dočasně nedostupný',
  );
  api.snapshotFailure = 0;
  api.maps.get(scan.id)!.status = 'completed';
  await page.clock.fastForward(3000);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Spustit skenování' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Uložené mapy', exact: true }).click();
  await expect(
    page
      .locator('.scan-saved')
      .getByRole('button', { name: /Známá fronta je dokončená/ }),
  ).toBeVisible();
});

test('reports session and creation failures without losing the form and allows a retry', async ({
  page,
}) => {
  const api = await mockApi(page);
  api.sessionFailure = 503;
  await page.goto('/scan');
  await expect(page.getByRole('alert')).toContainText(
    'Server je dočasně nedostupný',
  );
  await expect(
    page.getByRole('button', { name: 'Spustit sken' }),
  ).toBeDisabled();
  api.sessionFailure = 0;
  api.createFailure = 429;
  await page.reload();
  await page.getByLabel('Weby k prozkoumání').fill('example.com/start');
  await page.getByRole('button', { name: 'Spustit sken' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Kapacita skenování nebo denní limit jsou vyčerpané',
  );
  await expect(page.getByLabel('Weby k prozkoumání')).toHaveValue(
    'example.com/start',
  );
  await expect(
    page.getByRole('button', { name: 'Spustit sken' }),
  ).toBeEnabled();
  expect(api.created).toHaveLength(0);
  api.createFailure = 0;
  await page.getByRole('button', { name: 'Spustit sken' }).click();
  await expect(page).toHaveURL(/\/scan\?id=/);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(api.created).toHaveLength(1);
});

test('persists global pause and origin interval changes through the API', async ({
  page,
}) => {
  const scan = snapshot('00000000-0000-4000-8000-000000000099', {
    status: 'running',
  });
  const api = await mockApi(page, [scan]);
  await page.goto(`/scan?id=${scan.id}`);
  await page
    .getByRole('button', { name: 'Pozastavit sken', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Pokračovat ve skenování', exact: true }),
  ).toBeVisible();
  expect(api.patches[0]).toEqual({ status: 'paused' });
  await page
    .getByRole('button', { name: 'Doména example.com', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Pozastavit skenování webu', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Pokračovat ve skenování webu',
      exact: true,
    }),
  ).toBeVisible();
  expect(api.maps.get(scan.id)?.sites[0].paused).toBe(true);
  const interval = page.getByRole('slider', { name: /Interval skenu/ });
  await expect(interval).toHaveValue('3');
  await interval.focus();
  await interval.press('ArrowRight');
  await expect(interval).toHaveValue('4');
  await expect
    .poll(() => api.maps.get(scan.id)?.sites[0].intervalMs)
    .toBe(4000);
  const updated = api.maps.get(scan.id)?.sites[0];
  expect(updated?.origin).toBe(site.origin);
  expect(updated?.seedUrl).toBe(site.seedUrl);
  expect(updated?.maxPages).toBe(site.maxPages);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Pokračovat ve skenování', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Doména example.com', exact: true })
    .click();
  await expect(
    page.getByRole('slider', { name: /Interval skenu/ }),
  ).toHaveValue('4');
});

test('commits only the final dragged interval and keeps it while the save is pending', async ({
  page,
}) => {
  const scan = snapshot('00000000-0000-4000-8000-000000000099');
  const api = await mockApi(page, [scan]);
  await page.goto(`/scan?id=${scan.id}`);
  await page
    .getByRole('button', { name: 'Doména example.com', exact: true })
    .click();
  const interval = page.getByRole('slider', { name: /Interval skenu/ });
  await interval.scrollIntoViewIfNeeded();
  const bounds = await interval.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const center = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + 10, center);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.35, center, { steps: 4 });
  await page.mouse.move(bounds.x + bounds.width * 0.75, center, { steps: 8 });
  const finalValue = Number(await interval.inputValue());
  expect(finalValue).toBeGreaterThan(35);
  expect(api.patches).toHaveLength(0);
  let releaseSave = () => {};
  api.patchGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.mouse.up();
  try {
    await expect(interval).toBeDisabled();
    await expect.poll(() => api.patches.length).toBe(1);
    expect(api.patches[0].sites?.[0].intervalMs).toBe(finalValue * 1000);
    await expect(interval).toHaveValue(String(finalValue));
    await expect(
      page.getByRole('button', {
        name: 'Pozastavit skenování webu',
        exact: true,
      }),
    ).toBeDisabled();
  } finally {
    releaseSave();
  }
  await expect(interval).toBeEnabled();
  await expect(interval).toHaveValue(String(finalValue));
  await page.reload();
  await page
    .getByRole('button', { name: 'Doména example.com', exact: true })
    .click();
  await expect(
    page.getByRole('slider', { name: /Interval skenu/ }),
  ).toHaveValue(String(finalValue));
  expect(api.patches).toHaveLength(1);
});

const savedResult: PageResult = {
  sourceUrl: site.seedUrl,
  title: 'Existing page',
  observedAt: '2026-09-12T08:00:00.000Z',
  status: 'ok',
  httpStatus: 200,
  links: [
    {
      targetUrl: 'https://second.org/',
      anchor: 'Existing link',
      rel: [],
      region: 'content',
      occurrences: 1,
    },
  ],
  discoveredUrls: [],
  truncated: false,
};

test('adds a web to a completed map without resetting selection or position and resumes result polling', async ({
  page,
}) => {
  const scan = snapshot('00000000-0000-4000-8000-000000000099', {
    status: 'completed',
    pageCount: 1,
    results: [savedResult],
  });
  const api = await mockApi(page, [scan]);
  await page.clock.install();
  await page.goto(`/scan?id=${scan.id}`);
  const domain = page.getByRole('button', {
    name: 'Doména second.org',
    exact: true,
  });
  await domain.click();
  await domain.press('Shift+ArrowRight');
  const position = await domain.locator('circle').first().getAttribute('cx');
  await expect(domain).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('link-count')).toHaveText('1');
  await page.getByRole('button', { name: 'Přidat web', exact: true }).click();
  const form = page.getByRole('form', { name: 'Přidat web do mapy' });
  await form
    .getByLabel('Nový web', { exact: true })
    .fill(' SECOND.org/start#section ');
  await form.getByLabel('Interval nového webu (sekundy)').fill('7');
  await form.getByRole('button', { name: 'Přidat do mapy' }).click();
  await expect(form).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Doména second.org', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(`/scan?id=${scan.id}`);
  await expect(domain).toHaveAttribute('aria-pressed', 'true');
  await expect(domain.locator('circle').first()).toHaveAttribute(
    'cx',
    position!,
  );
  await expect(page.getByTestId('link-count')).toHaveText('1');
  expect(api.additions).toEqual([
    {
      site: {
        origin: 'https://second.org',
        seedUrl: 'https://second.org/start',
        intervalMs: 7000,
        maxPages: 100,
        paused: false,
      },
    },
  ]);
  expect(api.maps.size).toBe(1);
  expect(api.maps.get(scan.id)?.results).toEqual([savedResult]);
  const current = api.maps.get(scan.id)!;
  current.status = 'running';
  current.results.push({
    ...savedResult,
    sourceUrl: 'https://second.org/start',
    title: 'New page',
    links: [{ ...savedResult.links[0], targetUrl: site.seedUrl }],
  });
  current.pageCount = 2;
  await page.clock.fastForward(3000);
  await expect(page.getByTestId('link-count')).toHaveText('2');
  await expect(domain.locator('circle').first()).toHaveAttribute(
    'cx',
    position!,
  );
  await expect(domain).toHaveAttribute('aria-pressed', 'true');
});

test('rejects invalid and duplicate added origins before sending and explains the three-web cap', async ({
  page,
}) => {
  const scan = snapshot('00000000-0000-4000-8000-000000000099', {
    sites: [
      site,
      { ...site, origin: 'https://second.org', seedUrl: 'https://second.org/' },
    ],
  });
  const api = await mockApi(page, [scan]);
  await page.goto(`/scan?id=${scan.id}`);
  await page.getByRole('button', { name: 'Přidat web', exact: true }).click();
  const form = page.getByRole('form', { name: 'Přidat web do mapy' });
  const input = form.getByLabel('Nový web', { exact: true });
  const add = form.getByRole('button', { name: 'Přidat do mapy' });
  await input.fill('http://127.0.0.1/');
  await add.click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(api.additions).toHaveLength(0);
  await input.fill('https://EXAMPLE.com/another-path#section');
  await add.click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(api.additions).toHaveLength(0);
  await input.fill('third.org');
  await add.click();
  await expect(
    page.getByRole('button', { name: 'Doména third.org', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Přidat web', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText('Limit prototypu: 3 weby v jedné mapě.', { exact: true }),
  ).toBeVisible();
  expect(api.maps.get(scan.id)?.sites).toHaveLength(3);
  expect(api.additions).toHaveLength(1);
});

test('preserves the map and new-web input when adding fails and accepts a retry', async ({
  page,
}) => {
  const scan = snapshot('00000000-0000-4000-8000-000000000099', {
    status: 'completed',
    pageCount: 1,
    results: [savedResult],
  });
  const api = await mockApi(page, [scan]);
  api.addFailure = 503;
  await page.goto(`/scan?id=${scan.id}`);
  await page.getByRole('button', { name: 'Přidat web', exact: true }).click();
  const form = page.getByRole('form', { name: 'Přidat web do mapy' });
  await form.getByLabel('Nový web', { exact: true }).fill('third.org/start');
  await form.getByLabel('Interval nového webu (sekundy)').fill('9');
  await form.getByRole('button', { name: 'Přidat do mapy' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Server je dočasně nedostupný',
  );
  await expect(form.getByLabel('Nový web', { exact: true })).toHaveValue(
    'third.org/start',
  );
  await expect(form.getByLabel('Interval nového webu (sekundy)')).toHaveValue(
    '9',
  );
  await expect(
    form.getByRole('button', { name: 'Přidat do mapy' }),
  ).toBeEnabled();
  await expect(page).toHaveURL(`/scan?id=${scan.id}`);
  await expect(page.getByTestId('link-count')).toHaveText('1');
  expect(api.maps.get(scan.id)?.sites).toHaveLength(1);
  expect(api.maps.get(scan.id)?.results).toEqual([savedResult]);
  api.addFailure = 0;
  await form.getByRole('button', { name: 'Přidat do mapy' }).click();
  await expect(
    page.getByRole('button', { name: 'Doména third.org', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(api.additions).toHaveLength(2);
  expect(api.maps.get(scan.id)?.sites).toHaveLength(2);
  expect(api.maps.get(scan.id)?.results).toEqual([savedResult]);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Doména third.org', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('link-count')).toHaveText('1');
});

test('ignores snapshots started before settings and pause mutations so later writes retain current settings', async ({
  page,
}) => {
  const scan = snapshot('00000000-0000-4000-8000-000000000099', {
    status: 'running',
  });
  const api = await mockApi(page, [scan]);
  await page.clock.install();
  await page.goto(`/scan?id=${scan.id}`);
  await page
    .getByRole('button', { name: 'Doména example.com', exact: true })
    .click();
  const interval = page.getByRole('slider', { name: /Interval skenu/ });
  const holdNextPoll = async () => {
    let release = () => {};
    api.heldSnapshotStarted = false;
    api.nextSnapshotGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await expect
      .poll(async () => {
        await page.clock.fastForward(3000);
        return api.heldSnapshotStarted;
      })
      .toBe(true);
    return async () => {
      const response = page.waitForResponse(
        (response) => response.headers()['x-test-snapshot'] === 'held',
      );
      release();
      await (await response).finished();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
    };
  };
  const releaseOldSettings = await holdNextPoll();
  await interval.focus();
  await interval.press('ArrowRight');
  await expect(interval).toBeEnabled();
  await expect(interval).toHaveValue('4');
  await releaseOldSettings();
  await expect(interval).toHaveValue('4');
  await page
    .getByRole('button', { name: 'Pozastavit skenování webu', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Pokračovat ve skenování webu',
      exact: true,
    }),
  ).toBeEnabled();
  expect(api.patches.at(-1)?.sites?.[0]).toMatchObject({
    intervalMs: 4000,
    paused: true,
  });
  const releaseOldStatus = await holdNextPoll();
  await page
    .getByRole('button', { name: 'Pozastavit sken', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Pokračovat ve skenování', exact: true }),
  ).toBeEnabled();
  await releaseOldStatus();
  await expect(
    page.getByRole('button', { name: 'Pokračovat ve skenování', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Pozastavit sken', exact: true }),
  ).toHaveCount(0);
  expect(api.maps.get(scan.id)?.status).toBe('paused');
  expect(api.maps.get(scan.id)?.sites[0]).toMatchObject({
    intervalMs: 4000,
    paused: true,
  });
});

test('shows a prominent fixed page limit with preserved results and configured administrator contact', async ({
  page,
}, testInfo) => {
  const scan = snapshot('00000000-0000-4000-8000-000000000099', {
    status: 'limited',
    limitReason: 'page_limit',
    pageCount: 1,
    results: [savedResult],
  });
  const api = await mockApi(page, [scan]);
  api.adminEmail = 'admin@example.com';
  await page.goto(`/scan?id=${scan.id}`);
  const banner = page.getByRole('alert');
  await expect(
    banner.getByRole('heading', { name: 'Dosažen limit 100 stránek na web' }),
  ).toBeVisible();
  await expect(banner).toContainText('Pro vyšší limit kontaktuj správce.');
  await expect(banner).toContainText('Dosavadní výsledky zůstávají uložené');
  await expect(
    banner.getByRole('link', { name: 'Kontaktovat správce' }),
  ).toHaveAttribute('href', /^mailto:admin@example\.com\?subject=/);
  await expect(page.getByTestId('link-count')).toHaveText('1');
  await expect(
    page.getByRole('button', { name: 'Spustit skenování' }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Doména example.com', exact: true })
    .click();
  await expect(
    page.getByRole('spinbutton', { name: 'Limit stránek skenu', exact: true }),
  ).toHaveCount(0);
  expect(api.patches).toHaveLength(0);
  expect(api.startRequests).toHaveLength(0);
  for (const theme of ['signal', 'midnight']) {
    const shell = page.locator('.app-shell');
    if ((await shell.getAttribute('data-theme')) !== theme)
      await page
        .getByRole('button', { name: 'Noční režim', exact: true })
        .click();
    await expect(shell).toHaveAttribute('data-theme', theme);
    await banner.screenshot({
      path: testInfo.outputPath(`page-limit-${theme}.png`),
    });
  }
});

for (const [reason, title] of [
  ['scan_storage_limit', 'Dosažen limit velikosti mapy'],
  ['time_limit', 'Dosažen časový limit skenování'],
  ['daily_limit', 'Dosažen denní limit skenování'],
] as const) {
  test(`explains ${reason} without inventing administrator contact`, async ({
    page,
  }) => {
    const scan = snapshot('00000000-0000-4000-8000-000000000099', {
      status: 'limited',
      limitReason: reason,
    });
    await mockApi(page, [scan]);
    await page.goto(`/scan?id=${scan.id}`);
    await expect(
      page.getByRole('alert').getByRole('heading', { name: title }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).not.toContainText(
      'Dosažen limit 100 stránek',
    );
    await expect(
      page.getByRole('link', { name: 'Kontaktovat správce' }),
    ).toHaveCount(0);
    await expect(page.getByRole('alert')).toContainText(
      'Pro vyšší limit kontaktuj správce.',
    );
  });
}

test('keeps a newly created map when server capacity is exhausted and can retry starting it', async ({
  page,
}) => {
  const api = await mockApi(page);
  api.startFailure = 429;
  await page.goto('/scan');
  await page.getByLabel('Weby k prozkoumání').fill('example.com');
  await page.getByRole('button', { name: 'Spustit sken', exact: true }).click();
  await expect(page).toHaveURL(/\/scan\?id=/);
  await expect(page.getByRole('alert')).toContainText(
    'Kapacita skenování nebo denní limit jsou vyčerpané',
  );
  expect(api.created).toHaveLength(1);
  api.startFailure = 0;
  await page
    .getByRole('button', { name: 'Spustit skenování', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Skenování běží', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(api.created).toHaveLength(1);
  expect(api.startRequests).toHaveLength(2);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Skenování běží', exact: true }),
  ).toBeDisabled();
  expect(api.startRequests).toHaveLength(2);
});

test('retains the page-limit warning after adding another origin and resumes the enlarged map', async ({
  page,
}) => {
  const scan = snapshot('00000000-0000-4000-8000-000000000099', {
    status: 'limited',
    limitReason: 'page_limit',
    pageCount: 1,
    results: [savedResult],
  });
  const api = await mockApi(page, [scan]);
  await page.goto(`/scan?id=${scan.id}`);
  await page.getByRole('button', { name: 'Přidat web', exact: true }).click();
  const form = page.getByRole('form', { name: 'Přidat web do mapy' });
  await form.getByLabel('Nový web', { exact: true }).fill('second.org');
  await form.getByRole('button', { name: 'Přidat do mapy' }).click();
  await expect(
    page
      .getByRole('alert')
      .getByRole('heading', { name: 'Dosažen limit 100 stránek na web' }),
  ).toBeVisible();
  await expect(page.getByTestId('link-count')).toHaveText('1');
  await page
    .getByRole('button', { name: 'Pokračovat ve skenování', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Skenování běží', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(api.maps.get(scan.id)?.sites).toHaveLength(2);
  expect(api.maps.get(scan.id)?.results).toEqual([savedResult]);
});

test('allows a daily-limit retry without losing its warning until the server accepts it', async ({
  page,
}) => {
  const scan = snapshot('00000000-0000-4000-8000-000000000099', {
    status: 'limited',
    limitReason: 'daily_limit',
  });
  const api = await mockApi(page, [scan]);
  api.startFailure = 429;
  await page.goto(`/scan?id=${scan.id}`);
  const resume = page.getByRole('button', {
    name: 'Pokračovat ve skenování',
    exact: true,
  });
  await expect(resume).toBeEnabled();
  await resume.click();
  await expect(
    page.getByRole('heading', { name: 'Dosažen denní limit skenování' }),
  ).toBeVisible();
  expect(api.maps.get(scan.id)?.limitReason).toBe('daily_limit');
  api.startFailure = 0;
  await resume.click();
  await expect(
    page.getByRole('button', { name: 'Skenování běží', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(api.startRequests).toHaveLength(2);
});

for (const reason of ['time_limit', 'scan_storage_limit'] as const) {
  test(`keeps ${reason} visible and prevents resume even in a paused snapshot`, async ({
    page,
  }) => {
    const scan = snapshot('00000000-0000-4000-8000-000000000099', {
      status: 'paused',
      limitReason: reason,
    });
    const api = await mockApi(page, [scan]);
    await page.goto(`/scan?id=${scan.id}`);
    await expect(page.getByRole('alert')).toContainText(
      'Pro vyšší limit kontaktuj správce.',
    );
    await expect(
      page.getByRole('button', {
        name: 'Pokračovat ve skenování',
        exact: true,
      }),
    ).toBeDisabled();
    expect(api.startRequests).toHaveLength(0);
  });
}
