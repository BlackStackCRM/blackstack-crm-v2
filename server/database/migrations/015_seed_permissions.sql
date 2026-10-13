INSERT OR IGNORE INTO permissions (id, company_id, code, module, name, description) VALUES
  ('perm_001', 'default', 'contacts.view', 'contacts', 'View Contacts', 'Can view contacts and search list'),
  ('perm_002', 'default', 'contacts.create', 'contacts', 'Create Contacts', 'Can create new contacts'),
  ('perm_003', 'default', 'contacts.edit', 'contacts', 'Edit Contacts', 'Can modify existing contact records'),
  ('perm_004', 'default', 'contacts.delete', 'contacts', 'Delete Contacts', 'Can delete contact records'),
  ('perm_005', 'default', 'organizations.view', 'organizations', 'View Organizations', 'Can view organizations'),
  ('perm_006', 'default', 'organizations.create', 'organizations', 'Create Organizations', 'Can create organizations'),
  ('perm_007', 'default', 'organizations.edit', 'organizations', 'Edit Organizations', 'Can modify organizations'),
  ('perm_008', 'default', 'organizations.delete', 'organizations', 'Delete Organizations', 'Can delete organizations'),
  ('perm_009', 'default', 'deals.view', 'deals', 'View Deals', 'Can view deals'),
  ('perm_010', 'default', 'deals.create', 'deals', 'Create Deals', 'Can create deals'),
  ('perm_011', 'default', 'deals.edit', 'deals', 'Edit Deals', 'Can modify deals'),
  ('perm_012', 'default', 'deals.delete', 'deals', 'Delete Deals', 'Can delete deals'),
  ('perm_013', 'default', 'invoices.view', 'invoices', 'View Invoices', 'Can view invoices'),
  ('perm_014', 'default', 'invoices.create', 'invoices', 'Create Invoices', 'Can create invoices'),
  ('perm_015', 'default', 'invoices.edit', 'invoices', 'Edit Invoices', 'Can modify invoices'),
  ('perm_016', 'default', 'invoices.delete', 'invoices', 'Delete Invoices', 'Can delete invoices'),
  ('perm_017', 'default', 'payments.view', 'payments', 'View Payments', 'Can view payments'),
  ('perm_018', 'default', 'payments.create', 'payments', 'Create Payments', 'Can record payments'),
  ('perm_019', 'default', 'payments.refund', 'payments', 'Refund Payments', 'Can refund payments'),
  ('perm_020', 'default', 'products.view', 'products', 'View Products', 'Can view products'),
  ('perm_021', 'default', 'products.create', 'products', 'Create Products', 'Can create products'),
  ('perm_022', 'default', 'products.edit', 'products', 'Edit Products', 'Can modify products'),
  ('perm_023', 'default', 'products.delete', 'products', 'Delete Products', 'Can delete products'),
  ('perm_024', 'default', 'tasks.view', 'tasks', 'View Tasks', 'Can view tasks'),
  ('perm_025', 'default', 'tasks.create', 'tasks', 'Create Tasks', 'Can create tasks'),
  ('perm_026', 'default', 'tasks.edit', 'tasks', 'Edit Tasks', 'Can modify tasks'),
  ('perm_027', 'default', 'tasks.delete', 'tasks', 'Delete Tasks', 'Can delete tasks'),
  ('perm_028', 'default', 'activities.view', 'activities', 'View Activities', 'Can view activities'),
  ('perm_029', 'default', 'activities.create', 'activities', 'Create Activities', 'Can create activities'),
  ('perm_030', 'default', 'workflows.view', 'workflows', 'View Workflows', 'Can view workflows'),
  ('perm_031', 'default', 'workflows.manage', 'workflows', 'Manage Workflows', 'Can create and edit workflows'),
  ('perm_032', 'default', 'reports.view', 'reports', 'View Reports', 'Can view reports'),
  ('perm_033', 'default', 'users.view', 'users', 'View Users', 'Can view users'),
  ('perm_034', 'default', 'users.manage', 'users', 'Manage Users', 'Can create and edit users'),
  ('perm_035', 'default', 'settings.manage', 'settings', 'Manage Settings', 'Can modify settings'),
  ('perm_036', 'default', 'audit.view', 'audit', 'View Audit Logs', 'Can view audit logs'),
  ('perm_037', 'default', 'database.view', 'admin', 'View Database', 'Can access read-only database/server viewer');

INSERT OR IGNORE INTO roles (id, company_id, name, code, description, is_system) VALUES
  ('role_admin', 'default', 'Administrator', 'ADMIN', 'Full system access', 1),
  ('role_manager', 'default', 'Manager', 'MANAGER', 'Management access', 1),
  ('role_user', 'default', 'User', 'USER', 'Standard user access', 1);

-- NOTE: the 'admin' user is created by seed.js (bootstrap credentials), so its
-- role assignment also lives there. Migrations only seed system tables.

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'role_admin', id FROM permissions;
