/**
 * Verify the Customer Bill inventory UI wiring without a browser.
 *
 * The bill create form lives inside public/js/pages/customer-bills.js, a class
 * on window. This loads that file in a minimal sandbox with stubs for the DOM
 * and the API, then asserts the behaviours that matter:
 *
 *   1. selecting an inventory-managed product marks the line as managed and
 *      captures the stock item id, batch/serial flags and default placement
 *   2. the rendered line markup contains godown / location selects
 *   3. a batch select appears ONLY for a batch-tracked item
 *   4. a serial select appears ONLY for a serial-tracked item
 *   5. a service (non-inventory) product renders NO inventory row at all
 *   6. the save payload carries product_id (without which no stock moves)
 *   7. the save payload carries the chosen dimensions for inventory lines
 *   8. the save payload omits dimensions for non-inventory lines
 *
 *   node scripts/test-bill-ui.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'pages', 'customer-bills.js'), 'utf8');

let passed = 0, failed = 0;
const out = [];
function check(name, cond, detail) {
  if (cond) { passed++; out.push(`  PASS  ${name}`); }
  else { failed++; out.push(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`); }
}

// ── Minimal browser-ish sandbox ────────────────────────────────────────────
function makeEl() {
  const el = {
    innerHTML: '', value: '', textContent: '', dataset: {}, style: {}, classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    children: [], selectedOptions: [],
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {}, removeEventListener() {}, appendChild() {},
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    closest: () => null, focus() {}, click() {},
  };
  return el;
}

const apiCalls = [];
const sandbox = {
  window: {},
  document: {
    getElementById: (id) => (id === 'cb-items-body' ? makeEl() : makeEl()),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    addEventListener() {}, body: makeEl(),
  },
  localStorage: { getItem: () => null, setItem() {} },
  API: {
    get: async (url) => { apiCalls.push(['GET', url]); return { data: { items: [] } }; },
    post: async (url, body) => { apiCalls.push(['POST', url, body]); return { data: { id: 'bill_test' } }; },
    put: async () => ({}), del: async () => ({}),
  },
  Currency: { format: (n) => String(n) },
  Toast: { success() {}, error() {}, info() {} },
  console,
  setTimeout, clearTimeout, Date, Math, JSON, Object, Array, String, Number, Boolean,
  parseFloat, parseInt, isNaN, encodeURIComponent, URLSearchParams, Promise, Set, Map,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox.window;
vm.createContext(sandbox);

// Expose the class. The file assigns to window; grab whatever it defines.
vm.runInContext(SRC, sandbox, { filename: 'customer-bills.js' });

// The file exports an object literal of page methods via
// window.PageModules['customer-bills'], not a class. Build an instance whose
// prototype is that object so methods can call each other via `this`.
const mod = sandbox.window.PageModules && sandbox.window.PageModules['customer-bills'];
if (!mod || !mod._inventoryDimensionRow) {
  console.log('Could not locate the customer-bills page module in the sandbox');
  console.log('Available:', sandbox.window.PageModules
    ? Object.keys(sandbox.window.PageModules).join(', ') : '(none)');
  process.exit(1);
}

const page = Object.create(mod);
page.esc = (s) => String(s == null ? '' : s);
page._safeRound = (n) => Math.round(n * 100) / 100;
page._formatTaxRate = (r) => `${r || 0}%`;
page._taxOptionsFor = () => '<option value="tax_gst_5_intra">GST 5%</option>';
page._recalcLine = () => {};
page.updateCreateBillTotals = () => {};
page._markDirty = () => {};
page._lineNetWithTax = (l) => l.line_total || 0;
page._lineTaxRate = (l) => l.tax_rate || 0;
page._lineDiscountPercent = (l) => l.discount_percent || 0;
page.currentCurrency = 'INR';
page.createBillState = {
  billLines: [],
  taxMasters: [{ id: 'tax_gst_5_intra', rate: 5, isIgst: false }],
  invOptions: { godowns: { __global__: [{ id: 'G1', name: 'Main Store' }] },
                locations: { __global__: [{ id: 'L1', name: 'HQ' }] } },
  invLoaded: { godowns: {}, locations: {}, batches: {}, serials: {} },
};

console.log('\n' + '='.repeat(70));
console.log('CUSTOMER BILL INVENTORY UI — wiring tests');
console.log('='.repeat(70));

// A stock-managed product as /api/products returns it.
const managedProduct = {
  id: 'prod_1', name: 'Widget', sku: 'W-1', price: 150, tax_rate: 5,
  is_inventory_managed: 1,
  stock_item_id: 'stoc_1',
  on_hand_qty: 40,
  stockItem: { id: 'stoc_1', godown_id: 'G1', location_id: 'L1', is_batch_tracked: 0, is_serial_tracked: 0 },
};
const batchProduct = {
  id: 'prod_2', name: 'Batched', sku: 'B-1', price: 100, tax_rate: 5,
  stockItem: { id: 'stoc_2', godown_id: 'G1', location_id: 'L1', is_batch_tracked: 1, is_serial_tracked: 0 },
};
const serialProduct = {
  id: 'prod_3', name: 'Serialized', sku: 'S-1', price: 500, tax_rate: 5,
  stockItem: { id: 'stoc_3', godown_id: 'G1', location_id: 'L1', is_batch_tracked: 0, is_serial_tracked: 1 },
};
const serviceProduct = { id: 'prod_4', name: 'Consulting', sku: 'SRV-1', price: 2000, tax_rate: 18 };

function line(over = {}) {
  return Object.assign({
    id: 'line_x', description: '', quantity: 1, unit: 'Nos', unit_price: 0,
    discount_amount: 0, discount_percent: 0, tax_master_id: 'tax_gst_5_intra', tax_rate: 5,
    line_total: 0, line_tax: 0, taxable_amount: 0,
  }, over);
}

// ── 1. selecting a managed product marks the line ─────────────────────────
page.createBillState.billLines = [line()];
page._applyProductToLine(0, managedProduct);
let l = page.createBillState.billLines[0];

check('U1. managed product sets is_inventory_managed', l.is_inventory_managed === true, l.is_inventory_managed);
check('U1. managed product captures stock_item_id', l.stock_item_id === 'stoc_1', l.stock_item_id);
check('U1. managed product carries product_id', l.product_id === 'prod_1', l.product_id);
check('U1. managed product captures on_hand_qty', Number(l.on_hand_qty) === 40, l.on_hand_qty);
check('U1. managed product inherits default godown', l.godown_id === 'G1', l.godown_id);
check('U1. managed product inherits default location', l.location_id === 'L1', l.location_id);

// ── 2. inventory row renders godown + location ─────────────────────────────
let html = page._inventoryDimensionRow(l, 0);
check('U2. inventory row renders', html.includes('Inventory details'), html.slice(0, 80));
check('U2. godown select present', /data-dim-field="godown_id"/.test(html));
check('U2. location select present', /data-dim-field="location_id"/.test(html));
check('U2. available stock shown', /Available:\s*40/.test(html));
check('U2. godown marked required', /Godown\s*<span class="text-error">\*<\/span>/.test(html));

// ── 3. batch select only for batch-tracked ────────────────────────────────
page.createBillState.billLines = [line()];
page._applyProductToLine(0, batchProduct);
l = page.createBillState.billLines[0];
check('U3. batch product flagged batch-tracked', l.is_batch_tracked === true);
html = page._inventoryDimensionRow(l, 0);
check('U3. batch select rendered', /data-dim-field="batch_id"/.test(html));
check('U3. no serial select for a non-serial item', !/data-dim-field="serial_ids"/.test(html));

// and NOT for a non-batch item
page.createBillState.billLines = [line()];
page._applyProductToLine(0, managedProduct);
html = page._inventoryDimensionRow(page.createBillState.billLines[0], 0);
check('U3. batch select absent for a non-batch item', !/data-dim-field="batch_id"/.test(html));

// ── 4. serial select only for serial-tracked ──────────────────────────────
page.createBillState.billLines = [line()];
page._applyProductToLine(0, serialProduct);
l = page.createBillState.billLines[0];
check('U4. serial product flagged serial-tracked', l.is_serial_tracked === true);
html = page._inventoryDimensionRow(l, 0);
check('U4. serial select rendered', /data-dim-field="serial_ids"/.test(html));
check('U4. quantity/serial rule explained to the user',
  /Quantity must equal the number of serials selected/.test(html));

// ── 5. service product renders NO inventory row ───────────────────────────
page.createBillState.billLines = [line()];
page._applyProductToLine(0, serviceProduct);
l = page.createBillState.billLines[0];
check('U5. service product is not inventory managed', l.is_inventory_managed !== true);
check('U5. service product renders no inventory row', page._inventoryDimensionRow(l, 0) === '');

// switching product clears stale dimensions
page.createBillState.billLines = [line({ batch_id: 'B9', serial_ids: ['S9'] })];
page._applyProductToLine(0, managedProduct);
l = page.createBillState.billLines[0];
check('U5. stale batch cleared when switching to a non-batch product', !l.batch_id, l.batch_id);
check('U5. stale serials cleared when switching to a non-serial product',
  !l.serial_ids || l.serial_ids.length === 0, JSON.stringify(l.serial_ids));

// ── 6/7/8. save payload ──────────────────────────────────────────────────
async function buildPayload(billLines) {
  page.createBillState.billLines = billLines;
  // Reuse the real payload builder from the file.
  const fn = page._buildCreateBillPayload || page._createBillPayload;
  if (typeof fn === 'function') return await fn.call(page, 'draft');
  // Fall back to reading the same mapping the file performs.
  return null;
}

(async () => {
  page.createBillState.billLines = [line()];
  page._applyProductToLine(0, managedProduct);
  page.createBillState.billLines[0].godown_id = 'G1';
  page.createBillState.billLines[0].location_id = 'L1';

  let payload = await buildPayload(page.createBillState.billLines);

  if (payload) {
    const ln = payload.lines[0];
    check('U6. payload carries product_id', ln.product_id === 'prod_1', ln.product_id);
    check('U7. payload carries stock_item_id', ln.stock_item_id === 'stoc_1', ln.stock_item_id);
    check('U7. payload carries godown_id', ln.godown_id === 'G1', ln.godown_id);
    check('U7. payload carries location_id', ln.location_id === 'L1', ln.location_id);
    check('U8. non-batch line omits batch_id', ln.batch_id === undefined || ln.batch_id === null, ln.batch_id);
  } else {
    // No exported payload builder; assert the mapping directly instead.
    const l2 = page.createBillState.billLines[0];
    check('U6. line retains product_id for the payload', l2.product_id === 'prod_1', l2.product_id);
    check('U6. line retains stock_item_id for the payload', l2.stock_item_id === 'stoc_1', l2.stock_item_id);
    out.push('  NOTE  payload builder not exported; asserted line state instead');
  }

  // service line must not gain dimensions
  page.createBillState.billLines = [line()];
  page._applyProductToLine(0, serviceProduct);
  const svc = page.createBillState.billLines[0];
  check('U8. service line has no godown_id', !svc.godown_id, svc.godown_id);

  console.log('\n' + '-'.repeat(70));
  out.forEach((l) => console.log(l));
  console.log('-'.repeat(70));
  console.log(`\nPASS: ${passed}   FAIL: ${failed}`);
  console.log('='.repeat(70) + '\n');
  process.exit(failed === 0 ? 0 : 1);
})();