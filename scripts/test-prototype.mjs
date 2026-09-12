import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { chromium, expect } from '@playwright/test';
import { EXTENSION_ID } from '../shared/extension.ts';
import {
  buildTestExtension,
  TEST_APP_ORIGIN,
  TEST_APP_PORT,
  TEST_FIXTURE_PORT,
} from './build-test-extension.mjs';

const appOrigin = TEST_APP_ORIGIN;
const origins = ['http://a.vizlinx.com', 'http://b.vizlinx.com'];
let serverFetches = 0;
let context;
let mf;
let app;
const fetched = [];
let releaseSlowPage;
let releaseQuotaPage;
const resultUploads = [];
const fixtures = createServer((request, response) => {
  fetched.push(`${request.headers.host}${request.url}`);
  if (request.url === '/robots.txt') {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html' });
  if (request.url === '/quota-root') {
    response.end(
      '<title>Quota root</title><a href="/quota-slow">Next page</a>',
    );
    return;
  }
  if (request.url === '/quota-slow') {
    releaseQuotaPage = () => response.end('<title>Quota second page</title>');
    return;
  }
  if (
    request.headers.host === 'a.vizlinx.com' &&
    ['/slow', '/slow-regular'].includes(request.url)
  ) {
    releaseSlowPage = () =>
      response.end(
        request.url === '/slow-regular'
          ? '<title>Regular pairing</title>'
          : '<title>Slow alpha</title><main><a href="/next">Queued</a><a href="http://b.vizlinx.com/deep">Partner</a></main>',
      );
    return;
  }
  if (request.headers.host === 'a.vizlinx.com' && request.url === '/next') {
    response.end('<title>Next alpha</title><main>Done</main>');
    return;
  }
  response.end(
    request.headers.host === 'a.vizlinx.com'
      ? '<title>Alpha</title><main><a href="http://b.vizlinx.com/deep">Partner</a></main>'
      : request.url === '/deep'
        ? '<title>Beta detail</title><main><a href="http://a.vizlinx.com/">Home</a></main>'
        : '<title>Beta</title><main>No links here</main>',
  );
});
const listen = (server, port) =>
  new Promise((done, reject) =>
    server.once('error', reject).listen(port, '127.0.0.1', done),
  );
const close = (server) =>
  new Promise((done) => {
    if (!server) {
      done();
      return;
    }
    server.closeAllConnections();
    server.close(done);
  });

try {
  const bundle = await build({
    entryPoints: ['worker/index.ts'],
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
      d1Databases: ['DB'],
      serviceBindings: {
        ASSETS: () =>
          new Response('Asset requests must use the local asset server.', {
            status: 500,
          }),
      },
      outboundService: () => {
        serverFetches += 1;
        throw new Error('The backend must never crawl a website.');
      },
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
    '.zip': 'application/zip',
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
        if (request.method === 'PUT' && request.url.endsWith('/results'))
          resultUploads.push({
            body: JSON.parse(body.toString()),
            status: result.status,
          });
        const headers = Object.fromEntries(result.headers);
        const cookies = result.headers.getSetCookie();
        if (cookies.length) headers['set-cookie'] = cookies;
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
    } catch {
      response.writeHead(500);
      response.end('Local test server failed.');
    }
  });
  await listen(app, TEST_APP_PORT);
  await listen(fixtures, TEST_FIXTURE_PORT);
  const extension = await buildTestExtension();
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1600, height: 1000 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--no-proxy-server',
      `--host-resolver-rules=MAP *.vizlinx.com 127.0.0.1:${TEST_FIXTURE_PORT}`,
    ],
  });
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const unpaired = await context.newPage();
  await unpaired.goto(`chrome-extension://${EXTENSION_ID}/runner.html`);
  await expect(unpaired.locator('#status')).toContainText(
    'Otevřít skenovací kartu',
  );
  await expect(unpaired.locator('#map')).toHaveAttribute(
    'href',
    `${appOrigin}/scan`,
  );
  await expect(unpaired.locator('#start')).toBeDisabled();
  await unpaired.close();
  await page.goto(`${appOrigin}/scan`);
  await expect(page.getByRole('heading', { name: 'Nová mapa' })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Stáhni rozšíření' }),
  ).toHaveCount(0);
  await expect(page.locator('.scan-install')).toContainText(
    'build/extension-dev',
  );
  await expect(page.getByText('Rozšíření je připojené')).toBeVisible();
  await page.getByLabel('Weby k prozkoumání').fill(origins[0]);
  await page.getByLabel('Interval požadavků (sekundy)').fill('1');
  await page.getByLabel('Limit stránek na web').fill('5');
  await page.getByRole('button', { name: 'Připravit sken' }).click();
  await expect(
    page.getByRole('button', { name: 'Otevřít skenovací kartu' }),
  ).toBeVisible();
  const mapUrl = page.url();
  const id = new URL(mapUrl).searchParams.get('id');
  assert.match(id, /^[a-f0-9-]{36}$/);
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Otevřít skenovací kartu' }).click();
  const runner = await opened;
  await runner.waitForLoadState();
  await expect(runner.locator('#sites li')).toHaveCount(1);
  await expect(runner.locator('#map')).toHaveAttribute('href', mapUrl);
  const settings = await context.newPage();
  await settings.goto(`chrome://extensions/?id=${EXTENSION_ID}`);
  await settings.evaluate(
    ({ id, origin }) =>
      chrome.developerPrivate.addHostPermission(id, `${origin}/*`),
    { id: EXTENSION_ID, origin: origins[0] },
  );
  await runner.locator('#start').click();
  await expect(runner.locator('#status')).toContainText('Hotovo.', {
    timeout: 20_000,
  });
  await expect(page.locator('.scan-stats')).toContainText('1 načtených', {
    timeout: 10_000,
  });
  assert.equal(
    fetched.some((url) => url.startsWith('b.vizlinx.com')),
    false,
    'An external link stays known without fetching its host',
  );
  const original = await db
    .prepare(
      'SELECT result_json FROM page_results WHERE scan_id = ?1 AND source_url = ?2',
    )
    .bind(id, `${origins[0]}/`)
    .first();
  assert.equal(
    JSON.parse(original.result_json).links[0].targetUrl,
    `${origins[1]}/deep`,
  );
  await page.getByRole('button', { name: 'Přidat web', exact: true }).click();
  await page.getByLabel('Nový web', { exact: true }).fill(origins[1]);
  await page
    .getByRole('button', { name: 'Přidat do mapy', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Pokračovat v rozšíření', exact: true }),
  ).toBeVisible();
  const expandedOpened = context.waitForEvent('page');
  await page
    .getByRole('button', { name: 'Pokračovat v rozšíření', exact: true })
    .click();
  const expandedRunner = await expandedOpened;
  await expect(expandedRunner.locator('#sites li')).toHaveCount(2);
  assert.equal(
    fetched.some((url) => url.startsWith('b.vizlinx.com')),
    false,
    'Pairing an expanded scope must not start host requests',
  );
  await settings.evaluate(
    ({ id, origin }) =>
      chrome.developerPrivate.addHostPermission(id, `${origin}/*`),
    { id: EXTENSION_ID, origin: origins[1] },
  );
  // An old card must not silently adopt a newly paired scope, even when its host permission exists.
  await runner.locator('#start').click();
  await expect(runner.locator('#status')).toContainText(
    'Rozsah mapy se změnil',
  );
  assert.equal(
    fetched.some((url) => url.startsWith('b.vizlinx.com')),
    false,
    'An old card cannot start the added host without another explicit confirmation',
  );
  await expandedRunner.locator('#start').click();
  await expect(expandedRunner.locator('#status')).toContainText('Hotovo.', {
    timeout: 20_000,
  });
  await expect(page.locator('.scan-stats')).toContainText('3 načtených', {
    timeout: 10_000,
  });
  await expect(page.locator('[data-connection]')).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: 'Doména a.vizlinx.com', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Doména b.vizlinx.com', exact: true }),
  ).toBeVisible();
  assert.equal(
    fetched.includes('b.vizlinx.com/deep'),
    true,
    'An approved cross-origin deep link is crawled even when absent from the target root',
  );
  const persisted = await db
    .prepare('SELECT source_url FROM page_results WHERE scan_id = ?1')
    .bind(id)
    .all();
  assert.equal(persisted.results.length, 3);
  assert.deepEqual(
    await db
      .prepare(
        'SELECT result_json FROM page_results WHERE scan_id = ?1 AND source_url = ?2',
      )
      .bind(id, `${origins[0]}/`)
      .first(),
    original,
    'Adding a host preserves the existing page result',
  );
  assert.equal(
    fetched.filter((url) => url === 'a.vizlinx.com/').length,
    1,
    'The previously completed page is never recrawled',
  );
  await page.reload();
  await expect(page.locator('.scan-stats')).toContainText('3 načtených');
  await expect(page.locator('[data-connection]')).toHaveCount(2);
  await page
    .getByRole('button', { name: 'Zobrazit tabulku', exact: true })
    .click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.locator('tbody')).toContainText('a.vizlinx.com');
  await expect(page.locator('tbody')).toContainText('/deep');
  await page
    .getByRole('button', {
      name: 'Detail odkazu http://a.vizlinx.com/ → http://b.vizlinx.com/deep',
      exact: true,
    })
    .click();
  await expect(page.getByText('Partner', { exact: true })).toBeVisible();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({
    path: 'test-results/prototype-live.png',
    fullPage: true,
  });
  // Add a host while the old runner is still fetching. Its late outbox must survive
  // the revoked token, and the replacement session must wait for the old writer.
  await page.goto(`${appOrigin}/scan`);
  await page.getByLabel('Weby k prozkoumání').fill(`${origins[0]}/slow`);
  await page.getByLabel('Interval požadavků (sekundy)').fill('1');
  await page.getByLabel('Limit stránek na web').fill('5');
  await page.getByRole('button', { name: 'Připravit sken' }).click();
  await expect(
    page.getByRole('button', { name: 'Otevřít skenovací kartu', exact: true }),
  ).toBeVisible();
  const slowId = new URL(page.url()).searchParams.get('id');
  const slowOpened = context.waitForEvent('page');
  await page
    .getByRole('button', { name: 'Otevřít skenovací kartu', exact: true })
    .click();
  const slowRunner = await slowOpened;
  await slowRunner.locator('#start').click();
  await expect
    .poll(() => fetched.includes('a.vizlinx.com/slow'), { timeout: 10_000 })
    .toBe(true);
  const previousToken = await slowRunner.evaluate(
    async (id) =>
      (await chrome.storage.local.get(`scan:${id}`))[`scan:${id}`].token,
    slowId,
  );
  await page.getByRole('button', { name: 'Přidat web', exact: true }).click();
  await page.getByLabel('Nový web', { exact: true }).fill(origins[1]);
  await page
    .getByRole('button', { name: 'Přidat do mapy', exact: true })
    .click();
  const replacementOpened = context.waitForEvent('page', { timeout: 30_000 });
  await page
    .getByRole('button', { name: 'Pokračovat v rozšíření', exact: true })
    .click();
  await expect
    .poll(() =>
      slowRunner.evaluate(async () =>
        (await navigator.locks.query()).pending.some(
          (lock) => lock.name === 'vizlinx:runner',
        ),
      ),
    )
    .toBe(true);
  assert.equal(
    await slowRunner.evaluate(
      async (id) =>
        (await chrome.storage.local.get(`scan:${id}`))[`scan:${id}`].token,
      slowId,
    ),
    previousToken,
    'Pairing cannot overwrite the session while a runner holds the write lock',
  );
  releaseSlowPage();
  const replacementRunner = await replacementOpened;
  await expect(replacementRunner.locator('#sites li')).toHaveCount(2);
  await expect(slowRunner.locator('#status')).toContainText('Spojení vypršelo');
  const recovered = await replacementRunner.evaluate(
    async (id) => (await chrome.storage.local.get(`scan:${id}`))[`scan:${id}`],
    slowId,
  );
  assert.notEqual(recovered.token, previousToken);
  assert.equal(recovered.outbox.sourceUrl, `${origins[0]}/slow`);
  assert.equal(recovered.outbox.title, 'Slow alpha');
  assert.equal(recovered.queue.includes(`${origins[1]}/`), true);
  await replacementRunner.locator('#start').click();
  await expect(replacementRunner.locator('#status')).toContainText('Hotovo.', {
    timeout: 30_000,
  });
  await expect(page.locator('.scan-stats')).toContainText('5 načtených', {
    timeout: 10_000,
  });
  assert.equal(
    fetched.filter((url) => url === 'a.vizlinx.com/slow').length,
    1,
    'The interrupted page is uploaded from its outbox without being fetched again',
  );
  const recoveredRows = await db
    .prepare('SELECT source_url FROM page_results WHERE scan_id = ?1')
    .bind(slowId)
    .all();
  assert.equal(recoveredRows.results.length, 5);
  assert.equal(
    recoveredRows.results.some(
      (row) => row.source_url === `${origins[0]}/next`,
    ),
    true,
    'Links from the recovered outbox are added to the queue',
  );
  // Reopening a running scanner without changing its scope must also rotate the
  // token before waiting for the old runner, rather than timing out on its lock.
  await page.goto(`${appOrigin}/scan`);
  await page
    .getByLabel('Weby k prozkoumání')
    .fill(`${origins[0]}/slow-regular`);
  await page.getByLabel('Interval požadavků (sekundy)').fill('1');
  await page.getByRole('button', { name: 'Připravit sken' }).click();
  await expect(
    page.getByRole('button', { name: 'Otevřít skenovací kartu', exact: true }),
  ).toBeVisible();
  const regularId = new URL(page.url()).searchParams.get('id');
  const regularOpened = context.waitForEvent('page');
  await page
    .getByRole('button', { name: 'Otevřít skenovací kartu', exact: true })
    .click();
  const regularRunner = await regularOpened;
  await regularRunner.locator('#start').click();
  await expect
    .poll(() => fetched.includes('a.vizlinx.com/slow-regular'), {
      timeout: 10_000,
    })
    .toBe(true);
  const reopened = context.waitForEvent('page', { timeout: 30_000 });
  await page
    .getByRole('button', { name: 'Otevřít skenovací kartu', exact: true })
    .click();
  await expect
    .poll(() =>
      regularRunner.evaluate(async () =>
        (await navigator.locks.query()).pending.some(
          (lock) => lock.name === 'vizlinx:runner',
        ),
      ),
    )
    .toBe(true);
  releaseSlowPage();
  const resumedRunner = await reopened;
  await expect(regularRunner.locator('#status')).toContainText(
    'Spojení vypršelo',
  );
  await expect(resumedRunner.locator('#sites li')).toHaveCount(1);
  await resumedRunner.locator('#start').click();
  await expect(resumedRunner.locator('#status')).toContainText('Hotovo.', {
    timeout: 10_000,
  });
  assert.equal(
    fetched.filter((url) => url === 'a.vizlinx.com/slow-regular').length,
    1,
  );
  assert.equal(
    (
      await db
        .prepare(
          'SELECT COUNT(*) AS count FROM page_results WHERE scan_id = ?1',
        )
        .bind(regularId)
        .first()
    ).count,
    1,
  );
  // Lower a page limit while a real HTML fetch is in flight. The Worker must
  // refuse that result once; a reload must not retry until the UI raises the limit.
  await page.goto(`${appOrigin}/scan`);
  await page.getByLabel('Weby k prozkoumání').fill(`${origins[0]}/quota-root`);
  await page.getByLabel('Interval požadavků (sekundy)').fill('1');
  await page.getByLabel('Limit stránek na web').fill('2');
  await page.getByRole('button', { name: 'Připravit sken' }).click();
  await expect(
    page.getByRole('button', { name: 'Otevřít skenovací kartu', exact: true }),
  ).toBeVisible();
  const quotaId = new URL(page.url()).searchParams.get('id');
  const quotaOpened = context.waitForEvent('page');
  await page
    .getByRole('button', { name: 'Otevřít skenovací kartu', exact: true })
    .click();
  const quotaRunner = await quotaOpened;
  await quotaRunner.locator('#start').click();
  await expect
    .poll(() => fetched.includes('a.vizlinx.com/quota-slow'), {
      timeout: 10_000,
    })
    .toBe(true);
  await page
    .getByRole('button', { name: 'Doména a.vizlinx.com', exact: true })
    .click();
  await page.getByLabel('Limit stránek skenu', { exact: true }).fill('1');
  const lowered = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/v1/scans/${quotaId}`) &&
      response.request().method() === 'PATCH',
  );
  await page.getByLabel('Limit stránek skenu', { exact: true }).press('Enter');
  assert.equal((await lowered).status(), 200);
  releaseQuotaPage();
  await expect(quotaRunner.locator('#status')).toContainText(
    'Zvyšte limit webu',
  );
  const quotaUploads = () =>
    resultUploads.filter(
      (upload) => upload.body.sourceUrl === `${origins[0]}/quota-slow`,
    );
  assert.deepEqual(
    quotaUploads().map((upload) => upload.status),
    [429],
  );
  await quotaRunner.reload();
  const quotaControl = quotaRunner.waitForResponse((response) =>
    response.url().endsWith(`/api/v1/runner/scans/${quotaId}/control`),
  );
  await quotaRunner.locator('#start').click();
  assert.equal((await quotaControl).status(), 200);
  await expect(quotaRunner.locator('#status')).toContainText(
    'Zvyšte limit webu',
  );
  await expect(quotaRunner.locator('#start')).toBeEnabled();
  assert.equal(quotaUploads().length, 1);
  await expect(
    page.getByText(/Dosažen limit skenu\. V detailu webu/),
  ).toBeVisible();
  await page.getByLabel('Limit stránek skenu', { exact: true }).fill('2');
  const raised = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/v1/scans/${quotaId}`) &&
      response.request().method() === 'PATCH',
  );
  await page.getByLabel('Limit stránek skenu', { exact: true }).press('Enter');
  assert.equal((await raised).status(), 200);
  const quotaResumed = context.waitForEvent('page');
  await page
    .getByRole('button', { name: 'Pokračovat v rozšíření', exact: true })
    .click();
  const resumedQuotaRunner = await quotaResumed;
  await resumedQuotaRunner.locator('#start').click();
  await expect(resumedQuotaRunner.locator('#status')).toContainText('Hotovo.');
  await expect(page.locator('.scan-stats')).toContainText('2 načtených', {
    timeout: 10_000,
  });
  assert.deepEqual(
    quotaUploads().map((upload) => upload.status),
    [429, 200],
  );
  assert.deepEqual(quotaUploads()[0].body, quotaUploads()[1].body);
  assert.equal(
    fetched.filter((url) => url === 'a.vizlinx.com/quota-slow').length,
    1,
  );
  assert.deepEqual(errors, []);
  assert.equal(serverFetches, 0);
  console.log(
    'Prototype E2E passed: actual UI/Worker/D1/extension; add a host to a completed map; stale-card scope consent; in-flight token/outbox recovery; live graph/table and reload persistence; zero backend crawl requests.',
  );
} finally {
  await context?.close();
  await close(app);
  await close(fixtures);
  await mf?.dispose();
}
