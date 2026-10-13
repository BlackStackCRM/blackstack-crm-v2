-- Migration 062: Step 11 — Permissions for credit/debit note view & cancel
INSERT OR IGNORE INTO permissions (id, company_id, code, module, name, description) VALUES
  ('perm_cb_019', 'default', 'customer_bills.view_credit_note',  'customer_bills', 'View Credit Notes',  'Can view credit note details and list credit notes'),
  ('perm_cb_020', 'default', 'customer_bills.cancel_credit_note', 'customer_bills', 'Cancel Credit Notes', 'Can cancel (reverse) posted credit notes'),
  ('perm_cb_021', 'default', 'customer_bills.view_debit_note',   'customer_bills', 'View Debit Notes',   'Can view debit note details and list debit notes'),
  ('perm_cb_022', 'default', 'customer_bills.cancel_debit_note',  'customer_bills', 'Cancel Debit Notes', 'Can cancel (reverse) posted debit notes');

-- Assign new permissions to admin role
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'role_admin', id FROM permissions WHERE company_id = 'default' AND code IN (
    'customer_bills.view_credit_note', 'customer_bills.cancel_credit_note',
    'customer_bills.view_debit_note', 'customer_bills.cancel_debit_note'
  );
