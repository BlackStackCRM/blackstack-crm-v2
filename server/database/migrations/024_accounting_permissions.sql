-- Migration 024: Accounting & Finance RBAC permissions
INSERT OR IGNORE INTO permissions (id, company_id, code, module, name, description) VALUES
  ('perm_acc_001', 'default', 'accounting.view', 'accounting', 'View Accounting', 'Can view accounting data and reports'),
  ('perm_acc_002', 'default', 'accounting.create', 'accounting', 'Create Accounting Transactions', 'Can create journal entries and vouchers'),
  ('perm_acc_003', 'default', 'accounting.edit', 'accounting', 'Edit Accounting Transactions', 'Can edit draft accounting transactions'),
  ('perm_acc_004', 'default', 'accounting.post', 'accounting', 'Post Accounting Transactions', 'Can post vouchers to the ledger'),
  ('perm_acc_005', 'default', 'accounting.cancel', 'accounting', 'Cancel Accounting Transactions', 'Can cancel posted vouchers'),
  ('perm_acc_006', 'default', 'accounting.reverse', 'accounting', 'Reverse Accounting Transactions', 'Can reverse posted vouchers'),
  ('perm_acc_007', 'default', 'accounting.manage', 'accounting', 'Manage Accounting Settings', 'Can manage chart of accounts, cost centres, budgets, bank accounts'),
  ('perm_acc_008', 'default', 'accounting.override_locked', 'accounting', 'Override Locked Period', 'Can post/void transactions in locked financial years'),
  ('perm_acc_009', 'default', 'coa.manage', 'accounting', 'Manage Chart of Accounts', 'Can create, edit, delete chart of accounts'),
  ('perm_acc_010', 'default', 'budget.manage', 'accounting', 'Manage Budgets', 'Can create and edit budgets'),
  ('perm_acc_011', 'default', 'reports.export', 'accounting', 'Export Financial Reports', 'Can export financial reports to CSV/PDF'),
  ('perm_acc_012', 'default', 'finance.manage', 'accounting', 'Manage Full Finance Module', 'Full access to all accounting & finance functions');

-- Assign all accounting permissions to admin role
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'role_admin', id FROM permissions WHERE company_id = 'default' AND (code LIKE 'accounting.%' OR code LIKE 'coa.%' OR code LIKE 'budget.%' OR code LIKE 'reports.export');

-- Assign accounting view + create to manager role
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES
  ('role_manager', 'perm_acc_001'), -- accounting.view
  ('role_manager', 'perm_acc_002'), -- accounting.create
  ('role_manager', 'perm_acc_003'), -- accounting.edit
  ('role_manager', 'perm_acc_007'), -- accounting.manage
  ('role_manager', 'perm_acc_009'), -- coa.manage
  ('role_manager', 'perm_acc_010'), -- budget.manage
  ('role_manager', 'perm_acc_011'), -- reports.export
  ('role_manager', 'perm_acc_012'); -- finance.manage
