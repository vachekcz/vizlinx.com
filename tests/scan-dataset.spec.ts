import { expect, test } from '@playwright/test';
import type { Page as BrowserPage } from '@playwright/test';
import type { PageResult, ScanSnapshot } from '../shared/scan';
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
  expect(data.pages.some((page) => page.path === '/queued')).toBe(false);
  expect(data.sites).toHaveLength(2);
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
    page.getByText('Dalších 3 odkazovaných webů najdete v tabulce.'),
  ).toBeAttached();
  const external = page.getByRole('button', {
    name: 'Doména external.cz',
    exact: true,
  });
  await expect(page.locator('.sidebar-section-label > span').last()).toHaveText(
    '12',
  );
  if (testInfo.project.name === 'desktop') {
    await page.getByLabel('Hledat doménu v seznamu').fill('other-11.cz');
    await expect(
      page.getByText('Žádná doména neodpovídá hledání.', { exact: true }),
    ).toBeVisible();
    await page.getByLabel('Hledat doménu v seznamu').fill('');
  }
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
  await expect(page.locator('.detail-link-list > button')).toHaveCount(200);
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
