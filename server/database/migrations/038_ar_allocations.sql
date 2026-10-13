-- Migration 038: Accounts Receivable — allocation tracking & customer-level outstanding
-- Adds receivable-level allocation between Sales Invoices, Receipts, and Credit Notes
-- Customer outstanding is derived from the Journal Entry engine (source of truth)

-- Receivable allocations: track which receipt/credit note amounts apply to which invoice
CREATE TABLE IF NOT EXISTS receivable_allocations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  invoice_voucher_id TEXT NOT NULL,    -- The SALES voucher being settled
  payment_voucher_id TEXT,            -- The RECEIPT voucher applying payment
  credit_note_voucher_id TEXT,        -- The CREDIT_NOTE voucher applying credit
  amount REAL NOT NULL,
  allocation_date TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invoice_voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT,
  FOREIGN KEY (payment_voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT,
  FOREIGN KEY (credit_note_voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_ra_invoice ON receivable_allocations(invoice_voucher_id);
CREATE INDEX IF NOT EXISTS idx_ra_payment ON receivable_allocations(payment_voucher_id);
CREATE INDEX IF NOT EXISTS idx_ra_credit_note ON receivable_allocations(credit_note_voucher_id);
CREATE INDEX IF NOT EXISTS idx_ra_company ON receivable_allocations(company_id);

-- AR reconciliation log: track when reconciliation was performed
CREATE TABLE IF NOT EXISTS ar_reconciliation_log (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  as_of_date TEXT NOT NULL,
  customer_level_total REAL NOT NULL,
  control_ledger_total REAL NOT NULL,
  difference REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RECONCILED', 'REQUIRES_ATTENTION')),
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ar_recon_company ON ar_reconciliation_log(company_id);
