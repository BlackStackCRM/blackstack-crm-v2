/**
 * Prove the safe in-transaction table-rebuild pattern for SQLite when
 * `PRAGMA foreign_keys` cannot be toggled (it is a no-op inside a
 * transaction, and the project's migration runner always wraps each
 * migration in `BEGIN IMMEDIATE`).
 *
 * The problem: `DROP TABLE parent` fires implicit DELETEs for every child
 * row, so ON DELETE SET NULL children lose their value even though the parent
 * rows are copied back into a replacement table afterwards.
 *
 * The fix: capture the child values, null them, rebuild the parent, restore.
 */
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');

db.exec(`CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT, location_id TEXT REFERENCES inv_locations(id) ON DELETE SET NULL)`);
db.exec(`CREATE TABLE stock_items (id TEXT PRIMARY KEY, product_id TEXT REFERENCES products(id) ON DELETE SET NULL, location_id TEXT REFERENCES inv_locations(id) ON DELETE SET NULL)`);
db.exec(`CREATE TABLE inv_locations (id TEXT PRIMARY KEY, name TEXT)`);
db.exec(`CREATE TABLE locations (id TEXT PRIMARY KEY, name TEXT)`);

db.exec(`INSERT INTO inv_locations VALUES ('L1','MVP'),('L2','Back Store')`);
db.exec(`INSERT INTO locations  VALUES ('L1','MVP')`);
db.exec(`INSERT INTO products    VALUES ('P1','Widget','L2')`);
db.exec(`INSERT INTO stock_items VALUES ('S1','P1','L2')`);

const before = db.prepare(`SELECT
    (SELECT COUNT(*) FROM products)     AS products,
    (SELECT COUNT(*) FROM stock_items)  AS stock_items,
    (SELECT COUNT(*) FROM stock_items WHERE product_id='P1') AS link_intact`).get();
console.log('BEFORE:', JSON.stringify(before));

// ── The pattern, executed inside one transaction (as migrate.js does) ──
db.exec('BEGIN IMMEDIATE');

// 1. Merge legacy rows into the canonical table (INSERT OR IGNORE keeps ids).
db.exec(`INSERT OR IGNORE INTO locations (id, name) SELECT id, name FROM inv_locations`);

// 2. Stash the child column values that would be destroyed by DROP TABLE.
db.exec(`CREATE TABLE _rbk_stock_items_product (id TEXT PRIMARY KEY, product_id TEXT)`);
db.exec(`INSERT INTO _rbk_stock_items_product SELECT id, product_id FROM stock_items`);
db.exec(`CREATE TABLE _rbk_stock_items_loc (id TEXT PRIMARY KEY, location_id TEXT)`);
db.exec(`INSERT INTO _rbk_stock_items_loc SELECT id, location_id FROM stock_items`);

// 3. Detach the children so the parent DROP is a no-op for them.
db.exec(`UPDATE stock_items SET product_id = NULL, location_id = NULL`);

// 4. Rebuild the parent with the new FK target, preserving every row.
db.exec(`CREATE TABLE products_new (id TEXT PRIMARY KEY, name TEXT,
    location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
    is_inventory_managed INTEGER DEFAULT 0)`);
db.exec(`INSERT INTO products_new (id, name, location_id) SELECT id, name, location_id FROM products`);
db.exec(`DROP TABLE products`);
db.exec(`ALTER TABLE products_new RENAME TO products`);

// 5. Reattach the children using the stashed values.
db.exec(`UPDATE stock_items SET
    product_id  = (SELECT r.product_id  FROM _rbk_stock_items_product r WHERE r.id = stock_items.id),
    location_id = (SELECT r.location_id FROM _rbk_stock_items_loc     r WHERE r.id = stock_items.id)`);
db.exec(`DROP TABLE _rbk_stock_items_product`);
db.exec(`DROP TABLE _rbk_stock_items_loc`);

db.exec('COMMIT');

const after = db.prepare(`SELECT
    (SELECT COUNT(*) FROM products) AS products,
    (SELECT COUNT(*) FROM stock_items) AS stock_items,
    (SELECT COUNT(*) FROM stock_items WHERE product_id='P1') AS link_intact,
    (SELECT COUNT(*) FROM stock_items WHERE location_id='L2') AS loc_intact,
    (SELECT COUNT(*) FROM locations) AS locations`).get();
console.log('AFTER: ', JSON.stringify(after));

const fk = db.prepare('PRAGMA foreign_key_list(products)').all().map(r => `${r.from}->${r.table}.${r.to}`);
console.log('products FK target now:', fk.join(', '));
console.log('foreign_key_check violations:', db.prepare('PRAGMA foreign_key_check').all().length);

const ok = after.link_intact === 1 && after.loc_intact === 1 && after.products === 1
        && after.stock_items === 1 && fk.some(f => f.includes('locations'));
console.log(ok ? '\nPASS — pattern preserves child links and repoints FKs.'
             : '\nFAIL — data was lost.');
process.exitCode = ok ? 0 : 1;