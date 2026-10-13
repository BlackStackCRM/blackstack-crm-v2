-- Migration 028: Account Group CRUD Support
-- Adds allow_child_accounts to account_groups for explicit control,
-- plus indexes that the self-referencing hierarchy queries need.

ALTER TABLE account_groups ADD COLUMN allow_child_accounts INTEGER DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_account_groups_parent ON account_groups(parent_id);
CREATE INDEX IF NOT EXISTS idx_account_groups_company_code ON account_groups(company_id, code);
CREATE INDEX IF NOT EXISTS idx_account_groups_type ON account_groups(type);
