-- Migration 034: Expense Voucher / Expense Transaction support
-- Adds the expense_voucher_lines table for multi-line expense support.
-- The vouchers table already supports EXPENSE type and has columns:
--   expense_voucher_number, payment_ledger_id, expense_payee_id

CREATE TABLE IF NOT EXISTS expense_voucher_lines (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  expense_voucher_id TEXT NOT NULL,
  expense_ledger_id TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL DEFAULT 0.0,
  tax_amount REAL DEFAULT 0.0,
  line_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (expense_voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
  FOREIGN KEY (expense_ledger_id) REFERENCES accounts(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_expense_lines_voucher ON expense_voucher_lines(expense_voucher_id);
CREATE INDEX IF NOT EXISTS idx_expense_lines_ledger ON expense_voucher_lines(expense_ledger_id);
