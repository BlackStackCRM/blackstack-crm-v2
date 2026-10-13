-- Migration 029: Add is_system column to accounts table
-- Marks protected/system ledger accounts that cannot be deleted or have
-- their critical fields (type, group, nature, code) changed.
-- Uses a guard to be idempotent on SQLite (which lacks ADD COLUMN IF NOT EXISTS
-- in some versions, but the migration runner will skip already-applied versions).

-- SQLite >= 3.35 supports ADD COLUMN IF NOT EXISTS
ALTER TABLE accounts ADD COLUMN is_system INTEGER DEFAULT 0 NOT NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_system ON accounts(is_system) WHERE is_system = 1;
