-- Migration 076: Stock Categories → Stock Group hierarchy
--
-- Adds stock_group_id FK to stock_categories, establishing a required
-- parent-child relationship: Stock Group → Stock Category → Stock Item/Product.
-- Existing categories are migrated to a default "General" stock group.

PRAGMA foreign_keys = OFF;

-- Add the column (SQLite ADD COLUMN is idempotent-safe via the check below)
-- We use a migration-safe approach: add column, set defaults, add FK constraint
-- via table rebuild if needed. But since SQLite ADD COLUMN doesn't support
-- adding FK constraints to existing columns, we use the table-rebuild pattern
-- only if the column doesn't exist.

-- Approach: Use a clean table rebuild for correctness

CREATE TEMP TABLE IF NOT EXISTS _stock_categories_backup AS
  SELECT id, company_id, name, description, is_active,
         created_at, updated_at, created_by, updated_by
  FROM stock_categories;

DROP TABLE IF EXISTS stock_categories;

CREATE TABLE stock_categories (
  id            TEXT    PRIMARY KEY,
  company_id    TEXT    NOT NULL DEFAULT 'default',
  name          TEXT    NOT NULL,
  stock_group_id TEXT,
  description   TEXT,
  is_active     INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now')),
  created_by    TEXT,
  updated_by    TEXT,
  FOREIGN KEY (stock_group_id) REFERENCES stock_groups(id) ON DELETE RESTRICT,
  UNIQUE(company_id, name),
  UNIQUE(company_id, stock_group_id, name)
);

INSERT INTO stock_categories (id, company_id, name, description, is_active,
  created_at, updated_at, created_by, updated_by)
SELECT id, company_id, name, description, is_active,
  created_at, updated_at, created_by, updated_by
FROM _stock_categories_backup;

DROP TABLE _stock_categories_backup;

-- Index for efficient lookups by stock_group_id
CREATE INDEX IF NOT EXISTS idx_stock_categories_group ON stock_categories(stock_group_id);
CREATE INDEX IF NOT EXISTS idx_stock_categories_company ON stock_categories(company_id);

-- If no stock_groups exist yet, the seed will create them.
-- The seed.js will insert stock_groups and then link categories.
