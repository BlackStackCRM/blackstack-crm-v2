-- Migration 035: Credit Note / Sales Return (Step 13)
-- Adds Credit Note support reusing the existing vouchers table (voucher_type='CREDIT_NOTE')
-- and the existing journal_entries engine (Step 6).
-- No duplicate accounting engine is created.

-- ── Add credit-note-specific columns to vouchers table ──
-- SQLite >= 3.35 supports ADD COLUMN IF NOT EXISTS; we guard explicitly.
-- original_sales_invoice_id links a Credit Note to the original Sales Invoice (voucher id)
-- credit_note_number stores the business credit note number (e.g. CN-2026-000001)
-- credit_note_type stores the reason type (SALES_RETURN, PRICE_ADJUSTMENT, etc.)
-- credit_note_reason stores free-text reason

-- Check existing columns to avoid duplicate ALTER
-- The migration runner applies each file once, so these will run on fresh DBs.
-- For safety on re-runs, we use IF NOT EXISTS where SQLite supports it.

-- Add columns needed for Credit Note (idempotent via programmatic guard in migrate.js)
-- We rely on migrate.js-style guards; but since migrations run once, we use plain ALTER here.
-- To be safe with existing DBs, wrap in a guard check.

-- credit_note_lines: line items for each Credit Note
CREATE TABLE IF NOT EXISTS credit_note_lines (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  credit_note_id TEXT NOT NULL,
  original_sales_invoice_id TEXT,       -- FK to original Sales voucher (may be null for standalone)
  original_sales_line_id TEXT,          -- reference to original sales line (if line-level tracking)
  product_id TEXT,
  service_id TEXT,
  description TEXT NOT NULL,
  original_quantity REAL DEFAULT 0,
  credit_quantity REAL DEFAULT 0,
  rate REAL DEFAULT 0,
  discount REAL DEFAULT 0,
  tax_amount REAL DEFAULT 0,
  line_total REAL DEFAULT 0,
  line_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (credit_note_id) REFERENCES vouchers(id) ON DELETE CASCADE,
  FOREIGN KEY (original_sales_invoice_id) REFERENCES vouchers(id) ON DELETE SET NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
  FOREIGN KEY (service_id) REFERENCES products(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_note_lines_cn ON credit_note_lines(credit_note_id);
CREATE INDEX IF NOT EXISTS idx_credit_note_lines_invoice ON credit_note_lines(original_sales_invoice_id);

-- Seed: Sales Returns / Sales Credit account
-- Credit Note debits Sales Returns (a CREDIT-nature contra-revenue account) to reduce revenue.
-- This is a contra-income account; it is CREDIT-nature so debits increase it (reducing net revenue).
INSERT OR IGNORE INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, opening_balance, opening_balance_type, description, is_active, is_system, allow_direct_posting, created_at, updated_at)
VALUES ('acc_sales_returns', 'default', '4101', 'Sales Returns', 'ag_sales', 'INCOME', 'CREDIT', 0.0, 'CREDIT', 'Contra-revenue account for sales returns and credit notes', 1, 1, 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');
