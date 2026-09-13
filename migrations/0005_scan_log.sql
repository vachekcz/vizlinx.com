ALTER TABLE scans ADD COLUMN activity_json TEXT;
ALTER TABLE scans ADD COLUMN scan_log_truncated INTEGER NOT NULL DEFAULT 0;

CREATE TABLE scan_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  event_json TEXT NOT NULL,
  UNIQUE (scan_id, event_key)
);
CREATE INDEX scan_events_scan_id ON scan_events(scan_id, id);
