import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf;
let db;
const pending = [];
const requests = [];
const claimGates = new Map();
let respond = () => new Response('Not found', { status: 404 });
const origin = 'https://example.com';
const site = {
  origin,
  seedUrl: `${origin}/`,
  maxPages: 1000,
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
      contents: `import { startServerScan, consumeCrawlBatch, enqueueManualPage } from './worker/crawler.ts';
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
          const gatedDatabase = input.claimGate ? {
            batch: (...args) => database.batch(...args),
            prepare(sql) {
              const statement = database.prepare(sql);
              if (!sql.startsWith("UPDATE crawl_frontier SET state = 'attempted'")) return statement;
              return { bind(...parameters) {
                const bound = statement.bind(...parameters);
                return { async first(...args) {
                  await env.CLAIM_GATE.fetch('https://gate.invalid/' + input.claimGate);
                  return bound.first(...args);
                } };
              } };
            },
          } : database;
          const bound = { ...env, DB: gatedDatabase, CRAWL_QUEUE: queue, CRAWLER_ENABLED: input.enabled === false ? 'false' : 'true' };
          if (input.action === 'start') {
            try { await startServerScan(bound, input.id, input.generation); return Response.json({ ok: true, maxSqlStringBytes }); }
            catch (error) { return Response.json({ error: error.message }, { status: error.status ?? 500 }); }
          }
          if (input.action === 'manual') {
            try { await enqueueManualPage(bound, input.id, input.url, input.generation); return Response.json({ ok: true }); }
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
        CLAIM_GATE: async (request) => {
          const gate = claimGates.get(new URL(request.url).pathname.slice(1));
          gate.arrived.resolve();
          await gate.released.promise;
          return new Response('released');
        },
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
  claimGates.clear();
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
async function next({
  resetGate = true,
  claimGate,
  enforceSqlStringLimit = false,
} = {}) {
  const queued = pending.shift();
  assert.ok(queued, 'A continuation must be queued');
  if (resetGate)
    await db.prepare('UPDATE crawl_origin_gates SET next_allowed_at = 0').run();
  const response = await call({
    action: 'tick',
    body: queued.body,
    claimGate,
    enforceSqlStringLimit,
  });
  assert.deepEqual(await response.json(), ['ack']);
  return queued;
}
async function drain() {
  for (let count = 0; pending.length && count < 5000; count++) await next();
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

test('a large site stops at exactly 1000 pages and a restart or duplicate cannot fetch page 1001', async () => {
  respond = (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/robots.txt') return new Response('', { status: 404 });
    const index = path === '/' ? 0 : Number(path.slice('/page-'.length));
    return html([`/page-${index + 1}`]);
  };
  const id = await create();
  await start(id);
  const first = { ...pending[0].body };
  await drain();
  assert.equal((await pages(id)).length, 1000);
  assert.equal(
    requests.length,
    1001,
    'The robots request also consumes the daily budget',
  );
  assert.equal(new Set(requests.map((request) => request.url)).size, 1001);
  assert.equal((await scan(id)).status, 'limited');
  assert.equal((await scan(id)).limit_reason, 'page_limit');
  assert.equal(JSON.parse((await scan(id)).activity_json).phase, 'limited');
  assert.equal((await events(id)).length, 500);
  assert.equal((await scan(id)).scan_log_truncated, 1);
  assert.equal((await events(id)).at(-1).type, 'scan_limited');
  await call({ action: 'tick', body: first });
  await start(id);
  await drain();
  assert.equal(requests.length, 1001, 'Completed page slots survive a restart');
  assert.equal(
    (await db.prepare('SELECT request_count FROM crawl_daily_budget').first())
      .request_count,
    1001,
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

test('protocol/www redirect-only sites share the 1000 request page budget', async () => {
  respond = (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/robots.txt') return new Response('', { status: 404 });
    const index = path === '/' ? 0 : Number(path.slice(1));
    return new Response('', {
      status: 302,
      headers: {
        Location: `${index % 2 ? origin : 'http://www.example.com'}/${index + 1}`,
      },
    });
  };
  const id = await create();
  await start(id);
  await drain();
  assert.equal(requests.length, 1002);
  assert.equal((await pages(id)).length, 1000);
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
    .bind(Date.now() - 4 * 60 * 60_000 - 1, id)
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
        ? html([
            `/page-${new URL(request.url).pathname === '/' ? 1 : Number(new URL(request.url).pathname.slice('/page-'.length)) + 1}`,
          ])
        : html(['/deep']);
  const id = await create([site, second]);
  await start(id);
  await drain();
  const results = await pages(id);
  assert.equal(
    results.filter((result) => new URL(result.sourceUrl).origin === origin)
      .length,
    1000,
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
  const known = new Set((await pages(id)).map((page) => page.sourceUrl));
  const manualTarget = targets.find((url) => !known.has(url));
  assert.equal((await manual(id, manualTarget)).status, 200);
  await drain();
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl === manualTarget).crawlMode,
    'manual',
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
        .bind(Date.now() - 4 * 60 * 60_000 - 1, id)
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

async function manual(id, url, generation) {
  return call({
    action: 'manual',
    id,
    url,
    generation: generation ?? (await scan(id)).crawl_generation,
  });
}

async function savePage(id, result) {
  const serialized = JSON.stringify(result);
  await db
    .prepare(
      'INSERT INTO page_results (scan_id, source_url, source_origin, result_hash, result_json, result_bytes) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      id,
      result.sourceUrl,
      new URL(result.sourceUrl).origin,
      'fixture',
      serialized,
      new TextEncoder().encode(serialized).byteLength,
    )
    .run();
}

const savedPage = (sourceUrl, discoveredUrls = [], crawlMode) => ({
  sourceUrl,
  title: 'Saved fixture',
  observedAt: new Date().toISOString(),
  status: 'ok',
  httpStatus: 200,
  links: [],
  discoveredUrls,
  truncated: false,
  ...(crawlMode ? { crawlMode } : {}),
});

test('manual pages extend a three-site map without recursively following their links, including on resume', async () => {
  const sites = [
    site,
    ...['https://second.org', 'https://third.org'].map((origin) => ({
      ...site,
      origin,
      seedUrl: `${origin}/`,
    })),
  ];
  const landing = 'https://partner.org/landing';
  const target = 'https://fourth.org/manual';
  const scopedTarget = `${origin}/manual-backlink`;
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (url.href === site.seedUrl) return html([landing]);
    if (sites.some((site) => site.seedUrl === url.href)) return html();
    if (url.href === landing) return html([target, scopedTarget]);
    if ([target, scopedTarget].includes(url.href))
      return html(['/never-follow', 'https://fifth.org/never-follow']);
    assert.fail(`Manual page links must remain unvisited: ${url.href}`);
  };
  const id = await create(sites);
  await start(id);
  await drain();
  for (const url of [target, scopedTarget]) {
    const response = await manual(id, `${url}#fragment`);
    assert.equal(response.status, 200, await response.clone().text());
    const repeated = await manual(id, url);
    assert.equal(repeated.status, 200, await repeated.clone().text());
    await drain();
    const result = (await pages(id)).find((page) => page.sourceUrl === url);
    assert.equal(result.crawlMode, 'manual');
    assert.equal(result.links.length, 2);
    assert.equal(requests.filter((request) => request.url === url).length, 1);
    assert.ok(
      (await events(id)).some(
        (event) =>
          event.type === 'page_finished' &&
          event.url === url &&
          event.crawlMode === 'manual',
      ),
    );
  }
  assert.equal(JSON.parse((await scan(id)).sites_json).length, 3);
  const count = requests.length;
  assert.equal((await manual(id, target)).status, 200);
  await start(id);
  await drain();
  assert.equal(
    requests.length,
    count,
    'Completed manual pages must retain their one-page scope after resume',
  );
});

test('a manual page can exceed the ten-page automatic preview cap for its origin', async () => {
  const targets = Array.from(
    { length: 11 },
    (_, index) => `https://partner.org/page-${index}`,
  );
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    return html(url.origin === origin ? targets : []);
  };
  const id = await create();
  await start(id);
  await drain();
  assert.equal(
    (await pages(id)).filter((page) => page.crawlMode === 'preview').length,
    10,
  );
  const existing = new Set((await pages(id)).map((page) => page.sourceUrl));
  const remaining = targets.find((url) => !existing.has(url));
  const response = await manual(id, remaining);
  assert.equal(response.status, 200, await response.clone().text());
  await drain();
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl === remaining).crawlMode,
    'manual',
  );
  assert.equal((await pages(id)).length, 12);
});

test('queued manual pages retain their scope when paused before fetching and resumed', async () => {
  const target = `${origin}/manual`;
  const id = await create();
  await savePage(id, savedPage(site.seedUrl, [target], 'manual'));
  await db
    .prepare(
      "UPDATE scans SET execution_mode = 'server', crawl_ready = 1, status = 'completed' WHERE id = ?",
    )
    .bind(id)
    .run();
  assert.equal((await manual(id, target)).status, 200);
  await db
    .prepare(
      "UPDATE scans SET status = 'paused', crawl_generation = crawl_generation + 1, crawl_enqueued_tick = -1 WHERE id = ?",
    )
    .bind(id)
    .run();
  await drain();
  respond = (request) =>
    new URL(request.url).pathname === '/robots.txt'
      ? new Response('', { status: 404 })
      : request.url === target
        ? html(['/never-follow'])
        : assert.fail(`Unexpected resumed request: ${request.url}`);
  await start(id);
  await drain();
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl === target).crawlMode,
    'manual',
  );
  assert.equal(requests.filter((request) => request.url === target).length, 1);
});

test('manual admission counts saved results from every mode and reserves the final site slot atomically', async () => {
  const id = await create();
  const targets = [`${origin}/last-slot-a`, `${origin}/last-slot-b`];
  await db
    .prepare(
      "UPDATE scans SET execution_mode = 'server', crawl_ready = 1, status = 'running' WHERE id = ?",
    )
    .bind(id)
    .run();
  const saved = Array.from({ length: 999 }, (_, index) =>
    savedPage(
      index === 0 ? site.seedUrl : `${origin}/saved-${index}`,
      index === 0 ? targets : [],
      index % 2 ? 'manual' : 'preview',
    ),
  );
  await db
    .prepare(
      `INSERT INTO page_results (scan_id, source_url, source_origin, result_hash, result_json, result_bytes)
    SELECT ?1, json_extract(value, '$.sourceUrl'), ?2, 'fixture', value, length(value) FROM json_each(?3)`,
    )
    .bind(id, origin, JSON.stringify(saved))
    .run();
  await db
    .prepare(
      "INSERT INTO crawl_frontier (scan_id, url, origin, state, is_manual, is_preview) SELECT scan_id, source_url, source_origin, 'done', json_extract(result_json, '$.crawlMode') = 'manual', json_extract(result_json, '$.crawlMode') = 'preview' FROM page_results WHERE scan_id = ?",
    )
    .bind(id)
    .run();
  const responses = await Promise.all(targets.map((url) => manual(id, url)));
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 429],
  );
  const accepted =
    targets[responses.findIndex((response) => response.status === 200)];
  respond = (request) =>
    new URL(request.url).pathname === '/robots.txt'
      ? new Response('', { status: 404 })
      : request.url === accepted
        ? html()
        : assert.fail(`The site cap must prevent this request: ${request.url}`);
  await drain();
  assert.equal((await pages(id)).length, 1000);
  const rejected = targets.find((url) => url !== accepted);
  assert.equal((await manual(id, rejected)).status, 429);
});

test('manual admission rejects unknown, private and stale URLs without fetching', async () => {
  const id = await create();
  const known = 'https://other.org/known';
  await savePage(
    id,
    savedPage(site.seedUrl, [known, 'http://127.0.0.1/private']),
  );
  await db
    .prepare(
      "UPDATE scans SET execution_mode = 'server', crawl_ready = 1, status = 'completed' WHERE id = ?",
    )
    .bind(id)
    .run();
  for (const url of [
    'https://unknown.org/',
    'http://127.0.0.1/private',
    'https://example.com:8080/private',
    'not a URL',
  ]) {
    assert.equal((await manual(id, url)).status, 400);
  }
  assert.equal((await manual(id, known, 999)).status, 409);
  assert.equal(requests.length, 0);
  assert.equal(pending.length, 0);
});

for (const reason of ['time_limit', 'scan_storage_limit', 'daily_limit']) {
  test(`manual admission cannot bypass a ${reason}`, async () => {
    const id = await create();
    const known = 'https://other.org/known';
    await savePage(id, savedPage(site.seedUrl, [known]));
    await db
      .prepare(
        "UPDATE scans SET execution_mode = 'server', crawl_ready = 1, status = 'limited', limit_reason = ? WHERE id = ?",
      )
      .bind(reason, id)
      .run();
    if (reason === 'daily_limit') {
      await db
        .prepare('INSERT INTO crawl_daily_budget VALUES (?, 10000)')
        .bind(Math.floor(Date.now() / 86_400_000))
        .run();
    }
    assert.equal((await manual(id, known)).status, 429);
    assert.equal(pending.length, 0);
    assert.equal(requests.length, 0);
  });
}

test('manual admission preserves an in-flight automatic page and prioritizes the selected pending page', async () => {
  const arrived = Promise.withResolvers();
  const released = Promise.withResolvers();
  const target = `${origin}/z-manual`;
  respond = async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (url.pathname === '/')
      return html(['/a-current', '/b-automatic', target]);
    if (url.pathname === '/a-current') {
      arrived.resolve();
      await released.promise;
      return html();
    }
    if (url.href === target) return html(['/manual-child']);
    if (url.pathname === '/b-automatic') return html();
    assert.fail(`Unexpected recursive manual request: ${url.href}`);
  };
  const id = await create();
  await start(id);
  await next();
  await next();
  const inFlight = next();
  await arrived.promise;
  try {
    const before = await scan(id);
    assert.equal((await manual(id, `${origin}/a-current`)).status, 200);
    const response = await manual(id, target);
    assert.equal(response.status, 200, await response.clone().text());
    const after = await scan(id);
    assert.equal(after.crawl_generation, before.crawl_generation);
    assert.equal(after.crawl_lease_token, before.crawl_lease_token);
  } finally {
    released.resolve();
  }
  await inFlight;
  await drain();
  assert.deepEqual(
    requests
      .filter((request) => !request.url.endsWith('/robots.txt'))
      .map((request) => new URL(request.url).pathname),
    ['/', '/a-current', '/z-manual', '/b-automatic'],
  );
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl.endsWith('/a-current'))
      .status,
    'ok',
  );
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl === target).crawlMode,
    'manual',
  );
});

test('manual pages respect robots and cannot resume an externally throttled origin', async () => {
  const landing = 'https://partner.org/landing';
  const target = 'https://partner.org/manual';
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('User-agent: *\nDisallow: /denied\n');
    if (url.href === site.seedUrl) return html([landing]);
    if (url.href === landing)
      return html([target, '/denied', '/after-throttle']);
    if (url.href === target) return new Response('', { status: 429 });
    assert.fail(`Forbidden manual network request: ${url.href}`);
  };
  const id = await create();
  await start(id);
  await drain();
  assert.equal((await manual(id, 'https://partner.org/denied')).status, 200);
  await drain();
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl.endsWith('/denied')).status,
    'robots_denied',
  );
  assert.equal((await manual(id, target)).status, 200);
  await drain();
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl === target).httpStatus,
    429,
  );
  assert.equal(
    (await manual(id, 'https://partner.org/after-throttle')).status,
    429,
  );
});

test('disabling the crawler pauses queued manual work and preserves it for resume', async () => {
  const id = await create();
  const target = 'https://partner.org/manual';
  await savePage(id, savedPage(site.seedUrl, [target], 'manual'));
  await db
    .prepare(
      "UPDATE scans SET execution_mode = 'server', crawl_ready = 1, status = 'completed' WHERE id = ?",
    )
    .bind(id)
    .run();
  assert.equal(
    (
      await call({
        action: 'manual',
        id,
        url: target,
        generation: 0,
        enabled: false,
      })
    ).status,
    503,
  );
  assert.equal(pending.length, 0);
  assert.equal((await manual(id, target)).status, 200);
  const queued = pending.shift();
  const response = await call({
    action: 'tick',
    body: queued.body,
    enabled: false,
  });
  assert.deepEqual(await response.json(), ['ack']);
  assert.equal(requests.length, 0);
  assert.equal((await scan(id)).status, 'paused');
  respond = (request) =>
    new URL(request.url).pathname === '/robots.txt'
      ? new Response('', { status: 404 })
      : request.url === target
        ? html()
        : assert.fail(`Unexpected resumed request: ${request.url}`);
  await start(id);
  await drain();
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl === target).crawlMode,
    'manual',
  );
});

for (const samePage of [true, false]) {
  test(
    `manual admission during an automatic claim ${samePage ? 'preserves the selected page mode' : 'reserves the last slot before any automatic fetch'}`,
    { timeout: 60_000 },
    async () => {
      const id = await create();
      await start(id);
      const automatic = `${origin}/a-automatic`;
      const target = samePage ? automatic : `${origin}/z-manual`;
      const saved = Array.from({ length: samePage ? 1 : 999 }, (_, index) =>
        savedPage(
          index === 0 ? site.seedUrl : `${origin}/saved-${index}`,
          index === 0 ? [automatic, target] : [],
        ),
      );
      await db
        .prepare(
          `INSERT INTO page_results (scan_id, source_url, source_origin, result_hash, result_json, result_bytes)
      SELECT ?1, json_extract(value, '$.sourceUrl'), ?2, 'fixture', value, length(value) FROM json_each(?3)`,
        )
        .bind(id, origin, JSON.stringify(saved))
        .run();
      await db
        .prepare(
          "INSERT OR REPLACE INTO crawl_frontier (scan_id, url, origin, state) SELECT scan_id, source_url, source_origin, 'done' FROM page_results WHERE scan_id = ?",
        )
        .bind(id)
        .run();
      await db
        .prepare(
          'INSERT INTO crawl_frontier (scan_id, url, origin) VALUES (?, ?, ?)',
        )
        .bind(id, automatic, origin)
        .run();
      await db
        .prepare(
          "UPDATE crawl_robots SET state = 'done', policy_json = ? WHERE scan_id = ?",
        )
        .bind(JSON.stringify({ body: '', denied: false, delayMs: 0 }), id)
        .run();
      const gate = {
        arrived: Promise.withResolvers(),
        released: Promise.withResolvers(),
      };
      claimGates.set('manual-race', gate);
      respond = (request) =>
        request.url === target
          ? html(['/manual-child'])
          : assert.fail(
              `An automatic request must not consume the reserved manual slot: ${request.url}`,
            );
      const inFlight = next({ claimGate: 'manual-race' });
      await gate.arrived.promise;
      try {
        const response = await manual(id, target);
        assert.equal(response.status, 200, await response.clone().text());
      } finally {
        gate.released.resolve();
      }
      await inFlight;
      await drain();
      assert.equal((await pages(id)).length, samePage ? 2 : 1000);
      assert.equal(
        (await pages(id)).find((page) => page.sourceUrl === target).crawlMode,
        'manual',
      );
      assert.deepEqual(
        requests.map((request) => request.url),
        [target],
      );
    },
  );
}

test('a discovered external redirect target can be manually scanned', async () => {
  const target = 'https://redirect-target.org/landing';
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (url.href === site.seedUrl)
      return new Response('', { status: 302, headers: { Location: target } });
    if (url.href === target) return html(['/do-not-follow']);
    assert.fail(`Redirect landing links must remain unvisited: ${url.href}`);
  };
  const id = await create();
  await start(id);
  await drain();
  assert.equal((await pages(id)).length, 1);
  assert.equal((await manual(id, target)).status, 200);
  await drain();
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl === target).crawlMode,
    'manual',
  );
  assert.equal((await pages(id)).length, 2);
});

test('a configured seed can be manually scanned before any result exists', async () => {
  const id = await create();
  await start(id);
  respond = (request) =>
    new URL(request.url).pathname === '/robots.txt'
      ? new Response('', { status: 404 })
      : request.url === site.seedUrl
        ? html(['/do-not-follow'])
        : assert.fail(
            `Manual seed links must remain unvisited: ${request.url}`,
          );
  assert.equal((await manual(id, site.seedUrl)).status, 200);
  await drain();
  assert.equal((await pages(id)).length, 1);
  assert.equal((await pages(id))[0].crawlMode, 'manual');
});

test('protocol and www redirects preserve one site owner, robots, exact URLs and history events', async () => {
  const original = 'http://example.com';
  const secure = 'https://example.com';
  const canonical = 'https://www.example.com';
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (url.origin === original)
      return new Response(null, {
        status: 301,
        headers: { Location: `${secure}/start` },
      });
    if (url.origin === secure)
      return new Response(null, {
        status: 308,
        headers: { Location: `${canonical}/folder/` },
      });
    if (url.pathname === '/folder/')
      return html(['child', `${original}/`, 'https://unrelated.org/landing']);
    return html();
  };
  const id = await create([
    { ...site, origin: original, seedUrl: `${original}/` },
  ]);
  await start(id);
  while (pending.length) {
    const before = requests.length;
    await next();
    assert.ok(
      requests.length - before <= 1,
      'Every hop is a separate queue tick',
    );
  }
  const results = await pages(id);
  assert.deepEqual(
    requests.slice(0, 7).map((request) => request.url),
    [
      `${original}/robots.txt`,
      `${original}/`,
      `${secure}/robots.txt`,
      `${secure}/start`,
      `${canonical}/robots.txt`,
      `${canonical}/folder/`,
      `${canonical}/folder/child`,
    ],
  );
  assert.equal(
    results.find((page) => page.sourceUrl === `${canonical}/folder/child`)
      .siteOrigin,
    original,
  );
  assert.ok(
    results
      .filter((page) => page.siteOrigin === original)
      .every((page) => !page.crawlMode),
  );
  const redirects = (await events(id)).filter((event) => event.redirect);
  assert.deepEqual(
    redirects.map((event) => [
      event.url,
      event.redirect.targetUrl,
      event.httpStatus,
      event.origin,
      event.level,
    ]),
    [
      [`${original}/`, `${secure}/start`, 301, original, 'info'],
      [`${secure}/start`, `${canonical}/folder/`, 308, original, 'info'],
    ],
  );
  const before = requests.length;
  await start(id);
  await drain();
  assert.equal(
    requests.length,
    before,
    'Resume must retain alias ownership and URL deduplication',
  );
});

test('redirected robots uses individual paced requests, keeps its original policy scope and logs each hop', async () => {
  const target = 'https://www.example.com/policies/bot.txt';
  respond = (request) => {
    if (request.url === `${origin}/robots.txt`)
      return new Response(null, { status: 302, headers: { Location: target } });
    if (request.url === target)
      return new Response(
        'User-agent: VizlinxBot\nDisallow: /private\nCrawl-delay: 4\n',
      );
    return html(['/private']);
  };
  const id = await create();
  await start(id);
  await next();
  assert.equal(requests.length, 1);
  await db
    .prepare(
      'INSERT INTO crawl_origin_gates (origin, next_allowed_at) VALUES (?, ?)',
    )
    .bind('https://www.example.com', Date.now() + 60_000)
    .run();
  await next({ resetGate: false });
  assert.equal(
    requests.length,
    1,
    'Redirect target must respect a gate shared with other scans',
  );
  await next();
  assert.equal(requests.length, 2);
  assert.ok(pending[0].options.delaySeconds >= 4);
  await next({ resetGate: false });
  assert.equal(
    requests.length,
    2,
    'Redirected policy crawl-delay applies to original page origin',
  );
  await drain();
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl.endsWith('/private'))
      .status,
    'robots_denied',
  );
  assert.deepEqual(
    requests.map((request) => request.url),
    [`${origin}/robots.txt`, target, `${origin}/`],
  );
  assert.equal(
    (await db.prepare('SELECT request_count FROM crawl_daily_budget').first())
      .request_count,
    3,
  );
  const robotsEvents = (await events(id)).filter(
    (event) => event.type === 'robots_checked',
  );
  assert.equal(robotsEvents[0].redirect.kind, 'site_variant');
  assert.equal(robotsEvents[0].redirect.targetUrl, target);
  assert.equal(robotsEvents[0].httpStatus, 302);
  assert.equal(robotsEvents[1].url, target);
  assert.equal(robotsEvents[1].httpStatus, 200);
  assert.equal(robotsEvents[1].status, 'ok');
});

test('www redirects like aitom.cz scan public pages while retaining robots path restrictions', async () => {
  const source = 'https://aitom.cz';
  const canonical = 'https://www.aitom.cz';
  const robots =
    'User-agent: *\nDisallow: /core/wp-admin/\nAllow: /core/wp-admin/admin-ajax.php\nDisallow: /app/uploads/wpo/wpo-plugins-tables-list.json\nDisallow: /?s=\nDisallow: /page/*/?s=\nDisallow: /search/\nDisallow: /*filterTax=\nDisallow: /*filterTerm\n\nUser-agent: User-Agent\nDisallow: /Amazonbot\n';
  respond = (request) => {
    const url = new URL(request.url);
    if (url.origin === source)
      return new Response(null, {
        status: 301,
        headers: { Location: `${canonical}${url.pathname}` },
      });
    if (url.pathname === '/robots.txt') return new Response(robots);
    return html(
      url.pathname === '/' ? ['/sluzby/', '/search/', '/core/wp-admin/'] : [],
    );
  };
  const id = await create([{ ...site, origin: source, seedUrl: `${source}/` }]);
  await start(id);
  await drain();
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      `${source}/robots.txt`,
      `${canonical}/robots.txt`,
      `${source}/`,
      `${canonical}/robots.txt`,
      `${canonical}/`,
      `${canonical}/sluzby/`,
    ],
  );
  const results = await pages(id);
  for (const path of ['/', '/sluzby/']) {
    const result = results.find(
      (page) => page.sourceUrl === `${canonical}${path}`,
    );
    assert.equal(result.status, 'ok');
    assert.equal(result.siteOrigin, source);
  }
  for (const path of ['/search/', '/core/wp-admin/'])
    assert.equal(
      results.find((page) => page.sourceUrl === `${canonical}${path}`).status,
      'robots_denied',
    );
  assert.equal((await scan(id)).status, 'completed');
  assert.ok(
    (await events(id))
      .filter((event) => event.type === 'robots_checked')
      .every((event) => event.level === 'info'),
  );
});

test('robots HTTP failures stop pages without claiming a Disallow rule and remain cached on resume', async () => {
  for (const status of [403, 429, 503]) {
    const before = requests.length;
    respond = () => new Response('Unavailable', { status });
    const id = await create();
    await start(id);
    await drain();
    assert.equal(requests.length - before, 1);
    const [result] = await pages(id);
    assert.equal(result.status, 'robots_unavailable');
    assert.equal(
      result.httpStatus,
      null,
      'The page itself was never requested',
    );
    assert.match(result.error, /could not be loaded/);
    assert.equal(
      (await events(id)).find((event) => event.type === 'page_finished').level,
      'error',
    );
    const entry = (await events(id)).find(
      (event) => event.type === 'robots_checked',
    );
    assert.equal(entry.status, 'robots_unavailable');
    assert.equal(entry.httpStatus, status);
    assert.equal(entry.level, 'error');
    await start(id);
    await drain();
    assert.equal(requests.length - before, 1);
  }
});

test('robots redirect loops, overlong chains and unrelated domains fail closed with an explicit log', async () => {
  for (const scenario of ['loop', 'limit', 'external']) {
    const before = requests.length;
    respond = (request) => {
      const path = new URL(request.url).pathname;
      const nextPath =
        path === '/robots.txt'
          ? '/policy-1'
          : `/policy-${Number(path.split('-')[1]) + 1}`;
      return new Response(null, {
        status: 307,
        headers: {
          Location:
            scenario === 'external'
              ? 'https://unrelated.org/robots.txt'
              : scenario === 'loop'
                ? '/robots.txt'
                : nextPath,
        },
      });
    };
    const id = await create();
    await start(id);
    await drain();
    assert.equal(requests.length - before, scenario === 'limit' ? 6 : 1);
    assert.equal((await pages(id))[0].status, 'robots_unavailable');
    const entry = (await events(id))
      .filter((event) => event.type === 'robots_checked')
      .at(-1);
    assert.equal(entry.level, 'error');
    assert.equal(entry.status, 'robots_unavailable');
    assert.equal(entry.httpStatus, 307);
    assert.equal(
      entry.redirect.kind,
      scenario === 'external' ? 'external' : 'invalid',
    );
    if (scenario !== 'external')
      assert.equal(
        entry.redirect.reason,
        scenario === 'loop' ? 'redirect_loop' : 'redirect_limit',
      );
  }
});

test('a page redirect checks target robots and shares pause and throttling with the original site', async () => {
  const target = 'https://www.example.com';
  let deny = true;
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response(
        url.origin === target && deny ? 'User-agent: *\nDisallow: /\n' : '',
        { status: 200 },
      );
    if (url.origin === origin)
      return new Response(null, {
        status: 301,
        headers: { Location: `${target}/` },
      });
    return new Response('Slow down', { status: 429 });
  };
  const denied = await create();
  await start(denied);
  await drain();
  assert.equal(
    requests.some((request) => request.url === `${target}/`),
    false,
  );
  assert.equal(
    (await pages(denied)).find((page) => page.sourceUrl === `${target}/`)
      .status,
    'robots_denied',
  );
  deny = false;
  const throttled = await create();
  await start(throttled);
  await next();
  await next();
  await db
    .prepare('UPDATE scans SET sites_json = ? WHERE id = ?')
    .bind(JSON.stringify([{ ...site, paused: true }]), throttled)
    .run();
  const before = requests.length;
  await drain();
  assert.equal(
    requests.length,
    before,
    'Pausing the owner stops pending alias pages and robots',
  );
  await db
    .prepare('UPDATE scans SET sites_json = ? WHERE id = ?')
    .bind(JSON.stringify([site]), throttled)
    .run();
  await start(throttled);
  await drain();
  assert.equal(JSON.parse((await scan(throttled)).sites_json)[0].paused, true);
  assert.equal(
    (await events(throttled)).find((event) => event.type === 'site_throttled')
      .origin,
    origin,
  );
});

test('preview variant redirects share the ten-URL cap and never expand HTML links', async () => {
  const partner = 'http://partner.org';
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (url.origin === origin) return html([`${partner}/0`]);
    const index = Number(url.pathname.slice(1));
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${index % 2 ? partner : 'https://www.partner.org'}/${index + 1}`,
      },
    });
  };
  const id = await create();
  await start(id);
  await drain();
  const previews = (await pages(id)).filter(
    (page) => page.crawlMode === 'preview',
  );
  assert.equal(previews.length, 10);
  assert.ok(
    previews.every(
      (page) => (page.siteOrigin ?? new URL(page.sourceUrl).origin) === partner,
    ),
  );
  assert.equal((await scan(id)).status, 'completed');
  const before = requests.length;
  await start(id);
  await drain();
  assert.equal(requests.length, before);
});

test('an observed redirect joins an already queued preview to its full site without freeing preview slots', async () => {
  const alias = 'https://www.example.com';
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (request.url === `${origin}/`)
      return html(['/redirect', `${alias}/landing`]);
    if (url.pathname === '/redirect')
      return new Response(null, {
        status: 301,
        headers: { Location: `${alias}/landing` },
      });
    if (url.pathname === '/landing') return html(['/internal']);
    return html();
  };
  const id = await create();
  await start(id);
  await drain();
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl === `${alias}/internal`)
      .siteOrigin,
    origin,
  );
  assert.equal(
    (await pages(id)).some((page) => page.crawlMode === 'preview'),
    false,
  );
  const reserved = await db
    .prepare(
      'SELECT origin, is_preview FROM crawl_frontier WHERE scan_id = ? AND url = ?',
    )
    .bind(id, `${alias}/landing`)
    .first();
  assert.deepEqual(reserved, { origin, is_preview: 1 });
});

test('joining a throttled preview to its full site preserves the pause until the user resumes it', async () => {
  const alias = 'https://www.example.com';
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (request.url === `${origin}/`)
      return html(['/redirect', `${alias}/rate`, `${alias}/next`]);
    if (url.pathname === '/redirect')
      return new Response(null, {
        status: 301,
        headers: { Location: `${alias}/next` },
      });
    if (url.pathname === '/rate')
      return new Response('Slow down', { status: 429 });
    return html();
  };
  const id = await create();
  await start(id);
  await next();
  await next();
  await db
    .prepare('UPDATE scans SET sites_json = ? WHERE id = ?')
    .bind(JSON.stringify([{ ...site, paused: true }]), id)
    .run();
  await drain();
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl === `${alias}/rate`)
      .httpStatus,
    429,
  );
  await db
    .prepare('UPDATE scans SET sites_json = ? WHERE id = ?')
    .bind(JSON.stringify([site]), id)
    .run();
  await start(id);
  await drain();
  assert.equal(
    requests.some((request) => request.url === `${alias}/next`),
    false,
  );
  assert.equal(JSON.parse((await scan(id)).sites_json)[0].paused, true);
  assert.ok(
    (await events(id)).some(
      (event) => event.type === 'site_throttled' && event.origin === origin,
    ),
  );
  await db
    .prepare('UPDATE scans SET sites_json = ? WHERE id = ?')
    .bind(JSON.stringify([site]), id)
    .run();
  await start(id);
  await drain();
  assert.equal(
    requests.filter((request) => request.url === `${alias}/next`).length,
    1,
  );
});

test('a redirect rejected by the storage budget cannot transfer ownership without a saved result', async () => {
  const alias = 'https://www.example.com';
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (url.pathname === '/') return html(['/redirect', `${alias}/target`]);
    return new Response(null, {
      status: 301,
      headers: { Location: `${alias}/target` },
    });
  };
  const id = await create();
  await start(id);
  await next();
  await next();
  await db
    .prepare('UPDATE page_results SET result_bytes = ? WHERE scan_id = ?')
    .bind(4 * 1024 * 1024, id)
    .run();
  await drain();
  assert.equal((await scan(id)).limit_reason, 'scan_storage_limit');
  assert.equal((await pages(id)).length, 1);
  assert.equal(
    (
      await db
        .prepare(
          'SELECT origin FROM crawl_frontier WHERE scan_id = ? AND url = ?',
        )
        .bind(id, `${alias}/target`)
        .first()
    ).origin,
    alias,
  );
  assert.equal(
    (await events(id)).some((event) => event.redirect),
    false,
  );
});

test('robots redirects survive pause checkpoints and cannot exceed the daily request budget', async () => {
  const target = `${origin}/policy`;
  respond = (request) =>
    request.url === `${origin}/robots.txt`
      ? new Response(null, { status: 301, headers: { Location: target } })
      : request.url === target
        ? new Response('User-agent: *\nAllow: /\n')
        : html();
  const id = await create();
  await start(id);
  await next();
  await db
    .prepare(
      "UPDATE scans SET status = 'paused', crawl_generation = crawl_generation + 1, crawl_lease_token = NULL WHERE id = ?",
    )
    .bind(id)
    .run();
  pending.length = 0;
  await start(id);
  await drain();
  assert.deepEqual(
    requests.map((request) => request.url),
    [`${origin}/robots.txt`, target, `${origin}/`],
  );
  const limited = await create();
  await db.prepare('UPDATE crawl_daily_budget SET request_count = 9999').run();
  const before = requests.length;
  await start(limited);
  await drain();
  assert.equal(requests.length, before + 1);
  assert.equal((await scan(limited)).limit_reason, 'daily_limit');
  assert.equal(
    (await events(limited)).filter((event) => event.redirect).length,
    1,
  );
});

test('joining an already completed preview expands its saved links without fetching it again', async () => {
  const alias = 'https://www.example.com';
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (request.url === `${origin}/`)
      return html(['/redirect', `${alias}/landing`]);
    if (url.pathname === '/redirect')
      return new Response(null, {
        status: 301,
        headers: { Location: `${alias}/landing` },
      });
    if (url.pathname === '/landing')
      return html(['/internal', 'https://third.org/reference']);
    return html();
  };
  const id = await create();
  await start(id);
  await next();
  await next();
  await db
    .prepare('UPDATE scans SET sites_json = ? WHERE id = ?')
    .bind(JSON.stringify([{ ...site, paused: true }]), id)
    .run();
  await drain();
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl === `${alias}/landing`)
      .crawlMode,
    'preview',
  );
  assert.equal(
    requests.some((request) => request.url === `${alias}/internal`),
    false,
  );
  await db
    .prepare('UPDATE scans SET sites_json = ? WHERE id = ?')
    .bind(JSON.stringify([site]), id)
    .run();
  await start(id);
  await drain();
  assert.equal(
    requests.filter((request) => request.url === `${alias}/landing`).length,
    1,
  );
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl === `${alias}/internal`)
      .siteOrigin,
    origin,
  );
  assert.equal(
    (await pages(id)).find(
      (page) => page.sourceUrl === 'https://third.org/reference',
    ).crawlMode,
    'preview',
  );
});

test('joining large saved previews bounds D1 URL parameters and preserves reserved slots', async () => {
  const alias = 'https://www.example.com';
  const id = await create();
  let aggregateBytes = 0;
  for (let index = 0; index < 10; index++) {
    const result = {
      sourceUrl: `${alias}/saved-${index}`,
      crawlMode: 'preview',
      title: 'Saved preview',
      observedAt: new Date().toISOString(),
      status: 'ok',
      httpStatus: 200,
      links: Array.from({ length: 70 }, (_, link) => ({
        targetUrl: `https://partner-${index}.org/${link}-${'x'.repeat(3000)}`,
        anchor: '',
        rel: [],
        region: 'content',
        occurrences: 1,
      })),
      discoveredUrls: [],
      truncated: false,
    };
    const json = JSON.stringify(result);
    assert.ok(Buffer.byteLength(json) < 256 * 1024);
    aggregateBytes += Buffer.byteLength(json);
    await db
      .prepare(
        'INSERT INTO page_results (scan_id, source_url, source_origin, result_hash, result_json, result_bytes) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        id,
        result.sourceUrl,
        alias,
        'fixture',
        json,
        Buffer.byteLength(json),
      )
      .run();
  }
  assert.ok(aggregateBytes > 2_000_000);
  respond = (request) =>
    new URL(request.url).pathname === '/robots.txt'
      ? new Response('', { status: 404 })
      : new Response(null, {
          status: 301,
          headers: { Location: `${alias}/saved-0` },
        });
  await start(id);
  await next();
  await next({ enforceSqlStringLimit: true });
  assert.equal(
    (await pages(id)).length,
    11,
    'Redirect and ownership transfer must commit',
  );
  assert.equal(
    (
      await db
        .prepare(
          'SELECT origin FROM crawl_frontier WHERE scan_id = ? AND url = ?',
        )
        .bind(id, `${alias}/saved-0`)
        .first()
    ).origin,
    origin,
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
});

test('manual pages on a confirmed alias share their owner pause and preserve siteOrigin without expanding on restart', async () => {
  const alias = 'https://www.example.com';
  const partner = 'https://partner.org/landing';
  const target = `${alias}/manual`;
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (url.href === site.seedUrl)
      return new Response(null, {
        status: 301,
        headers: { Location: `${alias}/landing` },
      });
    if (url.href === `${alias}/landing`) return html([partner]);
    if (url.href === partner) return html([target]);
    if (url.href === target)
      return html(['/manual-child', 'https://third.org/manual-child']);
    assert.fail(`A manual alias page must not expand its links: ${url.href}`);
  };
  const id = await create();
  await start(id);
  await drain();
  await db
    .prepare('UPDATE scans SET sites_json = ? WHERE id = ?')
    .bind(JSON.stringify([{ ...site, paused: true }]), id)
    .run();
  const before = requests.length;
  assert.equal((await manual(id, target)).status, 409);
  assert.equal(requests.length, before);
  await db
    .prepare('UPDATE scans SET sites_json = ? WHERE id = ?')
    .bind(JSON.stringify([site]), id)
    .run();
  const response = await manual(id, target);
  assert.equal(response.status, 200, await response.clone().text());
  await drain();
  const result = (await pages(id)).find((page) => page.sourceUrl === target);
  assert.equal(result.crawlMode, 'manual');
  assert.equal(result.siteOrigin, origin);
  assert.equal(
    (await events(id)).find(
      (event) => event.type === 'page_finished' && event.url === target,
    ).origin,
    origin,
  );
  const completed = requests.length;
  await start(id);
  await drain();
  assert.equal(requests.length, completed);
  assert.deepEqual(
    (await pages(id)).find((page) => page.sourceUrl === target),
    result,
  );
});

test('manual alias admission shares the thousand-page owner budget with exact-origin results and reservations', async () => {
  const alias = 'https://www.example.com';
  const id = await create();
  const targets = [`${alias}/last-slot-a`, `${origin}/last-slot-b`];
  const saved = Array.from({ length: 999 }, (_, index) => ({
    ...savedPage(
      index === 0
        ? site.seedUrl
        : `${index % 2 ? alias : origin}/saved-${index}`,
      index === 0 ? targets : [],
      index % 2 ? 'manual' : 'preview',
    ),
    ...(index % 2 ? { siteOrigin: origin } : {}),
  }));
  await db
    .prepare(
      "UPDATE scans SET execution_mode = 'server', crawl_ready = 1, status = 'running' WHERE id = ?",
    )
    .bind(id)
    .run();
  await db
    .prepare(
      `INSERT INTO page_results (scan_id, source_url, source_origin, result_hash, result_json, result_bytes)
    SELECT ?1, json_extract(value, '$.sourceUrl'), CASE WHEN json_extract(value, '$.siteOrigin') IS NOT NULL THEN ?2 ELSE ?3 END, 'fixture', value, length(value) FROM json_each(?4)`,
    )
    .bind(id, alias, origin, JSON.stringify(saved))
    .run();
  await db
    .prepare(
      `INSERT INTO crawl_frontier (scan_id, url, origin, state, is_manual, is_preview)
    SELECT scan_id, source_url, ?2, 'done', json_extract(result_json, '$.crawlMode') = 'manual', json_extract(result_json, '$.crawlMode') = 'preview'
    FROM page_results WHERE scan_id = ?1`,
    )
    .bind(id, origin)
    .run();
  const responses = await Promise.all(targets.map((url) => manual(id, url)));
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 429],
  );
  const accepted =
    targets[responses.findIndex((response) => response.status === 200)];
  respond = (request) =>
    new URL(request.url).pathname === '/robots.txt'
      ? new Response('', { status: 404 })
      : request.url === accepted
        ? html()
        : assert.fail(
            `The alias must not bypass the owner budget: ${request.url}`,
          );
  await drain();
  assert.equal((await pages(id)).length, 1000);
  assert.equal(
    (
      await manual(
        id,
        targets.find((url) => url !== accepted),
      )
    ).status,
    429,
  );
});

test('promoting an already completed manual alias page preserves its one-page scope', async () => {
  const alias = 'https://www.example.com';
  const partner = 'https://partner.org/landing';
  const target = `${alias}/manual`;
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (url.href === site.seedUrl) return html(['/redirect', partner]);
    if (url.href === partner) return html([target]);
    if (url.href === target)
      return html(['/manual-child', 'https://third.org/manual-child']);
    if (url.href === `${origin}/redirect`)
      return new Response(null, { status: 301, headers: { Location: target } });
    assert.fail(`Promotion must not expand a saved manual page: ${url.href}`);
  };
  const id = await create();
  await start(id);
  await next();
  await next();
  await db
    .prepare('UPDATE scans SET sites_json = ? WHERE id = ?')
    .bind(JSON.stringify([{ ...site, paused: true }]), id)
    .run();
  await next();
  await next();
  assert.equal(
    (await pages(id)).find((page) => page.sourceUrl === partner).crawlMode,
    'preview',
  );
  assert.equal((await manual(id, target)).status, 200);
  await drain();
  const original = (await pages(id)).find((page) => page.sourceUrl === target);
  assert.equal(original.crawlMode, 'manual');
  await db
    .prepare('UPDATE scans SET sites_json = ? WHERE id = ?')
    .bind(JSON.stringify([site]), id)
    .run();
  await start(id);
  await drain();
  const promoted = (await pages(id)).find((page) => page.sourceUrl === target);
  assert.equal(promoted.crawlMode, 'manual');
  assert.deepEqual(
    promoted,
    original,
    'Promotion must preserve the observed result metadata',
  );
  assert.equal(
    (
      await db
        .prepare(
          'SELECT origin FROM crawl_frontier WHERE scan_id = ? AND url = ?',
        )
        .bind(id, target)
        .first()
    ).origin,
    origin,
  );
  assert.equal(requests.filter((request) => request.url === target).length, 1);
  const before = requests.length;
  await start(id);
  await drain();
  assert.equal(requests.length, before);
});

test('a manual variant redirect requires another click and gives its target the original site owner', async () => {
  const partner = 'https://partner.org/landing';
  const redirect = `${origin}/manual-redirect`;
  const target = 'https://www.example.com/manual-target';
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt')
      return new Response('', { status: 404 });
    if (url.href === site.seedUrl) return html([partner]);
    if (url.href === partner) return html([redirect]);
    if (url.href === redirect)
      return new Response(null, { status: 301, headers: { Location: target } });
    if (url.href === target) return html(['/manual-child']);
    assert.fail(
      `A manual redirect or its target must not expand automatically: ${url.href}`,
    );
  };
  const id = await create();
  await start(id);
  await drain();
  assert.equal((await manual(id, redirect)).status, 200);
  await drain();
  const redirected = (await pages(id)).find(
    (page) => page.sourceUrl === redirect,
  );
  assert.equal(redirected.crawlMode, 'manual');
  assert.deepEqual(redirected.redirect, {
    kind: 'site_variant',
    targetUrl: target,
  });
  assert.equal(
    requests.some((request) => request.url === target),
    false,
  );
  const before = requests.length;
  await start(id);
  await drain();
  assert.equal(
    requests.length,
    before,
    'Restart must not follow a saved manual redirect',
  );
  await db
    .prepare('UPDATE scans SET sites_json = ? WHERE id = ?')
    .bind(JSON.stringify([{ ...site, paused: true }]), id)
    .run();
  assert.equal((await manual(id, target)).status, 409);
  await db
    .prepare('UPDATE scans SET sites_json = ? WHERE id = ?')
    .bind(JSON.stringify([site]), id)
    .run();
  assert.equal((await manual(id, target)).status, 200);
  await drain();
  const result = (await pages(id)).find((page) => page.sourceUrl === target);
  assert.equal(result.crawlMode, 'manual');
  assert.equal(result.siteOrigin, origin);
  assert.equal(requests.filter((request) => request.url === target).length, 1);
});

for (const priorManualRedirect of [false, true])
  test(`a redirect confirmation transfers concurrently admitted manual work${priorManualRedirect ? ' through an earlier manual redirect owner' : ''}`, async () => {
    const alias = 'https://www.example.com';
    const partner = 'https://partner.org/landing';
    const target = `${alias}/manual`;
    const previousOwner = 'http://example.com';
    const previousRedirect = `${previousOwner}/prior-manual-redirect`;
    const arrived = Promise.withResolvers();
    const released = Promise.withResolvers();
    respond = async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/robots.txt')
        return new Response('', { status: 404 });
      if (url.href === site.seedUrl) return html(['/redirect', partner]);
      if (url.href === partner) return html([target, previousRedirect]);
      if (url.href === previousRedirect)
        return new Response(null, {
          status: 301,
          headers: { Location: target },
        });
      if (url.href === `${origin}/redirect`) {
        arrived.resolve();
        await released.promise;
        return new Response(null, {
          status: 301,
          headers: { Location: `${alias}/canonical` },
        });
      }
      if (url.href === target) return html(['/manual-child']);
      if (url.href === `${alias}/canonical`) return html();
      assert.fail(`Unexpected redirect/manual race request: ${url.href}`);
    };
    const id = await create();
    await start(id);
    await next();
    await next();
    await db
      .prepare('UPDATE scans SET sites_json = ? WHERE id = ?')
      .bind(JSON.stringify([{ ...site, paused: true }]), id)
      .run();
    await next();
    await next();
    if (priorManualRedirect) {
      assert.equal((await manual(id, previousRedirect)).status, 200);
      await next();
      await next();
      assert.equal(
        (await pages(id)).find((page) => page.sourceUrl === previousRedirect)
          .crawlMode,
        'manual',
      );
      assert.equal(
        requests.some((request) => request.url === target),
        false,
      );
    }
    await db
      .prepare('UPDATE scans SET sites_json = ? WHERE id = ?')
      .bind(JSON.stringify([site]), id)
      .run();
    const inFlight = next();
    await arrived.promise;
    const frontierOwner = async () =>
      (
        await db
          .prepare(
            'SELECT origin FROM crawl_frontier WHERE scan_id = ? AND url = ?',
          )
          .bind(id, target)
          .first()
      ).origin;
    try {
      const response = await manual(id, target);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(
        await frontierOwner(),
        priorManualRedirect ? previousOwner : alias,
        'The new owner has not yet been confirmed',
      );
    } finally {
      released.resolve();
    }
    await inFlight;
    assert.equal(
      await frontierOwner(),
      origin,
      'The redirect transaction must transfer concurrently admitted manual work',
    );
    await drain();
    const result = (await pages(id)).find((page) => page.sourceUrl === target);
    assert.equal(result.crawlMode, 'manual');
    assert.equal(result.siteOrigin, origin);
    assert.equal(
      requests.filter((request) => request.url === target).length,
      1,
    );
  });
