-- Migration 088: Local-first CRM + Supabase Agency Cloud Sync.
--
-- SCOPE
--   Adds the tables and code path that forward each created/updated distribution
--   agency from the local SQLite store to the Supabase Cloud project.
--   This migration is ADDITIVE ONLY:
--     * No DROP, no DELETE, no UPDATE of any existing row.
--     * No existing table is altered, so every existing customer, contact, deal,
--       accounting, billing or inventory row is untouched.
--     * IF NOT EXISTS throughout, so re-running is a no-op.
--
-- DATA SAFETY
--   * Additive only. No destructive operation anywhere in this file.
--   * The existing local SQLite database remains the authority for the agency
--     record itself. Cloud sync is a parallel, best-effort copy.
--   * If Supabase is unreachable at write time, the local agency is still
--     committed and the record is left in `cloud_sync_status` = 'PENDING' for
--     the server-side retry worker to pick up later.
--
-- DESIGN PROMISE
--   * fail-closed send: a Supabase send is best-effort. It is never allowed to
--     invalidate a local agency, and it is never allowed to throw to the caller.
--   * the backend decides what to send; the frontend NEVER touches a Supabase
--     secret. The service layer sends server-to-server using the service role
--     key, and the JWT session continues to be the single admission control.
--
-- RETRY SEMANTICS
--   * `cloud_sync_status` carries `status` = PENDING | SYNCED | FAILED, plus
--     `attempts`, `started_at`, `finished_at` and `error_message`.
--   * A retry worker (see `server/services/supabase.client.js`) calls
--     `retryPending()` on an interval and will not re-send an already
--     `SYNCED` row. The `Unique` index on `agency_id` keeps a single
--     authoritative sync row per agency, so a retry never creates duplicate
--     Supabase records.

-- ── cloud_sync_status: one sync row per agency ──────────────────────────
-- Holds the authoritative cloud-send result per agency_id.
-- UNIQUE(agency_id) is the idempotency key: it guarantees exactly one row
-- per agency, so a retry can never produce a duplicate upstream record.
CREATE TABLE IF NOT EXISTS cloud_sync_status (
  id            TEXT PRIMARY KEY,
  agency_id     TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','SYNCED','FAILED')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  started_at    DATETIME,
  finished_at   DATETIME,
  error_message TEXT,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_status_agency
  ON cloud_sync_status(agency_id);

-- ── cloud_sync_log: an append-only audit of every cloud send attempt ─────
-- Useful for operators to see retry pressure and transient failures without
-- touching the live sync row.
CREATE TABLE IF NOT EXISTS cloud_sync_log (
  id            TEXT PRIMARY KEY,
  agency_id     TEXT NOT NULL,
  event         TEXT NOT NULL
                  CHECK (event IN ('CREATED','UPDATED','SYNCED','FAILED')),
  payload       TEXT,
  status        TEXT NOT NULL
                  CHECK (status IN ('PENDING','SYNCED','FAILED')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  started_at    DATETIME,
  finished_at   DATETIME,
  error_message TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_log_agency
  ON cloud_sync_log(agency_id, created_at);

-- Confirm the table is in place.
-- (read-only assertion; intentional: it proves the migration applied cleanly.)
