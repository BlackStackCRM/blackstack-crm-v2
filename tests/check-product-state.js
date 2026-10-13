const { DatabaseSync } = require('node:sqlite');
// PHASE 3 — TEST DATABASE SAFETY.
// Opened the LIVE production database with no override. Now reads an isolated
// disposable clone, verified by the project's existing allow-list.
const { createDisposableDb } = require('../scripts/assert-disposable-db');
const { dbPath: DB_PATH, cleanup: cleanupDisposableDb } = createDisposableDb({
  suite: 'check-product-state',
  prefix: 'bscrm-prodstate-',
});
const db = new DatabaseSync(DB_PATH);

// Check if the test product still exists
const product = db.prepare("SELECT * FROM products WHERE id = 'prod_01M3TTXFFH3XWWZ4E9HCJF0S76'").get();
console.log('Product exists:', !!product);
if (product) {
  console.log('  name:', product.name);
  console.log('  is_serial_tracked:', product.is_serial_tracked);
}

const stockItem = db.prepare("SELECT * FROM stock_items WHERE id = 'stoc_01M3TTXFFMXBHGDXG9NWXX8PBF'").get();
console.log('Stock item exists:', !!stockItem);
if (stockItem) {
  console.log('  godown_id:', stockItem.godown_id);
  console.log('  location_id:', stockItem.location_id);
}

const serials = db.prepare("SELECT * FROM item_serials WHERE item_id = 'stoc_01M3TTXFFMXBHGDXG9NWXX8PBF'").all();
console.log('Serials for this item:', serials.length);

const balances = db.prepare("SELECT * FROM stock_balances WHERE item_id = 'stoc_01M3TTXFFMXBHGDXG9NWXX8PBF'").all();
console.log('Stock balances:', balances.length);

db.close();
