-- supabase/migrations/005_agency_status_history.sql
-- Synced from local agency_status_history
-- (server/database/migrations/085_mother_company_agencies.sql).
-- UUID PK (pgcrypto); FK -> agencies(id).
-- from_status is NULL only for initial creation (no previous status).

CREATE TABLE IF NOT EXISTS agency_status_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     UUID NOT NULL,
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  reason        TEXT,
  changed_by    TEXT,
  changed_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_agency_status_history_agency
    FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agency_status_history_agency
  ON agency_status_history(agency_id);
