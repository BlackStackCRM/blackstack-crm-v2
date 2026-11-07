-- Migration 093: explicit workflow execution and activity deletion permissions.
-- Existing role assignments are preserved; only the system administrator
-- receives these new sensitive permissions automatically.

INSERT OR IGNORE INTO permissions (id, company_id, code, module, name, description) VALUES
  ('perm_sec_001', 'default', 'workflows.execute', 'workflows', 'Execute Workflows', 'Can manually execute active workflows'),
  ('perm_sec_002', 'default', 'activities.delete', 'activities', 'Delete Activities', 'Can permanently delete activity records'),
  ('perm_sec_003', 'default', 'appointments.view', 'appointments', 'View Appointments', 'Can view appointment records'),
  ('perm_sec_004', 'default', 'appointments.delete', 'appointments', 'Delete Appointments', 'Can permanently delete appointment records');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'role_admin', id FROM permissions
   WHERE company_id = 'default'
     AND code IN ('workflows.execute', 'activities.delete', 'appointments.view', 'appointments.delete');
