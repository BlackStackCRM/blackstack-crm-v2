/**
 * Baseline / verification snapshot for the Inventory + Billing repair.
 *
 * Usage:
 *   node scripts/baseline-snapshot.js            # human-readable report
 *   node scripts/baseline-snapshot.js --json     # machine-readable (for before/after diff)
 *
 * Read-only. Never writes to the database.
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'blackstack-crm.db');
const db = new DatabaseSync(DB_PATH);

const TABLES = [
  'locations', 'inv_locations', 'godowns',
  'stock_groups', 'stock_categories', 'brands', 'models',
  'products', 'stock_items',
  'units_of_measure', 'uoms', 'alternate_units', 'compound_units',
  'batches', 'batch_wise_stock', 'item_serials',
  'stock_ledger', 'stock_balances',
  'inventory_voucher_headers', 'inventory_voucher_lines',
  'inventory_items', 'inventory_movements',
  'physical_stock_documents', 'physical_stock_lines',
  'bills', 'bill_items', 'payments', 'vouchers',
  'journal_entries', 'journal_entry_lines',
];

const q = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch (e) { return [{ __err: e.message }]; } };

function counts() {
  const out = {};
  for (const t of TABLES) {
    const r = q(`SELECT COUNT(*) AS n FROM ${t}`);
    out[t] = r[0].__err ? `ERR(${r[0].__err})` : Number(r[0].n);
  }
  return out;
}

/**
 * Core invariant: every stock_balances row must be reproducible from stock_ledger.
 * Anything else means a second writer is corrupting the derived cache.
 */
function reconciliation() {
  return q(`
    SELECT COALESCE(sb.company_id, lg.company_id) AS company_id,
           COALESCE(sb.item_id, lg.item_id)       AS item_id,
           COALESCE(sb.batch_id, lg.batch_id)     AS batch_id,
           COALESCE(sb.godown_id, lg.godown_id)   AS godown_id,
           COALESCE(sb.location_id, lg.location_id) AS location_id,
           sb.quantity  AS balance_qty,
           COALESCE(lg.ledger_qty, 0) AS ledger_qty,
           COALESCE(sb.quantity, 0) - COALESCE(lg.ledger_qty, 0) AS diff
      FROM stock_balances sb
      FULL OUTER JOIN (
            SELECT company_id, item_id, batch_id, godown_id, location_id,
                   SUM(quantity) AS ledger_qty
              FROM stock_ledger
             GROUP BY company_id, item_id, batch_id, godown_id, location_id
      ) lg
        ON  lg.company_id   = sb.company_id
        AND lg.item_id      = sb.item_id
        AND lg.batch_id     IS sb.batch_id
        AND lg.godown_id    = sb.godown_id
        AND lg.location_id  IS sb.location_id
     WHERE sb.id IS NULL OR lg.company_id IS NULL
        OR ABS(COALESCE(sb.quantity,0) - COALESCE(lg.ledger_qty,0)) > 0.000001
     ORDER BY company_id, item_id
  `);
}

/** Batch rows in stock_balances that have no ledger backing at all (silent corruption). */
function orphanBalances() {
  return q(`
    SELECT sb.id, sb.item_id, sb.godown_id, sb.location_id, sb.quantity
      FROM stock_balances sb
      LEFT JOIN (
            SELECT company_id, item_id, batch_id, godown_id, location_id,
                   SUM(quantity) AS ledger_qty
              FROM stock_ledger
             GROUP BY company_id, item_id, batch_id, godown_id, location_id
      ) lg
        ON  lg.company_id  = sb.company_id
        AND lg.item_id     = sb.item_id
        AND lg.batch_id   IS sb.batch_id
        AND lg.godown_id   = sb.godown_id
        AND lg.location_id IS sb.location_id
     WHERE COALESCE(lg.ledger_qty, 0) = 0 AND COALESCE(sb.quantity, 0) != 0
     ORDER BY sb.item_id
  `);
}

/** Product with no stock item, or stock item with no product. */
function productItemGaps() {
  return {
    products_without_stock_item: q(`
      SELECT p.id, p.name, p.sku
        FROM products p
        LEFT JOIN stock_items si ON si.product_id = p.id AND si.company_id = p.company_id
       WHERE si.id IS NULL`),
    stock_items_without_product: q(`
      SELECT si.id, si.sku, si.name, si.product_id
        FROM stock_items si
        LEFT JOIN products p ON p.id = si.product_id
       WHERE p.id IS NULL`),
    products_missing_unit: q(`
      SELECT p.id, p.name FROM products p
       WHERE NOT EXISTS (SELECT 1 FROM stock_items si
                          WHERE si.product_id = p.id AND si.company_id = p.company_id
                            AND si.uom_id IS NOT NULL)`),
  };
}

/** inv_locations rows with no counterpart in canonical locations. */
function locationGaps() {
  return {
    inv_locations_orphan: q(`
      SELECT il.id, il.name, il.code
        FROM inv_locations il
        LEFT JOIN locations l ON l.id = il.id
       WHERE l.id IS NULL ORDER BY il.created_at`),
    locations_orphan: q(`
      SELECT l.id, l.name, l.code
        FROM locations l
        LEFT JOIN inv_locations il ON il.id = l.id
       WHERE il.id IS NULL ORDER BY l.created_at`),
    name_mismatches: q(`
      SELECT l.id, l.name AS locations_name, il.name AS inv_locations_name,
             l.code AS locations_code, il.code AS inv_locations_code
        FROM locations l JOIN inv_locations il ON il.id = l.id
       WHERE IFNULL(l.name,'') <> IFNULL(il.name,'')
          OR IFNULL(l.code,'') <> IFNULL(il.code,'')`),
  };
}

/** stock_balances rows whose (godown, location) pair is inconsistent. */
function godownLocationMismatches() {
  return q(`
    SELECT sb.id, sb.item_id, sb.godown_id, sb.location_id,
           g.location_id AS godown_location_id
      FROM stock_balances sb
      JOIN godowns g ON g.id = sb.godown_id
     WHERE sb.location_id IS NOT NULL
       AND g.location_id IS NOT NULL
       AND sb.location_id <> g.location_id
     ORDER BY sb.item_id`);
}

const report = {
  db: DB_PATH,
  generated_at: new Date().toISOString(),
  counts: counts(),
  reconciliation_mismatches: reconciliation(),
  orphan_balances: orphanBalances(),
  product_item_gaps: productItemGaps(),
  location_gaps: locationGaps(),
  godown_location_mismatches: godownLocationMismatches(),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('=== DB:', DB_PATH, '===');
  console.log('\n--- ROW COUNTS ---');
  for (const [t, n] of Object.entries(report.counts)) console.log(String(t).padEnd(30), n);
  console.log('\n--- LEDGER vs BALANCE MISMATCHES ---');
  console.log(report.reconciliation_mismatches.length
    ? JSON.stringify(report.reconciliation_mismatches, null, 1)
    : 'none — stock_balances fully reproducible from stock_ledger');
  console.log('\n--- BALANCE ROWS WITH NO LEDGER BACKING ---');
  console.log(report.orphan_balances.length ? JSON.stringify(report.orphan_balances, null, 1) : 'none');
  console.log('\n--- PRODUCT / STOCK ITEM GAPS ---');
  for (const [k, v] of Object.entries(report.product_item_gaps)) {
    console.log(k + ':', v.length ? JSON.stringify(v, null, 1) : 'none');
  }
  console.log('\n--- LOCATION GAPS ---');
  for (const [k, v] of Object.entries(report.location_gaps)) {
    console.log(k + ':', v.length ? JSON.stringify(v, null, 1) : 'none');
  }
  console.log('\n--- GODOWN/LOCATION MISMATCHES ---');
  console.log(report.godown_location_mismatches.length
    ? JSON.stringify(report.godown_location_mismatches, null, 1) : 'none');
}

if (report.reconciliation_mismatches.length || report.orphan_balances.length) {
  console.error('\n!! INTEGRITY VIOLATION PRESENT — fix before declaring success.');
  process.exitCode = 1;
}