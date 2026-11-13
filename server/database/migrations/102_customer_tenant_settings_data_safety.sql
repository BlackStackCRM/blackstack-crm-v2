-- Customer tenants may manage CRM settings and create/read verified backups.
-- Whole-database restore, maintenance, retention rotation, and deletion remain
-- limited to platform/agency administrators in the route layer.

INSERT OR IGNORE INTO permissions (id, company_id, code, module, name, description) VALUES
  ('perm_settings_view', 'default', 'settings.view', 'settings', 'View Settings', 'Can view system settings'),
  ('perm_data_safety_view', 'default', 'data_safety.view', 'data_safety', 'View Data Safety', 'Can view backup and data safety status'),
  ('perm_data_safety_manage', 'default', 'data_safety.manage', 'data_safety', 'Manage Data Safety Backups', 'Can create verified backups');

-- Keep existing settings managers working with the new fine-grained Data Safety
-- permissions, including platform and agency administration roles.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p.id
FROM role_permissions rp
JOIN permissions manage ON manage.id = rp.permission_id AND manage.code = 'settings.manage'
JOIN permissions p ON p.code IN ('settings.view', 'data_safety.view', 'data_safety.manage');

-- Customer tenants get the requested full Settings access and may create
-- backups. Destructive Data Safety operations are separately role-gated.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT 'role_customer_tenant', id
FROM permissions
WHERE code IN ('settings.view', 'settings.manage', 'data_safety.view', 'data_safety.manage');

UPDATE roles
SET description = 'Customer tenant access to Settings, system preferences, and verified backup creation'
WHERE id = 'role_customer_tenant';
