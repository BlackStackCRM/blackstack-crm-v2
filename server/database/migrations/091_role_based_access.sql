-- Migration 091: role-based access — local side (SQLite).
-- ADDITIVE ONLY. Columns added programmatically at first deployment
-- (ALTER TABLE ... ADD COLUMN is not idempotent in SQLite and would abort
-- the boot safe-runner on re-run; the columns are applied once via the
-- guarded adapter helper, then the migration record is written).
--   users.hierarchy_role   — 'agency' | 'sub_agency' | 'customer_tenant'
--                            (NULL = legacy account, untouched behavior)
--   users.parent_user_id   — who created this account (chain of custody)
--   users.must_change_password — forces the password-change screen (1/0)
-- Local-first: these columns are the operational authority; the Supabase
-- profiles table (migration 090) mirrors them.

CREATE INDEX IF NOT EXISTS idx_users_hierarchy_role ON users(hierarchy_role);
CREATE INDEX IF NOT EXISTS idx_users_parent ON users(parent_user_id);
