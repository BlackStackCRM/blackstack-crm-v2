-- Migration 071: Inventory Management RBAC permissions
-- Reuses existing number_sequences table for voucher numbering (migration 045).
-- Uses ENTITIES registered in code-generator.service.js: INVENTORY_VOUCHER.

INSERT OR IGNORE INTO permissions (id, company_id, code, module, name, description) VALUES
  ('perm_inv_001', 'default', 'inventory.view',           'inventory', 'View Inventory',           'Can view inventory items, masters, and transactions'),
  ('perm_inv_002', 'default', 'inventory.create',         'inventory', 'Create Inventory',         'Can create inventory masters and draft transactions'),
  ('perm_inv_003', 'default', 'inventory.edit',           'inventory', 'Edit Inventory',           'Can edit draft inventory transactions and masters'),
  ('perm_inv_004', 'default', 'inventory.delete',         'inventory', 'Delete Inventory',         'Can soft-delete inventory masters'),
  ('perm_inv_005', 'default', 'inventory.post',           'inventory', 'Post Inventory',           'Can post inventory transactions to the stock ledger'),
  ('perm_inv_006', 'default', 'inventory.cancel',         'inventory', 'Cancel Inventory',         'Can cancel posted inventory transactions'),
  ('perm_inv_007', 'default', 'inventory.approve',        'inventory', 'Approve Inventory',        'Can approve physical stock documents'),
  ('perm_inv_008', 'default', 'inventory.reports',        'inventory', 'Inventory Reports',        'Can view inventory valuation and stock reports');

-- Admin gets all inventory permissions
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'role_admin', id FROM permissions
  WHERE company_id = 'default' AND code LIKE 'inventory.%';

-- Manager gets view + create + edit
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES
  ('role_manager', (SELECT id FROM permissions WHERE company_id = 'default' AND code = 'inventory.view')),
  ('role_manager', (SELECT id FROM permissions WHERE company_id = 'default' AND code = 'inventory.create')),
  ('role_manager', (SELECT id FROM permissions WHERE company_id = 'default' AND code = 'inventory.edit')),
  ('role_manager', (SELECT id FROM permissions WHERE company_id = 'default' AND code = 'inventory.reports'));
