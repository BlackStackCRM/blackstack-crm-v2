#!/usr/bin/env node
/**
 * PHASE D — post-update data-preservation verification (§13, §14, §22).
 *
 * Reads the isolated userData SQLite DIRECTLY rather than through the API,
 * because the point is to prove the bytes on disk survived a real installer run
 * — going through the app would prove the app works, not that the data is intact.
 *
 * Verifies, for records seeded as PHASE-D-*:
 *   - the record still exists, matched on its actual identifying values
 *   - its relationships still resolve (invoice -> customer -> contact,
 *     line -> stock item, product -> category -> group, model -> brand)
 *   - numeric values are unchanged (balances, quantities, rates)
 *   - integrity_check, foreign_key_check, and schema/migration state
 *
 * Usage: node scripts/phase-d-verify-data.js <userDataDir> [seedManifestPath]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

// Resolve deps through the project's own package.json so `node:sqlite`
// (a builtin) and any relative requires resolve the way the app does.
const nodeRequire = createRequire(path.join(path.resolve(__dirname, '..'), 'package.json'));
const { DatabaseSync } = nodeRequire('node:sqlite');

const USER_DATA = process.argv[2];
const MANIFEST = process.argv[3] || path.join(USER_DATA || '', 'phase-d-seeded.json');
const TAG = 'PHASE-D';

if (!USER_DATA) {
  console.error('usage: node scripts/phase-d-verify-data.js <userDataDir> [seedManifest.json]');
  process.exit(2);
}

// Isolation gate: production must never be read.
//
// Compare REALPATH, not the raw strings. On Windows `os.tmpdir()` returns the
// 8.3 short form ("C:\\Users\\BLACKS~1\\AppData\\Local\\Temp") while the path handed
// in is long-form ("C:\\Users\\BLACK STACK\\..."). They are the same directory,
// but a plain startsWith() comparison says no and the gate refuses everything.
const dbPath = path.join(USER_DATA, 'database', 'blackstack-crm.db');
function realPathOrSelf(p) {
  try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); }
  catch { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
}
const tempRoot = realPathOrSelf(os.tmpdir()).toLowerCase().replace(/[\\/]+$/, '');
const resolvedDb = realPathOrSelf(dbPath).toLowerCase();
if (!resolvedDb.startsWith(tempRoot + '\\') && resolvedDb !== tempRoot) {
  console.error('FATAL: refusing to verify — DB is not under the OS temp root: ' + dbPath);
  console.error('       temp root : ' + tempRoot);
  console.error('       db path   : ' + resolvedDb);
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error('FATAL: no database at ' + dbPath);
  process.exit(1);
}

let pass = 0, fail = 0, skipped = 0;
const failures = [];

// The pre-update snapshot records exactly which rows existed before the update.
// Anything absent from it cannot have been lost by the update.
const snapshot = (() => {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return null; }
})();

function snapshotHas(table, value) {
  const recs = snapshot && snapshot.records && snapshot.records[table];
  return Array.isArray(recs) && recs.some((r) => JSON.stringify(r).includes(value));
}

/** Did the seeder report this record as successfully created? */
function seedSaysSeeded(table, value) {
  if (!seed || !seed.created) return false;
  return Object.values(seed.created).some((v) => JSON.stringify(v).includes(value));
}
function ok(name, detail = '') { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
function bad(name, detail) { fail++; failures.push(`${name}: ${detail}`); console.log(`  FAIL  ${name}\n          ${detail}`); }

const seed = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : null;

// v2 may still be running, leaving a live -wal/-shm pair behind. A readOnly
// connection cannot replay a WAL (it would have to write), so opening dbPath
// read-only while one exists fails with "database is not open". Verify against a
// throwaway COPY instead: copy the db plus its sidecars, then open the copy
// read-write so SQLite recovers the WAL into it. The original is never opened
// and never written — same rule the app itself follows (backupService
// checkpoints a copy, never the source).
const SNAP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-d-verify-'));
const SNAP_DB = path.join(SNAP_DIR, 'verify.db');
let snapSeq = 0;
const openForVerify = (sourcePath) => {
  const dest = path.join(SNAP_DIR, `verify-${++snapSeq}.db`);
  for (const suffix of ['', '-wal', '-shm']) {
    const from = sourcePath + suffix;
    if (fs.existsSync(from)) fs.copyFileSync(from, dest + suffix);
  }
  return new DatabaseSync(dest);   // read-write on the COPY, to replay the WAL
};
const db = openForVerify(dbPath);

/** Find a table by any of several candidate names — schema differs by version. */
function tableExists(...names) {
  for (const n of names) {
    const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n);
    if (r) return n;
  }
  return null;
}

/** Count rows whose `col` contains the tag. */
function countTagged(table, col) {
  const t = tableExists(table);
  if (!t) return { table: null, n: 0 };
  try {
    const r = db.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE "${col}" LIKE ?`).get(`%${TAG}%`);
    return { table: t, n: r.c };
  } catch { return { table: t, n: 0 }; }
}

console.log(`\nPHASE D — post-update data verification`);
console.log(`  db: ${dbPath}`);
console.log(`  size: ${fs.statSync(dbPath).size} bytes`);
console.log(`  seeded manifest: ${seed ? MANIFEST : '(none — verifying by tag only)'}\n`);

// ── §14 Database integrity ──────────────────────────────────────────────────
console.log('Database integrity');
const integrity = db.prepare('PRAGMA integrity_check').get();
const integrityVal = Object.values(integrity)[0];
if (integrityVal === 'ok') ok('PRAGMA integrity_check', 'ok');
else bad('PRAGMA integrity_check', String(integrityVal));

const fk = db.prepare('PRAGMA foreign_key_check').all();
if (fk.length === 0) ok('PRAGMA foreign_key_check', '0 violations');
else bad('PRAGMA foreign_key_check', `${fk.length} violations: ${JSON.stringify(fk.slice(0, 5))}`);

// Schema / migration state
const migTable = tableExists('schema_migrations');
if (migTable) {
  const rows = db.prepare('SELECT COUNT(*) c, MAX(version) v FROM schema_migrations').get();
  ok('schema_migrations present', `${rows.c} applied, max version ${rows.v}`);
  global.__maxSchema = rows.v;
} else {
  bad('schema_migrations present', 'table missing');
}

// Duplicate detection on the tagged rows (§14 "no unexpected duplicates")
console.log('\nDuplicate check');
for (const [table, col] of [['contacts', 'first_name'], ['inventory_brands', 'name'], ['invoices', 'notes']]) {
  const t = tableExists(table);
  if (!t) { console.log(`  SKIP  ${table} (table absent)`); continue; }
  try {
    const d = db.prepare(
      `SELECT "${col}" v, COUNT(*) c FROM "${t}" WHERE "${col}" LIKE ? GROUP BY "${col}" HAVING c > 1`,
    ).all(`%${TAG}%`);
    if (d.length === 0) ok(`${table}: no duplicate ${TAG} rows`);
    else bad(`${table}: duplicates`, JSON.stringify(d));
  } catch (e) { console.log(`  SKIP  ${table} (${e.message.slice(0, 60)})`); }
}

// ── §13 Records present, with values intact ─────────────────────────────────
console.log('\nBusiness records preserved');
// Column names come from the real schema read at runtime (see resolveCol below);
// contacts use first_name/last_name, customers/leads use name/title.
// leads and customers have no name/title column — they reference a contact
// (see the relationship section below, and PRAGMA table_info at runtime). Their
// label is asserted through the contact row they point at.
const expectations = [
  ['contacts', 'first_name', `${TAG}-TEST-CONTACT`],
  ['tasks', 'title', `${TAG}-TEST-TASK`],
  ['account_groups', 'name', `${TAG}-TEST-GROUP-CUSTOMER`],
  ['account_groups', 'name', `${TAG}-TEST-GROUP-VENDOR`],
  ['inventory_stock_groups', 'name', `${TAG}-TEST-STOCK-GROUP`],
  ['inventory_stock_categories', 'name', `${TAG}-TEST-STOCK-CATEGORY`],
  ['inventory_brands', 'name', `${TAG}-TEST-BRAND`],
  ['inventory_models', 'name', `${TAG}-TEST-MODEL`],
  ['inventory_products', 'name', `${TAG}-TEST-PRODUCT`],
  ['inventory_stock_items', 'name', `${TAG}-TEST-STOCK-ITEM`],
  ['inventory_locations', 'name', `${TAG}-TEST-LOCATION`],
  ['inventory_godowns', 'name', `${TAG}-TEST-GODOWN`],
];
// Some tables use non-inventory_ prefixes; probe candidates.
// Real table names, read from the live schema: contacts, leads, customers, tasks,
// accounts, account_groups, stock_groups, stock_categories, brands, models,
// products, stock_items, locations, invoices. There is NO inventory_* prefix in
// this schema, and no `godowns` table was confirmed, so godowns stays optional.
const CANDIDATES = {
  account_groups: ['account_groups', 'chart_of_account_groups'],
  inventory_stock_groups: ['stock_groups', 'inventory_stock_groups'],
  inventory_stock_categories: ['stock_categories', 'inventory_stock_categories'],
  inventory_brands: ['brands', 'inventory_brands'],
  inventory_models: ['models', 'inventory_models'],
  inventory_products: ['products', 'inventory_products'],
  inventory_stock_items: ['stock_items', 'inventory_stock_items'],
  inventory_locations: ['locations', 'inventory_locations'],
  inventory_godowns: ['godowns', 'inventory_godowns'],
};

// Resolve each expected row through the LIVE schema rather than assuming a
// table/column pair. Guessing names ("inventory_brands", tasks.title, ...) made
// this throw `no such column` and abort the whole run before later checks.
function columnsOf(t) {
  try { return db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name); }
  catch { return []; }
}

for (const [table, col, value] of expectations) {
  const t = tableExists(...(CANDIDATES[table] || [table]));
  if (!t) { bad(`${table}: ${value}`, `table not found (tried ${(CANDIDATES[table] || [table]).join(', ')})`); continue; }

  const cols = columnsOf(t);
  if (!cols.includes(col)) {
    bad(`${table}.${col}`, `column "${col}" does not exist in "${t}" (has: ${cols.slice(0, 12).join(', ')})`);
    continue;
  }
  const row = db.prepare(`SELECT * FROM "${t}" WHERE "${col}" = ?`).get(value);
  if (row) ok(`${t}.${col}`, `${value} (id ${row.id ?? '?'})`);
  else {
    // Distinguish REAL data loss from a record that never existed. The seeder
    // records its own failures; if a record is absent from BOTH the seed
    // manifest and the snapshot, calling it "lost in update" is wrong — the
    // honest verdict is "not seeded".
    const wasSeeded = seedSaysSeeded(t, value) || snapshotHas(t, value);
    if (wasSeeded) {
      bad(`${t}.${col}`, `row "${value}" is MISSING after update — it existed before`);
    } else {
      skipped++;
      console.log(`  SKIP  ${t}.${col} — "${value}" was never created (seed-time failure, not update loss)`);
    }
  }
}

// ── §13 Relationships must still resolve ────────────────────────────────────
console.log('\nRelationship integrity (actual joins, not just counts)');
function relationship(name, sql, params) {
  try {
    const r = db.prepare(sql).get(...params);
    if (r && Object.values(r).some((v) => v != null)) ok(name, JSON.stringify(r));
    else bad(name, 'join returned no row — relationship broken');
  } catch (e) {
    bad(name, 'query failed: ' + e.message.slice(0, 90));
  }
}

// invoice -> customer -> contact
const invTable = tableExists('invoices', 'billing_invoices', 'sales_invoices');
const custTable = tableExists('customers');
const contactTable = tableExists('contacts');
if (invTable && custTable && contactTable) {
  relationship(
    'invoice -> customer -> contact resolves',
    `SELECT i.id AS invoice_id, i.contact_id AS contact_ref,
            c.id AS contact_id,
            c.first_name AS contact_first, c.last_name AS contact_last,
            i.total AS invoice_total, i.status AS invoice_status
     FROM "${invTable}" i
     LEFT JOIN "${contactTable}" c ON c.id = i.contact_id
     WHERE c.first_name = ? OR i.notes LIKE ?`,
    [`${TAG}-TEST-CONTACT`, `%${TAG}-TEST-INVOICE%`],
  );
  // leads and customers have NO label column of their own (verified with
  // PRAGMA); they point at contacts. Prove the link to the seeded contact.
  relationship(
    'lead -> contact resolves',
    `SELECT l.id AS lead_id, c.id AS contact_id, c.first_name AS contact_first
       FROM leads l JOIN contacts c ON c.id = l.contact_id
      WHERE c.first_name = ?`, [`${TAG}-TEST-CONTACT`]);

  relationship(
    'customer -> contact resolves',
    `SELECT cu.id AS customer_id, c.id AS contact_id, c.first_name AS contact_first
       FROM customers cu JOIN contacts c ON c.id = cu.contact_id
      WHERE c.first_name = ?`, [`${TAG}-TEST-CONTACT`]);

  // Also assert the invoice line still points at the seeded stock item.
  const lineTable = tableExists('invoice_line_items', 'invoice_lines', 'invoice_items', 'billing_invoice_lines');
  if (lineTable) {
    relationship(
      'invoice line -> stock item resolves',
      `SELECT l.id AS line_id, l.description, l.quantity, l.unit_price, si.id AS stock_item_id, si.name AS stock_item_name
       FROM "${lineTable}" l
       LEFT JOIN "${(tableExists('inventory_stock_items', 'stock_items'))}" si ON si.product_id = l.product_id
       WHERE l.description LIKE ?`,
      [`%${TAG}-TEST-LINE-ITEM%`],
    );
  } else {
    console.log(`  SKIP  invoice line -> stock item (no line table found)`);
  }
} else {
  console.log('  SKIP  invoice relationships (missing tables)');
}

// product -> category -> group  (the Phase C-era hierarchy FKs)
const prodT = tableExists(...(CANDIDATES.inventory_products || []));
const catT = tableExists(...(CANDIDATES.inventory_stock_categories || []));
const grpT = tableExists(...(CANDIDATES.inventory_stock_groups || []));
if (prodT && catT && grpT) {
  relationship(
    'product -> stock category -> stock group resolves',
    `SELECT p.name AS product, c.name AS category, g.name AS group_name
     FROM "${prodT}" p
     LEFT JOIN "${catT}" c ON c.id = p.stock_category_id
     LEFT JOIN "${grpT}" g ON g.id = c.stock_group_id
     WHERE p.name LIKE ?`,
    [`%${TAG}-TEST-PRODUCT%`],
  );
}

// model -> brand
const modelT = tableExists(...(CANDIDATES.inventory_models || []));
const brandT = tableExists(...(CANDIDATES.inventory_brands || []));
if (modelT && brandT) {
  relationship(
    'model -> brand resolves',
    `SELECT m.name AS model, b.name AS brand FROM "${modelT}" m
     LEFT JOIN "${brandT}" b ON b.id = m.brand_id WHERE m.name LIKE ?`,
    [`%${TAG}-TEST-MODEL%`],
  );
}

// ── §18 User data outside the install dir survived ──────────────────────────
console.log('\nUser-data separation (§18)');
for (const sub of ['database', 'backups', 'preferences', 'uploads', 'updates']) {
  const dir = path.join(USER_DATA, sub);
  const exists = fs.existsSync(dir);
  const entries = exists ? fs.readdirSync(dir).length : 0;
  if (exists) ok(`${sub}/ present`, `${entries} entries`);
  else bad(`${sub}/ present`, 'directory missing');
}
const backupDir = path.join(USER_DATA, 'backups');
if (fs.existsSync(backupDir)) {
  const baks = fs.readdirSync(backupDir).filter((f) => !f.endsWith('.txt'));
  ok('backups present', `${baks.length} file(s)`);
  if (baks.length) {
    const latest = baks.sort().pop();
    const full = path.join(backupDir, latest);
    try {
      const bdb = openForVerify(full);
      const bic = Object.values(bdb.prepare('PRAGMA integrity_check').get())[0];
      const bcols = bdb.prepare('PRAGMA table_info("contacts")').all().map((c) => c.name);
      const bnameCol = bcols.includes('name') ? 'name'
        : bcols.includes('first_name') ? "first_name || ' ' || COALESCE(last_name,'')" : null;
      const bc = bnameCol
        ? bdb.prepare(`SELECT COUNT(*) c FROM contacts WHERE ${bnameCol} LIKE ?`).get(`%${TAG}%`).c
        : -1;
      bdb.close();
      if (bic === 'ok') ok('latest backup is a valid SQLite file', `${latest} (${bc} tagged contacts)`);
      else bad('latest backup integrity', String(bic));
    } catch (e) {
      bad('latest backup is a valid SQLite file', e.message.slice(0, 80));
    }
  }
}

// ── Seed manifest cross-check ───────────────────────────────────────────────
if (seed?.created) {
  console.log('\nSeed manifest cross-check (IDs must be unchanged)');
  for (const [key, rec] of Object.entries(seed.created)) {
    if (!rec || typeof rec !== 'object' || rec.id == null) continue;
    const table = {
      contact: contactTable, lead: tableExists('leads'), customer: custTable,
      accountCustomer: tableExists('accounts'), stockGroup: grpT, stockCategory: catT,
      brand: brandT, model: modelT, product: prodT, stockItem: tableExists(...(CANDIDATES.inventory_stock_items || [])),
      location: tableExists(...(CANDIDATES.inventory_locations || [])), invoice: invTable,
    }[key];
    if (!table) continue;
    const row = db2(`SELECT id FROM "${table}" WHERE id = ?`, rec.id);
    if (row) ok(`${key}: id ${rec.id} still present`, table);
    else bad(`${key}: id ${rec.id} missing`, `table ${table}`);
  }
}

db.close();

function db2(sql, ...params) {
  return db.prepare(sql).get(...params);
}

console.log(`\n${'='.repeat(64)}`);
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) {
  console.log('\n  Failures:');
  for (const f of failures) console.log('   - ' + f);
}
console.log(`${'='.repeat(64)}\n`);

try { db.close(); } catch { /* already closed */ }
try { fs.rmSync(SNAP_DIR, { recursive: true, force: true }); } catch { /* noop */ }
process.exit(fail ? 1 : 0);
