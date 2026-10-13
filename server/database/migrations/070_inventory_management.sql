-- Migration 070: Full Inventory Management System
-- Extends existing inventory_items / inventory_movements (from migration 041)
-- with: full master data, voucher header/line model, immutable stock ledger,
--       rebuildable stock balances, serial tracking, batch attributes,
--       physical stock workflow, adjustment reasons, and atomic voucher numbering.
--
-- Architecture:
--   Inventory Master Data -> Inventory Voucher Header -> Voucher Lines ->
--     Stock Ledger (immutable source of truth) -> Stock Balances (rebuildable) ->
--       Valuation -> Accounting Journal
--
-- All tables are company_id (tenant) scoped, consistent with the existing
-- accounting module convention. Primary keys are TEXT (ULID-style via generateId).

-- Units of Measure (canonical UOM master)
CREATE TABLE IF NOT EXISTS units_of_measure (
  id            TEXT    PRIMARY KEY,
  company_id    TEXT    NOT NULL DEFAULT 'default',
  name          TEXT    NOT NULL,
  symbol        TEXT    NOT NULL,
  decimal_places INTEGER DEFAULT 0,
  description   TEXT,
  is_active     INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now')),
  created_by    TEXT,
  updated_by    TEXT,
  UNIQUE(company_id, name),
  UNIQUE(company_id, symbol)
);

-- Compound Units (e.g., 1 Box = 12 pcs)
CREATE TABLE IF NOT EXISTS compound_units (
  id            TEXT    PRIMARY KEY,
  company_id    TEXT    NOT NULL DEFAULT 'default',
  name          TEXT    NOT NULL,
  base_unit_id  TEXT    NOT NULL,
  quantity      REAL    NOT NULL CHECK(quantity > 0),
  is_active     INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now')),
  created_by    TEXT,
  updated_by    TEXT,
  FOREIGN KEY (base_unit_id) REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  UNIQUE(company_id, name)
);

-- Alternate Units (e.g., 1 Distributor Case = 24 pcs)
CREATE TABLE IF NOT EXISTS alternate_units (
  id                TEXT    PRIMARY KEY,
  company_id        TEXT    NOT NULL DEFAULT 'default',
  name              TEXT    NOT NULL,
  base_unit_id      TEXT    NOT NULL,
  conversion_factor REAL    NOT NULL CHECK(conversion_factor > 0),
  rate              REAL DEFAULT 0,
  is_active         INTEGER DEFAULT 1,
  created_at        DATETIME DEFAULT (datetime('now')),
  updated_at        DATETIME DEFAULT (datetime('now')),
  created_by        TEXT,
  updated_by        TEXT,
  FOREIGN KEY (base_unit_id) REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  UNIQUE(company_id, name)
);

-- Stock Groups (hierarchical)
CREATE TABLE IF NOT EXISTS stock_groups (
  id              TEXT    PRIMARY KEY,
  company_id      TEXT    NOT NULL DEFAULT 'default',
  name            TEXT    NOT NULL,
  parent_group_id TEXT,
  description     TEXT,
  is_active       INTEGER DEFAULT 1,
  created_at      DATETIME DEFAULT (datetime('now')),
  updated_at      DATETIME DEFAULT (datetime('now')),
  created_by      TEXT,
  updated_by      TEXT,
  FOREIGN KEY (parent_group_id) REFERENCES stock_groups(id) ON DELETE SET NULL,
  UNIQUE(company_id, name)
);

-- Stock Categories
CREATE TABLE IF NOT EXISTS stock_categories (
  id            TEXT    PRIMARY KEY,
  company_id    TEXT    NOT NULL DEFAULT 'default',
  name          TEXT    NOT NULL,
  description   TEXT,
  is_active     INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now')),
  created_by    TEXT,
  updated_by    TEXT,
  UNIQUE(company_id, name)
);

-- Brands
CREATE TABLE IF NOT EXISTS brands (
  id            TEXT    PRIMARY KEY,
  company_id    TEXT    NOT NULL DEFAULT 'default',
  name          TEXT    NOT NULL,
  description   TEXT,
  is_active     INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now')),
  created_by    TEXT,
  updated_by    TEXT,
  UNIQUE(company_id, name)
);

-- Models (optionally belong to a Brand)
CREATE TABLE IF NOT EXISTS models (
  id            TEXT    PRIMARY KEY,
  company_id    TEXT    NOT NULL DEFAULT 'default',
  name          TEXT    NOT NULL,
  brand_id      TEXT,
  description   TEXT,
  is_active     INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now')),
  created_by    TEXT,
  updated_by    TEXT,
  FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL,
  UNIQUE(company_id, name)
);

-- Colours
CREATE TABLE IF NOT EXISTS colours (
  id            TEXT    PRIMARY KEY,
  company_id    TEXT    NOT NULL DEFAULT 'default',
  name          TEXT    NOT NULL,
  hex_code      TEXT,
  is_active     INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now')),
  created_by    TEXT,
  updated_by    TEXT,
  UNIQUE(company_id, name)
);

-- Sizes
CREATE TABLE IF NOT EXISTS sizes (
  id            TEXT    PRIMARY KEY,
  company_id    TEXT    NOT NULL DEFAULT 'default',
  name          TEXT    NOT NULL,
  is_active     INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now')),
  created_by    TEXT,
  updated_by    TEXT,
  UNIQUE(company_id, name)
);

-- Styles
CREATE TABLE IF NOT EXISTS styles (
  id            TEXT    PRIMARY KEY,
  company_id    TEXT    NOT NULL DEFAULT 'default',
  name          TEXT    NOT NULL,
  is_active     INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now')),
  created_by    TEXT,
  updated_by    TEXT,
  UNIQUE(company_id, name)
);

-- Godowns (warehouses)
CREATE TABLE IF NOT EXISTS godowns (
  id            TEXT    PRIMARY KEY,
  company_id    TEXT    NOT NULL DEFAULT 'default',
  name          TEXT    NOT NULL,
  code          TEXT,
  address       TEXT,
  is_active     INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now')),
  created_by    TEXT,
  updated_by    TEXT,
  UNIQUE(company_id, name),
  UNIQUE(company_id, code)
);

-- Locations (rack/shelf within a godown)
CREATE TABLE IF NOT EXISTS locations (
  id            TEXT    PRIMARY KEY,
  company_id    TEXT    NOT NULL DEFAULT 'default',
  godown_id     TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  code          TEXT,
  is_active     INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now')),
  created_by    TEXT,
  updated_by    TEXT,
  FOREIGN KEY (godown_id) REFERENCES godowns(id) ON DELETE CASCADE,
  UNIQUE(company_id, godown_id, name)
);

-- Stock Items (core inventory master, linked to existing products table)
CREATE TABLE IF NOT EXISTS stock_items (
  id                         TEXT    PRIMARY KEY,
  company_id                 TEXT    NOT NULL DEFAULT 'default',
  name                       TEXT    NOT NULL,
  sku                        TEXT    NOT NULL,
  product_id                 TEXT,
  description                TEXT,
  brand_id                   TEXT,
  model_id                   TEXT,
  colour_id                  TEXT,
  size_id                    TEXT,
  style_id                   TEXT,
  category_id                TEXT,
  group_id                   TEXT,
  uom_id                     TEXT    NOT NULL,
  is_batch_tracked           INTEGER DEFAULT 0,
  is_serial_tracked          INTEGER DEFAULT 0,
  is_active                  INTEGER DEFAULT 1,
  cost_price                 REAL DEFAULT 0,
  mrp                        REAL,
  selling_rate               REAL,
  min_stock_level            REAL DEFAULT 0,
  max_stock_level            REAL,
  stock_asset_account_id     TEXT,
  cogs_account_id            TEXT,
  inventory_variance_account_id TEXT,
  opening_stock_account_id   TEXT,
  purchase_account_id        TEXT,
  sales_account_id           TEXT,
  created_at                 DATETIME DEFAULT (datetime('now')),
  updated_at                 DATETIME DEFAULT (datetime('now')),
  created_by                 TEXT,
  updated_by                 TEXT,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
  FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL,
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL,
  FOREIGN KEY (colour_id) REFERENCES colours(id) ON DELETE SET NULL,
  FOREIGN KEY (size_id) REFERENCES sizes(id) ON DELETE SET NULL,
  FOREIGN KEY (style_id) REFERENCES styles(id) ON DELETE SET NULL,
  FOREIGN KEY (category_id) REFERENCES stock_categories(id) ON DELETE SET NULL,
  FOREIGN KEY (group_id) REFERENCES stock_groups(id) ON DELETE SET NULL,
  FOREIGN KEY (uom_id) REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  FOREIGN KEY (stock_asset_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (cogs_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (inventory_variance_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (opening_stock_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (purchase_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (sales_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
  UNIQUE(company_id, sku),
  UNIQUE(company_id, name)
);

-- Batches (extended with purchase_rate, mrp, selling_rate, supplier_ref)
CREATE TABLE IF NOT EXISTS batches (
  id               TEXT    PRIMARY KEY,
  company_id       TEXT    NOT NULL DEFAULT 'default',
  item_id          TEXT    NOT NULL,
  batch_number     TEXT    NOT NULL,
  manufacturing_date TEXT,
  expiry_date      TEXT,
  purchase_rate    REAL DEFAULT 0,
  mrp              REAL,
  selling_rate     REAL,
  supplier_ref     TEXT,
  is_active        INTEGER DEFAULT 1,
  created_at       DATETIME DEFAULT (datetime('now')),
  updated_at       DATETIME DEFAULT (datetime('now')),
  created_by       TEXT,
  updated_by       TEXT,
  FOREIGN KEY (item_id) REFERENCES stock_items(id) ON DELETE CASCADE,
  UNIQUE(company_id, item_id, batch_number)
);

-- Price Levels
CREATE TABLE IF NOT EXISTS price_levels (
  id             TEXT    PRIMARY KEY,
  company_id     TEXT    NOT NULL DEFAULT 'default',
  name           TEXT    NOT NULL,
  level_type     TEXT    NOT NULL CHECK(level_type IN ('percentage', 'absolute')),
  markup_value   REAL    DEFAULT 0,
  is_active      INTEGER DEFAULT 1,
  created_at     DATETIME DEFAULT (datetime('now')),
  updated_at     DATETIME DEFAULT (datetime('now')),
  created_by     TEXT,
  updated_by     TEXT,
  UNIQUE(company_id, name)
);

-- Item Prices (junction: stock_items x price_levels)
CREATE TABLE IF NOT EXISTS item_prices (
  id             TEXT    PRIMARY KEY,
  company_id     TEXT    NOT NULL DEFAULT 'default',
  item_id        TEXT    NOT NULL,
  price_level_id TEXT    NOT NULL,
  price          REAL    NOT NULL CHECK(price >= 0),
  created_at     DATETIME DEFAULT (datetime('now')),
  updated_at     DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (item_id) REFERENCES stock_items(id) ON DELETE CASCADE,
  FOREIGN KEY (price_level_id) REFERENCES price_levels(id) ON DELETE CASCADE,
  UNIQUE(company_id, item_id, price_level_id)
);

-- Item Serials (serial number lifecycle tracking)
CREATE TABLE IF NOT EXISTS item_serials (
  id            TEXT    PRIMARY KEY,
  company_id    TEXT    NOT NULL DEFAULT 'default',
  item_id       TEXT    NOT NULL,
  batch_id      TEXT,
  serial_number TEXT    NOT NULL,
  godown_id     TEXT,
  location_id   TEXT,
  status        TEXT    NOT NULL DEFAULT 'available' CHECK(status IN ('in_transit','available','sold','returned','damaged','scrapped','expired')),
  purchase_date TEXT,
  purchase_rate REAL DEFAULT 0,
  mfg_date      TEXT,
  expiry_date   TEXT,
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (item_id) REFERENCES stock_items(id) ON DELETE CASCADE,
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE SET NULL,
  FOREIGN KEY (godown_id) REFERENCES godowns(id) ON DELETE SET NULL,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL,
  UNIQUE(company_id, serial_number),
  UNIQUE(company_id, item_id, serial_number)
);

-- Stock Adjustment Reasons (master)
CREATE TABLE IF NOT EXISTS stock_adjustment_reasons (
  id            TEXT    PRIMARY KEY,
  company_id    TEXT    NOT NULL DEFAULT 'default',
  code          TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  description   TEXT,
  is_active     INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now')),
  UNIQUE(company_id, code),
  UNIQUE(company_id, name)
);

-- Seed default adjustment reasons
INSERT OR IGNORE INTO stock_adjustment_reasons (id, company_id, code, name, description) VALUES
  ('adj_dmg_001', 'default', 'DAMAGE',   'Damage',       'Items damaged beyond usable condition'),
  ('adj_exp_001', 'default', 'EXPIRY',   'Expiry',       'Items past their expiry date'),
  ('adj_shr_001', 'default', 'SHORTAGE', 'Shortage',     'Discrepancy found during physical count'),
  ('adj_exc_001', 'default', 'EXCESS',   'Excess',       'More items found than system quantity'),
  ('adj_cor_001', 'default', 'CORRECTION','Correction',  'General quantity correction'),
  ('adj_thf_001', 'default', 'THEFT',    'Theft',        'Items lost due to theft'),
  ('adj_opn_001', 'default', 'OPENING_ADJ', 'Opening Adjustment', 'Initial opening stock adjustment');

-- Physical Stock Documents (draft → verified → approved workflow)
CREATE TABLE IF NOT EXISTS physical_stock_documents (
  id              TEXT    PRIMARY KEY,
  company_id      TEXT    NOT NULL DEFAULT 'default',
  document_number TEXT    NOT NULL,
  document_date   TEXT    NOT NULL,
  godown_id       TEXT    NOT NULL,
  location_id     TEXT,
  status          TEXT    NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','verified','approved','cancelled')),
  verified_by     TEXT,
  verified_on     TEXT,
  approved_by     TEXT,
  approved_on     TEXT,
  narration       TEXT,
  created_at      DATETIME DEFAULT (datetime('now')),
  updated_at      DATETIME DEFAULT (datetime('now')),
  created_by      TEXT,
  updated_by      TEXT,
  FOREIGN KEY (godown_id) REFERENCES godowns(id) ON DELETE RESTRICT,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL,
  UNIQUE(company_id, document_number)
);

-- Physical Stock Lines
CREATE TABLE IF NOT EXISTS physical_stock_lines (
  id                  TEXT    PRIMARY KEY,
  company_id          TEXT    NOT NULL DEFAULT 'default',
  document_id         TEXT    NOT NULL,
  item_id             TEXT    NOT NULL,
  batch_id            TEXT,
  serial_number       TEXT,
  system_quantity     REAL    NOT NULL DEFAULT 0,
  counted_quantity    REAL    NOT NULL DEFAULT 0,
  difference          REAL    NOT NULL DEFAULT 0,
  location_id         TEXT,
  godown_id           TEXT,
  created_at          DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (document_id) REFERENCES physical_stock_documents(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES stock_items(id) ON DELETE CASCADE,
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE SET NULL,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL,
  FOREIGN KEY (godown_id) REFERENCES godowns(id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Inventory Voucher Header
-- Extends the existing vouchers table conceptually; uses its own header table
-- to support detailed inventory-specific fields (lines, source_type, etc.)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_voucher_headers (
  id                  TEXT    PRIMARY KEY,
  company_id          TEXT    NOT NULL DEFAULT 'default',
  voucher_type        TEXT    NOT NULL CHECK(voucher_type IN ('opening_stock','stock_inward','stock_outward','stock_transfer','stock_adjustment','physical_stock','stock_journal')),
  voucher_number      TEXT    NOT NULL,
  voucher_date        TEXT    NOT NULL,
  reference_id        TEXT,
  narration           TEXT,
  source_type         TEXT,
  status              TEXT    NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','cancelled')),
  approved_by         TEXT,
  approved_on         TEXT,
  accounting_journal_id TEXT,
  created_at          DATETIME DEFAULT (datetime('now')),
  updated_at          DATETIME DEFAULT (datetime('now')),
  created_by          TEXT,
  updated_by          TEXT,
  FOREIGN KEY (accounting_journal_id) REFERENCES journal_entries(id) ON DELETE SET NULL,
  UNIQUE(company_id, voucher_number)
);

-- Inventory Voucher Lines
CREATE TABLE IF NOT EXISTS inventory_voucher_lines (
  id                  TEXT    PRIMARY KEY,
  company_id          TEXT    NOT NULL DEFAULT 'default',
  header_id           TEXT    NOT NULL,
  line_number         INTEGER NOT NULL,
  item_id             TEXT    NOT NULL,
  batch_id            TEXT,
  serial_number       TEXT,
  uom_id              TEXT    NOT NULL,
  quantity            REAL    NOT NULL CHECK(quantity > 0),
  unit_rate           REAL    NOT NULL DEFAULT 0,
  amount              REAL    NOT NULL,
  source_godown_id    TEXT,
  source_location_id  TEXT,
  dest_godown_id      TEXT,
  dest_location_id    TEXT,
  is_source           INTEGER NOT NULL DEFAULT 1,
  adjustment_reason_id TEXT,
  created_at          DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (header_id) REFERENCES inventory_voucher_headers(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES stock_items(id) ON DELETE RESTRICT,
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE SET NULL,
  FOREIGN KEY (uom_id) REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_godown_id) REFERENCES godowns(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_location_id) REFERENCES locations(id) ON DELETE SET NULL,
  FOREIGN KEY (dest_godown_id) REFERENCES godowns(id) ON DELETE RESTRICT,
  FOREIGN KEY (dest_location_id) REFERENCES locations(id) ON DELETE SET NULL,
  FOREIGN KEY (adjustment_reason_id) REFERENCES stock_adjustment_reasons(id) ON DELETE SET NULL,
  -- serial_number is a free-text field referencing the human-readable serial number
  -- string (e.g. "SN-001"), NOT item_serials.id (UUID). It is validated by
  -- business logic during voucher posting (_processSerialLifecycle), not by a
  -- database FK constraint, because serial records are created AFTER posting.
  UNIQUE(company_id, header_id, line_number)
);

-- Stock Ledger (immutable, append-only source of truth for all movements)
CREATE TABLE IF NOT EXISTS stock_ledger (
  id                  TEXT    PRIMARY KEY,
  company_id          TEXT    NOT NULL DEFAULT 'default',
  voucher_type        TEXT    NOT NULL,
  voucher_number      TEXT    NOT NULL,
  header_id           TEXT    NOT NULL,
  line_number         INTEGER NOT NULL,
  voucher_date        TEXT    NOT NULL,
  item_id             TEXT    NOT NULL,
  batch_id            TEXT,
  serial_number       TEXT,
  godown_id           TEXT    NOT NULL,
  location_id         TEXT,
  quantity            REAL    NOT NULL,
  unit_rate           REAL    NOT NULL,
  amount              REAL    NOT NULL,
  reference_id        TEXT,
  narration           TEXT,
  posting_time        DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (header_id) REFERENCES inventory_voucher_headers(id) ON DELETE RESTRICT,
  FOREIGN KEY (item_id) REFERENCES stock_items(id) ON DELETE RESTRICT,
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE SET NULL,
  FOREIGN KEY (godown_id) REFERENCES godowns(id) ON DELETE RESTRICT,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL
);

-- Stock Balances (rebuildable materialised summary)
CREATE TABLE IF NOT EXISTS stock_balances (
  id              TEXT    PRIMARY KEY,
  company_id      TEXT    NOT NULL DEFAULT 'default',
  item_id         TEXT    NOT NULL,
  batch_id        TEXT,
  godown_id       TEXT    NOT NULL,
  location_id     TEXT,
  quantity        REAL    NOT NULL DEFAULT 0,
  avg_rate        REAL    NOT NULL DEFAULT 0,
  last_updated    DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (item_id) REFERENCES stock_items(id) ON DELETE CASCADE,
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,
  FOREIGN KEY (godown_id) REFERENCES godowns(id) ON DELETE CASCADE,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  UNIQUE(company_id, item_id, batch_id, godown_id, location_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes for performance
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_uom_company ON units_of_measure(company_id);
CREATE INDEX IF NOT EXISTS idx_compound_base ON compound_units(base_unit_id);
CREATE INDEX IF NOT EXISTS idx_alternate_base ON alternate_units(base_unit_id);
CREATE INDEX IF NOT EXISTS idx_stock_groups_parent ON stock_groups(parent_group_id);
CREATE INDEX IF NOT EXISTS idx_models_brand ON models(brand_id);
CREATE INDEX IF NOT EXISTS idx_locations_godown ON locations(godown_id);
CREATE INDEX IF NOT EXISTS idx_stock_items_product ON stock_items(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_items_uom ON stock_items(uom_id);
CREATE INDEX IF NOT EXISTS idx_batches_item ON batches(item_id);
CREATE INDEX IF NOT EXISTS idx_item_prices_item ON item_prices(item_id);
CREATE INDEX IF NOT EXISTS idx_item_prices_level ON item_prices(price_level_id);
CREATE INDEX IF NOT EXISTS idx_item_serials_item ON item_serials(item_id);
CREATE INDEX IF NOT EXISTS idx_item_serials_serial ON item_serials(serial_number);
CREATE INDEX IF NOT EXISTS idx_item_serials_godown ON item_serials(godown_id);
CREATE INDEX IF NOT EXISTS idx_phys_lines_doc ON physical_stock_lines(document_id);
CREATE INDEX IF NOT EXISTS idx_ivh_company_date ON inventory_voucher_headers(company_id, voucher_date);
CREATE INDEX IF NOT EXISTS idx_ivh_company_status ON inventory_voucher_headers(company_id, status);
CREATE INDEX IF NOT EXISTS idx_ivl_header ON inventory_voucher_lines(header_id);
CREATE INDEX IF NOT EXISTS idx_ivl_item ON inventory_voucher_lines(item_id);
CREATE INDEX IF NOT EXISTS idx_sl_company_item ON stock_ledger(company_id, item_id);
CREATE INDEX IF NOT EXISTS idx_sl_company_date ON stock_ledger(company_id, voucher_date);
CREATE INDEX IF NOT EXISTS idx_sl_company_batch ON stock_ledger(company_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_sl_company_serial ON stock_ledger(company_id, serial_number);
CREATE INDEX IF NOT EXISTS idx_sl_company_header ON stock_ledger(company_id, header_id);
CREATE INDEX IF NOT EXISTS idx_sb_company_item ON stock_balances(company_id, item_id);
CREATE INDEX IF NOT EXISTS idx_sb_company_godown ON stock_balances(company_id, godown_id);
