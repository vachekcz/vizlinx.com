import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { EXTENSION_ID } from '../shared/extension.ts';
import {
  buildTestExtension,
  TEST_APP_ORIGIN,
  TEST_APP_PORT,
  TEST_FIXTURE_PORT,
} from './build-test-extension.mjs';

const origins = [
  'http://a.vizlinx.com',
  'http://b.vizlinx.com',
  'http://c.vizlinx.com',
];
const requests = [];
const uploads = [];
const results = new Map();
const createdAt = new Date().toISOString();
const scan = {
  id: 'fixture-scan',
  status: 'waiting',
  createdAt,
  updatedAt: createdAt,
  pageCount: 0,
  sites: origins.map((origin) => ({
    origin,
    seedUrl: `${origin}/`,
    intervalMs: 1000,
    maxPages: 50,
    paused: false,
  })),
};
let dropAcknowledgement = true;
const ticket = 'controlled-fixture-pairing-ticket';
let token = 'controlled-fixture-runner-token';
let exchangeCount = 0;
let holdNextExchange = false;
let releaseExchange;
let robotsDirective;
let uploadLimitCode;
let controlRequests = 0;

function json(response, body, code = 200) {
  response.writeHead(code, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

const fixture = createServer((request, response) => {
  const host = request.headers.host;
  const path = request.url;
  requests.push({ host, path, cookie: request.headers.cookie, at: Date.now() });
  if (path === '/robots.txt') {
    response.writeHead(
      host === 'c.vizlinx.com' ? 503 : host === 'b.vizlinx.com' ? 404 : 200,
      { 'Content-Type': 'text/plain' },
    );
    response.end(
      robotsDirective === undefined
        ? 'User-agent: VizlinxBot\nAllow: /private\n\nUser-agent: *\nDisallow: /private\nCrawl-delay: 1\n'
        : `User-agent: *\nCrawl-delay: ${robotsDirective}\n`,
    );
    return;
  }
  if (host !== 'a.vizlinx.com') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<title>Beta</title><main>Public page</main>');
    return;
  }
  if (path === '/redirect') {
    response.writeHead(302, { Location: 'http://outside.vizlinx.com/leak' });
    response.end();
    return;
  }
  if (path === '/429') {
    response.writeHead(429, { 'Retry-After': '60' });
    response.end('Rate limited');
    return;
  }
  if (path === '/throttled-seed') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      '<a href="/429">Busy</a><a href="/after-throttle">Do not fetch</a>',
    );
    return;
  }
  if (path === '/error') {
    response.writeHead(503);
    response.end('Unavailable');
    return;
  }
  if (path === '/robots-case' || path === '/upload-limit') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<title>Single page</title>');
    return;
  }
  if (path === '/pdf') {
    response.writeHead(200, { 'Content-Type': 'application/pdf' });
    response.end('%PDF');
    return;
  }
  if (path === '/large') {
    response.writeHead(200, {
      'Content-Type': 'text/html',
      'Content-Length': 3_000_000,
    });
    response.end('Too large');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (path === '/many') {
    response.end(
      Array.from(
        { length: 501 },
        (_, index) =>
          `<a href="http://outside.vizlinx.com/${index}">Link ${index}</a>`,
      ).join(''),
    );
    return;
  }
  if (path === '/') {
    response.end(`<title>Alpha &amp; Friends</title><base href="/base/"><script src="/script-leak"></script><img src="/image-leak"><main>
      <a href="../ok#section" rel="nofollow">Hello &amp; world</a><a href="/ok" rel="nofollow">Hello &amp; world</a>
      <a href="/private">Private</a><a href="/redirect">Redirect</a><a href="/error">Error</a><a href="/pdf">PDF</a><a href="/large">Large</a><a href="/many">Many</a>
      <a href="http://b.vizlinx.com/page">Beta page</a><a href="http://outside.vizlinx.com/known">Outside</a>
      <a href="http://127.0.0.1/secret">Local link only</a><a href="javascript:alert(1)">Script URL</a>
      <a href="http://a.vizlinx.com:8901/nonstandard-port">Same host on another port</a>
    </main>`);
    return;
  }
  response.end('<title>OK</title><nav><a href="/">Back</a></nav>');
});

// This fixture server exercises the extension transport. D1/auth contracts have their own API suite.
const api = createServer(async (request, response) => {
  if (!request.url.startsWith('/api/')) {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<title>Pairing fixture</title>');
    return;
  }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  if (request.url === '/api/v1/runner/exchange') {
    assert.ok(
      body.ticket === ticket ||
        /^concurrent-fixture-ticket-[ab]$/.test(body.ticket),
    );
    assert.equal(request.headers.cookie, undefined);
    exchangeCount += 1;
    token = `controlled-fixture-token-${exchangeCount}`;
    const issuedToken = token;
    if (holdNextExchange) {
      holdNextExchange = false;
      await new Promise((done) => {
        releaseExchange = done;
      });
    }
    json(response, {
      token: issuedToken,
      scan: { ...scan, results: [...results.values()] },
    });
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    json(response, { error: 'Runner token expired.' }, 401);
    return;
  }
  if (request.url.endsWith('/control')) {
    controlRequests += 1;
    json(response, scan);
    return;
  }
  if (request.url.endsWith('/progress')) {
    if (scan.status !== 'paused' || body.status !== 'running')
      scan.status = body.status;
    json(response, { ok: true });
    return;
  }
  if (request.url.endsWith('/results')) {
    uploads.push(body);
    if (uploadLimitCode) {
      if (uploadLimitCode !== 'transient') scan.status = 'limited';
      json(
        response,
        {
          error: 'Result quota exceeded.',
          ...(uploadLimitCode === 'transient' ? {} : { code: uploadLimitCode }),
          ...(uploadLimitCode === 'page_limit'
            ? {
                maxPages: scan.sites.find(
                  (site) => site.origin === new URL(body.sourceUrl).origin,
                ).maxPages,
              }
            : {}),
        },
        429,
      );
      return;
    }
    const previous = results.get(body.sourceUrl);
    if (previous)
      assert.deepEqual(
        body,
        previous,
        'Outbox retry must deliver the identical result',
      );
    results.set(body.sourceUrl, body);
    if (body.sourceUrl === `${origins[0]}/ok` && dropAcknowledgement) {
      dropAcknowledgement = false;
      json(
        response,
        { error: 'Acknowledgement unavailable after persistence' },
        503,
      );
      return;
    }
    json(response, { ok: true });
    return;
  }
  json(response, { ...scan, results: [...results.values()] });
});

const listen = (server, port) =>
  new Promise((done, reject) =>
    server.once('error', reject).listen(port, '127.0.0.1', done),
  );
const close = (server) =>
  new Promise((done) => {
    server.closeAllConnections();
    server.close(done);
  });
let context;
try {
  await listen(fixture, TEST_FIXTURE_PORT);
  await listen(api, TEST_APP_PORT);
  const extension = await buildTestExtension();
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--no-proxy-server',
      `--host-resolver-rules=MAP *.vizlinx.com 127.0.0.1:${TEST_FIXTURE_PORT}`,
    ],
  });
  context.setDefaultTimeout(15_000);
  await context.addCookies([
    {
      name: 'private_session',
      value: 'must-not-leak',
      domain: 'a.vizlinx.com',
      path: '/',
    },
  ]);
  const web = await context.newPage();
  await web.goto(TEST_APP_ORIGIN);
  const send = (message) =>
    web.evaluate(({ id, message }) => chrome.runtime.sendMessage(id, message), {
      id: EXTENSION_ID,
      message,
    });
  assert.deepEqual(await send({ type: 'vizlinx:ping' }), {
    ok: true,
    protocolVersion: 2,
  });
  const originalSites = scan.sites;
  for (const seedUrl of [
    'http://127.0.0.1/secret',
    'http://localhost/secret',
    'https://a.vizlinx.com:8443/secret',
    'https://name:password@a.vizlinx.com/',
    'file:///private/secret',
  ]) {
    scan.sites = [
      { ...originalSites[0], origin: new URL(seedUrl).origin, seedUrl },
    ];
    const tabsBefore = context.pages().length;
    assert.equal(
      (await send({ type: 'vizlinx:pair', ticket })).ok,
      false,
      `Valid pairing must reject unsafe scope ${seedUrl}`,
    );
    assert.equal(
      context.pages().length,
      tabsBefore,
      'An invalid scope must never open a runner',
    );
  }
  assert.equal(
    requests.length,
    0,
    'Rejected scopes must not issue local crawl requests',
  );
  scan.sites = originalSites;
  const runnerOpened = context.waitForEvent('page');
  assert.deepEqual(await send({ type: 'vizlinx:pair', ticket }), { ok: true });
  let runner = await runnerOpened;
  await runner.waitForLoadState();
  await expect(runner.locator('#sites li')).toHaveCount(3);
  assert.equal(new URL(runner.url()).protocol, 'chrome-extension:');
  const extensionSettings = await context.newPage();
  await extensionSettings.goto(`chrome://extensions/?id=${EXTENSION_ID}`);
  for (const origin of origins) {
    // Use Chromium's real permission management, equivalent to confirming these hosts in its UI.
    // The runner still calls the real chrome.permissions.request from its button gesture.
    await extensionSettings.evaluate(
      ({ id, origin }) =>
        chrome.developerPrivate.addHostPermission(id, `${origin}/*`),
      { id: EXTENSION_ID, origin },
    );
  }
  await runner.locator('#start').click();
  await expect(runner.locator('#pause')).toBeEnabled();
  const duplicate = await context.newPage();
  await duplicate.goto(runner.url());
  await duplicate.locator('#start').click();
  await expect(duplicate.locator('#status')).toContainText(
    'už běží v jiné kartě',
  );
  await duplicate.close();
  await expect
    .poll(() => uploads.some((result) => result.sourceUrl.endsWith('/ok')), {
      timeout: 20_000,
    })
    .toBe(true);
  await expect(runner.locator('#start')).toBeEnabled();
  const saved = await runner.evaluate(
    async () =>
      (await chrome.storage.local.get('scan:fixture-scan'))[
        'scan:fixture-scan'
      ],
  );
  assert.equal(saved.outbox.sourceUrl, `${origins[0]}/ok`);
  const runnerUrl = runner.url();
  await runner.close();
  runner = await context.newPage();
  await runner.goto(runnerUrl);
  await runner.locator('#start').click();
  await expect(runner.locator('#status')).toContainText('Hotovo.', {
    timeout: 30_000,
  });
  assert.equal(
    uploads.filter((result) => result.sourceUrl.endsWith('/ok')).length,
    2,
  );
  assert.equal(results.size, 11);
  const root = results.get(`${origins[0]}/`);
  assert.equal(root.title, 'Alpha & Friends');
  const duplicatedLink = root.links.find(
    (link) => link.targetUrl === `${origins[0]}/ok`,
  );
  assert.deepEqual(duplicatedLink, {
    targetUrl: `${origins[0]}/ok`,
    anchor: 'Hello & world',
    rel: ['nofollow'],
    region: 'content',
    occurrences: 2,
  });
  assert.equal(
    root.links.some(
      (link) => link.targetUrl === 'http://outside.vizlinx.com/known',
    ),
    true,
  );
  assert.equal(
    root.links.some((link) => link.targetUrl.startsWith('javascript:')),
    false,
  );
  assert.equal(results.get(`${origins[0]}/private`).status, 'robots_denied');
  assert.equal(results.get(`${origins[2]}/`).status, 'robots_denied');
  assert.equal(
    results.get(`${origins[0]}/redirect`).status,
    'redirect_unresolved',
  );
  assert.equal(results.get(`${origins[0]}/error`).httpStatus, 503);
  assert.equal(results.get(`${origins[0]}/error`).status, 'http_error');
  assert.equal(results.get(`${origins[0]}/pdf`).status, 'not_html');
  assert.equal(results.get(`${origins[0]}/large`).status, 'too_large');
  assert.equal(results.get(`${origins[0]}/many`).truncated, true);
  assert.equal(results.get(`${origins[0]}/many`).links.length, 500);
  assert.equal(
    requests.some((request) => request.cookie),
    false,
    'No crawl request may carry cookies',
  );
  assert.equal(
    requests.some(
      (request) =>
        request.host === 'outside.vizlinx.com' ||
        [
          '/private',
          '/script-leak',
          '/image-leak',
          '/secret',
          '/leak',
          '/nonstandard-port',
        ].includes(request.path),
    ),
    false,
    'No external redirect, denied page or subresource may be fetched',
  );
  for (const host of ['a.vizlinx.com', 'b.vizlinx.com', 'c.vizlinx.com']) {
    const calls = requests.filter((request) => request.host === host);
    for (let index = 1; index < calls.length; index += 1)
      assert.ok(
        calls[index].at - calls[index - 1].at >= 950,
        `Rate limit respected for ${host}: ${calls[index - 1].path} -> ${calls[index].path}, ${calls[index].at - calls[index - 1].at} ms`,
      );
  }
  assert.equal(
    (await runner.evaluate(() => chrome.permissions.getAll())).origins.includes(
      'http://outside.vizlinx.com/*',
    ),
    false,
  );
  const untrusted = await context.newPage();
  await untrusted.goto(`http://127.0.0.1:${TEST_FIXTURE_PORT}`);
  assert.equal(
    (
      await untrusted.evaluate(
        (id) => chrome.runtime.sendMessage(id, { type: 'vizlinx:ping' }),
        EXTENSION_ID,
      )
    ).ok,
    false,
    'A different development port must not be trusted',
  );
  await untrusted.close();
  scan.id = 'fixture-limited';
  scan.status = 'waiting';
  scan.sites = [{ ...scan.sites[0], maxPages: 2 }];
  results.clear();
  uploads.length = 0;
  const limitedOpened = context.waitForEvent('page');
  assert.deepEqual(await send({ type: 'vizlinx:pair', ticket }), { ok: true });
  const limited = await limitedOpened;
  await limited.locator('#start').click();
  await expect
    .poll(() => results.has(`${origins[0]}/`), { timeout: 10_000 })
    .toBe(true);
  await limited.locator('#pause').click();
  await expect(limited.locator('#status')).toContainText('Pozastaveno.');
  const countAtPause = requests.length;
  await new Promise((done) => setTimeout(done, 1200));
  assert.equal(
    requests.length,
    countAtPause,
    'Pause must prevent further local requests',
  );
  assert.equal(scan.status, 'paused');
  // The user resumes from the owning website; runner heartbeats cannot override a web pause.
  scan.status = 'waiting';
  await limited.locator('#start').click();
  await expect(limited.locator('#status')).toContainText(
    'Dosažen limit stránek.',
    { timeout: 10_000 },
  );
  assert.equal(results.size, 2);
  assert.equal(scan.status, 'limited');
  scan.id = 'fixture-throttled';
  scan.status = 'waiting';
  scan.sites = [
    { ...scan.sites[0], seedUrl: `${origins[0]}/throttled-seed`, maxPages: 5 },
  ];
  results.clear();
  const throttledOpened = context.waitForEvent('page');
  assert.deepEqual(await send({ type: 'vizlinx:pair', ticket }), { ok: true });
  const throttled = await throttledOpened;
  await throttled.locator('#start').click();
  await expect(throttled.locator('#status')).toContainText(
    'Server omezil požadavky (HTTP 429)',
    { timeout: 10_000 },
  );
  assert.equal(scan.status, 'paused');
  assert.equal(results.size, 2);
  assert.equal(
    requests.some((request) => request.path === '/after-throttle'),
    false,
    'HTTP 429 stops the affected origin instead of consuming its next URLs',
  );
  const pairFixture = async () => {
    const opened = context.waitForEvent('page');
    assert.deepEqual(await send({ type: 'vizlinx:pair', ticket }), {
      ok: true,
    });
    const card = await opened;
    await expect(card.locator('#sites li')).toHaveCount(scan.sites.length);
    return card;
  };
  for (const directive of ['NaN', 'Infinity', '1e306']) {
    scan.id = `fixture-robots-${directive}`;
    scan.status = 'waiting';
    scan.sites = [
      { ...scan.sites[0], seedUrl: `${origins[0]}/robots-case`, maxPages: 1 },
    ];
    results.clear();
    robotsDirective = directive;
    const before = requests.length;
    const card = await pairFixture();
    await card.locator('#start').click();
    await expect(card.locator('#status')).toContainText('Hotovo.', {
      timeout: 10_000,
    });
    assert.equal(results.get(`${origins[0]}/robots-case`).status, 'ok');
    const calls = requests.slice(before);
    assert.equal(calls.length, 2);
    assert.ok(
      calls[1].at - calls[0].at >= 950,
      `Invalid Crawl-delay ${directive} must retain the normal minimum interval`,
    );
  }
  scan.id = 'fixture-robots-long';
  scan.status = 'waiting';
  results.clear();
  robotsDirective = '120';
  const longBefore = requests.length;
  const longDelay = await pairFixture();
  await longDelay.locator('#start').click();
  await expect
    .poll(() =>
      requests
        .slice(longBefore)
        .some((request) => request.path === '/robots.txt'),
    )
    .toBe(true);
  await new Promise((done) => setTimeout(done, 1200));
  assert.equal(
    requests.length - longBefore,
    1,
    'A valid 120-second crawl delay must not be capped to the manual interval limit',
  );
  assert.equal(
    results.size,
    0,
    'A valid long crawl delay must not be treated as a denied page',
  );
  await longDelay.locator('#pause').click();
  await expect(longDelay.locator('#status')).toContainText('Pozastaveno.');
  robotsDirective = undefined;

  scan.id = 'fixture-upload-transient';
  scan.status = 'waiting';
  scan.sites = [
    { ...scan.sites[0], seedUrl: `${origins[0]}/upload-limit`, maxPages: 1 },
  ];
  results.clear();
  uploads.length = 0;
  uploadLimitCode = 'transient';
  const transient = await pairFixture();
  await transient.locator('#start').click();
  await expect(transient.locator('#status')).toContainText('HTTP 429');
  assert.equal(
    (
      await transient.evaluate(
        async () =>
          (await chrome.storage.local.get('scan:fixture-upload-transient'))[
            'scan:fixture-upload-transient'
          ],
      )
    ).outboxLimit,
    undefined,
    'An unclassified 429 must not persist a quota',
  );
  uploadLimitCode = undefined;
  await transient.locator('#start').click();
  await expect(transient.locator('#status')).toContainText('Hotovo.');
  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads[0], uploads[1]);

  scan.id = 'fixture-upload-page-limit';
  scan.status = 'waiting';
  scan.sites = [
    { ...scan.sites[0], seedUrl: `${origins[0]}/upload-limit`, maxPages: 1 },
  ];
  results.clear();
  uploads.length = 0;
  uploadLimitCode = 'page_limit';
  const uploadFetchesBefore = requests.filter(
    (request) => request.path === '/upload-limit',
  ).length;
  let quota = await pairFixture();
  await quota.locator('#start').click();
  await expect(quota.locator('#status')).toContainText('Zvyšte limit webu');
  assert.equal(scan.status, 'limited');
  assert.equal(uploads.length, 1);
  await quota.reload();
  let controlsBefore = controlRequests;
  await quota.locator('#start').click();
  await expect.poll(() => controlRequests).toBeGreaterThan(controlsBefore);
  await expect(quota.locator('#status')).toContainText('Zvyšte limit webu');
  await expect(quota.locator('#start')).toBeEnabled();
  assert.equal(
    uploads.length,
    1,
    'Reopening without increasing the limit must not repeat the refused PUT',
  );
  assert.equal(
    scan.status,
    'limited',
    'A blocked retry must not reset the backend status to running',
  );
  quota = await pairFixture();
  controlsBefore = controlRequests;
  await quota.locator('#start').click();
  await expect.poll(() => controlRequests).toBeGreaterThan(controlsBefore);
  await expect(quota.locator('#status')).toContainText('Zvyšte limit webu');
  await expect(quota.locator('#start')).toBeEnabled();
  assert.equal(
    uploads.length,
    1,
    'Pairing must preserve the refused outbox quota',
  );
  scan.sites[0].maxPages = 2;
  scan.status = 'waiting';
  uploadLimitCode = undefined;
  await quota.locator('#start').click();
  await expect(quota.locator('#status')).toContainText('Hotovo.');
  assert.equal(uploads.length, 2);
  assert.deepEqual(
    uploads[1],
    uploads[0],
    'A higher limit retries the identical saved result',
  );
  assert.equal(
    requests.filter((request) => request.path === '/upload-limit').length -
      uploadFetchesBefore,
    1,
    'Quota recovery must not recrawl the page',
  );

  scan.id = 'fixture-upload-page-ceiling';
  scan.status = 'waiting';
  scan.sites[0].maxPages = 100;
  results.clear();
  uploads.length = 0;
  uploadLimitCode = 'page_limit';
  const ceilingQuota = await pairFixture();
  await ceilingQuota.locator('#start').click();
  await expect(ceilingQuota.locator('#status')).toContainText(
    'pro další sken založte novou mapu',
  );
  await expect(ceilingQuota.locator('#status')).not.toContainText('Zvyšte');
  await ceilingQuota.reload();
  await expect(ceilingQuota.locator('#status')).toContainText(
    'maximální limit 100 stránek',
  );
  assert.equal(uploads.length, 1);

  scan.id = 'fixture-upload-storage-limit';
  scan.status = 'waiting';
  results.clear();
  uploads.length = 0;
  uploadLimitCode = 'scan_storage_limit';
  const storageQuota = await pairFixture();
  await storageQuota.locator('#start').click();
  await expect(storageQuota.locator('#status')).toContainText(
    'Kapacita této mapy je vyčerpaná',
  );
  await expect(storageQuota.locator('#start')).toBeDisabled();
  await storageQuota.reload();
  await expect(storageQuota.locator('#start')).toBeDisabled();
  await expect(storageQuota.locator('#status')).toContainText(
    'Kapacita této mapy je vyčerpaná',
  );
  const pairedStorageQuota = await pairFixture();
  await expect(pairedStorageQuota.locator('#start')).toBeDisabled();
  assert.equal(
    uploads.length,
    1,
    'A permanent storage quota must survive reload and pairing without another PUT',
  );
  uploadLimitCode = undefined;

  scan.id = 'fixture-concurrent-pairing';
  scan.status = 'waiting';
  scan.sites = [{ ...scan.sites[0], seedUrl: `${origins[0]}/robots-case` }];
  results.clear();
  const otherWeb = await context.newPage();
  await otherWeb.goto(TEST_APP_ORIGIN);
  const exchangeBefore = exchangeCount;
  holdNextExchange = true;
  const concurrentOpened = context.waitForEvent('page');
  const firstPairing = send({
    type: 'vizlinx:pair',
    ticket: 'concurrent-fixture-ticket-a',
  });
  await expect.poll(() => typeof releaseExchange).toBe('function');
  const secondPairing = await otherWeb.evaluate(
    (id) =>
      chrome.runtime.sendMessage(id, {
        type: 'vizlinx:pair',
        ticket: 'concurrent-fixture-ticket-b',
      }),
    EXTENSION_ID,
  );
  assert.equal(secondPairing.ok, false);
  assert.match(secondPairing.error, /připojení rozšíření právě probíhá/);
  assert.equal(
    exchangeCount,
    exchangeBefore + 1,
    'A concurrent pairing must not rotate the token while the first session is pending',
  );
  releaseExchange();
  assert.deepEqual(await firstPairing, { ok: true });
  const concurrentRunner = await concurrentOpened;
  await concurrentRunner.locator('#start').click();
  await expect(concurrentRunner.locator('#status')).toContainText('Hotovo.', {
    timeout: 10_000,
  });
  assert.equal(
    results.size,
    1,
    'The final stored token must remain valid for uploads',
  );
  const prod = JSON.parse(
    await readFile('build/extension/manifest.json', 'utf8'),
  );
  assert.equal(
    prod.host_permissions.some((origin) =>
      /localhost|127\.0\.0\.1/.test(origin),
    ),
    false,
  );
  assert.deepEqual(prod.externally_connectable.matches, [
    'https://vizlinx.com/*',
    'https://www.vizlinx.com/*',
  ]);
  console.log(
    'Extension PoC passed: actual Chromium permissions, local cross-origin fetch without CORS/cookies, parsing, robots/HTTP/limits, scope, idempotent outbox recovery, and one-runner lock.',
  );
} finally {
  await context?.close();
  await close(api);
  await close(fixture);
}
