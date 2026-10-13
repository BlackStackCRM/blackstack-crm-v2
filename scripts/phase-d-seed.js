#!/usr/bin/env node
/**
 * PHASE D — create real business test data in an isolated packaged instance.
 *
 * Everything is created through the SAME authenticated HTTP API the desktop UI
 * uses, so the data is genuine application data with genuine relationships,
 * not hand-inserted rows. Records are tagged PHASE-D-* so verification after the
 * update can find exactly what was created before it.
 *
 * Isolation (§2): refuses to run unless the target DB is inside a mkdtemp
 * directory under the OS temp root. Production is never referenced.
 *
 * Usage: node scripts/phase-d-seed.js <baseUrl> <userDataDir>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:34567';
const USER_DATA = process.argv[3];

if (!USER_DATA) {
  console.error('usage: node scripts/phase-d-seed.js <baseUrl> <userDataDir>');
  process.exit(2);
}

// ── Isolation gate (§2) ─────────────────────────────────────────────────────
const dbPath = path.join(USER_DATA, 'database', 'blackstack-crm.db');
const resolvedRoot = path.resolve(os.tmpdir()).toLowerCase();
const resolvedDb = path.resolve(dbPath).toLowerCase();
if (!resolvedDb.startsWith(resolvedRoot)) {
  console.error('FATAL: refusing to seed — DB is not inside the OS temp root: ' + dbPath);
  process.exit(1);
}
console.log(`[seed] isolation OK: ${dbPath}`);

const TAG = 'PHASE-D';
let failures = 0;
const created = {};

async function api(method, endpoint, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + endpoint, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`${method} ${endpoint} -> ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

async function main() {
  // ── Auth (as the app itself does) ─────────────────────────────────────────
  //
  // There is NO /api/auth/register route — the only auth POST is /login. The
  // first admin is created by server/database/seed.js from DEMO_MODE /
  // BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD, which the Phase D driver
  // sets when launching the isolated instance. Try that account first; fall back
  // to the historical demo defaults so this script also works against a
  // DEMO_MODE instance.
  let token = null;
  const loginCreds = [
    { email: process.env.PHASE_D_ADMIN_EMAIL || 'phase-d-admin@blackstack.local', password: process.env.PHASE_D_ADMIN_PASSWORD || 'PhaseD-Admin-2026' },
    { email: 'admin@blackstack.local', password: 'admin123' },
    { email: 'admin@blackstack.local', password: 'Admin@123' },
  ];
  for (const creds of loginCreds) {
    try {
      const r = await api('POST', '/api/auth/login', creds);
      token = r.token || r.data?.token;
      if (token) { console.log(`[seed] logged in as ${creds.email}`); created.authenticatedAs = creds.email; break; }
    } catch { /* try next */ }
  }
  if (!token) {
    console.error('[seed] FATAL: cannot authenticate against the isolated instance.');
    console.error('[seed]   Tried: ' + loginCreds.map((c) => c.email).join(', '));
    console.error('[seed]   The instance must be launched with BOOTSTRAP_ADMIN_EMAIL/PASSWORD.');
    process.exit(1);
  }

  // ── CRM ──────────────────────────────────────────────────────────────────
  // Field names/required keys read from the real validators in server/routes/*.js:
  //   contacts POST requires first_name; leads/customers require contact_id;
  //   tasks requires title (+ contact_id or organization_id);
  //   invoices requires contact_id.
  const contact = await api('POST', '/api/contacts', {
    first_name: `${TAG}-TEST-CONTACT`,
    last_name: 'Verifier',
    email: 'phase-d-contact@example.invalid',
    phone: '9000000001',
    company: `${TAG} Industries`,
    address: '1 Test Lane, Test City',
  }, token).catch((e) => ({ warn: e.message }));
  created.contact = pick(contact);
  console.log(`[seed] contact    : ${JSON.stringify(created.contact)}`);

  const lead = await api('POST', '/api/leads', {
    contact_id: created.contact?.id,
    title: `${TAG}-TEST-LEAD`,
    source: 'phase-d',
    status: 'new',
    value: 50000,
  }, token).catch((e) => ({ warn: e.message }));
  created.lead = pick(lead);
  console.log(`[seed] lead       : ${JSON.stringify(created.lead)}`);

  const customer = await api('POST', '/api/customers', {
    contact_id: created.contact?.id,
    name: `${TAG}-TEST-CUSTOMER`,
    phone: '9000000003',
    address: '2 Test Road, Test City',
  }, token).catch((e) => ({ warn: e.message }));
  created.customer = pick(customer);
  console.log(`[seed] customer   : ${JSON.stringify(created.customer)}`);

  const task = await api('POST', '/api/tasks', {
    title: `${TAG}-TEST-TASK`,
    description: 'Follow up after Phase D update verification',
    status: 'pending',
    priority: 'high',
    due_date: '2026-12-31',
    contact_id: created.contact?.id,
  }, token).catch((e) => ({ warn: e.message }));
  created.task = pick(task);
  console.log(`[seed] task       : ${JSON.stringify(created.task)}`);

  // ── Accounting ────────────────────────────────────────────────────────────
  // POST /api/accounting/accounts does not exist: accounts are read-only (GET)
  // in this build. Account GROUPS are the creatable accounting master and carry
  // real parent/child structure.
  for (const [key, name, type] of [
    ['accountGroupCustomer', `${TAG}-TEST-GROUP-CUSTOMER`, 'asset'],
    ['accountGroupVendor', `${TAG}-TEST-GROUP-VENDOR`, 'liability'],
  ]) {
    const r = await api('POST', '/api/accounting/accounts/groups', {
      name,
      group_type: type,
      is_active: 1,
      // Required by the server: account-group.service.js rejects a group unless
      // BOTH `name` and `type` are present, and `type` must be one of
      // ASSET/LIABILITY/EQUITY/INCOME/EXPENSE. `type` above already carries that.
      type: type.toUpperCase(),
    }, token).catch((e) => ({ warn: e.message }));
    created[key] = pick(r);
    console.log(`[seed] acct group : ${name} -> ${JSON.stringify(created[key])}`);
  }

  // ── Inventory masters ─────────────────────────────────────────────────────
  // Real paths: /api/inventory/masters/:table and /api/inventory/stocks.
  // Server-enforced hierarchy: stock_categories needs stock_group_id,
  // models needs brand_id, godowns needs location_id.
  const group = await api('POST', '/api/inventory/masters/stock_groups', {
    name: `${TAG}-TEST-STOCK-GROUP`, description: 'Phase D stock group',
  }, token).catch((e) => ({ warn: e.message }));
  created.stockGroup = pick(group);
  console.log(`[seed] stock group    : ${JSON.stringify(created.stockGroup)}`);

  const brand = await api('POST', '/api/inventory/masters/brands', {
    name: `${TAG}-TEST-BRAND`, description: 'Phase D brand',
  }, token).catch((e) => ({ warn: e.message }));
  created.brand = pick(brand);
  console.log(`[seed] brand          : ${JSON.stringify(created.brand)}`);

  const category = await api('POST', '/api/inventory/masters/stock_categories', {
    name: `${TAG}-TEST-STOCK-CATEGORY`,
    stock_group_id: created.stockGroup?.id,
    description: 'Phase D stock category',
  }, token).catch((e) => ({ warn: e.message }));
  created.stockCategory = pick(category);
  console.log(`[seed] stock category : ${JSON.stringify(created.stockCategory)}`);

  const model = await api('POST', '/api/inventory/masters/models', {
    name: `${TAG}-TEST-MODEL`,
    brand_id: created.brand?.id,
    stock_category_id: created.stockCategory?.id,
    description: 'Phase D model',
  }, token).catch((e) => ({ warn: e.message }));
  created.model = pick(model);
  console.log(`[seed] model          : ${JSON.stringify(created.model)}`);

  const product = await api('POST', '/api/inventory/masters/products', {
    name: `${TAG}-TEST-PRODUCT`,
    stock_category_id: created.stockCategory?.id,
    model_id: created.model?.id,
    brand_id: created.brand?.id,
    description: 'Phase D product',
  }, token).catch((e) => ({ warn: e.message }));
  created.product = pick(product);
  console.log(`[seed] product        : ${JSON.stringify(created.product)}`);

  const location = await api('POST', '/api/inventory/masters/locations', {
    name: `${TAG}-TEST-LOCATION`, address: 'Phase D Warehouse', city: 'Test City',
  }, token).catch((e) => ({ warn: e.message }));
  created.location = pick(location);
  console.log(`[seed] location       : ${JSON.stringify(created.location)}`);

  const godown = await api('POST', '/api/inventory/masters/godowns', {
    name: `${TAG}-TEST-GODOWN`,
    location_id: created.location?.id,
  }, token).catch((e) => ({ warn: e.message }));
  created.godown = pick(godown);
  console.log(`[seed] godown         : ${JSON.stringify(created.godown)}`);

  // stock_items.uom_id is NOT NULL and FKs units_of_measure. Sending no uom
  // produced a bare FOREIGN KEY failure that the global error mapper reports as
  // the generic "operation was blocked because related records reference this
  // data" (409), which reads like data loss but is really a missing required
  // field. There is no /api/inventory/masters/units_of_measure route, so take
  // the unit id from the list endpoint the UI uses, falling back to "Each".
  let uomId = null;
  const uoms = await api('GET', '/api/inventory/masters/units', null, token)
    .catch(() => null);
  if (Array.isArray(uoms?.data)) {
    const each = uoms.data.find((u) => /each|unit|nos/i.test(u.name || '')) || uoms.data[0];
    uomId = each?.id || null;
  }
  if (!uomId) {
    // Last resort: read it straight from the isolated DB (test-only helper, and
    // this DB is the throwaway Phase D instance, never production).
    try {
      const { createRequire } = require('module');
      const nodeRequire = createRequire(path.join(process.cwd(), 'package.json'));
      const { DatabaseSync } = nodeRequire('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare("SELECT id FROM units_of_measure WHERE lower(name) IN ('each','unit','nos') LIMIT 1")
        .get() || db.prepare('SELECT id FROM units_of_measure LIMIT 1').get();
      uomId = row?.id || null;
      db.close();
    } catch { /* leave null and let the API report */ }
  }
  console.log(`[seed] uom            : ${uomId}`);

  const stockItem = await api('POST', '/api/inventory/stocks', {
    name: `${TAG}-TEST-STOCK-ITEM`,
    product_id: created.product?.id,
    uom_id: uomId,
    sku: `${TAG}-SKU-001`,
    group_id: created.stockGroup?.id,
    category_id: created.stockCategory?.id,
    brand_id: created.brand?.id,
    model_id: created.model?.id,
    location_id: created.location?.id,
    godown_id: created.godown?.id,
    cost_price: 42.5,
    selling_rate: 65.75,
    description: 'Phase D stock item',
  }, token).catch((e) => ({ warn: e.message }));
  created.stockItem = pick(stockItem);
  console.log(`[seed] stock item     : ${JSON.stringify(created.stockItem)}`);

  // ── Billing ───────────────────────────────────────────────────────────────
  const invoice = await api('POST', '/api/invoices', {
    contact_id: created.contact?.id,
    issue_date: '2026-10-07',
    due_date: '2026-11-07',
    notes: `${TAG}-TEST-INVOICE`,
    // The live route wires controllers/invoice.controller.js -> InvoiceService,
    // which reads `lines` (server/services/invoice.service.js:64) with
    // product_id / unit_price / tax_rate / discount, and computes
    // quantity * unit_price itself. Sending `line_items` is silently ignored
    // (that key belongs to the dead controllers/invoices.controller.js).
    lines: [{
      description: `${TAG}-TEST-LINE-ITEM`,
      quantity: 3,
      unit_price: 250.75,
      tax_rate: 18,
      // stock_items are reached through product_id.
      product_id: created.product?.id ?? null,
      discount: 0,
    }],
  }, token).catch((e) => ({ warn: e.message }));
  created.invoice = pick(invoice);
  console.log(`[seed] invoice        : ${JSON.stringify(created.invoice)}`);

  // ── Manifest for the post-update verifier (§7) ────────────────────────────
  const out = path.join(USER_DATA, 'phase-d-seeded.json');
  fs.writeFileSync(out, JSON.stringify({
    tag: TAG, seededAt: new Date().toISOString(), base: BASE, created,
  }, null, 2));
  console.log(`\n[seed] manifest -> ${out}`);

  const missing = Object.entries(created)
    .filter(([k, v]) => k !== 'authenticatedAs' && (v === null || (v && v.warn)))
    .map(([k, v]) => `${k}: ${v?.warn || 'null'}`);
  if (missing.length) {
    console.log(`\n[seed] ${missing.length} record(s) could not be created through the API:`);
    for (const m of missing) console.log('[seed]   - ' + m);
    failures = missing.length;
  } else {
    console.log('\n[seed] all business records created through the real API.');
  }
  process.exit(failures ? 1 : 0);
}

/** API responses vary ({data:{...}} vs flat); find the id wherever it is. */
function pick(res) {
  if (!res || res.warn) return res?.warn ? { warn: res.warn } : null;
  const d = res.data && typeof res.data === 'object' ? res.data : res;
  if (d && typeof d === 'object' && d.id != null) {
    return { id: d.id, name: d.name, ...(d.contact_id != null ? { contact_id: d.contact_id } : {}) };
  }
  return null;
}

main().catch((e) => { console.error('[seed] FATAL', e); process.exit(1); });
