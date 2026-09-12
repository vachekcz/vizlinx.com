import { after, before, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf;
let db;
let outboundRequests = 0;
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
    entryPoints: ['worker/index.ts'],
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
      serviceBindings: { ASSETS: () => new Response('asset') },
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
  await db.prepare('DELETE FROM creation_quotas').run();
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
  assert.equal((await upload(page('/c'))).status, 429);
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
        body: { sites: [{ ...site, maxPages: 51 }] },
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
    if (response.status === 429) break;
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
