-- server/database/migrations-local/001_local_outbox.sql
-- Local outbox: exactly-once forward to the cloud.
-- One row per logical record; UNIQUE(record_type, local_id) is the idempotency key.

CREATE TABLE IF NOT EXISTS local_outbox (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  record_type   TEXT NOT NULL,
  local_id      TEXT NOT NULL,
  payload       TEXT NOT NULL,
  enqueued_at   TEXT NOT NULL DEFAULT (datetime('now')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','PROCESSING','SUCCESS','FAILED')),
  error_message TEXT,
  synced_at     TEXT,
  CONSTRAINT uq_local_outbox_record
    UNIQUE (record_type, local_id)
);

CREATE INDEX IF NOT EXISTS idx_local_outbox_pending
  ON local_outbox(status) WHERE status = 'PENDING';
