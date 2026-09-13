import {
  SCAN_LIMITS,
  type PageResult,
  type ScanActivity,
  type ScanControl,
  type ScanHistory,
  type ScanLogEvent,
  type ScanLogResponse,
  type ScanRunSummary,
  type ScanSite,
  type ScanSnapshot,
  type ScanStatus,
} from '../shared/scan';
import { DAILY_REQUESTS, startServerScan } from './crawler';
import { ApiError } from './validation';

const RETENTION_MS = 30 * 86_400_000;
export type ScanRow = {
  id: string;
  owner_hash: string;
  status: ScanStatus;
  sites_json: string;
  created_at: number;
  updated_at: number;
  heartbeat_at: number | null;
  runner_hash: string | null;
  execution_mode: 'extension' | 'server';
  crawl_generation: number;
  limit_reason: ScanControl['limitReason'] | null;
  activity_json: string | null;
  run_id: string | null;
  run_number: number;
  run_created_at: number | null;
};
type ArchivedRow = {
  id: string;
  scan_id: string;
  run_number: number;
  created_at: number;
  updated_at: number;
  status: ScanStatus;
  sites_json: string;
  limit_reason: ScanControl['limitReason'] | null;
  activity_json: string | null;
  page_count: number;
  map_created_at: number;
  scan_log_truncated: number;
};

export function control(row: ScanRow): ScanControl {
  return {
    id: row.id,
    status:
      row.status === 'running' &&
      (row.heartbeat_at ?? 0) <
        Date.now() - (row.execution_mode === 'server' ? 20 * 60_000 : 90_000)
        ? 'interrupted'
        : row.status,
    sites: JSON.parse(row.sites_json) as ScanSite[],
    ...(row.limit_reason ? { limitReason: row.limit_reason } : {}),
  };
}

export function currentSummary(
  row: ScanRow,
  pageCount: number,
): ScanRunSummary {
  return {
    ...control(row),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    pageCount,
    runId: row.run_id ?? row.id,
    runNumber: row.run_number,
    runCreatedAt: new Date(row.run_created_at ?? row.created_at).toISOString(),
    archived: false,
  };
}

function archivedSummary(row: ArchivedRow): ScanRunSummary {
  return {
    id: row.scan_id,
    status: row.status,
    sites: JSON.parse(row.sites_json) as ScanSite[],
    createdAt: new Date(row.map_created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    pageCount: row.page_count,
    runId: row.id,
    runNumber: row.run_number,
    runCreatedAt: new Date(row.created_at).toISOString(),
    archived: true,
    ...(row.limit_reason ? { limitReason: row.limit_reason } : {}),
  };
}

// The owning map must be authorized by the caller. Each batch reads one coherent
// view even if another request archives the current run concurrently.
export async function readRunSnapshot(
  env: Env,
  scanId: string,
  runId: string | null = null,
): Promise<ScanSnapshot> {
  const cutoff = Date.now() - RETENTION_MS;
  const [current, archived, pages] = await env.DB.batch<
    Record<string, unknown>
  >([
    env.DB.prepare(
      `SELECT * FROM scans WHERE id = ?1 AND created_at > ?3
      AND (?2 IS NULL OR COALESCE(run_id, id) = ?2)`,
    ).bind(scanId, runId, cutoff),
    env.DB.prepare(
      `SELECT r.*, s.created_at AS map_created_at FROM scan_runs r
      JOIN scans s ON s.id = r.scan_id WHERE s.id = ?1 AND r.id = ?2 AND s.created_at > ?3`,
    ).bind(scanId, runId, cutoff),
    env.DB.prepare(
      `SELECT p.source_url, p.result_json FROM page_results p JOIN scans s ON s.id = p.scan_id
      WHERE s.id = ?1 AND s.created_at > ?3 AND (?2 IS NULL OR COALESCE(s.run_id, s.id) = ?2)
      UNION ALL
      SELECT p.source_url, p.result_json FROM scan_run_pages p JOIN scan_runs r ON r.id = p.run_id
      JOIN scans s ON s.id = r.scan_id WHERE s.id = ?1 AND r.id = ?2 AND s.created_at > ?3
      ORDER BY source_url`,
    ).bind(scanId, runId, cutoff),
  ]);
  const activeRow = current.results[0] as ScanRow | undefined;
  const archivedRow = archived.results[0] as ArchivedRow | undefined;
  if (!activeRow && !archivedRow)
    throw new ApiError(404, 'Scan run not found.');
  const results = pages.results.map(
    (page) => JSON.parse(String(page.result_json)) as PageResult,
  );
  const metadata = activeRow
    ? currentSummary(activeRow, results.length)
    : archivedSummary(archivedRow!);
  const activity = activeRow?.activity_json ?? archivedRow?.activity_json;
  return {
    ...metadata,
    results,
    ...(activity ? { activity: JSON.parse(activity) as ScanActivity } : {}),
  };
}

export async function readRunHistory(
  env: Env,
  scanId: string,
): Promise<ScanHistory> {
  const cutoff = Date.now() - RETENTION_MS;
  const [current, archived] = await env.DB.batch([
    env.DB.prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM page_results WHERE scan_id = s.id) AS page_count
      FROM scans s WHERE id = ?1 AND created_at > ?2`,
    ).bind(scanId, cutoff),
    env.DB.prepare(
      `SELECT r.*, s.created_at AS map_created_at FROM scan_runs r JOIN scans s ON s.id = r.scan_id
      WHERE s.id = ?1 AND s.created_at > ?2 ORDER BY r.run_number DESC LIMIT ?3`,
    ).bind(scanId, cutoff, SCAN_LIMITS.runsPerMap),
  ]);
  const row = current.results[0] as
    (ScanRow & { page_count: number }) | undefined;
  if (!row) throw new ApiError(404, 'Scan not found.');
  return {
    runs: [
      currentSummary(row, row.page_count),
      ...archived.results.map((row) => archivedSummary(row as ArchivedRow)),
    ],
    limit: SCAN_LIMITS.runsPerMap,
  };
}

export async function readRunLog(
  env: Env,
  scanId: string,
  runId: string,
): Promise<ScanLogResponse> {
  const cutoff = Date.now() - RETENTION_MS;
  const [metadata, rows] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `SELECT scan_log_truncated FROM scans WHERE id = ?1 AND COALESCE(run_id, id) = ?2 AND created_at > ?3
      UNION ALL SELECT r.scan_log_truncated FROM scan_runs r JOIN scans s ON s.id = r.scan_id
      WHERE s.id = ?1 AND r.id = ?2 AND s.created_at > ?3`,
    ).bind(scanId, runId, cutoff),
    env.DB.prepare(
      `SELECT e.id AS id, e.event_json FROM scan_events e JOIN scans s ON s.id = e.scan_id
      WHERE s.id = ?1 AND COALESCE(s.run_id, s.id) = ?2 AND s.created_at > ?3
      UNION ALL SELECT e.id, e.event_json FROM scan_run_events e JOIN scan_runs r ON r.id = e.run_id
      JOIN scans s ON s.id = r.scan_id WHERE s.id = ?1 AND r.id = ?2 AND s.created_at > ?3
      ORDER BY id DESC LIMIT 500`,
    ).bind(scanId, runId, cutoff),
  ]);
  if (!metadata.results.length) throw new ApiError(404, 'Scan run not found.');
  return {
    events: rows.results.reverse().map((row) => ({
      ...(JSON.parse(String(row.event_json)) as Omit<ScanLogEvent, 'id'>),
      id: Number(row.id),
    })),
    truncated: metadata.results[0].scan_log_truncated === 1,
  };
}

export function checkRun(
  row: ScanRow,
  expected: unknown,
  required = false,
): void {
  if (expected === undefined && !required) return;
  if (
    typeof expected !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      expected,
    )
  )
    throw new ApiError(400, 'A valid run ID is required.');
  if (expected !== (row.run_id ?? row.id))
    throw new ApiError(409, 'The active run changed. Reload before retrying.');
}

export async function rescan(env: Env, row: ScanRow): Promise<void> {
  if (env.CRAWLER_ENABLED !== 'true')
    throw new ApiError(503, 'Server scanning is temporarily disabled.');
  if (['running', 'waiting'].includes(control(row).status))
    throw new ApiError(
      409,
      'Pause or finish the current run before rescanning.',
    );
  // A new run receives fresh per-run limits, never a fresh global daily budget.
  const now = Date.now();
  const budget = await env.DB.prepare(
    'SELECT request_count FROM crawl_daily_budget WHERE day = ?',
  )
    .bind(Math.floor(now / 86_400_000))
    .first<{ request_count: number }>();
  if ((budget?.request_count ?? 0) >= DAILY_REQUESTS)
    throw new ApiError(
      429,
      'The daily scanning budget is exhausted. Try again tomorrow.',
    );
  if (row.run_number >= SCAN_LIMITS.runsPerMap)
    throw new ApiError(
      429,
      'Scan history capacity reached. Contact the administrator.',
    );
  const nextRunId = crypto.randomUUID();
  const oldRunId = row.run_id ?? row.id;
  const guard = 'EXISTS (SELECT 1 FROM scans WHERE id = ?1 AND run_id = ?2)';
  const outcomes = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO scan_runs
      (id, scan_id, run_number, created_at, updated_at, status, sites_json, limit_reason, activity_json, scan_log_truncated, page_count)
      SELECT COALESCE(run_id, id), id, run_number, COALESCE(run_created_at, created_at), updated_at,
        CASE WHEN status = 'running' THEN 'interrupted' ELSE status END,
        sites_json, limit_reason, activity_json, scan_log_truncated,
        (SELECT COUNT(*) FROM page_results WHERE scan_id = scans.id)
      FROM scans WHERE id = ?1 AND COALESCE(run_id, id) = ?2 AND crawl_generation = ?3 AND created_at > ?4
        AND run_number < ?5 AND status != 'waiting'
        AND (status != 'running' OR COALESCE(heartbeat_at, 0) < ?6 - CASE WHEN execution_mode = 'server' THEN 1200000 ELSE 90000 END)
      ON CONFLICT(id) DO NOTHING`,
    ).bind(
      row.id,
      oldRunId,
      row.crawl_generation,
      now - RETENTION_MS,
      SCAN_LIMITS.runsPerMap,
      now,
    ),
    env.DB.prepare(
      `UPDATE scans SET run_id = ?2, run_number = run_number + 1, run_created_at = ?3,
      status = 'waiting', execution_mode = 'server', updated_at = ?3, heartbeat_at = NULL, limit_reason = NULL,
      runner_hash = NULL, runner_expires_at = NULL, ticket_hash = NULL, ticket_expires_at = NULL,
      crawl_generation = crawl_generation + 1, crawl_started_at = NULL, crawl_tick = 0,
      crawl_enqueued_tick = -1, crawl_ready = 0, crawl_lease_token = NULL, crawl_lease_until = NULL,
      activity_json = NULL, scan_log_truncated = 0
      WHERE id = ?1 AND changes() = 1 RETURNING *`,
    ).bind(row.id, nextRunId, now),
    env.DB.prepare(
      `INSERT INTO scan_run_pages (run_id, source_url, result_json)
      SELECT ?3, source_url, result_json FROM page_results WHERE scan_id = ?1 AND ${guard}`,
    ).bind(row.id, nextRunId, oldRunId),
    env.DB.prepare(
      `INSERT INTO scan_run_events (run_id, id, event_json)
      SELECT ?3, id, event_json FROM scan_events WHERE scan_id = ?1 AND ${guard}`,
    ).bind(row.id, nextRunId, oldRunId),
    ...['page_results', 'scan_events', 'crawl_frontier', 'crawl_robots'].map(
      (table) =>
        env.DB.prepare(
          `DELETE FROM ${table} WHERE scan_id = ?1 AND ${guard}`,
        ).bind(row.id, nextRunId),
    ),
  ]);
  const updated = outcomes[1].results[0] as ScanRow | undefined;
  if (!updated)
    throw new ApiError(409, 'The active run changed. Reload before retrying.');
  await startServerScan(env, row.id, updated.crawl_generation);
}
