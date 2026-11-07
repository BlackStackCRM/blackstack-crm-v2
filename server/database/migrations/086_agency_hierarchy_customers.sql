-- Migration 086: Agency hierarchy + customer tenants.
--
-- RECOVERY RECORD
--   This migration was applied to the live database (recorded in
--   schema_migrations as version 86) but the SQL FILE was lost from the
--   migrations directory. This file restores it. The restored content was
--   reconciled against the LIVE SCHEMA (PRAGMA table_info on each table) so
--   that re-running migrate.js is a no-op on databases that already have the
--   tables, and produces this exact schema on fresh installs.
--
-- SAFETY
--   * Additive only. No DROP, no DELETE, no UPDATE of any existing row.
--   * IF NOT EXISTS throughout.
--
-- MODEL
--   agency_parent_relationships : sub-agency hierarchy. A child agency is
--     managed by its parent agency (an agency admin manages their own
--     sub-agencies). One parent per child.
--   customer_tenant_agencies    : which company is a "customer tenant" of which
--     agency. The company row is created by the agency-control service; the
--     agency column points at the managing agency.
--   customer_tenant_agency_history : append-only record of assignments.

CREATE TABLE IF NOT EXISTS agency_parent_relationships (
  child_agency_id  TEXT PRIMARY KEY,
  parent_agency_id TEXT NOT NULL,
  created_by       TEXT,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (child_agency_id) REFERENCES agencies(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_agency_id) REFERENCES agencies(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agency_parent_parent ON agency_parent_relationships(parent_agency_id);

CREATE TABLE IF NOT EXISTS customer_tenant_agencies (
  company_id          TEXT PRIMARY KEY,
  agency_id           TEXT NOT NULL,
  provider_company_id TEXT NOT NULL,
  assigned_by         TEXT,
  assigned_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cta_agency ON customer_tenant_agencies(agency_id);

CREATE TABLE IF NOT EXISTS customer_tenant_agency_history (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL,
  old_agency_id       TEXT,
  new_agency_id       TEXT NOT NULL,
  changed_by          TEXT,
  changed_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ctah_customer ON customer_tenant_agency_history(company_id);
