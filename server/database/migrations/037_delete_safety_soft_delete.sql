-- ============================================================
-- Migration 036: Delete Safety & Soft Delete Standard
-- Approved plan (Stage 2):
--   1. Soft-delete columns on business entities
--   2. Retighten dangerous CASCADEs -> RESTRICT:
--        leads.contact_id, invoices.contact_id,
--        relationships.person_a_id/person_b_id/organization_id,
--        notes.contact_id/organization_id/deal_id   (notes policy: RESTRICT)
--   3. All other FK rules unchanged.
-- Idempotent: safe to re-run. Rebuilds only tables whose FKs change.
-- ============================================================

-- ------------------------------------------------------------------
-- Part 1: Soft-delete columns
-- ------------------------------------------------------------------
ALTER TABLE contacts       ADD COLUMN deleted_at DATETIME;
ALTER TABLE contacts       ADD COLUMN deleted_by TEXT;
ALTER TABLE contacts       ADD COLUMN delete_reason TEXT;
ALTER TABLE contacts       ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE contacts       ADD COLUMN updated_by TEXT;

ALTER TABLE organizations  ADD COLUMN deleted_at DATETIME;
ALTER TABLE organizations  ADD COLUMN deleted_by TEXT;
ALTER TABLE organizations  ADD COLUMN delete_reason TEXT;
ALTER TABLE organizations  ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE organizations  ADD COLUMN updated_by TEXT;

ALTER TABLE leads          ADD COLUMN deleted_at DATETIME;
ALTER TABLE leads          ADD COLUMN deleted_by TEXT;
ALTER TABLE leads          ADD COLUMN delete_reason TEXT;
ALTER TABLE leads          ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE leads          ADD COLUMN updated_by TEXT;

ALTER TABLE deals          ADD COLUMN deleted_at DATETIME;
ALTER TABLE deals          ADD COLUMN deleted_by TEXT;
ALTER TABLE deals          ADD COLUMN delete_reason TEXT;
ALTER TABLE deals          ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE deals          ADD COLUMN updated_by TEXT;

ALTER TABLE products       ADD COLUMN deleted_at DATETIME;
ALTER TABLE products       ADD COLUMN deleted_by TEXT;
ALTER TABLE products       ADD COLUMN delete_reason TEXT;
ALTER TABLE products       ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE products       ADD COLUMN updated_by TEXT;

ALTER TABLE tasks          ADD COLUMN deleted_at DATETIME;
ALTER TABLE tasks          ADD COLUMN deleted_by TEXT;
ALTER TABLE tasks          ADD COLUMN delete_reason TEXT;
ALTER TABLE tasks          ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks          ADD COLUMN updated_by TEXT;

ALTER TABLE notes          ADD COLUMN deleted_at DATETIME;
ALTER TABLE notes          ADD COLUMN deleted_by TEXT;
ALTER TABLE notes          ADD COLUMN delete_reason TEXT;
ALTER TABLE notes          ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notes          ADD COLUMN updated_by TEXT;

ALTER TABLE appointments   ADD COLUMN deleted_at DATETIME;
ALTER TABLE appointments   ADD COLUMN deleted_by TEXT;
ALTER TABLE appointments   ADD COLUMN delete_reason TEXT;
ALTER TABLE appointments   ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE appointments   ADD COLUMN updated_by TEXT;

ALTER TABLE pipelines      ADD COLUMN deleted_at DATETIME;
ALTER TABLE pipelines      ADD COLUMN deleted_by TEXT;
ALTER TABLE pipelines      ADD COLUMN delete_reason TEXT;
ALTER TABLE pipelines      ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pipelines      ADD COLUMN updated_by TEXT;

ALTER TABLE relationships  ADD COLUMN deleted_at DATETIME;
ALTER TABLE relationships  ADD COLUMN deleted_by TEXT;
ALTER TABLE relationships  ADD COLUMN delete_reason TEXT;
ALTER TABLE relationships  ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE relationships  ADD COLUMN updated_by TEXT;

ALTER TABLE workflow_definitions ADD COLUMN deleted_at DATETIME;
ALTER TABLE workflow_definitions ADD COLUMN deleted_by TEXT;
ALTER TABLE workflow_definitions ADD COLUMN delete_reason TEXT;
ALTER TABLE workflow_definitions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workflow_definitions ADD COLUMN updated_by TEXT;

-- ------------------------------------------------------------------
-- Part 2: FK retighten via table rebuild (RESTRICT)
-- ------------------------------------------------------------------

-- invoices
CREATE TABLE invoices_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  invoice_number TEXT UNIQUE NOT NULL,
  contact_id TEXT NOT NULL,
  organization_id TEXT,
  deal_id TEXT,
  status TEXT DEFAULT 'DRAFT',
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  subtotal REAL DEFAULT 0.0,
  tax REAL DEFAULT 0.0,
  discount REAL DEFAULT 0.0,
  total REAL DEFAULT 0.0,
  paid_amount REAL DEFAULT 0.0,
  balance REAL DEFAULT 0.0,
  notes TEXT,
  terms TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  currency TEXT DEFAULT 'USD',
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL
);
INSERT INTO invoices_new SELECT * FROM invoices;
DROP TABLE invoices;
ALTER TABLE invoices_new RENAME TO invoices;

-- leads
CREATE TABLE leads_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  contact_id TEXT NOT NULL,
  source TEXT DEFAULT 'manual',
  lead_status TEXT DEFAULT 'NEW',
  lead_score INTEGER DEFAULT 0,
  budget REAL,
  timeline TEXT,
  decision_maker TEXT,
  interest_level TEXT,
  qualification_notes TEXT,
  converted_at DATETIME,
  lost_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME,
  deleted_by TEXT,
  delete_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT
);
INSERT INTO leads_new SELECT * FROM leads;
DROP TABLE leads;
ALTER TABLE leads_new RENAME TO leads;

-- relationships
CREATE TABLE relationships_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  relationship_type TEXT NOT NULL,
  status TEXT DEFAULT 'ACTIVE',
  person_a_id TEXT NOT NULL,
  person_b_id TEXT,
  organization_id TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME,
  deleted_by TEXT,
  delete_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  FOREIGN KEY (person_a_id) REFERENCES contacts(id) ON DELETE RESTRICT,
  FOREIGN KEY (person_b_id) REFERENCES contacts(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT
);
INSERT INTO relationships_new SELECT * FROM relationships;
DROP TABLE relationships;
ALTER TABLE relationships_new RENAME TO relationships;

-- notes
CREATE TABLE notes_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  title TEXT NOT NULL,
  content TEXT,
  contact_id TEXT,
  organization_id TEXT,
  deal_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME,
  deleted_by TEXT,
  delete_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE RESTRICT
);
INSERT INTO notes_new SELECT * FROM notes;
DROP TABLE notes;
ALTER TABLE notes_new RENAME TO notes;

-- ------------------------------------------------------------------
-- Part 3: Indexes for soft-delete filtering
-- ------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_contacts_deleted_at ON contacts(deleted_at);
CREATE INDEX IF NOT EXISTS idx_organizations_deleted_at ON organizations(deleted_at);
CREATE INDEX IF NOT EXISTS idx_leads_deleted_at ON leads(deleted_at);
CREATE INDEX IF NOT EXISTS idx_deals_deleted_at ON deals(deleted_at);
CREATE INDEX IF NOT EXISTS idx_products_deleted_at ON products(deleted_at);
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON tasks(deleted_at);
CREATE INDEX IF NOT EXISTS idx_notes_deleted_at ON notes(deleted_at);
CREATE INDEX IF NOT EXISTS idx_appointments_deleted_at ON appointments(deleted_at);
CREATE INDEX IF NOT EXISTS idx_pipelines_deleted_at ON pipelines(deleted_at);
