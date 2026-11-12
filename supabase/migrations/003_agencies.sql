-- supabase/migrations/003_agencies.sql
-- Distribution agency table; synced from local agencies
-- (server/database/migrations/085_mother_company_agencies.sql).
-- UUID PK (pgcrypto); FK -> companies(id) for company_id and provider_company_id.

CREATE TABLE IF NOT EXISTS agencies (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         TEXT NOT NULL,
  provider_company_id TEXT NOT NULL,
  agency_code        TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  legal_name         TEXT,
  contact_name       TEXT,
  contact_email      TEXT,
  contact_phone      TEXT,
  address            TEXT,
  city               TEXT,
  state              TEXT,
  country            TEXT DEFAULT 'India',
  pincode            TEXT,
  status             TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','TERMINATED')),
  is_active          INTEGER NOT NULL DEFAULT 0,
  activated_at       TIMESTAMP,
  suspended_at       TIMESTAMP,
  suspended_reason   TEXT,
  notes              TEXT,
  created_by         TEXT,
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_agencies_company
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_agencies_provider_company
    FOREIGN KEY (provider_company_id) REFERENCES companies(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agencies_code
  ON agencies(agency_code);
CREATE INDEX IF NOT EXISTS idx_agencies_company
  ON agencies(company_id);
CREATE INDEX IF NOT EXISTS idx_agencies_provider
  ON agencies(provider_company_id);
CREATE INDEX IF NOT EXISTS idx_agencies_status
  ON agencies(status);
