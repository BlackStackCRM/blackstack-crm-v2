/**
 * Dry-run the pending migrations against a COPY of the live database.
 *
 *   node scripts/migrate-dryrun.js
 *
 * Verifies, before anything touches the real DB:
 *   - every migration applies cleanly
 *   - no row counts decrease (except the documented inv_locations retirement)
 *   - no product <-> stock_item link is lost
 *   - stock_balances remains reproducible from stock_ledger
 *   - PRAGMA foreign_key_check is clean
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

(async () => {
const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, 'data', 'blackstack-crm.db');
const MIGRATIONS = path.join(ROOT, 'server', 'database', 'migrations');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bscrm-dryrun-'));
const copy = path.join(tmpDir, 'dryrun.db');
fs.copyFileSync(LIVE, copy);

let db = new DatabaseSync(copy);
db.exec('PRAGMA foreign_keys=ON');

const q = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch (e) { return [{ __err: e.message }]; } };
const one = (sql, ...p) => { try { return db.prepare(sql).get(...p); } catch (e) { return { __err: e.message }; } };

const WATCH = [
  'locations', 'inv_locations', 'godowns', 'stock_groups', 'stock_categories',
  'brands', 'models', 'products', 'stock_items', 'units_of_measure',
  'batches', 'item_serials', 'stock_ledger', 'stock_balances',
  'inventory_voucher_headers', 'inventory_voucher_lines', 'inventory_items',
  'bills', 'bill_items', 'payments', 'vouchers', 'journal_entries', 'journal_entry_lines',
];

const count = (t) => { const r = one(`SELECT COUNT(*) AS n FROM ${t}`); return r.__err ? `ERR(${r.__err})` : Number(r.n); };

const before = {};
for (const t of WATCH) before[t] = count(t);
const beforeLink = one(`SELECT COUNT(*) AS n FROM stock_items WHERE product_id IS NOT NULL`);
const beforeLedgerQty = one(`SELECT COALESCE(SUM(quantity),0) AS q FROM stock_ledger`);

console.log('=== DRY RUN on', copy, '===');
console.log('baseline counts:', JSON.stringify(before, null, 1));

// ── Apply pending migrations exactly as production will ──
//   We call the REAL migrate() against the copy, so the dry run exercises the
//   identical code path: .sql files inside BEGIN IMMEDIATE, then the
//   programmatic post-steps (which need PRAGMA foreign_keys=OFF and therefore
//   CANNOT run inside a transaction).
process.env.DB_PATH = copy;
try {
  const { migrate } = require(path.join(ROOT, 'server', 'database', 'migrate.js'));
  const migrated = await migrate();
  // migrate() returns an open handle; close it so WAL files can be removed.
  if (migrated && typeof migrated.close === 'function') migrated.close();
} catch (e) {
  console.error('  FAILED migrate():', e.message);
  process.exit(1);
}
db.close();
for (const suffix of ['-wal', '-shm']) {
  try { fs.rmSync(copy + suffix, { force: true }); } catch (_) { /* not present */ }
}
db = new DatabaseSync(copy);
db.exec('PRAGMA foreign_keys=ON');
console.log('\nmigrations applied\n');

// ── Integrity checks ──
const after = {};
for (const t of WATCH) after[t] = count(t);
const afterLink = one(`SELECT COUNT(*) AS n FROM stock_items WHERE product_id IS NOT NULL`);
const afterLedgerQty = one(`SELECT COALESCE(SUM(quantity),0) AS q FROM stock_ledger`);

const LOST = { inv_locations: true };  // documented retirement only
const failures = [];

console.log('=== ROW COUNT COMPARISON ===');
for (const t of WATCH) {
  const b = before[t], a = after[t];
  const status = b === a ? 'same' : (LOST[t] ? 'RETIRED' : (a > b ? 'GREW' : 'LOST!!'));
  if (status === 'LOST!!') failures.push(`row loss in ${t}: ${b} -> ${a}`);
  console.log(`  ${t.padEnd(28)} ${String(b).padStart(6)} -> ${String(a).padStart(6)}  ${status}`);
}

console.log('\n=== INTEGRITY ===');
const linkStatus = beforeLink.n === afterLink.n
  ? 'OK'
  : `FAIL (${beforeLink.n} -> ${afterLink.n})`;
if (beforeLink.n !== afterLink.n) failures.push('product<->stock_item link lost');
console.log('  product<->stock_item links:', linkStatus);

const ledStatus = beforeLedgerQty.q === afterLedgerQty.q ? 'OK' : `FAIL (${beforeLedgerQty.q} -> ${afterLedgerQty.q})`;
if (beforeLedgerQty.q !== afterLedgerQty.q) failures.push('stock_ledger quantity changed');
console.log('  stock_ledger total qty:    ', ledStatus);

const fkc = q('PRAGMA foreign_key_check');
console.log('  foreign_key_check:        ', fkc.length === 0 ? 'OK (0 violations)' : `FAIL (${fkc.length})`);
if (fkc.length) { failures.push('foreign_key_check violations'); console.log(JSON.stringify(fkc, null, 1)); }

const mismatch = q(`
  SELECT sb.item_id, sb.quantity AS bal, COALESCE(lg.q,0) AS led
    FROM stock_balances sb
    LEFT JOIN (SELECT company_id,item_id,batch_id,godown_id,location_id,SUM(quantity) q
                 FROM stock_ledger GROUP BY company_id,item_id,batch_id,godown_id,location_id) lg
      ON lg.company_id=sb.company_id AND lg.item_id=sb.item_id
     AND lg.batch_id IS sb.batch_id AND lg.godown_id=sb.godown_id
     AND lg.location_id IS sb.location_id
   WHERE ABS(COALESCE(sb.quantity,0)-COALESCE(lg.q,0)) > 0.000001`);
console.log('  ledger==balances:         ', mismatch.length === 0 ? 'OK' : `FAIL (${mismatch.length} rows)`);
if (mismatch.length) { failures.push('balances not reproducible from ledger'); console.log(JSON.stringify(mismatch, null, 1)); }

// Location consolidation outcome
const locs = q('SELECT id, name, code FROM locations ORDER BY created_at');
console.log('\n=== CANONICAL locations ===');
console.log(JSON.stringify(locs, null, 1));
console.log('  inv_locations rows remaining:', count('inv_locations'));
const stillRef = one(`SELECT COUNT(*) AS n FROM pragma_table_info('x') WHERE 0`);
const dupNames = q(`SELECT company_id, name, COUNT(*) n FROM locations GROUP BY company_id, name HAVING n > 1`);
console.log('  duplicate location names:  ', dupNames.length === 0 ? 'none' : JSON.stringify(dupNames));

// New idempotency index present?
const idx = q(`SELECT name FROM sqlite_master WHERE type='index' AND name IN
  ('uq_ivh_one_per_source_document','idx_stock_ledger_source_document','idx_bill_items_stock_item','idx_bills_inventory_voucher')`);
console.log('\n=== NEW INDEXES ===');
console.log('  ', idx.map(i => i.name).join(', ') || 'none');

// FK targets repointed?
console.log('\n=== FK TARGETS (must all be `locations`) ===');
for (const t of ['products', 'stock_items', 'stock_groups']) {
  const f = db.prepare(`PRAGMA foreign_key_list(${t})`).all()
    .filter(r => r.from.includes('location'));
  for (const r of f) console.log(`  ${t}.${r.from} -> ${r.table}.${r.to}`);
  if (f.some(r => r.table !== 'locations')) failures.push(`${t} still references non-canonical location table`);
}

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('\n' + '='.repeat(60));
if (failures.length) {
  console.log('DRY RUN FAILED:');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('DRY RUN PASSED — safe to apply to the live database.');
})().catch(e => { console.error('DRY RUN ERROR:', e.message); process.exit(1); });
