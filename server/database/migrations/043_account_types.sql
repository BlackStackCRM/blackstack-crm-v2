-- Migration 043: Account Type Management
-- Adds a table for custom account types that can be created from the UI.
-- Built-in types (ASSET, LIABILITY, EQUITY, INCOME, EXPENSE, BANK, CASH) are always available.
-- Custom types are stored here and can be used when creating/editing ledger accounts.

CREATE TABLE IF NOT EXISTS account_types (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  debit_credit_nature TEXT NOT NULL CHECK (debit_credit_nature IN ('DEBIT', 'CREDIT')),
  is_active INTEGER DEFAULT 1,
  is_builtin INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_account_types_company ON account_types(company_id);
CREATE INDEX IF NOT EXISTS idx_account_types_active ON account_types(is_active) WHERE is_active = 1;
