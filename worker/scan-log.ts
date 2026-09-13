import type { ScanLogEvent } from '../shared/scan';

const MAX_EVENTS = 500;
type EventGuard = { sql: string; bindings: (string | number | null)[] };

// Append these statements to the same batch as the state transition. The guard
// can inspect changes() immediately after that transition to exclude stale work.
export function scanLogStatements(
  env: Env,
  scanId: string,
  eventKey: string,
  event: Omit<ScanLogEvent, 'id'>,
  guard?: EventGuard,
): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      `INSERT OR IGNORE INTO scan_events (scan_id, event_key, event_json)
      SELECT ?, ?, ? WHERE ${guard?.sql ?? '1'} AND EXISTS (SELECT 1 FROM scans WHERE id = ?)`,
    ).bind(
      scanId,
      eventKey,
      JSON.stringify(event),
      ...(guard?.bindings ?? []),
      scanId,
    ),
    env.DB.prepare(
      `UPDATE scans SET scan_log_truncated = 1 WHERE id = ? AND changes() = 1
      AND EXISTS (SELECT 1 FROM scan_events WHERE scan_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
    ).bind(scanId, scanId, MAX_EVENTS),
    env.DB.prepare(
      `DELETE FROM scan_events WHERE scan_id = ? AND id < CASE WHEN changes() = 1 THEN
      (SELECT id FROM scan_events WHERE scan_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?) ELSE NULL END`,
    ).bind(scanId, scanId, MAX_EVENTS - 1),
  ];
}

export async function readScanLog(
  env: Env,
  scanId: string,
): Promise<{ events: ScanLogEvent[]; truncated: boolean }> {
  const [rows, metadata] = await env.DB.batch<{
    id?: number;
    event_json?: string;
    scan_log_truncated?: number;
  }>([
    env.DB.prepare(
      'SELECT id, event_json FROM scan_events WHERE scan_id = ? ORDER BY id DESC LIMIT ?',
    ).bind(scanId, MAX_EVENTS),
    env.DB.prepare('SELECT scan_log_truncated FROM scans WHERE id = ?').bind(
      scanId,
    ),
  ]);
  return {
    events: rows.results.reverse().map((row) => ({
      ...(JSON.parse(String(row.event_json)) as Omit<ScanLogEvent, 'id'>),
      id: Number(row.id),
    })),
    truncated: metadata.results[0]?.scan_log_truncated === 1,
  };
}
