-- Contact-centric workflow restructure
-- Tasks and Appointments can be related to either a Contact or an Organization.
-- (leads, deals, invoices already have contact_id / organization_id columns.)

ALTER TABLE tasks ADD COLUMN organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE appointments ADD COLUMN organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_organization ON tasks(organization_id);
CREATE INDEX IF NOT EXISTS idx_appointments_organization ON appointments(organization_id);
