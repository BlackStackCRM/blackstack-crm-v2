/**
 * Read-only probe for the specific code/schema mismatches found in the audit.
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB = path.join(__dirname, '..', 'data', 'blackstack-crm.db');
const db = new DatabaseSync(DB, { readOnly: true });
const one = (s, ...p) => { try { return db.prepare(s).get(...p); } catch (e) { return { __err: e.message }; } };
const all = (s, ...p) => { try { return db.prepare(s).all(...p); } catch (e) { return [{ __err: e.message }]; } };

console.log('=== A. inventory_items shape after the re-key (migration 082) ===');
const invCols = db.prepare('PRAGMA table_info(inventory_items)').all().map((c) => c.name);
console.log('  columns:', invCols.join(', '));
console.log('  rows   :', one('SELECT COUNT(*) AS n FROM inventory_items').n);

console.log('\n=== B. Do accounting.controller.js queries still resolve? ===');
console.log('  It queries: SELECT * FROM inventory_items WHERE company_id = ? AND product_id = ?');
console.log('  product_id column exists?', invCols.includes('product_id') ? 'YES' : 'NO  <-- QUERY WILL THROW');
const probe = all('SELECT * FROM inventory_items WHERE company_id = ? AND product_id = ?', 'default', 'x');
console.log('  live probe result:', probe[0].__err ? `THROWS -> ${probe[0].__err}` : 'resolves');

console.log('\n=== C. reporting.repository.js join ===');
console.log('  LEFT JOIN inventory_items w ON w.id = b.warehouse_id');
console.log('  inventory_items.id type/rows:', one('SELECT COUNT(*) AS n FROM inventory_items').n, 'rows');
console.log('  bills.warehouse_id sample    :', JSON.stringify(all('SELECT DISTINCT warehouse_id FROM bills LIMIT 3')));
const joinProbe = all(`SELECT b.id FROM bills b LEFT JOIN inventory_items w ON w.id = b.warehouse_id LIMIT 1`);
console.log('  live probe result:', joinProbe.length === 0
  ? 'resolves (returns 0 rows; bills is empty so the join is untested by data)'
  : (joinProbe[0].__err ? `THROWS -> ${joinProbe[0].__err}` : 'resolves (but semantically wrong: inventory_items is keyed by product/stock_item, not warehouse)'));

console.log('\n=== D. MEDIUM finding: stock items whose product lacks is_inventory_managed ===');
console.log(JSON.stringify(all(`
  SELECT p.id AS product_id, p.name, p.is_inventory_managed, si.id AS stock_item_id, si.sku
    FROM stock_items si
    JOIN products p ON p.id = si.product_id
   WHERE COALESCE(p.is_inventory_managed, 0) = 0`), null, 1));

console.log('\n=== E. Does the billing bridge depend on that flag? ===');
console.log('  BillInventoryBridge.resolveEntries() calls engine.isInventoryManaged(),');
console.log('  which checks: products.is_service AND existence of an active stock_items row.');
console.log('  -> the FLAG is not used to decide; a live stock_items row is. Flag drift is cosmetic.');
const svc = one(`SELECT COUNT(*) AS n FROM stock_items WHERE is_active = 1`);
console.log('  active stock_items:', svc.n);

console.log('\n=== F. Batch / serial tracking flags present in live data ===');
console.log('  batch-tracked items  :', one('SELECT COUNT(*) AS n FROM stock_items WHERE is_batch_tracked = 1').n);
console.log('  serial-tracked items :', one('SELECT COUNT(*) AS n FROM stock_items WHERE is_serial_tracked = 1').n);
console.log('  batches              :', one('SELECT COUNT(*) AS n FROM batches').n);
console.log('  item_serials         :', one('SELECT COUNT(*) AS n FROM item_serials').n);
console.log('  serial statuses      :', JSON.stringify(all('SELECT status, COUNT(*) n FROM item_serials GROUP BY status')));

console.log('\n=== G. Bills / bill_items / vouchers current state ===');
for (const t of ['bills', 'bill_items', 'payments', 'bill_allocations', 'receivables',
  'vouchers', 'journal_entries', 'journal_entry_lines',
  'inventory_voucher_headers', 'inventory_voucher_lines',
  'valuation_movements', 'physical_stock_documents']) {
  console.log('  ' + t.padEnd(30) + one(`SELECT COUNT(*) AS n FROM ${t}`).n);
}
console.log('  bill statuses:', JSON.stringify(all('SELECT status, COUNT(*) n FROM bills GROUP BY status')));
console.log('  bill_items with stock_item_id:', one('SELECT COUNT(*) AS n FROM bill_items WHERE stock_item_id IS NOT NULL').n);

console.log('\n=== H. Idempotency index present? ===');
console.log(JSON.stringify(all(`SELECT name FROM sqlite_master WHERE type='index' AND name IN
  ('uq_ivh_one_per_source_document','idx_stock_ledger_source_document','idx_bill_items_stock_item','idx_bills_inventory_voucher')`)));

console.log('\n=== I. legacy_tables registry ===');
console.log(JSON.stringify(all('SELECT table_name, status, canonical_replacement, rows_at_retirement FROM legacy_tables'), null, 1));

console.log('\n=== J. product hierarchy integrity ===');
console.log('  products -> model resolves:', one(`SELECT COUNT(*) AS n FROM products p JOIN models m ON m.id=p.model_id`).n, '/', one('SELECT COUNT(*) AS n FROM products').n);
console.log('  products -> stock_category:', one(`SELECT COUNT(*) AS n FROM products p JOIN stock_categories sc ON sc.id=p.stock_category_id`).n);
console.log('  products -> stock_group  :', one(`SELECT COUNT(*) AS n FROM products p JOIN stock_groups sg ON sg.id=p.stock_group_id`).n);
console.log('  models -> brand          :', one(`SELECT COUNT(*) AS n FROM models m JOIN brands b ON b.id=m.brand_id`).n);
console.log('  models -> stock_category :', one(`SELECT COUNT(*) AS n FROM models m JOIN stock_categories sc ON sc.id=m.stock_category_id`).n);
console.log('  stock_categories -> group:', one(`SELECT COUNT(*) AS n FROM stock_categories sc JOIN stock_groups sg ON sg.id=sc.stock_group_id`).n);
console.log('  brands have category FK? :', db.prepare('PRAGMA table_info(brands)').all().some((c) => c.name === 'stock_category_id') ? 'YES' : 'NO (Brand is an independent master by design)');

db.close();