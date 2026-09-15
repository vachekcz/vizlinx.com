import {
  normalizeScanUrl,
  isSiteVariant,
  isFollowableRedirect,
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
const RUN_MS = 4 * 60 * 60_000;
const LEASE_MS = 120_000;
export const DAILY_REQUESTS = 10_000;
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
type FrontierRow = {
  url: string;
  origin: string;
  state: string;
  is_preview: number;
  is_manual: number;
  preview_throttled: number;
};

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

type CrawlOwner = { url: string; origin: string; is_preview: number };

// Frontier origins identify the budget owner; URLs retain the network origin.
function originOwners(
  sites: ScanSite[],
  entries: CrawlOwner[],
): Map<string, string> {
  const owners = new Map(sites.map((site) => [site.origin, site.origin]));
  for (const entry of entries) {
    const actual = new URL(entry.url).origin;
    if (!owners.has(actual) && isSiteVariant(entry.origin, actual))
      owners.set(actual, entry.origin);
  }
  return owners;
}

function safeUrls(
  urls: string[],
  origin: string,
  owners = new Map<string, string>(),
): string[] {
  const unique = new Set<string>();
  for (const value of urls) {
    if (unique.size >= FRONTIER_SIZE) break;
    try {
      const url = normalizeScanUrl(value);
      if ((owners.get(new URL(url).origin) ?? new URL(url).origin) === origin)
        unique.add(url);
    } catch {
      // A discovered URL is untrusted, even when imported from a legacy scan.
    }
  }
  return [...unique];
}

function redirectTargets(result: PageResult, origin: string): string[] {
  return isFollowableRedirect(result.redirect) &&
    (result.siteOrigin ?? new URL(result.sourceUrl).origin) === origin &&
    isSiteVariant(origin, result.redirect.targetUrl)
    ? [result.redirect.targetUrl]
    : [];
}

function allowRedirectOrigin(
  result: PageResult,
  owners: Map<string, string>,
  sites: ScanSite[],
): { from: string; to: string } | null {
  const owner =
    owners.get(new URL(result.sourceUrl).origin) ??
    result.siteOrigin ??
    new URL(result.sourceUrl).origin;
  if (
    !isFollowableRedirect(result.redirect) ||
    !isSiteVariant(owner, result.redirect.targetUrl)
  )
    return null;
  const actual = new URL(result.redirect.targetUrl).origin;
  const previous = owners.get(actual);
  if (previous === owner || sites.some((site) => site.origin === previous))
    return null;
  owners.set(actual, owner);
  // Admission may have added a manual page on this origin since the tick read
  // its frontier. The conditional transfer also catches those new rows.
  if (!previous) return { from: actual, to: owner };
  for (const [alias, current] of owners)
    if (current === previous) owners.set(alias, owner);
  return { from: previous, to: owner };
}

function transferOwnerStatements(
  env: Env,
  guard: { scanId: string; generation: number; token?: string },
  transfer: { from: string; to: string },
  sites: ScanSite[],
  sourceUrl: string,
): D1PreparedStatement[] {
  // Keep preview reservations and historical result metadata unchanged.
  const proof = `EXISTS (SELECT 1 FROM scans WHERE id = ?1 AND crawl_generation = ?2
    AND status = 'running' AND execution_mode = 'server'
    AND (?5 IS NULL OR crawl_lease_token = ?5) AND created_at > ?6)
    AND EXISTS (SELECT 1 FROM page_results WHERE scan_id = ?1 AND source_url = ?7)`;
  const bindings = [
    guard.scanId,
    guard.generation,
    transfer.from,
    transfer.to,
    guard.token ?? null,
    Date.now() - RETENTION_MS,
    sourceUrl,
  ];
  const throttled = `EXISTS (SELECT 1 FROM crawl_robots WHERE scan_id = ?1 AND origin = ?3 AND preview_throttled = 1)`;
  const preview = !sites.some((site) => site.origin === transfer.to);
  return [
    env.DB.prepare(
      `UPDATE crawl_frontier SET origin = ?4
      WHERE scan_id = ?1 AND origin = ?3 AND ${proof}`,
    ).bind(...bindings),
    preview
      ? env.DB.prepare(
          `UPDATE crawl_robots SET preview_throttled = 1
        WHERE scan_id = ?1 AND origin = ?4 AND preview_throttled = 0 AND ${proof} AND ${throttled}`,
        ).bind(...bindings)
      : env.DB.prepare(
          `UPDATE scans SET sites_json = (
          SELECT json_group_array(json(CASE WHEN json_extract(value, '$.origin') = ?4
            THEN json_set(value, '$.paused', json('true')) ELSE value END)) FROM json_each(sites_json))
        WHERE id = ?1 AND ${proof} AND ${throttled}
        AND EXISTS (SELECT 1 FROM json_each(sites_json) WHERE json_extract(value, '$.origin') = ?4 AND json_extract(value, '$.paused') = 0)`,
        ).bind(...bindings),
    ...scanLogStatements(
      env,
      guard.scanId,
      `throttled:alias:${transfer.from}:${transfer.to}`,
      {
        at: new Date().toISOString(),
        type: 'site_throttled',
        level: 'warning',
        origin: transfer.to,
        httpStatus: 429,
        ...(preview ? { crawlMode: 'preview' as const } : {}),
      },
      { sql: 'changes() = 1', bindings: [] },
    ),
  ];
}

function addFrontier(
  env: Env,
  id: string,
  origin: string,
  urls: string[],
  generation: number,
  owners = new Map<string, string>(),
) {
  const candidates = safeUrls(urls, origin, owners);
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < candidates.length; offset += 200) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO crawl_frontier (scan_id, url, origin)
    SELECT ?1, value, ?2 FROM json_each(?3)
    WHERE EXISTS (SELECT 1 FROM scans WHERE id = ?1 AND crawl_generation = ?4 AND status = 'running')
      AND NOT EXISTS (SELECT 1 FROM crawl_frontier WHERE scan_id = ?1 AND url = value)
    ORDER BY CAST(key AS INTEGER)
    LIMIT MAX(0, ?5 - (SELECT COUNT(*) FROM crawl_frontier WHERE scan_id = ?1 AND origin = ?2))`,
      ).bind(
        id,
        origin,
        JSON.stringify(candidates.slice(offset, offset + 200)),
        generation,
        FRONTIER_SIZE,
      ),
    );
  }
  return statements;
}

function previewFrontierStatements(
  env: Env,
  guard: { scanId: string; generation: number; token: string | null },
  urls: string[],
  sites: ScanSite[],
  sourceUrl: string | null = null,
  existing?: CrawlOwner[],
  owners = new Map<string, string>(),
): D1PreparedStatement[] {
  const scoped = new Set(sites.map((site) => site.origin));
  const known = new Set(existing?.map((entry) => entry.url));
  const previewCounts = new Map<string, number>();
  let remaining = SCAN_LIMITS.previewPagesPerScan;
  for (const entry of existing ?? []) {
    if (!entry.is_preview) continue;
    remaining--;
    previewCounts.set(entry.origin, (previewCounts.get(entry.origin) ?? 0) + 1);
  }
  const candidates = new Map<string, { url: string; origin: string }>();
  for (const value of urls) {
    // A resumed map can contain megabytes of links. Preselect only the remaining
    // slots before binding JSON; SQL still enforces the limits atomically.
    if (remaining <= 0) break;
    try {
      const url = normalizeScanUrl(value);
      const actualOrigin = new URL(url).origin;
      const origin = owners.get(actualOrigin) ?? actualOrigin;
      if (scoped.has(origin) || known.has(url) || candidates.has(url)) continue;
      if ((previewCounts.get(origin) ?? 0) >= SCAN_LIMITS.previewPagesPerSite)
        continue;
      candidates.set(url, { url, origin });
      previewCounts.set(origin, (previewCounts.get(origin) ?? 0) + 1);
      remaining--;
    } catch {
      // External targets have the same public-network restrictions as scan seeds.
    }
  }
  if (!candidates.size) return [];
  const guardSql = `SELECT 1 FROM scans WHERE id = ?1 AND crawl_generation = ?2
    AND (?3 IS NULL OR crawl_lease_token = ?3) AND status = 'running'
    AND execution_mode = 'server' AND created_at > ?4`;
  const bindings = [
    guard.scanId,
    guard.generation,
    guard.token,
    Date.now() - RETENTION_MS,
  ];
  return [
    env.DB.prepare(
      `INSERT OR IGNORE INTO crawl_frontier (scan_id, url, origin, is_preview)
      WITH candidates AS (
        SELECT json_extract(value, '$.url') AS url,
          json_extract(value, '$.origin') AS origin, CAST(key AS INTEGER) AS position
        FROM json_each(?5)
        WHERE NOT EXISTS (SELECT 1 FROM crawl_frontier
          WHERE scan_id = ?1 AND url = json_extract(value, '$.url'))
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY origin ORDER BY position) AS origin_position
        FROM candidates
      )
      SELECT ?1, url, origin, 1 FROM ranked
      WHERE EXISTS (${guardSql})
        AND (?8 IS NULL OR EXISTS (SELECT 1 FROM page_results WHERE scan_id = ?1 AND source_url = ?8))
        AND origin_position + (SELECT COUNT(*) FROM crawl_frontier f
          WHERE f.scan_id = ?1 AND f.is_preview = 1 AND f.origin = ranked.origin) <= ?6
      ORDER BY position
      LIMIT MAX(0, ?7 - (SELECT COUNT(*) FROM crawl_frontier WHERE scan_id = ?1 AND is_preview = 1))`,
    ).bind(
      ...bindings,
      JSON.stringify([...candidates.values()]),
      SCAN_LIMITS.previewPagesPerSite,
      SCAN_LIMITS.previewPagesPerScan,
      sourceUrl,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO crawl_robots (scan_id, origin)
      SELECT DISTINCT scan_id, origin FROM crawl_frontier
      WHERE scan_id = ?1 AND is_preview = 1 AND EXISTS (${guardSql})`,
    ).bind(...bindings),
  ];
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

export async function enqueueManualPage(
  env: Env,
  scanId: string,
  value: unknown,
  expectedGeneration: number,
): Promise<void> {
  if (env.CRAWLER_ENABLED !== 'true')
    throw new ApiError(503, 'Server scanning is temporarily disabled.');
  let url: string;
  try {
    if (typeof value !== 'string') throw new Error('Invalid URL.');
    url = normalizeScanUrl(value);
  } catch {
    throw new ApiError(400, 'A public HTTP(S) page URL is required.');
  }
  const now = Date.now();
  const row = await env.DB.prepare(
    'SELECT * FROM scans WHERE id = ?1 AND created_at > ?2',
  )
    .bind(scanId, now - RETENTION_MS)
    .first<ScanRow>();
  if (!row) throw new ApiError(404, 'Scan not found.');
  if (row.crawl_generation !== expectedGeneration)
    throw new ApiError(409, 'The scan changed. Reload before scanning a page.');
  if (row.status === 'paused')
    throw new ApiError(409, 'Resume the scan before scanning a page.');
  if (row.execution_mode !== 'server' || !row.crawl_ready)
    throw new ApiError(
      409,
      'Start the server scan before scanning individual pages.',
    );
  const alreadyFetching = async () =>
    Boolean(
      await env.DB.prepare(
        `SELECT 1 FROM crawl_frontier f JOIN scans s ON s.id = f.scan_id
    WHERE f.scan_id = ?1 AND f.url = ?2 AND f.state = 'attempted'
      AND s.status = 'running' AND s.crawl_generation = ?3`,
      )
        .bind(scanId, url, expectedGeneration)
        .first(),
    );
  if (await alreadyFetching()) return;
  const saved = await env.DB.prepare(
    'SELECT result_json FROM page_results WHERE scan_id = ?1',
  )
    .bind(scanId)
    .all<{ result_json: string }>();
  const results = saved.results.map(
    (entry) => JSON.parse(entry.result_json) as PageResult,
  );
  if (results.some((result) => result.sourceUrl === url)) return;
  const actualOrigin = new URL(url).origin;
  const scanSites = JSON.parse(row.sites_json) as ScanSite[];
  const entries = (
    await env.DB.prepare(
      'SELECT url, origin, is_preview FROM crawl_frontier WHERE scan_id = ?1',
    )
      .bind(scanId)
      .all<CrawlOwner>()
  ).results;
  const owners = originOwners(scanSites, entries);
  for (const result of results) allowRedirectOrigin(result, owners, scanSites);
  const origin = owners.get(actualOrigin) ?? actualOrigin;
  const known =
    scanSites.some((site) => site.seedUrl === url) ||
    results.some((result) =>
      safeUrls(
        [
          ...result.discoveredUrls,
          ...result.links.map((link) => link.targetUrl),
          ...(result.redirect?.targetUrl ? [result.redirect.targetUrl] : []),
        ],
        origin,
        owners,
      ).includes(url),
    );
  if (!known)
    throw new ApiError(400, 'The page has not been discovered in this scan.');
  if (
    ['time_limit', 'scan_storage_limit'].includes(row.limit_reason ?? '') ||
    (row.status === 'running' && now - (row.crawl_started_at ?? now) >= RUN_MS)
  )
    throw new ApiError(429, 'This scan reached its safety limit.');
  if (scanSites.some((site) => site.origin === origin && site.paused))
    throw new ApiError(409, 'Resume this site before scanning a page.');
  const throttled = await env.DB.prepare(
    'SELECT preview_throttled FROM crawl_robots WHERE scan_id = ?1 AND origin = ?2',
  )
    .bind(scanId, origin)
    .first<{ preview_throttled: number }>();
  if (
    throttled?.preview_throttled &&
    !scanSites.some((site) => site.origin === origin)
  )
    throw new ApiError(
      429,
      'This site paused scanning after an HTTP 429 response.',
    );
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

  // Adding work to a running scan preserves its lease and in-flight response.
  // Generation and the observed results guard keep redirect ownership current
  // if an in-flight response confirms another alias during admission.
  const guard = `SELECT 1 FROM scans WHERE id = ?1 AND crawl_generation = ?2
    AND execution_mode = 'server' AND crawl_ready = 1 AND created_at > ?3
    AND (SELECT COUNT(*) FROM page_results WHERE scan_id = ?1) = ?8
    AND COALESCE(limit_reason, '') NOT IN ('time_limit', 'scan_storage_limit') AND status != 'paused'
    AND NOT EXISTS (SELECT 1 FROM json_each(sites_json) WHERE json_extract(value, '$.origin') = ?5 AND json_extract(value, '$.paused') = 1)
    AND (EXISTS (SELECT 1 FROM json_each(sites_json) WHERE json_extract(value, '$.origin') = ?5)
      OR NOT EXISTS (SELECT 1 FROM crawl_robots WHERE scan_id = ?1 AND origin = ?5 AND preview_throttled = 1))`;
  const bindings = [
    scanId,
    expectedGeneration,
    now - RETENTION_MS,
    url,
    origin,
  ];
  const admitted = await env.DB.batch<ScanRow>([
    env.DB.prepare(
      `INSERT INTO crawl_frontier (scan_id, url, origin, is_manual)
      SELECT ?1, ?4, ?5, 1 WHERE EXISTS (${guard})
        AND NOT EXISTS (SELECT 1 FROM page_results WHERE scan_id = ?1 AND source_url = ?4)
        AND (SELECT COALESCE(SUM(result_bytes), 0) FROM page_results WHERE scan_id = ?1) < ?7
        AND ((SELECT COUNT(*) FROM (
          SELECT p.source_url AS url FROM page_results p LEFT JOIN crawl_frontier f
            ON f.scan_id = p.scan_id AND f.url = p.source_url
          WHERE p.scan_id = ?1 AND COALESCE(f.origin, json_extract(p.result_json, '$.siteOrigin'), p.source_origin) = ?5
          UNION SELECT url FROM crawl_frontier WHERE scan_id = ?1 AND origin = ?5 AND (state != 'pending' OR is_manual = 1)
        )) < ?6 OR EXISTS (SELECT 1 FROM crawl_frontier WHERE scan_id = ?1 AND url = ?4 AND is_manual = 1))
      ON CONFLICT(scan_id, url) DO UPDATE SET is_manual = 1
        WHERE state = 'pending' AND is_manual = 0`,
    ).bind(
      ...bindings,
      SCAN_LIMITS.pagesPerSite,
      MAX_SCAN_BYTES,
      results.length,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO crawl_robots (scan_id, origin)
      SELECT ?1, ?5 WHERE EXISTS (${guard})
      AND EXISTS (SELECT 1 FROM crawl_frontier WHERE scan_id = ?1 AND url = ?4 AND is_manual = 1)`,
    ).bind(...bindings, null, null, results.length),
    env.DB.prepare(
      `UPDATE scans SET status = 'running', limit_reason = NULL, updated_at = ?6,
        crawl_generation = crawl_generation + CASE WHEN status = 'running' THEN 0 ELSE 1 END,
        crawl_tick = CASE WHEN status = 'running' THEN crawl_tick ELSE 0 END,
        crawl_enqueued_tick = CASE WHEN status = 'running' THEN crawl_enqueued_tick ELSE -1 END,
        crawl_started_at = CASE WHEN status = 'running' THEN crawl_started_at ELSE ?6 END,
        crawl_lease_token = CASE WHEN status = 'running' THEN crawl_lease_token ELSE NULL END,
        crawl_lease_until = CASE WHEN status = 'running' THEN crawl_lease_until ELSE NULL END,
        heartbeat_at = CASE WHEN status = 'running' THEN heartbeat_at ELSE ?6 END,
        activity_json = CASE WHEN status = 'running' THEN activity_json ELSE ?7 END
      WHERE id = ?1 AND EXISTS (${guard})
        AND EXISTS (SELECT 1 FROM crawl_frontier WHERE scan_id = ?1 AND url = ?4 AND origin = ?5 AND is_manual = 1 AND state != 'done')
      RETURNING *`,
    ).bind(
      ...bindings,
      now,
      JSON.stringify({
        phase: 'queued',
        crawlMode: 'manual',
        url,
        origin,
        updatedAt: new Date(now).toISOString(),
      }),
      results.length,
    ),
  ]);
  const updated = admitted[2].results[0];
  if (!updated) {
    const current = await env.DB.prepare(
      'SELECT crawl_generation, (SELECT COUNT(*) FROM page_results WHERE scan_id = ?1) AS result_count FROM scans WHERE id = ?1',
    )
      .bind(scanId)
      .first<{ crawl_generation: number; result_count: number }>();
    if (current?.crawl_generation !== expectedGeneration)
      throw new ApiError(
        409,
        'The scan changed. Reload before scanning a page.',
      );
    if (await alreadyFetching()) return;
    if (
      await env.DB.prepare(
        'SELECT 1 FROM page_results WHERE scan_id = ?1 AND source_url = ?2',
      )
        .bind(scanId, url)
        .first()
    )
      return;
    if (current?.result_count !== results.length)
      throw new ApiError(
        409,
        'The scan changed. Reload before scanning a page.',
      );
    throw new ApiError(429, 'The page or storage limit has been reached.');
  }
  await enqueueCurrent(env, updated);
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
        `INSERT OR IGNORE INTO crawl_frontier (scan_id, url, origin, state, is_preview, is_manual)
        SELECT scan_id, source_url, COALESCE(json_extract(result_json, '$.siteOrigin'), source_origin), 'done',
          CASE WHEN json_extract(result_json, '$.crawlMode') = 'preview' THEN 1 ELSE 0 END,
          CASE WHEN json_extract(result_json, '$.crawlMode') = 'manual' THEN 1 ELSE 0 END
        FROM page_results WHERE scan_id = ?1
        AND EXISTS (SELECT 1 FROM scans WHERE id = ?1 AND crawl_generation = ?2)`,
      ).bind(scanId, updated.crawl_generation),
      ...scanSites.map((site) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO crawl_robots (scan_id, origin)
        SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM scans WHERE id = ?1 AND crawl_generation = ?3)`,
        ).bind(scanId, site.origin, updated.crawl_generation),
      ),
      ...scanSites.flatMap((site) =>
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
    const savedResults = saved.results.map(
      ({ result_json }) => JSON.parse(result_json) as PageResult,
    );
    const existing = (
      await env.DB.prepare(
        'SELECT url, origin, is_preview FROM crawl_frontier WHERE scan_id = ?1',
      )
        .bind(scanId)
        .all<CrawlOwner>()
    ).results;
    const owners = originOwners(scanSites, existing);
    for (const result of savedResults) {
      const transfer = allowRedirectOrigin(result, owners, scanSites);
      if (transfer) {
        await env.DB.batch(
          transferOwnerStatements(
            env,
            { scanId, generation: updated.crawl_generation },
            transfer,
            scanSites,
            result.sourceUrl,
          ),
        );
        for (const entry of existing)
          if (entry.origin === transfer.from) entry.origin = transfer.to;
      }
    }
    const scoped = new Set(scanSites.map((site) => site.origin));
    const fullResults = savedResults.filter(
      (result) =>
        result.crawlMode !== 'manual' &&
        scoped.has(
          owners.get(new URL(result.sourceUrl).origin) ??
            result.siteOrigin ??
            new URL(result.sourceUrl).origin,
        ),
    );
    for (const site of scanSites) {
      const discovered = fullResults.flatMap((result) => {
        return [
          ...redirectTargets(result, site.origin),
          ...result.discoveredUrls,
          ...result.links.map((link) => link.targetUrl),
        ];
      });
      if (discovered.length)
        for (const statement of addFrontier(
          env,
          scanId,
          site.origin,
          discovered,
          updated.crawl_generation,
          owners,
        ))
          await statement.run();
    }
    const previewUrls = savedResults
      .filter((result) => result.crawlMode !== 'manual')
      .flatMap((result) =>
        scoped.has(
          owners.get(new URL(result.sourceUrl).origin) ??
            result.siteOrigin ??
            new URL(result.sourceUrl).origin,
        )
          ? result.links.map((link) => link.targetUrl)
          : redirectTargets(
              result,
              result.siteOrigin ?? new URL(result.sourceUrl).origin,
            ),
      );
    const previewStatements = previewFrontierStatements(
      env,
      { scanId, generation: updated.crawl_generation, token: null },
      previewUrls,
      scanSites,
      null,
      existing,
      owners,
    );
    if (previewStatements.length) await env.DB.batch(previewStatements);
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
  const [finished] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE scans SET status = ?5, limit_reason = ?6,
      crawl_lease_token = NULL, crawl_lease_until = NULL, heartbeat_at = ?7, updated_at = ?7,
      activity_json = ?8 WHERE EXISTS (${activeSql}) AND id = ?1
      AND (?10 = 1 OR ?6 IS NOT NULL AND ?6 != 'page_limit' OR NOT EXISTS (
        SELECT 1 FROM crawl_frontier f JOIN crawl_robots r ON r.scan_id = f.scan_id AND r.origin = f.origin
        WHERE f.scan_id = ?1 AND f.is_manual = 1 AND f.state != 'done'
          AND (EXISTS (SELECT 1 FROM json_each(scans.sites_json) WHERE json_extract(value, '$.origin') = f.origin AND json_extract(value, '$.paused') = 0)
            OR (r.preview_throttled = 0 AND NOT EXISTS (SELECT 1 FROM json_each(scans.sites_json) WHERE json_extract(value, '$.origin') = f.origin)))
          AND (SELECT COUNT(*) FROM crawl_frontier c WHERE c.scan_id = ?1 AND c.origin = f.origin AND c.state != 'pending') < ?9
      ))`,
    ).bind(
      ...leaseBindings(lease),
      phase,
      reason,
      now,
      JSON.stringify({ phase, updatedAt: new Date(now).toISOString() }),
      SCAN_LIMITS.pagesPerSite,
      env.CRAWLER_ENABLED !== 'true' ? 1 : 0,
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
  if (!finished.meta.changes && (!reason || reason === 'page_limit'))
    await checkpoint(env, lease);
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
  preview = false,
  manual = false,
): Promise<void> {
  const now = Date.now();
  const activity: ScanActivity = {
    phase: delayMs > 0 ? 'waiting' : 'queued',
    updatedAt: new Date(now).toISOString(),
    ...(origin ? { origin } : {}),
    ...(manual
      ? { crawlMode: 'manual' as const }
      : preview
        ? { crawlMode: 'preview' as const }
        : {}),
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
  candidate: FrontierRow,
  frontier: FrontierRow[],
): Promise<void> {
  const origin = candidate.origin;
  const manual = candidate.is_manual === 1;
  const actualOrigin = new URL(result.sourceUrl).origin;
  if (origin !== actualOrigin) result = { ...result, siteOrigin: origin };
  if (
    isFollowableRedirect(result.redirect) &&
    !isSiteVariant(origin, result.redirect.targetUrl)
  ) {
    result = {
      ...result,
      redirect: { kind: 'external', targetUrl: result.redirect.targetUrl },
      error: 'Redirect leaves the scan site and was not followed.',
    };
  }
  const owners = originOwners(sites, frontier);
  if (isFollowableRedirect(result.redirect)) {
    // Manual redirects provide alias evidence without queuing their targets.
    // Recover that evidence before attaching a previously known alias group.
    const saved = await env.DB.prepare(
      `SELECT result_json FROM page_results WHERE scan_id = ?1
      AND json_extract(result_json, '$.crawlMode') = 'manual'
      AND json_extract(result_json, '$.redirect.kind') IN ('same_origin', 'site_variant')`,
    )
      .bind(lease.scanId)
      .all<{ result_json: string }>();
    for (const entry of saved.results)
      allowRedirectOrigin(
        JSON.parse(entry.result_json) as PageResult,
        owners,
        sites,
      );
  }
  const transfer = allowRedirectOrigin(result, owners, sites);
  const preview = !sites.some((site) => site.origin === origin);
  if (manual) result = { ...result, crawlMode: 'manual' };
  else if (preview) result = { ...result, crawlMode: 'preview' };
  const promotedResults: PageResult[] =
    transfer && !preview
      ? (
          await env.DB.prepare(
            `SELECT p.result_json FROM page_results p JOIN crawl_frontier f
        ON f.scan_id = p.scan_id AND f.url = p.source_url WHERE p.scan_id = ?1 AND f.origin = ?2`,
          )
            .bind(lease.scanId, transfer.from)
            .all<{ result_json: string }>()
        ).results.map(
          ({ result_json }) =>
            ({ ...JSON.parse(result_json), siteOrigin: origin }) as PageResult,
        )
      : [];
  const fullResults =
    preview || manual
      ? []
      : [result, ...promotedResults].filter(
          (saved) => saved.crawlMode !== 'manual',
        );
  const json = JSON.stringify(result);
  const encoded = new TextEncoder().encode(json);
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  const results = await env.DB.batch<{ stored?: number }>([
    env.DB.prepare(
      `INSERT INTO page_results (scan_id, source_url, source_origin, result_hash, result_json, result_bytes)
      SELECT ?1, ?5, ?6, ?7, ?8, ?9 WHERE EXISTS (${activeSql})
      AND (SELECT COUNT(*) FROM page_results p JOIN crawl_frontier f
        ON f.scan_id = p.scan_id AND f.url = p.source_url
        WHERE p.scan_id = ?1 AND f.origin = ?12) < ?10
      AND (SELECT COALESCE(SUM(result_bytes), 0) FROM page_results WHERE scan_id = ?1) + ?9 <= ?11
      ON CONFLICT(scan_id, source_url) DO NOTHING`,
    ).bind(
      ...leaseBindings(lease),
      result.sourceUrl,
      actualOrigin,
      hash,
      json,
      encoded.byteLength,
      SCAN_LIMITS.pagesPerSite,
      MAX_SCAN_BYTES,
      origin,
    ),
    ...scanLogStatements(
      env,
      lease.scanId,
      `page:${result.sourceUrl}`,
      {
        at: new Date().toISOString(),
        type: 'page_finished',
        ...(manual
          ? { crawlMode: 'manual' as const }
          : preview
            ? { crawlMode: 'preview' as const }
            : {}),
        level: ['http_error', 'network_error', 'robots_unavailable'].includes(
          result.status,
        )
          ? 'error'
          : result.status === 'ok' || isFollowableRedirect(result.redirect)
            ? 'info'
            : 'warning',
        origin,
        url: result.sourceUrl,
        status: result.status,
        ...(result.redirect ? { redirect: result.redirect } : {}),
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
    ...(result.httpStatus === 429
      ? [
          preview
            ? env.DB.prepare(
                `UPDATE crawl_robots SET preview_throttled = 1
                WHERE scan_id = ?1 AND origin = ?5 AND EXISTS (${activeSql})
                AND EXISTS (SELECT 1 FROM page_results WHERE scan_id = ?1 AND source_url = ?6)`,
              ).bind(...leaseBindings(lease), origin, result.sourceUrl)
            : env.DB.prepare(
                `UPDATE scans SET sites_json = ?5 WHERE id = ?1 AND EXISTS (${activeSql})
            AND sites_json != ?5
            AND EXISTS (SELECT 1 FROM page_results WHERE scan_id = ?1 AND source_url = ?6)`,
              ).bind(
                ...leaseBindings(lease),
                JSON.stringify(
                  sites.map((site) =>
                    site.origin === origin ? { ...site, paused: true } : site,
                  ),
                ),
                result.sourceUrl,
              ),
          ...scanLogStatements(
            env,
            lease.scanId,
            `throttled:${result.sourceUrl}`,
            {
              at: new Date().toISOString(),
              type: 'site_throttled',
              ...(manual
                ? { crawlMode: 'manual' as const }
                : preview
                  ? { crawlMode: 'preview' as const }
                  : {}),
              level: 'warning',
              origin,
              url: result.sourceUrl,
              httpStatus: 429,
            },
            { sql: 'changes() = 1', bindings: [] },
          ),
        ]
      : []),
    ...(transfer
      ? transferOwnerStatements(env, lease, transfer, sites, result.sourceUrl)
      : []),
    // The result, completed frontier entry and newly discovered links commit together.
    ...(manual ? [] : sites).map((site) =>
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
              ...redirectTargets(result, origin),
              ...fullResults.flatMap((saved) => [
                ...redirectTargets(saved, origin),
                ...saved.discoveredUrls,
                ...saved.links.map((link) => link.targetUrl),
              ]),
            ],
            site.origin,
            owners,
          ),
        ),
        result.sourceUrl,
        FRONTIER_SIZE,
      ),
    ),
    ...previewFrontierStatements(
      env,
      lease,
      manual
        ? []
        : preview
          ? redirectTargets(result, origin)
          : fullResults.flatMap((saved) =>
              saved.links.map((link) => link.targetUrl),
            ),
      sites,
      result.sourceUrl,
      frontier.map((entry) =>
        transfer && entry.origin === transfer.from
          ? { ...entry, origin: transfer.to }
          : entry,
      ),
      owners,
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
      `SELECT f.url, f.origin, f.state, f.is_preview, f.is_manual,
        COALESCE(r.preview_throttled, 0) AS preview_throttled
      FROM crawl_frontier f LEFT JOIN crawl_robots r
        ON r.scan_id = f.scan_id AND r.origin = f.origin
      WHERE f.scan_id = ?1 ORDER BY f.is_manual DESC, f.rowid`,
    )
      .bind(body.scanId)
      .all<FrontierRow>()
  ).results;
  const activeSites = scanSites.filter((site) => !site.paused);
  const isEligible = (entry: FrontierRow) => {
    const scopedSite = scanSites.find((site) => site.origin === entry.origin);
    return scopedSite
      ? !scopedSite.paused
      : (entry.is_preview === 1 || entry.is_manual === 1) &&
          !entry.preview_throttled;
  };
  const counts = new Map<string, number>();
  const previewCounts = new Map<string, number>();
  for (const entry of frontier) {
    if (entry.state === 'pending') continue;
    counts.set(entry.origin, (counts.get(entry.origin) ?? 0) + 1);
    if (entry.is_preview)
      previewCounts.set(
        entry.origin,
        (previewCounts.get(entry.origin) ?? 0) + 1,
      );
  }
  const candidate =
    frontier.find(
      (entry) => entry.state === 'attempted' && isEligible(entry),
    ) ??
    frontier.find(
      (entry) =>
        entry.state === 'pending' &&
        isEligible(entry) &&
        (counts.get(entry.origin) ?? 0) < SCAN_LIMITS.pagesPerSite &&
        (entry.is_manual === 1 ||
          scanSites.some((site) => site.origin === entry.origin) ||
          (previewCounts.get(entry.origin) ?? 0) <
            SCAN_LIMITS.previewPagesPerSite),
    );
  if (!candidate) {
    const limited =
      scanSites.some(
        (site) => (counts.get(site.origin) ?? 0) >= SCAN_LIMITS.pagesPerSite,
      ) ||
      frontier.some(
        (entry) =>
          entry.is_manual === 1 &&
          (counts.get(entry.origin) ?? 0) >= SCAN_LIMITS.pagesPerSite,
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
      candidate,
      frontier,
    );
    await checkpoint(env, lease);
    return;
  }
  const scopedSite = activeSites.find(
    (site) => site.origin === candidate.origin,
  );
  const preview = !scopedSite;
  let manual = candidate.is_manual === 1;
  const site = scopedSite ?? {
    origin: candidate.origin,
    intervalMs: 3000,
  };
  const networkOrigin = new URL(candidate.url).origin;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO crawl_robots (scan_id, origin)
    SELECT ?1, ?5 WHERE EXISTS (${activeSql})`,
  )
    .bind(...leaseBindings(lease), networkOrigin)
    .run();
  const robotsRow = await env.DB.prepare(
    'SELECT state, policy_json FROM crawl_robots WHERE scan_id = ?1 AND origin = ?2',
  )
    .bind(body.scanId, networkOrigin)
    .first<{ state: string; policy_json: string | null }>();
  if (!robotsRow) throw new Error('Robots checkpoint is missing.');
  type RobotsCheckpoint = StoredRobots & {
    nextUrl?: string;
    visitedUrls?: string[];
  };
  let policy: RobotsCheckpoint = robotsRow.policy_json
    ? (JSON.parse(robotsRow.policy_json) as RobotsCheckpoint)
    : { body: '', denied: true, delayMs: 0 };
  if (robotsRow.state === 'pending') {
    const robotsUrl = policy.nextUrl ?? `${networkOrigin}/robots.txt`;
    const robotsOrigin = new URL(robotsUrl).origin;
    const wait = await reserveOrigin(
      env,
      lease,
      robotsOrigin,
      Math.max(1000, site.intervalMs),
    );
    if (wait) {
      await checkpoint(
        env,
        lease,
        Math.min(wait, Math.max(0, lease.startedAt + RUN_MS - Date.now())),
        robotsOrigin,
        preview,
        manual,
      );
      return;
    }
    if (!(await reserveRequest(env, lease))) return;
    const claimed = await env.DB.prepare(
      `UPDATE crawl_robots SET state = 'attempted'
      WHERE scan_id = ?1 AND origin = ?5 AND state = 'pending' AND EXISTS (${activeSql}) RETURNING origin`,
    )
      .bind(...leaseBindings(lease), networkOrigin)
      .first();
    if (!claimed) return;
    await setActivity(env, lease, {
      phase: 'fetching_robots',
      ...(manual
        ? { crawlMode: 'manual' as const }
        : preview
          ? { crawlMode: 'preview' as const }
          : {}),
      origin: site.origin,
      url: robotsUrl,
    });
    const visitedUrls = [...(policy.visitedUrls ?? []), robotsUrl];
    policy = await fetchServerRobots(networkOrigin, robotsUrl);
    if (isFollowableRedirect(policy.redirect)) {
      const targetUrl = policy.redirect.targetUrl;
      const reason = visitedUrls.includes(targetUrl)
        ? 'redirect_loop'
        : visitedUrls.length > 5
          ? 'redirect_limit'
          : null;
      policy = reason
        ? { ...policy, redirect: { kind: 'invalid', targetUrl, reason } }
        : { ...policy, nextUrl: targetUrl, visitedUrls };
    }
    const continuing = !!policy.nextUrl;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE crawl_robots SET state = ?7, policy_json = ?6
        WHERE scan_id = ?1 AND origin = ?5 AND EXISTS (${activeSql})`,
      ).bind(
        ...leaseBindings(lease),
        networkOrigin,
        JSON.stringify(policy),
        continuing ? 'pending' : 'done',
      ),
      ...scanLogStatements(
        env,
        lease.scanId,
        `robots:${networkOrigin}:${robotsUrl}`,
        {
          at: new Date().toISOString(),
          type: 'robots_checked',
          ...(manual
            ? { crawlMode: 'manual' as const }
            : preview
              ? { crawlMode: 'preview' as const }
              : {}),
          level: policy.denied && !continuing ? 'error' : 'info',
          origin: site.origin,
          url: robotsUrl,
          status: continuing
            ? 'redirect_unresolved'
            : policy.denied
              ? 'robots_unavailable'
              : 'ok',
          ...(policy.httpStatus !== undefined
            ? { httpStatus: policy.httpStatus }
            : {}),
          ...(policy.redirect ? { redirect: policy.redirect } : {}),
        },
        { sql: 'changes() = 1', bindings: [] },
      ),
      env.DB.prepare(
        `UPDATE crawl_origin_gates SET next_allowed_at = MAX(next_allowed_at, ?7)
        WHERE origin IN (?5, ?6) AND EXISTS (${activeSql})`,
      ).bind(
        ...leaseBindings(lease),
        robotsOrigin,
        networkOrigin,
        Date.now() + policy.delayMs,
      ),
    ]);
    await checkpoint(
      env,
      lease,
      Math.min(
        Math.max(1000, site.intervalMs, policy.delayMs),
        Math.max(0, lease.startedAt + RUN_MS - Date.now()),
      ),
      site.origin,
      preview,
      manual,
    );
    return;
  }
  if (robotsAllows(policy, networkOrigin, candidate.url)) {
    const wait = await reserveOrigin(
      env,
      lease,
      networkOrigin,
      Math.max(1000, site.intervalMs, policy.delayMs),
    );
    if (wait) {
      await checkpoint(
        env,
        lease,
        Math.min(wait, Math.max(0, lease.startedAt + RUN_MS - Date.now())),
        site.origin,
        preview,
        manual,
      );
      return;
    }
    if (!(await reserveRequest(env, lease))) return;
  }
  const claimed = await env.DB.prepare(
    `UPDATE crawl_frontier SET state = 'attempted'
    WHERE scan_id = ?1 AND url = ?5 AND state = 'pending' AND EXISTS (${activeSql})
    AND (SELECT COUNT(*) FROM crawl_frontier WHERE scan_id = ?1 AND origin = ?6
      AND url != ?5 AND (state != 'pending' OR is_manual = 1)) < ?7
    RETURNING url, is_manual`,
  )
    .bind(
      ...leaseBindings(lease),
      candidate.url,
      candidate.origin,
      SCAN_LIMITS.pagesPerSite,
    )
    .first<{ url: string; is_manual: number }>();
  if (!claimed) {
    await checkpoint(env, lease);
    return;
  }
  manual = claimed.is_manual === 1;
  await setActivity(env, lease, {
    phase: 'fetching_page',
    ...(manual
      ? { crawlMode: 'manual' as const }
      : preview
        ? { crawlMode: 'preview' as const }
        : {}),
    origin: site.origin,
    url: candidate.url,
  });
  const result = robotsAllows(policy, networkOrigin, candidate.url)
    ? await fetchServerPage(candidate.url, networkOrigin)
    : emptyResult(
        candidate.url,
        policy.denied ? 'robots_unavailable' : 'robots_denied',
        policy.denied
          ? 'Crawling stopped because the site robots policy could not be loaded.'
          : 'Crawling is not allowed by the site robots policy.',
      );
  await storeResult(
    env,
    lease,
    result,
    scanSites,
    { ...candidate, is_manual: manual ? 1 : 0 },
    frontier,
  );
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
