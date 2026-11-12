-- supabase/migrations/004_agency_administrators.sql
-- Synced from local agency_administrators
-- (server/database/migrations/085_mother_company_agencies.sql).
-- UUID PK (pgcrypto); FK -> agencies(id), companies(id).

CREATE TABLE IF NOT EXISTS agency_administrators (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     UUID NOT NULL,
  company_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  role_code     TEXT NOT NULL DEFAULT 'AGENCY_ADMIN',
  assigned_by   TEXT,
  assigned_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  revoked_at    TIMESTAMP,
  revoked_by    TEXT,
  status        TEXT NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE','REVOKED')),
  CONSTRAINT fk_agency_administrators_agency
    FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE CASCADE,
  CONSTRAINT fk_agency_administrators_company
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agency_administrators_agency
  ON agency_administrators(agency_id);
