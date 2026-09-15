import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

let boundedText;
let BodyTooLarge;
let emptyResult;
let fitResult;
let fetchServerRobots;
let fetchServerPage;
let SCAN_LIMITS;

before(async () => {
  const output = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `export * from './shared/fetch-result.ts';
        export { fetchServerRobots, fetchServerPage } from './worker/server-fetch.ts';
        export { SCAN_LIMITS } from './shared/scan.ts';`,
    },
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'browser',
    target: 'es2023',
  });
  ({
    boundedText,
    BodyTooLarge,
    emptyResult,
    fitResult,
    fetchServerRobots,
    fetchServerPage,
    SCAN_LIMITS,
  } = await import(
    `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`
  ));
});

test('redirect metadata resolves paths and public site variants without fetching the target', async (t) => {
  const cases = [
    ['../final?q=1#section', 'same_origin', 'https://example.com/final?q=1'],
    ['https://example.com/next', 'same_origin', 'https://example.com/next'],
    ['//other.org/landing', 'external', 'https://other.org/landing'],
    [
      'https://sub.example.com/landing',
      'external',
      'https://sub.example.com/landing',
    ],
    [
      'http://example.com/landing',
      'site_variant',
      'http://example.com/landing',
    ],
    [
      'https://www.example.com/landing',
      'site_variant',
      'https://www.example.com/landing',
    ],
    [
      'http://www.example.com/landing',
      'site_variant',
      'http://www.example.com/landing',
    ],
    [
      'https://www.www.example.com/landing',
      'external',
      'https://www.www.example.com/landing',
    ],
    [
      'https://example.com:8443/landing',
      'invalid',
      'https://example.com:8443/landing',
    ],
    ['http://127.0.0.1/private', 'invalid', 'http://127.0.0.1/private'],
    ['http://[::1]/private', 'invalid', 'http://[::1]/private'],
    ['http://service.internal/', 'invalid', 'http://service.internal/'],
    ['http://localhost/', 'invalid', 'http://localhost/'],
    ['javascript:alert(1)', 'invalid', undefined],
    ['https://user:secret@other.org/', 'invalid', undefined],
    ['', 'invalid', undefined],
    [null, 'invalid', undefined],
  ];
  for (const [location, kind, targetUrl] of cases) {
    let calls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async (_url, options) => {
      calls++;
      assert.equal(options.redirect, 'manual');
      return new Response('', {
        status: 302,
        headers: location === null ? {} : { Location: location },
      });
    });
    const result = await fetchServerPage(
      'https://example.com/start/page',
      'https://example.com',
    );
    assert.equal(calls, 1);
    assert.equal(result.status, 'redirect_unresolved');
    assert.equal(result.httpStatus, 302);
    assert.equal(result.redirect.kind, kind);
    assert.equal(result.redirect.targetUrl, targetUrl);
    if (kind === 'invalid')
      assert.equal(result.redirect.reason, 'invalid_target');
    if (kind === 'same_origin' || kind === 'site_variant')
      assert.equal(result.error, undefined);
    assert.deepEqual(result.links, []);
    assert.deepEqual(result.discoveredUrls, []);
    mock.mock.restore();
  }
});

test('all supported redirect statuses allow HTTPS upgrades and removal of www', async (t) => {
  for (const status of [301, 302, 303, 307, 308]) {
    const calls = [];
    const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, 'manual');
      return new Response('', {
        status,
        headers: { Location: 'https://example.com/final' },
      });
    });
    const result = await fetchServerPage(
      'http://www.example.com/',
      'http://www.example.com',
    );
    assert.deepEqual(calls, ['http://www.example.com/']);
    assert.equal(result.httpStatus, status);
    assert.deepEqual(result.redirect, {
      kind: 'site_variant',
      targetUrl: 'https://example.com/final',
    });
    assert.equal(result.error, undefined);
    mock.mock.restore();
  }
});

test('unsupported redirect statuses preserve the target with an accurate reason', async (t) => {
  for (const status of [300, 304, 305]) {
    const mock = t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(null, {
          status,
          headers: { Location: '/landing' },
        }),
    );
    const result = await fetchServerPage(
      'https://example.com/',
      'https://example.com',
    );
    assert.deepEqual(result.redirect, {
      kind: 'invalid',
      reason: 'unsupported_status',
      targetUrl: 'https://example.com/landing',
    });
    assert.equal(
      result.error,
      `Unsupported redirect status HTTP ${status} was not followed.`,
    );
    mock.mock.restore();
  }
});

test('robots exposes each redirect status and target without following it', async (t) => {
  for (const status of [301, 302, 303, 307, 308]) {
    const calls = [];
    const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, 'manual');
      return new Response('', {
        status,
        headers: { Location: 'https://www.example.com/policy/robots.txt' },
      });
    });
    assert.deepEqual(await fetchServerRobots('http://example.com'), {
      body: '',
      denied: true,
      delayMs: 0,
      httpStatus: status,
      redirect: {
        kind: 'site_variant',
        targetUrl: 'https://www.example.com/policy/robots.txt',
      },
    });
    assert.deepEqual(calls, ['http://example.com/robots.txt']);
    mock.mock.restore();
  }
});

test('robots resolves cursor-relative redirects within the original site scope', async (t) => {
  const cases = [
    ['../rules.txt', 'same_origin', 'https://www.example.com/rules.txt'],
    [
      'http://example.com/rules.txt',
      'site_variant',
      'http://example.com/rules.txt',
    ],
    [
      'https://other.org/robots.txt',
      'external',
      'https://other.org/robots.txt',
    ],
    [
      'https://www.www.example.com/robots.txt',
      'external',
      'https://www.www.example.com/robots.txt',
    ],
    [
      'https://sub.example.com/robots.txt',
      'external',
      'https://sub.example.com/robots.txt',
    ],
    ['http://127.0.0.1/robots.txt', 'invalid', 'http://127.0.0.1/robots.txt'],
    [
      'https://example.com:8443/robots.txt',
      'invalid',
      'https://example.com:8443/robots.txt',
    ],
    [
      'https://service.local/robots.txt',
      'invalid',
      'https://service.local/robots.txt',
    ],
    ['https://user:secret@example.com/robots.txt', 'invalid', undefined],
    ['javascript:void(0)', 'invalid', undefined],
    ['', 'invalid', undefined],
  ];
  for (const [location, kind, targetUrl] of cases) {
    const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, 'https://www.example.com/policy/robots.txt');
      assert.equal(options.redirect, 'manual');
      return new Response('', { status: 302, headers: { Location: location } });
    });
    const policy = await fetchServerRobots(
      'http://example.com',
      'https://www.example.com/policy/robots.txt',
    );
    assert.equal(mock.mock.callCount(), 1);
    assert.equal(policy.denied, true);
    assert.equal(policy.httpStatus, 302);
    assert.equal(policy.redirect.kind, kind);
    assert.equal(policy.redirect.targetUrl, targetUrl);
    if (kind === 'invalid')
      assert.equal(policy.redirect.reason, 'invalid_target');
    mock.mock.restore();
  }
});

test('robots rejects unsupported redirect statuses and unsafe or unrelated cursors', async (t) => {
  const mock = t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(null, { status: 304, headers: { Location: '/policy.txt' } }),
  );
  const policy = await fetchServerRobots('https://example.com');
  assert.equal(policy.httpStatus, 304);
  assert.deepEqual(policy.redirect, {
    kind: 'invalid',
    reason: 'unsupported_status',
    targetUrl: 'https://example.com/policy.txt',
  });
  for (const cursor of [
    'https://other.org/robots.txt',
    'https://www.www.example.com/robots.txt',
    'https://example.com:8443/robots.txt',
    'http://127.0.0.1/robots.txt',
    'http://[::1]/robots.txt',
    'http://service.internal/robots.txt',
    'https://user:secret@example.com/robots.txt',
  ]) {
    assert.deepEqual(await fetchServerRobots('https://example.com', cursor), {
      body: '',
      denied: true,
      delayMs: 0,
    });
  }
  assert.equal(mock.mock.callCount(), 1);
});

test('robots reads a redirected policy once and retains status and crawl delay', async (t) => {
  const body = 'User-agent: *\nDisallow: /private\nCrawl-delay: 7';
  const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://www.example.com/policy.txt');
    assert.equal(options.redirect, 'manual');
    return new Response(body);
  });
  assert.deepEqual(
    await fetchServerRobots(
      'http://example.com',
      'https://www.example.com/policy.txt',
    ),
    {
      body,
      denied: false,
      delayMs: 7000,
      httpStatus: 200,
    },
  );
  assert.equal(mock.mock.callCount(), 1);
});

test('robots preserves non-redirect HTTP status and fails closed except for absent files', async (t) => {
  for (const status of [404, 410, 401, 403, 429, 500]) {
    const mock = t.mock.method(
      globalThis,
      'fetch',
      async () => new Response('', { status }),
    );
    assert.deepEqual(await fetchServerRobots('https://example.com'), {
      body: '',
      denied: ![404, 410].includes(status),
      delayMs: 0,
      httpStatus: status,
    });
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
});

test('HTTPS failures never fall back to HTTP for pages or robots', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    throw new Error('TLS connection failed');
  });
  const page = await fetchServerPage(
    'https://example.com/',
    'https://example.com',
  );
  assert.equal(page.status, 'network_error');
  assert.equal(page.redirect, undefined);
  assert.deepEqual(await fetchServerRobots('https://example.com'), {
    body: '',
    denied: true,
    delayMs: 0,
  });
  assert.deepEqual(calls, [
    'https://example.com/',
    'https://example.com/robots.txt',
  ]);
});

function streamedResponse(chunks, headers = {}) {
  const state = { reads: 0, cancelled: false };
  const response = new Response(
    new ReadableStream(
      {
        pull(controller) {
          const chunk = chunks[state.reads++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    { headers },
  );
  return { response, state };
}

test('robots rejects an oversized Content-Length before reading the stream', async (t) => {
  const { response, state } = streamedResponse([new Uint8Array(1024)], {
    'Content-Length': String(64 * 1024 + 1),
  });
  t.mock.method(globalThis, 'fetch', async () => response);
  assert.deepEqual(await fetchServerRobots('https://example.com'), {
    body: '',
    denied: true,
    delayMs: 0,
    httpStatus: 200,
  });
  assert.equal(state.reads, 0);
  assert.equal(state.cancelled, true);
});

for (const headers of [{}, { 'Content-Length': '1' }]) {
  test(`robots stops and cancels at 64 KiB with ${JSON.stringify(headers)} headers`, async (t) => {
    const { response, state } = streamedResponse(
      [
        new Uint8Array(32 * 1024),
        new Uint8Array(32 * 1024),
        new Uint8Array(1),
        new Uint8Array(1024 * 1024),
      ],
      headers,
    );
    t.mock.method(globalThis, 'fetch', async () => response);
    assert.equal((await fetchServerRobots('https://example.com')).denied, true);
    assert.equal(state.reads, 3);
    assert.equal(state.cancelled, true);
  });
}

test('robots accepts exactly 64 KiB and retains the policy', async (t) => {
  const body = 'User-agent: *\nDisallow: /private\n#'.padEnd(64 * 1024, 'x');
  t.mock.method(globalThis, 'fetch', async () => new Response(body));
  const policy = await fetchServerRobots('https://example.com');
  assert.equal(policy.denied, false);
  assert.equal(policy.body, body);
});

test('bounded text preserves split UTF-8 and enforces the default HTML byte cap', async () => {
  const bytes = new TextEncoder().encode('A🌍ž');
  const { response } = streamedResponse([
    bytes.subarray(0, 3),
    bytes.subarray(3),
  ]);
  assert.equal(await boundedText(response, bytes.length), 'A🌍ž');
  const oversized = streamedResponse([
    new Uint8Array(SCAN_LIMITS.htmlBytes + 1),
    new Uint8Array(1),
  ]);
  await assert.rejects(boundedText(oversized.response), BodyTooLarge);
  assert.equal(oversized.state.reads, 1);
  assert.equal(oversized.state.cancelled, true);
});

const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));

function largeResult() {
  const result = emptyResult('https://example.com/', 'ok');
  result.title = 'Příliš žluťoučký 🌍 "title"';
  result.links = Array.from({ length: 500 }, (_, index) => ({
    targetUrl: `https://example.com/${index}/${'🌍ž'.repeat(500)}`,
    anchor: '"\\\n🌍'.repeat(100),
    rel: ['nofollow'],
    region: 'content',
    occurrences: 1,
  }));
  result.discoveredUrls = result.links.map((link) => link.targetUrl);
  return result;
}

test('result trimming retains a dense original prefix and respects escaped UTF-8 byte limits', () => {
  const original = largeResult();
  const fitted = fitResult(structuredClone(original));
  assert.equal(fitted.truncated, true);
  assert.equal(fitted.discoveredUrls.length, 0);
  assert.ok(fitted.links.length > 0 && fitted.links.length < 500);
  assert.deepEqual(fitted.links, original.links.slice(0, fitted.links.length));
  assert.ok(jsonBytes(fitted) <= SCAN_LIMITS.resultBytes - 1024);
  fitted.links.push(original.links[fitted.links.length]);
  assert.ok(jsonBytes(fitted) > SCAN_LIMITS.resultBytes - 1024);
});

test('result trimming removes discovered URLs before touching links', () => {
  const original = largeResult();
  original.links = original.links.slice(0, 2);
  const fitted = fitResult(structuredClone(original));
  assert.deepEqual(fitted.links, original.links);
  assert.ok(fitted.discoveredUrls.length > 0);
  assert.deepEqual(
    fitted.discoveredUrls,
    original.discoveredUrls.slice(0, fitted.discoveredUrls.length),
  );
  assert.ok(jsonBytes(fitted) <= SCAN_LIMITS.resultBytes - 1024);
  fitted.discoveredUrls.push(
    original.discoveredUrls[fitted.discoveredUrls.length],
  );
  assert.ok(jsonBytes(fitted) > SCAN_LIMITS.resultBytes - 1024);
});

test('result trimming encodes at most twice the original payload size', (t) => {
  const result = largeResult();
  const initialBytes = jsonBytes(result);
  const encode = TextEncoder.prototype.encode;
  let encodedBytes = 0;
  t.mock.method(TextEncoder.prototype, 'encode', function (text) {
    const bytes = encode.call(this, text);
    encodedBytes += bytes.length;
    return bytes;
  });
  fitResult(result);
  assert.ok(encodedBytes <= 2 * initialBytes, `${encodedBytes} encoded bytes`);
  assert.ok(jsonBytes(result) <= SCAN_LIMITS.resultBytes - 1024);
});

test('small results preserve their content and truncation flag', () => {
  for (const truncated of [false, true]) {
    const result = { ...emptyResult('https://example.com/', 'ok'), truncated };
    assert.deepEqual(fitResult(structuredClone(result)), result);
  }
});
