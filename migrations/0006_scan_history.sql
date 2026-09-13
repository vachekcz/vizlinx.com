ALTER TABLE scans ADD COLUMN run_id TEXT;
ALTER TABLE scans ADD COLUMN run_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE scans ADD COLUMN run_created_at INTEGER;

UPDATE scans SET run_id = id, run_created_at = created_at;

CREATE TABLE scan_runs (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  run_number INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  sites_json TEXT NOT NULL,
  limit_reason TEXT,
  activity_json TEXT,
  scan_log_truncated INTEGER NOT NULL DEFAULT 0,
  page_count INTEGER NOT NULL,
  UNIQUE (scan_id, run_number)
);

CREATE TABLE scan_run_pages (
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (run_id, source_url)
);

CREATE TABLE scan_run_events (
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  id INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
);
