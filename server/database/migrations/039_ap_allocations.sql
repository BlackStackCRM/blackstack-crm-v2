-- Migration 039: Accounts Payable — allocation tracking & supplier-level outstanding
-- Adds payable-level allocation between Purchase Invoices and Payment Vouchers
-- Supplier payable is derived from the Journal Entry engine (source of truth)

-- Payable allocations: track which payment amounts apply to which purchase invoice
CREATE TABLE IF NOT EXISTS payable_allocations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  supplier_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,             -- The PAYMENT voucher
  purchase_invoice_id TEXT NOT NULL,    -- The PURCHASE voucher being settled
  allocated_amount REAL NOT NULL,
  allocation_date TEXT NOT NULL,
  financial_year_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVERSED')),
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (payment_id) REFERENCES vouchers(id) ON DELETE RESTRICT,
  FOREIGN KEY (purchase_invoice_id) REFERENCES vouchers(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_pa_payment ON payable_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_pa_invoice ON payable_allocations(purchase_invoice_id);
CREATE INDEX IF NOT EXISTS idx_pa_supplier ON payable_allocations(supplier_id);
CREATE INDEX IF NOT EXISTS idx_pa_company ON payable_allocations(company_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pa_unique ON payable_allocations(payment_id, purchase_invoice_id, status) WHERE status = 'ACTIVE';

-- AP reconciliation log: track when reconciliation was performed
CREATE TABLE IF NOT EXISTS ap_reconciliation_log (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  as_of_date TEXT NOT NULL,
  supplier_level_total REAL NOT NULL,
  control_ledger_total REAL NOT NULL,
  difference REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RECONCILED', 'REQUIRES_ATTENTION')),
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ap_recon_company ON ap_reconciliation_log(company_id);
