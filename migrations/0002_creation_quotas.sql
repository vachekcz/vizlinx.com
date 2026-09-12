CREATE TABLE creation_quotas (
  bucket_hash TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX creation_quotas_expiry ON creation_quotas(expires_at);
CREATE INDEX visitors_expiry ON visitors(expires_at);
CREATE INDEX scans_created ON scans(created_at);
