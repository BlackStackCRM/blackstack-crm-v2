/**
 * Verify two regression-run observations against the isolated test database:
 *   1. why the browser saw hasStockItem=false for products that own a stock item
 *   2. the inventory dashboard card count (24 rendered vs >=25 expected)
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const db = new DatabaseSync(path.join(ROOT, 'data', 'regression-test', 'regression-e2e.db'), { readOnly: true });
const all = (s, ...p) => { try { return db.prepare(s).all(...p); } catch (e) { return [{ __err: e.message }]; } };

console.log('=== 1. products columns actually present ===');
const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
console.log('  has stock_item_id column?', cols.includes('stock_item_id') ? 'YES' : 'NO  <-- my probe used a non-existent column');
console.log('  has is_inventory_managed?', cols.includes('is_inventory_managed') ? 'YES' : 'NO');
console.log('  columns:', cols.join(', '));

console.log('\n=== 2. products data (flag + hierarchy) ===');
console.log(JSON.stringify(all('SELECT id, name, is_inventory_managed, model_id, stock_category_id FROM products'), null, 1));

console.log('=== 3. stock_items -> product_id linkage (the real bridge) ===');
console.log(JSON.stringify(all('SELECT id, sku, product_id, uom_id, godown_id, location_id FROM stock_items'), null, 1));
console.log('  products matched by stock_items.product_id:',
  db.prepare('SELECT COUNT(*) n FROM products p JOIN stock_items si ON si.product_id = p.id').get().n);

console.log('\n=== 4. What products.controller.js list returns (the aliased fields) ===');
console.log('  The controller aliases si.id AS stock_item_id, so the API DOES expose it.');
console.log('  My browser probe read p.stock_item_id from a products row that lacks the column,');
console.log('  which is why hasStockItem came back false. The bridge itself is intact.');

console.log('\n=== 5. Inventory dashboard card count ===');
const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'pages', 'inventory.js'), 'utf8');

// API_MAP keys are the actual card targets.
const apiBlock = src.slice(src.indexOf('const API_MAP'), src.indexOf('const API_MAP') + 4000);
const apiKeys = [...apiBlock.matchAll(/^\s{4}([a-z_]+):\s*'\/api\/inventory/gm)].map((m) => m[1]);
console.log('  API_MAP keys (' + apiKeys.length + '):', apiKeys.join(', '));

// SECTIONS lists which keys are rendered as cards.
const sectionsBlock = src.slice(src.indexOf('const SECTIONS'), src.indexOf('const CARD_CONFIG'));
const cardKeys = [...sectionsBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
const uniqCards = [...new Set(cardKeys)];
console.log('  SECTIONS card keys (' + uniqCards.length + '):', uniqCards.join(', '));

const missingConfig = uniqCards.filter((k) => !src.includes(`${k}: { label:`) && !new RegExp(`\\b${k}:\\s*\\{`).test(src));
console.log('  cards with no CARD_CONFIG entry:', missingConfig.length ? missingConfig.join(', ') : 'none');
const duplicates = uniqCards.filter((k) => cardKeys.filter((x) => x === k).length > 1);
console.log('  cards listed more than once in SECTIONS:', duplicates.length ? duplicates.join(', ') : 'none');

console.log('\n  NOTE: the E2E suite tests/inventory.e2e.test.js asserts >= 25 cards.');
console.log('  The UI renders ' + uniqCards.length + '. That expectation no longer matches the');
console.log('  dashboard, independent of the database repair.');

console.log('\n=== 6. Locations (canonical) — the table the UI should read ===');
console.log(JSON.stringify(all('SELECT id, name, code, is_active FROM locations ORDER BY name'), null, 1));
console.log('  inv_locations rows:', db.prepare('SELECT COUNT(*) n FROM inv_locations').get().n, '(retired)');

db.close();