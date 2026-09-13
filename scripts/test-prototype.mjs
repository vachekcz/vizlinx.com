import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { chromium, expect } from '@playwright/test';

const appPort = 8897;
const appOrigin = `http://127.0.0.1:${appPort}`;
const origins = ['https://a.vizlinx.com', 'https://b.vizlinx.com'];
const quotaOrigin = 'https://quota.vizlinx.com';
const fetched = [];
const apiFailures = [];
let context;
let browser;
let mf;
let app;
let releaseSlowPage;
let slowPageReleased = false;

const html = (body) =>
  new Response(body, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });

// All outbound traffic stays inside the fixture: the browser has no extension,
// and actual Worker fetch/HTML parsing/D1 writes run against public-looking URLs.
async function fixture(request) {
  const url = new URL(request.url);
  assert.ok(
    [...origins, quotaOrigin].includes(url.origin),
    `Unexpected server fetch: ${url.href}`,
  );
  fetched.push(url.href);
  if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
  if (url.origin === origins[0] && url.pathname === '/redirect-start')
    return new Response('', {
      status: 302,
      headers: { Location: '/redirect-final/' },
    });
  if (url.origin === origins[0] && url.pathname === '/redirect-final/')
    return html('<title>Redirect landing</title><a href="out">Next</a>');
  if (url.origin === origins[0] && url.pathname === '/redirect-final/out')
    return new Response('', {
      status: 302,
      headers: { Location: `${origins[1]}/redirect-must-not-fetch` },
    });
  if (url.origin === quotaOrigin) {
    const index = url.pathname === '/' ? 0 : Number(url.pathname.slice(1));
    assert.ok(Number.isInteger(index) && index >= 0 && index <= 100);
    return html(
      `<title>Quota ${index}</title><main>${index < 100 ? `<a href="/${index + 1}">Next page</a>` : 'Last page'}</main>`,
    );
  }
  if (url.origin === origins[0] && url.pathname === '/pause-root') {
    return html(
      `<title>Pause root</title><main><a href="/pause-slow">Next page</a><a href="${origins[1]}/deep">Partner</a></main>`,
    );
  }
  if (url.origin === origins[0] && url.pathname === '/pause-slow') {
    if (!slowPageReleased)
      await new Promise((done) => {
        releaseSlowPage = () => {
          slowPageReleased = true;
          done();
        };
      });
    return html(
      `<title>Paused page</title><main><a href="${origins[1]}/deep">Partner</a></main>`,
    );
  }
  if (url.origin === origins[0])
    return html(
      `<title>Alpha</title><main><a href="${origins[1]}/deep">Partner</a></main>`,
    );
  if (url.pathname === '/deep')
    return html(
      `<title>Beta detail</title><main><a href="${origins[0]}/">Home</a></main>`,
    );
  return html('<title>Beta</title><main>No links here</main>');
}

const listen = (server, port) =>
  new Promise((done, reject) =>
    server.once('error', reject).listen(port, '127.0.0.1', done),
  );
const close = (server) =>
  new Promise((done) => {
    if (!server) return done();
    server.closeAllConnections();
    server.close(done);
  });

try {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      // Advance the clock only between real Queue deliveries and remove delivery
      // delays in this test bundle. Production throttle and quota code is intact.
      contents: `import worker from './worker/index.ts';
        let elapsed = 0;
        const realNow = Date.now.bind(Date);
        Date.now = () => realNow() + elapsed;
        function testEnvironment(env) {
          return { ...env, CRAWL_QUEUE: { send: (body) => env.CRAWL_QUEUE.send(body) } };
        }
        export default {
          fetch(request, env, ctx) { return worker.fetch(request, testEnvironment(env), ctx); },
          queue(batch, env, ctx) {
            elapsed += 1_001;
            return worker.queue(batch, testEnvironment(env), ctx);
          },
        };`,
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    target: 'es2022',
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-09-11',
      bindings: { CRAWLER_ENABLED: 'true' },
      d1Databases: ['DB'],
      queueProducers: { CRAWL_QUEUE: 'prototype-crawl' },
      queueConsumers: {
        'prototype-crawl': {
          maxBatchSize: 1,
          maxBatchTimeout: 0,
          maxRetries: 0,
        },
      },
      serviceBindings: {
        ASSETS: () =>
          new Response('Asset requests must use the local asset server.', {
            status: 500,
          }),
      },
      outboundService: fixture,
    }),
  );
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir('migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    const migration = await readFile(`migrations/${file}`, 'utf8');
    for (const sql of migration.split(';').filter((sql) => sql.trim()))
      await db.prepare(sql).run();
  }
  const mime = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  };
  app = createServer(async (request, response) => {
    try {
      if (request.url.startsWith('/api/')) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const result = await mf.dispatchFetch(`${appOrigin}${request.url}`, {
          method: request.method,
          headers: request.headers,
          ...(body.length ? { body } : {}),
        });
        const headers = Object.fromEntries(result.headers);
        const cookies = result.headers.getSetCookie();
        if (cookies.length) headers['set-cookie'] = cookies;
        if (!result.ok)
          apiFailures.push(
            `${request.method} ${request.url}: ${result.status} ${await result.clone().text()}`,
          );
        response.writeHead(result.status, headers);
        response.end(Buffer.from(await result.arrayBuffer()));
        return;
      }
      const pathname = new URL(request.url, appOrigin).pathname;
      const root = resolve('dist');
      let asset = resolve(root, `.${decodeURIComponent(pathname)}`);
      if (!asset.startsWith(`${root}/`)) asset = `${root}/index.html`;
      let content;
      try {
        content = await readFile(asset);
      } catch {
        asset = `${root}/index.html`;
        content = await readFile(asset);
      }
      response.writeHead(200, {
        'Content-Type': mime[extname(asset)] ?? 'application/octet-stream',
      });
      response.end(content);
    } catch (error) {
      console.error(error);
      response.writeHead(500);
      response.end('Local test server failed.');
    }
  });
  await listen(app, appPort);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  });
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    assert.equal(
      url.origin,
      appOrigin,
      'The browser must never fetch crawled websites',
    );
    return route.continue();
  });
  const scanRow = (id) =>
    db
      .prepare('SELECT status, limit_reason FROM scans WHERE id = ?1')
      .bind(id)
      .first();
  const pageRows = (id) =>
    db
      .prepare(
        'SELECT source_url, result_json FROM page_results WHERE scan_id = ?1 ORDER BY source_url',
      )
      .bind(id)
      .all();
  async function createScan(url) {
    await page.goto(`${appOrigin}/scan`);
    await expect(
      page.getByRole('heading', { name: 'Nová mapa' }),
    ).toBeVisible();
    await page.getByLabel('Weby k prozkoumání').fill(url);
    await page.getByLabel('Interval požadavků (sekundy)').fill('1');
    await page
      .getByRole('button', { name: 'Spustit sken', exact: true })
      .click();
    await expect(page).toHaveURL(/\?id=[a-f0-9-]{36}$/);
    const id = new URL(page.url()).searchParams.get('id');
    assert.match(id, /^[a-f0-9-]{36}$/);
    return id;
  }
  async function addSite(origin) {
    await page.getByRole('button', { name: 'Přidat web', exact: true }).click();
    await page.getByLabel('Nový web', { exact: true }).fill(origin);
    await page.getByLabel('Interval nového webu (sekundy)').fill('1');
    await page
      .getByRole('button', { name: 'Přidat do mapy', exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: 'Pokračovat ve skenování',
        exact: true,
      }),
    ).toBeEnabled();
  }

  const id = await createScan(origins[0]);
  await expect.poll(async () => (await scanRow(id)).status).toBe('completed');
  await expect(page.locator('.scan-stats')).toContainText('1 načtených');
  assert.equal(
    fetched.some((url) => url.startsWith(origins[1])),
    false,
    'External links must not expand the approved fetch scope',
  );
  const original = (await pageRows(id)).results;
  assert.equal(
    JSON.parse(original[0].result_json).links[0].targetUrl,
    `${origins[1]}/deep`,
  );
  await page.getByRole('button', { name: 'Průběh skenu', exact: true }).click();
  const logPanel = page.getByRole('dialog', { name: 'Průběh skenu' });
  const logRows = logPanel
    .getByRole('region', { name: 'Záznamy skenu' })
    .locator('li');
  await expect(logRows).toHaveCount(4);
  await expect(logRows.nth(0)).toContainText('Spuštěn sken');
  await expect(logRows.nth(1)).toContainText(
    'Zkontrolována pravidla robots.txt',
  );
  await expect(logRows.nth(1)).toContainText(`${origins[0]}/robots.txt`);
  await expect(logRows.nth(2)).toContainText('Načteno');
  await expect(logRows.nth(2)).toContainText('HTTP 200');
  await expect(logRows.nth(2)).toContainText('1 odkazů');
  await expect(logRows.nth(2)).toContainText(`${origins[0]}/`);
  await expect(logRows.nth(3)).toContainText('Známá fronta je dokončená');
  await logPanel.getByRole('button', { name: 'Zavřít průběh skenu' }).click();
  await addSite(origins[1]);
  assert.equal(
    fetched.some((url) => url.startsWith(origins[1])),
    false,
    'Adding a website waits for the explicit resume action',
  );
  await page
    .getByRole('button', { name: 'Pokračovat ve skenování', exact: true })
    .click();
  await expect.poll(async () => (await scanRow(id)).status).toBe('completed');
  await expect(page.locator('.scan-stats')).toContainText('3 načtených');
  await expect(page.locator('[data-connection]')).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: 'Doména a.vizlinx.com', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Doména b.vizlinx.com', exact: true }),
  ).toBeVisible();
  assert.ok(
    fetched.includes(`${origins[1]}/deep`),
    'A discovered deep link is scanned after approving its origin',
  );
  assert.deepEqual(
    (await pageRows(id)).results.filter(
      (row) => row.source_url === `${origins[0]}/`,
    ),
    original,
  );
  assert.equal(
    fetched.filter((url) => url === `${origins[0]}/`).length,
    1,
    'Existing successful pages must not be recrawled',
  );
  await page.getByRole('button', { name: 'Průběh skenu', exact: true }).click();
  await expect(logRows).toHaveCount(10);
  await expect(logRows.filter({ hasText: 'Načteno' })).toHaveCount(3);
  await expect(
    logRows.filter({ hasText: 'Zkontrolována pravidla robots.txt' }),
  ).toHaveCount(2);
  await expect(logRows.last()).toContainText('Známá fronta je dokončená');
  const persistedLog = await logRows.allTextContents();
  await page.reload();
  await expect(page.locator('.scan-stats')).toContainText('3 načtených');
  await expect(page.locator('[data-connection]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Průběh skenu', exact: true }).click();
  await expect(logRows).toHaveCount(persistedLog.length);
  assert.deepEqual(
    await logRows.allTextContents(),
    persistedLog,
    'Real crawler history must survive a browser reload',
  );
  await logPanel.getByRole('button', { name: 'Zavřít průběh skenu' }).click();
  await page
    .getByRole('button', { name: 'Zobrazit tabulku', exact: true })
    .click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page
    .getByRole('button', {
      name: `Detail odkazu ${origins[0]}/ → ${origins[1]}/deep`,
      exact: true,
    })
    .click();
  await expect(page.getByText('Partner', { exact: true })).toBeVisible();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({
    path: 'test-results/prototype-live.png',
    fullPage: true,
  });

  // Pause a real in-flight fetch, then change scope and resume from persisted
  // results. Late work from the old generation must not undo the paused state.
  const pausedId = await createScan(`${origins[0]}/pause-root`);
  await expect.poll(() => typeof releaseSlowPage).toBe('function');
  const activity = page.getByTestId('scan-activity');
  await expect(activity).toBeVisible();
  await expect(activity).toContainText('Načítám stránku');
  await expect(activity).toContainText(`${origins[0]}/pause-slow`);
  await expect(activity).toHaveClass(/is-running/);
  await page
    .getByRole('button', { name: 'Pozastavit sken', exact: true })
    .click();
  await expect
    .poll(async () => (await scanRow(pausedId)).status)
    .toBe('paused');
  await expect(activity).toContainText('Skenování pozastaveno');
  await expect(activity).not.toHaveClass(/is-running/);
  releaseSlowPage();
  const savedRoot = (await pageRows(pausedId)).results.find((row) =>
    row.source_url.endsWith('/pause-root'),
  );
  assert.ok(savedRoot, 'Completed results exist before pausing');
  await addSite(origins[1]);
  await page
    .getByRole('button', { name: 'Pokračovat ve skenování', exact: true })
    .click();
  await expect
    .poll(async () => (await scanRow(pausedId)).status)
    .toBe('completed');
  const resumedRows = (await pageRows(pausedId)).results;
  assert.deepEqual(
    resumedRows.find((row) => row.source_url.endsWith('/pause-root')),
    savedRoot,
  );
  assert.equal(
    fetched.filter((url) => url === `${origins[0]}/pause-root`).length,
    1,
  );
  assert.ok(resumedRows.some((row) => row.source_url === `${origins[1]}/deep`));

  const quotaId = await createScan(quotaOrigin);
  await expect
    .poll(async () => (await scanRow(quotaId)).status, { timeout: 60_000 })
    .toBe('limited');
  assert.equal((await scanRow(quotaId)).limit_reason, 'page_limit');
  const quotaRows = (await pageRows(quotaId)).results;
  assert.equal(quotaRows.length, 100);
  const quotaRequests = fetched.filter(
    (url) => url.startsWith(quotaOrigin) && !url.endsWith('/robots.txt'),
  );
  assert.equal(
    quotaRequests.length,
    100,
    'The page budget must be checked before the 101st fetch',
  );
  assert.equal(new Set(quotaRequests).size, 100);
  assert.equal(fetched.includes(`${quotaOrigin}/100`), false);
  await expect(page.locator('.scan-stats')).toContainText('100 načtených');
  const banner = page.getByRole('alert').filter({
    has: page.getByRole('heading', {
      name: 'Dosažen limit 100 stránek na web',
    }),
  });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/kontaktuj správce/i);
  await page.screenshot({
    path: 'test-results/prototype-page-limit.png',
    fullPage: true,
  });
  await page.reload();
  await expect(banner).toBeVisible();
  await expect(page.locator('.scan-stats')).toContainText('100 načtených');
  assert.deepEqual(errors, []);
  const redirectId = await createScan(`${origins[0]}/redirect-start`);
  await expect
    .poll(async () => (await scanRow(redirectId)).status)
    .toBe('completed');
  await expect(page.locator('.scan-stats')).toContainText('1 načtených');
  const redirects = (await pageRows(redirectId)).results.map((row) =>
    JSON.parse(row.result_json),
  );
  assert.equal(redirects.length, 3);
  assert.ok(
    redirects.some(
      (result) =>
        result.sourceUrl === `${origins[0]}/redirect-final/` &&
        result.status === 'ok',
    ),
  );
  assert.equal(
    fetched.includes(`${origins[1]}/redirect-must-not-fetch`),
    false,
  );
  await page.getByRole('button', { name: 'Průběh skenu', exact: true }).click();
  await expect(logPanel).toContainText('Přesměrování v rámci webu');
  await expect(logPanel).toContainText('Přesměrování mimo web – nenásledováno');
  await expect(logPanel).toContainText(
    `Cíl přesměrování: ${origins[1]}/redirect-must-not-fetch`,
  );
  await page.reload();
  await page.getByRole('button', { name: 'Průběh skenu', exact: true }).click();
  await expect(logPanel).toContainText(
    `Cíl přesměrování: ${origins[1]}/redirect-must-not-fetch`,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(apiFailures, []);
  console.log(
    'Prototype E2E passed: actual UI/Worker/Queues/D1; parsed links in graph/table; add website and reload persistence; real scan log and its reload persistence; visible fetching/paused activity; pause and resume; exactly 100 page fetches; same-origin redirects followed and external targets recorded without fetching.',
  );
} finally {
  releaseSlowPage?.();
  await context?.close();
  await browser?.close();
  await close(app);
  await mf?.dispose();
}
