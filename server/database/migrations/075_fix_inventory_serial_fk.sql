-- Migration 075: Fix inventory_voucher_lines serial_number FK constraint
--
-- Problem: The FK constraint
--   FOREIGN KEY (serial_number) REFERENCES item_serials(id) ON DELETE SET NULL
-- is incorrect because `serial_number` stores the human-readable serial string
-- (e.g. "SN-001"), NOT a UUID referencing item_serials.id.
--
-- Serial records (item_serials) are only created AFTER a voucher is posted
-- (in _processSerialLifecycle). Having the FK on the draft voucher_lines table
-- causes every INSERT with a serial_number value to fail with
-- "FOREIGN KEY constraint failed" because the serial_number text never
-- matches an item_serials.id UUID.
--
-- Fix: Drop and recreate inventory_voucher_lines WITHOUT the FK constraint.
-- SQLite does not support ALTER TABLE ... DROP CONSTRAINT, so we use the
-- standard table-rebuild pattern (rename → create → copy → drop → rename).

-- Enable FK enforcement for this migration session
PRAGMA foreign_keys = ON;

-- Backup existing data and table structure
CREATE TEMP TABLE IF NOT EXISTS _ivl_backup AS
  SELECT id, company_id, header_id, line_number, item_id, batch_id, serial_number,
         uom_id, quantity, unit_rate, amount, source_godown_id, source_location_id,
         dest_godown_id, dest_location_id, is_source, adjustment_reason_id,
         created_at FROM inventory_voucher_lines;

-- Disable FK temporarily to allow the table swap
PRAGMA foreign_keys = OFF;

-- Drop the old table and its indexes
DROP TABLE IF EXISTS inventory_voucher_lines;
DROP INDEX IF EXISTS idx_ivl_header;
DROP INDEX IF EXISTS idx_ivl_item;
DROP INDEX IF EXISTS idx_ivl_batch;

-- Recreate the table WITHOUT the serial_number FK constraint
CREATE TABLE inventory_voucher_lines (
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
  FOREIGN KEY (header_id)            REFERENCES inventory_voucher_headers(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id)              REFERENCES stock_items(id)        ON DELETE RESTRICT,
  FOREIGN KEY (batch_id)             REFERENCES batches(id)            ON DELETE SET NULL,
  FOREIGN KEY (uom_id)               REFERENCES units_of_measure(id)   ON DELETE RESTRICT,
  FOREIGN KEY (source_godown_id)     REFERENCES godowns(id)            ON DELETE RESTRICT,
  FOREIGN KEY (source_location_id)   REFERENCES locations(id)          ON DELETE SET NULL,
  FOREIGN KEY (dest_godown_id)       REFERENCES godowns(id)            ON DELETE RESTRICT,
  FOREIGN KEY (dest_location_id)     REFERENCES locations(id)          ON DELETE SET NULL,
  FOREIGN KEY (adjustment_reason_id) REFERENCES adjustment_reasons(id) ON DELETE SET NULL
  -- serial_number is a free-text field: NOT an FK to item_serials.id.
  -- Serial records are created during voucher posting, not at draft time.
);

-- Restore data
INSERT INTO inventory_voucher_lines
  (id, company_id, header_id, line_number, item_id, batch_id, serial_number,
   uom_id, quantity, unit_rate, amount, source_godown_id, source_location_id,
   dest_godown_id, dest_location_id, is_source, adjustment_reason_id, created_at)
SELECT id, company_id, header_id, line_number, item_id, batch_id, serial_number,
       uom_id, quantity, unit_rate, amount, source_godown_id, source_location_id,
       dest_godown_id, dest_location_id, is_source, adjustment_reason_id, created_at
FROM _ivl_backup;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_ivl_header ON inventory_voucher_lines(header_id);
CREATE INDEX IF NOT EXISTS idx_ivl_item   ON inventory_voucher_lines(item_id);
CREATE INDEX IF NOT EXISTS idx_ivl_batch  ON inventory_voucher_lines(batch_id);

-- Clean up
DROP TABLE IF EXISTS _ivl_backup;

-- Re-enable FK enforcement
PRAGMA foreign_keys = ON;
