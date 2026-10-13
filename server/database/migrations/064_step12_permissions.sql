-- Migration 064: Step 12 — Permissions for AR Aging, Statements & Collection Management
INSERT OR IGNORE INTO permissions (id, company_id, code, module, name, description) VALUES
  ('perm_cb_023', 'default', 'customer_bills.view_outstanding',       'customer_bills', 'View Customer Outstanding',       'Can view accounts receivable customer outstanding page'),
  ('perm_cb_024', 'default', 'customer_bills.view_aging',             'customer_bills', 'View AR Aging',                    'Can view accounts receivable aging reports'),
  ('perm_cb_025', 'default', 'customer_bills.view_statement',         'customer_bills', 'View Customer Statement',          'Can view customer account statements'),
  ('perm_cb_026', 'default', 'customer_bills.export_reports',         'customer_bills', 'Export AR Reports',                'Can export customer outstanding, aging, and statement data'),
  ('perm_cb_027', 'default', 'customer_bills.manage_collections',     'customer_bills', 'Manage Collections',               'Can manage collection assignments and activities'),
  ('perm_cb_028', 'default', 'customer_bills.assign_collection_owner', 'customer_bills', 'Assign Collection Owner',          'Can assign and reassign collection owners to customers'),
  ('perm_cb_029', 'default', 'customer_bills.manage_promises',        'customer_bills', 'Manage Promises to Pay',           'Can create, update, and cancel promises to pay'),
  ('perm_cb_030', 'default', 'customer_bills.manage_disputes',        'customer_bills', 'Manage Customer Disputes',         'Can create, update, and resolve customer disputes'),
  ('perm_cb_031', 'default', 'customer_bills.view_reports',            'customer_bills', 'View Reports',                       'Can view billing reports, sales register, and analytics'),
  ('perm_cb_032', 'default', 'customer_bills.view_collection_dashboard', 'customer_bills', 'View Collection Dashboard',         'Can view collection dashboard KPIs');

-- Assign new permissions to admin role
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'role_admin', id FROM permissions WHERE company_id = 'default' AND code IN (
    'customer_bills.view_outstanding', 'customer_bills.view_aging', 'customer_bills.view_statement',
    'customer_bills.export_reports', 'customer_bills.manage_collections',
    'customer_bills.assign_collection_owner', 'customer_bills.manage_promises',
    'customer_bills.manage_disputes', 'customer_bills.view_reports',
    'customer_bills.view_collection_dashboard'
  );
