import { expect, test } from '@playwright/test';
import type { Page as BrowserPage } from '@playwright/test';
import type { PageResult, ScanSnapshot } from '../shared/scan';
import { expectSiteSpacing } from './graph-spacing';
import { scanToDataset } from '../src/scan-dataset';

function snapshot(results: PageResult[] = []): ScanSnapshot {
  return {
    id: 'adapter-test',
    status: 'running',
    createdAt: '2026-09-12T12:00:00Z',
    updatedAt: '2026-09-12T12:00:00Z',
    pageCount: results.length,
    sites: [
      {
        origin: 'https://alpha.cz',
        seedUrl: 'https://alpha.cz/start',
        intervalMs: 3000,
        maxPages: 50,
        paused: false,
      },
      {
        origin: 'https://beta.cz',
        seedUrl: 'https://beta.cz/',
        intervalMs: 5000,
        maxPages: 50,
        paused: false,
      },
    ],
    results,
  };
}

function result(overrides: Partial<PageResult> = {}): PageResult {
  return {
    sourceUrl: 'https://alpha.cz/start',
    title: 'Alpha home',
    observedAt: '2026-09-12T12:01:00Z',
    status: 'ok',
    httpStatus: 200,
    links: [],
    discoveredUrls: [],
    truncated: false,
    ...overrides,
  };
}

test('keeps seeds known until fetched and distinguishes failed results from successful pages', () => {
  const initial = scanToDataset(snapshot());
  expect(initial.pages.map((page) => page.status)).toEqual(['known', 'known']);
  expect(initial.sites.every((site) => site.scanned)).toBe(true);
  const data = scanToDataset(
    snapshot([
      result({
        status: 'network_error',
        error: 'Offline',
        links: [
          {
            targetUrl: 'https://unobserved.cz/',
            anchor: 'Ignored',
            rel: [],
            region: 'content',
            occurrences: 1,
          },
        ],
      }),
    ]),
  );
  expect(
    data.pages.find((page) => page.url === 'https://alpha.cz/start'),
  ).toMatchObject({ status: 'network_error', error: 'Offline' });
  expect(data.links).toHaveLength(0);
  expect(data.sites).toHaveLength(2);
});

test('deduplicates page pairs and retry results, preserves exact origins and target status', () => {
  const found = {
    targetUrl: 'https://beta.cz/?q=1#section',
    anchor: 'Beta',
    rel: ['nofollow'],
    region: 'content' as const,
    occurrences: 2,
  };
  const source = result({
    links: [
      found,
      {
        ...found,
        targetUrl: 'https://beta.cz/?q=1',
        rel: ['sponsored'],
        occurrences: 3,
      },
      { ...found, targetUrl: 'http://beta.cz/' },
    ],
  });
  const data = scanToDataset(
    snapshot([
      source,
      source,
      result({ sourceUrl: 'https://beta.cz/?q=1', title: 'Loaded beta' }),
    ]),
  );
  expect(data.links).toHaveLength(2);
  const link = data.links.find(
    (item) => item.target.url === 'https://beta.cz/?q=1',
  )!;
  expect(link.occurrences).toBe(5);
  expect(link.rel).toBe('nofollow sponsored');
  expect(link.target).toMatchObject({ status: 'ok', title: 'Loaded beta' });
  expect(data.sites.find((site) => site.id === 'http://beta.cz')).toMatchObject(
    { scanned: false, origin: 'http://beta.cz' },
  );
  expect(
    data.pages.filter((page) => page.id === 'https://beta.cz/?q=1'),
  ).toHaveLength(1);
});

test('newly discovered origins preserve existing IDs, colors and initial positions', () => {
  const first = result({
    links: [
      {
        targetUrl: 'https://external.cz/article',
        anchor: 'Article',
        rel: [],
        region: 'unknown',
        occurrences: 1,
      },
    ],
  });
  const before = scanToDataset(snapshot([first]));
  const after = scanToDataset(
    snapshot([
      first,
      result({
        sourceUrl: 'https://alpha.cz/next',
        links: [
          {
            targetUrl: 'https://another.cz/',
            anchor: 'Another',
            rel: [],
            region: 'footer',
            occurrences: 1,
          },
        ],
      }),
    ]),
  );
  for (const site of before.sites)
    expect(after.sites.find((item) => item.id === site.id)).toEqual(site);
  expect(after.links[0].id).toBe(before.links[0].id);
  expect(after.links[0].region).toBe('Neznámé');
});

test('does not turn the internal discovery queue or non-web links into graph edges', () => {
  const data = scanToDataset(
    snapshot([
      result({
        discoveredUrls: ['https://alpha.cz/queued'],
        links: [
          {
            targetUrl: 'mailto:hello@beta.cz',
            anchor: 'Email',
            rel: [],
            region: 'content',
            occurrences: 1,
          },
          {
            targetUrl: 'https://alpha.cz/internal',
            anchor: 'Internal',
            rel: [],
            region: 'content',
            occurrences: 1,
          },
        ],
      }),
    ]),
  );
  expect(data.links).toHaveLength(0);
  expect(data.pages.find((page) => page.path === '/queued')?.status).toBe(
    'known',
  );
  expect(data.sites).toHaveLength(2);
});

test('measures only directly linked preview targets and preserves backlinks and further known sites', () => {
  const found = (targetUrl: string) => ({
    targetUrl,
    anchor: 'Link',
    rel: [],
    region: 'content' as const,
    occurrences: 1,
  });
  const scan = snapshot([
    result({
      links: [
        found('https://external.cz/landing'),
        found('https://external.cz/landing#duplicate'),
        found('https://external.cz/redirect'),
        found('https://external.cz/blocked'),
        found('https://external.cz/unknown'),
      ],
    }),
    result({
      sourceUrl: 'https://external.cz/landing',
      crawlMode: 'preview',
      links: [
        found('https://alpha.cz/contact'),
        found('https://third.cz/only-known'),
        found('https://external.cz/internal'),
      ],
      discoveredUrls: ['https://external.cz/internal'],
    }),
    result({
      sourceUrl: 'https://external.cz/redirect',
      crawlMode: 'preview',
      status: 'redirect_unresolved',
      redirect: {
        kind: 'same_origin',
        targetUrl: 'https://external.cz/final',
      },
    }),
    result({
      sourceUrl: 'https://external.cz/final',
      crawlMode: 'preview',
    }),
    result({
      sourceUrl: 'https://external.cz/blocked',
      crawlMode: 'preview',
      status: 'robots_denied',
    }),
  ]);
  const data = scanToDataset(scan);
  expect(
    data.sites.find((site) => site.id === 'https://external.cz'),
  ).toMatchObject({
    scanned: false,
    preview: {
      attemptedPages: 4,
      inspectedPages: 2,
      knownTargets: 4,
      checkedTargets: 2,
      failedTargets: 1,
      backlinkCount: 1,
    },
  });
  expect(
    data.sites.find((site) => site.id === 'https://third.cz'),
  ).toMatchObject({
    scanned: false,
    preview: { attemptedPages: 0, knownTargets: 0, backlinkCount: 0 },
  });
  expect(
    data.links.some((link) => link.target.id === 'https://alpha.cz/contact'),
  ).toBe(true);
  expect(
    data.pages.find((page) => page.id === 'https://third.cz/only-known')
      ?.status,
  ).toBe('known');
  expect(
    data.pages.find((page) => page.id === 'https://external.cz/internal')
      ?.status,
  ).toBe('known');
  const promoted = scanToDataset({
    ...scan,
    sites: [
      ...scan.sites,
      {
        origin: 'https://external.cz',
        seedUrl: 'https://external.cz/',
        intervalMs: 3000,
        maxPages: 100,
        paused: false,
      },
    ],
  });
  expect(
    promoted.sites.find((site) => site.id === 'https://external.cz'),
  ).toMatchObject({ scanned: true });
  expect(
    promoted.sites.find((site) => site.id === 'https://external.cz')?.preview,
  ).toBeUndefined();
  expect(promoted.links.map((link) => link.id)).toEqual(
    data.links.map((link) => link.id),
  );
});

test('does not report pending preview redirects as failed or loop on cyclic redirects', () => {
  const data = scanToDataset(
    snapshot([
      result({
        links: ['pending', 'loop'].map((path) => ({
          targetUrl: `https://external.cz/${path}`,
          anchor: path,
          rel: [],
          region: 'content' as const,
          occurrences: 1,
        })),
      }),
      ...['pending', 'loop'].map((path) =>
        result({
          sourceUrl: `https://external.cz/${path}`,
          crawlMode: 'preview',
          status: 'redirect_unresolved',
          redirect: {
            kind: 'same_origin',
            targetUrl: `https://external.cz/${path === 'pending' ? 'not-fetched' : path}`,
          },
        }),
      ),
    ]),
  );
  expect(
    data.sites.find((site) => site.id === 'https://external.cz')?.preview,
  ).toMatchObject({
    checkedTargets: 0,
    failedTargets: 1,
    knownTargets: 2,
  });
});

async function mockScan(page: BrowserPage, current: () => ScanSnapshot) {
  await page.route('**/api/v1/**', async (route) => {
    await route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith('/session')
        ? { ok: true }
        : current(),
    });
  });
}

async function sitePositions(page: BrowserPage) {
  return page.locator('[data-drag-site]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const circle = node.querySelector('circle')!;
      return {
        id: node.getAttribute('data-drag-site')!,
        x: Number(circle.getAttribute('cx')),
        y: Number(circle.getAttribute('cy')),
      };
    }),
  );
}

async function expectBalancedLiveLayout(page: BrowserPage) {
  const positions = await sitePositions(page);
  const hub = positions.find((site) => site.id === 'https://alpha.cz')!;
  const targets = positions.filter((site) => site.id !== hub.id);
  expect(targets.length).toBeGreaterThan(2);
  const distances = targets.map((site) =>
    Math.hypot(site.x - hub.x, site.y - hub.y),
  );
  expect(Math.max(...distances) - Math.min(...distances)).toBeLessThan(1);
  const angles = targets
    .map((site) => Math.atan2(site.y - hub.y, site.x - hub.x))
    .sort((a, b) => a - b);
  const expectedGap = (2 * Math.PI) / targets.length;
  for (let index = 0; index < angles.length; index++) {
    const next = angles[index + 1] ?? angles[0] + 2 * Math.PI;
    expect(Math.abs(next - angles[index] - expectedGap)).toBeLessThan(0.002);
  }
}

test('renders a live arbitrary dataset and keeps a moved expanded origin stable as results arrive', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let current = snapshot([
    result({
      links: [
        {
          targetUrl: 'https://beta.cz/',
          anchor: 'Beta',
          rel: [],
          region: 'content',
          occurrences: 1,
        },
      ],
    }),
  ]);
  await mockScan(page, () => current);
  await page.clock.install();
  await page.goto('/scan?id=adapter-test');
  await expect(page.getByTestId('link-count')).toHaveText('1');
  await expect(
    page.getByRole('button', { name: 'Přehrát demo', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Ukázka: 20 stránek', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.local-indicator')).toHaveText('Serverový sken');
  const domain = page.getByRole('button', {
    name: 'Doména alpha.cz',
    exact: true,
  });
  await domain.focus();
  await domain.press('ArrowRight');
  const x = await domain.locator('circle').getAttribute('cx');
  await page.getByRole('button', { name: 'Zobrazit 1 známých URL' }).click();
  await page
    .getByRole('button', { name: 'Stránka alpha.cz/start', exact: true })
    .click();
  await expect(
    page.getByText('Úspěšně načtená stránka', { exact: true }),
  ).toBeVisible();
  current = snapshot([
    ...current.results,
    result({
      sourceUrl: 'https://alpha.cz/next',
      links: [
        {
          targetUrl: 'https://third.cz/',
          anchor: 'Third',
          rel: [],
          region: 'navigation',
          occurrences: 1,
        },
      ],
    }),
  ]);
  await page.clock.fastForward(3000);
  await expect(page.getByTestId('link-count')).toHaveText('2');
  await expect(domain.locator('circle')).toHaveAttribute('cx', x!);
  await expect(
    page.getByRole('button', { name: 'Stránka alpha.cz/next', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Doména beta.cz', exact: true })
    .focus();
  await page
    .getByRole('button', { name: 'Doména beta.cz', exact: true })
    .press('Enter');
  await page.getByRole('button', { name: 'Zobrazit 1 známých URL' }).click();
  await page
    .getByRole('button', { name: 'Stránka beta.cz/', exact: true })
    .click();
  await expect(
    page.getByText('Pouze známá URL · zatím nenačteno', { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('limits live map detail while preserving every discovered link in table and CSV', async ({
  page,
}, testInfo) => {
  const found = Array.from({ length: 240 }, (_, index) => ({
    targetUrl: `https://external.cz/page-${index}`,
    anchor: index === 0 ? '=1+1' : `Page ${index}`,
    rel: ['nofollow', 'sponsored'],
    region: 'content' as const,
    occurrences: 1,
  }));
  found.push(
    ...Array.from({ length: 12 }, (_, index) => ({
      targetUrl: `https://other-${index}.cz/`,
      anchor: `Other ${index}`,
      rel: [],
      region: 'content' as const,
      occurrences: 1,
    })),
  );
  const current = snapshot([result({ links: found })]);
  await mockScan(page, () => current);
  await page.goto('/scan?id=adapter-test');
  await expect(page.getByTestId('link-count')).toHaveText('252');
  await expect(page.locator('.site-node')).toHaveCount(12);
  await expect(
    page.getByText('Dalších 3 odkazovaných webů najdete v seznamu a tabulce.'),
  ).toBeAttached();
  const external = page.getByRole('button', {
    name: 'Doména external.cz',
    exact: true,
  });
  await expect(page.locator('.sidebar-section-label > span').last()).toHaveText(
    '15',
  );
  if (testInfo.project.name === 'desktop') {
    await page.getByLabel('Hledat doménu v seznamu').fill('other-11.cz');
    await expect(
      page.locator('.site-list').getByRole('button', { name: /other-11.cz/ }),
    ).toBeVisible();
    await page.getByLabel('Hledat doménu v seznamu').fill('');
  }
  await page
    .getByLabel('Vybrat web v mapě')
    .selectOption('https://other-11.cz');
  await expect(page.locator('.inspector h2')).toHaveText('other-11.cz');
  await expect(
    page.locator('.inspector').getByRole('button', {
      name: 'Proskenovat https://other-11.cz/',
      exact: true,
    }),
  ).toBeEnabled();
  const center = await external.locator('circle').evaluate((circle) => ({
    x: Number(circle.getAttribute('cx')),
    y: Number(circle.getAttribute('cy')),
  }));
  const dots = external.locator('..').locator('.page-summary-dot');
  await expect(dots).toHaveCount(24);
  const quadrants = await dots.evaluateAll((circles, center) => {
    const counts = [0, 0, 0, 0];
    for (const circle of circles) {
      const x = Number(circle.getAttribute('cx')) - center.x;
      const y = Number(circle.getAttribute('cy')) - center.y;
      counts[(x < 0 ? 1 : 0) + (y < 0 ? 2 : 0)]++;
    }
    return counts;
  }, center);
  // Allow angular jitter and boundary rounding while requiring a balanced full circle.
  for (const count of quadrants) {
    expect(count).toBeGreaterThanOrEqual(4);
    expect(count).toBeLessThanOrEqual(8);
  }
  await page
    .getByRole('button', { name: /^Propojení alpha.cz → external.cz/ })
    .press('Enter');
  await expect(
    page.getByText('240 unikátních dvojic stránek', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.detail-link-row')).toHaveCount(200);
  await expect(
    page.getByText(
      'Zobrazeno 200 z 240 vazeb. Všechny vazby najdeš v tabulce a CSV.',
      { exact: true },
    ),
  ).toBeVisible();
  await external.focus();
  await external.press('Enter');
  await page
    .getByRole('button', { name: 'Zobrazit známé cílové URL', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /^Stránka external.cz/ }),
  ).toHaveCount(60);
  await page.getByRole('button', { name: 'Zobrazit tabulku' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(252);
  const downloadPromise = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Exportovat zobrazené odkazy do CSV' })
    .click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  let csv = '';
  for await (const chunk of stream!) csv += chunk.toString();
  expect(csv.split('\r\n')).toHaveLength(253);
  expect(csv).toContain('local_scan');
  expect(csv).toContain('"\'=1+1"');
  expect(csv).toContain('https://other-11.cz/');
  await page.getByRole('button', { name: 'nofollow', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(240);
});

test('balances crowded live domains by default and preserves manual placement as the map expands', async ({
  page,
}, testInfo) => {
  const domains = [
    'psychedelicalpha.com',
    'doubleblindmag.com',
    'psychedelicinvest.com',
    'pubmed.ncbi.nlm.nih.gov',
    'www.nature.com',
    'en.wikipedia.org',
    'medicalxpress.com',
    'www.ecstaticintegration.org',
    'thepsychedelicblog.substack.com',
    'a-very-long-domain-name-for-testing-label-space.example.com',
  ];
  const links = domains.map((domain) => ({
    targetUrl: `https://${domain}/`,
    anchor: domain,
    rel: [],
    region: 'content' as const,
    occurrences: 1,
  }));
  let current = snapshot([result({ links: links.slice(0, 8) })]);
  current.sites = current.sites.slice(0, 1);
  await mockScan(page, () => current);
  await page.clock.install();
  const pollScan = async () => {
    const responsePromise = page.waitForResponse('**/scans/adapter-test');
    await page.clock.fastForward(3000);
    const response = await responsePromise;
    await response.finished();
    await page.clock.runFor(50);
  };
  await page.goto('/scan?id=adapter-test');
  await expect(page.locator('.site-node')).toHaveCount(9);
  await expectSiteSpacing(page);
  await expectBalancedLiveLayout(page);
  const initialPositions = await sitePositions(page);
  await pollScan();
  expect(await sitePositions(page)).toEqual(initialPositions);
  const graph = page.getByLabel('Interaktivní mapa odkazů mezi weby');
  const initialFrame = await graph.getAttribute('viewBox');
  for (let step = 0; step < 3; step++)
    await page
      .getByRole('button', { name: 'Přiblížit mapu', exact: true })
      .click();
  await expect(page.getByLabel('Přiblížení mapy')).toHaveText('173 %');
  await expect(page.locator('.site-node.is-expanded')).toHaveCount(0);
  expect(await sitePositions(page)).toEqual(initialPositions);
  await expect(graph).toHaveAttribute('viewBox', initialFrame!);
  await expectSiteSpacing(page, false);
  for (let step = 0; step < 3; step++)
    await page
      .getByRole('button', { name: 'Oddálit mapu', exact: true })
      .click();
  await expect(page.locator('.site-node.is-expanded')).toHaveCount(0);
  await expectSiteSpacing(page);
  await expectBalancedLiveLayout(page);
  current = { ...current, results: [result({ links })] };
  await pollScan();
  await expect(page.locator('.site-node')).toHaveCount(11);
  await expectSiteSpacing(page);
  await expectBalancedLiveLayout(page);
  await expect(graph).not.toHaveAttribute('viewBox', initialFrame!);
  await page.locator('.graph-area').screenshot({
    path: testInfo.outputPath('balanced-live-map.png'),
  });
  const grownPositions = await sitePositions(page);
  await page.reload();
  await expect(page.locator('.site-node')).toHaveCount(11);
  await expectSiteSpacing(page);
  await expectBalancedLiveLayout(page);
  expect(await sitePositions(page)).toEqual(grownPositions);
  await page.getByRole('button', { name: 'Zobrazit celou mapu' }).click();
  await expectSiteSpacing(page);
  await expectBalancedLiveLayout(page);
  await page.getByLabel('Další odkazované weby').uncheck();
  await expect(page.locator('.site-node')).toHaveCount(1);
  await page.getByLabel('Další odkazované weby').check();
  await expect(page.locator('.site-node')).toHaveCount(11);
  await expectSiteSpacing(page);
  await expectBalancedLiveLayout(page);
  const domain = page.getByRole('button', {
    name: 'Doména doubleblindmag.com',
    exact: true,
  });
  await domain.focus();
  for (let step = 0; step < 8; step++) await domain.press('Shift+ArrowRight');
  await expectSiteSpacing(page);
  const movedPositions = await sitePositions(page);
  const movedDomain = movedPositions.find(
    (site) => site.id === 'https://doubleblindmag.com',
  );
  expect(movedDomain).not.toEqual(
    grownPositions.find((site) => site.id === movedDomain!.id),
  );
  await pollScan();
  expect(await sitePositions(page)).toEqual(movedPositions);
  await domain.press('Enter');
  await page
    .getByRole('button', { name: 'Zobrazit známé cílové URL', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Stránka doubleblindmag.com/',
      exact: true,
    }),
  ).toHaveCount(1);
  await expectSiteSpacing(page);
  expect(
    (await sitePositions(page)).find((site) => site.id === movedDomain!.id),
  ).toEqual(movedDomain);
  const expandedPositions = await sitePositions(page);
  await pollScan();
  expect(await sitePositions(page)).toEqual(expandedPositions);
  await graph.screenshot({ path: testInfo.outputPath('crowded-map.png') });
  await page.getByRole('button', { name: 'Zobrazit celou mapu' }).click();
  await expectSiteSpacing(page);
  await expectBalancedLiveLayout(page);
});
