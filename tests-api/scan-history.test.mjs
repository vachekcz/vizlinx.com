import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

describe('scan history', () => {
  let mf;
  let db;
  let migrationSnapshot;
  let outboundRequests = 0;
  let fixtureResponse;
  const queued = [];
  const base = 'https://vizlinx.com';
  const site = {
    origin: 'https://example.com',
    seedUrl: 'https://example.com/start/',
    intervalMs: 7000,
    maxPages: 100,
    paused: false,
  };
  const result = {
    sourceUrl: site.seedUrl,
    title: 'Previous content',
    observedAt: '2026-09-12T08:00:00.000Z',
    status: 'ok',
    httpStatus: 200,
    links: [],
    discoveredUrls: ['https://example.com/old-page'],
    truncated: false,
  };
  const event = {
    at: result.observedAt,
    type: 'page_finished',
    level: 'info',
    url: result.sourceUrl,
    httpStatus: 200,
    status: 'ok',
    linkCount: 0,
  };

  before(async () => {
    const output = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `import worker from './worker/index.ts';
        export default { async fetch(request, env) {
          const bound = { ...env, CRAWLER_ENABLED: request.headers.get('X-Test-Disabled') ? 'false' : 'true', ADMIN_EMAIL: '',
            CRAWL_QUEUE: { send: (body, options) => env.QUEUE_SPY.fetch('https://queue.invalid/', {
              method: 'POST', body: JSON.stringify({ body, options })
            }) }
          };
          if (new URL(request.url).pathname === '/test-consume') {
            const outcomes = [];
            await worker.queue({ queue: 'fixture', messages: [{ body: await request.json(), id: 'fixture',
              timestamp: new Date(), attempts: 1, ack() { outcomes.push('ack'); }, retry() { outcomes.push('retry'); }
            }], ackAll() {}, retryAll() {} }, bound);
            return Response.json(outcomes);
          }
          return worker.fetch(request, bound);
        } };`,
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
          QUEUE_SPY: async (request) => {
            queued.push(await request.json());
            return new Response('queued');
          },
        },
        outboundService: (request) => {
          if (fixtureResponse) return fixtureResponse(request);
          outboundRequests++;
          throw new Error(
            'Server network access is forbidden in history tests.',
          );
        },
      }),
    );
    db = await mf.getD1Database('DB');
    for (const file of (
      await readdir(new URL('../migrations/', import.meta.url))
    )
      .filter((file) => file.endsWith('.sql'))
      .sort()) {
      if (file.startsWith('0006')) {
        await db
          .prepare(
            'INSERT INTO visitors (token_hash, expires_at) VALUES (?, ?)',
          )
          .bind('legacy-owner', Date.now() + 86400000)
          .run();
        await db
          .prepare(
            'INSERT INTO scans (id, owner_hash, status, sites_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .bind(
            'legacy-map',
            'legacy-owner',
            'completed',
            JSON.stringify([site]),
            100,
            200,
          )
          .run();
      }
      const migration = await readFile(
        new URL(`../migrations/${file}`, import.meta.url),
        'utf8',
      );
      for (const sql of migration.split(';').filter((sql) => sql.trim()))
        await db.prepare(sql).run();
    }
    migrationSnapshot = await db
      .prepare('SELECT * FROM scans WHERE id = ?')
      .bind('legacy-map')
      .first();
  });
  afterEach(async () => {
    await db.batch(
      [
        'scans',
        'visitors',
        'creation_quotas',
        'crawl_daily_budget',
        'crawl_origin_gates',
      ].map((table) => db.prepare(`DELETE FROM ${table}`)),
    );
    queued.length = 0;
    fixtureResponse = undefined;
  });
  after(async () => {
    assert.equal(outboundRequests, 0);
    await mf?.dispose();
  });

  async function request(
    path,
    { method = 'GET', cookie, body, headers = {}, origin = base } = {},
  ) {
    return mf.dispatchFetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        Origin: origin,
        'CF-Connecting-IP': '203.0.113.11',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function visitor() {
    const response = await request('/session', { method: 'POST', body: {} });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  async function create(cookie, sites = [site]) {
    const response = await request('/scans', {
      method: 'POST',
      cookie,
      body: { sites },
    });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  }
  async function snapshot(cookie, id, runId) {
    const response = await request(
      `/scans/${id}${runId ? `/runs/${runId}` : ''}`,
      { cookie },
    );
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  async function complete(id, status = 'completed') {
    await db
      .prepare(
        'UPDATE scans SET status = ?, heartbeat_at = ?, activity_json = ? WHERE id = ?',
      )
      .bind(
        status,
        Date.now(),
        JSON.stringify({ phase: status, updatedAt: result.observedAt }),
        id,
      )
      .run();
  }
  async function seedResults(id) {
    const json = JSON.stringify(result);
    await db.batch([
      db
        .prepare(
          'INSERT INTO page_results (scan_id, source_url, source_origin, result_hash, result_json, result_bytes) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(
          id,
          result.sourceUrl,
          site.origin,
          'fixture-hash',
          json,
          json.length,
        ),
      db
        .prepare(
          'INSERT INTO scan_events (scan_id, event_key, event_json) VALUES (?, ?, ?)',
        )
        .bind(id, 'old-result', JSON.stringify(event)),
      db
        .prepare(
          'UPDATE scans SET scan_log_truncated = 1, limit_reason = ? WHERE id = ?',
        )
        .bind('page_limit', id),
    ]);
  }
  async function rescan(cookie, scan, options = {}) {
    return request(`/scans/${scan.id}/rescan`, {
      method: 'POST',
      cookie,
      body: { runId: scan.runId },
      ...options,
    });
  }
  async function restart(cookie, scan) {
    const response = await rescan(cookie, scan);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  async function runs(cookie, id) {
    const response = await request(`/scans/${id}/runs`, { cookie });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }

  async function drainCrawls() {
    for (let count = 0; queued.length && count < 1000; count++) {
      const { body } = queued.shift();
      await db
        .prepare('UPDATE crawl_origin_gates SET next_allowed_at = 0')
        .run();
      const response = await mf.dispatchFetch(`${base}/test-consume`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), ['ack']);
    }
    assert.equal(
      queued.length,
      0,
      'The crawler must finish within its bounded frontier',
    );
  }

  test('rescan archives real page and robots redirects with their original site identity and complete log', async () => {
    const redirectSite = {
      ...site,
      origin: 'http://example.com',
      seedUrl: 'http://example.com/start/',
    };
    const upgradedUrl = 'https://example.com/start/';
    const finalUrl = 'https://www.example.com/final';
    const robotsUrl = `${redirectSite.origin}/robots.txt`;
    const robotsTarget = 'https://www.example.com/crawl-policy.txt';
    const redirects = new Map([
      [robotsUrl, { target: robotsTarget, status: 302 }],
      [redirectSite.seedUrl, { target: upgradedUrl, status: 301 }],
      [upgradedUrl, { target: finalUrl, status: 308 }],
    ]);
    const fetched = [];
    fixtureResponse = (request) => {
      const url = new URL(request.url);
      fetched.push(url.href);
      const redirect = redirects.get(url.href);
      if (redirect)
        return new Response(null, {
          status: redirect.status,
          headers: { Location: redirect.target },
        });
      if (url.href === robotsTarget)
        return new Response('User-agent: *\nAllow: /');
      if (url.pathname === '/robots.txt')
        return new Response('', { status: 404 });
      assert.equal(url.href, finalUrl, 'Only the redirect target is scanned.');
      return new Response('<title>Canonical page</title>', {
        headers: { 'Content-Type': 'text/html' },
      });
    };
    const cookie = await visitor();
    const scan = await create(cookie, [redirectSite]);
    const started = await request(`/scans/${scan.id}/start`, {
      method: 'POST',
      cookie,
      body: { runId: scan.runId },
    });
    assert.equal(started.status, 200, await started.clone().text());
    await drainCrawls();
    assert.deepEqual(fetched, [
      robotsUrl,
      robotsTarget,
      redirectSite.seedUrl,
      'https://example.com/robots.txt',
      upgradedUrl,
      'https://www.example.com/robots.txt',
      finalUrl,
    ]);
    const original = await snapshot(cookie, scan.id);
    assert.equal(original.status, 'completed');
    assert.deepEqual(original.sites, [redirectSite]);
    assert.deepEqual(
      original.results.map((page) => ({
        sourceUrl: page.sourceUrl,
        siteOrigin: page.siteOrigin,
        status: page.status,
        httpStatus: page.httpStatus,
        redirect: page.redirect,
        crawlMode: page.crawlMode,
      })),
      [
        {
          sourceUrl: redirectSite.seedUrl,
          siteOrigin: undefined,
          status: 'redirect_unresolved',
          httpStatus: 301,
          redirect: { kind: 'site_variant', targetUrl: upgradedUrl },
          crawlMode: undefined,
        },
        {
          sourceUrl: upgradedUrl,
          siteOrigin: redirectSite.origin,
          status: 'redirect_unresolved',
          httpStatus: 308,
          redirect: { kind: 'site_variant', targetUrl: finalUrl },
          crawlMode: undefined,
        },
        {
          sourceUrl: finalUrl,
          siteOrigin: redirectSite.origin,
          status: 'ok',
          httpStatus: 200,
          redirect: undefined,
          crawlMode: undefined,
        },
      ],
    );
    const logResponse = await request(`/scans/${scan.id}/log`, { cookie });
    assert.equal(logResponse.status, 200);
    const originalLog = await logResponse.json();
    assert.equal(originalLog.truncated, false);
    assert.deepEqual(
      originalLog.events
        .filter((entry) => entry.redirect)
        .map((entry) => ({
          type: entry.type,
          origin: entry.origin,
          url: entry.url,
          status: entry.status,
          httpStatus: entry.httpStatus,
          redirect: entry.redirect,
        })),
      [...redirects].map(([url, { target, status }]) => ({
        type: url === robotsUrl ? 'robots_checked' : 'page_finished',
        origin: redirectSite.origin,
        url,
        status: 'redirect_unresolved',
        httpStatus: status,
        redirect: { kind: 'site_variant', targetUrl: target },
      })),
    );
    const policyEvent = originalLog.events.find(
      (entry) => entry.type === 'robots_checked' && entry.url === robotsTarget,
    );
    assert.equal(policyEvent.status, 'ok');
    assert.equal(policyEvent.httpStatus, 200);
    const finalEvent = originalLog.events.find(
      (entry) => entry.type === 'page_finished' && entry.url === finalUrl,
    );
    assert.equal(finalEvent.status, 'ok');
    assert.equal(finalEvent.httpStatus, 200);

    const current = await restart(cookie, original);
    assert.notEqual(current.runId, original.runId);
    assert.equal(current.pageCount, 0);
    assert.deepEqual(current.results, []);
    const archived = await snapshot(cookie, scan.id, original.runId);
    assert.deepEqual(archived.results, original.results);
    assert.deepEqual(archived.sites, original.sites);
    assert.equal(archived.status, 'completed');
    const archiveLogResponse = await request(
      `/scans/${scan.id}/runs/${original.runId}/log`,
      { cookie },
    );
    assert.equal(archiveLogResponse.status, 200);
    assert.deepEqual(await archiveLogResponse.json(), originalLog);
    const currentLogResponse = await request(`/scans/${scan.id}/log`, {
      cookie,
    });
    assert.equal(currentLogResponse.status, 200);
    const currentLog = await currentLogResponse.json();
    assert.equal(currentLog.truncated, false);
    assert.deepEqual(
      currentLog.events.map((entry) => entry.type),
      ['scan_started'],
    );
    assert.ok(
      currentLog.events.every((entry) => !entry.url && !entry.redirect),
      'A fresh run must not inherit page or robots redirect steps.',
    );
  });

  test('rescan preserves robots loading failures in history and reads recovered rules in the new run', async () => {
    fixtureResponse = () => new Response('Unavailable', { status: 503 });
    const cookie = await visitor();
    const scan = await create(cookie);
    const started = await request(`/scans/${scan.id}/start`, {
      method: 'POST',
      cookie,
      body: { runId: scan.runId },
    });
    assert.equal(started.status, 200);
    await drainCrawls();
    const original = await snapshot(cookie, scan.id);
    assert.equal(original.results[0].status, 'robots_unavailable');
    const originalLog = await (
      await request(`/scans/${scan.id}/log`, { cookie })
    ).json();
    const robotsEvent = originalLog.events.find(
      (entry) => entry.type === 'robots_checked',
    );
    assert.equal(robotsEvent.status, 'robots_unavailable');
    assert.equal(robotsEvent.httpStatus, 503);
    fixtureResponse = (request) =>
      new URL(request.url).pathname === '/robots.txt'
        ? new Response('User-agent: *\nAllow: /')
        : new Response('<title>Recovered</title>', {
            headers: { 'Content-Type': 'text/html' },
          });
    await restart(cookie, original);
    await drainCrawls();
    assert.equal((await snapshot(cookie, scan.id)).results[0].status, 'ok');
    assert.deepEqual(
      (await snapshot(cookie, scan.id, original.runId)).results,
      original.results,
    );
    assert.deepEqual(
      await (
        await request(`/scans/${scan.id}/runs/${original.runId}/log`, {
          cookie,
        })
      ).json(),
      originalLog,
    );
  });

  test('API promotion reuses landing evidence, expands saved links and archives preview metadata on a fresh rescan', async () => {
    const second = {
      ...site,
      origin: 'https://partner.org',
      seedUrl: 'https://partner.org/',
    };
    const landing = `${second.origin}/product`;
    const third = 'https://third.org/landing';
    const fetched = [];
    fixtureResponse = (request) => {
      const url = new URL(request.url);
      fetched.push(url.href);
      if (url.pathname === '/robots.txt')
        return new Response('', { status: 404 });
      const links =
        url.href === site.seedUrl
          ? [landing]
          : url.href === landing
            ? ['/inside', site.seedUrl, third]
            : url.href === third
              ? ['https://fourth.org/must-not-fetch']
              : [];
      assert.ok(
        [site.origin, second.origin, 'https://third.org'].includes(url.origin),
        `Unexpected recursive preview fetch: ${url.href}`,
      );
      return new Response(
        `<title>Landing fixture</title>${links.map((link) => `<a href="${link}">Link</a>`).join('')}`,
        { headers: { 'Content-Type': 'text/html' } },
      );
    };
    const cookie = await visitor();
    const scan = await create(cookie);
    assert.equal(
      (
        await request(`/scans/${scan.id}/start`, {
          method: 'POST',
          cookie,
          body: { runId: scan.runId },
        })
      ).status,
      200,
    );
    await drainCrawls();
    const initial = await snapshot(cookie, scan.id);
    assert.equal(initial.results.length, 2);
    const preview = initial.results.find((page) => page.sourceUrl === landing);
    assert.equal(preview.crawlMode, 'preview');
    assert.equal(fetched.includes(`${second.origin}/inside`), false);
    assert.equal(fetched.includes(third), false);
    const requestCount = fetched.length;
    const added = await request(`/scans/${scan.id}/sites`, {
      method: 'POST',
      cookie,
      body: { runId: scan.runId, site: second },
    });
    assert.equal(added.status, 201, await added.clone().text());
    const promoted = await added.json();
    assert.equal(promoted.runId, initial.runId);
    assert.equal(promoted.sites.length, 2);
    assert.deepEqual(promoted.results, initial.results);
    assert.equal(
      fetched.length,
      requestCount,
      'Adding the site waits for the explicit start action',
    );
    assert.equal(
      (
        await request(`/scans/${scan.id}/start`, {
          method: 'POST',
          cookie,
          body: { runId: scan.runId },
        })
      ).status,
      200,
    );
    await drainCrawls();
    const expanded = await snapshot(cookie, scan.id);
    assert.equal(expanded.status, 'completed');
    assert.equal(expanded.results.length, 5);
    assert.deepEqual(
      expanded.results.find((page) => page.sourceUrl === landing),
      preview,
    );
    assert.equal(
      expanded.results.find(
        (page) => page.sourceUrl === `${second.origin}/inside`,
      ).crawlMode,
      undefined,
    );
    assert.equal(
      expanded.results.find((page) => page.sourceUrl === third).crawlMode,
      'preview',
    );
    assert.equal(fetched.filter((url) => url === landing).length, 1);
    assert.equal(fetched.filter((url) => url === site.seedUrl).length, 1);
    const current = await restart(cookie, expanded);
    assert.equal(current.results.length, 0);
    assert.deepEqual(
      (await snapshot(cookie, scan.id, expanded.runId)).results,
      expanded.results,
    );
    assert.equal(
      (
        await db
          .prepare(
            'SELECT COUNT(*) AS count FROM crawl_frontier WHERE scan_id = ? AND is_preview = 1',
          )
          .bind(scan.id)
          .first()
      ).count,
      0,
    );
    assert.equal(
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM crawl_robots WHERE scan_id = ? AND (state <> 'pending' OR policy_json IS NOT NULL OR preview_throttled <> 0)",
          )
          .bind(scan.id)
          .first()
      ).count,
      0,
    );
    await drainCrawls();
    const refreshed = await snapshot(cookie, scan.id);
    assert.equal(
      refreshed.results.find((page) => page.sourceUrl === landing).crawlMode,
      undefined,
    );
    assert.equal(
      refreshed.results.find((page) => page.sourceUrl === third).crawlMode,
      'preview',
    );
    assert.deepEqual(
      (await snapshot(cookie, scan.id, expanded.runId)).results,
      expanded.results,
    );
  });

  test('rescan resets preview throttling while keeping the earlier failed landing result immutable', async () => {
    const landing = 'https://throttled.org/a-throttle';
    const pending = 'https://throttled.org/z-pending';
    let throttled = true;
    const fetched = [];
    fixtureResponse = (request) => {
      const url = new URL(request.url);
      fetched.push(url.href);
      if (url.pathname === '/robots.txt')
        return new Response('', { status: 404 });
      if (url.href === site.seedUrl)
        return new Response(
          `<a href="${landing}">Throttled</a><a href="${pending}">Pending</a>`,
          { headers: { 'Content-Type': 'text/html' } },
        );
      if (url.href === landing && throttled)
        return new Response('', { status: 429 });
      assert.ok([landing, pending].includes(url.href));
      return new Response('<title>Recovered landing</title>', {
        headers: { 'Content-Type': 'text/html' },
      });
    };
    const cookie = await visitor();
    const scan = await create(cookie);
    assert.equal(
      (
        await request(`/scans/${scan.id}/start`, {
          method: 'POST',
          cookie,
          body: { runId: scan.runId },
        })
      ).status,
      200,
    );
    await drainCrawls();
    const original = await snapshot(cookie, scan.id);
    assert.equal(original.status, 'completed');
    assert.equal(
      original.results.find((page) => page.sourceUrl === landing).httpStatus,
      429,
    );
    assert.equal(fetched.includes(pending), false);
    throttled = false;
    await restart(cookie, original);
    assert.equal(
      (
        await db
          .prepare(
            'SELECT COUNT(*) AS count FROM crawl_robots WHERE scan_id = ? AND preview_throttled = 1',
          )
          .bind(scan.id)
          .first()
      ).count,
      0,
    );
    await drainCrawls();
    const current = await snapshot(cookie, scan.id);
    assert.equal(
      current.results.filter(
        (page) => page.crawlMode === 'preview' && page.status === 'ok',
      ).length,
      2,
    );
    assert.equal(fetched.filter((url) => url === landing).length, 2);
    assert.deepEqual(
      (await snapshot(cookie, scan.id, original.runId)).results,
      original.results,
    );
  });

  test('history migration preserves existing maps and the API supplies legacy run identity', async () => {
    assert.equal(migrationSnapshot.id, 'legacy-map');
    assert.equal(migrationSnapshot.run_number, 1);
    assert.equal(migrationSnapshot.run_id, 'legacy-map');
    assert.equal(migrationSnapshot.created_at, 100);
    assert.equal(migrationSnapshot.status, 'completed');
    assert.deepEqual(JSON.parse(migrationSnapshot.sites_json), [site]);
    const cookie = await visitor();
    const scan = await create(cookie);
    await db
      .prepare(
        'UPDATE scans SET run_id = NULL, run_created_at = NULL WHERE id = ?',
      )
      .bind(scan.id)
      .run();
    const legacy = await snapshot(cookie, scan.id);
    assert.equal(legacy.runId, scan.id);
    assert.equal(legacy.runNumber, 1);
    assert.equal(legacy.runCreatedAt, legacy.createdAt);
    assert.deepEqual(
      (await runs(cookie, scan.id)).runs.map((run) => [
        run.runId,
        run.archived,
      ]),
      [[scan.id, false]],
    );
  });

  test('rescan freezes results, log and settings while keeping the map and publishing an empty live run', async () => {
    const cookie = await visitor();
    const scan = await create(cookie, [
      site,
      {
        ...site,
        origin: 'https://second.org',
        seedUrl: 'https://second.org/docs',
        paused: true,
      },
    ]);
    await complete(scan.id, 'limited');
    await seedResults(scan.id);
    const original = await snapshot(cookie, scan.id);
    const oldLog = await (
      await request(`/scans/${scan.id}/log`, { cookie })
    ).json();
    const current = await restart(cookie, original);
    assert.equal(current.id, original.id);
    assert.equal(current.createdAt, original.createdAt);
    assert.notEqual(current.runId, original.runId);
    assert.equal(current.runNumber, 2);
    assert.equal(current.status, 'running');
    assert.equal(current.pageCount, 0);
    assert.deepEqual(current.results, []);
    assert.deepEqual(current.sites, original.sites);
    assert.equal(current.limitReason, undefined);
    assert.ok(
      Date.parse(current.runCreatedAt) >= Date.parse(original.runCreatedAt),
    );
    const archived = await snapshot(cookie, scan.id, original.runId);
    assert.deepEqual(archived.results, [result]);
    assert.deepEqual(archived.sites, original.sites);
    assert.equal(archived.status, 'limited');
    assert.equal(archived.limitReason, 'page_limit');
    assert.equal(archived.pageCount, 1);
    assert.equal(archived.updatedAt, original.updatedAt);
    assert.deepEqual(archived.activity, original.activity);
    const archiveLog = await (
      await request(`/scans/${scan.id}/runs/${original.runId}/log`, { cookie })
    ).json();
    assert.deepEqual(archiveLog, oldLog);
    const liveLog = await (
      await request(`/scans/${scan.id}/log`, { cookie })
    ).json();
    assert.equal(liveLog.truncated, false);
    assert.ok(liveLog.events.every((entry) => entry.url !== result.sourceUrl));
    assert.equal(
      liveLog.events.filter((entry) => entry.type === 'scan_started').length,
      1,
    );
    const listed = await runs(cookie, scan.id);
    assert.equal(listed.limit, 10);
    assert.deepEqual(
      listed.runs.map((run) => [
        run.runId,
        run.runNumber,
        run.archived,
        run.pageCount,
      ]),
      [
        [current.runId, 2, false, 0],
        [original.runId, 1, true, 1],
      ],
    );
    assert.deepEqual(await snapshot(cookie, scan.id, current.runId), current);
    assert.equal(queued.length, 1);
    const frontier = await db
      .prepare('SELECT url FROM crawl_frontier WHERE scan_id = ? ORDER BY url')
      .bind(scan.id)
      .all();
    assert.ok(
      frontier.results.every(({ url }) => url !== result.discoveredUrls[0]),
      'Old discovered pages must not seed a fresh traversal.',
    );
    const changed = await request(`/scans/${scan.id}`, {
      method: 'PATCH',
      cookie,
      body: {
        runId: current.runId,
        sites: current.sites.map((entry) => ({ ...entry, intervalMs: 9000 })),
      },
    });
    assert.equal(changed.status, 200);
    assert.deepEqual(
      (await snapshot(cookie, scan.id, original.runId)).sites,
      original.sites,
    );
  });

  test('an archive write failure rolls back metadata, results and log before any new queue work', async () => {
    const cookie = await visitor();
    const scan = await create(cookie);
    await complete(scan.id);
    await seedResults(scan.id);
    const previous = await snapshot(cookie, scan.id);
    const oldLog = await (
      await request(`/scans/${scan.id}/log`, { cookie })
    ).json();
    await db
      .prepare(
        "CREATE TRIGGER fail_archive BEFORE INSERT ON scan_run_pages BEGIN SELECT RAISE(ABORT, 'Simulated archive write failure'); END",
      )
      .run();
    try {
      assert.equal((await rescan(cookie, previous)).status, 500);
      assert.deepEqual(await snapshot(cookie, scan.id), previous);
      assert.deepEqual(
        await (await request(`/scans/${scan.id}/log`, { cookie })).json(),
        oldLog,
      );
      assert.equal((await runs(cookie, scan.id)).runs.length, 1);
      assert.equal(queued.length, 0);
    } finally {
      await db.prepare('DROP TRIGGER fail_archive').run();
    }
    const retried = await restart(cookie, previous);
    assert.equal(retried.runNumber, 2);
    assert.deepEqual(
      (await snapshot(cookie, scan.id, previous.runId)).results,
      [result],
    );
  });

  test('a double click starts exactly one new run and stale run identities cannot overwrite it', async () => {
    const cookie = await visitor();
    const scan = await create(cookie);
    await complete(scan.id);
    await seedResults(scan.id);
    const responses = await Promise.all([
      rescan(cookie, scan),
      rescan(cookie, scan),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 409],
    );
    assert.equal((await runs(cookie, scan.id)).runs.length, 2);
    assert.equal(queued.length, 1);
    await complete(scan.id);
    assert.equal((await rescan(cookie, scan)).status, 409);
    assert.equal((await runs(cookie, scan.id)).runs.length, 2);
  });

  test('rescan validates run identity and rejects an active or waiting traversal without archiving', async () => {
    const cookie = await visitor();
    const scan = await create(cookie);
    assert.equal((await rescan(cookie, scan)).status, 409);
    await complete(scan.id);
    assert.equal((await rescan(cookie, scan, { body: {} })).status, 400);
    const previous = await snapshot(cookie, scan.id);
    for (const runId of [
      '-'.repeat(36),
      'a'.repeat(36),
      '0000000-00000-4000-8000-000000000000',
    ]) {
      assert.equal(
        (await rescan(cookie, scan, { body: { runId } })).status,
        400,
        `Malformed run ID must fail validation: ${runId}`,
      );
    }
    assert.deepEqual(await snapshot(cookie, scan.id), previous);
    assert.equal((await runs(cookie, scan.id)).runs.length, 1);
    assert.equal(queued.length, 0);
    assert.equal(
      (
        await rescan(cookie, scan, {
          body: { runId: '00000000-0000-4000-8000-000000000000' },
        })
      ).status,
      409,
    );
    const current = await restart(cookie, scan);
    assert.equal((await rescan(cookie, current)).status, 409);
    assert.equal((await runs(cookie, scan.id)).runs.length, 2);
  });

  test('disabled crawling rejects a rescan before changing the previous results or history', async () => {
    const cookie = await visitor();
    const scan = await create(cookie);
    await complete(scan.id);
    await seedResults(scan.id);
    const previous = await snapshot(cookie, scan.id);
    assert.equal(
      (
        await rescan(cookie, previous, {
          headers: { 'X-Test-Disabled': 'true' },
        })
      ).status,
      503,
    );
    assert.deepEqual(await snapshot(cookie, scan.id), previous);
    assert.equal((await runs(cookie, scan.id)).runs.length, 1);
    assert.equal(queued.length, 0);
  });

  test('history keeps ten runs and rejects an eleventh without deleting any old content', async () => {
    const cookie = await visitor();
    let scan = await create(cookie);
    const firstRunId = scan.runId;
    await seedResults(scan.id);
    for (let run = 2; run <= 10; run++) {
      await complete(scan.id);
      scan = await restart(cookie, scan);
      assert.equal(scan.runNumber, run);
    }
    await complete(scan.id);
    const previous = await snapshot(cookie, scan.id);
    assert.equal((await rescan(cookie, scan)).status, 429);
    assert.deepEqual(await snapshot(cookie, scan.id), previous);
    const history = await runs(cookie, scan.id);
    assert.equal(history.runs.length, 10);
    assert.deepEqual(
      history.runs.map((run) => run.runNumber),
      [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    );
    assert.deepEqual((await snapshot(cookie, scan.id, firstRunId)).results, [
      result,
    ]);
    assert.equal(queued.length, 9);
  });

  test('history endpoints inherit map ownership and rescan requires a same-origin owner request', async () => {
    const alice = await visitor();
    const bob = await visitor();
    const scan = await create(alice);
    await complete(scan.id);
    await seedResults(scan.id);
    const current = await restart(alice, scan);
    for (const path of [
      `/scans/${scan.id}/runs`,
      `/scans/${scan.id}/runs/${scan.runId}`,
      `/scans/${scan.id}/runs/${scan.runId}/log`,
    ]) {
      assert.equal((await request(path)).status, 401);
      assert.equal((await request(path, { cookie: bob })).status, 404);
    }
    assert.equal((await rescan(bob, current)).status, 404);
    assert.equal(
      (await rescan(alice, current, { origin: 'https://evil.org' })).status,
      403,
    );
    const other = await create(alice);
    assert.equal(
      (
        await request(`/scans/${other.id}/runs/${scan.runId}`, {
          cookie: alice,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request(`/scans/${other.id}/runs/${scan.runId}/log`, {
          cookie: alice,
        })
      ).status,
      404,
    );
    assert.equal(
      (await request(`/scans/${scan.id}/runs/unknown`, { cookie: alice }))
        .status,
      404,
    );
  });

  for (const expiry of ['map', 'visitor']) {
    test(`archived data becomes inaccessible when its ${expiry} expires and deletion cascades`, async () => {
      const cookie = await visitor();
      const scan = await create(cookie);
      await complete(scan.id);
      await seedResults(scan.id);
      await restart(cookie, scan);
      if (expiry === 'map')
        await db
          .prepare('UPDATE scans SET created_at = 1 WHERE id = ?')
          .bind(scan.id)
          .run();
      else await db.prepare('UPDATE visitors SET expires_at = 1').run();
      for (const suffix of [
        '/runs',
        `/runs/${scan.runId}`,
        `/runs/${scan.runId}/log`,
      ]) {
        assert.equal(
          (await request(`/scans/${scan.id}${suffix}`, { cookie })).status,
          expiry === 'map' ? 404 : 401,
        );
      }
      await db.prepare('DELETE FROM scans WHERE id = ?').bind(scan.id).run();
      for (const table of ['scan_runs', 'scan_run_pages', 'scan_run_events']) {
        assert.equal(
          (await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first())
            .count,
          0,
        );
      }
    });
  }

  test('pause and resume retain the active run while stale tab mutations are rejected', async () => {
    const cookie = await visitor();
    const scan = await create(cookie);
    await complete(scan.id);
    const current = await restart(cookie, scan);
    for (const [path, method, body] of [
      [`/scans/${scan.id}`, 'PATCH', { runId: scan.runId, status: 'paused' }],
      [`/scans/${scan.id}/start`, 'POST', { runId: scan.runId }],
      [
        `/scans/${scan.id}/sites`,
        'POST',
        {
          runId: scan.runId,
          site: {
            ...site,
            origin: 'https://other.org',
            seedUrl: 'https://other.org/',
          },
        },
      ],
    ])
      assert.equal((await request(path, { method, cookie, body })).status, 409);
    let response = await request(`/scans/${scan.id}`, {
      method: 'PATCH',
      cookie,
      body: { runId: current.runId, status: 'paused' },
    });
    assert.equal(response.status, 200);
    assert.equal((await snapshot(cookie, scan.id)).runId, current.runId);
    response = await request(`/scans/${scan.id}/start`, {
      method: 'POST',
      cookie,
      body: { runId: current.runId },
    });
    assert.equal(response.status, 200);
    const resumed = await response.json();
    assert.equal(resumed.runId, current.runId);
    assert.equal(resumed.runNumber, 2);
    assert.equal(resumed.status, 'running');
    assert.equal((await runs(cookie, scan.id)).runs.length, 2);
  });

  test('rescan does not reset shared request budgets and exhausted start quota leaves history intact', async () => {
    const cookie = await visitor();
    const scan = await create(cookie);
    await complete(scan.id);
    const day = Math.floor(Date.now() / 86400000);
    await db
      .prepare(
        'INSERT INTO crawl_daily_budget (day, request_count) VALUES (?, ?)',
      )
      .bind(day, 321)
      .run();
    await db
      .prepare(
        'INSERT INTO crawl_origin_gates (origin, next_allowed_at) VALUES (?, ?)',
      )
      .bind(site.origin, Date.now() + 60000)
      .run();
    const gate = await db.prepare('SELECT * FROM crawl_origin_gates').first();
    const current = await restart(cookie, scan);
    assert.equal(
      (
        await db
          .prepare('SELECT request_count FROM crawl_daily_budget WHERE day = ?')
          .bind(day)
          .first()
      ).request_count,
      321,
    );
    assert.deepEqual(
      await db.prepare('SELECT * FROM crawl_origin_gates').first(),
      gate,
    );
    await complete(scan.id);
    const bucket = Buffer.from(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`start:${day}:203.0.113.11`),
      ),
    ).toString('hex');
    await db
      .prepare(
        'UPDATE creation_quotas SET request_count = 100 WHERE bucket_hash = ?',
      )
      .bind(bucket)
      .run();
    const previous = await snapshot(cookie, scan.id);
    assert.equal((await rescan(cookie, current)).status, 429);
    assert.deepEqual(await snapshot(cookie, scan.id), previous);
    assert.equal((await runs(cookie, scan.id)).runs.length, 2);
  });

  test('queued work from an earlier generation cannot write into the new live run or its archive', async () => {
    const cookie = await visitor();
    const scan = await create(cookie);
    await request(`/scans/${scan.id}/start`, {
      method: 'POST',
      cookie,
      body: {},
    });
    const oldMessage = queued[0].body;
    await complete(scan.id);
    await seedResults(scan.id);
    const previous = await snapshot(cookie, scan.id);
    const current = await restart(cookie, previous);
    const archive = await snapshot(cookie, scan.id, previous.runId);
    const response = await mf.dispatchFetch(`${base}/test-consume`, {
      method: 'POST',
      body: JSON.stringify(oldMessage),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), ['ack']);
    assert.deepEqual(await snapshot(cookie, scan.id), current);
    assert.deepEqual(await snapshot(cookie, scan.id, previous.runId), archive);
    assert.equal(queued.length, 2);
  });

  test(
    'an in-flight page released after pause and rescan cannot change either run',
    { timeout: 15000 },
    async () => {
      const cookie = await visitor();
      const scan = await create(cookie);
      const arrived = Promise.withResolvers();
      const release = Promise.withResolvers();
      const pending = [];
      async function withinTimeout(promise, label) {
        let timer;
        try {
          return await Promise.race([
            promise,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`Timed out waiting for ${label}.`)),
                5000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      fixtureResponse = async (request) => {
        if (new URL(request.url).pathname === '/robots.txt')
          return new Response('User-agent: *\nAllow: /');
        arrived.resolve();
        await release.promise;
        return new Response(
          '<title>Late response</title><a href="/late-discovery">Next</a>',
          { headers: { 'Content-Type': 'text/html' } },
        );
      };
      const consume = (body) => {
        const work = mf.dispatchFetch(`${base}/test-consume`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        pending.push(work);
        // Observe early failures while waiting for the fixture to arrive.
        void work.catch(() => {});
        return work;
      };
      try {
        const started = await request(`/scans/${scan.id}/start`, {
          method: 'POST',
          cookie,
          body: {},
        });
        assert.equal(started.status, 200);
        assert.equal(queued.length, 1);
        assert.equal(
          (await withinTimeout(consume(queued[0].body), 'robots tick')).status,
          200,
        );
        assert.equal(
          queued.length,
          2,
          'Robots tick must enqueue one page tick.',
        );
        await db
          .prepare('UPDATE crawl_origin_gates SET next_allowed_at = 0')
          .run();
        const inFlight = consume(queued[1].body);
        await withinTimeout(arrived.promise, 'page request');
        const paused = await request(`/scans/${scan.id}`, {
          method: 'PATCH',
          cookie,
          body: { status: 'paused', runId: scan.runId },
        });
        assert.equal(paused.status, 200);
        const current = await restart(cookie, scan);
        const archived = await snapshot(cookie, scan.id, scan.runId);
        const archiveLog = await (
          await request(`/scans/${scan.id}/runs/${scan.runId}/log`, { cookie })
        ).json();
        release.resolve();
        assert.equal(
          (await withinTimeout(inFlight, 'released page tick')).status,
          200,
        );
        assert.deepEqual(await snapshot(cookie, scan.id), current);
        assert.deepEqual(await snapshot(cookie, scan.id, scan.runId), archived);
        assert.deepEqual(
          await (
            await request(`/scans/${scan.id}/runs/${scan.runId}/log`, {
              cookie,
            })
          ).json(),
          archiveLog,
        );
        assert.equal(
          (
            await db
              .prepare(
                'SELECT COUNT(*) AS count FROM crawl_frontier WHERE url LIKE ?',
              )
              .bind('%late-discovery')
              .first()
          ).count,
          0,
        );
      } finally {
        release.resolve();
        try {
          await withinTimeout(Promise.allSettled(pending), 'queue cleanup');
        } finally {
          fixtureResponse = undefined;
        }
      }
    },
  );
});
