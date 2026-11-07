-- server/database/migrations-local/002_cloud_conflict.sql
-- Local conflict audit (cloud write rejected with 409).
-- resolved_by is TEXT; no FK, because there is no users table in the cloud.

CREATE TABLE IF NOT EXISTS cloud_conflict (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  record_type   TEXT NOT NULL,
  local_id      TEXT NOT NULL,
  cloud_request TEXT NOT NULL,
  cloud_response TEXT NOT NULL,
  conflict_reason TEXT,
  resolved_by   TEXT,
  resolved_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
