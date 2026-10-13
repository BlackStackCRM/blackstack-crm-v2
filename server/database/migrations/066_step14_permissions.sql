-- Step 14: Collection automation permissions

INSERT INTO permissions (id, company_id, code, module, name, description) VALUES
  ('perm_s14_001', 'default', 'customer_bills.view_collections',        'customer_bills', 'View Collections Workspace',     'Can view collection dashboard and lists'),
  ('perm_s14_002', 'default', 'customer_bills.manage_collection_rules',  'customer_bills', 'Manage Collection Rules',      'Can create/update/delete collection rules'),
  ('perm_s14_003', 'default', 'customer_bills.execute_collection_actions', 'customer_bills', 'Execute Collection Actions', 'Can create and execute collection actions'),
  ('perm_s14_004', 'default', 'customer_bills.manage_payment_plans',     'customer_bills', 'Manage Payment Plans',         'Can create/update/approve payment plans'),
  ('perm_s14_005', 'default', 'customer_bills.calculate_interest',       'customer_bills', 'Calculate Interest',          'Can calculate late fee/interest charges'),
  ('perm_s14_006', 'default', 'customer_bills.approve_interest',         'customer_bills', 'Approve Interest',            'Can approve interest charges'),
  ('perm_s14_007', 'default', 'customer_bills.manage_bad_debt',          'customer_bills', 'Manage Bad Debt',             'Can propose and manage bad debt cases'),
  ('perm_s14_008', 'default', 'customer_bills.approve_bad_debt',         'customer_bills', 'Approve Bad Debt',            'Can approve bad debt write-offs'),
  ('perm_s14_009', 'default', 'customer_bills.view_collection_risk',     'customer_bills', 'View Collection Risk',        'Can view collection risk scores'),
  ('perm_s14_010', 'default', 'customer_bills.manage_escalations',       'customer_bills', 'Manage Escalations',          'Can create and manage escalations'),
  ('perm_s14_011', 'default', 'customer_bills.export_collections',       'customer_bills', 'Export Collections',          'Can export collection data');
