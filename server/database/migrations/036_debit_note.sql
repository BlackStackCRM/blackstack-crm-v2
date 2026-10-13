-- Migration 036: Debit Note / Purchase Return (Step 14)
-- Adds Debit Note support reusing the existing vouchers table (voucher_type='DEBIT_NOTE')
-- and the existing journal_entries engine (Step 6).
-- No duplicate accounting engine is created.

-- ── Add debit-note-specific columns to vouchers table ──
-- original_purchase_invoice_id links a Debit Note to the original Purchase Invoice (voucher id)
-- debit_note_number stores the business debit note number (e.g. DN-2026-000001)
-- debit_note_type stores the reason type (PURCHASE_RETURN, PRICE_ADJUSTMENT, etc.)
-- debit_note_reason stores free-text reason

-- debit_note_lines: line items for each Debit Note
CREATE TABLE IF NOT EXISTS debit_note_lines (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  debit_note_id TEXT NOT NULL,
  original_purchase_invoice_id TEXT,       -- FK to original Purchase voucher (may be null for standalone)
  original_purchase_line_id TEXT,          -- reference to original purchase line (if line-level tracking)
  product_id TEXT,
  service_id TEXT,
  description TEXT NOT NULL,
  original_quantity REAL DEFAULT 0,
  return_quantity REAL DEFAULT 0,
  rate REAL DEFAULT 0,
  discount REAL DEFAULT 0,
  tax_amount REAL DEFAULT 0,
  line_total REAL DEFAULT 0,
  line_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (debit_note_id) REFERENCES vouchers(id) ON DELETE CASCADE,
  FOREIGN KEY (original_purchase_invoice_id) REFERENCES vouchers(id) ON DELETE SET NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
  FOREIGN KEY (service_id) REFERENCES products(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_debit_note_lines_dn ON debit_note_lines(debit_note_id);
CREATE INDEX IF NOT EXISTS idx_debit_note_lines_invoice ON debit_note_lines(original_purchase_invoice_id);

-- Seed: Purchase Returns / Purchase Credit account
-- Debit Note credits Purchase Returns (a DEBIT-nature contra-expense account) to reduce expense.
-- This is a contra-expense account; it is DEBIT-nature so credits increase it (reducing net expense).
INSERT OR IGNORE INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, opening_balance, opening_balance_type, description, is_active, is_system, allow_direct_posting, created_at, updated_at)
VALUES ('acc_purchase_returns', 'default', '5501', 'Purchase Returns', 'ag_purchases', 'EXPENSE', 'DEBIT', 0.0, 'DEBIT', 'Contra-expense account for purchase returns and debit notes', 1, 1, 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');
