import {
  normalizeScanUrl,
  SCAN_LIMITS,
  type PageResult,
  type ScanSite,
  type ScanActivity,
  type ScanControl,
} from '../shared/scan';
import { emptyResult } from '../shared/fetch-result';
import { ApiError } from './validation';
import { scanLogStatements } from './scan-log';
import {
  fetchServerPage,
  fetchServerRobots,
  robotsAllows,
  type StoredRobots,
} from './server-fetch';

const DAY_MS = 86_400_000;
const RETENTION_MS = 30 * DAY_MS;
const RUN_MS = 15 * 60_000;
const LEASE_MS = 120_000;
const DAILY_REQUESTS = 10_000;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const FRONTIER_SIZE = SCAN_LIMITS.pagesPerSite + 1;

export type CrawlMessage = { scanId: string; generation: number; tick: number };
type ScanRow = {
  id: string;
  status: string;
  execution_mode: string;
  sites_json: string;
  limit_reason: string | null;
  crawl_generation: number;
  crawl_started_at: number | null;
  crawl_tick: number;
  crawl_enqueued_tick: number;
  crawl_lease_token: string | null;
  crawl_lease_until: number | null;
  heartbeat_at: number | null;
  crawl_ready: number;
};
type Lease = CrawlMessage & { token: string; startedAt: number };
type FrontierRow = { url: string; origin: string; state: string };

const activeSql = `SELECT 1 FROM scans WHERE id = ?1 AND crawl_generation = ?2
  AND crawl_lease_token = ?3 AND status = 'running' AND execution_mode = 'server'
  AND created_at > ?4`;

function leaseBindings(lease: Lease): [string, number, string, number] {
  return [
    lease.scanId,
    lease.generation,
    lease.token,
    Date.now() - RETENTION_MS,
  ];
}

function safeUrls(urls: string[], origin: string): string[] {
  const unique = new Set<string>();
  for (const value of urls) {
    try {
      const url = normalizeScanUrl(value);
      if (new URL(url).origin === origin) unique.add(url);
    } catch {
      // A discovered URL is untrusted, even when imported from a legacy scan.
    }
  }
  return [...unique];
}

function addFrontier(
  env: Env,
  id: string,
  origin: string,
  urls: string[],
  generation: number,
) {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO crawl_frontier (scan_id, url, origin)
    SELECT ?1, value, ?2 FROM json_each(?3)
    WHERE EXISTS (SELECT 1 FROM scans WHERE id = ?1 AND crawl_generation = ?4 AND status = 'running')
      AND NOT EXISTS (SELECT 1 FROM crawl_frontier WHERE scan_id = ?1 AND url = value)
    ORDER BY CAST(key AS INTEGER)
    LIMIT MAX(0, ?5 - (SELECT COUNT(*) FROM crawl_frontier WHERE scan_id = ?1 AND origin = ?2))`,
  ).bind(
    id,
    origin,
    JSON.stringify(safeUrls(urls, origin)),
    generation,
    FRONTIER_SIZE,
  );
}

async function enqueueCurrent(
  env: Env,
  row: ScanRow,
  delaySeconds = 0,
): Promise<void> {
  if (
    row.status !== 'running' ||
    !row.crawl_ready ||
    row.crawl_enqueued_tick >= row.crawl_tick
  )
    return;
  await env.CRAWL_QUEUE.send(
    { scanId: row.id, generation: row.crawl_generation, tick: row.crawl_tick },
    { delaySeconds },
  );
  // Sending and D1 are not one transaction. A crash here can duplicate a tick;
  // its generation, tick and lease make that duplicate harmless.
  await env.DB.prepare(
    `UPDATE scans SET crawl_enqueued_tick = MAX(crawl_enqueued_tick, ?3)
    WHERE id = ?1 AND crawl_generation = ?2`,
  )
    .bind(row.id, row.crawl_generation, row.crawl_tick)
    .run();
}

export async function startServerScan(
  env: Env,
  scanId: string,
  expectedGeneration?: number,
): Promise<void> {
  if (env.CRAWLER_ENABLED !== 'true')
    throw new ApiError(503, 'Server scanning is temporarily disabled.');
  const now = Date.now();
  const row = await env.DB.prepare(
    'SELECT * FROM scans WHERE id = ?1 AND created_at > ?2',
  )
    .bind(scanId, now - RETENTION_MS)
    .first<ScanRow>();
  if (!row) throw new ApiError(404, 'Scan not found.');
  if (
    expectedGeneration !== undefined &&
    row.crawl_generation !== expectedGeneration
  )
    throw new ApiError(409, 'The scan changed. Reload before starting it.');
  if (
    row.limit_reason === 'time_limit' ||
    row.limit_reason === 'scan_storage_limit'
  )
    throw new ApiError(
      429,
      'This scan reached its safety limit. Contact the administrator.',
    );
  if (row.limit_reason === 'daily_limit') {
    const budget = await env.DB.prepare(
      'SELECT request_count FROM crawl_daily_budget WHERE day = ?1',
    )
      .bind(Math.floor(now / DAY_MS))
      .first<{ request_count: number }>();
    if ((budget?.request_count ?? 0) >= DAILY_REQUESTS)
      throw new ApiError(
        429,
        'The daily scanning budget is exhausted. Try again tomorrow.',
      );
  }
  if (
    row.execution_mode === 'server' &&
    row.status === 'running' &&
    !row.crawl_ready &&
    (row.heartbeat_at ?? 0) >= now - LEASE_MS
  )
    throw new ApiError(
      409,
      'The scan is still being prepared. Try again shortly.',
    );
  if (
    row.execution_mode === 'server' &&
    row.status === 'running' &&
    row.crawl_ready
  ) {
    // A failed delivery can exhaust the queue retry count. An explicit start may
    // recover that checkpoint, but cannot reset its deadline or an active lease.
    const recovered =
      (row.heartbeat_at ?? 0) < now - LEASE_MS
        ? await env.DB.prepare(
            `UPDATE scans SET crawl_enqueued_tick = -1, heartbeat_at = ?3
          WHERE id = ?1 AND crawl_generation = ?2 AND status = 'running'
          AND COALESCE(heartbeat_at, 0) < ?4 AND COALESCE(crawl_lease_until, 0) <= ?3 RETURNING *`,
          )
            .bind(scanId, row.crawl_generation, now, now - LEASE_MS)
            .first<ScanRow>()
        : null;
    await enqueueCurrent(env, recovered ?? row);
    return;
  }
  const scanSites = (JSON.parse(row.sites_json) as ScanSite[]).map((site) => ({
    ...site,
    maxPages: SCAN_LIMITS.pagesPerSite,
  }));
  const started = await env.DB.batch<ScanRow>([
    env.DB.prepare(
      `UPDATE scans SET status = 'running', execution_mode = 'server',
    sites_json = ?3, limit_reason = NULL, crawl_generation = crawl_generation + 1,
    crawl_started_at = ?4, crawl_tick = 0, crawl_enqueued_tick = -1, crawl_ready = 0,
    crawl_lease_token = NULL, crawl_lease_until = NULL, heartbeat_at = ?4, updated_at = ?4,
    runner_hash = NULL, runner_expires_at = NULL, ticket_hash = NULL, ticket_expires_at = NULL,
    activity_json = ?5
    WHERE id = ?1 AND crawl_generation = ?2 RETURNING *`,
    ).bind(
      scanId,
      row.crawl_generation,
      JSON.stringify(scanSites),
      now,
      JSON.stringify({
        phase: 'queued',
        updatedAt: new Date(now).toISOString(),
      }),
    ),
    ...scanLogStatements(
      env,
      scanId,
      `start:${row.crawl_generation + 1}`,
      {
        at: new Date(now).toISOString(),
        type: 'scan_started',
        level: 'info',
      },
      { sql: 'changes() = 1', bindings: [] },
    ),
  ]);
  const updated = started[0].results[0];
  if (!updated)
    throw new ApiError(409, 'The scan changed. Reload before starting it.');
  try {
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM crawl_origin_gates WHERE origin IN
        (SELECT origin FROM crawl_origin_gates WHERE next_allowed_at < ?1 LIMIT 100)`,
      ).bind(now - DAY_MS),
      env.DB.prepare('DELETE FROM crawl_daily_budget WHERE day < ?1').bind(
        Math.floor(now / DAY_MS) - 1,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO crawl_frontier (scan_id, url, origin, state)
        SELECT scan_id, source_url, source_origin, 'done' FROM page_results WHERE scan_id = ?1
        AND EXISTS (SELECT 1 FROM scans WHERE id = ?1 AND crawl_generation = ?2)`,
      ).bind(scanId, updated.crawl_generation),
      ...scanSites.map((site) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO crawl_robots (scan_id, origin)
        SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM scans WHERE id = ?1 AND crawl_generation = ?3)`,
        ).bind(scanId, site.origin, updated.crawl_generation),
      ),
      ...scanSites.map((site) =>
        addFrontier(
          env,
          scanId,
          site.origin,
          [site.seedUrl],
          updated.crawl_generation,
        ),
      ),
    ]);
    const saved = await env.DB.prepare(
      'SELECT result_json FROM page_results WHERE scan_id = ?1',
    )
      .bind(scanId)
      .all<{ result_json: string }>();
    for (const site of scanSites) {
      const discovered = saved.results.flatMap(({ result_json }) => {
        const result = JSON.parse(result_json) as PageResult;
        return [
          ...result.discoveredUrls,
          ...result.links.map((link) => link.targetUrl),
        ];
      });
      if (discovered.length)
        await addFrontier(
          env,
          scanId,
          site.origin,
          discovered,
          updated.crawl_generation,
        ).run();
    }
    const ready = await env.DB.prepare(
      `UPDATE scans SET crawl_ready = 1
      WHERE id = ?1 AND crawl_generation = ?2 AND status = 'running' RETURNING *`,
    )
      .bind(scanId, updated.crawl_generation)
      .first<ScanRow>();
    if (ready) await enqueueCurrent(env, ready);
  } catch (error) {
    const failedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE scans SET status = 'error', updated_at = ?3, activity_json = ?4
        WHERE id = ?1 AND crawl_generation = ?2 AND status = 'running'`,
      ).bind(
        scanId,
        updated.crawl_generation,
        Date.now(),
        JSON.stringify({ phase: 'error', updatedAt: failedAt }),
      ),
      ...scanLogStatements(
        env,
        scanId,
        `start-error:${updated.crawl_generation}`,
        {
          at: failedAt,
          type: 'scan_error',
          level: 'error',
        },
        { sql: 'changes() = 1', bindings: [] },
      ),
    ]);
    throw error;
  }
}

async function finish(
  env: Env,
  lease: Lease,
  reason: NonNullable<ScanControl['limitReason']> | null,
  paused = false,
): Promise<void> {
  const now = Date.now();
  const phase = paused ? 'paused' : reason ? 'limited' : 'completed';
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE scans SET status = ?5, limit_reason = ?6,
      crawl_lease_token = NULL, crawl_lease_until = NULL, heartbeat_at = ?7, updated_at = ?7,
      activity_json = ?8 WHERE EXISTS (${activeSql}) AND id = ?1`,
    ).bind(
      ...leaseBindings(lease),
      phase,
      reason,
      now,
      JSON.stringify({ phase, updatedAt: new Date(now).toISOString() }),
    ),
    ...scanLogStatements(
      env,
      lease.scanId,
      `finish:${lease.generation}`,
      {
        at: new Date(now).toISOString(),
        type: paused
          ? 'scan_paused'
          : reason
            ? 'scan_limited'
            : 'scan_completed',
        level: reason ? 'warning' : 'info',
        ...(reason ? { reason } : {}),
      },
      { sql: 'changes() = 1', bindings: [] },
    ),
  ]);
}

async function setActivity(
  env: Env,
  lease: Lease,
  activity: Omit<ScanActivity, 'updatedAt'>,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE scans SET activity_json = ?5 WHERE EXISTS (${activeSql}) AND id = ?1`,
  )
    .bind(
      ...leaseBindings(lease),
      JSON.stringify({ ...activity, updatedAt: new Date().toISOString() }),
    )
    .run();
}

async function checkpoint(
  env: Env,
  lease: Lease,
  delayMs = 0,
  origin?: string,
): Promise<void> {
  const now = Date.now();
  const activity: ScanActivity = {
    phase: delayMs > 0 ? 'waiting' : 'queued',
    updatedAt: new Date(now).toISOString(),
    ...(origin ? { origin } : {}),
    ...(delayMs > 0
      ? { nextRequestAt: new Date(now + delayMs).toISOString() }
      : {}),
  };
  const row = await env.DB.prepare(
    `UPDATE scans SET crawl_tick = crawl_tick + 1,
    crawl_lease_token = NULL, crawl_lease_until = NULL, heartbeat_at = ?5, updated_at = ?5,
    activity_json = ?6 WHERE EXISTS (${activeSql}) AND id = ?1 RETURNING *`,
  )
    .bind(...leaseBindings(lease), now, JSON.stringify(activity))
    .first<ScanRow>();
  if (row)
    await enqueueCurrent(env, row, Math.max(0, Math.ceil(delayMs / 1000)));
}

async function storeResult(
  env: Env,
  lease: Lease,
  result: PageResult,
  sites: ScanSite[],
): Promise<void> {
  const json = JSON.stringify(result);
  const encoded = new TextEncoder().encode(json);
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  const origin = new URL(result.sourceUrl).origin;
  const results = await env.DB.batch<{ stored?: number }>([
    env.DB.prepare(
      `INSERT INTO page_results (scan_id, source_url, source_origin, result_hash, result_json, result_bytes)
      SELECT ?1, ?5, ?6, ?7, ?8, ?9 WHERE EXISTS (${activeSql})
      AND (SELECT COUNT(*) FROM page_results WHERE scan_id = ?1 AND source_origin = ?6) < ?10
      AND (SELECT COALESCE(SUM(result_bytes), 0) FROM page_results WHERE scan_id = ?1) + ?9 <= ?11
      ON CONFLICT(scan_id, source_url) DO NOTHING`,
    ).bind(
      ...leaseBindings(lease),
      result.sourceUrl,
      origin,
      hash,
      json,
      encoded.byteLength,
      SCAN_LIMITS.pagesPerSite,
      MAX_SCAN_BYTES,
    ),
    ...scanLogStatements(
      env,
      lease.scanId,
      `page:${result.sourceUrl}`,
      {
        at: new Date().toISOString(),
        type: 'page_finished',
        level: ['http_error', 'network_error'].includes(result.status)
          ? 'error'
          : result.status === 'ok'
            ? 'info'
            : 'warning',
        origin,
        url: result.sourceUrl,
        status: result.status,
        ...(result.httpStatus !== null
          ? { httpStatus: result.httpStatus }
          : {}),
        linkCount: result.links.reduce(
          (count, link) => count + link.occurrences,
          0,
        ),
      },
      { sql: 'changes() = 1', bindings: [] },
    ),
    env.DB.prepare(
      `UPDATE crawl_frontier SET state = 'done' WHERE scan_id = ?1 AND url = ?5
      AND EXISTS (${activeSql}) AND EXISTS (SELECT 1 FROM page_results WHERE scan_id = ?1 AND source_url = ?5)`,
    ).bind(...leaseBindings(lease), result.sourceUrl),
    // The result, completed frontier entry and newly discovered links commit together.
    ...sites.map((site) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO crawl_frontier (scan_id, url, origin)
      SELECT ?1, value, ?5 FROM json_each(?6) WHERE EXISTS (${activeSql})
      AND EXISTS (SELECT 1 FROM page_results WHERE scan_id = ?1 AND source_url = ?7)
      AND NOT EXISTS (SELECT 1 FROM crawl_frontier WHERE scan_id = ?1 AND url = value)
      ORDER BY CAST(key AS INTEGER)
      LIMIT MAX(0, ?8 - (SELECT COUNT(*) FROM crawl_frontier WHERE scan_id = ?1 AND origin = ?5))`,
      ).bind(
        ...leaseBindings(lease),
        site.origin,
        JSON.stringify(
          safeUrls(
            [
              ...result.discoveredUrls,
              ...result.links.map((link) => link.targetUrl),
            ],
            site.origin,
          ),
        ),
        result.sourceUrl,
        FRONTIER_SIZE,
      ),
    ),
    env.DB.prepare(
      `SELECT EXISTS (SELECT 1 FROM page_results WHERE scan_id = ?1 AND source_url = ?5) AS stored
      WHERE EXISTS (${activeSql})`,
    ).bind(...leaseBindings(lease), result.sourceUrl),
  ]);
  if (results.at(-1)?.results[0]?.stored === 0)
    await finish(env, lease, 'scan_storage_limit');
}

async function reserveOrigin(
  env: Env,
  lease: Lease,
  origin: string,
  intervalMs: number,
): Promise<number> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO crawl_origin_gates (origin, next_allowed_at)
    SELECT ?5, ?6 WHERE EXISTS (${activeSql}) AND
      (EXISTS (SELECT 1 FROM crawl_origin_gates WHERE origin = ?5) OR (SELECT COUNT(*) FROM crawl_origin_gates) < 10000)
    ON CONFLICT(origin) DO UPDATE SET next_allowed_at = excluded.next_allowed_at
      WHERE next_allowed_at <= ?7 RETURNING next_allowed_at`,
  )
    .bind(...leaseBindings(lease), origin, now + intervalMs, now)
    .first();
  if (row) return 0;
  const gate = await env.DB.prepare(
    'SELECT next_allowed_at FROM crawl_origin_gates WHERE origin = ?1',
  )
    .bind(origin)
    .first<{ next_allowed_at: number }>();
  return Math.max(1000, (gate?.next_allowed_at ?? now + 60_000) - now);
}

async function reserveRequest(env: Env, lease: Lease): Promise<boolean> {
  const row = await env.DB.prepare(
    `INSERT INTO crawl_daily_budget (day, request_count)
    SELECT ?5, 1 WHERE EXISTS (${activeSql})
    ON CONFLICT(day) DO UPDATE SET request_count = request_count + 1
      WHERE request_count < ?6 RETURNING request_count`,
  )
    .bind(
      ...leaseBindings(lease),
      Math.floor(Date.now() / DAY_MS),
      DAILY_REQUESTS,
    )
    .first();
  if (row) return true;
  await finish(env, lease, 'daily_limit');
  return false;
}

async function tick(env: Env, message: Message<CrawlMessage>): Promise<void> {
  const body = message.body;
  if (
    !body ||
    typeof body.scanId !== 'string' ||
    !Number.isSafeInteger(body.generation) ||
    !Number.isSafeInteger(body.tick)
  )
    return;
  const now = Date.now();
  const token = crypto.randomUUID();
  const row = await env.DB.prepare(
    `UPDATE scans SET crawl_lease_token = ?4, crawl_lease_until = ?5,
    heartbeat_at = ?6 WHERE id = ?1 AND crawl_generation = ?2 AND crawl_tick = ?3
    AND status = 'running' AND execution_mode = 'server' AND crawl_ready = 1 AND created_at > ?7
    AND (crawl_lease_until IS NULL OR crawl_lease_until <= ?6) RETURNING *`,
  )
    .bind(
      body.scanId,
      body.generation,
      body.tick,
      token,
      now + LEASE_MS,
      now,
      now - RETENTION_MS,
    )
    .first<ScanRow>();
  if (!row) {
    const current = await env.DB.prepare(
      "SELECT * FROM scans WHERE id = ?1 AND crawl_generation = ?2 AND status = 'running'",
    )
      .bind(body.scanId, body.generation)
      .first<ScanRow>();
    if (current && current.crawl_tick > body.tick)
      await enqueueCurrent(env, current);
    else if (current?.crawl_tick === body.tick && current.crawl_lease_until)
      message.retry({
        delaySeconds: Math.max(
          1,
          Math.ceil((current.crawl_lease_until - now) / 1000),
        ),
      });
    return;
  }
  const lease: Lease = {
    ...body,
    token,
    startedAt: row.crawl_started_at ?? now,
  };
  if (env.CRAWLER_ENABLED !== 'true') {
    await finish(env, lease, null, true);
    return;
  }
  if (now - lease.startedAt >= RUN_MS) {
    await finish(env, lease, 'time_limit');
    return;
  }
  const scanSites = JSON.parse(row.sites_json) as ScanSite[];
  const frontier = (
    await env.DB.prepare(
      'SELECT url, origin, state FROM crawl_frontier WHERE scan_id = ?1 ORDER BY rowid',
    )
      .bind(body.scanId)
      .all<FrontierRow>()
  ).results;
  const activeSites = scanSites.filter((site) => !site.paused);
  const counts = new Map(
    scanSites.map((site) => [
      site.origin,
      frontier.filter(
        (entry) => entry.origin === site.origin && entry.state !== 'pending',
      ).length,
    ]),
  );
  const candidate =
    frontier.find(
      (entry) =>
        entry.state === 'attempted' &&
        activeSites.some((site) => site.origin === entry.origin),
    ) ??
    frontier.find(
      (entry) =>
        entry.state === 'pending' &&
        (counts.get(entry.origin) ?? 0) < SCAN_LIMITS.pagesPerSite &&
        activeSites.some((site) => site.origin === entry.origin),
    );
  if (!candidate) {
    const limited = [...counts.values()].some(
      (count) => count >= SCAN_LIMITS.pagesPerSite,
    );
    const hasPausedWork = frontier.some(
      (entry) =>
        entry.state === 'pending' &&
        scanSites.some((site) => site.paused && site.origin === entry.origin),
    );
    await finish(
      env,
      lease,
      limited ? 'page_limit' : null,
      !limited && hasPausedWork,
    );
    return;
  }
  if (candidate.state === 'attempted') {
    // A crash can happen after the network request and before its result commits.
    // Consume that page slot rather than silently issuing a second HTTP request.
    await storeResult(
      env,
      lease,
      emptyResult(
        candidate.url,
        'network_error',
        'The previous request was interrupted. It was not retried.',
      ),
      scanSites,
    );
    await checkpoint(env, lease);
    return;
  }
  const site = activeSites.find((site) => site.origin === candidate.origin)!;
  const robotsRow = await env.DB.prepare(
    'SELECT state, policy_json FROM crawl_robots WHERE scan_id = ?1 AND origin = ?2',
  )
    .bind(body.scanId, site.origin)
    .first<{ state: string; policy_json: string | null }>();
  if (!robotsRow) throw new Error('Robots checkpoint is missing.');
  let policy: StoredRobots = robotsRow.policy_json
    ? (JSON.parse(robotsRow.policy_json) as StoredRobots)
    : { body: '', denied: true, delayMs: 0 };
  if (robotsRow.state === 'pending') {
    const wait = await reserveOrigin(
      env,
      lease,
      site.origin,
      Math.max(1000, site.intervalMs),
    );
    if (wait) {
      await checkpoint(
        env,
        lease,
        Math.min(wait, Math.max(0, lease.startedAt + RUN_MS - Date.now())),
        site.origin,
      );
      return;
    }
    if (!(await reserveRequest(env, lease))) return;
    const claimed = await env.DB.prepare(
      `UPDATE crawl_robots SET state = 'attempted'
      WHERE scan_id = ?1 AND origin = ?5 AND state = 'pending' AND EXISTS (${activeSql}) RETURNING origin`,
    )
      .bind(...leaseBindings(lease), site.origin)
      .first();
    if (!claimed) return;
    await setActivity(env, lease, {
      phase: 'fetching_robots',
      origin: site.origin,
      url: `${site.origin}/robots.txt`,
    });
    policy = await fetchServerRobots(site.origin);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE crawl_robots SET state = 'done', policy_json = ?6
        WHERE scan_id = ?1 AND origin = ?5 AND EXISTS (${activeSql})`,
      ).bind(...leaseBindings(lease), site.origin, JSON.stringify(policy)),
      ...scanLogStatements(
        env,
        lease.scanId,
        `robots:${site.origin}`,
        {
          at: new Date().toISOString(),
          type: 'robots_checked',
          level: policy.denied ? 'warning' : 'info',
          origin: site.origin,
          url: `${site.origin}/robots.txt`,
          status: policy.denied ? 'robots_denied' : 'ok',
        },
        { sql: 'changes() = 1', bindings: [] },
      ),
      env.DB.prepare(
        `UPDATE crawl_origin_gates SET next_allowed_at = MAX(next_allowed_at, ?6)
        WHERE origin = ?5 AND EXISTS (${activeSql})`,
      ).bind(...leaseBindings(lease), site.origin, Date.now() + policy.delayMs),
    ]);
    await checkpoint(
      env,
      lease,
      Math.min(
        Math.max(1000, site.intervalMs, policy.delayMs),
        Math.max(0, lease.startedAt + RUN_MS - Date.now()),
      ),
      site.origin,
    );
    return;
  }
  if (robotsAllows(policy, site.origin, candidate.url)) {
    const wait = await reserveOrigin(
      env,
      lease,
      site.origin,
      Math.max(1000, site.intervalMs, policy.delayMs),
    );
    if (wait) {
      await checkpoint(
        env,
        lease,
        Math.min(wait, Math.max(0, lease.startedAt + RUN_MS - Date.now())),
        site.origin,
      );
      return;
    }
    if (!(await reserveRequest(env, lease))) return;
  }
  const claimed = await env.DB.prepare(
    `UPDATE crawl_frontier SET state = 'attempted'
    WHERE scan_id = ?1 AND url = ?5 AND state = 'pending' AND EXISTS (${activeSql}) RETURNING url`,
  )
    .bind(...leaseBindings(lease), candidate.url)
    .first();
  if (!claimed) return;
  await setActivity(env, lease, {
    phase: 'fetching_page',
    origin: site.origin,
    url: candidate.url,
  });
  const result = robotsAllows(policy, site.origin, candidate.url)
    ? await fetchServerPage(candidate.url, site.origin)
    : emptyResult(
        candidate.url,
        'robots_denied',
        'Crawling is not allowed by the site robots policy.',
      );
  await storeResult(env, lease, result, scanSites);
  await checkpoint(env, lease);
}

export async function consumeCrawlBatch(
  batch: MessageBatch<CrawlMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await tick(env, message);
      message.ack();
    } catch {
      console.error(
        JSON.stringify({ message: 'Server crawl checkpoint failed' }),
      );
      message.retry({ delaySeconds: 120 });
    }
  }
}
