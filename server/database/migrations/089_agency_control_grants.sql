-- Migration 089: Grant agency_control.* permissions to agency administrator roles.
--
-- WHY
--   The agency-control backend (server/routes/agencyControl.js) authorizes with
--   the four agency_control.* permission codes, which already exist in the
--   permissions table but were never attached to the per-agency
--   AGENCY_ADMIN_<AGENCYCODE> roles that agency administrators actually hold.
--   Without this grant, an agency administrator is authenticated correctly but
--   every /api/agency-control request returns 403.
--
-- SAFETY
--   * Additive only: INSERT OR IGNORE into role_permissions. No UPDATE/DELETE.
--   * Idempotent: re-running is a no-op.
--   * Scoped to existing per-agency admin roles only (code LIKE 'AGENCY_ADMIN\_%'
--     ESCAPE '\'). The Mother Company and customer-admin roles are untouched.
--
-- DESIGN NOTE
--   The frontend (public/js/pages/agency-control.js) gates its UI on exactly
--   these four codes, so the grant set matches the page's requirements 1:1.

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'agency_control.subagencies.view',
  'agency_control.subagencies.create',
  'agency_control.agencies.manage',
  'agency_control.customers.manage'
)
WHERE r.code LIKE 'AGENCY_ADMIN\_%' ESCAPE '\';
