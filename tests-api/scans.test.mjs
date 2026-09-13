import { after, before, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf;
let db;
let outboundRequests = 0;
const authGates = new Map();
const queuedCrawls = [];
const base = 'https://vizlinx.com';
const site = {
  origin: 'https://example.com',
  seedUrl: 'https://example.com/',
  intervalMs: 1000,
  maxPages: 50,
  paused: false,
};
const page = (path = '/') => ({
  sourceUrl: `${site.origin}${path}`,
  title: 'Fixture',
  observedAt: '2026-09-12T08:00:00.000Z',
  status: 'ok',
  httpStatus: 200,
  links: [
    {
      targetUrl: 'https://outside.org/',
      anchor: 'External',
      rel: [],
      region: 'content',
      occurrences: 1,
    },
  ],
  discoveredUrls: [],
  truncated: false,
});

before(async () => {
  const output = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `import worker from './worker/index.ts';
      export default {
        fetch(request, env) {
          env = { ...env, CRAWLER_ENABLED: 'true', ADMIN_EMAIL: '',
            CRAWL_QUEUE: { send: (body, options) => env.CRAWL_SINK.fetch('https://queue.invalid/', {
              method: 'POST', body: JSON.stringify({ body, options })
            }) }
          };
          const gate = request.headers.get('X-Test-Auth-Gate');
          if (!gate) return worker.fetch(request, env);
          const database = {
            batch: (...args) => env.DB.batch(...args),
            prepare(sql) {
              const statement = env.DB.prepare(sql);
              if (!sql.startsWith('SELECT * FROM scans WHERE id = ?1 AND runner_hash = ?2')) return statement;
              return {
                bind(...parameters) {
                  const bound = statement.bind(...parameters);
                  return {
                    async first(...args) {
                      const row = await bound.first(...args);
                      if (row) await env.AUTH_GATE.fetch('https://gate.invalid/' + gate);
                      return row;
                    },
                  };
                },
              };
            },
          };
          return worker.fetch(request, { ...env, DB: database });
        },
      };`,
    },
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'browser',
    target: 'es2022',
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: output.outputFiles[0].text,
      compatibilityDate: '2026-09-11',
      d1Databases: ['DB'],
      serviceBindings: {
        ASSETS: () => new Response('asset'),
        CRAWL_SINK: async (request) => {
          queuedCrawls.push(await request.json());
          return new Response('queued');
        },
        AUTH_GATE: async (request) => {
          const gate = authGates.get(new URL(request.url).pathname.slice(1));
          assert.ok(
            gate,
            'A test gate must exist before the authorized request arrives',
          );
          gate.arrived();
          await gate.released;
          return new Response('released');
        },
      },
      outboundService: () => {
        outboundRequests++;
        throw new Error('Server network access is forbidden in scan tests.');
      },
    }),
  );
  db = await mf.getD1Database('DB');
  for (const file of (await readdir(new URL('../migrations/', import.meta.url)))
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    const migration = await readFile(
      new URL(`../migrations/${file}`, import.meta.url),
      'utf8',
    );
    for (const sql of migration.split(';').filter((sql) => sql.trim()))
      await db.prepare(sql).run();
  }
});
afterEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM page_results'),
    db.prepare('DELETE FROM scans'),
    db.prepare('DELETE FROM visitors'),
    db.prepare('DELETE FROM creation_quotas'),
  ]);
  authGates.clear();
  queuedCrawls.length = 0;
});
after(async () => {
  assert.equal(outboundRequests, 0);
  await mf?.dispose();
});

async function request(
  path,
  { method = 'GET', cookie, token, body, origin = base, headers = {} } = {},
) {
  return mf.dispatchFetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      Origin: origin,
      'CF-Connecting-IP': '203.0.113.10',
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function visitor() {
  const response = await request('/session', { method: 'POST', body: {} });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(
    cookie,
    /HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000; Secure/,
  );
  return cookie.split(';')[0];
}
async function create(cookie, overrides = {}) {
  const response = await request('/scans', {
    method: 'POST',
    cookie,
    body: { sites: [{ ...site, ...overrides }] },
  });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}
async function pair(cookie, id) {
  const response = await request(`/scans/${id}/pairing-ticket`, {
    method: 'POST',
    cookie,
    body: {},
  });
  assert.equal(response.status, 200);
  const { ticket } = await response.json();
  const exchange = await request('/runner/exchange', {
    method: 'POST',
    body: { ticket },
  });
  assert.equal(exchange.status, 200);
  return { ticket, ...(await exchange.json()) };
}

async function pauseAfterRunnerAuth(path, options) {
  const id = String(authGates.size);
  const arrived = Promise.withResolvers();
  const released = Promise.withResolvers();
  authGates.set(id, { arrived: arrived.resolve, released: released.promise });
  const response = request(path, {
    ...options,
    headers: { 'X-Test-Auth-Gate': id },
  });
  await arrived.promise;
  return { response, release: released.resolve };
}

for (const revoke of ['rotate', 'append', 'expire']) {
  test(
    `in-flight runner writes cannot survive ${revoke} after successful authentication`,
    { timeout: 15_000 },
    async () => {
      for (const action of ['progress', 'results', 'duplicate', 'quota']) {
        const cookie = await visitor();
        const scan = await create(cookie, {
          maxPages: action === 'quota' ? 1 : 50,
        });
        const { token } = await pair(cookie, scan.id);
        const hasExistingResult = action === 'duplicate' || action === 'quota';
        if (hasExistingResult) {
          assert.equal(
            (
              await request(`/runner/scans/${scan.id}/results`, {
                method: 'PUT',
                token,
                body: page(),
              })
            ).status,
            200,
          );
        }
        const progress = action === 'progress';
        const pending = await pauseAfterRunnerAuth(
          `/runner/scans/${scan.id}/${progress ? 'progress' : 'results'}`,
          {
            method: progress ? 'POST' : 'PUT',
            token,
            body: progress
              ? { status: 'completed' }
              : page(action === 'quota' ? '/overflow' : '/'),
          },
        );
        try {
          if (revoke === 'rotate') await pair(cookie, scan.id);
          else if (revoke === 'append')
            assert.equal(
              (
                await appendSite(
                  cookie,
                  scan.id,
                  addedSite('https://second.org'),
                )
              ).status,
              201,
            );
          else
            await db
              .prepare('UPDATE scans SET runner_expires_at = 0 WHERE id = ?')
              .bind(scan.id)
              .run();
          const before = await db
            .prepare('SELECT * FROM scans WHERE id = ?')
            .bind(scan.id)
            .first();
          pending.release();
          assert.equal((await pending.response).status, 401, action);
          assert.deepEqual(
            await db
              .prepare('SELECT * FROM scans WHERE id = ?')
              .bind(scan.id)
              .first(),
            before,
            'A revoked request cannot change status, heartbeat, timestamps or credentials',
          );
          const stored = await (
            await request(`/scans/${scan.id}`, { cookie })
          ).json();
          assert.deepEqual(stored.results, hasExistingResult ? [page()] : []);
        } finally {
          pending.release();
        }
      }
    },
  );
}

test('cookie auth isolates visitors; JSON and same-origin protect writes', async () => {
  const alice = await visitor();
  const bob = await visitor();
  const scan = await create(alice);
  assert.equal(
    (await request(`/scans/${scan.id}`, { cookie: bob })).status,
    404,
  );
  assert.equal((await request(`/scans/${scan.id}`)).status, 401);
  assert.deepEqual(await (await request('/scans', { cookie: bob })).json(), []);
  assert.equal(
    (
      await request('/scans', {
        method: 'POST',
        cookie: alice,
        origin: 'https://attacker.org',
        body: { sites: [site] },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('/scans', {
        method: 'POST',
        cookie: alice,
        body: {},
        headers: { 'Content-Type': 'text/plain' },
      })
    ).status,
    415,
  );
  assert.equal(
    (await request('/scans', { cookie: alice })).headers.get(
      'access-control-allow-origin',
    ),
    null,
  );
  assert.equal((await request('/unknown')).status, 404);
  const stored = await db
    .prepare('SELECT token_hash FROM visitors WHERE token_hash = ?')
    .bind(alice.split('=')[1])
    .first();
  assert.equal(stored, null, 'Raw cookie is never stored');
});

test('refreshing an aged session and creating a map renew access without changing its owner', async () => {
  const retention = 30 * 24 * 60 * 60 * 1000;
  const cookie = await visitor();
  const original = await create(cookie);
  const { owner_hash: owner } = await db
    .prepare('SELECT owner_hash FROM scans WHERE id = ?')
    .bind(original.id)
    .first();
  const ageSession = () =>
    db
      .prepare('UPDATE visitors SET expires_at = ? WHERE token_hash = ?')
      .bind(Date.now() + 60_000, owner)
      .run();
  await ageSession();
  const refreshedAt = Date.now();
  const refreshed = await request('/session', {
    method: 'POST',
    cookie,
    body: {},
  });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.headers.get('set-cookie').split(';')[0], cookie);
  assert.match(refreshed.headers.get('set-cookie'), /Max-Age=2592000; Secure/);
  const renewed = await db
    .prepare('SELECT expires_at FROM visitors WHERE token_hash = ?')
    .bind(owner)
    .first();
  assert.ok(renewed.expires_at >= refreshedAt + retention);
  assert.equal(
    (await request(`/scans/${original.id}`, { cookie })).status,
    200,
  );

  // A long-open workspace creates a map without calling /session again.
  await ageSession();
  const created = await request('/scans', {
    method: 'POST',
    cookie,
    body: { sites: [site] },
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('set-cookie').split(';')[0], cookie);
  const scan = await created.json();
  const stored = await db
    .prepare(
      'SELECT scans.owner_hash, scans.created_at, visitors.expires_at FROM scans JOIN visitors ON scans.owner_hash = visitors.token_hash WHERE scans.id = ?',
    )
    .bind(scan.id)
    .first();
  assert.equal(stored.owner_hash, owner);
  assert.ok(stored.expires_at >= stored.created_at + retention);
  const maps = await (await request('/scans', { cookie })).json();
  assert.deepEqual(
    new Set(maps.map((map) => map.id)),
    new Set([original.id, scan.id]),
  );
});

test('session renewal never revives an expired visitor or transfers its young maps', async () => {
  const cookie = await visitor();
  const scan = await create(cookie);
  const { owner_hash: owner } = await db
    .prepare('SELECT owner_hash FROM scans WHERE id = ?')
    .bind(scan.id)
    .first();
  await db
    .prepare('UPDATE visitors SET expires_at = 0 WHERE token_hash = ?')
    .bind(owner)
    .run();
  assert.equal(
    (
      await request('/scans', {
        method: 'POST',
        cookie,
        body: { sites: [site] },
      })
    ).status,
    401,
  );
  const refreshed = await request('/session', {
    method: 'POST',
    cookie,
    body: {},
  });
  assert.equal(refreshed.status, 200);
  const replacement = refreshed.headers.get('set-cookie').split(';')[0];
  assert.notEqual(replacement, cookie);
  assert.equal((await request(`/scans/${scan.id}`, { cookie })).status, 401);
  assert.equal(
    (await request(`/scans/${scan.id}`, { cookie: replacement })).status,
    404,
  );
  assert.equal(
    (
      await db
        .prepare('SELECT expires_at FROM visitors WHERE token_hash = ?')
        .bind(owner)
        .first()
    ).expires_at,
    0,
  );
});

test('pairing is one-use under concurrency, rotates tokens and enforces scan scope', async () => {
  const cookie = await visitor();
  const scan = await create(cookie);
  const response = await request(`/scans/${scan.id}/pairing-ticket`, {
    method: 'POST',
    cookie,
    body: {},
  });
  const { ticket } = await response.json();
  const exchanges = await Promise.all(
    [0, 1].map(() =>
      request('/runner/exchange', { method: 'POST', body: { ticket } }),
    ),
  );
  assert.deepEqual(
    exchanges.map((response) => response.status).sort(),
    [200, 401],
  );
  const { token } = await exchanges
    .find((response) => response.status === 200)
    .json();
  assert.equal(
    (await request(`/runner/scans/${scan.id}`, { token })).status,
    200,
  );
  const other = await create(cookie);
  assert.equal(
    (await request(`/runner/scans/${other.id}`, { token })).status,
    401,
  );
  const next = await pair(cookie, scan.id);
  assert.equal(
    (await request(`/runner/scans/${scan.id}`, { token })).status,
    401,
  );
  assert.equal(
    (await request(`/runner/scans/${scan.id}`, { token: next.token })).status,
    200,
  );
});

test('expired ticket, runner, visitor and retained scan cannot authenticate', async () => {
  const cookie = await visitor();
  const scan = await create(cookie);
  const ticketResponse = await request(`/scans/${scan.id}/pairing-ticket`, {
    method: 'POST',
    cookie,
    body: {},
  });
  const { ticket } = await ticketResponse.json();
  await db
    .prepare('UPDATE scans SET ticket_expires_at = 0 WHERE id = ?')
    .bind(scan.id)
    .run();
  assert.equal(
    (await request('/runner/exchange', { method: 'POST', body: { ticket } }))
      .status,
    401,
  );
  const { token } = await pair(cookie, scan.id);
  await db
    .prepare('UPDATE scans SET runner_expires_at = 0 WHERE id = ?')
    .bind(scan.id)
    .run();
  assert.equal(
    (await request(`/runner/scans/${scan.id}`, { token })).status,
    401,
  );
  const active = await pair(cookie, scan.id);
  await db
    .prepare('UPDATE scans SET created_at = 0 WHERE id = ?')
    .bind(scan.id)
    .run();
  assert.equal((await request(`/scans/${scan.id}`, { cookie })).status, 404);
  assert.equal(
    (await request(`/runner/scans/${scan.id}`, { token: active.token })).status,
    401,
  );
  assert.deepEqual(await (await request('/scans', { cookie })).json(), []);
  await db
    .prepare(
      'UPDATE visitors SET expires_at = 0 WHERE token_hash = (SELECT owner_hash FROM scans WHERE id = ?)',
    )
    .bind(scan.id)
    .run();
  assert.equal((await request('/scans', { cookie })).status, 401);
});

test('duplicate uploads are idempotent, conflicting bodies fail and exact source scope is checked', async () => {
  const cookie = await visitor();
  const scan = await create(cookie);
  const { token } = await pair(cookie, scan.id);
  const upload = (body) =>
    request(`/runner/scans/${scan.id}/results`, { method: 'PUT', token, body });
  const responses = await Promise.all([upload(page()), upload(page())]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  );
  assert.equal((await upload({ ...page(), title: 'Changed' })).status, 409);
  assert.equal(
    (await upload({ ...page(), sourceUrl: 'https://sub.example.com/' })).status,
    403,
  );
  assert.equal(
    (await upload({ ...page(), sourceUrl: 'http://127.0.0.1/' })).status,
    400,
  );
  assert.equal(
    (await upload({ ...page(), discoveredUrls: ['https://other.org/'] }))
      .status,
    400,
  );
  assert.equal(
    (
      await upload({
        ...page(),
        links: [{ ...page().links[0], targetUrl: 'javascript:alert(1)' }],
      })
    ).status,
    400,
  );
  const result = await (await request(`/scans/${scan.id}`, { cookie })).json();
  assert.equal(result.pageCount, 1);
  assert.deepEqual(result.results, [page()]);
  assert.equal(outboundRequests, 0);
});

test('page quota is atomic, retries still succeed at quota, and lowering maxPages is honored', async () => {
  const cookie = await visitor();
  const scan = await create(cookie, { maxPages: 1 });
  const { token } = await pair(cookie, scan.id);
  const upload = (body) =>
    request(`/runner/scans/${scan.id}/results`, { method: 'PUT', token, body });
  const results = await Promise.all([upload(page('/a')), upload(page('/b'))]);
  assert.deepEqual(
    results.map((response) => response.status).sort(),
    [200, 429],
  );
  const acceptedPath = results[0].status === 200 ? '/a' : '/b';
  assert.equal((await upload(page(acceptedPath))).status, 200);
  const limited = await upload(page('/c'));
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), {
    error: 'Scan page or storage limit reached.',
    code: 'page_limit',
    maxPages: 1,
  });
  assert.equal(
    (await (await request(`/scans/${scan.id}`, { cookie })).json()).status,
    'limited',
  );
  assert.equal(
    (
      await request(`/scans/${scan.id}`, {
        method: 'PATCH',
        cookie,
        body: { sites: [{ ...site, seedUrl: 'https://example.com/other' }] },
      })
    ).status,
    400,
  );
  await request(`/scans/${scan.id}`, {
    method: 'PATCH',
    cookie,
    body: { status: 'waiting', sites: [{ ...site, maxPages: 2 }] },
  });
  assert.equal(
    (await upload(page('/c'))).status,
    200,
    'A retained result can be retried after increasing the page limit',
  );
});

test('ten-scan limit and bounded bodies prevent unbounded visitor storage', async () => {
  const cookie = await visitor();
  for (let index = 0; index < 10; index++) await create(cookie);
  assert.equal(
    (
      await request('/scans', {
        method: 'POST',
        cookie,
        body: { sites: [site] },
      })
    ).status,
    429,
  );
  assert.equal(
    (
      await request('/scans', {
        method: 'POST',
        cookie,
        body: { sites: [site], ignored: 'x'.repeat(17 * 1024) },
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await request('/scans', {
        method: 'POST',
        cookie,
        body: { sites: [{ ...site, maxPages: 101 }] },
      })
    ).status,
    400,
  );
});

test('pause wins over heartbeat; stale runs report interrupted and web resume works', async () => {
  const cookie = await visitor();
  const scan = await create(cookie);
  const { token } = await pair(cookie, scan.id);
  const progress = (status) =>
    request(`/runner/scans/${scan.id}/progress`, {
      method: 'POST',
      token,
      body: { status },
    });
  await progress('running');
  await db
    .prepare('UPDATE scans SET heartbeat_at = 0 WHERE id = ?')
    .bind(scan.id)
    .run();
  assert.equal(
    (
      await (
        await request(`/runner/scans/${scan.id}/control`, { token })
      ).json()
    ).status,
    'interrupted',
  );
  await request(`/scans/${scan.id}`, {
    method: 'PATCH',
    cookie,
    body: { status: 'paused' },
  });
  await progress('completed');
  assert.equal(
    (await (await request(`/scans/${scan.id}`, { cookie })).json()).status,
    'paused',
  );
  await request(`/scans/${scan.id}`, {
    method: 'PATCH',
    cookie,
    body: { status: 'waiting' },
  });
  await progress('running');
  assert.equal(
    (
      await (
        await request(`/runner/scans/${scan.id}/control`, { token })
      ).json()
    ).status,
    'running',
  );
});

test('scan byte quota bounds snapshots independently of page count', async () => {
  const cookie = await visitor();
  const scan = await create(cookie);
  const { token } = await pair(cookie, scan.id);
  const links = Array.from({ length: 400 }, (_, index) => ({
    ...page().links[0],
    targetUrl: `https://outside.org/${index}`,
    anchor: 'x'.repeat(400),
  }));
  const statuses = [];
  for (let index = 0; index < 24; index++) {
    const response = await request(`/runner/scans/${scan.id}/results`, {
      method: 'PUT',
      token,
      body: { ...page(`/${index}`), links },
    });
    statuses.push(response.status);
    if (response.status === 429) {
      assert.equal((await response.json()).code, 'scan_storage_limit');
      break;
    }
  }
  assert.equal(statuses.at(-1), 429);
  assert.ok(statuses.slice(0, -1).every((status) => status === 200));
  const stored = await db
    .prepare(
      'SELECT SUM(result_bytes) AS bytes FROM page_results WHERE scan_id = ?',
    )
    .bind(scan.id)
    .first();
  assert.ok(stored.bytes <= 4 * 1024 * 1024);
  assert.equal(
    (await (await request(`/scans/${scan.id}`, { cookie })).json()).status,
    'limited',
  );
  await request(`/scans/${scan.id}`, {
    method: 'PATCH',
    cookie,
    body: { status: 'paused' },
  });
  const paused = await request(`/runner/scans/${scan.id}/results`, {
    method: 'PUT',
    token,
    body: { ...page('/paused-overflow'), links },
  });
  assert.equal(paused.status, 429);
  assert.equal(
    (await (await request(`/scans/${scan.id}`, { cookie })).json()).status,
    'paused',
    'A quota report cannot override a web pause',
  );
});

test('fresh cookies cannot bypass the atomic daily session limit', async () => {
  const responses = await Promise.all(
    Array.from({ length: 21 }, () =>
      request('/session', { method: 'POST', body: {} }),
    ),
  );
  assert.equal(
    responses.filter((response) => response.status === 200).length,
    20,
  );
  assert.equal(
    responses.filter((response) => response.status === 429).length,
    1,
  );
  const buckets = await db.prepare('SELECT * FROM creation_quotas').all();
  assert.equal(buckets.results.length, 1);
  assert.match(buckets.results[0].bucket_hash, /^[a-f0-9]{64}$/);
  assert.equal(buckets.results[0].request_count, 20);
  assert.ok(!JSON.stringify(buckets.results).includes('203.0.113.10'));
  const cookie = responses
    .find((response) => response.status === 200)
    .headers.get('set-cookie')
    .split(';')[0];
  assert.equal(
    (await request('/session', { method: 'POST', body: {}, cookie })).status,
    200,
    'Existing sessions do not consume creation quota',
  );
});

test('daily scan quota spans visitors and rejects concurrent overflow', async () => {
  const cookies = [];
  for (let index = 0; index < 6; index++) cookies.push(await visitor());
  const responses = await Promise.all(
    Array.from({ length: 51 }, (_, index) =>
      request('/scans', {
        method: 'POST',
        cookie: cookies[index % cookies.length],
        body: { sites: [site] },
      }),
    ),
  );
  assert.equal(
    responses.filter((response) => response.status === 201).length,
    50,
  );
  assert.equal(
    responses.filter((response) => response.status === 429).length,
    1,
  );
});

test('global scan capacity is enforced atomically across owners', async () => {
  const cookie = await visitor();
  const existing = await db
    .prepare('SELECT COUNT(*) AS count FROM scans')
    .first();
  await db
    .prepare('INSERT INTO visitors (token_hash, expires_at) VALUES (?, ?)')
    .bind('capacity-owner', Date.now() + 100000)
    .run();
  const remaining = 999 - existing.count;
  await db
    .prepare(
      `WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < ?1)
    INSERT INTO scans (id, owner_hash, sites_json, created_at, updated_at)
    SELECT 'capacity-' || n, 'capacity-owner', ?2, ?3, ?3 FROM numbers`,
    )
    .bind(remaining, JSON.stringify([site]), Date.now())
    .run();
  try {
    const responses = await Promise.all(
      [0, 1].map(() =>
        request('/scans', { method: 'POST', cookie, body: { sites: [site] } }),
      ),
    );
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [201, 429],
    );
    assert.equal(
      (await db.prepare('SELECT COUNT(*) AS count FROM scans').first()).count,
      1000,
    );
  } finally {
    await db
      .prepare("DELETE FROM visitors WHERE token_hash = 'capacity-owner'")
      .run();
  }
});

test('creation cleanup physically removes expired results in bounded batches', async () => {
  const owner = 'expired-owner';
  await db
    .prepare('INSERT INTO visitors (token_hash, expires_at) VALUES (?, 0)')
    .bind(owner)
    .run();
  for (let index = 0; index < 5; index++) {
    await db
      .prepare(
        'INSERT INTO scans (id, owner_hash, sites_json, created_at, updated_at) VALUES (?, ?, ?, 0, 0)',
      )
      .bind(`expired-${index}`, owner, JSON.stringify([site]))
      .run();
    await db
      .prepare(
        'INSERT INTO page_results (scan_id, source_url, source_origin, result_hash, result_json, result_bytes) VALUES (?, ?, ?, ?, ?, 1)',
      )
      .bind(
        `expired-${index}`,
        site.seedUrl,
        site.origin,
        'fixture',
        JSON.stringify(page()),
      )
      .run();
  }
  await db
    .prepare(
      'INSERT INTO scans (id, owner_hash, sites_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(
      'young-scan-old-owner',
      owner,
      JSON.stringify([site]),
      Date.now(),
      Date.now(),
    )
    .run();
  await db
    .prepare(
      'INSERT INTO creation_quotas (bucket_hash, request_count, expires_at) VALUES (?, 20, 0)',
    )
    .bind('expired-quota')
    .run();
  await visitor();
  assert.equal(
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM scans WHERE id LIKE 'expired-%'",
        )
        .first()
    ).count,
    3,
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM page_results WHERE scan_id LIKE 'expired-%'",
        )
        .first()
    ).count,
    3,
  );
  assert.ok(
    await db
      .prepare("SELECT id FROM scans WHERE id = 'young-scan-old-owner'")
      .first(),
    'Visitor expiry must not cascade to a scan younger than 30 days',
  );
  assert.equal(
    await db
      .prepare(
        "SELECT bucket_hash FROM creation_quotas WHERE bucket_hash = 'expired-quota'",
      )
      .first(),
    null,
  );
  await db
    .prepare('DELETE FROM visitors WHERE token_hash = ?')
    .bind(owner)
    .run();
});

test('redirect results stay metadata and protocol changes cannot expand source scope', async () => {
  const cookie = await visitor();
  const scan = await create(cookie);
  const { token } = await pair(cookie, scan.id);
  const upload = (body) =>
    request(`/runner/scans/${scan.id}/results`, { method: 'PUT', token, body });
  assert.equal(
    (await upload({ ...page(), sourceUrl: 'http://example.com/' })).status,
    403,
  );
  assert.equal(
    (
      await upload({
        ...page(),
        sourceUrl: 'https://example.com@attacker.org/',
      })
    ).status,
    400,
  );
  const redirected = {
    ...page('/redirect'),
    status: 'redirect_unresolved',
    httpStatus: 302,
    links: [],
    discoveredUrls: [],
  };
  assert.equal((await upload(redirected)).status, 200);
  const snapshot = await (
    await request(`/scans/${scan.id}`, { cookie })
  ).json();
  assert.deepEqual(snapshot.results, [redirected]);
  assert.equal(outboundRequests, 0);
});

const addedSite = (origin) => ({
  ...site,
  origin,
  seedUrl: `${origin}/`,
  intervalMs: 4000,
  maxPages: 20,
});
const appendSite = (cookie, id, value) =>
  request(`/scans/${id}/sites`, {
    method: 'POST',
    cookie,
    body: { site: value },
  });

test('appending an origin preserves completed results and retention while revoking runner and pending ticket', async () => {
  const cookie = await visitor();
  const scan = await create(cookie, { intervalMs: 5000, maxPages: 5 });
  const { token } = await pair(cookie, scan.id);
  assert.equal(
    (
      await request(`/runner/scans/${scan.id}/results`, {
        method: 'PUT',
        token,
        body: page(),
      })
    ).status,
    200,
  );
  await request(`/runner/scans/${scan.id}/progress`, {
    method: 'POST',
    token,
    body: { status: 'completed' },
  });
  const { ticket } = await (
    await request(`/scans/${scan.id}/pairing-ticket`, {
      method: 'POST',
      cookie,
      body: {},
    })
  ).json();
  const added = addedSite('https://second.org');
  const response = await appendSite(cookie, scan.id, added);
  assert.equal(response.status, 201);
  const updated = await response.json();
  assert.equal(updated.status, 'paused');
  assert.equal(updated.id, scan.id);
  assert.equal(updated.createdAt, scan.createdAt);
  assert.deepEqual(updated.sites, [...scan.sites, added]);
  assert.deepEqual(updated.results, [page()]);
  assert.equal(updated.pageCount, 1);
  const stored = await db
    .prepare(
      'SELECT runner_hash, runner_expires_at, ticket_hash, ticket_expires_at, heartbeat_at FROM scans WHERE id = ?',
    )
    .bind(scan.id)
    .first();
  assert.ok(Object.values(stored).every((value) => value === null));
  assert.equal(
    (await request(`/runner/scans/${scan.id}/control`, { token })).status,
    401,
  );
  assert.equal(
    (
      await request(`/runner/scans/${scan.id}/results`, {
        method: 'PUT',
        token,
        body: page(),
      })
    ).status,
    401,
  );
  assert.equal(
    (await request('/runner/exchange', { method: 'POST', body: { ticket } }))
      .status,
    401,
  );
  const next = await pair(cookie, scan.id);
  assert.equal(next.scan.status, 'paused');
  assert.deepEqual(next.scan.sites, updated.sites);
  assert.equal(
    (await request(`/runner/scans/${scan.id}/control`, { token: next.token }))
      .status,
    200,
  );
});

test('adding a scan origin enforces ownership, same origin, valid bounded inputs and the three-origin limit', async () => {
  const alice = await visitor();
  const bob = await visitor();
  const scan = await create(alice);
  const second = addedSite('https://second.org');
  assert.equal((await appendSite(bob, scan.id, second)).status, 404);
  assert.equal((await appendSite(undefined, scan.id, second)).status, 401);
  assert.equal(
    (
      await request(`/scans/${scan.id}/sites`, {
        method: 'POST',
        cookie: alice,
        origin: 'https://attacker.org',
        body: { site: second },
      })
    ).status,
    403,
  );
  assert.equal(
    (await appendSite(alice, scan.id, addedSite('http://127.0.0.1'))).status,
    400,
  );
  assert.equal(
    (
      await appendSite(alice, scan.id, {
        ...second,
        seedUrl: 'https://other.org/',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/scans/${scan.id}/sites`, {
        method: 'POST',
        cookie: alice,
        body: { site: second, oversized: 'x'.repeat(17 * 1024) },
      })
    ).status,
    413,
  );
  assert.equal((await appendSite(alice, scan.id, site)).status, 409);
  assert.equal((await appendSite(alice, scan.id, second)).status, 201);
  assert.equal(
    (
      await request(`/scans/${scan.id}`, {
        method: 'PATCH',
        cookie: alice,
        body: { sites: scan.sites },
      })
    ).status,
    409,
    'An older control payload must not remove an appended origin',
  );
  assert.equal(
    (await appendSite(alice, scan.id, addedSite('https://third.org'))).status,
    201,
  );
  assert.equal(
    (await appendSite(alice, scan.id, addedSite('https://fourth.org'))).status,
    409,
  );
  const stored = await (
    await request(`/scans/${scan.id}`, { cookie: alice })
  ).json();
  assert.equal(stored.sites.length, 3);
});

test('concurrent additions cannot exceed the origin limit or overwrite the accepted addition', async () => {
  const cookie = await visitor();
  const scan = await create(cookie);
  await appendSite(cookie, scan.id, addedSite('https://second.org'));
  const additions = [
    addedSite('https://third.org'),
    addedSite('https://fourth.org'),
  ];
  const responses = await Promise.all(
    additions.map((added) => appendSite(cookie, scan.id, added)),
  );
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [201, 409],
  );
  const stored = await (await request(`/scans/${scan.id}`, { cookie })).json();
  assert.equal(stored.sites.length, 3);
  assert.deepEqual(
    stored.sites[2],
    additions[responses.findIndex((response) => response.status === 201)],
  );
});

test('concurrent append and site-control PATCH preserve every acknowledged change', async () => {
  const cookie = await visitor();
  for (let index = 0; index < 8; index++) {
    const scan = await create(cookie);
    const added = addedSite('https://second.org');
    const [append, patch] = await Promise.all([
      appendSite(cookie, scan.id, added),
      request(`/scans/${scan.id}`, {
        method: 'PATCH',
        cookie,
        body: { sites: [{ ...site, intervalMs: 17000 }] },
      }),
    ]);
    assert.ok([201, 409].includes(append.status));
    assert.ok([200, 409].includes(patch.status));
    assert.ok(append.status === 201 || patch.status === 200);
    const stored = await (
      await request(`/scans/${scan.id}`, { cookie })
    ).json();
    if (append.status === 201) {
      assert.equal(stored.sites.length, 2);
      assert.deepEqual(stored.sites[1], added);
      assert.equal(stored.status, 'paused');
    }
    if (patch.status === 200) assert.equal(stored.sites[0].intervalMs, 17000);
  }
});

test('server start requires ownership and same origin, fixes the page cap, and revokes the extension', async () => {
  const alice = await visitor();
  const bob = await visitor();
  const scan = await create(alice, { maxPages: 20 });
  const { token } = await pair(alice, scan.id);
  const path = `/scans/${scan.id}/start`;
  assert.equal((await request(path, { method: 'POST', body: {} })).status, 401);
  assert.equal(
    (await request(path, { method: 'POST', cookie: bob, body: {} })).status,
    404,
  );
  assert.equal(
    (
      await request(path, {
        method: 'POST',
        cookie: alice,
        origin: 'https://evil.org',
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(queuedCrawls.length, 0);
  const response = await request(path, {
    method: 'POST',
    cookie: alice,
    body: {},
  });
  assert.equal(response.status, 200, await response.clone().text());
  const started = await response.json();
  assert.equal(started.status, 'running');
  assert.equal(started.sites[0].maxPages, 100);
  const checkpoint = await db
    .prepare('SELECT crawl_generation, crawl_tick FROM scans WHERE id = ?')
    .bind(scan.id)
    .first();
  assert.deepEqual(queuedCrawls, [
    {
      body: {
        scanId: scan.id,
        generation: checkpoint.crawl_generation,
        tick: checkpoint.crawl_tick,
      },
      options: { delaySeconds: 0 },
    },
  ]);
  assert.equal(
    (await request(`/runner/scans/${scan.id}`, { token })).status,
    401,
  );
  assert.equal(
    (
      await request(`/scans/${scan.id}/pairing-ticket`, {
        method: 'POST',
        cookie: alice,
        body: {},
      })
    ).status,
    409,
  );
  const repeated = await request(path, {
    method: 'POST',
    cookie: alice,
    body: {},
  });
  assert.equal(repeated.status, 200);
  assert.equal(
    queuedCrawls.length,
    1,
    'Repeated start must not multiply queue work.',
  );
  const paused = await request(`/scans/${scan.id}`, {
    method: 'PATCH',
    cookie: alice,
    body: { status: 'paused', sites: [{ ...site, maxPages: 1 }] },
  });
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).sites[0].maxPages, 100);
});

test('running settings preserve the run deadline and start quota while resumes consume it', async () => {
  const cookie = await visitor();
  const scan = await create(cookie);
  const path = `/scans/${scan.id}`;
  assert.equal(
    (await request(`${path}/start`, { method: 'POST', cookie, body: {} }))
      .status,
    200,
  );
  const day = Math.floor(Date.now() / 86_400_000);
  const bucket = Buffer.from(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`start:${day}:203.0.113.10`),
    ),
  ).toString('hex');
  await db
    .prepare(
      'UPDATE creation_quotas SET request_count = 99 WHERE bucket_hash = ?',
    )
    .bind(bucket)
    .run();
  const original = await db
    .prepare('SELECT crawl_started_at FROM scans WHERE id = ?')
    .bind(scan.id)
    .first();
  for (const change of [
    { intervalMs: 3000 },
    { intervalMs: 3000, paused: true },
    { intervalMs: 5000, paused: false },
  ]) {
    const response = await request(path, {
      method: 'PATCH',
      cookie,
      body: { sites: [{ ...site, ...change }] },
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).status, 'running');
  }
  assert.deepEqual(
    await db
      .prepare('SELECT crawl_started_at FROM scans WHERE id = ?')
      .bind(scan.id)
      .first(),
    original,
    'Settings changes must not reset the running scan deadline.',
  );
  assert.equal(
    (
      await db
        .prepare(
          'SELECT request_count FROM creation_quotas WHERE bucket_hash = ?',
        )
        .bind(bucket)
        .first()
    ).request_count,
    99,
  );
  const control = (status) =>
    request(path, { method: 'PATCH', cookie, body: { status } });
  assert.equal((await control('paused')).status, 200);
  assert.equal((await control('waiting')).status, 200);
  assert.equal(
    (
      await db
        .prepare(
          'SELECT request_count FROM creation_quotas WHERE bucket_hash = ?',
        )
        .bind(bucket)
        .first()
    ).request_count,
    100,
  );
  assert.equal((await control('paused')).status, 200);
  assert.equal((await control('waiting')).status, 429);
  assert.equal(
    (await (await request(path, { cookie })).json()).status,
    'paused',
    'Rejected resumes must leave the scan paused.',
  );
});

test('server limit reason survives reload and pause without allowing a time-budget bypass', async () => {
  const cookie = await visitor();
  const scan = await create(cookie);
  await db
    .prepare(
      "UPDATE scans SET execution_mode = 'server', status = 'limited', limit_reason = 'time_limit' WHERE id = ?1",
    )
    .bind(scan.id)
    .run();
  const snapshot = await (
    await request(`/scans/${scan.id}`, { cookie })
  ).json();
  assert.equal(snapshot.limitReason, 'time_limit');
  const paused = await request(`/scans/${scan.id}`, {
    method: 'PATCH',
    cookie,
    body: { status: 'paused' },
  });
  assert.equal((await paused.json()).status, 'limited');
  const resumed = await request(`/scans/${scan.id}/start`, {
    method: 'POST',
    cookie,
    body: {},
  });
  assert.equal(resumed.status, 429);
  assert.equal(queuedCrawls.length, 0);
});

test('public scanner configuration exposes only the contact and fixed page cap', async () => {
  const response = await request('/config');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    adminEmail: null,
    maxPagesPerSite: 100,
  });
});

test('legacy runner settings and progress never retain server queue activity', async () => {
  const cookie = await visitor();
  const scan = await create(cookie);
  const { token } = await pair(cookie, scan.id);
  const progress = () =>
    request(`/runner/scans/${scan.id}/progress`, {
      method: 'POST',
      token,
      body: { status: 'running' },
    });
  assert.equal((await progress()).status, 200);
  assert.equal(
    (
      await request(`/scans/${scan.id}`, {
        method: 'PATCH',
        cookie,
        body: { sites: [{ ...site, intervalMs: 5000 }] },
      })
    ).status,
    200,
  );
  let snapshot = await (await request(`/scans/${scan.id}`, { cookie })).json();
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.activity, undefined);
  await db
    .prepare('UPDATE scans SET activity_json = ? WHERE id = ?')
    .bind(
      JSON.stringify({ phase: 'queued', updatedAt: new Date().toISOString() }),
      scan.id,
    )
    .run();
  assert.equal((await progress()).status, 200);
  snapshot = await (await request(`/scans/${scan.id}`, { cookie })).json();
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.activity, undefined);
});

test('scan logs require the owner and expire with the map and visitor', async () => {
  const alice = await visitor();
  const bob = await visitor();
  const scan = await create(alice);
  const path = `/scans/${scan.id}/log`;
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(path, { cookie: bob })).status, 404);
  const response = await request(path, { cookie: alice });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { events: [], truncated: false });
  await db
    .prepare('UPDATE scans SET created_at = 0 WHERE id = ?')
    .bind(scan.id)
    .run();
  assert.equal((await request(path, { cookie: alice })).status, 404);
  await db
    .prepare(
      'UPDATE visitors SET expires_at = 0 WHERE token_hash = (SELECT owner_hash FROM scans WHERE id = ?)',
    )
    .bind(scan.id)
    .run();
  assert.equal((await request(path, { cookie: alice })).status, 401);
});

test('scan activity and control events persist without logging rejected changes', async () => {
  const cookie = await visitor();
  const scan = await create(cookie);
  const path = `/scans/${scan.id}`;
  const start = await request(`${path}/start`, {
    method: 'POST',
    cookie,
    body: {},
  });
  assert.equal((await start.json()).activity.phase, 'queued');
  await request(`${path}/start`, { method: 'POST', cookie, body: {} });
  assert.equal(
    (
      await request(path, {
        method: 'PATCH',
        cookie,
        body: { status: 'paused' },
      })
    ).status,
    200,
  );
  const paused = await (await request(path, { cookie })).json();
  assert.equal(paused.status, 'paused');
  assert.equal(paused.activity.phase, 'paused');
  assert.equal(
    (
      await request(path, {
        method: 'PATCH',
        cookie,
        body: { sites: [{ ...site, intervalMs: 5000 }] },
      })
    ).status,
    200,
  );
  const added = {
    ...site,
    origin: 'https://second.org',
    seedUrl: 'https://second.org/',
  };
  const addition = await request(`${path}/sites`, {
    method: 'POST',
    cookie,
    body: { site: added },
  });
  assert.equal(addition.status, 201);
  assert.equal((await addition.json()).activity.phase, 'paused');
  assert.equal(
    (
      await request(`${path}/sites`, {
        method: 'POST',
        cookie,
        body: { site: added },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(path, {
        method: 'PATCH',
        cookie,
        body: { status: 'completed' },
      })
    ).status,
    400,
  );
  const log = await (await request(`${path}/log`, { cookie })).json();
  assert.deepEqual(
    log.events.map((event) => event.type),
    ['scan_started', 'scan_paused', 'settings_changed', 'site_added'],
  );
  assert.equal(log.truncated, false);
  assert.equal(log.events[3].origin, added.origin);
  assert.equal(log.events[3].url, added.seedUrl);
  for (const [index, event] of log.events.entries()) {
    assert.ok(Number.isFinite(Date.parse(event.at)));
    assert.equal(event.level, 'info');
    if (index) assert.ok(event.id > log.events[index - 1].id);
  }
  await db.prepare('DELETE FROM scans WHERE id = ?').bind(scan.id).run();
  assert.equal(
    (
      await db
        .prepare('SELECT COUNT(*) AS count FROM scan_events WHERE scan_id = ?')
        .bind(scan.id)
        .first()
    ).count,
    0,
  );
});
