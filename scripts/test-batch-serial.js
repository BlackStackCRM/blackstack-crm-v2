/**
 * Batch and serial tracking tests for the canonical inventory engine.
 *
 * Runs against a THROWAWAY copy of the database. The live database is never
 * touched. Read the blackstack-test-db-isolation skill before changing how this
 * is run.
 *
 *   node scripts/test-batch-serial.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bscrm-batch-'));
const dbPath = path.join(tmpDir, 'batch-serial.db');

fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), dbPath);
process.env.DB_PATH = dbPath;

const { DatabaseSync } = require('node:sqlite');
const raw = new DatabaseSync(dbPath);
raw.exec('PRAGMA foreign_keys=ON');
for (const t of ['stock_ledger', 'stock_balances', 'valuation_movements',
  'inventory_voucher_lines', 'inventory_voucher_headers',
  'item_serials', 'batches', 'inventory_items']) {
  try { raw.exec(`DELETE FROM ${t}`); } catch (e) { /* optional */ }
}
raw.exec('DELETE FROM stock_items');
raw.exec('DELETE FROM products');
raw.close();

let passed = 0, failed = 0;
const lines = [];
function check(name, cond, detail) {
  if (cond) { passed++; lines.push(`  PASS  ${name}`); }
  else { failed++; lines.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, a, e) {
  // Compare numerically when both sides are numeric, otherwise compare exactly.
  const na = Number(a), ne = Number(e);
  const bothNumeric = !Number.isNaN(na) && !Number.isNaN(ne) && a !== null && e !== null;
  const ok = bothNumeric ? na === ne : String(a) === String(e);
  check(name, ok, `expected ${e}, got ${a}`);
}
function rejects(name, fn, pattern) {
  try { fn(); check(name, false, 'expected a ValidationError but none was thrown'); }
  catch (e) {
    const msg = String(e && e.message);
    check(name, !pattern || pattern.test(msg), `threw "${msg}" which did not match ${pattern}`);
  }
}

(async () => {
  const { migrate } = require(path.join(ROOT, 'server', 'database', 'migrate.js'));
  const migrated = await migrate();
  const conn = migrated.get();

  const { InventoryService } = require(path.join(ROOT, 'server', 'services', 'inventory.service'));
  const { InventoryEngine } = require(path.join(ROOT, 'server', 'services', 'inventory-engine.service'));
  const { generateId } = require(path.join(ROOT, 'server', 'utils', 'generateId'));

  const COMPANY = 'default';
  const USER = conn.get(`SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id
                          JOIN role_permissions rp ON rp.role_id=ur.role_id
                         WHERE u.id='admin' LIMIT 1`)?.id;
  const inventory = new InventoryService(conn);
  const engine = new InventoryEngine(conn);

  const uomId = conn.get(`SELECT id FROM units_of_measure WHERE company_id=? AND is_active=1 LIMIT 1`, [COMPANY])?.id;
  const godown = conn.get(`SELECT g.id, g.location_id FROM godowns g WHERE g.company_id=? ORDER BY g.created_at LIMIT 1`, [COMPANY]);
  const locationId = godown.location_id;

  console.log('\n' + '='.repeat(70));
  console.log('BATCH & SERIAL TRACKING TESTS');
  console.log('='.repeat(70));

  // ── Fixtures ────────────────────────────────────────────────────────────
  function makeItem(sku, { batch = false, serial = false } = {}) {
    const productId = generateId('prod');
    const stockItemId = generateId('stoc');
    conn.run(
      `INSERT INTO products (id, company_id, name, sku, price, cost, is_service, is_active,
         is_inventory_managed, created_at, updated_at)
       VALUES (?,?,?,?,100,50,0,1,1,datetime('now'),datetime('now'))`,
      [productId, COMPANY, sku, sku]);
    conn.run(
      `INSERT INTO stock_items (id, company_id, name, sku, product_id, uom_id, godown_id, location_id,
         cost_price, selling_rate, is_batch_tracked, is_serial_tracked, is_active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,50,100,?,?,1,datetime('now'),datetime('now'))`,
      [stockItemId, COMPANY, sku, sku, productId, uomId, godown.id, locationId, batch ? 1 : 0, serial ? 1 : 0]);
    return { productId, stockItemId, sku };
  }

  function postVoucher(type, linesArr, date = '2026-02-01') {
    const v = inventory.createDraftVoucher({
      voucher_type: type, voucher_date: date, lines: linesArr,
    }, COMPANY, USER);
    return inventory.postVoucher(v.voucher_number, COMPANY, USER);
  }

  function inLine(itemId, qty, rate, extra = {}) {
    return {
      item_id: itemId, uom_id: uomId, quantity: qty, unit_rate: rate,
      source_godown_id: godown.id, source_location_id: locationId, is_source: 0, ...extra,
    };
  }

  // ═══ BATCH ═══
  console.log('\n--- BATCH TRACKING ---');
  const batched = makeItem('BATCH-ITEM', { batch: true });

  const batchA = generateId('bat');
  const batchB = generateId('bat');
  conn.run(`INSERT INTO batches (id, company_id, item_id, batch_number, manufacturing_date, expiry_date,
              purchase_rate, is_active, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,1,datetime('now'),datetime('now'))`,
    [batchA, COMPANY, batched.stockItemId, 'A-001', '2026-01-01', '2027-01-01', 50]);
  conn.run(`INSERT INTO batches (id, company_id, item_id, batch_number, manufacturing_date, expiry_date,
              purchase_rate, is_active, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,1,datetime('now'),datetime('now'))`,
    [batchB, COMPANY, batched.stockItemId, 'A-002', '2026-01-01', '2027-01-01', 50]);

  postVoucher('stock_inward', [
    inLine(batched.stockItemId, 10, 50, { batch_id: batchA }),
    inLine(batched.stockItemId, 25, 50, { batch_id: batchB }),
  ]);

  eq('B1. batch A holds 10', engine.getBalance(COMPANY, batched.stockItemId, { batchId: batchA }).quantity, 10);
  eq('B2. batch B holds 25', engine.getBalance(COMPANY, batched.stockItemId, { batchId: batchB }).quantity, 25);
  eq('B3. total across batches = 35', engine.getTotalBalance(COMPANY, batched.stockItemId), 35);

  // Selling from B must be validated against B alone, never against the total.
  postVoucher('stock_outward', [{
    item_id: batched.stockItemId, uom_id: uomId, quantity: 5, unit_rate: 50,
    source_godown_id: godown.id, source_location_id: locationId, is_source: 1, batch_id: batchB,
  }]);
  eq('B4. batch B reduced to 20', engine.getBalance(COMPANY, batched.stockItemId, { batchId: batchB }).quantity, 20);
  eq('B5. batch A untouched at 10', engine.getBalance(COMPANY, batched.stockItemId, { batchId: batchA }).quantity, 10);

  // Selling 50 from a batch holding only 20 must fail, even though the item
  // totals 30. This is the exact bug the old validator had.
  rejects('B6. outward exceeding the BATCH is rejected even when total stock suffices', () =>
    postVoucher('stock_outward', [{
      item_id: batched.stockItemId, uom_id: uomId, quantity: 50, unit_rate: 50,
      source_godown_id: godown.id, source_location_id: locationId, is_source: 1, batch_id: batchB,
    }]), /Insufficient stock/i);

  // Omitting the batch on a batch-tracked item must be rejected outright.
  rejects('B7. batch-tracked outward WITHOUT a batch is rejected', () =>
    postVoucher('stock_outward', [{
      item_id: batched.stockItemId, uom_id: uomId, quantity: 1, unit_rate: 50,
      source_godown_id: godown.id, source_location_id: locationId, is_source: 1,
    }]), /batch-tracked/i);

  // Expired batch must not be sellable.
  const expiredBatch = generateId('bat');
  conn.run(`INSERT INTO batches (id, company_id, item_id, batch_number, expiry_date, purchase_rate,
              is_active, created_at, updated_at)
            VALUES (?,?,?,?,?,?,1,datetime('now'),datetime('now'))`,
    [expiredBatch, COMPANY, batched.stockItemId, 'A-OLD', '2020-01-01', 50]);
  postVoucher('stock_inward', [inLine(batched.stockItemId, 5, 50, { batch_id: expiredBatch })]);
  rejects('B8. expired batch cannot be sold outward', () =>
    postVoucher('stock_outward', [{
      item_id: batched.stockItemId, uom_id: uomId, quantity: 1, unit_rate: 50,
      source_godown_id: godown.id, source_location_id: locationId, is_source: 1, batch_id: expiredBatch,
    }]), /expired|Insufficient/i);

  // ═══ SERIAL ═══
  console.log('\n--- SERIAL TRACKING ---');
  const serials = makeItem('SERIAL-ITEM', { serial: true });
  const serIds = ['SER-001', 'SER-002', 'SER-003'].map((n, i) => {
    const id = generateId('ser');
    conn.run(`INSERT INTO item_serials (id, company_id, item_id, serial_number, status, godown_id,
                location_id, purchase_rate, created_at, updated_at)
              VALUES (?,?,?,?,'available',?,?,50,datetime('now'),datetime('now'))`,
      [id, COMPANY, serials.stockItemId, n, godown.id, locationId]);
    return { id, name: n, idx: i };
  });

  postVoucher('stock_inward', [inLine(serials.stockItemId, 3, 50)]);

  eq('S1. three serials available', engine.getAvailableSerials(COMPANY, serials.stockItemId).length, 3);
  eq('S2. total stock = 3', engine.getTotalBalance(COMPANY, serials.stockItemId), 3);

  // Outward WITHOUT a serial on a serial-tracked item must be refused.
  rejects('S3. serial-tracked outward WITHOUT a serial is rejected', () =>
    postVoucher('stock_outward', [{
      item_id: serials.stockItemId, uom_id: uomId, quantity: 1, unit_rate: 50,
      source_godown_id: godown.id, source_location_id: locationId, is_source: 1,
    }]), /serial-tracked|serial number is required/i);

  // Selling an already-sold serial must be refused.
  const first = serIds[0];
  postVoucher('stock_outward', [{
    item_id: serials.stockItemId, uom_id: uomId, quantity: 1, unit_rate: 50,
    source_godown_id: godown.id, source_location_id: locationId, is_source: 1,
    serial_number: first.name,
  }]);
  eq('S4. sold serial is marked sold',
    engine.getSerialByNumber(COMPANY, first.name).status, 'sold');
  eq('S5. two serials remain available',
    engine.getAvailableSerials(COMPANY, serials.stockItemId).length, 2);

  rejects('S6. selling the SAME serial twice is rejected', () =>
    postVoucher('stock_outward', [{
      item_id: serials.stockItemId, uom_id: uomId, quantity: 1, unit_rate: 50,
      source_godown_id: godown.id, source_location_id: locationId, is_source: 1,
      serial_number: first.name,
    }]), /is sold|cannot be issued/i);

  // A damaged serial must never be sellable.
  conn.run(`UPDATE item_serials SET status = 'damaged' WHERE id = ?`, [serIds[1].id]);
  rejects('S7. a damaged serial cannot be sold', () =>
    postVoucher('stock_outward', [{
      item_id: serials.stockItemId, uom_id: uomId, quantity: 1, unit_rate: 50,
      source_godown_id: godown.id, source_location_id: locationId, is_source: 1,
      serial_number: serIds[1].name,
    }]), /is damaged|cannot be issued/i);

  // Transfer must MOVE a serial, not mark it sold.
  const godown2 = generateId('godo');
  conn.run(`INSERT INTO godowns (id, company_id, name, code, location_id, is_active, created_at, updated_at)
            VALUES (?,?,?,?,?,1,datetime('now'),datetime('now'))`,
    [godown2, COMPANY, 'BATCH-TEST-GD-2', 'BT-GD2', locationId]);
  const moving = serIds[2];
  postVoucher('stock_transfer', [{
    item_id: serials.stockItemId, uom_id: uomId, quantity: 1, unit_rate: 50,
    source_godown_id: godown.id, source_location_id: locationId,
    dest_godown_id: godown2, dest_location_id: locationId, is_source: 1,
    serial_number: moving.name,
  }]);
  const movedSerial = engine.getSerialByNumber(COMPANY, moving.name);
  eq('S8. transferred serial stays available', movedSerial.status, 'available');
  eq('S9. transferred serial moved godown', movedSerial.godown_id, godown2);

  // Company total must be conserved by a transfer.
  eq('S10. transfer conserves total serial-item stock',
    engine.getTotalBalance(COMPANY, serials.stockItemId), 2);

  // ═══ Cross-checks ═══
  console.log('\n--- INTEGRITY ---');
  eq('X1. foreign_key_check clean', conn.prepare('PRAGMA foreign_key_check').all().length, 0);

  const orphan = conn.get(`
    SELECT COUNT(*) AS n FROM stock_balances sb
     WHERE sb.quantity != 0 AND NOT EXISTS (
       SELECT 1 FROM (SELECT company_id,item_id,batch_id,godown_id,location_id,SUM(quantity) q
                        FROM stock_ledger GROUP BY company_id,item_id,batch_id,godown_id,location_id) lg
        WHERE lg.company_id=sb.company_id AND lg.item_id=sb.item_id
          AND lg.batch_id IS sb.batch_id AND lg.godown_id=sb.godown_id
          AND lg.location_id IS sb.location_id AND lg.q != 0)`).n;
  eq('X2. no balance row lacks ledger backing', orphan, 0);

  const noActor = conn.get(`SELECT COUNT(*) AS n FROM stock_ledger WHERE created_by IS NULL`).n;
  eq('X3. every ledger row records an actor', noActor, 0);

  console.log('\n' + '-'.repeat(70));
  lines.forEach((l) => console.log(l));
  console.log('-'.repeat(70));
  console.log(`\nPASS: ${passed}   FAIL: ${failed}`);
  console.log('='.repeat(70) + '\n');

  try { migrated.close(); } catch (_) {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nTEST ERROR:', err.stack || err.message);
  console.error(`\nPASS: ${passed}   FAIL: ${failed + 1}`);
  process.exit(1);
});