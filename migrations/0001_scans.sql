CREATE TABLE visitors (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE scans (
  id TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL REFERENCES visitors(token_hash) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'waiting',
  sites_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  heartbeat_at INTEGER,
  ticket_hash TEXT UNIQUE,
  ticket_expires_at INTEGER,
  runner_hash TEXT UNIQUE,
  runner_expires_at INTEGER
);
CREATE INDEX scans_owner_created ON scans(owner_hash, created_at);

CREATE TABLE page_results (
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  source_origin TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  result_bytes INTEGER NOT NULL,
  PRIMARY KEY (scan_id, source_url)
);
CREATE INDEX results_scan_origin ON page_results(scan_id, source_origin);
