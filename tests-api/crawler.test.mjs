import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf;
let db;
const pending = [];
const requests = [];
let respond = () => new Response('Not found', { status: 404 });
const origin = 'https://example.com';
const site = {
  origin,
  seedUrl: `${origin}/`,
  maxPages: 100,
  intervalMs: 1000,
  paused: false,
};
const html = (links = [], title = 'Fixture') =>
  new Response(
    `<title>${title}</title>${links.map((url) => `<a href="${url}">Link</a>`).join('')}`,
    { headers: { 'Content-Type': 'text/html' } },
  );

before(async () => {
  const output = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `import { startServerScan, consumeCrawlBatch } from './worker/crawler.ts';
        export default { async fetch(request, env) {
          const input = await request.json();
          const queue = { async send(body, options) {
            if (input.failQueue) throw new Error('Simulated delivery failure: private diagnostic');
            await env.QUEUE_SPY.fetch('https://queue.invalid/', { method: 'POST', body: JSON.stringify({ body, options }) });
          } };
          const bound = { ...env, CRAWL_QUEUE: queue, CRAWLER_ENABLED: input.enabled === false ? 'false' : 'true' };
          if (input.action === 'start') {
            try { await startServerScan(bound, input.id, input.generation); return Response.json({ ok: true }); }
            catch (error) { return Response.json({ error: error.message }, { status: error.status ?? 500 }); }
          }
          const outcomes = [];
          const message = { body: input.body, id: 'fixture', timestamp: new Date(), attempts: 1,
            ack() { outcomes.push('ack'); }, retry(options) { outcomes.push({ retry: options }); } };
          await consumeCrawlBatch({ messages: [message], queue: 'fixture', ackAll() {}, retryAll() {} }, bound);
          return Response.json(outcomes);
        } };`,
    },
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'browser',
    target: 'es2023',
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: output.outputFiles[0].text,
      compatibilityDate: '2026-09-12',
      compatibilityFlags: ['global_fetch_strictly_public'],
      d1Databases: ['DB'],
      serviceBindings: {
        QUEUE_SPY: async (request) => {
          pending.push(await request.json());
          return new Response('queued');
        },
      },
      outboundService: async (request) => {
        requests.push(request);
        return respond(request);
      },
    }),
  );
  db = await mf.getD1Database('DB');
  for (const file of (await readdir(new URL('../migrations/', import.meta.url)))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const migration = await readFile(
      new URL(`../migrations/${file}`, import.meta.url),
      'utf8',
    );
    for (const sql of migration
      .split(';')
      .filter((statement) => statement.trim()))
      await db.prepare(sql).run();
  }
});
afterEach(async () => {
  await db.batch(
    [
      'DELETE FROM page_results',
      'DELETE FROM scans',
      'DELETE FROM visitors',
      'DELETE FROM crawl_daily_budget',
      'DELETE FROM crawl_origin_gates',
    ].map((sql) => db.prepare(sql)),
  );
  pending.length = 0;
  requests.length = 0;
  respond = () => new Response('Not found', { status: 404 });
});
after(async () => {
  await mf?.dispose();
});

async function call(body) {
  return mf.dispatchFetch('https://vizlinx.com/', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
async function create(sites = [site]) {
  const id = crypto.randomUUID();
  await db
    .prepare(
      'INSERT OR IGNORE INTO visitors (token_hash, expires_at) VALUES (?, ?)',
    )
    .bind('fixture', Date.now() + 86_400_000)
    .run();
  await db
    .prepare(
      'INSERT INTO scans (id, owner_hash, sites_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(id, 'fixture', JSON.stringify(sites), Date.now(), Date.now())
    .run();
  return id;
}
async function start(id, generation) {
  const response = await call({ action: 'start', id, generation });
  assert.equal(response.status, 200, await response.clone().text());
}
async function next({ resetGate = true } = {}) {
  const queued = pending.shift();
  assert.ok(queued, 'A continuation must be queued');
  if (resetGate)
    await db.prepare('UPDATE crawl_origin_gates SET next_allowed_at = 0').run();
  const response = await call({ action: 'tick', body: queued.body });
  assert.deepEqual(await response.json(), ['ack']);
  return queued;
}
async function drain() {
  for (let count = 0; pending.length && count < 1000; count++) await next();
  assert.equal(
    pending.length,
    0,
    'The crawler must finish without an unbounded continuation loop',
  );
}
async function scan(id) {
  return db.prepare('SELECT * FROM scans WHERE id = ?').bind(id).first();
}
async function pages(id) {
  return (
    await db
      .prepare(
        'SELECT result_json FROM page_results WHERE scan_id = ? ORDER BY source_url',
      )
      .bind(id)
      .all()
  ).results.map(({ result_json }) => JSON.parse(result_json));
}

async function events(id) {
  return (
    await db
      .prepare(
        'SELECT event_json FROM scan_events WHERE scan_id = ? ORDER BY id',
      )
      .bind(id)
      .all()
  ).results.map(({ event_json }) => JSON.parse(event_json));
}

test('a large site stops at exactly 100 pages and a restart or duplicate cannot fetch page 101', async () => {
  respond = (request) =>
    new URL(request.url).pathname === '/robots.txt'
      ? new Response('', { status: 404 })
      : html(Array.from({ length: 150 }, (_, index) => `/page-${index}`));
  const id = await create();
  await start(id);
  const first = { ...pending[0].body };
  await drain();
  assert.equal((await pages(id)).length, 100);
  assert.equal(
    requests.length,
    101,
    'The robots request also consumes the daily budget',
  );
  assert.equal(new Set(requests.map((request) => request.url)).size, 101);
  assert.equal((await scan(id)).status, 'limited');
  assert.equal((await scan(id)).limit_reason, 'page_limit');
  assert.equal(JSON.parse((await scan(id)).activity_json).phase, 'limited');
  assert.equal(
    (await events(id)).filter((event) => event.type === 'page_finished').length,
    100,
  );
  assert.equal((await events(id)).at(-1).type, 'scan_limited');
  await call({ action: 'tick', body: first });
  await start(id);
  await drain();
  assert.equal(requests.length, 101, 'Completed page slots survive a restart');
  assert.equal(
    (await db.prepare('SELECT request_count FROM crawl_daily_budget').first())
      .request_count,
    101,
  );
});

test('small sites complete, public exact-origin links are followed, and external redirects are never followed', async () => {
  respond = (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/robots.txt') return new Response('', { status: 404 });
    if (path === '/')
      return html([
        '/a',
        '/redirect',
        'https://outside.org/',
        'http://127.0.0.1/',
        'https://example.com:8080/private',
      ]);
    if (path === '/redirect')
      return new Response('', {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
      });
    return html();
  };
  const id = await create();
  await start(id);
  await drain();
  assert.equal((await scan(id)).status, 'completed');
  assert.equal((await scan(id)).limit_reason, null);
  assert.equal((await pages(id)).length, 3);
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl.endsWith('/redirect'))
      .status,
    'redirect_unresolved',
  );
  assert.ok(
    requests.every((request) => new URL(request.url).origin === origin),
  );
  assert.ok(
    requests.every((request) =>
      request.headers.get('User-Agent').startsWith('VizlinxBot/'),
    ),
  );
  assert.ok(
    requests.every(
      (request) =>
        !request.headers.has('Cookie') && !request.headers.has('Authorization'),
    ),
  );
});

test('same-origin redirect chains run one request per tick and parse links relative to the final URL', async () => {
  const paths = ['/', '/hop-1', '/hop-2', '/hop-3', '/hop-4', '/sk/'];
  const statuses = [301, 302, 303, 307, 308];
  respond = (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/robots.txt') return new Response('', { status: 404 });
    const index = paths.indexOf(path);
    if (index >= 0 && index < statuses.length)
      return new Response('', {
        status: statuses[index],
        headers: { Location: paths[index + 1] },
      });
    return path === '/sk/'
      ? html(['contact'], 'Final page')
      : html([], 'Contact');
  };
  const id = await create();
  await start(id);
  let ticks = 0;
  while (pending.length) {
    assert.ok(
      ++ticks <= 1000,
      'Redirect chain did not finish within 1000 ticks',
    );
    const count = requests.length;
    await next();
    assert.ok(requests.length - count <= 1);
  }
  assert.equal((await scan(id)).status, 'completed');
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    ['/robots.txt', ...paths, '/sk/contact'],
  );
  const results = await pages(id);
  assert.equal(
    results.find((result) => result.sourceUrl === `${origin}/sk/`).title,
    'Final page',
  );
  assert.equal(
    results.find((result) => result.sourceUrl === `${origin}/sk/`).links[0]
      .targetUrl,
    `${origin}/sk/contact`,
  );
  assert.equal(
    results.find((result) => result.sourceUrl === `${origin}/`).links.length,
    0,
  );
  const redirects = (await events(id)).filter((event) => event.redirect);
  assert.equal(redirects.length, 5);
  assert.ok(
    redirects.every(
      (event) =>
        event.redirect.kind === 'same_origin' && event.level === 'info',
    ),
  );
  assert.equal(redirects[0].redirect.targetUrl, `${origin}/hop-1`);
});

test('redirect targets respect robots, origin pacing, and URL deduplication', async () => {
  respond = (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/robots.txt')
      return new Response(
        'User-agent: *\nDisallow: /private\nCrawl-delay: 3\n',
      );
    return new Response('', { status: 302, headers: { Location: '/private' } });
  };
  const id = await create();
  await start(id);
  await drain();
  assert.equal(requests.length, 2);
  assert.equal(
    (await pages(id)).find((result) => result.sourceUrl.endsWith('/private'))
      .status,
    'robots_denied',
  );

  respond = (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/robots.txt') return new Response('', { status: 404 });
    return new Response('', {
      status: 302,
      headers: { Location: path === '/' ? '/back' : '/' },
    });
  };
  const loop = await create();
  await start(loop);
  await next();
  await next();
  const count = requests.length;
  await next({ resetGate: false });
  assert.equal(
    requests.length,
    count,
    'Redirect hops must retain the origin request interval',
  );
  assert.ok(pending[0].options.delaySeconds >= 1);
  await drain();
  assert.equal(
    (await pages(loop)).length,
    2,
    'A redirect loop must visit each URL only once',
  );
  assert.equal((await scan(loop)).status, 'completed');
});

test('external redirects are recorded but do not expand even an approved second origin on restart', async () => {
  const second = {
    ...site,
    origin: 'https://other.org',
    seedUrl: 'https://other.org/seed',
  };
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (url.origin === origin)
      return new Response('', {
        status: 302,
        headers: { Location: '//other.org/private' },
      });
    assert.equal(url.href, second.seedUrl);
    return html();
  };
  const id = await create([site, second]);
  await start(id);
  await drain();
  assert.deepEqual(
    (await pages(id)).find((result) => result.sourceUrl === site.seedUrl)
      .redirect,
    {
      kind: 'external',
      targetUrl: 'https://other.org/private',
    },
  );
  assert.equal(
    (await events(id)).find((event) => event.redirect).redirect.targetUrl,
    'https://other.org/private',
  );
  const count = requests.length;
  await start(id);
  await drain();
  assert.equal(requests.length, count);
  assert.equal(
    requests.some((request) => request.url === 'https://other.org/private'),
    false,
  );
});

test('redirect-only sites cannot exceed the 100 request page budget', async () => {
  respond = (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/robots.txt') return new Response('', { status: 404 });
    const index = path === '/' ? 0 : Number(path.slice(1));
    return new Response('', {
      status: 302,
      headers: { Location: `/${index + 1}` },
    });
  };
  const id = await create();
  await start(id);
  await drain();
  assert.equal(requests.length, 101);
  assert.equal((await pages(id)).length, 100);
  assert.equal((await scan(id)).limit_reason, 'page_limit');
});

test('robots uses VizlinxBot rules and preserves a crawl delay in its queue continuation', async () => {
  respond = (request) =>
    new URL(request.url).pathname === '/robots.txt'
      ? new Response(
          'User-agent: *\nAllow: /\n\nUser-agent: VizlinxBot\nDisallow: /private\nCrawl-delay: 3\n',
        )
      : html(['/private']);
  const id = await create();
  await start(id);
  await next();
  assert.ok(pending[0].options.delaySeconds >= 3);
  await drain();
  assert.equal(requests.length, 2);
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl.endsWith('/private'))
      .status,
    'robots_denied',
  );
});

test('HTTP 429 pauses only its origin, preserves pending URLs, and requires explicit unpause', async () => {
  const second = {
    ...site,
    origin: 'https://second.org',
    seedUrl: 'https://second.org/',
  };
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (url.origin === second.origin) return html();
    if (url.pathname === '/') return html(['/a-throttle', '/z-pending']);
    if (url.pathname === '/a-throttle')
      return new Response('', { status: 429 });
    return html();
  };
  const id = await create([site, second]);
  await start(id);
  await drain();
  const paused = await scan(id);
  assert.equal(paused.status, 'paused');
  assert.deepEqual(
    JSON.parse(paused.sites_json).map((site) => site.paused),
    [true, false],
  );
  assert.equal(
    requests.some((request) => request.url.endsWith('/z-pending')),
    false,
  );
  assert.ok(
    (await pages(id)).some((page) => page.sourceUrl === second.seedUrl),
  );
  assert.equal(
    (await pages(id)).find((page) => page.httpStatus === 429).status,
    'http_error',
  );
  const throttles = (await events(id)).filter(
    (event) => event.type === 'site_throttled',
  );
  assert.equal(throttles.length, 1);
  assert.equal(throttles[0].origin, origin);
  assert.equal(throttles[0].httpStatus, 429);
  const count = requests.length;
  await start(id);
  await drain();
  assert.equal(
    requests.length,
    count,
    'Restarting the map must not override a throttled origin pause',
  );
  await db
    .prepare('UPDATE scans SET sites_json = ? WHERE id = ?')
    .bind(JSON.stringify([site, second]), id)
    .run();
  await start(id);
  await drain();
  assert.equal((await scan(id)).status, 'completed');
  assert.equal(
    requests.filter((request) => request.url.endsWith('/z-pending')).length,
    1,
  );
  assert.equal(
    requests.filter((request) => request.url.endsWith('/a-throttle')).length,
    1,
  );
});

test('the global daily budget is atomic, includes robots, and cannot be bypassed by restarting', async () => {
  const day = Math.floor(Date.now() / 86_400_000);
  await db
    .prepare('INSERT INTO crawl_daily_budget VALUES (?, 9999)')
    .bind(day)
    .run();
  const ids = await Promise.all([create(), create()]);
  for (const id of ids) await start(id);
  await drain();
  assert.equal(requests.length, 1);
  assert.equal(
    (await db.prepare('SELECT request_count FROM crawl_daily_budget').first())
      .request_count,
    10000,
  );
  for (const id of ids) {
    assert.equal((await scan(id)).limit_reason, 'daily_limit');
    await db
      .prepare("UPDATE scans SET status = 'paused' WHERE id = ?")
      .bind(id)
      .run();
    assert.equal((await call({ action: 'start', id })).status, 429);
  }
});

for (const lateStatus of [200, 302, 429])
  test(`a revoked generation cannot write a late HTTP ${lateStatus} result or throttle the origin`, async () => {
    const started = Promise.withResolvers();
    const released = Promise.withResolvers();
    respond = async (request) => {
      if (new URL(request.url).pathname === '/robots.txt')
        return new Response('', { status: 404 });
      started.resolve();
      await released.promise;
      return lateStatus === 429
        ? new Response('', { status: 429 })
        : lateStatus === 302
          ? new Response('', { status: 302, headers: { Location: '/another' } })
          : html(['/another']);
    };
    const id = await create();
    await start(id);
    await next();
    const inFlight = next();
    await started.promise;
    assert.equal(
      JSON.parse((await scan(id)).activity_json).phase,
      'fetching_page',
    );
    const beforePauseEvents = await events(id);
    await db
      .prepare(
        "UPDATE scans SET status = 'paused', crawl_generation = crawl_generation + 1, crawl_lease_token = NULL, crawl_lease_until = NULL, crawl_enqueued_tick = -1, activity_json = ? WHERE id = ?",
      )
      .bind(
        JSON.stringify({
          phase: 'paused',
          updatedAt: new Date().toISOString(),
        }),
        id,
      )
      .run();
    released.resolve();
    await inFlight;
    assert.equal((await pages(id)).length, 0);
    assert.equal((await scan(id)).status, 'paused');
    assert.equal(JSON.parse((await scan(id)).activity_json).phase, 'paused');
    assert.equal(JSON.parse((await scan(id)).sites_json)[0].paused, false);
    assert.deepEqual(
      await events(id),
      beforePauseEvents,
      'Revoked generation must not log the late page result or completion',
    );
    respond = () => {
      throw new Error(
        'A page that was already attempted must not be fetched again',
      );
    };
    await start(id);
    await drain();
    assert.equal(requests.length, 2);
    assert.equal((await pages(id))[0].status, 'network_error');
  });

test('an expired run stops before network activity and its time limit survives control changes', async () => {
  const id = await create();
  await start(id);
  await db
    .prepare('UPDATE scans SET crawl_started_at = ? WHERE id = ?')
    .bind(Date.now() - 15 * 60_000 - 1, id)
    .run();
  await drain();
  assert.equal(requests.length, 0);
  assert.equal((await scan(id)).limit_reason, 'time_limit');
  await db
    .prepare("UPDATE scans SET status = 'waiting' WHERE id = ?")
    .bind(id)
    .run();
  assert.equal((await call({ action: 'start', id })).status, 429);
});

test('a stale start generation and the disabled crawler cannot create new work', async () => {
  const id = await create();
  assert.equal(
    (await call({ action: 'start', id, generation: 99 })).status,
    409,
  );
  assert.equal(
    (await call({ action: 'start', id, enabled: false })).status,
    503,
  );
  assert.equal(pending.length, 0);
  assert.equal(requests.length, 0);
});

test('a newly approved origin follows previously observed deep links without re-fetching the original site', async () => {
  const second = {
    ...site,
    origin: 'https://second.org',
    seedUrl: 'https://second.org/',
  };
  respond = (request) =>
    new URL(request.url).pathname === '/robots.txt'
      ? new Response('', { status: 404 })
      : new URL(request.url).origin === origin
        ? html(['https://second.org/deep'])
        : html();
  const id = await create();
  await start(id);
  await drain();
  assert.equal(requests.length, 2);
  await db
    .prepare(
      "UPDATE scans SET sites_json = ?, status = 'paused', crawl_generation = crawl_generation + 1, crawl_enqueued_tick = -1 WHERE id = ?",
    )
    .bind(JSON.stringify([site, second]), id)
    .run();
  await start(id);
  await drain();
  assert.equal((await pages(id)).length, 3);
  assert.equal(
    requests.filter((request) => new URL(request.url).origin === origin).length,
    2,
  );
  assert.ok(
    requests.some((request) => request.url === 'https://second.org/deep'),
  );
});

test('a full origin does not stop a second approved origin', async () => {
  const second = {
    ...site,
    origin: 'https://second.org',
    seedUrl: 'https://second.org/',
  };
  respond = (request) =>
    new URL(request.url).pathname === '/robots.txt'
      ? new Response('', { status: 404 })
      : new URL(request.url).origin === origin
        ? html(Array.from({ length: 110 }, (_, index) => `/page-${index}`))
        : html(['/deep']);
  const id = await create([site, second]);
  await start(id);
  await drain();
  const results = await pages(id);
  assert.equal(
    results.filter((result) => new URL(result.sourceUrl).origin === origin)
      .length,
    100,
  );
  assert.equal(
    results.filter(
      (result) => new URL(result.sourceUrl).origin === second.origin,
    ).length,
    2,
  );
  assert.equal((await scan(id)).limit_reason, 'page_limit');
});

test('concurrent duplicate messages share a lease and issue only one robots request', async () => {
  const reached = Promise.withResolvers();
  const released = Promise.withResolvers();
  respond = async () => {
    reached.resolve();
    await released.promise;
    return new Response('', { status: 404 });
  };
  const id = await create();
  await start(id);
  await start(id);
  assert.equal(
    (await events(id)).filter((event) => event.type === 'scan_started').length,
    1,
  );
  const body = pending.shift().body;
  const first = call({ action: 'tick', body });
  await reached.promise;
  assert.equal(
    JSON.parse((await scan(id)).activity_json).phase,
    'fetching_robots',
  );
  const duplicate = await call({ action: 'tick', body });
  const outcome = await duplicate.json();
  assert.ok(
    outcome.some((action) => typeof action === 'object' && action.retry),
  );
  assert.equal(requests.length, 1);
  released.resolve();
  await first;
  const activity = JSON.parse((await scan(id)).activity_json);
  assert.equal(activity.phase, 'waiting');
  assert.equal(activity.origin, origin);
  assert.ok(
    Date.parse(activity.nextRequestAt) > Date.parse(activity.updatedAt),
  );
  assert.equal(
    (await events(id)).filter((event) => event.type === 'robots_checked')
      .length,
    1,
  );
  respond = () => html();
  await drain();
  assert.equal(requests.length, 2);
  assert.equal((await pages(id)).length, 1);
});

test('the shared origin gate delays another scan without spending its daily network budget', async () => {
  const ids = await Promise.all([create(), create()]);
  for (const id of ids) await start(id);
  await next();
  await db
    .prepare('UPDATE crawl_origin_gates SET next_allowed_at = ?')
    .bind(Date.now() + 30_000)
    .run();
  await next({ resetGate: false });
  assert.equal(requests.length, 1);
  assert.ok(
    pending.some(
      (entry) =>
        entry.body.scanId === ids[1] && entry.options.delaySeconds >= 29,
    ),
  );
  assert.equal(
    (await db.prepare('SELECT request_count FROM crawl_daily_budget').first())
      .request_count,
    1,
  );
  await drain();
});

test('a lost queued checkpoint can be recovered without resetting the original run deadline', async () => {
  const id = await create();
  await start(id);
  const original = await scan(id);
  pending.length = 0;
  await db
    .prepare('UPDATE scans SET heartbeat_at = ? WHERE id = ?')
    .bind(Date.now() - 121_000, id)
    .run();
  await start(id);
  assert.equal(pending.length, 1);
  assert.equal((await scan(id)).crawl_started_at, original.crawl_started_at);
  await drain();
  assert.equal((await pages(id)).length, 1);
});

test('a full result-storage budget stops the run and cannot be bypassed by restarting', async () => {
  const id = await create();
  const result = {
    sourceUrl: `${origin}/saved`,
    title: '',
    status: 'ok',
    observedAt: new Date().toISOString(),
    httpStatus: 200,
    links: [],
    discoveredUrls: [],
    truncated: false,
  };
  await db
    .prepare(
      'INSERT INTO page_results (scan_id, source_url, source_origin, result_hash, result_json, result_bytes) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      id,
      result.sourceUrl,
      origin,
      'fixture',
      JSON.stringify(result),
      4 * 1024 * 1024,
    )
    .run();
  respond = (request) =>
    new URL(request.url).pathname === '/robots.txt'
      ? new Response('', { status: 404 })
      : html();
  await start(id);
  await drain();
  assert.equal((await pages(id)).length, 1);
  assert.equal((await scan(id)).limit_reason, 'scan_storage_limit');
  assert.equal((await call({ action: 'start', id })).status, 429);
});

test('a preparing scan cannot be queued or completed before its durable frontier is ready', async () => {
  const id = await create();
  await db
    .prepare(
      "UPDATE scans SET execution_mode = 'server', status = 'running', crawl_generation = 1, crawl_started_at = ?, heartbeat_at = ?, crawl_ready = 0 WHERE id = ?",
    )
    .bind(Date.now(), Date.now(), id)
    .run();
  assert.equal((await call({ action: 'start', id })).status, 409);
  await call({ action: 'tick', body: { scanId: id, generation: 1, tick: 0 } });
  assert.equal((await scan(id)).status, 'running');
  assert.equal(requests.length, 0);
  assert.equal(pending.length, 0);
  // A crash during preparation remains recoverable without discarding the map.
  await db
    .prepare('UPDATE scans SET heartbeat_at = ? WHERE id = ?')
    .bind(Date.now() - 121_000, id)
    .run();
  await start(id);
  await drain();
  assert.equal((await scan(id)).status, 'completed');
  assert.equal((await pages(id)).length, 1);
});

test('revoking the generation during robots fetching preserves paused activity and excludes a late robots log', async () => {
  const reached = Promise.withResolvers();
  const released = Promise.withResolvers();
  respond = async () => {
    reached.resolve();
    await released.promise;
    return new Response('User-agent: *\nDisallow: /secret', { status: 200 });
  };
  const id = await create();
  await start(id);
  const inFlight = next();
  await reached.promise;
  await db
    .prepare(
      "UPDATE scans SET status = 'paused', crawl_generation = crawl_generation + 1, activity_json = ? WHERE id = ?",
    )
    .bind(
      JSON.stringify({ phase: 'paused', updatedAt: new Date().toISOString() }),
      id,
    )
    .run();
  released.resolve();
  await inFlight;
  assert.deepEqual(
    (await events(id)).map((event) => event.type),
    ['scan_started'],
  );
  assert.equal(JSON.parse((await scan(id)).activity_json).phase, 'paused');
  assert.equal(pending.length, 0);
});

test('a failed initial queue delivery records a safe error and remains resumable', async () => {
  const id = await create();
  assert.equal(
    (await call({ action: 'start', id, failQueue: true })).status,
    500,
  );
  assert.equal((await scan(id)).status, 'error');
  assert.equal(JSON.parse((await scan(id)).activity_json).phase, 'error');
  assert.deepEqual(
    (await events(id)).map((event) => event.type),
    ['scan_started', 'scan_error'],
  );
  assert.ok(!JSON.stringify(await events(id)).includes('private diagnostic'));
  await start(id);
  await drain();
  assert.equal((await scan(id)).status, 'completed');
  assert.equal(JSON.parse((await scan(id)).activity_json).phase, 'completed');
  assert.equal((await events(id)).at(-1).type, 'scan_completed');
});
