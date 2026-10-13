const { DatabaseSync } = require('node:sqlite');
// PHASE 3 — TEST DATABASE SAFETY.
// This opened the LIVE production database unconditionally — there was no
// DB_PATH override at all — and issues 14 DELETE statements. It now operates on
// an isolated disposable clone asserted through the project's existing
// allow-list, so it cannot touch production even by accident.
const { createDisposableDb } = require('../scripts/assert-disposable-db');
const { dbPath: DB_PATH, cleanup: cleanupDisposableDb } = createDisposableDb({
  suite: 'cleanup-test-data',
  prefix: 'bscrm-cleanup-',
});
const db = new DatabaseSync(DB_PATH);

// Delete in correct FK dependency order
const testIds = db.prepare("SELECT id FROM products WHERE name LIKE '%Test%' OR name LIKE '%Fresh%' OR name LIKE '%Verify%' OR name LIKE '%Serial%' OR name LIKE '%Debug%' OR name LIKE '%Edit%' OR name LIKE '%Form%' OR name LIKE '%Display%'").all();
const productIds = testIds.map(r => r.id);

const stockItemIds = productIds.length > 0
  ? db.prepare(`SELECT id FROM stock_items WHERE product_id IN (${productIds.map(() => '?').join(',')})`).all(...productIds)
  : [];
const itemIds = stockItemIds.map(r => r.id);

// Delete stock_ledger
if (itemIds.length) {
  db.prepare(`DELETE FROM stock_ledger WHERE item_id IN (${itemIds.map(() => '?').join(',')})`).run(...itemIds);
  db.prepare(`DELETE FROM item_serials WHERE item_id IN (${itemIds.map(() => '?').join(',')})`).run(...itemIds);
  db.prepare(`DELETE FROM stock_balances WHERE item_id IN (${itemIds.map(() => '?').join(',')})`).run(...itemIds);
  db.prepare(`DELETE FROM inventory_voucher_lines WHERE item_id IN (${itemIds.map(() => '?').join(',')})`).run(...itemIds);
  db.prepare(`DELETE FROM stock_items WHERE id IN (${itemIds.map(() => '?').join(',')})`).run(...itemIds);
}

// Delete journal entries for test vouchers first (before deleting voucher headers)
const voucherIds = db.prepare(`
  SELECT id FROM inventory_voucher_headers 
  WHERE narration LIKE '%Test%' OR narration LIKE '%Fresh%' OR narration LIKE '%Verify%' OR narration LIKE '%Serial%' OR narration LIKE '%Debug%' OR narration LIKE '%Edit%' OR narration LIKE '%Form%' OR narration LIKE '%Display%'
`).all();
const voucherIdList = voucherIds.map(r => r.id);

if (voucherIdList.length) {
  db.prepare(`DELETE FROM journal_entries WHERE voucher_id IN (${voucherIdList.map(() => '?').join(',')})`).run(...voucherIdList);
  db.prepare(`DELETE FROM inventory_voucher_lines WHERE header_id IN (${voucherIdList.map(() => '?').join(',')})`).run(...voucherIdList);
  db.prepare(`DELETE FROM stock_ledger WHERE header_id IN (${voucherIdList.map(() => '?').join(',')})`).run(...voucherIdList);
  db.prepare(`DELETE FROM inventory_movements WHERE voucher_id IN (${voucherIdList.map(() => '?').join(',')})`).run(...voucherIdList);
  db.prepare(`DELETE FROM transaction_tax_details WHERE voucher_id IN (${voucherIdList.map(() => '?').join(',')})`).run(...voucherIdList);
  db.prepare(`DELETE FROM inventory_voucher_headers WHERE id IN (${voucherIdList.map(() => '?').join(',')})`).run(...voucherIdList);
}

// Delete products
if (productIds.length) {
  db.prepare(`DELETE FROM invoice_line_items WHERE product_id IN (${productIds.map(() => '?').join(',')})`).run(...productIds);
  db.prepare(`DELETE FROM bill_items WHERE product_id IN (${productIds.map(() => '?').join(',')})`).run(...productIds);
  db.prepare(`DELETE FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`).run(...productIds);
}

console.log('Remaining test products:', db.prepare("SELECT COUNT(*) as c FROM products WHERE name LIKE '%Test%' OR name LIKE '%Fresh%' OR name LIKE '%Verify%' OR name LIKE '%Serial%' OR name LIKE '%Debug%' OR name LIKE '%Edit%' OR name LIKE '%Form%' OR name LIKE '%Display%'").get().c);
console.log('Remaining item_serials:', db.prepare("SELECT COUNT(*) as c FROM item_serials").get().c);
db.close();
