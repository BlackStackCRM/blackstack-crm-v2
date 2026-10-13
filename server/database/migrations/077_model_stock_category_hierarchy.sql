-- Migration 077: Model → Stock Category foreign key
--
-- Establishes the full hierarchy:
--   Stock Group → Stock Category → Model
--
-- Adds `stock_category_id` column to the `models` table, with a FK
-- constraint to `stock_categories(id) ON DELETE SET NULL`.
--
-- SQLite ADD COLUMN does not support inline FK constraints, so we use
-- the table-rebuild pattern (backup → drop → recreate with FK → restore).
-- Pre-existing models get stock_category_id = NULL (nullable, so no data loss).
--
-- Runs once (tracked by schema_migrations table with SHA256).

PRAGMA foreign_keys = OFF;

-- Backup existing data (preserve all columns from migration 070 schema)
CREATE TEMP TABLE _models_backup AS
  SELECT id, company_id, name, brand_id, description, is_active,
         created_at, updated_at, created_by, updated_by
  FROM models;

-- Drop and recreate the models table WITH the new FK column
DROP TABLE IF EXISTS models;
CREATE TABLE models (
  id                TEXT    PRIMARY KEY,
  company_id        TEXT    NOT NULL DEFAULT 'default',
  name              TEXT    NOT NULL,
  brand_id          TEXT,
  stock_category_id TEXT,
  description       TEXT,
  is_active         INTEGER DEFAULT 1,
  created_at        DATETIME DEFAULT (datetime('now')),
  updated_at        DATETIME DEFAULT (datetime('now')),
  created_by        TEXT,
  updated_by        TEXT,
  FOREIGN KEY (brand_id)          REFERENCES brands(id)          ON DELETE SET NULL,
  FOREIGN KEY (stock_category_id) REFERENCES stock_categories(id) ON DELETE SET NULL,
  UNIQUE(company_id, name)
);

-- Restore existing data (stock_category_id is NULL for pre-existing models)
INSERT INTO models (id, company_id, name, brand_id, stock_category_id, description,
                    is_active, created_at, updated_at, created_by, updated_by)
SELECT id, company_id, name, brand_id, NULL, description,
       is_active, created_at, updated_at, created_by, updated_by
FROM _models_backup;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_models_category ON models(stock_category_id);
CREATE INDEX IF NOT EXISTS idx_models_brand    ON models(brand_id);

-- Cleanup
DROP TABLE IF EXISTS _models_backup;

PRAGMA foreign_keys = ON;
