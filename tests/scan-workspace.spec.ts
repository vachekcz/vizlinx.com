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
    .getByRole('button', { name: 'Otevřít mapu example.com, second.org' });
  await expect(saved).toBeVisible();
  const savedMaps = page.locator('.scan-saved');
  for (const origin of ['https://example.com', 'https://second.org']) {
    const link = savedMaps.getByRole('link', {
      name: `Otevřít ${origin} v nové kartě`,
      exact: true,
    });
    await expect(link).toHaveAttribute('href', `${origin}/`);
    await expect(link).toHaveAttribute('target', '_blank');
  }
  await expect(savedMaps.locator('button a, a button, a a')).toHaveCount(0);
  await page
    .context()
    .route('https://example.com/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<h1>Example</h1>' }),
    );
  const popupOpened = page.waitForEvent('popup');
  await savedMaps
    .getByRole('link', { name: 'Otevřít https://example.com v nové kartě' })
    .click();
  const popup = await popupOpened;
  await expect(popup).toHaveURL('https://example.com/');
  await expect(page).toHaveURL(/\/scan$/);
  await popup.close();
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
    .getByRole('button', { name: 'example.com', exact: true })
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
    page.locator('.scan-saved').getByRole('button', {
      name: 'Otevřít mapu example.com',
      exact: true,
    }),
  ).toContainText('Známá fronta je dokončená');
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

const previewResult: PageResult = {
  ...savedResult,
  sourceUrl: 'https://second.org/',
  title: 'Inspected landing page',
  crawlMode: 'preview',
  links: [
    { ...savedResult.links[0], targetUrl: 'https://example.com/contact' },
    { ...savedResult.links[0], targetUrl: 'https://third.org/known-only' },
  ],
};

test('shows partial landing-page coverage and keeps backlinks visible when unknown sites are hidden', async ({
  page,
}) => {
  const scan = snapshot('00000000-0000-4000-8000-000000000081', {
    status: 'completed',
    results: [
      {
        ...savedResult,
        links: [
          ...savedResult.links,
          { ...savedResult.links[0], targetUrl: 'https://second.org/blocked' },
          {
            ...savedResult.links[0],
            targetUrl: 'https://second.org/not-checked',
          },
        ],
      },
      previewResult,
      {
        ...previewResult,
        sourceUrl: 'https://second.org/blocked',
        status: 'robots_denied',
        links: [],
      },
    ],
    pageCount: 3,
  });
  await mockApi(page, [scan]);
  await page.goto(`/scan?id=${scan.id}`);
  await page
    .getByRole('button', { name: 'Doména second.org', exact: true })
    .press('Enter');
  const inspector = page.getByRole('complementary', { name: 'Detail výběru' });
  await expect(inspector.locator('.status-chip')).toHaveText(
    'Částečně prozkoumáno',
  );
  await expect(inspector.getByTestId('site-preview')).toContainText(
    'Zkontrolováno 1 z 3 známých cílových URL',
  );
  await expect(inspector.getByTestId('site-preview')).toContainText(
    'Nepodařilo se ověřit 1 cílových URL',
  );
  await expect(inspector.getByTestId('site-preview')).toContainText(
    'Nalezené odkazy zpět na odkazující vybrané weby: 1.',
  );
  await expect(
    page.getByRole('button', { name: /^Propojení second.org → example.com/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Doména third.org', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Další odkazované weby').uncheck();
  await expect(
    page.getByRole('button', { name: 'Doména third.org', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Doména second.org', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^Propojení second.org → example.com/ }),
  ).toBeVisible();
  await expect(page.getByTestId('link-count')).toHaveText('4');
  await inspector
    .getByRole('button', { name: 'Zobrazit známé cílové URL', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Stránka second.org/', exact: true })
    .press('Enter');
  await expect(inspector).toContainText(
    'Úspěšně načtená stránka · kontrola cílové URL',
  );
});

test('keeps inspected targets outside the ten unknown-site map cap', async ({
  page,
}) => {
  const scan = snapshot('00000000-0000-4000-8000-000000000082', {
    status: 'completed',
    results: [
      {
        ...savedResult,
        links: [
          ...Array.from({ length: 12 }, (_, index) => ({
            ...savedResult.links[0],
            targetUrl: `https://unknown-${index}.org/`,
          })),
          ...savedResult.links,
        ],
      },
      previewResult,
    ],
    pageCount: 2,
  });
  await mockApi(page, [scan]);
  await page.goto(`/scan?id=${scan.id}`);
  await expect(page.locator('.site-node')).toHaveCount(12);
  await expect(
    page.getByRole('button', { name: 'Doména second.org', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^Propojení second.org → example.com/ }),
  ).toBeVisible();
  await page.getByLabel('Další odkazované weby').uncheck();
  await expect(page.locator('.site-node')).toHaveCount(2);
});

test('labels preview activity and lets the saved log filter external preview origins', async ({
  page,
}) => {
  const scan = snapshot('00000000-0000-4000-8000-000000000086', {
    status: 'running',
    results: [savedResult],
    pageCount: 1,
    activity: {
      phase: 'fetching_page',
      crawlMode: 'preview',
      origin: 'https://second.org',
      url: 'https://second.org/',
      updatedAt: savedResult.observedAt,
    },
  });
  await mockApi(page, [scan]);
  await page.route(`**${API_PREFIX}/scans/${scan.id}/log`, (route) =>
    route.fulfill({
      json: {
        truncated: false,
        events: [
          {
            id: 1,
            type: 'page_finished',
            level: 'info',
            at: savedResult.observedAt,
            origin: site.origin,
            url: site.seedUrl,
            status: 'ok',
          },
          {
            id: 2,
            type: 'page_finished',
            level: 'info',
            at: savedResult.observedAt,
            origin: 'https://second.org',
            url: previewResult.sourceUrl,
            status: 'ok',
            crawlMode: 'preview',
          },
        ],
      },
    }),
  );
  await page.goto(`/scan?id=${scan.id}`);
  await expect(page.getByTestId('scan-activity')).toContainText(
    'Kontroluji cílovou stránku odkazu',
  );
  await page.getByRole('button', { name: 'Průběh skenu', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Průběh skenu' });
  await expect(panel).toContainText('Kontrola cílové URL · Načteno');
  await panel
    .getByRole('combobox', { name: 'Web', exact: true })
    .selectOption('https://second.org');
  await expect(panel.getByText(site.seedUrl, { exact: true })).toHaveCount(0);
  await expect(
    panel
      .getByRole('region', { name: 'Záznamy skenu' })
      .getByText(previewResult.sourceUrl, { exact: true }),
  ).toBeVisible();
});

test('promotes an inspected target and starts its normal scan while retaining results and placement', async ({
  page,
}) => {
  const scan = snapshot('00000000-0000-4000-8000-000000000083', {
    status: 'completed',
    results: [savedResult, previewResult],
    pageCount: 2,
  });
  const api = await mockApi(page, [scan]);
  await page.goto(`/scan?id=${scan.id}`);
  const domain = page.getByRole('button', {
    name: 'Doména second.org',
    exact: true,
  });
  await domain.press('Enter');
  const position = await domain.locator('circle').first().getAttribute('cx');
  await page
    .getByRole('button', { name: 'Prozkoumat web', exact: true })
    .click();
  await expect(page.locator('.scan-notice')).toContainText(
    'Běžný sken webu běží.',
  );
  expect(api.startRequests).toEqual([scan.id]);
  expect(api.additions).toEqual([
    {
      site: {
        origin: 'https://second.org',
        seedUrl: 'https://second.org/',
        intervalMs: 3000,
        maxPages: 100,
        paused: false,
      },
    },
  ]);
  expect(api.maps.get(scan.id)?.results).toEqual(scan.results);
  await expect(page.getByTestId('link-count')).toHaveText('3');
  await expect(domain).toHaveAttribute('aria-pressed', 'true');
  await expect(domain.locator('circle').first()).toHaveAttribute(
    'cx',
    position!,
  );
  await expect(
    page.getByRole('button', { name: 'Prozkoumat web', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('slider', { name: /Interval skenu/ }),
  ).toHaveValue('3');
});

test('preserves unknown target data through failed promotion and a failed scan start', async ({
  page,
}) => {
  const scan = snapshot('00000000-0000-4000-8000-000000000084', {
    status: 'completed',
    results: [savedResult],
    pageCount: 1,
  });
  const api = await mockApi(page, [scan]);
  api.addFailure = 503;
  await page.goto(`/scan?id=${scan.id}`);
  await page
    .getByRole('button', { name: 'Doména second.org', exact: true })
    .press('Enter');
  await expect(page.locator('.inspector .status-chip')).toHaveText(
    'Neprozkoumáno',
  );
  const explore = page.getByRole('button', {
    name: 'Prozkoumat web',
    exact: true,
  });
  await explore.click();
  await expect(page.getByRole('alert')).toContainText(
    'Server je dočasně nedostupný',
  );
  await expect(explore).toBeEnabled();
  expect(api.maps.get(scan.id)?.sites).toHaveLength(1);
  expect(api.startRequests).toHaveLength(0);
  api.addFailure = 0;
  api.startFailure = 429;
  await explore.click();
  await expect(page.getByRole('alert')).toContainText(
    'Web je přidaný a výsledky zůstaly uložené. Spuštění skenu se nepodařilo',
  );
  expect(api.maps.get(scan.id)?.sites).toHaveLength(2);
  expect(api.maps.get(scan.id)?.results).toEqual(scan.results);
  await expect(page.getByTestId('link-count')).toHaveText('1');
  api.startFailure = 0;
  await page
    .getByRole('button', { name: 'Pokračovat ve skenování', exact: true })
    .click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(api.startRequests).toHaveLength(2);
  expect(api.additions).toHaveLength(2);
});

for (const archived of [false, true]) {
  test(`disables preview promotion for ${archived ? 'archived runs' : 'three full sites'}`, async ({
    page,
  }) => {
    const scan = snapshot('00000000-0000-4000-8000-000000000085', {
      status: 'completed',
      archived,
      sites: archived
        ? [site]
        : [
            site,
            ...['fourth.org', 'fifth.org'].map((domain) => ({
              ...site,
              origin: `https://${domain}`,
              seedUrl: `https://${domain}/`,
            })),
          ],
      results: [
        savedResult,
        { ...previewResult, status: 'robots_denied', links: [] },
      ],
      pageCount: 2,
    });
    const api = await mockApi(page, [scan]);
    await page.goto(`/scan?id=${scan.id}`);
    await page
      .getByRole('button', { name: 'Doména second.org', exact: true })
      .press('Enter');
    await expect(page.locator('.inspector .status-chip')).toHaveText(
      'Nepodařilo se ověřit',
    );
    await expect(page.getByTestId('site-preview')).not.toContainText(
      'odkaz zpět na odkazující vybrané weby nenašli',
    );
    await expect(
      page.getByRole('button', { name: 'Prozkoumat web', exact: true }),
    ).toBeDisabled();
    await expect(page.getByTestId('site-preview')).toContainText(
      archived
        ? 'Historický průchod je pouze ke čtení'
        : 'Běžný sken může zahrnovat nejvýše 3 weby',
    );
    expect(api.additions).toHaveLength(0);
    expect(api.startRequests).toHaveLength(0);
  });
}

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

test('shows persistent scan activity and expires the request countdown without claiming a fetch', async ({
  page,
}) => {
  const id = '00000000-0000-4000-8000-000000000091';
  const scan = snapshot(id, {
    status: 'running',
    activity: {
      phase: 'waiting',
      updatedAt: new Date().toISOString(),
      nextRequestAt: new Date(Date.now() + 6000).toISOString(),
      url: 'https://example.com/next',
    },
  });
  const api = await mockApi(page, [scan]);
  await page.goto(`/scan?id=${id}`);
  const activity = page.getByTestId('scan-activity');
  await expect(activity).toContainText('Odstup mezi požadavky');
  await expect(activity).toContainText('https://example.com/next');
  await expect(activity.getByRole('link')).toHaveAttribute(
    'href',
    'https://example.com/next',
  );
  await expect(activity.getByRole('link')).toHaveAttribute('target', '_blank');
  await expect(activity).toContainText('0 zpracovaných stránek');
  await expect(activity).toContainText('Čeká na zpracování', {
    timeout: 10000,
  });
  api.maps.get(id)!.activity!.phase = 'fetching_page';
  await expect(activity).toContainText('Načítám stránku');
  await page
    .getByRole('button', { name: 'Pozastavit sken', exact: true })
    .click();
  await expect(activity).toContainText('Skenování pozastaveno');
  await expect(activity).not.toContainText('Načítám stránku');
  await expect(activity).not.toContainText('https://example.com/next');
});

test('explains blocked redirect targets in the saved log and avoids claiming a successful empty scan', async ({
  page,
}) => {
  const id = '00000000-0000-4000-8000-000000000095';
  const redirect: PageResult = {
    sourceUrl: site.seedUrl,
    title: '',
    observedAt: '2026-09-13T11:00:00.000Z',
    status: 'redirect_unresolved',
    httpStatus: 302,
    links: [],
    discoveredUrls: [],
    truncated: false,
    redirect: {
      kind: 'external',
      targetUrl: 'https://other.org/landing?from=example',
    },
  };
  await mockApi(page, [
    snapshot(id, { status: 'completed', results: [redirect], pageCount: 1 }),
  ]);
  await page.route(`**${API_PREFIX}/scans/${id}/log`, (route) =>
    route.fulfill({
      json: {
        truncated: false,
        events: [
          {
            id: 1,
            type: 'page_finished',
            at: redirect.observedAt,
            level: 'warning',
            url: redirect.sourceUrl,
            httpStatus: 302,
            status: redirect.status,
            redirect: redirect.redirect,
          },
        ],
      },
    }),
  );
  await page.goto(`/scan?id=${id}`);
  await expect(page.getByTestId('scan-activity')).toContainText(
    'Sken skončil bez načtených stránek',
  );
  await page
    .getByText('Podrobnosti neúplných výsledků', { exact: true })
    .click();
  await expect(page.locator('.scan-issues')).toContainText(
    'Přesměrování mimo web – nenásledováno',
  );
  await expect(page.locator('.scan-issues')).toContainText(
    redirect.redirect!.targetUrl!,
  );
  await page.getByRole('button', { name: 'Průběh skenu', exact: true }).click();
  const panel = page.getByRole('dialog');
  await expect(panel).toContainText('Přesměrování mimo web – nenásledováno');
  await expect(panel).toContainText(
    `Cíl přesměrování: ${redirect.redirect!.targetUrl}`,
  );
  for (const container of [page.locator('.scan-issues'), panel]) {
    for (const url of [redirect.sourceUrl, redirect.redirect!.targetUrl!]) {
      const link = container.getByRole('link', {
        name: `Otevřít ${url} v nové kartě`,
        exact: true,
      });
      await expect(link).toHaveAttribute('href', url);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    await expect(container.locator('button a, a button, a a')).toHaveCount(0);
  }
  await page.reload();
  await page.getByRole('button', { name: 'Průběh skenu', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(
    redirect.redirect!.targetUrl!,
  );
});

for (const archived of [false, true]) {
  test(`keeps redirected website counts and detailed redirect logs in the ${archived ? 'archived' : 'current'} run`, async ({
    page,
  }) => {
    const id = '00000000-0000-4000-8000-000000000096';
    const runId = '00000000-0000-4000-8000-000000000196';
    const redirected: PageResult = {
      ...savedResult,
      links: [],
      status: 'redirect_unresolved',
      httpStatus: 301,
      redirect: {
        kind: 'site_variant',
        targetUrl: 'https://www.example.com/final',
      },
    };
    const final: PageResult = {
      ...savedResult,
      sourceUrl: 'https://www.example.com/final',
      siteOrigin: site.origin,
      links: [],
    };
    const scan = snapshot(id, {
      runId,
      runNumber: 1,
      runCreatedAt: savedResult.observedAt,
      archived,
      status: 'completed',
      results: [redirected, final],
      pageCount: 2,
    });
    const api = await mockApi(page, [scan]);
    await page.route(`**${API_PREFIX}/scans/${id}/runs**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/runs'))
        return route.fulfill({ json: { runs: [scan], limit: 10 } });
      if (!path.endsWith('/log')) return route.fulfill({ json: scan });
      return route.fulfill({
        json: {
          truncated: false,
          events: [
            {
              id: 1,
              at: savedResult.observedAt,
              type: 'page_finished',
              level: 'info',
              origin: site.origin,
              url: redirected.sourceUrl,
              httpStatus: 301,
              status: redirected.status,
              redirect: redirected.redirect,
            },
            {
              id: 2,
              at: savedResult.observedAt,
              type: 'robots_checked',
              level: 'info',
              origin: site.origin,
              url: `${site.origin}/robots.txt`,
              httpStatus: 308,
              redirect: {
                kind: 'site_variant',
                targetUrl: 'https://www.example.com/robots.txt',
              },
            },
            {
              id: 3,
              at: savedResult.observedAt,
              type: 'robots_checked',
              level: 'warning',
              origin: site.origin,
              url: 'https://www.example.com/robots-loop',
              httpStatus: 302,
              redirect: {
                kind: 'invalid',
                reason: 'redirect_loop',
                targetUrl: `${site.origin}/robots.txt`,
              },
            },
            {
              id: 4,
              at: savedResult.observedAt,
              type: 'robots_checked',
              level: 'warning',
              origin: site.origin,
              url: 'https://www.example.com/robots-limit',
              httpStatus: 302,
              redirect: {
                kind: 'invalid',
                reason: 'redirect_limit',
                targetUrl: 'https://www.example.com/robots-next',
              },
            },
          ],
        },
      });
    });
    await page.goto(`/scan?id=${id}${archived ? `&run=${runId}` : ''}`);
    await expect(page.locator('.site-list-row')).toHaveCount(1);
    await expect(page.locator('.site-list-row')).toContainText(
      '1 načteno · 2 URL',
    );
    await expect(page.locator('.scan-stats')).toContainText(
      '1 načtených · 0 neúspěšných / vynechaných',
    );
    await expect(page.locator('.scan-issues')).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Doména example.com', exact: true })
      .click();
    const pause = page.getByRole('button', {
      name: 'Pozastavit skenování webu',
      exact: true,
    });
    if (archived) await expect(pause).toHaveCount(0);
    else {
      await pause.click();
      expect(api.patches.at(-1)?.sites).toEqual([{ ...site, paused: true }]);
    }
    await page
      .getByRole('button', { name: 'Průběh skenu', exact: true })
      .click();
    const panel = page.getByRole('dialog');
    const pageEvent = panel
      .locator('li')
      .filter({ hasText: redirected.sourceUrl });
    await expect(pageEvent).toContainText('HTTP 301');
    await expect(pageEvent).not.toContainText('nenásledováno');
    for (const url of [redirected.sourceUrl, final.sourceUrl]) {
      const link = pageEvent.getByRole('link', {
        name: `Otevřít ${url} v nové kartě`,
        exact: true,
      });
      await expect(link).toHaveAttribute('href', url);
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    const robotsEvent = panel.locator('li').filter({ hasText: 'HTTP 308' });
    await expect(robotsEvent).toContainText(
      'Robots.txt · Přesměrování na HTTP/HTTPS nebo www variantu webu',
    );
    await expect(robotsEvent).toContainText(`${site.origin}/robots.txt`);
    await expect(robotsEvent).toContainText(
      'Cíl přesměrování: https://www.example.com/robots.txt',
    );
    await expect(panel).toContainText(
      'Robots.txt · Přesměrování se zacyklilo – zastaveno',
    );
    await expect(panel).toContainText(
      'Robots.txt · Dosažen limit přesměrování – zastaveno',
    );
    await page.reload();
    await page
      .getByRole('button', { name: 'Průběh skenu', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toContainText(
      'Cíl přesměrování: https://www.example.com/final',
    );
  });
}

test('opens saved log, filters by origin and errors, restores focus and does not poll while closed', async ({
  page,
}, testInfo) => {
  const id = '00000000-0000-4000-8000-000000000092';
  const second = {
    ...site,
    origin: 'https://other.example',
    seedUrl: 'https://other.example/',
  };
  await mockApi(page, [
    snapshot(id, { status: 'completed', sites: [site, second] }),
  ]);
  let requests = 0;
  await page.route(`**/scans/${id}/log`, async (route) => {
    requests++;
    await route.fulfill({
      json: {
        truncated: false,
        events: [
          {
            id: 1,
            at: '2026-09-12T10:00:00Z',
            type: 'scan_started',
            level: 'info',
          },
          {
            id: 2,
            at: '2026-09-12T10:00:03Z',
            type: 'page_finished',
            level: 'info',
            origin: site.origin,
            url: 'https://example.com/contact',
            status: 'ok',
            httpStatus: 200,
            linkCount: 12,
          },
          {
            id: 3,
            at: '2026-09-12T10:00:06Z',
            type: 'page_finished',
            level: 'error',
            origin: second.origin,
            url: 'https://other.example/private',
            status: 'http_error',
            httpStatus: 403,
          },
          {
            id: 4,
            at: '2026-09-12T10:00:09Z',
            type: 'scan_completed',
            level: 'info',
          },
        ],
      },
    });
  });
  await page.goto(`/scan?id=${id}`);
  const trigger = page.getByRole('button', { name: 'Průběh skenu' });
  await expect(trigger).toBeVisible();
  expect(requests).toBe(0);
  await trigger.click();
  const panel = page.getByRole('dialog', { name: 'Průběh skenu' });
  await expect(panel.getByText('HTTP 200', { exact: false })).toBeVisible();
  await expect(
    panel.getByText('https://other.example/private', { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole('link', {
      name: 'Otevřít https://example.com/contact v nové kartě',
    }),
  ).toHaveAttribute('href', 'https://example.com/contact');
  await expect(
    panel.getByRole('link', {
      name: 'Otevřít https://other.example/private v nové kartě',
    }),
  ).toHaveAttribute('target', '_blank');
  const requestsAfterOpen = requests;
  await page.screenshot({
    path: testInfo.outputPath('scan-log.png'),
    fullPage: true,
  });
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  if (testInfo.project.name === 'mobile')
    expect(bounds!.height).toBe(page.viewportSize()!.height);
  else expect(bounds!.height).toBeLessThan(page.viewportSize()!.height * 0.7);
  await panel.getByLabel('Jen chyby').check();
  await expect(
    panel.getByText('https://example.com/contact', { exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByText('https://other.example/private', { exact: true }),
  ).toBeVisible();
  await panel
    .getByRole('combobox', { name: 'Web', exact: true })
    .selectOption(site.origin);
  await expect(
    panel.getByText('Tomuto filtru neodpovídají žádné záznamy.'),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect
    .poll(() =>
      trigger.evaluate((element) => element === document.activeElement),
    )
    .toBe(true);
  await expect(trigger).toContainText('1 chyba');
  expect(requests).toBe(requestsAfterOpen);
});

test('retries failed logs and preserves scroll position while new events arrive', async ({
  page,
}) => {
  const id = '00000000-0000-4000-8000-000000000093';
  await mockApi(page, [snapshot(id, { status: 'running' })]);
  let failure = true;
  let count = 60;
  let requests = 0;
  await page.route(`**/scans/${id}/log`, async (route) => {
    requests++;
    if (failure)
      return route.fulfill({
        status: 503,
        json: { error: 'Internal secret must not be shown' },
      });
    await route.fulfill({
      json: {
        truncated: true,
        events: Array.from({ length: count }, (_, index) => ({
          id: index + 1,
          at: '2026-09-12T10:00:00Z',
          type: 'page_finished',
          level: 'info',
          origin: site.origin,
          url: `https://example.com/page-${index + 1}`,
          status: 'ok',
          httpStatus: 200,
          linkCount: 2,
        })),
      },
    });
  });
  await page.goto(`/scan?id=${id}`);
  await page.getByRole('button', { name: 'Průběh skenu' }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('alert')).toContainText(
    'Průběh skenu se nepodařilo načíst',
  );
  await expect(panel).not.toContainText('Internal secret');
  failure = false;
  await panel.getByRole('button', { name: 'Zkusit znovu' }).click();
  const list = panel.getByRole('region', { name: 'Záznamy skenu' });
  await expect(list.locator('li')).toHaveCount(60);
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(
    panel.getByRole('button', { name: 'Sledovat nové záznamy' }),
  ).toBeVisible();
  count = 61;
  await expect(list.locator('li')).toHaveCount(61, { timeout: 10000 });
  expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
  await panel.getByRole('button', { name: 'Sledovat nové záznamy' }).click();
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);
  await panel.getByRole('button', { name: 'Zavřít průběh skenu' }).click();
  const requestsAtClose = requests;
  await page.waitForTimeout(3300);
  expect(requests).toBe(requestsAtClose);
});

test('lets a slow log request finish while running snapshots keep updating', async ({
  page,
}) => {
  const id = '00000000-0000-4000-8000-000000000094';
  const api = await mockApi(page, [snapshot(id, { status: 'running' })]);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route(`**/scans/${id}/log`, async (route) => {
    requests++;
    await gate;
    await route.fulfill({
      json: {
        truncated: false,
        events: [
          {
            id: 1,
            at: '2026-09-12T10:00:00Z',
            type: 'scan_started',
            level: 'info',
          },
        ],
      },
    });
  });
  await page.goto(`/scan?id=${id}`);
  await page.getByRole('button', { name: 'Průběh skenu' }).click();
  await expect.poll(() => requests).toBeGreaterThan(0);
  const requestsAtOpen = requests;
  api.maps.get(id)!.updatedAt = '2026-09-12T10:01:00Z';
  api.maps.get(id)!.activity = {
    phase: 'fetching_robots',
    updatedAt: '2026-09-12T10:01:00Z',
    origin: site.origin,
  };
  await expect(
    page.getByRole('dialog').getByTestId('scan-activity'),
  ).toContainText('Kontroluji robots.txt');
  expect(requests).toBe(requestsAtOpen);
  release();
  await expect(
    page.getByRole('dialog').getByText('Spuštěn sken', { exact: true }),
  ).toBeVisible();
  api.snapshotFailure = 503;
  await expect(
    page.getByRole('dialog').getByTestId('scan-activity'),
  ).toContainText('Aktuální stav se nedaří ověřit', { timeout: 10000 });
  await expect(
    page.getByRole('dialog').locator('.scan-activity-spinner'),
  ).toHaveCount(0);
});

async function mockHistory(
  page: Page,
  status: ScanSnapshot['status'] = 'completed',
) {
  const first = snapshot('00000000-0000-4000-8000-000000000099', {
    runId: '00000000-0000-4000-8000-000000000101',
    runNumber: 1,
    runCreatedAt: '2026-09-12T08:00:00.000Z',
    archived: false,
    status,
    results: [savedResult],
    pageCount: 1,
  });
  const api = await mockApi(page, [first]);
  const state = {
    api,
    first,
    archives: [] as ScanSnapshot[],
    rescanBodies: [] as unknown[],
    historyGate: undefined as Promise<void> | undefined,
    historyRequested: false,
    logGate: undefined as Promise<void> | undefined,
    logRequested: false,
    limit: 10,
  };
  await page.route(`**${API_PREFIX}/scans/${first.id}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const current = api.maps.get(first.id)!;
    if (path.endsWith('/rescan')) {
      const body = route.request().postDataJSON();
      state.rescanBodies.push(body);
      expect(body).toEqual({ runId: current.runId });
      state.archives.unshift({ ...structuredClone(current), archived: true });
      const next = snapshot(first.id, {
        runId: '00000000-0000-4000-8000-000000000102',
        runNumber: 2,
        runCreatedAt: '2026-09-13T08:00:00.000Z',
        archived: false,
        status: 'running',
        activity: { phase: 'queued', updatedAt: '2026-09-13T08:00:00.000Z' },
      });
      api.maps.set(first.id, next);
      return route.fulfill({ json: next });
    }
    if (path.endsWith('/runs')) {
      return route.fulfill({
        json: { runs: [current, ...state.archives], limit: state.limit },
      });
    }
    const match = path.match(/\/runs\/([^/]+)(\/log)?$/);
    if (!match) return route.fallback();
    const run = [current, ...state.archives].find(
      (item) => item.runId === match[1],
    );
    if (!run) return route.fulfill({ status: 404, json: {} });
    if (match[2]) {
      state.logRequested = true;
      if (state.logGate) await state.logGate;
      return route.fulfill({
        json: {
          truncated: false,
          events: [
            {
              id: 1,
              at: run.updatedAt,
              level: 'info',
              type: 'page_finished',
              status: 'ok',
              url: `https://example.com/log-run-${run.runNumber}`,
            },
          ],
        },
      });
    }
    const response = structuredClone(run);
    state.historyRequested = true;
    if (state.historyGate) await state.historyGate;
    return route.fulfill({
      json: response,
      headers: { 'X-Test-History': 'loaded' },
    });
  });
  return state;
}

test('rescans the same map live and preserves a read-only history with its own log after reload', async ({
  page,
}) => {
  const state = await mockHistory(page);
  const { first } = state;
  await page.clock.install();
  await page.goto(`/scan?id=${first.id}`);
  await expect(page.getByTestId('link-count')).toHaveText('1');
  await expect(
    page.getByRole('button', { name: 'Spustit skenování', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Skenovat znovu', exact: true }),
  ).toHaveClass(/scan-button-primary/);
  await page
    .getByRole('button', { name: 'Skenovat znovu', exact: true })
    .click();
  await expect(page).toHaveURL(`/scan?id=${first.id}`);
  await expect(page.getByTestId('link-count')).toHaveText('0');
  await expect(page.getByTestId('scan-activity')).toContainText(
    'Čeká na zpracování',
  );
  await expect(
    page.getByRole('button', { name: 'Skenovat znovu', exact: true }),
  ).toBeDisabled();
  expect(state.rescanBodies).toHaveLength(1);
  state.api.maps.get(first.id)!.results = [savedResult];
  await page.clock.fastForward(3000);
  await expect(page.getByTestId('link-count')).toHaveText('1');
  await page
    .getByLabel('Historie skenů', { exact: true })
    .selectOption(first.runId!);
  await expect(page.getByText('Prohlížíš historii · sken #1')).toBeVisible();
  await expect(page).toHaveURL(`/scan?id=${first.id}&run=${first.runId}`);
  await expect(
    page.getByRole('button', { name: 'Skenovat znovu', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Přidat web', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Doména example.com', exact: true })
    .click();
  await expect(
    page.getByRole('slider', { name: /Interval skenu/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'Pozastavit skenování webu',
      exact: true,
    }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Prohlížíš historii · sken #1')).toBeVisible();
  await page.getByRole('button', { name: 'Průběh skenu', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'https://example.com/log-run-1',
  );
  await page.getByRole('button', { name: 'Zavřít průběh skenu' }).click();
  await page.getByRole('button', { name: 'Zpět na aktuální sken' }).click();
  await expect(
    page.getByRole('button', { name: 'Pozastavit sken', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(`/scan?id=${first.id}`);
});

test('ignores an older current snapshot after rescan and an archived response after returning to current', async ({
  page,
}) => {
  const state = await mockHistory(page);
  await page.clock.install();
  await page.goto(`/scan?id=${state.first.id}`);
  await expect(
    page.getByRole('button', { name: 'Skenovat znovu', exact: true }),
  ).toBeEnabled();
  let releaseSnapshot = () => {};
  state.api.nextSnapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  await page.clock.fastForward(3000);
  await expect.poll(() => state.api.heldSnapshotStarted).toBe(true);
  await page
    .getByRole('button', { name: 'Skenovat znovu', exact: true })
    .click();
  await expect(page.getByTestId('link-count')).toHaveText('0');
  const oldResponse = page.waitForResponse(
    (response) => response.headers()['x-test-snapshot'] === 'held',
  );
  releaseSnapshot();
  await (await oldResponse).finished();
  await expect(page.getByTestId('link-count')).toHaveText('0');
  let releaseHistory = () => {};
  state.historyGate = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  await page
    .getByLabel('Historie skenů', { exact: true })
    .selectOption(state.first.runId!);
  await expect.poll(() => state.historyRequested).toBe(true);
  await page.getByRole('button', { name: 'Zpět na aktuální sken' }).click();
  await expect(
    page.getByRole('button', { name: 'Pozastavit sken', exact: true }),
  ).toBeVisible();
  const historicResponse = page.waitForResponse(
    (response) => response.headers()['x-test-history'] === 'loaded',
  );
  releaseHistory();
  await (await historicResponse).finished();
  await expect(page.getByText('Prohlížíš historii · sken #1')).toHaveCount(0);
  await expect(page.getByTestId('link-count')).toHaveText('0');
});

test('never shows a stale log from a prior run and keeps archived paused scans read-only', async ({
  page,
}) => {
  const state = await mockHistory(page, 'paused');
  await page.goto(`/scan?id=${state.first.id}`);
  await expect(
    page.getByRole('button', { name: 'Pokračovat ve skenování', exact: true }),
  ).toHaveClass(/scan-button-primary/);
  await expect(
    page.getByRole('button', { name: 'Skenovat znovu', exact: true }),
  ).not.toHaveClass(/scan-button-primary/);
  let releaseLog = () => {};
  state.logGate = new Promise<void>((resolve) => {
    releaseLog = resolve;
  });
  await page.getByRole('button', { name: 'Průběh skenu', exact: true }).click();
  await expect.poll(() => state.logRequested).toBe(true);
  await page.getByRole('button', { name: 'Zavřít průběh skenu' }).click();
  await page
    .getByRole('button', { name: 'Skenovat znovu', exact: true })
    .click();
  state.logGate = undefined;
  releaseLog();
  await page.getByRole('button', { name: 'Průběh skenu', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'https://example.com/log-run-2',
  );
  await expect(page.getByRole('dialog')).not.toContainText(
    'https://example.com/log-run-1',
  );
  await page.getByRole('button', { name: 'Zavřít průběh skenu' }).click();
  await page
    .getByLabel('Historie skenů', { exact: true })
    .selectOption(state.first.runId!);
  await expect(page.getByText('Prohlížíš historii · sken #1')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Pokračovat ve skenování', exact: true }),
  ).toHaveCount(0);
});

test('explains the history limit and prevents another rescan without deleting history', async ({
  page,
}) => {
  const state = await mockHistory(page, 'limited');
  state.archives = Array.from({ length: 9 }, (_, index) => ({
    ...state.first,
    runId: `00000000-0000-4000-8000-${String(index + 200).padStart(12, '0')}`,
    archived: true,
  }));
  await page.goto(`/scan?id=${state.first.id}`);
  await expect(
    page.getByText('Dosažen limit 10 průchodů této mapy.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Skenovat znovu', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Spustit skenování', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Skenovat znovu', exact: true }),
  ).toHaveClass(/scan-button-primary/);
  expect(state.archives).toHaveLength(9);
});

test('recovers a failed history load and allows rescanning without a page reload', async ({
  page,
}) => {
  const state = await mockHistory(page);
  let requests = 0;
  await page.route(
    `**${API_PREFIX}/scans/${state.first.id}/runs`,
    async (route) => {
      requests += 1;
      if (requests === 1) return route.fulfill({ status: 503, json: {} });
      return route.fallback();
    },
  );
  await page.goto(`/scan?id=${state.first.id}`);
  const rescan = page.getByRole('button', {
    name: 'Skenovat znovu',
    exact: true,
  });
  await expect(page.getByRole('alert')).toContainText(
    'Historii skenů se nepodařilo načíst',
  );
  await expect(rescan).toBeDisabled();
  await page
    .getByRole('button', { name: 'Zkusit načíst historii znovu', exact: true })
    .click();
  await expect(rescan).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(requests).toBe(2);
  await rescan.click();
  await expect(page.getByTestId('scan-activity')).toContainText(
    'Čeká na zpracování',
  );
  expect(state.rescanBodies).toHaveLength(1);
});
