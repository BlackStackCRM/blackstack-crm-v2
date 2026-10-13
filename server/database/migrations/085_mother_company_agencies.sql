-- Migration 085: Mother Company (BlackStack) + Distribution Agency control.
--
-- SCOPE
--   Phase 1 only: the Mother Company identity, its dedicated RBAC permissions,
--   and the Distribution Agency tables needed to create, activate and suspend
--   an agency.
--
--   DELIBERATELY NOT INCLUDED (later phases, per task scope boundaries):
--     license keys, entitlements, device binding, activation, renewals,
--     subscription billing, sub-agency hierarchy, central license server.
--   No placeholder tables are created for those. The absence is recorded in
--   code comments instead, so nothing here can be mistaken for a working
--   licensing system.
--
-- DATA SAFETY — AND AN HONEST RECORD OF WHAT ACTUALLY HAPPENED
--
--   This migration was applied to the live database (data/blackstack-crm.db) on
--   2026-10-11 at 10:07:15 IST, unintentionally, before it had been run against a
--   disposable copy under full test coverage. Cause: an ad-hoc diagnostic script
--   read a misspelled environment variable, so the app received no DB_PATH and
--   fell back to its production default, which migrate-on-boot then wrote to.
--
--   Recorded here rather than hidden, because it is a real event in the
--   production database's history and belongs in the file that produced it.
--
--   IMPACT — measured, not assumed:
--     * Additive only. No DROP, no DELETE, no UPDATE of any existing row.
--     * Adds: agencies, agency_administrators, agency_status_history,
--       mother_company_providers tables; 7 permissions; 1 role; 7 role_permissions.
--     * Existing rows verified unchanged afterwards:
--         users 1, roles 3, permissions 126, companies 1, contacts 1,
--         organizations 1, journal_entries 31, journal_entry_lines 112,
--         audit_logs 431.
--     * PRAGMA integrity_check: ok.  PRAGMA foreign_key_check: 0 violations.
--     * agencies table: 0 rows. No agency, user or administrator was created in
--       production, and no account was provisioned.
--
--   No data was lost, restored or overwritten. Had it been destructive, this
--   migration would have been withdrawn and the database restored from backup
--   rather than left in place.
--
--   SAFETY PROPERTIES OF THIS FILE
--   * Additive only. No DROP, no DELETE, no UPDATE of existing rows.
--   * No existing table is altered, so no existing customer, contact, deal,
--     accounting, billing or inventory row can be affected.
--   * IF NOT EXISTS throughout, so re-running is a no-op.
--
-- TENANT MODEL
--   agencies live in their OWN company row (company_id points at the agency's
--   own company, created alongside it). This keeps the existing tenant
--   isolation intact: an agency's users are ordinary users of that company and
--   every existing query stays correct without modification.
--
--   mother_company_providers is a separate, deliberately global table: it maps
--   a company to the Mother Company entity. It is NOT tenant-scoped because a
--   single provider (BlackStack) governs all agencies. It has no FK to
--   companies ON DELETE CASCADE so that deleting a company can never silently
--   change who the provider is.

-- ── Mother Company permissions ────────────────────────────────────────────────
-- Named codes, module 'mother_company'. These are deliberately NOT included in
-- the ADMIN wildcard path: Authorizer.assertPermission treats '*' as
-- "allow everything", so if Mother Company powers were ever folded into '*'
-- then every customer-company admin would become a Mother Company operator.
-- That is why the guard in server/middleware/motherCompany.js checks an
-- EXPLICIT code and ignores '*' for these permissions.

INSERT OR IGNORE INTO permissions (id, company_id, code, module, name, description)
VALUES
  ('perm_mc_view',        'default', 'mother_company.view',          'mother_company', 'View Mother Company dashboard',      'Read-only access to Mother Company dashboard and agency list'),
  ('perm_mc_agencies',    'default', 'mother_company.agencies.view',  'mother_company', 'View distribution agencies',        'List, search and inspect distribution agencies'),
  ('perm_mc_agencies_create', 'default', 'mother_company.agencies.create', 'mother_company', 'Create distribution agency',    'Create a new distribution agency and assign its code'),
  ('perm_mc_agencies_edit',   'default', 'mother_company.agencies.edit',   'mother_company', 'Edit distribution agency',      'Update agency contact details and metadata'),
  ('perm_mc_agencies_status', 'default', 'mother_company.agencies.status', 'mother_company', 'Activate or suspend agency',     'Change the operational status of an agency'),
  ('perm_mc_agencies_admins', 'default', 'mother_company.agencies.admins.manage', 'mother_company', 'Assign agency administrators', 'Create and assign administrator accounts for an agency'),
  ('perm_mc_audit',        'default', 'mother_company.audit.view',      'mother_company', 'View Mother Company audit history', 'Read the Mother Company action log');

-- ── Mother Company role ───────────────────────────────────────────────────────
-- is_system = 1: this role is defined by the product, not by a tenant.
-- It is intentionally NOT granted to role_admin. Customer admins keep '*' for
-- CRM modules and nothing else; Mother Company access is opt-in only.

INSERT OR IGNORE INTO roles (id, company_id, name, code, description, is_system)
VALUES ('role_mother_company', 'default', 'Mother Company', 'MOTHER_COMPANY',
        'BlackStack Mother Company — distribution agency control', 1);

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT 'role_mother_company', id FROM permissions WHERE module = 'mother_company';

-- ── Distribution agencies ─────────────────────────────────────────────────────
-- created_by is intentionally NOT a foreign key. The Mother Company account may
-- be provisioned or removed independently of agency history, and audit history
-- must survive that. (audit_logs.user_id uses the same ON DELETE SET NULL idea.)

CREATE TABLE IF NOT EXISTS agencies (
  id                TEXT PRIMARY KEY,
  -- The agency's OWN tenant company. Its administrator and users belong here, so
  -- every existing tenant-scoped query keeps working without special-casing.
  company_id        TEXT NOT NULL,
  -- The Mother Company that manages this agency. Ownership of an agency is NOT
  -- expressed by company_id (that is the agency's own tenant); Mother Company
  -- queries scope on this column instead. Without it, an operator would create an
  -- agency and then be unable to see it.
  provider_company_id TEXT NOT NULL,
  agency_code       TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  legal_name        TEXT,
  contact_name      TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  address           TEXT,
  city              TEXT,
  state             TEXT,
  country           TEXT DEFAULT 'India',
  pincode           TEXT,
  -- Lifecycle. Only these four values are valid; the service layer enforces the
  -- transition rules (e.g. SUSPENDED -> ACTIVE is allowed, ACTIVE -> PENDING is
  -- not) so the DB stays dumb and the rules stay testable in one place.
  status            TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','TERMINATED')),
  is_active         INTEGER NOT NULL DEFAULT 0,
  activated_at      DATETIME,
  suspended_at      DATETIME,
  suspended_reason  TEXT,
  notes             TEXT,
  created_by        TEXT,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agencies_code ON agencies(agency_code);
CREATE INDEX IF NOT EXISTS idx_agencies_status  ON agencies(status);
CREATE INDEX IF NOT EXISTS idx_agencies_company  ON agencies(company_id);
CREATE INDEX IF NOT EXISTS idx_agencies_provider ON agencies(provider_company_id);

-- ── Agency administrators ─────────────────────────────────────────────────────
-- One row per (agency, user). A user may administer exactly one agency here;
-- that is enforced by the UNIQUE constraint on user_id rather than in code, so a
-- bug in the service layer cannot create a cross-agency administrator.
--
-- The linked user is a real row in `users` belonging to the agency's own
-- company, so the agency administrator signs in through the normal login page
-- and gets exactly the permissions their role grants — no separate auth path.

CREATE TABLE IF NOT EXISTS agency_administrators (
  id                TEXT PRIMARY KEY,
  agency_id         TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  company_id        TEXT NOT NULL,
  role_code         TEXT NOT NULL DEFAULT 'AGENCY_ADMIN',
  assigned_by       TEXT,
  assigned_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  revoked_at        DATETIME,
  revoked_by        TEXT,
  status            TEXT NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE','REVOKED')),
  UNIQUE (user_id),
  FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE CASCADE,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agency_admins_agency ON agency_administrators(agency_id);
CREATE INDEX IF NOT EXISTS idx_agency_admins_user   ON agency_administrators(user_id);

-- ── Mother Company provider mapping ───────────────────────────────────────────
-- Which company is the Mother Company. Kept as data, not code, so the product
-- can be re-pointed at a different entity later without a schema change.
-- No FK to companies: deleting a company must never reassign provider identity.

CREATE TABLE IF NOT EXISTS mother_company_providers (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  legal_name        TEXT,
  contact_email     TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ── Agency status history ─────────────────────────────────────────────────────
-- Append-only. Every lifecycle change lands here, giving the dashboard a real
-- audit trail rather than only a mutable current-status column.

CREATE TABLE IF NOT EXISTS agency_status_history (
  id                TEXT PRIMARY KEY,
  agency_id         TEXT NOT NULL,
  from_status       TEXT,
  to_status         TEXT NOT NULL,
  reason            TEXT,
  changed_by        TEXT,
  changed_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agency_status_history ON agency_status_history(agency_id, changed_at);
