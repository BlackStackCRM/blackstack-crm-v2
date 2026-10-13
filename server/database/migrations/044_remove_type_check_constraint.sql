-- Migration: Allow custom account types in accounts table
-- Issue: The accounts.type column has a CHECK constraint that only allows 7 built-in types.
-- Custom account types from the account_types table cannot be used.
-- This migration recreates the accounts table without the restrictive type CHECK constraint.
PRAGMA defer_foreign_keys = TRUE;

-- Step 1: Create the new accounts table WITHOUT the type CHECK constraint
CREATE TABLE accounts_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_group_id TEXT NOT NULL,
  type TEXT NOT NULL,
  debit_credit_nature TEXT NOT NULL CHECK (debit_credit_nature IN ('DEBIT', 'CREDIT')),
  opening_balance REAL DEFAULT 0.0,
  opening_balance_type TEXT DEFAULT 'DEBIT',
  description TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  parent_id TEXT,
  allow_direct_posting INTEGER DEFAULT 1,
  reconciliation_required INTEGER DEFAULT 0,
  opening_balance_date TEXT,
  is_group INTEGER DEFAULT 0,
  is_system INTEGER DEFAULT 0 NOT NULL,
  FOREIGN KEY (account_group_id) REFERENCES account_groups(id) ON DELETE RESTRICT,
  UNIQUE(company_id, code)
);

-- Step 2: Copy data from old table to new table
INSERT INTO accounts_new
  (id, company_id, code, name, account_group_id, type, debit_credit_nature,
   opening_balance, opening_balance_type, description, is_active, created_at, updated_at,
   parent_id, allow_direct_posting, reconciliation_required, opening_balance_date,
   is_group, is_system)
SELECT
  id, company_id, code, name, account_group_id, type, debit_credit_nature,
  opening_balance, opening_balance_type, description, is_active, created_at, updated_at,
  parent_id, allow_direct_posting, reconciliation_required, opening_balance_date,
  is_group, is_system
FROM accounts;

-- Step 3: Drop the old accounts table and rename the new one
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

-- Step 4: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_accounts_type ON accounts(type);
CREATE INDEX IF NOT EXISTS idx_accounts_group ON accounts(account_group_id);
CREATE INDEX IF NOT EXISTS idx_accounts_parent ON accounts(parent_id);

PRAGMA defer_foreign_keys = FALSE;
