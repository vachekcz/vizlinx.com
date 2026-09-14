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
          let maxSqlStringBytes = 0;
          const database = input.enforceSqlStringLimit ? {
            batch: (...args) => env.DB.batch(...args),
            prepare(sql) {
              const statement = env.DB.prepare(sql);
              if (!sql.includes('json_each')) return statement;
              return { bind(...parameters) {
                for (const value of parameters) {
                  if (typeof value !== 'string') continue;
                  const bytes = new TextEncoder().encode(value).byteLength;
                  maxSqlStringBytes = Math.max(maxSqlStringBytes, bytes);
                  if (bytes > 2_000_000) throw new Error('SQL string parameter exceeds the D1 byte limit.');
                }
                return statement.bind(...parameters);
              } };
            },
          } : env.DB;
          const bound = { ...env, DB: database, CRAWL_QUEUE: queue, CRAWLER_ENABLED: input.enabled === false ? 'false' : 'true' };
          if (input.action === 'start') {
            try { await startServerScan(bound, input.id, input.generation); return Response.json({ ok: true, maxSqlStringBytes }); }
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
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/robots.txt') return new Response('', { status: 404 });
    if (url.origin === 'https://outside.org') return html();
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
  assert.equal((await pages(id)).length, 4);
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl.endsWith('/redirect'))
      .status,
    'redirect_unresolved',
  );
  assert.ok(
    requests.every((request) =>
      [origin, 'https://outside.org'].includes(new URL(request.url).origin),
    ),
  );
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl === 'https://outside.org/')
      .crawlMode,
    'preview',
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

test('a newly approved origin preserves preview results and follows their saved internal links without re-fetching', async () => {
  const second = {
    ...site,
    origin: 'https://second.org',
    seedUrl: 'https://second.org/',
  };
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (url.origin === origin) return html(['https://second.org/deep']);
    return url.pathname === '/deep' ? html(['/internal']) : html();
  };
  const id = await create();
  await start(id);
  await drain();
  assert.equal(requests.length, 4);
  const preview = (await pages(id)).find(
    (page) => page.sourceUrl === 'https://second.org/deep',
  );
  assert.equal(preview.crawlMode, 'preview');
  assert.equal(
    requests.some((request) => request.url.endsWith('/internal')),
    false,
  );
  await db
    .prepare(
      "UPDATE scans SET sites_json = ?, status = 'paused', crawl_generation = crawl_generation + 1, crawl_enqueued_tick = -1 WHERE id = ?",
    )
    .bind(JSON.stringify([site, second]), id)
    .run();
  await start(id);
  await drain();
  assert.equal((await pages(id)).length, 4);
  assert.equal(
    requests.filter((request) => new URL(request.url).origin === origin).length,
    2,
  );
  assert.ok(
    requests.some((request) => request.url === 'https://second.org/deep'),
  );
  assert.equal(
    requests.filter((request) => request.url === 'https://second.org/deep')
      .length,
    1,
  );
  assert.deepEqual(
    (await pages(id)).find((page) => page.sourceUrl === preview.sourceUrl),
    preview,
  );
  assert.equal(
    (await pages(id)).find(
      (page) => page.sourceUrl === 'https://second.org/internal',
    ).crawlMode,
    undefined,
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

test('landing previews save backlinks and other evidence without following any page links, including after restart', async () => {
  const landing = 'https://partner.org/product';
  const back = `${origin}/unvisited-contact`;
  const third = 'https://third.org/next';
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (url.href === site.seedUrl) return html([landing, `${landing}#details`]);
    if (url.href === landing) return html([back, '/internal', third]);
    assert.fail(
      `Preview links must not trigger a recursive fetch: ${url.href}`,
    );
  };
  const id = await create();
  await start(id);
  const firstTick = { ...pending[0].body };
  await drain();
  const results = await pages(id);
  assert.equal(results.length, 2);
  assert.equal(
    results.find((page) => page.sourceUrl === site.seedUrl).crawlMode,
    undefined,
  );
  const preview = results.find((page) => page.sourceUrl === landing);
  assert.equal(preview.crawlMode, 'preview');
  assert.deepEqual(
    preview.links.map((link) => link.targetUrl).sort(),
    [back, 'https://partner.org/internal', third].sort(),
  );
  assert.deepEqual(preview.discoveredUrls, ['https://partner.org/internal']);
  assert.equal((await scan(id)).status, 'completed');
  assert.equal(JSON.parse((await scan(id)).sites_json).length, 1);
  const count = requests.length;
  await call({ action: 'tick', body: firstTick });
  await start(id);
  await drain();
  assert.equal(requests.length, count);
  assert.deepEqual(await pages(id), results);
});

test('landing preview URLs are deduplicated and capped at ten per origin across pause and resume', async () => {
  const targets = Array.from(
    { length: 15 },
    (_, index) => `https://partner.org/page-${index}`,
  );
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (url.origin === origin)
      return html([
        '/second',
        ...targets,
        ...targets.map((target) => `${target}#duplicate`),
      ]);
    return html();
  };
  const id = await create();
  await start(id);
  for (
    let ticks = 0;
    ticks < 30 &&
    (await pages(id)).filter((page) => page.crawlMode === 'preview').length < 3;
    ticks++
  )
    await next();
  assert.equal(
    (await pages(id)).filter((page) => page.crawlMode === 'preview').length,
    3,
  );
  await db
    .prepare(
      "UPDATE scans SET status = 'paused', crawl_generation = crawl_generation + 1, crawl_enqueued_tick = -1, crawl_lease_token = NULL, crawl_lease_until = NULL WHERE id = ?",
    )
    .bind(id)
    .run();
  await drain();
  await start(id);
  await drain();
  const results = await pages(id);
  assert.equal(
    results.filter((page) => page.crawlMode === 'preview').length,
    10,
  );
  assert.equal(results.filter((page) => !page.crawlMode).length, 2);
  const previewRequests = requests.filter(
    (request) =>
      new URL(request.url).origin === 'https://partner.org' &&
      !request.url.endsWith('/robots.txt'),
  );
  assert.equal(previewRequests.length, 10);
  assert.equal(new Set(previewRequests.map((request) => request.url)).size, 10);
  assert.equal((await scan(id)).status, 'completed');
  const count = requests.length;
  await start(id);
  await drain();
  assert.equal(
    requests.length,
    count,
    'Resume must not admit the next ten URLs from the same origin',
  );
});

test('restoring a large saved map bounds preview URL parameters below D1 string limits while preserving one-hop caps', async () => {
  const id = await create();
  const targets = [];
  const saved = Array.from({ length: 12 }, (_, page) => {
    const links = Array.from({ length: 60 }, (_, link) => {
      const targetUrl = `https://partner-${page}.org/${link}-${'x'.repeat(3000)}`;
      targets.push(targetUrl);
      return {
        targetUrl,
        anchor: 'External',
        rel: [],
        region: 'content',
        occurrences: 1,
      };
    });
    return {
      sourceUrl: page === 0 ? site.seedUrl : `${origin}/saved-${page}`,
      title: 'Previously scanned page',
      observedAt: new Date().toISOString(),
      status: 'ok',
      httpStatus: 200,
      links,
      discoveredUrls: [],
      truncated: false,
    };
  });
  const aggregate = JSON.stringify(
    targets.map((url) => ({ url, origin: new URL(url).origin })),
  );
  assert.ok(
    Buffer.byteLength(aggregate) > 2_000_000,
    'The fixture must exceed one D1 string parameter',
  );
  let storedBytes = 0;
  for (const result of saved) {
    const json = JSON.stringify(result);
    const bytes = Buffer.byteLength(json);
    assert.ok(
      bytes <= 256 * 1024,
      'Every saved page respects its existing result-size limit',
    );
    storedBytes += bytes;
    await db
      .prepare(
        'INSERT INTO page_results (scan_id, source_url, source_origin, result_hash, result_json, result_bytes) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(id, result.sourceUrl, origin, 'fixture', json, bytes)
      .run();
  }
  assert.ok(
    storedBytes < 4 * 1024 * 1024,
    'The saved map remains within its total storage budget',
  );
  const allowed = new Set(targets);
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    assert.ok(
      allowed.has(url.href),
      `A saved full page or recursive preview link must not be fetched: ${url.href}`,
    );
    return html([`${origin}/unvisited-backlink`, 'https://unvisited.org/next']);
  };
  const restored = await call({
    action: 'start',
    id,
    enforceSqlStringLimit: true,
  });
  assert.equal(restored.status, 200, await restored.clone().text());
  const { maxSqlStringBytes } = await restored.json();
  assert.ok(
    maxSqlStringBytes > 0 && maxSqlStringBytes < 1024 * 1024,
    'Restoration must bind a bounded URL selection instead of the complete saved graph',
  );
  assert.equal(
    (
      await db
        .prepare(
          'SELECT COUNT(*) AS count FROM crawl_frontier WHERE scan_id = ? AND is_preview = 1',
        )
        .bind(id)
        .first()
    ).count,
    100,
  );
  await drain();
  const results = await pages(id);
  const previews = results.filter((page) => page.crawlMode === 'preview');
  assert.equal(previews.length, 100);
  assert.equal(results.filter((page) => !page.crawlMode).length, saved.length);
  assert.equal((await scan(id)).status, 'completed');
  const previewCounts = new Map();
  for (const result of previews) {
    const previewOrigin = new URL(result.sourceUrl).origin;
    previewCounts.set(
      previewOrigin,
      (previewCounts.get(previewOrigin) ?? 0) + 1,
    );
  }
  assert.ok([...previewCounts.values()].every((count) => count <= 10));
  const requestCount = requests.length;
  const resumed = await call({
    action: 'start',
    id,
    enforceSqlStringLimit: true,
  });
  assert.equal(resumed.status, 200, await resumed.clone().text());
  await drain();
  assert.equal(requests.length, requestCount);
  assert.deepEqual(await pages(id), results);
});

test('landing previews share a one-hundred-URL budget without consuming the full site page budget', async () => {
  const targets = Array.from({ length: 11 }, (_, host) =>
    Array.from(
      { length: 10 },
      (_, page) => `https://partner-${host}.org/page-${page}`,
    ),
  ).flat();
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    return url.origin === origin ? html(targets) : html();
  };
  const id = await create();
  await start(id);
  await drain();
  const results = await pages(id);
  assert.equal(
    results.filter((page) => page.crawlMode === 'preview').length,
    100,
  );
  assert.equal(results.filter((page) => !page.crawlMode).length, 1);
  assert.equal((await scan(id)).status, 'completed');
  assert.equal((await scan(id)).limit_reason, null);
  assert.equal(JSON.parse((await scan(id)).sites_json).length, 1);
  const count = requests.length;
  assert.equal(new Set(requests.map((request) => request.url)).size, count);
  await start(id);
  await drain();
  assert.equal(
    requests.length,
    count,
    'The global preview cap survives restarts',
  );
  const promotedOrigin = new URL(
    results.find((page) => page.crawlMode === 'preview').sourceUrl,
  ).origin;
  await db
    .prepare("UPDATE scans SET sites_json = ?, status = 'paused' WHERE id = ?")
    .bind(
      JSON.stringify([
        site,
        { ...site, origin: promotedOrigin, seedUrl: `${promotedOrigin}/` },
      ]),
      id,
    )
    .run();
  await start(id);
  await drain();
  assert.equal(
    requests.length,
    count + 1,
    'Promotion only fetches the new full-scan seed and cannot free preview capacity',
  );
  assert.equal(
    (await pages(id)).filter((page) => page.crawlMode === 'preview').length,
    100,
  );
});

test('landing previews retain robots crawl-delay before their first page request', async () => {
  const landing = 'https://partner.org/landing';
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response(
        url.origin === origin ? '' : 'User-agent: VizlinxBot\nCrawl-delay: 3\n',
      );
    return url.origin === origin ? html([landing]) : html();
  };
  const id = await create();
  await start(id);
  await next();
  await next();
  await next();
  assert.equal(requests.length, 3);
  assert.ok(pending[0].options.delaySeconds >= 3);
  await next({ resetGate: false });
  assert.equal(requests.length, 3);
  assert.ok(pending[0].options.delaySeconds >= 3);
  await drain();
  assert.equal(requests.filter((request) => request.url === landing).length, 1);
});

for (const limit of ['daily_limit', 'time_limit', 'scan_storage_limit'])
  test(`landing previews obey the shared ${limit} after full-scan results are saved`, async () => {
    const landing = 'https://partner.org/landing';
    respond = (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/robots.txt')
        return new Response('', { status: 404 });
      return url.origin === origin ? html([landing]) : html();
    };
    const id = await create();
    await start(id);
    await next();
    await next();
    assert.equal((await pages(id)).length, 1);
    if (limit === 'daily_limit')
      await db
        .prepare('UPDATE crawl_daily_budget SET request_count = 9999')
        .run();
    else if (limit === 'time_limit')
      await db
        .prepare('UPDATE scans SET crawl_started_at = ? WHERE id = ?')
        .bind(Date.now() - 15 * 60_000 - 1, id)
        .run();
    else
      await db
        .prepare('UPDATE page_results SET result_bytes = ? WHERE scan_id = ?')
        .bind(4 * 1024 * 1024, id)
        .run();
    await drain();
    assert.equal((await scan(id)).limit_reason, limit);
    assert.equal((await pages(id)).length, 1);
    if (limit === 'daily_limit') {
      assert.equal(
        requests.length,
        3,
        'Preview robots must consume the final daily request slot',
      );
      assert.equal(
        requests.some((request) => request.url === landing),
        false,
      );
    }
    if (limit === 'time_limit') assert.equal(requests.length, 2);
    const count = requests.length;
    assert.equal((await call({ action: 'start', id })).status, 429);
    assert.equal(requests.length, count);
  });

test('landing previews obey robots and retain HTTP errors while other origins continue', async () => {
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return url.origin === 'https://denied.org'
        ? new Response(
            'User-agent: VizlinxBot\nDisallow: /private\nCrawl-delay: 3\n',
          )
        : new Response('', { status: 404 });
    if (url.origin === origin)
      return html([
        '/second',
        'https://denied.org/private',
        'https://error.org/landing',
        'https://allowed.org/landing',
      ]);
    if (url.origin === 'https://error.org')
      return new Response('', { status: 503 });
    if (url.origin === 'https://allowed.org')
      return html([`${origin}/unvisited-backlink`]);
    assert.fail(`A disallowed page must never be fetched: ${url.href}`);
  };
  const id = await create();
  await start(id);
  await drain();
  const previews = (await pages(id)).filter(
    (page) => page.crawlMode === 'preview',
  );
  assert.equal(previews.length, 3);
  assert.equal(
    previews.find((page) => page.sourceUrl === 'https://denied.org/private')
      .status,
    'robots_denied',
  );
  assert.equal(
    previews.find((page) => page.sourceUrl === 'https://error.org/landing')
      .status,
    'http_error',
  );
  assert.equal(
    previews.find((page) => page.sourceUrl === 'https://allowed.org/landing')
      .status,
    'ok',
  );
  assert.equal(
    requests.some((request) => request.url === 'https://denied.org/private'),
    false,
  );
  assert.equal((await scan(id)).status, 'completed');
  assert.equal((await pages(id)).filter((page) => !page.crawlMode).length, 2);
});

test('HTTP 429 stops only its preview origin for the current run and resume cannot retry its pending URLs', async () => {
  let promoted = false;
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (url.origin === origin)
      return html([
        '/second',
        'https://throttled.org/a-throttle',
        'https://throttled.org/z-pending',
        'https://allowed.org/landing',
      ]);
    if (url.href === 'https://throttled.org/a-throttle')
      return new Response('', { status: 429 });
    if (url.origin === 'https://allowed.org') return html();
    if (url.origin === 'https://throttled.org' && promoted) return html();
    assert.fail(`A throttled preview must not continue: ${url.href}`);
  };
  const id = await create();
  await start(id);
  await drain();
  assert.equal((await scan(id)).status, 'completed');
  assert.equal(JSON.parse((await scan(id)).sites_json)[0].paused, false);
  assert.equal(
    (await pages(id)).find((page) => page.httpStatus === 429).crawlMode,
    'preview',
  );
  assert.ok(
    (await pages(id)).some(
      (page) => page.sourceUrl === 'https://allowed.org/landing',
    ),
  );
  assert.equal(
    (
      await db
        .prepare(
          'SELECT preview_throttled FROM crawl_robots WHERE scan_id = ? AND origin = ?',
        )
        .bind(id, 'https://throttled.org')
        .first()
    ).preview_throttled,
    1,
  );
  const count = requests.length;
  await start(id);
  await drain();
  assert.equal(requests.length, count);
  assert.equal(
    requests.some((request) => request.url.endsWith('/z-pending')),
    false,
  );
  promoted = true;
  await db
    .prepare("UPDATE scans SET sites_json = ?, status = 'paused' WHERE id = ?")
    .bind(
      JSON.stringify([
        site,
        {
          ...site,
          origin: 'https://throttled.org',
          seedUrl: 'https://throttled.org/',
        },
      ]),
      id,
    )
    .run();
  await start(id);
  await drain();
  assert.equal((await scan(id)).status, 'completed');
  assert.equal(
    (await pages(id)).find(
      (page) => page.sourceUrl === 'https://throttled.org/z-pending',
    ).crawlMode,
    undefined,
  );
  assert.equal(
    requests.filter(
      (request) => request.url === 'https://throttled.org/a-throttle',
    ).length,
    1,
  );
});

test('preview redirects follow only the same origin and every hop consumes the shared preview URL cap', async () => {
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (url.origin === origin)
      return html(['https://redirect.org/hop-0', 'https://external.org/start']);
    if (url.origin === 'https://external.org')
      return new Response('', {
        status: 302,
        headers: { Location: 'https://unvisited.org/landing' },
      });
    assert.equal(url.origin, 'https://redirect.org');
    const index = Number(url.pathname.replace('/hop-', ''));
    return new Response('', {
      status: 302,
      headers: { Location: `/hop-${index + 1}` },
    });
  };
  const id = await create();
  await start(id);
  await drain();
  const previews = (await pages(id)).filter(
    (page) => page.crawlMode === 'preview',
  );
  assert.equal(
    previews.filter(
      (page) => new URL(page.sourceUrl).origin === 'https://redirect.org',
    ).length,
    10,
  );
  assert.equal(
    requests.some((request) => request.url === 'https://redirect.org/hop-10'),
    false,
  );
  assert.equal(
    requests.some(
      (request) => new URL(request.url).origin === 'https://unvisited.org',
    ),
    false,
  );
  assert.deepEqual(
    previews.find((page) => page.sourceUrl === 'https://external.org/start')
      .redirect,
    { kind: 'external', targetUrl: 'https://unvisited.org/landing' },
  );
  assert.equal((await scan(id)).status, 'completed');
  const count = requests.length;
  await start(id);
  await drain();
  assert.equal(requests.length, count);
});

for (const lateStatus of [200, 429])
  test(`a revoked preview lease cannot persist its late HTTP ${lateStatus} result or throttle`, async () => {
    const started = Promise.withResolvers();
    const released = Promise.withResolvers();
    respond = async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/robots.txt')
        return new Response('', { status: 404 });
      if (url.origin === origin) return html(['https://partner.org/landing']);
      started.resolve();
      await released.promise;
      return lateStatus === 429
        ? new Response('', { status: 429 })
        : html([`${origin}/late-backlink`, '/late-internal']);
    };
    const id = await create();
    await start(id);
    await next();
    await next();
    await next();
    const inFlight = next();
    try {
      await started.promise;
      const saved = await pages(id);
      const savedEvents = await events(id);
      await db
        .prepare(
          "UPDATE scans SET status = 'paused', crawl_generation = crawl_generation + 1, crawl_lease_token = NULL, crawl_lease_until = NULL, crawl_enqueued_tick = -1 WHERE id = ?",
        )
        .bind(id)
        .run();
      released.resolve();
      await inFlight;
      assert.deepEqual(await pages(id), saved);
      assert.deepEqual(await events(id), savedEvents);
      assert.equal(
        (
          await db
            .prepare(
              'SELECT preview_throttled FROM crawl_robots WHERE scan_id = ? AND origin = ?',
            )
            .bind(id, 'https://partner.org')
            .first()
        ).preview_throttled,
        0,
      );
      assert.equal((await scan(id)).status, 'paused');
      const count = requests.length;
      await start(id);
      await drain();
      assert.equal(
        requests.length,
        count,
        'A reserved preview attempt must not be retried after lease revocation',
      );
      const interrupted = (await pages(id)).find(
        (page) => page.sourceUrl === 'https://partner.org/landing',
      );
      assert.equal(interrupted.crawlMode, 'preview');
      assert.equal(interrupted.status, 'network_error');
    } finally {
      released.resolve();
      await inFlight;
    }
  });
