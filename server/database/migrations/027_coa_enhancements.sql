-- Migration 027: Chart of Accounts Enhancements
-- Adds fields needed for professional COA management:
--   - parent_id (hierarchical account structure)
--   - allow_direct_posting (header accounts can't be posted to)
--   - reconciliation_required (bank accounts, etc.)
--   - opening_balance_date
--   - is_group flag (distinguishes group accounts from leaf accounts)

-- Add parent_id for hierarchical account structure
ALTER TABLE accounts ADD COLUMN parent_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;

-- Allow direct posting flag (false = group/header account, can't post directly)
ALTER TABLE accounts ADD COLUMN allow_direct_posting INTEGER DEFAULT 1;

-- Reconciliation required flag (for bank accounts, etc.)
ALTER TABLE accounts ADD COLUMN reconciliation_required INTEGER DEFAULT 0;

-- Opening balance date
ALTER TABLE accounts ADD COLUMN opening_balance_date TEXT;

-- is_group flag (true = group/header account, not a leaf)
ALTER TABLE accounts ADD COLUMN is_group INTEGER DEFAULT 0;

-- Indexes for hierarchy queries
CREATE INDEX IF NOT EXISTS idx_accounts_parent ON accounts(parent_id);
CREATE INDEX IF NOT EXISTS idx_accounts_code_company ON accounts(company_id, code);
