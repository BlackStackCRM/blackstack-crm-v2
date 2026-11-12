-- supabase/migrations/007_agency_control_tables.sql
-- Creates the missing Agency Control link tables in Supabase.
-- Mirrors local schema:
--   agency_parent_relationships      (server/database/migrations/...)
--   customer_tenant_agencies
--   customer_tenant_agency_history
--
-- FK targets in Supabase:
--   agencies(id)   = UUID
--   companies(id)  = TEXT

BEGIN;

-- ── Sub-agency hierarchy ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agency_parent_relationships (
  child_agency_id  UUID NOT NULL,
  parent_agency_id UUID NOT NULL,
  created_by       TEXT,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_agency_parent_relationships PRIMARY KEY (child_agency_id),
  CONSTRAINT fk_apr_child FOREIGN KEY (child_agency_id)
    REFERENCES agencies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_apr_parent FOREIGN KEY (parent_agency_id)
    REFERENCES agencies(id) ON DELETE RESTRICT,
  CONSTRAINT chk_no_self_parent CHECK (child_agency_id <> parent_agency_id)
);

CREATE INDEX IF NOT EXISTS idx_apr_parent
  ON agency_parent_relationships(parent_agency_id);

-- ── Customer tenant assignments ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_tenant_agencies (
  company_id          TEXT PRIMARY KEY,
  agency_id           UUID NOT NULL,
  provider_company_id TEXT NOT NULL,
  assigned_by         TEXT,
  assigned_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cta_company FOREIGN KEY (company_id)
    REFERENCES companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cta_agency FOREIGN KEY (agency_id)
    REFERENCES agencies(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_cta_agency
  ON customer_tenant_agencies(agency_id);

-- ── Customer tenant reassignment history ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_tenant_agency_history (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  old_agency_id UUID,
  new_agency_id UUID NOT NULL,
  changed_by    TEXT,
  changed_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ctah_company FOREIGN KEY (company_id)
    REFERENCES companies(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_ctah_company
  ON customer_tenant_agency_history(company_id);

COMMIT;
