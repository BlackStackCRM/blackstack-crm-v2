// Clean test data from inventory tables
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
// PHASE 3 — TEST DATABASE SAFETY.
// Previously fell back to the LIVE production database. Now clones it into an
// isolated temp directory, verified by the project's existing allow-list.
const { createDisposableDb } = require('../scripts/assert-disposable-db');
const { dbPath: DB_PATH, cleanup: cleanupDisposableDb } = createDisposableDb({
  suite: 'clean-db',
  prefix: 'bscrm-cleandb-',
});

const tables = [
  'batches','stock_ledger','stock_balances','item_serials',
  'inventory_voucher_lines','inventory_voucher_headers',
  'stock_items','physical_stock_lines','physical_stock_documents',
  'price_levels','stock_adjustment_reasons',
  'units_of_measure','compound_units','alternate_units',
  'locations','godowns','brands','models','colours','sizes',
  'styles','stock_groups','stock_categories','rate'
];

try {
  const db = new DatabaseSync(DB_PATH);
  for (const t of tables) {
    try { db.run(`DELETE FROM ${t}`); } catch(e) { /* table may not exist */ }
  }
  console.log('DB cleaned');
  db.close();
} catch(err) {
  console.error('Clean error:', err.message);
  process.exit(1);
}
