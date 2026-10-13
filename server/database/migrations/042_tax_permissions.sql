-- Migration 042: Tax / GST RBAC permissions (Step 17)
-- Adds tax-specific permissions for managing tax configuration.

INSERT OR IGNORE INTO permissions (id, company_id, code, module, name, description) VALUES
  ('perm_tax_001', 'default', 'tax.view', 'tax', 'View Tax Configuration', 'Can view tax masters, company tax config, and tax account mappings'),
  ('perm_tax_002', 'default', 'tax.create', 'tax', 'Create Tax Configuration', 'Can create tax masters'),
  ('perm_tax_003', 'default', 'tax.manage', 'tax', 'Manage Tax Configuration', 'Can create, edit, activate/deactivate tax masters, mappings, and company config'),
  ('perm_tax_004', 'default', 'tax.reports', 'tax', 'View Tax Reports', 'Can view tax calculation previews and transaction tax details');

-- Assign tax permissions to admin role (full access)
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'role_admin', id FROM permissions WHERE company_id = 'default' AND code LIKE 'tax.%';

-- Assign tax view + calculate to manager role
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES
  ('role_manager', 'perm_tax_001'), -- tax.view
  ('role_manager', 'perm_tax_004');  -- tax.reports
