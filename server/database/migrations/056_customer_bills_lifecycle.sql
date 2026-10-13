-- Migration 056: Customer Bills full lifecycle
-- Extends the existing bills/bill_items tables with the full Customer Bill
-- accounting lifecycle: approval, posting, tax-inclusive billing, GST fields,
-- credit control, addresses, payment terms, costing dimensions.
-- Adds: bill audit log, customer advances, bill approvals, recurring bills,
--       payment reminders, recurring job state.

-- ─── Extend bills table ────────────────────────────────────────────────
ALTER TABLE bills ADD COLUMN invoice_number TEXT;
ALTER TABLE bills ADD COLUMN customer_gstin TEXT;
ALTER TABLE bills ADD COLUMN billing_address TEXT;
ALTER TABLE bills ADD COLUMN shipping_address TEXT;
ALTER TABLE bills ADD COLUMN place_of_supply TEXT;
ALTER TABLE bills ADD COLUMN customer_po_number TEXT;
ALTER TABLE bills ADD COLUMN customer_po_date TEXT;
ALTER TABLE bills ADD COLUMN salesperson_id TEXT;
ALTER TABLE bills ADD COLUMN sales_channel TEXT;
ALTER TABLE bills ADD COLUMN payment_terms TEXT;
ALTER TABLE bills ADD COLUMN price_list_id TEXT;
ALTER TABLE bills ADD COLUMN branch_id TEXT;
ALTER TABLE bills ADD COLUMN warehouse_id TEXT;
ALTER TABLE bills ADD COLUMN project_id TEXT;
ALTER TABLE bills ADD COLUMN cost_centre_id TEXT;
ALTER TABLE bills ADD COLUMN is_tax_inclusive INTEGER DEFAULT 0;
ALTER TABLE bills ADD COLUMN round_off REAL DEFAULT 0.0;
ALTER TABLE bills ADD COLUMN other_charges REAL DEFAULT 0.0;
ALTER TABLE bills ADD COLUMN discount_amount REAL DEFAULT 0.0;
ALTER TABLE bills ADD COLUMN taxable_amount REAL DEFAULT 0.0;
ALTER TABLE bills ADD COLUMN tax_master_id TEXT;
ALTER TABLE bills ADD COLUMN is_interstate INTEGER DEFAULT 0;
ALTER TABLE bills ADD COLUMN company_state TEXT;
ALTER TABLE bills ADD COLUMN salesperson_name TEXT;
ALTER TABLE bills ADD COLUMN cgst_amount REAL DEFAULT 0.0;
ALTER TABLE bills ADD COLUMN sgst_amount REAL DEFAULT 0.0;
ALTER TABLE bills ADD COLUMN igst_amount REAL DEFAULT 0.0;
ALTER TABLE bills ADD COLUMN cgst_rate REAL DEFAULT 0.0;
ALTER TABLE bills ADD COLUMN sgst_rate REAL DEFAULT 0.0;
ALTER TABLE bills ADD COLUMN igst_rate REAL DEFAULT 0.0;
ALTER TABLE bills ADD COLUMN journal_entry_id TEXT;
ALTER TABLE bills ADD COLUMN approved_by TEXT;
ALTER TABLE bills ADD COLUMN approved_at TEXT;
ALTER TABLE bills ADD COLUMN posted_by TEXT;
ALTER TABLE bills ADD COLUMN posted_at TEXT;
ALTER TABLE bills ADD COLUMN cancelled_by TEXT;
ALTER TABLE bills ADD COLUMN cancelled_at TEXT;
ALTER TABLE bills ADD COLUMN cancellation_reason TEXT;
ALTER TABLE bills ADD COLUMN reversal_journal_entry_id TEXT;
ALTER TABLE bills ADD COLUMN idempotency_key TEXT;
ALTER TABLE bills ADD COLUMN payment_terms_days INTEGER DEFAULT 30;
ALTER TABLE bills ADD COLUMN due_date_calc TEXT;

-- Update the status CHECK constraint to include the full lifecycle.
-- SQLite cannot ALTER a CHECK constraint in place, so we recreate the table.
-- (Migration 044 already demonstrated table-rebuild for constraints.)
CREATE TABLE bills_new AS SELECT * FROM bills;
DROP TABLE bills;
CREATE TABLE bills (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  bill_number TEXT NOT NULL,
  bill_type TEXT NOT NULL CHECK (bill_type IN ('CUSTOMER', 'SUPPLIER')),
  contact_id TEXT NOT NULL,
  organization_id TEXT,
  deal_id TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','POSTED','PARTIALLY_PAID','PAID','OVERDUE','WRITTEN_OFF','CANCELLED','VOID','SENT','PARTIAL')),
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  subtotal REAL DEFAULT 0.0,
  tax REAL DEFAULT 0.0,
  discount REAL DEFAULT 0.0,
  total REAL DEFAULT 0.0,
  paid_amount REAL DEFAULT 0.0,
  balance REAL DEFAULT 0.0,
  reference_number TEXT,
  notes TEXT,
  terms TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  invoice_number TEXT,
  customer_gstin TEXT,
  billing_address TEXT,
  shipping_address TEXT,
  place_of_supply TEXT,
  customer_po_number TEXT,
  customer_po_date TEXT,
  salesperson_id TEXT,
  sales_channel TEXT,
  payment_terms TEXT,
  price_list_id TEXT,
  branch_id TEXT,
  warehouse_id TEXT,
  project_id TEXT,
  cost_centre_id TEXT,
  is_tax_inclusive INTEGER DEFAULT 0,
  round_off REAL DEFAULT 0.0,
  other_charges REAL DEFAULT 0.0,
  discount_amount REAL DEFAULT 0.0,
  taxable_amount REAL DEFAULT 0.0,
  tax_master_id TEXT,
  is_interstate INTEGER DEFAULT 0,
  company_state TEXT,
  salesperson_name TEXT,
  cgst_amount REAL DEFAULT 0.0,
  sgst_amount REAL DEFAULT 0.0,
  igst_amount REAL DEFAULT 0.0,
  cgst_rate REAL DEFAULT 0.0,
  sgst_rate REAL DEFAULT 0.0,
  igst_rate REAL DEFAULT 0.0,
  journal_entry_id TEXT,
  approved_by TEXT,
  approved_at TEXT,
  posted_by TEXT,
  posted_at TEXT,
  cancelled_by TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  reversal_journal_entry_id TEXT,
  idempotency_key TEXT,
  payment_terms_days INTEGER DEFAULT 30,
  due_date_calc TEXT,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL,
  UNIQUE(company_id, bill_number),
  UNIQUE(company_id, invoice_number)
);
INSERT INTO bills SELECT * FROM bills_new;
DROP TABLE bills_new;

CREATE INDEX IF NOT EXISTS idx_bills_invoice_number ON bills(company_id, invoice_number);
CREATE INDEX IF NOT EXISTS idx_bills_journal_entry_id ON bills(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_bills_idempotency_key ON bills(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ─── Extend bill_items ─────────────────────────────────────────────────
ALTER TABLE bill_items ADD COLUMN sku TEXT;
ALTER TABLE bill_items ADD COLUMN hsn_sac TEXT;
ALTER TABLE bill_items ADD COLUMN unit TEXT DEFAULT 'PCS';
ALTER TABLE bill_items ADD COLUMN discount_percent REAL DEFAULT 0.0;
ALTER TABLE bill_items ADD COLUMN discount_amount REAL DEFAULT 0.0;
ALTER TABLE bill_items ADD COLUMN taxable_amount REAL DEFAULT 0.0;
ALTER TABLE bill_items ADD COLUMN cgst_rate REAL DEFAULT 0.0;
ALTER TABLE bill_items ADD COLUMN sgst_rate REAL DEFAULT 0.0;
ALTER TABLE bill_items ADD COLUMN igst_rate REAL DEFAULT 0.0;
ALTER TABLE bill_items ADD COLUMN cess_rate REAL DEFAULT 0.0;
ALTER TABLE bill_items ADD COLUMN cess_amount REAL DEFAULT 0.0;
ALTER TABLE bill_items ADD COLUMN other_tax REAL DEFAULT 0.0;
ALTER TABLE bill_items ADD COLUMN tax_master_id TEXT;
ALTER TABLE bill_items ADD COLUMN warehouse_id TEXT;
ALTER TABLE bill_items ADD COLUMN batch TEXT;
ALTER TABLE bill_items ADD COLUMN serial_number TEXT;
ALTER TABLE bill_items ADD COLUMN expiry TEXT;
ALTER TABLE bill_items ADD COLUMN project_id TEXT;
ALTER TABLE bill_items ADD COLUMN cost_centre_id TEXT;

-- ─── Bill audit log ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_bill_audit_log (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  bill_id TEXT NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  changes_json TEXT,
  ip_address TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bill_audit_bill ON customer_bill_audit_log(bill_id, company_id);
CREATE INDEX IF NOT EXISTS idx_bill_audit_action ON customer_bill_audit_log(bill_id, action);

-- ─── Bill approvals ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bill_approvals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  bill_id TEXT NOT NULL,
  approver_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  comments TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bill_approvals_bill ON bill_approvals(bill_id);

-- ─── Customer advances ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_advances (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  contact_id TEXT NOT NULL,
  organization_id TEXT,
  amount REAL NOT NULL DEFAULT 0.0,
  applied_amount REAL DEFAULT 0.0,
  balance REAL DEFAULT 0.0,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','APPLIED','CANCELLED','REFUNDED')),
  reference_number TEXT,
  notes TEXT,
  journal_entry_id TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_advances_contact ON customer_advances(company_id, contact_id);

-- ─── Recurring bills ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recurring_bills (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  bill_number TEXT,
  contact_id TEXT NOT NULL,
  organization_id TEXT,
  currency TEXT NOT NULL DEFAULT 'INR',
  frequency TEXT NOT NULL CHECK (frequency IN ('DAILY','WEEKLY','MONTHLY','QUARTERLY','HALF_YEARLY','YEARLY','CUSTOM')),
  interval_value INTEGER DEFAULT 1,
  start_date TEXT NOT NULL,
  end_date TEXT,
  next_generation_date TEXT NOT NULL,
  auto_post INTEGER DEFAULT 0,
  auto_send INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  template_json TEXT,
  last_generated_bill_id TEXT,
  last_generated_at TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
  FOREIGN KEY (last_generated_bill_id) REFERENCES bills(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_recurring_bills_next ON recurring_bills(company_id, next_generation_date) WHERE is_active = 1;

-- ─── Payment reminders ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_reminders (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  bill_id TEXT NOT NULL,
  reminder_type TEXT NOT NULL CHECK (reminder_type IN ('UPCOMING','DUE_TODAY','OVERDUE_1','OVERDUE_2','OVERDUE_3','MANAGER_ESCALATION')),
  due_date TEXT NOT NULL,
  days_offset INTEGER,
  is_sent INTEGER DEFAULT 0,
  sent_at TEXT,
  sent_via TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_payment_reminders_bill ON payment_reminders(bill_id);
CREATE INDEX IF NOT EXISTS idx_payment_reminders_due ON payment_reminders(company_id, due_date) WHERE is_sent = 0;

-- ─── Bill document templates (for PDF/print) ───────────────────────────
CREATE TABLE IF NOT EXISTS bill_templates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  is_default INTEGER DEFAULT 0,
  template_json TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, name)
);

-- ─── Bill events (for automation / WhatsApp / email triggers) ─────────
CREATE TABLE IF NOT EXISTS bill_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  bill_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  triggered INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bill_events_bill ON bill_events(bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_events_type ON bill_events(company_id, event_type, triggered);

-- ─── Idempotency guard for recurring generation ────────────────────────
CREATE TABLE IF NOT EXISTS recurring_generation_log (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  recurring_bill_id TEXT NOT NULL,
  scheduled_date TEXT NOT NULL,
  bill_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('SUCCESS','FAILED','SKIPPED')),
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(recurring_bill_id, scheduled_date)
);
CREATE INDEX IF NOT EXISTS idx_recurring_log_recurring ON recurring_generation_log(recurring_bill_id);

-- ─── Customer bill write-offs (bad debt) ───────────────────────────────
CREATE TABLE IF NOT EXISTS customer_bill_writeoffs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  bill_id TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0.0,
  reason TEXT,
  journal_entry_id TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_bill_writeoffs_bill ON customer_bill_writeoffs(bill_id, company_id);

-- ─── Customer bill disputes ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_bill_disputes (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  bill_id TEXT NOT NULL,
  reason TEXT,
  amount REAL NOT NULL DEFAULT 0.0,
  disputed_at TEXT,
  resolved_at TEXT,
  resolution TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bill_disputes_bill ON customer_bill_disputes(bill_id, company_id);

-- ─── Payment reconciliations ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_reconciliations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  payment_id TEXT,
  bill_id TEXT,
  bank_account_id TEXT NOT NULL,
  reconciled_amount REAL NOT NULL DEFAULT 0.0,
  reconciled_date TEXT,
  statement_reference TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payment_recon_payment ON payment_reconciliations(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_recon_bill ON payment_reconciliations(bill_id);
CREATE INDEX IF NOT EXISTS idx_payment_recon_bank ON payment_reconciliations(bank_account_id);

