/**
 * Seed the ISOLATED regression-test database so the bill -> inventory path can be
 * exercised end to end in a visible browser.
 *
 * WHY
 *   Every stock item in the live data is serial-tracked and holds exactly 1 unit.
 *   Selling one requires selecting a serial, and a 1-unit item cannot demonstrate
 *   "bill reduces stock, cancel restores it" convincingly.
 *
 *   So this seeds ONE additional plain (non-batch, non-serial) inventory-managed
 *   product with 100 units, through the CANONICAL path only:
 *
 *       opening_stock voucher -> stock_ledger -> stock_balances
 *
 *   It calls InventoryService.postVoucher(), the same route the application uses.
 *   No direct stock_balances write, no bypass of the ledger.
 *
 * SAFETY
 *   Refuses to run unless the target filename carries a disposable marker and is
 *   not the live database.
 *
 *   node scripts/seed-regression-stock.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

const TARGET = process.argv[2]
  || path.join(ROOT, 'data', 'regression-test', 'regression-e2e.db');

const { assertDisposableDb } = require(path.join(ROOT, 'scripts', 'assert-disposable-db'));
const safePath = assertDisposableDb(TARGET, { suite: 'seed-regression-stock.js' });

process.env.DB_PATH = safePath;
const { migrate } = require(path.join(ROOT, 'server', 'database', 'migrate.js'));
const { InventoryService } = require(path.join(ROOT, 'server', 'services', 'inventory.service'));
const { InventoryEngine } = require(path.join(ROOT, 'server', 'services', 'inventory-engine.service'));
const { generateId } = require(path.join(ROOT, 'server', 'utils', 'generateId'));

(async () => {
  const migrated = await migrate();
  const conn = migrated.get();
  const engine = new InventoryEngine(conn);

  const COMPANY = 'default';
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
      user: !!user, uomId: !!uomId, godown: !!godown,
      sales: !!sales, cogs: !!cogs, asset: !!asset,
    });
    process.exit(1);
  }

  const SKU = 'REG-PLAIN-001';
  const existing = conn.get('SELECT id FROM stock_items WHERE company_id = ? AND sku = ?', [COMPANY, SKU]);
  if (existing) {
    console.log(`already seeded: ${SKU} (item ${existing.id})`);
    console.log('  on hand:', engine.getTotalBalance(COMPANY, existing.id));
    try { migrated.close(); } catch (_) {}
    return;
  }

  const productId = generateId('prod');
  const stockItemId = generateId('stoc');
  const now = new Date().toISOString();

  conn.prepare(`INSERT INTO products
      (id, company_id, name, sku, price, cost, is_service, is_active, is_inventory_managed, created_at, updated_at)
      VALUES (?, ?, ?, ?, 150, 100, 0, 1, 1, ?, ?)`)
    .run(productId, COMPANY, 'Regression Plain Widget', SKU, now, now);

  conn.prepare(`INSERT INTO stock_items
      (id, company_id, name, sku, product_id, uom_id, godown_id, location_id,
       cost_price, selling_rate, is_batch_tracked, is_serial_tracked, is_active,
       cogs_account_id, stock_asset_account_id, sales_account_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 100, 150, 0, 0, 1, ?, ?, ?, ?, ?)`)
    .run(stockItemId, COMPANY, 'Regression Plain Widget', SKU, productId, uomId,
      godown.id, godown.location_id, cogs, asset, sales, now, now);

  // Canonical entry: opening_stock voucher -> ledger -> balances.
  const service = new InventoryService(conn);
  const draft = service.createDraftVoucher({
    voucher_type: 'opening_stock',
    voucher_date: new Date().toISOString().slice(0, 10),
    narration: 'Regression seed opening stock',
    source_type: 'REGRESSION_SEED',
    lines: [{
      item_id: stockItemId,
      uom_id: uomId,
      quantity: 100,
      unit_rate: 100,
      source_godown_id: godown.id,
      source_location_id: godown.location_id,
      is_source: 0,
    }],
  }, COMPANY, user);
  const posted = service.postVoucher(draft.voucher_number, COMPANY, user);

  console.log('seeded plain inventory-managed product:');
  console.log('  product  :', productId);
  console.log('  item     :', stockItemId, `(${SKU})`);
  console.log('  voucher  :', posted.voucher_number);
  console.log('  on hand  :', engine.getTotalBalance(COMPANY, stockItemId));
  console.log('  unit cost:', engine.getUnitCost(COMPANY, stockItemId));

  try { migrated.close(); } catch (_) {}
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });