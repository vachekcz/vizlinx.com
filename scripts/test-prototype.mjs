import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { chromium, expect } from '@playwright/test';
import { EXTENSION_ID } from '../shared/extension.ts';

const appOrigin = 'http://127.0.0.1:8797';
const origins = ['http://a.vizlinx.com', 'http://b.vizlinx.com'];
let serverFetches = 0;
let context;
let mf;
let app;
const fetched = [];
const fixtures = createServer((request, response) => {
  fetched.push(`${request.headers.host}${request.url}`);
  if (request.url === '/robots.txt') {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html' });
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
  await listen(app, 8797);
  await listen(fixtures, 8801);
  const extension = resolve('build/extension-dev');
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1600, height: 1000 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--no-proxy-server',
      '--host-resolver-rules=MAP *.vizlinx.com 127.0.0.1:8801',
    ],
  });
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${appOrigin}/scan`);
  await expect(page.getByRole('heading', { name: 'Nová mapa' })).toBeVisible();
  await expect(page.getByText('Rozšíření je připojené')).toBeVisible();
  await page.getByLabel('Weby k prozkoumání').fill(origins.join('\n'));
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
  await expect(runner.locator('#sites li')).toHaveCount(2);
  await expect(runner.locator('#map')).toHaveAttribute('href', mapUrl);
  const settings = await context.newPage();
  await settings.goto(`chrome://extensions/?id=${EXTENSION_ID}`);
  for (const origin of origins)
    await settings.evaluate(
      ({ id, origin }) =>
        chrome.developerPrivate.addHostPermission(id, `${origin}/*`),
      { id: EXTENSION_ID, origin },
    );
  await runner.locator('#start').click();
  await expect(runner.locator('#status')).toContainText('Hotovo.', {
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
  assert.deepEqual(errors, []);
  assert.equal(serverFetches, 0);
  console.log(
    'Prototype E2E passed: actual /scan UI → Worker/D1 → extension pairing/permissions → local fixture crawl → live graph/table → reload persistence; zero backend crawl requests.',
  );
} finally {
  await context?.close();
  await close(app);
  await close(fixtures);
  await mf?.dispose();
}
