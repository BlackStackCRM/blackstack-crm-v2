/**
 * PHASE 5 + 7 regression — customer-bill lifecycle determinism and inventory
 * reconciliation, end to end through the real HTTP API.
 *
 * What this protects, and what it cost to learn:
 *
 *  - A bill is NOT deducted at creation. createBill() leaves it DRAFT; the
 *    inventory movement, the accounting entry and the ledger rows all happen in
 *    postBill(). A 201 on create proves nothing about stock.
 *  - A bill cannot be posted from DRAFT. VALID_TRANSITIONS requires
 *    DRAFT -> PENDING_APPROVAL -> APPROVED -> POSTED, so the audit walks the real
 *    lifecycle instead of short-circuiting it.
 *  - The bill -> inventory bridge resolves stock through PRODUCT, via
 *    findStockItemByProduct(); a stock item is only reachable once its product
 *    link exists. createStockItem() auto-creates that product.
 *  - stock_ledger.quantity is SIGNED (negative = outbound), so reconciliation
 *    compares SUM(ledger) to SUM(balances), never absolute totals.
 *
 * Every state change goes through the application; nothing is written with SQL to
 * make an assertion pass. Runs on a disposable database copy.
 */
import path from 'path';
import fs from 'fs';
import net from 'net';
import { spawn } from 'child_process';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.BILL_LIFECYCLE_PORT || 3141);
const BASE = `http://127.0.0.1:${PORT}`;

let dbPath;
let token;
let server = null;
let tmpDir = null;

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1200);
  });
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

/** Balance must equal the SIGNED sum of the ledger for that item. */
function reconcileMismatches() {
  return q(`
    SELECT si.id AS item_id,
           (SELECT COALESCE(SUM(quantity),0) FROM stock_ledger l
             WHERE l.item_id = si.id AND l.company_id = si.company_id) AS ledger_qty,
           (SELECT COALESCE(SUM(quantity),0) FROM stock_balances b
             WHERE b.item_id = si.id AND b.company_id = si.company_id) AS balance_qty
    FROM stock_items si WHERE si.company_id = 'default'
  `)
    .map((r) => ({ item_id: r.item_id, ledger_qty: Number(r.ledger_qty), balance_qty: Number(r.balance_qty) }))
    .filter((r) => r.ledger_qty !== r.balance_qty);
}

// Fixture handles filled during setup.
let itemId, uom, grp, brd, godown, loc, custId, linkedProduct;

beforeAll(async () => {
  expect(await portInUse(PORT)).toBe(false);

  tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'bill-life-'));
  dbPath = path.join(tmpDir, 'lifecycle.db');
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), dbPath);
  for (const sidecar of ['-wal', '-shm']) {
    const src = path.join(ROOT, 'data', 'blackstack-crm.db' + sidecar);
    if (fs.existsSync(src)) fs.copyFileSync(src, dbPath + sidecar);
  }
  require_(path.join(ROOT, 'tests/helpers/reset-cloned-test-admin.js'))(dbPath);
  // The checked-in database clone may have had its chart of accounts removed;
  // restore deterministic accounting masters on this disposable test copy.
  {
    const seed = new DatabaseSync(dbPath);
    seed.exec(fs.readFileSync(path.join(ROOT, 'server/database/migrations/023_seed_chart_of_accounts.sql'), 'utf8'));
    seed.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    seed.close();
  }

  // PHASE 3A — FINANCIAL YEAR: make this suite INDEPENDENT of production's
  // financial-year state.
  //
  // This test used to inherit whatever `financial_years` rows production
  // happened to carry. After the 2026-10-09 audit incident both production
  // years read is_locked=1, and this suite then failed with
  // "Financial year is locked" — a change in PRODUCTION state silently altering
  // a TEST result. The suite must state its own precondition instead.
  //
  // Unlocked here is a TEST FIXTURE decision, not a production one: this suite
  // asserts posting behaviour, and posting into a locked year is a different
  // behaviour covered by the financial-year lock tests.
  {
    const { DatabaseSync } = require('node:sqlite');
    const seed = new DatabaseSync(dbPath);
    // NOTE: raw node:sqlite `run()` takes SPREAD args, not an array. Passing
    // `['default']` binds it as a named parameter and raises
    // "Unknown named parameter '0'" — the UPDATE then never runs.
    seed.prepare('UPDATE financial_years SET is_locked = 0 WHERE company_id = ?').run('default');
    seed.exec(`UPDATE financial_years SET is_active = CASE
      WHEN start_date <= date('now') AND end_date >= date('now') THEN 1 ELSE 0 END
      WHERE company_id = 'default'`);
    const rows = seed.prepare('SELECT id, start_date, end_date, is_active, is_locked FROM financial_years ORDER BY start_date').all();
    seed.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    seed.close();
    const lockedLeft = rows.filter((r) => r.is_locked === 1).length;
    expect(lockedLeft, `disposable DB still has ${lockedLeft} locked year(s)`).toBe(0);
    const active = rows.filter((r) => r.is_active === 1);
    expect(active.length, 'disposable DB needs exactly one active financial year').toBe(1);
    // The active year must actually contain today, or posting would fail the
    // separate date-range check for a reason unrelated to what this suite tests.
    const today = new Date().toISOString().slice(0, 10);
    expect(today >= active[0].start_date && today <= active[0].end_date,
      `active year ${active[0].id} (${active[0].start_date}..${active[0].end_date}) does not contain ${today}`)
      .toBe(true);
  }

  const logFd = fs.openSync(path.join(tmpDir, 'server.log'), 'w');
  server = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: dbPath,
      BLACKSTACK_USER_DATA_DIR: path.join(tmpDir, 'ud').replace(/\\/g, '/'),
      // Empty string models a packaged build, where no .env ships — keeps error
      // bodies free of stack traces so assertions stay on business behaviour.
      NODE_ENV: '',
    },
    stdio: ['ignore', logFd, logFd],
  });
  process.on('exit', () => { try { server.kill('SIGKILL'); } catch (_) {} });

  let up = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch (_) {}
  }
  expect(up, 'server did not become ready').toBe(true);

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@blackstack.local', password: 'admin123' }),
  });
  token = (await login.json())?.data?.token;
  expect(token, 'admin login failed').toBeTruthy();

  // Masters, parents first.
  const mk = (key, body) => api('POST', `/api/inventory/masters/${key}`, { company_id: 'default', ...body });
  await mk('locations', { name: 'BL Loc', code: 'BL-L' });
  loc = q1("SELECT id FROM locations WHERE code='BL-L'")?.id;
  await mk('units_of_measure', { name: 'BL Unit', symbol: 'BLU', decimalPlaces: 0 });
  uom = q1("SELECT id FROM units_of_measure WHERE symbol='BLU'")?.id;
  await mk('stock_groups', { name: 'BL Group' });
  grp = q1("SELECT id FROM stock_groups WHERE name='BL Group'")?.id;
  await mk('brands', { name: 'BL Brand' });
  brd = q1("SELECT id FROM brands WHERE name='BL Brand'")?.id;
  await mk('godowns', { name: 'BL Godown', code: 'BL-G', location_id: loc });
  godown = q1("SELECT id FROM godowns WHERE code='BL-G'")?.id;

  const itemRes = await api('POST', '/api/inventory/stocks', {
    name: 'BL Widget', sku: 'BL-001', uom_id: uom, group_id: grp, brand_id: brd,
    cost_price: 100, selling_rate: 150, mrp: 200,
  });
  itemId = itemRes.json?.data?.id || itemRes.json?.id;
  linkedProduct = q1('SELECT product_id FROM stock_items WHERE id=?', itemId)?.product_id;

  const custRes = await api('POST', '/api/contacts', {
    first_name: 'BL', last_name: 'Customer', email: `bl${Date.now()}@test.invalid`,
  });
  custId = custRes.json?.data?.id || custRes.json?.id;
}, 120000);

afterAll(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch (_) {} }
  await new Promise((r) => setTimeout(r, 600));
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} }
});

const balance = () => Number(
  q1('SELECT COALESCE(SUM(quantity),0) s FROM stock_balances WHERE item_id=? AND company_id=?', itemId, 'default').s,
);
const ledgerCount = () => q1('SELECT COUNT(*) c FROM stock_ledger WHERE item_id=?', itemId).c;

/** Post an opening-stock voucher: draft, then post. Line shape per the canonical seeder. */
async function openStock(qty) {
  const draft = await api('POST', '/api/inventory/vouchers', {
    company_id: 'default',
    voucher_type: 'opening_stock',
    voucher_date: new Date().toISOString().slice(0, 10),
    narration: 'lifecycle test opening stock',
    source_type: 'BILL_LIFECYCLE_TEST',
    lines: [{
      item_id: itemId, uom_id: uom, quantity: qty, unit_rate: 100,
      source_godown_id: godown, source_location_id: loc, is_source: 0,
    }],
  });
  const payload = draft.json?.data || draft.json || {};
  // Voucher numbers look like "INV/OPEN/2026/00032" — the slashes MUST be
  // percent-encoded or Express treats them as path separators and returns 404.
  const no = payload.voucherNumber || payload.voucher_number;
  expect(no, `draft returned no voucher number: ${draft.text.slice(0, 120)}`).toBeTruthy();
  return api('POST', `/api/inventory/vouchers/${encodeURIComponent(no)}/post`, {});
}

/** Walk the real state machine: DRAFT -> PENDING_APPROVAL -> APPROVED -> POSTED. */
async function createAndPostBill(ref, qty) {
  const draft = await api('POST', '/api/customer-bills', {
    company_id: 'default',
    contact_id: custId,
    currency: 'INR',
    issue_date: new Date().toISOString().slice(0, 10),
    due_date: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
    place_of_supply: '29', party_state: '29', company_state: '29',
    reference_number: ref,
    items: [{
      product_id: linkedProduct, item_id: itemId, description: 'BL Widget',
      quantity: qty, unit_price: 150, tax_rate: 0,
      gl_account_id: 'acc_sales', godown_id: godown, uom_id: uom,
    }],
  });
  const billId = draft.json?.data?.id || draft.json?.id;
  expect(billId, `bill not created: ${draft.text.slice(0, 140)}`).toBeTruthy();
  await api('POST', `/api/customer-bills/${billId}/submit`, {});
  await api('POST', `/api/customer-bills/${billId}/approve`, {});
  const posted = await api('POST', `/api/customer-bills/${billId}/post`, {});
  expect(posted.status, `post failed: ${posted.text.slice(0, 140)}`).toBeLessThan(400);
  return billId;
}

describe('PHASE 5 — customer-bill lifecycle', () => {
  test('stock item is auto-linked to a product', () => {
    expect(itemId).toBeTruthy();
    expect(linkedProduct, 'createStockItem must auto-create and link a product').toBeTruthy();
  });

  test('auto-created product claims inventory management', () => {
    // Regression: the auto-create INSERT omitted is_inventory_managed, so it
    // defaulted to 0 while the product owned an active stock_items row. The
    // backend ignored the flag but the Bill UI trusts it and hid the
    // godown/batch/serial inputs, which made posting fail with "no godown".
    const flag = Number(q1('SELECT is_inventory_managed FROM products WHERE id=?', linkedProduct)?.is_inventory_managed);
    expect(flag).toBe(1);
  });

  test('opening stock moves the ledger and the balance', async () => {
    const posted = await openStock(100);
    expect(posted.status, posted.text.slice(0, 140)).toBeLessThan(400);
    expect(balance()).toBe(100);
    expect(ledgerCount()).toBe(1);
  });

  test('posting a bill deducts stock exactly once', async () => {
    await createAndPostBill(`BL-1-${Date.now()}`, 10);
    expect(balance()).toBe(90);
  });

  test('a second bill deducts its own quantity once', async () => {
    await createAndPostBill(`BL-2-${Date.now()}`, 10);
    expect(balance()).toBe(80);
  });

  test('a DRAFT bill cannot be posted (state machine enforced)', async () => {
    // Guards the audit itself from regressing into a shortcut that bypasses
    // submit/approve: the server must refuse DRAFT -> POSTED.
    const draft = await api('POST', '/api/customer-bills', {
      company_id: 'default', contact_id: custId, currency: 'INR',
      issue_date: new Date().toISOString().slice(0, 10),
      due_date: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
      place_of_supply: '29', party_state: '29', company_state: '29',
      items: [{
        product_id: linkedProduct, item_id: itemId, description: 'BL Widget',
        quantity: 1, unit_price: 150, tax_rate: 0,
        gl_account_id: 'acc_sales', godown_id: godown, uom_id: uom,
      }],
    });
    const id = draft.json?.data?.id || draft.json?.id;
    const res = await api('POST', `/api/customer-bills/${id}/post`, {});
    expect(res.status).toBe(400);
    expect(res.json?.error?.code).toBe('INVALID_STATE');
  });

  test('cancel restores stock and appends a reversal rather than deleting', async () => {
    const before = ledgerCount();
    const billId = await createAndPostBill(`BL-3-${Date.now()}`, 10);
    expect(balance()).toBe(70);

    const cancel = await api('POST', `/api/customer-bills/${billId}/cancel`, { reason: 'audit' });
    expect(cancel.status).toBeLessThan(400);
    expect(balance(), 'stock must be restored on cancel').toBe(80);
    expect(ledgerCount(), 'reversal appends; originals are never deleted')
      .toBeGreaterThan(before);
  });

  test('cancelling twice does not restore stock twice', async () => {
    const before = balance();
    const billId = await createAndPostBill(`BL-4-${Date.now()}`, 10);
    expect(balance()).toBe(before - 10);

    await api('POST', `/api/customer-bills/${billId}/cancel`, { reason: 'first' });
    const afterFirst = balance();
    expect(afterFirst).toBe(before);

    const second = await api('POST', `/api/customer-bills/${billId}/cancel`, { reason: 'second' });
    expect(second.status, 'a second cancel must be refused').toBeGreaterThanOrEqual(400);
    expect(balance(), 'stock must not be restored again').toBe(afterFirst);
  });

  test('cancelling an unknown bill is rejected', async () => {
    const res = await api('POST', '/api/customer-bills/no-such-bill/cancel', { reason: 'x' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('PHASE 7 — reconciliation', () => {
  test('ledger and balances agree for every item', () => {
    expect(reconcileMismatches()).toEqual([]);
  });

  test('no negative balances', () => {
    const neg = q('SELECT item_id, SUM(quantity) s FROM stock_balances GROUP BY item_id HAVING SUM(quantity) < 0');
    expect(neg).toEqual([]);
  });

  test('no balances pointing at missing stock items', () => {
    const orphan = q(`SELECT b.item_id FROM stock_balances b
                       LEFT JOIN stock_items si ON si.id = b.item_id
                       WHERE si.id IS NULL`);
    expect(orphan).toEqual([]);
  });

  test('no duplicate ledger entries per source document', () => {
    const dups = q(`SELECT item_id, godown_id, source_document_id, COUNT(*) c
                     FROM stock_ledger
                     WHERE company_id='default' AND source_document_id IS NOT NULL
                     GROUP BY item_id, godown_id, source_document_id
                     HAVING c > 2`);
    expect(dups).toEqual([]);
  });

  test('foreign keys hold', () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]); }
    finally { db.close(); }
  });
});
