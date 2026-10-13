-- Migration 084: CRM RBAC permissions for modules that had none.
--
-- WHY
--   The Phase 3 CRM audit (STEP 2) found 33 CRM routes mounted with
--   `authMiddleware` but WITHOUT `requirePermission`. Anonymous callers were
--   correctly rejected with 401, but ANY authenticated user could read and
--   mutate them regardless of role.
--
--   Root cause: these modules simply had no permission codes defined. The
--   existing seed covers contacts / organizations / deals / tasks / activities
--   (015_seed_permissions.sql) and later modules, but nothing for leads,
--   customers, notes, pipelines, notifications, relationships, search or
--   dashboard — so no route guard could be attached without inventing codes.
--
--   The most consequential gaps were `relationships` POST/DELETE (any user
--   could create and delete CRM relationship records) and every `pipelines`
--   mutation.
--
-- SAFETY
--   * INSERT OR IGNORE throughout, so this is safe to run repeatedly and on an
--     existing database. No existing permission row is modified.
--   * role_admin receives every new code, preserving its current effective
--     access (it is also granted '*' at login, so nothing regresses).
--   * role_manager receives the read codes plus the CRM write codes it already
--     has equivalents for, keeping the existing manager role functional.
--   * role_user is deliberately NOT granted any of these. It holds 0
--     permissions today, and widening it here would silently grant access
--     rather than fix the gap.
--   * No production data is edited by this migration; it only adds rows.

-- ── leads ────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO permissions (id, company_id, code, module, name, description) VALUES
  ('perm_crm_001', 'default', 'leads.view',     'leads',     'View Leads',     'Can view the lead pipeline'),
  ('perm_crm_002', 'default', 'leads.create',   'leads',     'Create Leads',   'Can create lead records'),
  ('perm_crm_003', 'default', 'leads.edit',     'leads',     'Edit Leads',     'Can modify lead records and status'),
  ('perm_crm_004', 'default', 'leads.delete',   'leads',     'Delete Leads',   'Can permanently delete lead records');

-- ── customers ────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO permissions (id, company_id, code, module, name, description) VALUES
  ('perm_crm_005', 'default', 'customers.view',   'customers', 'View Customers',   'Can view customer records'),
  ('perm_crm_006', 'default', 'customers.create', 'customers', 'Create Customers', 'Can create customer records'),
  ('perm_crm_007', 'default', 'customers.edit',   'customers', 'Edit Customers',   'Can modify customer records'),
  ('perm_crm_008', 'default', 'customers.delete', 'customers', 'Delete Customers', 'Can permanently delete customer records');

-- ── notes (entire resource was unguarded) ───────────────────────────────
INSERT OR IGNORE INTO permissions (id, company_id, code, module, name, description) VALUES
  ('perm_crm_009', 'default', 'notes.view',   'notes', 'View Notes',   'Can view notes attached to CRM records'),
  ('perm_crm_010', 'default', 'notes.create', 'notes', 'Create Notes', 'Can create notes'),
  ('perm_crm_011', 'default', 'notes.edit',   'notes', 'Edit Notes',   'Can modify notes'),
  ('perm_crm_012', 'default', 'notes.delete', 'notes', 'Delete Notes', 'Can delete notes');

-- ── pipelines (every mutation was unguarded) ────────────────────────────
INSERT OR IGNORE INTO permissions (id, company_id, code, module, name, description) VALUES
  ('perm_crm_013', 'default', 'pipelines.view',   'pipelines', 'View Pipelines',   'Can view pipelines and their stages'),
  ('perm_crm_014', 'default', 'pipelines.create', 'pipelines', 'Create Pipelines', 'Can create pipelines and stages'),
  ('perm_crm_015', 'default', 'pipelines.edit',   'pipelines', 'Edit Pipelines',   'Can rename or restructure pipelines'),
  ('perm_crm_016', 'default', 'pipelines.delete', 'pipelines', 'Delete Pipelines', 'Can delete pipelines');

-- ── relationships (create/delete were unguarded) ────────────────────────
INSERT OR IGNORE INTO permissions (id, company_id, code, module, name, description) VALUES
  ('perm_crm_017', 'default', 'relationships.view',   'relationships', 'View Relationships',   'Can view links between CRM records'),
  ('perm_crm_018', 'default', 'relationships.create', 'relationships', 'Create Relationships', 'Can link CRM records together'),
  ('perm_crm_019', 'default', 'relationships.delete', 'relationships', 'Delete Relationships', 'Can remove links between CRM records');

-- ── notifications ───────────────────────────────────────────────────────
INSERT OR IGNORE INTO permissions (id, company_id, code, module, name, description) VALUES
  ('perm_crm_020', 'default', 'notifications.view', 'notifications', 'View Notifications', 'Can view own notifications'),
  ('perm_crm_021', 'default', 'notifications.edit', 'notifications', 'Edit Notifications', 'Can mark own notifications read');

-- ── search + dashboard ──────────────────────────────────────────────────
INSERT OR IGNORE INTO permissions (id, company_id, code, module, name, description) VALUES
  ('perm_crm_022', 'default', 'search.view',     'search',     'Use Search',     'Can run global CRM search'),
  ('perm_crm_023', 'default', 'dashboard.view',  'dashboard',  'View Dashboard', 'Can view dashboard metrics and summary');

-- ── Admin: everything introduced here ────────────────────────────────────
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'role_admin', id FROM permissions
   WHERE company_id = 'default'
     AND code IN (
       'leads.view','leads.create','leads.edit','leads.delete',
       'customers.view','customers.create','customers.edit','customers.delete',
       'notes.view','notes.create','notes.edit','notes.delete',
       'pipelines.view','pipelines.create','pipelines.edit','pipelines.delete',
       'relationships.view','relationships.create','relationships.delete',
       'notifications.view','notifications.edit',
       'search.view','dashboard.view'
     );

-- ── Manager: full CRM working access, matching the manager's existing
--    contacts/deals/organizations/tasks grants in 015. ────────────────────
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'role_manager', id FROM permissions
   WHERE company_id = 'default'
     AND code IN (
       'leads.view','leads.create','leads.edit',
       'customers.view','customers.create','customers.edit',
       'notes.view','notes.create','notes.edit','notes.delete',
       'pipelines.view','pipelines.create','pipelines.edit',
       'relationships.view','relationships.create','relationships.delete',
       'notifications.view','notifications.edit',
       'search.view','dashboard.view'
     );
