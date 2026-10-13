-- Migration 057: Customer Bills RBAC permissions
INSERT OR IGNORE INTO permissions (id, company_id, code, module, name, description) VALUES
  ('perm_cb_001', 'default', 'customer_bills.view',               'customer_bills', 'View Customer Bills', 'Can view customer bills list and details'),
  ('perm_cb_002', 'default', 'customer_bills.create',             'customer_bills', 'Create Customer Bills', 'Can create new customer bills'),
  ('perm_cb_003', 'default', 'customer_bills.edit',               'customer_bills', 'Edit Customer Bills', 'Can edit draft customer bills'),
  ('perm_cb_004', 'default', 'customer_bills.approve',            'customer_bills', 'Approve Customer Bills', 'Can submit for approval and approve customer bills'),
  ('perm_cb_005', 'default', 'customer_bills.post',               'customer_bills', 'Post Customer Bills', 'Can post customer bills to the ledger and create journal entries'),
  ('perm_cb_006', 'default', 'customer_bills.cancel',             'customer_bills', 'Cancel Customer Bills', 'Can cancel and reverse posted customer bills'),
  ('perm_cb_007', 'default', 'customer_bills.delete_draft',       'customer_bills', 'Delete Draft Customer Bills', 'Can delete draft customer bills'),
  ('perm_cb_008', 'default', 'customer_bills.record_payment',     'customer_bills', 'Record Customer Payments', 'Can record payments and allocate across invoices'),
  ('perm_cb_009', 'default', 'customer_bills.create_credit_note', 'customer_bills', 'Create Credit Notes', 'Can create credit notes for customer bills'),
  ('perm_cb_010', 'default', 'customer_bills.create_debit_note',  'customer_bills', 'Create Debit Notes', 'Can create debit notes for customer bills'),
  ('perm_cb_011', 'default', 'customer_bills.view_reports',       'customer_bills', 'View Customer Bill Reports', 'Can view sales register, AR aging, customer statements'),
  ('perm_cb_012', 'default', 'customer_bills.export',             'customer_bills', 'Export Customer Bills', 'Can export customer bills to CSV/PDF'),
  ('perm_cb_013', 'default', 'customer_bills.write_off',          'customer_bills', 'Write-off Customer Bills', 'Can write off bad debt receivables'),
  ('perm_cb_014', 'default', 'customer_bills.manage_advance',     'customer_bills', 'Manage Customer Advances', 'Can record and apply customer advances'),
  ('perm_cb_015', 'default', 'customer_bills.send',               'customer_bills', 'Send Customer Bills', 'Can send bills via email/WhatsApp'),
  ('perm_cb_016', 'default', 'customer_bills.allocate',           'customer_bills', 'Allocate Customer Payments', 'Can allocate payments across multiple invoices'),
  ('perm_cb_017', 'default', 'customer_bills.reconcile',          'customer_bills', 'Reconcile Customer Payments', 'Can reconcile payments against bank statements'),
  ('perm_cb_018', 'default', 'customer_bills.dispute',            'customer_bills', 'Dispute Customer Bills', 'Can raise and resolve customer bill disputes');

-- Assign all customer_bills permissions to admin role
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'role_admin', id FROM permissions WHERE company_id = 'default' AND code LIKE 'customer_bills.%';

-- Managers get view, create, edit, record_payment, view_reports, export
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES
  ('role_manager', 'perm_cb_001'), -- customer_bills.view
  ('role_manager', 'perm_cb_002'), -- customer_bills.create
  ('role_manager', 'perm_cb_003'), -- customer_bills.edit
  ('role_manager', 'perm_cb_008'), -- customer_bills.record_payment
  ('role_manager', 'perm_cb_011'), -- customer_bills.view_reports
  ('role_manager', 'perm_cb_012'); -- customer_bills.export
