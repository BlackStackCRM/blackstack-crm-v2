-- Migration 074: Inventory Hierarchy — Location → Godown → Inventory Group → Item Group
--
-- Implements the spec: Location (site) → Godown (warehouse) → Inventory Group → Item Group
--
-- Existing tables from migrations 070/072:
--   godowns: warehouses (now gets location_id FK to inv_locations)
--   locations: racks within godowns (unchanged — this is a DIFFERENT concept from inv_locations)
--   stock_groups: hierarchical via parent_group_id (now gets godown_id AND location_id for top-level groups)
--   products: basic product info (now gets location_id, godown_id, inventory_group_id, item_group_id)
--   stock_items: linked to products (now gets godown_id for physical placement)

-- ─── inv_locations: Top-level Location (site/facility) ──────────────────────
CREATE TABLE IF NOT EXISTS inv_locations (
  id          TEXT    PRIMARY KEY,
  company_id  TEXT    NOT NULL DEFAULT 'default',
  name        TEXT    NOT NULL,
  code        TEXT,
  address     TEXT,
  is_active   INTEGER DEFAULT 1,
  created_at  DATETIME DEFAULT (datetime('now')),
  updated_at  DATETIME DEFAULT (datetime('now')),
  created_by  TEXT,
  updated_by  TEXT,
  UNIQUE(company_id, name),
  UNIQUE(company_id, code)
);

-- ─── ALTER godowns: add location_id (FK → inv_locations) ─────────────────────
-- godowns become children of locations (sites)
-- NOTE: ALTER TABLE ADD COLUMN with FK works in SQLite but FK is only enforced
-- if PRAGMA foreign_keys = ON. The FK is recorded for schema introspection.
-- This is handled in migrate.js inline code for idempotency.

-- ─── ALTER stock_groups: add godown_id (FK → godowns) AND location_id ────────
-- Top-level stock_groups (Inventory Groups) belong to a godown AND a location
-- Child stock_groups (Item Groups) have parent_group_id pointing to a parent
-- location_id on child groups allows quick filtering without joining to godowns
-- This is handled in migrate.js inline code for idempotency.

-- ─── ALTER products: add hierarchy columns ──────────────────────────────────
-- products.location_id  → inv_locations(id)
-- products.godown_id    → godowns(id)
-- products.inventory_group_id → stock_groups(id)  (top-level group)
-- products.item_group_id → stock_groups(id)        (child group)

-- ─── ALTER stock_items: add godown_id for physical stock placement ──────────
-- stock_items.godown_id → godowns(id)  (where the stock physically resides)

-- ─── Indexes on inv_locations (created at table-creation time) ───────────
CREATE INDEX IF NOT EXISTS idx_inv_locations_company ON inv_locations(company_id);
-- ─── NOTE: Indexes that depend on ALTERed columns (location_id, godown_id, etc.)
--     are created in migrate.js AFTER the ALTER TABLE ADD COLUMN statements,
--     since SQLite migrations run before programmatic schema updates. ─────
