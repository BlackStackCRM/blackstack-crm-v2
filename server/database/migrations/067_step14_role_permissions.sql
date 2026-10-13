-- Step 14 (follow-up): assign collection automation permissions to admin role.
-- Migration 066 inserted the permission rows but omitted role assignment,
-- so the endpoints returned 403. This mirrors the pattern used by
-- 024_accounting_permissions.sql, 042_tax_permissions.sql and
-- 064_step12_permissions.sql.

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'role_admin', id FROM permissions
  WHERE company_id = 'default' AND id LIKE 'perm_s14_%';
