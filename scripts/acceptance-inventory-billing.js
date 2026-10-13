/**
 * Acceptance test for the repaired Inventory + Billing architecture.
 *
 * Runs against a THROWAWAY database so it can freely create bills, post them,
 * cancel them and rebuild balances. The live database is never touched.
 *
 *   node scripts/acceptance-inventory-billing.js
 *
 * The scenario is the mandated one:
 *   Opening stock 100 @ 100  ->  bill 10  ->  post  ->  cancel  ->  rebuild
 * and asserts stock, ledger history, valuation, COGS and idempotency at each step.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bscrm-accept-'));
const dbPath = path.join(tmpDir, 'acceptance.db');

// Build a fresh schema by copying the live DB (schema + masters), then wiping
// all transactional data so counts start from zero and assertions are exact.
const LIVE = path.join(ROOT, 'data', 'blackstack-crm.db');
fs.copyFileSync(LIVE, dbPath);
process.env.DB_PATH = dbPath;

const { DatabaseSync } = require('node:sqlite');
const raw = new DatabaseSync(dbPath);
raw.exec('PRAGMA foreign_keys=ON');

// Wipe transactional data only. Masters (accounts, groups, categories, brands,
// models, locations, godowns, UOM) are preserved so FKs still resolve.
const WIPE = [
  'stock_ledger', 'stock_balances', 'valuation_movements',
  'inventory_voucher_lines', 'inventory_voucher_headers',
  'physical_stock_lines', 'physical_stock_documents',
  'batches', 'item_serials', 'inventory_items',
  'batch_wise_stock',
  'bill_allocations', 'bill_items', 'payments', 'bills',
  'journal_entry_lines', 'journal_entries', 'vouchers',
  'receivables', 'receivable_allocations', 'bill_approvals', 'bill_events',
  'bill_templates', 'recurring_bills', 'customer_bill_audit_log',
  'customer_bill_disputes', 'customer_bill_writeoffs', 'credit_note_lines',
  'debit_note_lines', 'tax_audit_log', 'transaction_tax_details',
];
for (const t of WIPE) {
  try { raw.exec(`DELETE FROM ${t}`); } catch (e) { /* table may not exist */ }
}
// Products/stock_items are reset so the test owns its own inventory.
raw.exec('DELETE FROM product_specifications');
raw.exec('DELETE FROM stock_items');
raw.exec('DELETE FROM products');
raw.close();

const { migrate } = require(path.join(ROOT, 'server', 'database', 'migrate.js'));
const { DatabaseConnection } = require(path.join(ROOT, 'server', 'database', 'connection.js'));

// ── Tiny assertion harness ────────────────────────────────────────────────
let passed = 0, failed = 0;
const results = [];
function check(name, condition, detail) {
  if (condition) { passed++; results.push(`  PASS  ${name}`); }
  else { failed++; results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
  check(name, Object.is(Number(actual), Number(expected)),
    `expected ${expected}, got ${actual}`);
}
function near(name, actual, expected, tol = 0.001) {
  const a = Number(actual), e = Number(expected);
  check(name, Math.abs(a - e) <= tol, `expected ~${e}, got ${a}`);
}

(async () => {
  const migrated = await migrate();
  const conn = migrated.get();

  const { InventoryEngine } = require(path.join(ROOT, 'server', 'services', 'inventory-engine.service'));
  const { InventoryService } = require(path.join(ROOT, 'server', 'services', 'inventory.service'));
  const { CustomerBillService } = require(path.join(ROOT, 'server', 'services', 'customer-bill.service'));
  const { generateId } = require(path.join(ROOT, 'server', 'utils', 'generateId'));

  const COMPANY = 'default';
  // Use the seeded admin user: it carries all 102 permissions, including every
  // inventory.* code the voucher flow asserts against.
  const USER = conn.get(
    `SELECT u.id FROM users u
       JOIN user_roles ur  ON ur.user_id = u.id
       JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE u.id = 'admin' LIMIT 1`)?.id;
  if (!USER) throw new Error('Seeded admin user with roles not found');
  const engine = new InventoryEngine(conn);
  const inventory = new InventoryService(conn);
  const bills = new CustomerBillService(conn);

  // ── Fixtures ────────────────────────────────────────────────────────────
  const uomId = conn.get(
    `SELECT id FROM units_of_measure WHERE company_id = ? AND is_active = 1 LIMIT 1`,
    [COMPANY])?.id;
  if (!uomId) throw new Error('No UOM in fixture database');

  // Pick a godown that actually has a location, then take the location FROM the
  // godown. Deriving them independently would build an inconsistent fixture and
  // trip the godown/location validation the bridge correctly enforces.
  const godownRow = conn.get(
    `SELECT g.id, g.location_id FROM godowns g
       JOIN locations l ON l.id = g.location_id
      WHERE g.company_id = ? AND g.is_active = 1 AND l.is_active = 1
      ORDER BY g.created_at LIMIT 1`, [COMPANY]);
  if (!godownRow) throw new Error('Missing a godown with an active location');
  const godownA = godownRow.id;
  const locationId = godownRow.location_id;
  const godownB = conn.get(
    `SELECT id FROM godowns WHERE company_id = ? AND id != ? ORDER BY created_at LIMIT 1`,
    [COMPANY, godownA])?.id;

  // A second godown lets the transfer test run; fall back to a synthetic one.
  let godownForTransfer = godownB;
  if (!godownForTransfer) {
    godownForTransfer = generateId('godo');
    conn.run(
      `INSERT INTO godowns (id, company_id, name, code, location_id, is_active, created_at, updated_at)
       VALUES (?, ?, 'ACCEPTANCE-GD-2', 'ACC-GD2', ?, 1, datetime('now'), datetime('now'))`,
      [godownForTransfer, COMPANY, locationId]);
  }

  const salesAccount = conn.get(`SELECT id FROM accounts WHERE id = 'acc_sales' AND company_id = ?`, [COMPANY])?.id;
  const cogsAccount = conn.get(`SELECT id FROM accounts WHERE id = 'acc_cogs' AND company_id = ?`, [COMPANY])?.id
    || conn.get(`SELECT id FROM accounts WHERE company_id = ? AND type='EXPENSE' ORDER BY code LIMIT 1`, [COMPANY])?.id;
  const assetAccount = conn.get(`SELECT id FROM accounts WHERE company_id = ? AND type='ASSET' ORDER BY code LIMIT 1`, [COMPANY])?.id;
  if (!salesAccount || !cogsAccount || !assetAccount) {
    throw new Error('Missing account fixtures (sales / cogs / asset)');
  }

  const productId = generateId('prod');
  const stockItemId = generateId('stoc');
  conn.run(
    `INSERT INTO products (id, company_id, name, sku, price, cost, is_service, is_active,
       is_inventory_managed, created_at, updated_at)
     VALUES (?, ?, 'Acceptance Widget', 'ACC-WIDGET-1', 150, 100, 0, 1, 1, datetime('now'), datetime('now'))`,
    [productId, COMPANY]);
  conn.run(
    `INSERT INTO stock_items (id, company_id, name, sku, product_id, uom_id, godown_id, location_id,
       cost_price, selling_rate, is_batch_tracked, is_serial_tracked, is_active,
       cogs_account_id, stock_asset_account_id, sales_account_id, created_at, updated_at)
     VALUES (?, ?, 'Acceptance Widget', 'ACC-WIDGET-1', ?, ?, ?, ?, 100, 150, 0, 0, 1, ?, ?, ?,
       datetime('now'), datetime('now'))`,
    [stockItemId, COMPANY, productId, uomId, godownA, locationId, cogsAccount, assetAccount, salesAccount]);

  // A contact to bill.
  const contactId = conn.get(
    `SELECT id FROM contacts WHERE company_id = ? ORDER BY created_at LIMIT 1`, [COMPANY])?.id;
  if (!contactId) throw new Error('Missing contact fixture');

  // ── Helper: read the canonical balance ─────────────────────────────────
  const bal = () => engine.getTotalBalance(COMPANY, stockItemId);
  const ledgerQty = () => conn.get(
    `SELECT COALESCE(SUM(quantity),0) AS q FROM stock_ledger WHERE item_id = ?`, [stockItemId]).q;
  const balRow = () => conn.get(
    `SELECT COALESCE(SUM(quantity),0) AS q FROM stock_balances WHERE item_id = ?`, [stockItemId]).q;

  console.log('\n' + '='.repeat(70));
  console.log('ACCEPTANCE TEST — Inventory + Billing integration');
  console.log('='.repeat(70));
  console.log(`company=${COMPANY}  item=${stockItemId}  godownA=${godownA}  godownB=${godownForTransfer}`);

  // ═══ 1. Opening stock 100 @ 100 ═══
  const opening = inventory.createDraftVoucher({
    voucher_type: 'opening_stock',
    voucher_date: '2026-01-01',
    narration: 'Acceptance opening stock',
    source_type: 'ACCEPTANCE_TEST',
    lines: [{
      item_id: stockItemId, uom_id: uomId, quantity: 100, unit_rate: 100,
      source_godown_id: godownA, source_location_id: locationId, is_source: 0,
    }],
  }, COMPANY, USER);
  inventory.postVoucher(opening.voucher_number, COMPANY, USER);

  eq('1. stock_ledger total after opening = +100', ledgerQty(), 100);
  eq('1. stock_balances after opening = 100', balRow(), 100);
  eq('1. engine balance after opening = 100', bal(), 100);
  near('1. valuation qty = 100', engine.getTotalBalance(COMPANY, stockItemId), 100);
  near('1. weighted-average cost = 100', engine.getUnitCost(COMPANY, stockItemId), 100);

  // ═══ 2. Draft bill does NOT move stock ═══
  const draftBill = bills.createBill({
    company_id: COMPANY,
    contact_id: contactId,
    bill_type: 'CUSTOMER',
    issue_date: '2026-01-05',
    due_date: '2026-01-05',
    currency: 'INR',
    is_tax_inclusive: 0,
    items: [{
      product_id: productId, description: 'Acceptance Widget', quantity: 10,
      unit_price: 150, discount: 0, tax_rate: 0, uom_id: uomId,
      godown_id: godownA, location_id: locationId,
    }],
  }, USER);
  eq('2. DRAFT bill does not move stock', bal(), 100);
  eq('2. DRAFT bill created with status DRAFT', draftBill.status, 'DRAFT');

  // ═══ 3. Approval does NOT move stock ═══
  bills.submitForApproval(draftBill.id, COMPANY, USER);
  eq('3. after submit-for-approval, stock unchanged', bal(), 100);
  bills.approveBill(draftBill.id, COMPANY, USER);
  eq('3. after approve, stock unchanged', bal(), 100);

  // ═══ 4. POST moves stock exactly once ═══
  const posted = bills.postBill(draftBill.id, COMPANY, USER);
  eq('4. after POST, balance = 90', bal(), 90);
  eq('4. after POST, stock_balances = 90', balRow(), 90);
  eq('4. ledger net = 100 - 10 = 90', ledgerQty(), 90);
  near('4. valuation qty after sale = 90', engine.getTotalBalance(COMPANY, stockItemId), 90);
  near('4. cost released = 10 x 100 = 1000',
    (posted.inventory.valuation[0] || {}).cost_out, 1000);

  const outwardRows = conn.all(
    `SELECT * FROM stock_ledger WHERE item_id = ? AND source_document_type = 'CUSTOMER_BILL'`,
    [stockItemId]);
  eq('4. exactly ONE ledger row for the bill', outwardRows.length, 1);
  near('4. that row is negative (-10)', outwardRows[0].quantity, -10);

  // ═══ 5. Idempotency: a second post must not deduct again ═══
  let secondPostRejected = false;
  try { bills.postBill(draftBill.id, COMPANY, USER); } catch (e) { secondPostRejected = true; }
  check('5. re-posting a posted bill is rejected', secondPostRejected);
  eq('5. stock still 90 after rejected re-post', bal(), 90);

  // Also verify the DB-level guarantee directly.
  let dupeBlocked = false;
  try {
    conn.run(
      `INSERT INTO inventory_voucher_headers (id, company_id, voucher_type, voucher_number,
         voucher_date, source_document_type, source_document_id, status, created_by)
       VALUES (?, ?, 'stock_outward', 'DUPE-TEST', '2026-01-05', 'CUSTOMER_BILL', ?, 'draft', ?)`,
      [generateId('ivh'), COMPANY, draftBill.id, USER]);
  } catch (e) { dupeBlocked = /UNIQUE/i.test(e.message); }
  check('5. database unique index blocks a second stock-out for one bill', dupeBlocked);

  // ═══ 6. Payment does NOT deduct again ═══
  const bankAccount = conn.get(
    `SELECT id FROM accounts WHERE id = 'acc_cash' AND company_id = ?`, [COMPANY])?.id
    || conn.get(`SELECT id FROM accounts WHERE company_id = ? AND type='ASSET' ORDER BY code LIMIT 1`, [COMPANY])?.id;

  bills.recordPayment({
    bill_id: draftBill.id, amount: 500, payment_method: 'CASH', payment_account_id: bankAccount,
    payment_date: '2026-01-06', company_id: COMPANY,
  }, USER);
  eq('6. after partial payment, stock still 90', bal(), 90);

  bills.recordPayment({
    bill_id: draftBill.id, amount: 1000, payment_method: 'CASH', payment_account_id: bankAccount,
    payment_date: '2026-01-07', company_id: COMPANY,
  }, USER);
  eq('6. after full payment, stock still 90', bal(), 90);

  // ═══ 7. Insufficient stock is rejected, bill stays unposted ═══
  const bigBill = bills.createBill({
    company_id: COMPANY, contact_id: contactId, bill_type: 'CUSTOMER',
    issue_date: '2026-01-08', due_date: '2026-01-08', currency: 'INR',
    items: [{
      product_id: productId, description: 'Too many', quantity: 5000,
      unit_price: 150, discount: 0, tax_rate: 0, uom_id: uomId,
      godown_id: godownA, location_id: locationId,
    }],
  }, USER);
  bills.submitForApproval(bigBill.id, COMPANY, USER);
  bills.approveBill(bigBill.id, COMPANY, USER);
  let rejected = null;
  try { bills.postBill(bigBill.id, COMPANY, USER); } catch (e) { rejected = e.message; }
  check('7. posting an over-quantity bill is rejected', rejected !== null, String(rejected));
  // The SKU identifies the stock item; the description is whatever the line said.
  check('7. rejection identifies the stock item by SKU', /ACC-WIDGET-1/.test(rejected || ''), rejected);
  const bigStatus = conn.get(`SELECT status FROM bills WHERE id = ?`, [bigBill.id]).status;
  check('7. rejected bill is NOT posted', bigStatus === 'APPROVED', `status=${bigStatus}`);
  eq('7. stock unchanged after rejection', bal(), 90);

  // ═══ 8. Stock transfer conserves company total ═══
  const before = bal();
  const transfer = inventory.createDraftVoucher({
    voucher_type: 'stock_transfer',
    voucher_date: '2026-01-09',
    narration: 'Acceptance transfer',
    lines: [{
      item_id: stockItemId, uom_id: uomId, quantity: 20, unit_rate: 100,
      source_godown_id: godownA, source_location_id: locationId,
      dest_godown_id: godownForTransfer, dest_location_id: locationId, is_source: 1,
    }],
  }, COMPANY, USER);
  inventory.postVoucher(transfer.voucher_number, COMPANY, USER);
  eq('8. company total conserved by transfer', bal(), before);
  eq('8. source godown = 70', engine.getBalance(COMPANY, stockItemId, { godownId: godownA }).quantity, 70);
  eq('8. destination godown = 20', engine.getBalance(COMPANY, stockItemId, { godownId: godownForTransfer }).quantity, 20);

  // ═══ 9. Cancelling the bill restores stock, ledger keeps history ═══
  const beforeCancel = bal();
  bills.cancelBill(draftBill.id, COMPANY, USER, 'Acceptance reversal');
  eq('9. after cancel, balance restored', bal(), beforeCancel + 10);
  eq('9. stock_balances restored', balRow(), beforeCancel + 10);

  const billRows = conn.all(
    `SELECT quantity, source_document_type FROM stock_ledger
      WHERE item_id = ? AND source_document_type LIKE 'CUSTOMER_BILL%' ORDER BY posting_time`,
    [stockItemId]);
  eq('9. ledger has 2 bill-related rows (out + reversal)', billRows.length, 2);
  near('9. original -10 still present (not deleted)', billRows[0].quantity, -10);
  near('9. reversal +10 appended', billRows[1].quantity, 10);

  // ═══ 10. Repeated cancellation must not reverse twice ═══
  let reCancelRejected = false;
  try { bills.cancelBill(draftBill.id, COMPANY, USER, 'again'); } catch (e) { reCancelRejected = true; }
  check('10. second cancel is rejected', reCancelRejected);
  eq('10. stock unchanged after rejected re-cancel', bal(), beforeCancel + 10);

  // ═══ 11. Rebuild preserves everything ═══
  const preRebuild = bal();
  const preLedger = ledgerQty();
  inventory.repo.rebuildStockBalances(COMPANY);
  eq('11. rebuild preserves ledger total', ledgerQty(), preLedger);
  eq('11. rebuild preserves balance', balRow(), preRebuild);
  engine.rebuildBalances(COMPANY);
  eq('11. engine rebuild preserves balance', balRow(), preRebuild);
  eq('11. balances still reproducible from ledger', bal(), preRebuild);

  // ═══ 12. Reports read the canonical source ═══
  const valuation = inventory.getValuationReport(COMPANY, { limit: 500 });
  const valRow = valuation.items.find((r) => r.id === stockItemId);
  check('12. valuation report includes the item', !!valRow);
  // Read the balance now: a transfer splits an item across godowns, and the
  // report must still show the item's TOTAL, not one godown's share.
  if (valRow) near('12. valuation report total matches the ledger', valRow.quantity, bal());

  const godownReport = inventory.getGodownStockReport(COMPANY);
  const summed = godownReport.items.reduce((s, r) => s + (parseFloat(r.total_quantity) || 0), 0);
  near('12. godown-wise report total matches the ledger', summed, preRebuild, 0.01);

  // ═══ 13. Weighted average across two inward rates ═══
  const inward2 = inventory.createDraftVoucher({
    voucher_type: 'stock_inward',
    voucher_date: '2026-01-10',
    lines: [{
      item_id: stockItemId, uom_id: uomId, quantity: 100, unit_rate: 200,
      source_godown_id: godownA, source_location_id: locationId, is_source: 0,
    }],
  }, COMPANY, USER);
  inventory.postVoucher(inward2.voucher_number, COMPANY, USER);
  // (90 + 100) @ blend of 100 and 200 => (90*100 + 100*200) / 190
  const qtyBeforeInward = engine.getTotalBalance(COMPANY, stockItemId) - 100;
  near('13. weighted average after second inward',
    engine.getUnitCost(COMPANY, stockItemId),
    (qtyBeforeInward * 100 + 100 * 200) / (qtyBeforeInward + 100), 0.01);

  // ═══ 14. Valuation audit trail exists ═══
  const vmov = conn.get(
    `SELECT COUNT(*) AS n FROM valuation_movements WHERE item_id = ?`, [stockItemId]).n;
  check('14. every cost change is recorded in valuation_movements', vmov >= 3, `rows=${vmov}`);

  // ═══ 15. Global integrity ═══
  const fkc = conn.prepare('PRAGMA foreign_key_check').all();
  eq('15. foreign_key_check clean', fkc.length, 0);

  const orphan = conn.get(`
    SELECT COUNT(*) AS n FROM stock_balances sb
     WHERE NOT EXISTS (
       SELECT 1 FROM (SELECT company_id,item_id,batch_id,godown_id,location_id,SUM(quantity) q
                        FROM stock_ledger GROUP BY company_id,item_id,batch_id,godown_id,location_id) lg
        WHERE lg.company_id=sb.company_id AND lg.item_id=sb.item_id
          AND lg.batch_id IS sb.batch_id AND lg.godown_id=sb.godown_id
          AND lg.location_id IS sb.location_id AND lg.q != 0
     ) AND sb.quantity != 0`).n;
  eq('15. no balance row lacks ledger backing', orphan, 0);

  // Manually-created vouchers are attributable to their own voucher, not to a
  // source document, so a NULL source_document_id is legitimate for them. The
  // invariant that matters is that rows written by the BILL bridge always carry
  // their originating bill.
  const billRowsWithoutSource = conn.get(
    `SELECT COUNT(*) AS n FROM stock_ledger
      WHERE source_document_type LIKE 'CUSTOMER_BILL%' AND source_document_id IS NULL`).n;
  check('15. every bill-originated ledger row names its bill',
    billRowsWithoutSource === 0, `rows without source=${billRowsWithoutSource}`);

  const unattributed = conn.get(
    `SELECT COUNT(*) AS n FROM stock_ledger WHERE created_by IS NULL`).n;
  check('15. every ledger row records the acting user',
    unattributed === 0, `rows without actor=${unattributed}`);

  // ── Report ──────────────────────────────────────────────────────────────
  console.log('\n' + '-'.repeat(70));
  results.forEach((r) => console.log(r));
  console.log('-'.repeat(70));
  console.log(`\nPASS: ${passed}   FAIL: ${failed}`);
  console.log('='.repeat(70) + '\n');

  try { migrated.close(); } catch (_) {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nACCEPTANCE TEST ERROR:', err.stack || err.message);
  console.error(`\nPASS: ${passed}   FAIL: ${failed + 1}`);
  process.exit(1);
});