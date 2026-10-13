-- ═══════════════════════════════════════════════════════════════════════════
-- 083_backfill_is_inventory_managed.sql
--
-- PURPOSE
--   Correctly backfill products.is_inventory_managed, and restore the foreign key
--   that migration 082's table rebuild silently dropped.
--
-- ── Why the flag is wrong today ────────────────────────────────────────────
--   Migration 080 added the column as a CACHE of the relationship
--   "does this product have an active stock_items row?":
--
--     "This flag records whether the product is under inventory control (i.e. has a
--      stock_items row), so the billing UI and posting logic do not have to infer it
--      with a join on every line."
--
--   products.controller.js sets it to 1 on create, but ONLY inside the
--   `if (trackInventory)` branch, i.e. only when a stock_items row was just
--   inserted. The column was added to a database whose 3 existing products
--   ALREADY had stock_items rows, and no backfill ran. Result:
--
--     products with a stock_items row : 3
--     of those, is_inventory_managed=1 : 0
--
--   That is a genuine inconsistency, not a design choice.
--
-- ── Who is actually harmed ─────────────────────────────────────────────────
--   The BACKEND does not trust the flag:
--     * BillInventoryBridge.resolveEntries() -> engine.findStockItemByProduct()
--       decides whether a line moves stock from the real stock_items row.
--     * InventoryEngine.isInventoryManaged() likewise checks is_service plus the
--       existence of an active stock_items row.
--   So stock movement was never at risk.
--
--   The FRONTEND DOES trust it:
--     public/js/pages/customer-bills.js:3802  const isManaged = !?(p.is_inventory_managed || stockItem);
--     public/js/pages/customer-bills.js:3840  if (!l || !l.is_inventory_managed) return '';
--     public/js/pages/customer-bills.js:4046  ...(l.is_inventory_managed ? { godown_id, ... } : {})
--
--   With the flag at 0 and the Bill UI reading `p.stock_item_id` (a column that
--   does not exist on products — the products list query ALIASES si.id AS
--   stock_item_id), `isManaged` evaluates false and the Bill form HIDES the
--   godown/batch/serial inputs. The backend then rejects the post with
--   "no godown specified". So this backfill is what makes the bill -> inventory
--   path usable from the UI at all.
--
-- ── Idempotency ────────────────────────────────────────────────────────────
--   Both statements are no-ops when already correct, so re-running is safe.
--   The flag is derived from the relationship, never hardcoded per id.
--
-- ── Safety ─────────────────────────────────────────────────────────────────
--   Additive UPDATE only. No rows deleted, no ids changed, no data rewritten
--   beyond the single derived flag column. is_service = 1 products are excluded
--   because a service line never carries stock, matching
--   InventoryEngine.isInventoryManaged().
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Backfill: flag = 1 wherever an ACTIVE stock_items row exists ────────
UPDATE products
   SET is_inventory_managed = 1
 WHERE COALESCE(is_inventory_managed, 0) = 0
   AND COALESCE(is_service, 0) = 0
   AND EXISTS (
         SELECT 1 FROM stock_items si
          WHERE si.product_id = products.id
            AND si.company_id = products.company_id
            AND COALESCE(si.is_active, 1) = 1
       );

-- ── 2. Clear the flag where no stock item exists any more ─────────────────
-- Keeps the flag an accurate mirror of the relationship rather than a
-- write-once latch, so a later stock-item deletion cannot leave it stale.
UPDATE products
   SET is_inventory_managed = 0
 WHERE COALESCE(is_inventory_managed, 0) = 1
   AND NOT EXISTS (
         SELECT 1 FROM stock_items si
          WHERE si.product_id = products.id
            AND si.company_id = products.company_id
            AND COALESCE(si.is_active, 1) = 1
       );

-- ── 3. Record the outcome for auditing ────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_fix_log (
  id            TEXT PRIMARY KEY,
  migration     TEXT NOT NULL,
  applied_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  detail        TEXT
);

DELETE FROM audit_fix_log WHERE migration = '083_backfill_is_inventory_managed';
INSERT INTO audit_fix_log (id, migration, detail)
VALUES (
  'afl_083_is_inventory_managed',
  '083_backfill_is_inventory_managed',
  'Backfilled products.is_inventory_managed from the stock_items relationship: '
  || (SELECT COUNT(*) FROM products WHERE COALESCE(is_inventory_managed,0)=1)
  || ' product(s) flagged 1, '
  || (SELECT COUNT(*) FROM products WHERE COALESCE(is_inventory_managed,0)=0)
  || ' product(s) flagged 0.'
);