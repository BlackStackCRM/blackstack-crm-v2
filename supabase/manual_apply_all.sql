-- BlackStack CRM V2 — Cloud Migration Package
-- Apply in Supabase Dashboard > SQL Editor, in ONE transaction.
-- Generated: 2026-10-21
--
-- Do NOT run this against your production/local SQLite DB.
-- This is the combined PostgreSQL/Supabase equivalent of:
--   supabase/migrations/001_pgcrypto.sql
--   supabase/migrations/002_companies.sql
--   supabase/migrations/003_agencies.sql
--   supabase/migrations/004_agency_administrators.sql
--   supabase/migrations/005_agency_status_history.sql
--   supabase/migrations/006_agency_audit_entries.sql
--
-- Run in ONE transaction. If any statement fails, the whole transaction rolls
-- back and nothing is applied to the cloud schema.

BEGIN;

-- ============================================================================
-- 001_pgcrypto.sql — pgcrypto extension (UUID generation)
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 002_companies.sql — companies stub
-- ============================================================================
CREATE TABLE IF NOT EXISTS companies (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 003_agencies.sql — agencies with FKs to companies (company_id, provider_company_id)
-- ============================================================================
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

-- ============================================================================
-- 004_agency_administrators.sql — with FKs to agencies + companies
-- ============================================================================
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

-- ============================================================================
-- 005_agency_status_history.sql — with FK to agencies
-- ============================================================================
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

-- ============================================================================
-- 006_agency_audit_entries.sql — with FK to agencies, session_id included
-- ============================================================================
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

COMMIT;
