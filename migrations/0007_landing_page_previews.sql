ALTER TABLE crawl_frontier ADD COLUMN is_preview INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crawl_robots ADD COLUMN preview_throttled INTEGER NOT NULL DEFAULT 0;

CREATE INDEX crawl_frontier_preview ON crawl_frontier(scan_id, is_preview, origin);
