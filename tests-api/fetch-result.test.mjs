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

test('redirect metadata resolves paths but never follows changed origins or unsafe targets inside fetch', async (t) => {
  const cases = [
    ['../final?q=1#section', 'same_origin', 'https://example.com/final?q=1'],
    ['https://example.com/next', 'same_origin', 'https://example.com/next'],
    ['//other.org/landing', 'external', 'https://other.org/landing'],
    [
      'https://sub.example.com/landing',
      'external',
      'https://sub.example.com/landing',
    ],
    ['http://example.com/landing', 'external', 'http://example.com/landing'],
    [
      'https://example.com:8443/landing',
      'external',
      'https://example.com:8443/landing',
    ],
    ['http://127.0.0.1/private', 'external', 'http://127.0.0.1/private'],
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
    assert.equal(result.redirect.kind, kind);
    assert.equal(result.redirect.targetUrl, targetUrl);
    assert.deepEqual(result.links, []);
    assert.deepEqual(result.discoveredUrls, []);
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
