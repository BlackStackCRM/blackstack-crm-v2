-- Grant Customer Tenant accounts read-only access to core CRM modules.
-- No create, edit, delete, manage, or export permissions are added here.

INSERT OR IGNORE INTO roles (id, company_id, name, code, description, is_system)
VALUES (
  'role_customer_tenant',
  'default',
  'Customer Tenant',
  'CUSTOMER_TENANT',
  'Read-only access to core CRM modules for customer tenants',
  1
);

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT 'role_customer_tenant', id
FROM permissions
WHERE company_id = 'default'
  AND code IN (
    'leads.view',
    'contacts.view',
    'organizations.view',
    'deals.view',
    'pipelines.view',
    'tasks.view',
    'appointments.view',
    'customer_bills.view',
    'accounting.view',
    'products.view',
    'workflows.view',
    'reports.view'
  );

-- Attach the read-only role to existing hierarchy and legacy customer admins.
INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT id, 'role_customer_tenant'
FROM users
WHERE lower(coalesce(hierarchy_role, '')) = 'customer_tenant'
   OR upper(coalesce(role, '')) = 'CUSTOMER_ADMIN'
   OR lower(coalesce(role, '')) = 'customer_tenant';

-- New customer tenant accounts receive the same role automatically.
CREATE TRIGGER IF NOT EXISTS trg_customer_tenant_view_role_insert
AFTER INSERT ON users
WHEN lower(coalesce(NEW.hierarchy_role, '')) = 'customer_tenant'
  OR upper(coalesce(NEW.role, '')) = 'CUSTOMER_ADMIN'
  OR lower(coalesce(NEW.role, '')) = 'customer_tenant'
BEGIN
  INSERT OR IGNORE INTO user_roles (user_id, role_id)
  VALUES (NEW.id, 'role_customer_tenant');
END;

CREATE TRIGGER IF NOT EXISTS trg_customer_tenant_view_role_update
AFTER UPDATE OF hierarchy_role, role ON users
BEGIN
  INSERT OR IGNORE INTO user_roles (user_id, role_id)
  SELECT NEW.id, 'role_customer_tenant'
  WHERE lower(coalesce(NEW.hierarchy_role, '')) = 'customer_tenant'
     OR upper(coalesce(NEW.role, '')) = 'CUSTOMER_ADMIN'
     OR lower(coalesce(NEW.role, '')) = 'customer_tenant';

  DELETE FROM user_roles
  WHERE user_id = NEW.id
    AND role_id = 'role_customer_tenant'
    AND lower(coalesce(NEW.hierarchy_role, '')) <> 'customer_tenant'
    AND upper(coalesce(NEW.role, '')) <> 'CUSTOMER_ADMIN'
    AND lower(coalesce(NEW.role, '')) <> 'customer_tenant';
END;
