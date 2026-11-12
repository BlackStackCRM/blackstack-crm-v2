-- supabase/migrations/006_agency_audit_entries.sql
-- Synced from local audit_logs
-- (server/database/migrations/013_audit.sql).
-- Column mapping (local -> cloud):
--   entity_type  -> entity
--   old_values_json -> old_values
--   new_values_json -> new_values
--   session_id  -> session_id (kept)
--   company_id  -> agency_id
-- UUID PK (pgcrypto); FK -> agencies(id).

CREATE TABLE IF NOT EXISTS agency_audit_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     UUID NOT NULL,
  actor_id      TEXT,
  action        TEXT NOT NULL,
  entity        TEXT NOT NULL,
  entity_id     TEXT,
  old_values    TEXT,
  new_values    TEXT,
  ip_address    TEXT,
  user_agent    TEXT,
  session_id    TEXT,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_agency_audit_entries_agency
    FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agency_audit_entries_agency
  ON agency_audit_entries(agency_id);
