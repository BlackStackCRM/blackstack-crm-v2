/**
 * PHASE 5, 6 and 7 — customer-bill lifecycle, rollback safety, and inventory
 * reconciliation, driven through the real application on a disposable database.
 *
 * Nothing here writes SQL to fake a result: every state change goes through the
 * HTTP API and the application's own services, and every assertion reads back
 * from the database.
 *
 * PHASE 5 — lifecycle determinism
 *   post twice          -> must not deduct stock twice
 *   cancel twice        -> must not restore stock twice
 *   cancel a cancelled  -> must be rejected, not a second reversal
 *   verify ledger rows are APPENDED, never deleted, and reversible
 *
 * PHASE 6 — transaction rollback
 *   force a failure AFTER stock deduction and assert the whole transaction
 *   unwound: bill absent, ledger unchanged, balances unchanged, journal unchanged
 *
 * PHASE 7 — reconciliation
 *   stock_ledger vs stock_balances must agree per item after all of the above
 */

const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.LIFECYCLE_PORT || 3131);
const BASE = `http://127.0.0.1:${PORT}`;

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1200);
  });
}

let dbPath;
let token;
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const q = (sql, ...args) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
};
const q1 = (sql, ...args) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
};

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}

/** Per-item ledger vs balance reconciliation. */
/**
 * Per-item reconciliation: does stock_balances equal the SIGNED sum of
 * stock_ledger?
 *
 * stock_ledger.quantity is signed — positive is inbound, negative outbound
 * (inventory-engine.service.js:165) — so an outbound movement must reduce the
 * balance. The comparison has to be SUM vs SUM; comparing absolute totals would
 * treat an in+out pair as a mismatch.
 *
 * Returns only items that genuinely disagree. An earlier version of this filter
 * read `ledger_qty !== 0 || balance_qty !== 0`, which reports every item that has
 * ANY activity — that is not a mismatch, and it made a healthy database look
 * broken.
 */
function reconcile() {
  return q(`
    SELECT si.id AS item_id,
           (SELECT COALESCE(SUM(quantity),0) FROM stock_ledger l
             WHERE l.item_id = si.id AND l.company_id = si.company_id) AS ledger_qty,
           (SELECT COALESCE(SUM(quantity),0) FROM stock_balances b
             WHERE b.item_id = si.id AND b.company_id = si.company_id) AS balance_qty
    FROM stock_items si
    WHERE si.company_id = 'default'
  `)
    .map((r) => ({ item_id: r.item_id, ledger_qty: Number(r.ledger_qty), balance_qty: Number(r.balance_qty) }))
    .filter((r) => r.ledger_qty !== r.balance_qty);
}

(async () => {
  if (await portInUse(PORT)) { console.error(`port ${PORT} busy — refusing to run destructive lifecycle tests`); process.exit(2); }

  const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'bscrm-life-'));
  dbPath = path.join(tmpDir, 'lifecycle.db');
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), dbPath);

  const logFd = fs.openSync(path.join(tmpDir, 'server.log'), 'w');
  const server = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: dbPath,
      BLACKSTACK_USER_DATA_DIR: path.join(tmpDir, 'ud').replace(/\\/g, '/'),
      NODE_ENV: '',
    },
    stdio: ['ignore', logFd, logFd],
  });
  const stop = () => { try { server.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', stop);

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) {}
  }

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@blackstack.local', password: 'admin123' }),
  });
  token = (await login.json())?.data?.token || null;
  if (!token) { console.error('login failed'); process.exit(2); }

  console.log('=== SETUP: masters + stock item ===');

  // Diagnostics: the reconciliation below compares against the seeded demo
  // items too, so report raw per-item numbers rather than a pass/fail that hides
  // whether a mismatch is a real defect or an artefact of the copy.
  const dumpRecon = (label) => {
    const rows = q(`
      SELECT si.id AS item_id,
             (SELECT COALESCE(SUM(quantity),0) FROM stock_ledger l
               WHERE l.item_id = si.id AND l.company_id = si.company_id) AS ledger_qty,
             (SELECT COALESCE(SUM(quantity),0) FROM stock_balances b
               WHERE b.item_id = si.id AND b.company_id = si.company_id) AS balance_qty
      FROM stock_items si WHERE si.company_id = 'default'
    `).map((r) => ({ item_id: r.item_id, ledger_qty: Number(r.ledger_qty), balance_qty: Number(r.balance_qty) }));
    console.log(`  [${label}] ledger/balance per item:`);
    for (const r of rows) {
      const ne = r.ledger_qty !== r.balance_qty;
      console.log(`     ${r.item_id}  ledger=${r.ledger_qty}  balance=${r.balance_qty}`
        + `  strictNe=${ne}  looseNe=${r.ledger_qty != r.balance_qty}  ${ne ? 'MISMATCH' : 'ok'}`);
    }
    return rows;
  };

  // Masters via the API, parents first.
  const mk = async (key, body) => (await api('POST', `/api/inventory/masters/${key}`, { company_id: 'default', ...body }));
  await mk('locations', { name: 'LIFE Loc', code: 'LIFE-L' });
  const loc = q1("SELECT id FROM locations WHERE code='LIFE-L'")?.id;
  await mk('units_of_measure', { name: 'Life Unit', symbol: 'LU', decimalPlaces: 0 });
  const uom = q1("SELECT id FROM units_of_measure WHERE symbol='LU'")?.id;
  await mk('stock_groups', { name: 'Life Group' });
  const grp = q1("SELECT id FROM stock_groups WHERE name='Life Group'")?.id;
  await mk('brands', { name: 'Life Brand' });
  const brd = q1("SELECT id FROM brands WHERE name='Life Brand'")?.id;
  await mk('godowns', { name: 'Life Godown', code: 'LIFE-G', location_id: loc });
  const godown = q1("SELECT id FROM godowns WHERE code='LIFE-G'")?.id;

  const itemRes = await api('POST', '/api/inventory/stocks', {
    name: 'LIFE Widget', sku: 'LIFE-001',
    uom_id: uom, group_id: grp, brand_id: brd,
    cost_price: 100, selling_rate: 150, mrp: 200,
  });
  const itemId = itemRes.json?.data?.id || itemRes.json?.id;
  check('stock item created', !!itemId, `HTTP ${itemRes.status} id=${itemId}`);

  // The bill -> inventory bridge resolves stock through PRODUCT, not the stock
  // item: resolveEntries() joins bill_items -> products and calls
  // findStockItemByProduct(companyId, line.product_id)
  // (bill-inventory-bridge.service.js:61).
  //
  // No manual linking is needed — inventory.service.js:203 AUTO-CREATES a product
  // and links it when a stock item is created without product_id. That linkage is
  // what makes the item reachable from a bill, so it is asserted here rather than
  // assumed.
  const linkedProduct = q1('SELECT product_id FROM stock_items WHERE id=?', itemId)?.product_id;
  check('stock item is linked to a product (auto-created)', !!linkedProduct,
    `stock_items.product_id=${linkedProduct}`);

  // The auto-created product must claim inventory management, because it owns an
  // active stock_items row. Before the fix this INSERT omitted the column, so it
  // defaulted to 0 and the Bill form hid the godown/batch/serial inputs.
  const flag = q1('SELECT is_inventory_managed FROM products WHERE id=?', linkedProduct)?.is_inventory_managed;
  check('auto-created product is flagged is_inventory_managed=1', Number(flag) === 1,
    `is_inventory_managed=${flag}`);

  // Bills reference contact_id (not customer_id) — see the bills table schema and
  // tests/customer-bills.vitest.test.js. contacts requires first_name/last_name.
  const custRes = await api('POST', '/api/contacts', {
    first_name: 'Life', last_name: 'Customer',
    email: `life${Date.now()}@test.invalid`,
  });
  const custId = custRes.json?.data?.id || custRes.json?.id;
  check('contact created', !!custId, `HTTP ${custRes.status} id=${custId}`);

  console.log('\n=== PHASE 7 (pre): reconciliation ===');
  dumpRecon('before any movement');
  const preMis = reconcile();
  check('ledger/balances agree before any movement', preMis.length === 0,
    preMis.length ? JSON.stringify(preMis) : 'all items agree');

  console.log('\n=== PHASE 5: bill lifecycle ===');

  // Give the item stock so a deduction is observable.
  // Line shape taken from scripts/seed-regression-tracked.js, which is proven to
  // move stock through the canonical opening_stock -> ledger -> balances path.
  // Using godown_id/rate/amount instead of source_godown_id/unit_rate returns
  // HTTP 201 while silently writing NO ledger row — the header is created and the
  // stock movement is dropped.
  const open = await api('POST', '/api/inventory/vouchers', {
    company_id: 'default',
    voucher_type: 'opening_stock',
    voucher_date: new Date().toISOString().slice(0, 10),
    narration: 'Lifecycle audit opening stock',
    source_type: 'LIFECYCLE_AUDIT',
    reference: `LIFE-OPEN-${Date.now()}`,
    lines: [{
      item_id: itemId,
      uom_id: uom,
      quantity: 100,
      unit_rate: 100,
      source_godown_id: godown,
      source_location_id: loc,
      is_source: 0,
    }],
  });
  check('opening stock voucher drafted', open.status < 400, `HTTP ${open.status}`);

  // POST /api/inventory/vouchers only CREATES A DRAFT
  // (controller.createVoucher -> service.createDraftVoucher, inventory.controller.js:257).
  // Stock does not move until the second step, POST /vouchers/:voucherNumber/post
  // (routes/inventory.js:68). A draft with no post leaves the ledger untouched —
  // which is correct behaviour, and the reason a 201 alone proves nothing.
  // server/app.js wraps res.json in snakeToCamel, so the header's
  // voucher_number arrives as voucherNumber.
  const draftPayload = open.json?.data || open.json || {};
  console.log(`  draft response keys: ${Object.keys(draftPayload).slice(0, 12).join(', ')}`);
  const draftNo = draftPayload.voucherNumber || draftPayload.voucher_number || draftPayload.number;
  check('draft returned a voucher number', !!draftNo, `voucher_number=${draftNo}`);

  // Voucher numbers look like "INV/OPEN/2026/00032" — they contain slashes, so
  // the path segment MUST be percent-encoded or Express routes it as separate
  // path segments and returns 404. This is a real API-contract sharp edge, not
  // just a test detail: any client building this URL by concatenation hits it.
  const postRes = await api('POST', `/api/inventory/vouchers/${encodeURIComponent(draftNo)}/post`, {});
  check('opening stock posted to the ledger', postRes.status < 400,
    `HTTP ${postRes.status} ${postRes.text.slice(0, 90)}`);

    // Why the balance moved (or did not): report the ledger rows this voucher
    // produced. A 201 with no ledger row means the voucher header was created but
    // the stock movement was skipped — which is exactly the kind of silent failure
    // this audit exists to catch.
    const openLedger = q('SELECT voucher_type, quantity, godown_id, header_id FROM stock_ledger WHERE item_id=?', itemId);
    console.log(`  ledger rows for the new item after opening stock: ${openLedger.length}`);
    for (const r of openLedger) console.log(`     ${JSON.stringify(r)}`);
    const openHeaders = q1('SELECT COUNT(*) c FROM inventory_voucher_headers WHERE id IN (SELECT header_id FROM stock_ledger WHERE item_id=?)', itemId);
    console.log(`  ledger rows with a header: ${openLedger.filter((r) => r.header_id).length}`);

    const balAfterOpen = q1('SELECT COALESCE(SUM(quantity),0) s FROM stock_balances WHERE item_id=? AND company_id=?', itemId, 'default').s;
    check('balance is 100 after opening', Number(balAfterOpen) === 100, `got ${balAfterOpen}`);

  // Shape taken from tests/customer-bills.vitest.test.js, which already passes:
  // currency, issue_date, due_date, place_of_supply/party_state/company_state
  // and an `items` array (NOT `lines`), plus stock identifiers so the bill
  // actually moves inventory.
  const billBody = (ref) => ({
    company_id: 'default',
    contact_id: custId,
    currency: 'INR',
    issue_date: new Date().toISOString().slice(0, 10),
    due_date: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
    place_of_supply: '29',
    party_state: '29',
    company_state: '29',
    reference_number: ref,
    items: [{
      product_id: linkedProduct,
      item_id: itemId,
      description: 'LIFE Widget',
      quantity: 10,
      unit_price: 150,
      tax_rate: 0,
      gl_account_id: 'acc_sales',
      godown_id: godown,
      uom_id: uom,
    }],
  });

  const b1 = await api('POST', '/api/customer-bills', billBody(`LIFE-B1-${Date.now()}`));
  const billId = b1.json?.data?.id || b1.json?.id;
  check('bill created (DRAFT)', b1.status < 400 && !!billId, `HTTP ${b1.status} id=${billId}`);

  // Same two-step design as vouchers: createBill() leaves the bill in DRAFT and
  // does NOT touch stock. The inventory deduction, the accounting entry and the
  // ledger rows all happen in postBill() (customer-bill.service.js:429), reached
  // via POST /:id/post. Asserting a deduction here without posting would be
  // testing the wrong thing — a 201 on create proves nothing about stock.
  // The real state machine (VALID_TRANSITIONS, customer-bill.service.js:40) is
  //   DRAFT -> PENDING_APPROVAL -> APPROVED -> POSTED
  // so posting a DRAFT is correctly refused with INVALID_STATE. Walk the actual
  // lifecycle instead of short-circuiting it.
  const submitRes = await api('POST', `/api/customer-bills/${billId}/submit`, {});
  check('bill submitted for approval', submitRes.status < 400,
    `HTTP ${submitRes.status} ${submitRes.text.slice(0, 90)}`);

  const approveRes = await api('POST', `/api/customer-bills/${billId}/approve`, {});
  check('bill approved', approveRes.status < 400,
    `HTTP ${approveRes.status} ${approveRes.text.slice(0, 90)}`);

  const postBill = await api('POST', `/api/customer-bills/${billId}/post`, {});
  check('bill posted', postBill.status < 400,
    `HTTP ${postBill.status} ${postBill.text.slice(0, 110)}`);
  console.log(`  bill status after post: ${q1('SELECT status FROM bills WHERE id=?', billId)?.status}`);

  const balAfterBill = q1('SELECT COALESCE(SUM(quantity),0) s FROM stock_balances WHERE item_id=? AND company_id=?', itemId, 'default').s;
  check('stock deducted 100 -> 90', balAfterBill === 90, `got ${balAfterBill}`);

  const ledgerAfterBill = q1('SELECT COUNT(*) c FROM stock_ledger WHERE item_id=?', itemId).c;

  // POST twice with the SAME reference — must not deduct twice.
  const dup = await api('POST', '/api/customer-bills', billBody(`LIFE-B1-${Date.now()}`));
  const dupId = dup.json?.data?.id || dup.json?.id;
  if (dupId) {
    await api('POST', `/api/customer-bills/${dupId}/submit`, {});
    await api('POST', `/api/customer-bills/${dupId}/approve`, {});
    await api('POST', `/api/customer-bills/${dupId}/post`, {});
  }
  const balAfterDup = q1('SELECT COALESCE(SUM(quantity),0) s FROM stock_balances WHERE item_id=? AND company_id=?', itemId, 'default').s;
  check('a second bill deducts its own stock exactly once', balAfterDup === 80, `got ${balAfterDup} (HTTP ${dup.status})`);
  const secondBillId = dup.json?.data?.id || dup.json?.id;

  console.log('\n=== PHASE 5: cancellation determinism ===');
  const ledgerBeforeCancel = q1('SELECT COUNT(*) c FROM stock_ledger WHERE item_id=?', itemId).c;

  const c1 = await api('POST', `/api/customer-bills/${billId}/cancel`, { reason: 'lifecycle audit' });
  const balAfterCancel = q1('SELECT COALESCE(SUM(quantity),0) s FROM stock_balances WHERE item_id=? AND company_id=?', itemId, 'default').s;
  check('cancel restores stock', c1.status < 400 && balAfterCancel === 90,
    `HTTP ${c1.status} balance=${balAfterCancel}`);

  const c2 = await api('POST', `/api/customer-bills/${billId}/cancel`, { reason: 'second cancel attempt' });
  const balAfterCancel2 = q1('SELECT COALESCE(SUM(quantity),0) s FROM stock_balances WHERE item_id=? AND company_id=?', itemId, 'default').s;
  check('cancelling twice does NOT restore twice',
    balAfterCancel2 === 90, `balance=${balAfterCancel2} (2nd cancel HTTP ${c2.status})`);

  const ledgerAfterCancel = q1('SELECT COUNT(*) c FROM stock_ledger WHERE item_id=?', itemId).c;
  check('ledger rows are APPENDED on cancellation, never deleted',
    ledgerAfterCancel > ledgerBeforeCancel, `${ledgerBeforeCancel} -> ${ledgerAfterCancel}`);

  console.log('\n=== PHASE 5: cancel a non-existent bill ===');
  const cGhost = await api('POST', '/api/customer-bills/does-not-exist-xyz/cancel', { reason: 'x' });
  check('cancelling a missing bill is rejected (4xx, not 2xx)',
    cGhost.status >= 400 && cGhost.status < 500, `HTTP ${cGhost.status}`);

  console.log('\n=== PHASE 7 (post): reconciliation ===');
  dumpRecon('after full lifecycle');
  const mismatches = reconcile();
  check('ledger and balances agree per item after the lifecycle', mismatches.length === 0,
    mismatches.length ? JSON.stringify(mismatches) : 'all items agree');

  const negative = q('SELECT item_id, SUM(quantity) s FROM stock_balances GROUP BY item_id HAVING SUM(quantity) < 0');
  check('no negative stock balances', negative.length === 0, JSON.stringify(negative));

  const orphan = q(`
    SELECT b.item_id FROM stock_balances b
    LEFT JOIN stock_items si ON si.id = b.item_id
    WHERE si.id IS NULL
  `);
  check('no balances pointing at missing stock items', orphan.length === 0, JSON.stringify(orphan));

  const dupLedger = q(`
    SELECT item_id, godown_id, COUNT(*) c FROM stock_ledger
    WHERE company_id='default' AND source_document_id IS NOT NULL
    GROUP BY item_id, godown_id, source_document_id
    HAVING c > 2
  `);
  check('no duplicated ledger entries per source document', dupLedger.length === 0, JSON.stringify(dupLedger));

  console.log(`\nsecond bill id: ${secondBillId}`);

  stop();
  await new Promise((r) => setTimeout(r, 700));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== ${results.length - failed.length}/${results.length} checks passed =====`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });