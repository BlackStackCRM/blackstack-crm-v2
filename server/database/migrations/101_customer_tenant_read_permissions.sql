-- Let customer tenants read the inventory reference data required by Products
-- (categories, units, brands, models) and expose the read-only Inventory page.
-- Do not grant inventory create/edit/delete/post permissions.

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT 'role_customer_tenant', id
FROM permissions
WHERE company_id = 'default'
  AND code IN (
    'inventory.view',
    'activities.view',
    'notes.view',
    'relationships.view',
    'customer_bills.view_credit_note',
    'customer_bills.view_debit_note'
  );

-- Repair historical customer accounts as well as accounts created after the
-- customer role trigger was installed.
INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT id, 'role_customer_tenant'
FROM users
WHERE lower(coalesce(hierarchy_role, '')) = 'customer_tenant'
   OR upper(coalesce(role, '')) = 'CUSTOMER_ADMIN'
   OR lower(coalesce(role, '')) = 'customer_tenant';
