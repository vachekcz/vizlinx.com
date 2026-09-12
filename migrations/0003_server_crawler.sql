ALTER TABLE scans ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'extension';
ALTER TABLE scans ADD COLUMN limit_reason TEXT;
ALTER TABLE scans ADD COLUMN crawl_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scans ADD COLUMN crawl_started_at INTEGER;
ALTER TABLE scans ADD COLUMN crawl_lease_token TEXT;
ALTER TABLE scans ADD COLUMN crawl_lease_until INTEGER;
ALTER TABLE scans ADD COLUMN crawl_tick INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scans ADD COLUMN crawl_enqueued_tick INTEGER NOT NULL DEFAULT -1;

CREATE TABLE crawl_frontier (
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  origin TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY (scan_id, url)
);
CREATE INDEX crawl_frontier_site ON crawl_frontier(scan_id, origin, state);

CREATE TABLE crawl_robots (
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  policy_json TEXT,
  PRIMARY KEY (scan_id, origin)
);

CREATE TABLE crawl_origin_gates (
  origin TEXT PRIMARY KEY,
  next_allowed_at INTEGER NOT NULL
);

CREATE TABLE crawl_daily_budget (
  day INTEGER PRIMARY KEY,
  request_count INTEGER NOT NULL
);
