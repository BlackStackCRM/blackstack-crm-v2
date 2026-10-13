-- Migration 063: Step 12 — Collection Management
-- Adds tables for collection assignment, activities, promises to pay, and customer disputes
-- Adds customer_code and gstin columns to contacts for AR reporting

-- ─── Add customer_code and gstin to contacts ────────────────────────────────
-- Used by customer outstanding and aging queries for customer identification
ALTER TABLE contacts ADD COLUMN customer_code TEXT;
ALTER TABLE contacts ADD COLUMN gstin TEXT;
CREATE INDEX IF NOT EXISTS idx_contacts_customer_code ON contacts(customer_code, company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_gstin ON contacts(gstin, company_id);

-- ─── Collection Assignments ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collection_assignments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  contact_id TEXT NOT NULL,           -- customer contact
  bill_id TEXT,                       -- specific bill (nullable for customer-level)
  owner_id TEXT NOT NULL,             -- user responsible for collection
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'CRITICAL')),
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'CONTACT_PENDING', 'CONTACTED', 'PROMISED', 'PARTIALLY_COLLECTED', 'DISPUTED', 'ESCALATED', 'COLLECTED', 'CLOSED')),
  last_contact_date TEXT,
  next_followup_date TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE SET NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_coll_assign_contact ON collection_assignments(contact_id, company_id);
CREATE INDEX IF NOT EXISTS idx_coll_assign_owner ON collection_assignments(owner_id, company_id);
CREATE INDEX IF NOT EXISTS idx_coll_assign_status ON collection_assignments(status, company_id);
CREATE INDEX IF NOT EXISTS idx_coll_assign_bill ON collection_assignments(bill_id, company_id);

-- ─── Collection Activities ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collection_activities (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  contact_id TEXT NOT NULL,
  bill_id TEXT,                      -- nullable for customer-level activities
  assignment_id TEXT,                -- link to collection assignment
  user_id TEXT NOT NULL,             -- user who performed the activity
  activity_type TEXT NOT NULL CHECK (activity_type IN ('PHONE_CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'REMINDER', 'PROMISE', 'ESCALATION', 'NOTE')),
  activity_date TEXT NOT NULL,
  result TEXT,
  next_action TEXT,
  next_action_date TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE SET NULL,
  FOREIGN KEY (assignment_id) REFERENCES collection_assignments(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_coll_act_contact ON collection_activities(contact_id, company_id);
CREATE INDEX IF NOT EXISTS idx_coll_act_date ON collection_activities(activity_date, company_id);

-- ─── Promises to Pay ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promises_to_pay (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  contact_id TEXT NOT NULL,
  bill_id TEXT,                     -- nullable for customer-level promise
  assignment_id TEXT,               -- link to collection assignment
  promise_date TEXT NOT NULL,       -- date customer promised to pay
  promise_amount REAL NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'PROMISED' CHECK (status IN ('PROMISED', 'FULFILLED', 'PARTIAL', 'BROKEN', 'CANCELLED')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE SET NULL,
  FOREIGN KEY (assignment_id) REFERENCES collection_assignments(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ptp_contact ON promises_to_pay(contact_id, company_id);
CREATE INDEX IF NOT EXISTS idx_ptp_date ON promises_to_pay(promise_date, company_id);

-- ─── Customer Disputes ──────────────────────────────────────────────────────
-- Step 12 collection-level disputes with full status tracking
CREATE TABLE IF NOT EXISTS customer_disputes (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  contact_id TEXT NOT NULL,
  bill_id TEXT,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  disputed_amount REAL NOT NULL,
  customer_message TEXT,
  internal_notes TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_REVIEW', 'RESOLVED', 'REJECTED', 'CLOSED')),
  owner_id TEXT,
  resolution_reason TEXT,
  resolution_date TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_disputes_contact ON customer_disputes(contact_id, company_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON customer_disputes(status, company_id);
CREATE INDEX IF NOT EXISTS idx_disputes_company ON customer_disputes(company_id);
CREATE INDEX IF NOT EXISTS idx_disputes_bill ON customer_disputes(bill_id, company_id);

-- ─── Collection Audit Trail ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collection_audit (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  entity_type TEXT NOT NULL,        -- 'collection_assignment', 'promise', 'activity', 'dispute'
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,             -- 'ASSIGN', 'REASSIGN', 'STATUS_CHANGE', 'UPDATE', 'ESCALATE', etc.
  user_id TEXT,
  old_values_json TEXT,
  new_values_json TEXT,
  ip_address TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_coll_audit_entity ON collection_audit(entity_type, entity_id, company_id);
