-- Migration 026: Extend payments table for accounting integration
-- Makes invoice_id nullable (accounting payments may not reference an invoice) and adds bill_id column

CREATE TABLE IF NOT EXISTS _payments_backup AS SELECT * FROM payments LIMIT 0;

-- Rebuild payments table with invoice_id nullable and bill_id column
CREATE TABLE payments_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  invoice_id TEXT REFERENCES invoices(id),
  bill_id TEXT REFERENCES bills(id),
  contact_id TEXT REFERENCES contacts(id),
  amount REAL NOT NULL,
  payment_method TEXT,
  status TEXT DEFAULT 'COMPLETED',
  reference_number TEXT,
  notes TEXT,
  payment_date TEXT NOT NULL,
  currency TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Copy existing payments; bill_id will be NULL since the old table doesn't have it
INSERT OR IGNORE INTO payments_new (id, company_id, invoice_id, contact_id, amount, payment_method, status, reference_number, notes, payment_date, currency, created_at, updated_at)
  SELECT id, company_id, invoice_id, contact_id, amount, payment_method, status, reference_number, notes, payment_date, currency, created_at, updated_at FROM payments;

DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;

CREATE INDEX IF NOT EXISTS idx_payments_company ON payments(company_id);
CREATE INDEX IF NOT EXISTS idx_payments_bill ON payments(bill_id);
