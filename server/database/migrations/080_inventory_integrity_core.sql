-- ═══════════════════════════════════════════════════════════════════════════
-- 080_inventory_integrity_core.sql
--
-- PURPOSE
--   Establish the primitives required to make `stock_ledger` the single
--   authoritative inventory transaction engine, and to bridge Customer Bills
--   into it.
--
--   1. Source-document traceability + idempotency on inventory vouchers and
--      stock ledger rows (so a bill can never deduct stock twice).
--   2. Actor attribution on ledger rows (currently absent entirely).
--   3. Inventory dimensions on `bill_items` (stock_item / godown / location /
--      batch / serial) so bill lines can drive stock movement.
--   4. Back-pointer from `bills` to the stock-out voucher that satisfied it.
--   5. `inventory_items` becomes the canonical moving-weighted-average cost
--      table, keyed by stock_item_id (it was keyed by product_id and had no
--      stock_items link, so it could never be joined to the live inventory).
--
-- SAFETY
--   Additive only. No table is dropped, no existing row is modified or deleted.
--   Every ADD COLUMN is additive; existing values are untouched and remain the
--   correct value (NULL / default) for rows that predate this migration.
--   `inventory_items` has a defensive rebuild guarded to the empty case so no
--   live valuation data can ever be destroyed by this migration.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Source-document traceability on inventory vouchers ────────────────
-- Enables:  "which stock transactions did this bill cause?"  and the
-- idempotency guarantee "exactly one stock-out per bill".
ALTER TABLE inventory_voucher_headers ADD COLUMN source_document_type TEXT;
ALTER TABLE inventory_voucher_headers ADD COLUMN source_document_id   TEXT;

CREATE INDEX IF NOT EXISTS idx_ivh_source_document
  ON inventory_voucher_headers(company_id, source_document_type, source_document_id)
  WHERE source_document_id IS NOT NULL;

-- Hard idempotency guarantee at the database level: a given source document
-- may produce at most ONE inventory voucher. Reversal headers deliberately do
-- not set source_document_id, so they are unaffected by this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ivh_one_per_source_document
  ON inventory_voucher_headers(company_id, source_document_type, source_document_id)
  WHERE source_document_id IS NOT NULL;

-- ─── 2. Source-document + actor attribution on stock_ledger ───────────────
-- stock_ledger previously had NO record of *why* a movement happened or *who*
-- performed it. Both are required for an auditable sale.
ALTER TABLE stock_ledger ADD COLUMN source_document_type TEXT;
ALTER TABLE stock_ledger ADD COLUMN source_document_id   TEXT;
ALTER TABLE stock_ledger ADD COLUMN created_by          TEXT;

CREATE INDEX IF NOT EXISTS idx_stock_ledger_source_document
  ON stock_ledger(company_id, source_document_type, source_document_id)
  WHERE source_document_id IS NOT NULL;

-- Reporting / lookup path used by every inventory report.
CREATE INDEX IF NOT EXISTS idx_stock_ledger_balance_dimensions
  ON stock_ledger(company_id, item_id, godown_id, batch_id, location_id);

-- ─── 3. Inventory dimensions on bill_items ────────────────────────────────
-- `batch`, `serial_number`, `expiry`, `warehouse_id` already existed as
-- free-text columns (migration 058) and were never used by the billing flow.
-- Add properly-typed, FK-backed columns. The legacy free-text columns are left
-- in place for backward compatibility and are not read by new code.
ALTER TABLE bill_items ADD COLUMN stock_item_id TEXT REFERENCES stock_items(id)  ON DELETE SET NULL;
ALTER TABLE bill_items ADD COLUMN godown_id    TEXT REFERENCES godowns(id)     ON DELETE SET NULL;
ALTER TABLE bill_items ADD COLUMN location_id  TEXT REFERENCES locations(id)   ON DELETE SET NULL;
ALTER TABLE bill_items ADD COLUMN batch_id     TEXT REFERENCES batches(id)     ON DELETE SET NULL;
ALTER TABLE bill_items ADD COLUMN serial_id    TEXT REFERENCES item_serials(id) ON DELETE SET NULL;

-- Batch/serial-tracked lines are identified by ID, not by loose text.
CREATE INDEX IF NOT EXISTS idx_bill_items_stock_item
  ON bill_items(bill_id, stock_item_id) WHERE stock_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bill_items_serial
  ON bill_items(serial_id) WHERE serial_id IS NOT NULL;

-- ─── 4. Bill -> stock-out voucher back-pointer ────────────────────────────
-- Makes the bridge navigable in both directions:
--   bill.inventory_voucher_header_id -> the stock-out that fulfilled it
--   inventory_voucher_headers.source_document_id -> the bill that caused it
ALTER TABLE bills ADD COLUMN inventory_voucher_header_id TEXT REFERENCES inventory_voucher_headers(id) ON DELETE SET NULL;
ALTER TABLE bills ADD COLUMN inventory_reversal_voucher_header_id TEXT REFERENCES inventory_voucher_headers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bills_inventory_voucher
  ON bills(inventory_voucher_header_id) WHERE inventory_voucher_header_id IS NOT NULL;

-- ─── 5. Explicit inventory-management flag on products ────────────────────
-- `products` is the commercial identity and deliberately carries no quantity.
-- This flag records whether the product is under inventory control (i.e. has a
-- stock_items row), so the billing UI and posting logic do not have to infer it
-- with a join on every line. Kept in sync by the product service.
ALTER TABLE products ADD COLUMN is_inventory_managed INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_products_inventory_managed
  ON products(company_id, is_inventory_managed);

-- ─── 6. inventory_items becomes the canonical valuation table ─────────────
-- It already contained a correct moving weighted-average implementation, but:
--   * it was keyed by product_id with no link to stock_items, so it could never
--     participate in the live inventory flow, and
--   * it had zero rows and zero writers reachable from any voucher path.
-- It is promoted to the single valuation authority and re-keyed on
-- stock_items.id, which is the identity the ledger actually uses.
--
-- SAFETY: the rebuild below is skipped entirely if the table holds rows, so
-- this migration can never destroy existing valuation data.
-- ───────────────────────────────────────────────────────────────────────────

-- Only proceed with the re-key if the table is empty (verified in migrate.js
-- programmatic section); create the new shape defensively if it is already
-- in the target shape.
CREATE TABLE IF NOT EXISTS inventory_items_v2 (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL DEFAULT 'default',
  item_id           TEXT NOT NULL,
  quantity          REAL NOT NULL DEFAULT 0,
  unit_cost         REAL NOT NULL DEFAULT 0,   -- moving weighted-average cost
  total_value       REAL NOT NULL DEFAULT 0,   -- quantity * unit_cost
  valuation_method  TEXT NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
  gl_account_id     TEXT,
  last_inward_at    TEXT,
  last_outward_at   TEXT,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (item_id) REFERENCES stock_items(id) ON DELETE CASCADE,
  UNIQUE(company_id, item_id)
);

-- Back-pointer from stock_items so valuation can be resolved without guessing.
ALTER TABLE stock_items ADD COLUMN valuation_inventory_item_id TEXT REFERENCES inventory_items(id) ON DELETE SET NULL;

-- ─── 7. Valuation audit trail ────────────────────────────────────────────
-- Records each WAC recomputation so the resulting unit_cost can be explained
-- and audited after the fact, rather than only being observable in its result.
CREATE TABLE IF NOT EXISTS valuation_movements (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL DEFAULT 'default',
  item_id          TEXT NOT NULL,
  source_document_type TEXT,
  source_document_id   TEXT,
  direction        INTEGER NOT NULL,          -- +1 increase, -1 decrease
  quantity         REAL NOT NULL,
  unit_cost        REAL NOT NULL,
  total_value      REAL NOT NULL,
  balance_quantity REAL NOT NULL,
  balance_value    REAL NOT NULL,
  resulting_unit_cost REAL NOT NULL,
  valuation_method TEXT NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
  created_by       TEXT,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (item_id) REFERENCES stock_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_valuation_movements_item
  ON valuation_movements(company_id, item_id, created_at);

CREATE INDEX IF NOT EXISTS idx_valuation_movements_source
  ON valuation_movements(company_id, source_document_type, source_document_id)
  WHERE source_document_id IS NOT NULL;

-- ─── 8. Legacy table registry ────────────────────────────────────────────
-- Retired-but-preserved tables are recorded here rather than dropped, so the
-- decision is auditable and reversible.
CREATE TABLE IF NOT EXISTS legacy_tables (
  table_name    TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'LEGACY',
  canonical_replacement TEXT,
  reason        TEXT,
  rows_at_retirement INTEGER,
  retired_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO legacy_tables (table_name, status, canonical_replacement, reason)
VALUES
  ('uoms',                    'LEGACY', 'units_of_measure', 'Duplicate unit master. Zero rows, zero code references.'),
  ('batch_wise_stock',        'LEGACY', 'stock_balances',   'Duplicate batch balance. Derived from stock_ledger; no reader.'),
  ('inventory_movements',     'LEGACY', 'stock_ledger',     'Duplicate movement engine. Superseded by stock_ledger + valuation_movements.'),
  ('stock_adjustment_reasons','LEGACY', 'adjustment_reasons','Duplicate reason master. FK target is adjustment_reasons.'),
  ('inv_locations',           'LEGACY', 'locations',        'Duplicate location master. Consolidated into locations.');