/**
 * Verify the project's own rebuild idiom (PRAGMA foreign_keys=OFF, executed
 * OUTSIDE any transaction, as migrate.js already does for `godowns`) safely
 * rebuilds a parent whose children include NOT NULL columns.
 *
 * This is the pattern that failed with:
 *   - DROP TABLE inside a transaction (cascades into children)
 *   - PRAGMA foreign_keys=OFF inside a transaction (silently ignored)
 *   - NULLing NOT NULL child columns (constraint failure)
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bscrm-fk-'));
const file = path.join(dir, 't.db');
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`CREATE TABLE inv_locations (id TEXT PRIMARY KEY, name TEXT)`);
db.exec(`CREATE TABLE locations (id TEXT PRIMARY KEY, name TEXT)`);
db.exec(`CREATE TABLE godowns (id TEXT PRIMARY KEY, name TEXT)`);
db.exec(`CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT, sku TEXT UNIQUE,
    location_id TEXT REFERENCES inv_locations(id) ON DELETE SET NULL)`);
db.exec(`CREATE TABLE batches (id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    batch_number TEXT)`);
db.exec(`CREATE TABLE item_serials (id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    serial_number TEXT)`);
db.exec(`CREATE TABLE stock_ledger (id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
    godown_id TEXT NOT NULL REFERENCES godowns(id) ON DELETE RESTRICT,
    quantity REAL NOT NULL)`);
db.exec(`CREATE TABLE stock_items (id TEXT PRIMARY KEY, sku TEXT NOT NULL,
    product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
    location_id TEXT REFERENCES inv_locations(id) ON DELETE SET NULL,
    UNIQUE(sku))`);

db.exec(`INSERT INTO inv_locations VALUES ('L1','MVP'),('L2','Back Store')`);
db.exec(`INSERT INTO locations      VALUES ('L1','MVP')`);
db.exec(`INSERT INTO godowns        VALUES ('G1','MVP-GD-1')`);
db.exec(`INSERT INTO products      VALUES ('P1','Widget','SKU-1','L2')`);
db.exec(`INSERT INTO stock_items   VALUES ('SI1','SKU-1','P1','L2')`);
db.exec(`INSERT INTO batches       VALUES ('B1','SI1','BATCH-A')`);
db.exec(`INSERT INTO item_serials  VALUES ('SR1','SI1','SER-1')`);
db.exec(`INSERT INTO stock_ledger  VALUES ('SL1','SI1','G1',100)`);

const snap = () => ({
  products:     db.prepare('SELECT COUNT(*) n FROM products').get().n,
  stock_items:  db.prepare('SELECT COUNT(*) n FROM stock_items').get().n,
  batches:      db.prepare('SELECT COUNT(*) n FROM batches').get().n,
  serials:      db.prepare('SELECT COUNT(*) n FROM item_serials').get().n,
  ledger:       db.prepare('SELECT COUNT(*) n FROM stock_ledger').get().n,
  link:         db.prepare(`SELECT COUNT(*) n FROM stock_items WHERE product_id='P1'`).get().n,
  ledgerItem:   db.prepare(`SELECT COUNT(*) n FROM stock_ledger WHERE item_id='SI1'`).get().n,
  batchItem:    db.prepare(`SELECT COUNT(*) n FROM batches WHERE item_id='SI1'`).get().n,
});
console.log('BEFORE:', JSON.stringify(snap()));

// ── Merge legacy locations (safe, no rebuild) ──
db.exec(`INSERT OR IGNORE INTO locations (id,name) SELECT id,name FROM inv_locations`);

// ── Rebuild with FK enforcement OFF, OUTSIDE a transaction ──
db.exec('PRAGMA foreign_keys = OFF');

db.exec(`CREATE TABLE stock_items_new (id TEXT PRIMARY KEY, sku TEXT NOT NULL,
    product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
    location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
    UNIQUE(sku))`);
db.exec(`INSERT INTO stock_items_new SELECT id, sku, product_id, location_id FROM stock_items`);
db.exec('DROP TABLE stock_items');
db.exec('ALTER TABLE stock_items_new RENAME TO stock_items');

db.exec(`CREATE TABLE products_new (id TEXT PRIMARY KEY, name TEXT, sku TEXT UNIQUE,
    location_id TEXT REFERENCES locations(id) ON DELETE SET NULL)`);
db.exec(`INSERT INTO products_new SELECT id, name, sku, location_id FROM products`);
db.exec('DROP TABLE products');
db.exec('ALTER TABLE products_new RENAME TO products');

db.exec('PRAGMA foreign_keys = ON');

const after = snap();
console.log('AFTER: ', JSON.stringify(after));

const fkTargets = db.prepare('PRAGMA foreign_key_list(stock_items)').all()
  .filter(r => r.from === 'location_id').map(r => r.table);
console.log('stock_items.location_id -> ', fkTargets.join(','));

const fkc = db.prepare('PRAGMA foreign_key_check').all();
console.log('foreign_key_check violations:', fkc.length, fkc.length ? JSON.stringify(fkc) : '');

const ok = after.products === 1 && after.stock_items === 1 && after.batches === 1
        && after.serials === 1 && after.ledger === 1
        && after.link === 1 && after.ledgerItem === 1 && after.batchItem === 1
        && fkTargets[0] === 'locations' && fkc.length === 0;

console.log(ok ? '\nPASS — fk-off rebuild outside a transaction preserves NOT NULL children.'
               : '\nFAIL — data lost.');

db.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exitCode = ok ? 0 : 1;