/**
 * Seed BATCH-tracked and SERIAL-tracked inventory into the ISOLATED regression
 * test database, so Phases 6 and 7 can exercise those paths in a visible browser.
 *
 * WHY
 *   The visible regression could not cover batch/serial bill flows because the
 *   live data contains no suitable item: every tracked stock item holds exactly
 *   one unit, and there is no batch-tracked item at all. Both are seeded here
 *   instead, on a disposable database, so no production data is touched.
 *
 * WHAT IT CREATES
 *   1. Batch-tracked product  TEST-BATCH-001, 100 units in batch TEST-BATCH-001
 *   2. Serial-tracked product TEST-SERIAL-001, 2 units: TEST-SERIAL-001/002
 *
 * HOW
 *   Product/stock-item/batch/serial master rows are ordinary inserts — they are
 *   master data, not stock. All QUANTITY enters through the canonical engine:
 *
 *       opening_stock voucher -> stock_ledger -> stock_balances
 *
 *   via InventoryService.postVoucher(), exactly the path the application uses.
 *   No direct stock_balances write and no ledger bypass.
 *
 * SAFETY
 *   Refuses to run unless the target filename carries a disposable marker and is
 *   not the live database.
 *
 *   node scripts/seed-regression-tracked.js [dbPath]
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

const TARGET = process.argv[2]
  || path.join(ROOT, 'data', 'regression-test', 'regression-e2e.db');

const { assertDisposableDb } = require(path.join(ROOT, 'scripts', 'assert-disposable-db'));
const safePath = assertDisposableDb(TARGET, { suite: 'seed-regression-tracked.js' });

process.env.DB_PATH = safePath;
const { migrate } = require(path.join(ROOT, 'server', 'database', 'migrate.js'));
const { InventoryService } = require(path.join(ROOT, 'server', 'services', 'inventory.service'));
const { InventoryEngine } = require(path.join(ROOT, 'server', 'services', 'inventory-engine.service'));
const { generateId } = require(path.join(ROOT, 'server', 'utils', 'generateId'));

const COMPANY = 'default';
const COGS = 100;
const RATE = 100;
const OPENING_QTY = 100;

(async () => {
  const migrated = await migrate();
  const conn = migrated.get();
  const engine = new InventoryEngine(conn);

  const user = conn.get(
    `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id
      JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE u.id = 'admin' LIMIT 1`)?.id;
  const uomId = conn.get(
    `SELECT id FROM units_of_measure WHERE company_id = ? AND is_active = 1 LIMIT 1`, [COMPANY])?.id;
  const godown = conn.get(
    `SELECT g.id, g.location_id FROM godowns g JOIN locations l ON l.id = g.location_id
      WHERE g.company_id = ? AND g.is_active = 1 LIMIT 1`, [COMPANY]);
  const sales = conn.get(`SELECT id FROM accounts WHERE id='acc_sales' AND company_id=?`, [COMPANY])?.id;
  const cogs = conn.get(`SELECT id FROM accounts WHERE id='acc_cogs' AND company_id=?`, [COMPANY])?.id
    || conn.get(`SELECT id FROM accounts WHERE company_id=? AND type='EXPENSE' ORDER BY code LIMIT 1`, [COMPANY])?.id;
  const asset = conn.get(`SELECT id FROM accounts WHERE company_id=? AND type='ASSET' ORDER BY code LIMIT 1`, [COMPANY])?.id;

  if (!user || !uomId || !godown || !sales || !cogs || !asset) {
    console.error('Missing fixtures', {
      user: !!user, uomId: !!uomId, godown: !!godown, sales: !!sales, cogs: !!cogs, asset: !!asset,
    });
    process.exit(1);
  }

  const service = new InventoryService(conn);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  /**
   * Create product + stock item, then post the opening_stock voucher.
   * Idempotent: returns the existing item if the SKU is already present.
   */
  function seedTracked({ sku, name, isBatch, isSerial, batchNumber, serialNumbers }) {
    const existing = conn.get(
      'SELECT id FROM stock_items WHERE company_id = ? AND sku = ?', [COMPANY, sku]);
    if (existing) {
      // Idempotent re-run: resolve the batch from the database rather than
      // returning early with batchId undefined, which would make the caller's
      // isolation check compare against a missing value.
      const existingBatch = isBatch && batchNumber
        ? conn.get(
          'SELECT id FROM batches WHERE company_id = ? AND item_id = ? AND batch_number = ?',
          [COMPANY, existing.id, batchNumber])
        : null;
      return {
        itemId: existing.id,
        productId: existing.product_id,
        batchId: existingBatch ? existingBatch.id : null,
        created: false,
      };
    }

    const productId = generateId('prod');
    const itemId = generateId('stoc');

    conn.prepare(`INSERT INTO products
        (id, company_id, name, sku, price, cost, is_service, is_active, is_inventory_managed, created_at, updated_at)
        VALUES (?, ?, ?, ?, 150, 100, 0, 1, 1, ?, ?)`)
      .run(productId, COMPANY, name, sku, now, now);

    conn.prepare(`INSERT INTO stock_items
        (id, company_id, name, sku, product_id, uom_id, godown_id, location_id,
         cost_price, selling_rate, is_batch_tracked, is_serial_tracked, is_active,
         cogs_account_id, stock_asset_account_id, sales_account_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
      .run(itemId, COMPANY, name, sku, productId, uomId, godown.id, godown.location_id,
        COGS, RATE, isBatch, isSerial, cogs, asset, sales, now, now);

    // Batch master (if batch-tracked). Stock still flows via the voucher below.
    let batchId = null;
    if (isBatch && batchNumber) {
      batchId = generateId('batc');
      conn.prepare(`INSERT INTO batches
          (id, company_id, item_id, batch_number, manufacturing_date, expiry_date,
           purchase_rate, mrp, selling_rate, is_active, created_at, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(batchId, COMPANY, itemId, batchNumber, today, '2030-12-31',
          RATE, 150, 150, now, user);
    }

    // Canonical quantity entry: opening_stock voucher -> ledger -> balances.
    //
    // Serial handling: InventoryService._processSerialLifecycle() reads a single
    // `serial_number` per voucher line, so a serial-tracked item needs ONE LINE
    // PER SERIAL with quantity 1. Passing a `serials` array on one line is
    // silently ignored — the ledger records one qty=N row and no item_serials
    // rows are created at all.
    let lines;
    if (isSerial && serialNumbers.length) {
      lines = serialNumbers.map((sn) => ({
        item_id: itemId,
        uom_id: uomId,
        batch_id: batchId,
        serial_number: sn,
        quantity: 1,
        unit_rate: RATE,
        source_godown_id: godown.id,
        source_location_id: godown.location_id,
        is_source: 0,
      }));
    } else {
      lines = [{
        item_id: itemId,
        uom_id: uomId,
        batch_id: batchId,
        quantity: isSerial ? serialNumbers.length : OPENING_QTY,
        unit_rate: RATE,
        source_godown_id: godown.id,
        source_location_id: godown.location_id,
        is_source: 0,
      }];
    }

    const draft = service.createDraftVoucher({
      voucher_type: 'opening_stock',
      voucher_date: today,
      narration: `Regression seed opening stock ${sku}`,
      source_type: 'REGRESSION_SEED',
      lines,
    }, COMPANY, user);
    service.postVoucher(draft.voucher_number, COMPANY, user);

    return { itemId, productId, batchId, created: true };
  }

  // ── 1. Batch-tracked: 100 units in one batch ─────────────────────────────
  const batch = seedTracked({
    sku: 'TEST-BATCH-001',
    name: 'Test Batch Product',
    isBatch: 1,
    isSerial: 0,
    batchNumber: 'TEST-BATCH-001',
    serialNumbers: [],
  });

  // ── 2. Serial-tracked: one unit per serial ───────────────────────────────
  const serial = seedTracked({
    sku: 'TEST-SERIAL-001',
    name: 'Test Serial Product',
    isBatch: 0,
    isSerial: 1,
    batchNumber: null,
    serialNumbers: ['TEST-SERIAL-001', 'TEST-SERIAL-002'],
  });

  const batchBal = engine.getTotalBalance(COMPANY, batch.itemId);
  const serialBal = engine.getTotalBalance(COMPANY, serial.itemId);
  const serialRows = conn.all(
    'SELECT serial_number, status, godown_id FROM item_serials WHERE item_id = ? ORDER BY serial_number',
    [serial.itemId]);

  // Fail loudly rather than let a partially-seeded database reach the browser
  // tests: a serial-tracked item with no item_serials rows would make Phase 7
  // report a validation success that proves nothing.
  if (serialRows.length !== 2) {
    console.error(`FAILED: expected 2 serial rows for TEST-SERIAL-001, found ${serialRows.length}`);
    process.exit(1);
  }
  const batchRows = conn.all(
    'SELECT batch_id, quantity FROM stock_balances WHERE item_id = ?', [batch.itemId]);
  if (!batch.batchId) {
    console.error('FAILED: seeded batch could not be resolved for TEST-BATCH-001');
    process.exit(1);
  }
  if (batchRows.length !== 1 || batchRows[0].batch_id !== batch.batchId) {
    console.error('FAILED: batch balance is not isolated to the seeded batch', batchRows);
    process.exit(1);
  }

  console.log('seeded tracked inventory:');
  console.log('  BATCH  item', batch.itemId, '(TEST-BATCH-001)');
  console.log('         batch', batch.batchId, 'on hand', batchBal);
  console.log('  SERIAL item', serial.itemId, '(TEST-SERIAL-001)');
  console.log('         on hand', serialBal);
  console.log('  serials:');
  for (const row of serialRows) {
    console.log('    ', row.serial_number, '->', row.status, 'godown', row.godown_id);
  }

  // Sanity: the engine must agree with a direct ledger aggregation.
  for (const [label, itemId, expected] of [
    ['batch', batch.itemId, 100],
    ['serial', serial.itemId, 2],
  ]) {
    const led = conn.get(
      `SELECT COALESCE(SUM(quantity),0) q FROM stock_ledger
        WHERE company_id = ? AND item_id = ? AND voucher_type = 'opening_stock'`, [COMPANY, itemId]).q;
    const bal = engine.getBalance(COMPANY, itemId).quantity;
    if (Math.abs(led - expected) > 0.0001 || Math.abs(bal - expected) > 0.0001) {
      console.error(`FAILED ${label}: ledger=${led} balance=${bal} expected=${expected}`);
      process.exit(1);
    }
    console.log(`  verified ${label}: ledger=${led} balance=${bal} (expected ${expected})`);
  }

  try { migrated.close(); } catch (_) { /* ok */ }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });