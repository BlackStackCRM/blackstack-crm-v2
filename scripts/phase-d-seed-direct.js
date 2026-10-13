#!/usr/bin/env node
/**
 * Phase D Step 3 — seed representative CRM / Accounting / Inventory / Billing
 * rows DIRECTLY into an isolated database (no HTTP server, no login).
 *
 * Every row is tagged STEP3 so the relationship checks can find it, and the
 * foreign keys are real: leads/customers/invoices all point at one contact,
 * invoice lines point at a real product, and the product is wired into the
 * inventory hierarchy.
 *
 * Usage: node phase-d-seed-direct.js <dbFile>
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbFile = path.resolve(process.argv[2] || '');
if (!dbFile || !require('fs').existsSync(dbFile)) {
  console.error('usage: phase-d-seed-direct.js <dbFile>  (db must already exist)');
  process.exit(2);
}

const TAG = 'STEP3';
const db = new DatabaseSync(dbFile);
db.exec('PRAGMA foreign_keys = ON');

// companies is the tenant root that products/payments require.
const companies = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='companies'").get()
  ? db.prepare("SELECT id FROM companies LIMIT 1").all()
  : [];

const now = new Date().toISOString();
const id = (p) => `${p}_${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

function cols(table) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
}
function pick(table, wanted) {
  const have = new Set(cols(table));
  return wanted.filter((c) => have.has(c));
}
function ins(table, obj) {
  const keys = Object.keys(obj).filter((k) => cols(table).includes(k));
  if (!keys.length) { console.log(`  [skip] ${table}: no usable columns`); return null; }
  const sql = `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  try { db.prepare(sql).run(...keys.map((k) => obj[k])); return obj[keys[0]]; }
  catch (e) { console.log(`  [fail] ${table}: ${e.message.slice(0, 90)}`); return null; }
}

// ── tenant root ─────────────────────────────────────────────────────────────
let companyId = companies.length ? companies[0].id : null;
if (!companyId) {
  const ccols = new Set(cols('companies'));
  companyId = ins('companies', {
    id: id('comp'), name: `${TAG}-COMPANY`,
    ...(ccols.has('code') ? { code: `${TAG}-CODE` } : {}),
    ...(ccols.has('created_at') ? { created_at: now } : {}),
  });
}
console.log(`  [tenant] company_id=${companyId}`);

// ── Inventory master chain (outermost first) ────────────────────────────────
const brand = ins('brands', { id: id('bran'), name: `${TAG}-BRAND`, created_at: now });
const model = brand ? ins('models', { id: id('mode'), name: `${TAG}-MODEL`, brand_id: brand, created_at: now }) : null;

let stockGroup = ins('stock_groups', { id: id('stoc'), name: `${TAG}-STOCK-GROUP`, created_at: now });
let stockCategory = stockGroup
  ? ins('stock_categories', { id: id('stoc'), name: `${TAG}-STOCK-CATEGORY`, stock_group_id: stockGroup, created_at: now })
  : null;
const product = (stockCategory || stockGroup)
  ? ins('products', {
      id: id('prod'), name: `${TAG}-PRODUCT`, sku: `${TAG}-SKU`, company_id: companyId,
      stock_category_id: stockCategory, model_id: model, created_at: now,
    })
  : null;
// stock_items.uom_id is NOT NULL — resolve or create the unit of measure FIRST.
let uomId = (() => {
  for (const t of ['units_of_measure', 'uoms']) {
    try { const r = db.prepare(`SELECT id FROM "${t}" LIMIT 1`).get(); if (r) return r.id; } catch { /* next */ }
  }
  return null;
})();
if (!uomId) {
  for (const t of ['units_of_measure', 'uoms']) {
    const ucols = new Set(cols(t));
    if (!ucols.size) continue;
    uomId = ins(t, {
      id: id('uom'), name: `${TAG}-UOM`,
      ...(ucols.has('code') ? { code: `${TAG}-UOM` } : {}),
      ...(ucols.has('symbol') ? { symbol: 'PCS' } : {}),
      ...(ucols.has('base_unit') ? { base_unit: 'PCS' } : {}),
    });
    if (uomId) { console.log(`  [uom] created in ${t}: ${uomId}`); break; }
  }
}
console.log(`  [uom] uom_id=${uomId}`);
const stockItem = product && uomId
  ? ins('stock_items', {
      id: id('stoc'), name: `${TAG}-STOCK-ITEM`, sku: `${TAG}-ISKU`,
      product_id: product, uom_id: uomId, created_at: now,
    })
  : null;
const location = ins('locations', { id: id('loca'), name: `${TAG}-LOCATION`, created_at: now });

// ── Accounting ──────────────────────────────────────────────────────────────
const NAT = 'DEBIT';
const groupCust = ins('account_groups', {
  id: id('ag'), name: `${TAG}-GROUP-CUSTOMER`, code: `${TAG}-GCUST`,
  type: 'ASSET', debit_credit_nature: NAT, created_at: now,
});
const groupVend = ins('account_groups', {
  id: id('ag'), name: `${TAG}-GROUP-VENDOR`, code: `${TAG}-GVEND`,
  type: 'LIABILITY', debit_credit_nature: NAT, created_at: now,
});
const ledger = groupCust ? ins('accounts', {
  id: id('acco'), name: `${TAG}-LEDGER`, code: `${TAG}-LEDGER`,
  account_group_id: groupCust, type: 'ASSET', debit_credit_nature: NAT, created_at: now,
}) : null;

// ── CRM: one contact is the parent of lead / customer / invoice ─────────────
const contact = ins('contacts', {
  id: id('cnt'), first_name: `${TAG}-CONTACT`, last_name: 'Verifier',
  email: `${TAG.toLowerCase()}@blackstack.local`, created_at: now,
});
const lead = contact ? ins('leads', {
  id: id('lead'), contact_id: contact, title: `${TAG}-LEAD`, status: 'NEW', created_at: now,
}) : null;
const customer = contact ? ins('customers', {
  id: id('cust'), contact_id: contact, name: `${TAG}-CUSTOMER`, created_at: now,
}) : null;
const task = contact ? ins('tasks', {
  id: id('task'), contact_id: contact, title: `${TAG}-TASK`, status: 'PENDING', created_at: now,
}) : null;

// ── Billing: invoice + line, linked to the same contact and product ─────────
let invoice = null;
if (contact) {
  const invCols = new Set(cols('invoices'));
  const base = { id: id('inv'), contact_id: contact, created_at: now, updated_at: now };
  if (invCols.has('invoice_number')) base.invoice_number = `${TAG}-INV-001`;
  if (invCols.has('issue_date')) base.issue_date = now.slice(0, 10);
  if (invCols.has('due_date')) base.due_date = now.slice(0, 10);
  if (invCols.has('status')) base.status = 'DRAFT';
  if (invCols.has('total')) base.total = 826.48;
  if (invCols.has('subtotal')) base.subtotal = 752.25;
  invoice = ins('invoices', base);

  if (invoice && product) {
    // invoice_line_items columns: product_id, description, quantity, unit_price...
    ins('invoice_line_items', {
      id: id('iline'), invoice_id: invoice, product_id: product,
      description: `${TAG}-LINE-ITEM`, quantity: 3, unit_price: 250.75,
      tax_rate: 18, discount: 0, total: 889.845, created_at: now,
    });
  }
  if (invoice) {
    const payCols = new Set(cols('payments'));
    ins('payments', {
      id: id('pay'), invoice_id: invoice,
      ...(payCols.has('company_id') ? { company_id: companyId } : {}),
      ...(payCols.has('amount') ? { amount: 500 } : {}),
      ...(payCols.has('payment_date') ? { payment_date: now.slice(0, 10) } : {}),
      ...(payCols.has('contact_id') ? { contact_id: contact } : {}),
      created_at: now,
    });
  }
}

// ── report ──────────────────────────────────────────────────────────────────
const counts = {};
for (const t of ['contacts', 'leads', 'customers', 'tasks', 'account_groups', 'accounts',
  'stock_groups', 'stock_categories', 'brands', 'models', 'products', 'stock_items',
  'locations', 'invoices', 'invoice_line_items', 'payments']) {
  try {
    const cs = cols(t);
    const textCols = cs.filter((c) => /name|title|description|code|sku|first_name|last_name|invoice_number/i.test(c));
    if (!textCols.length) { counts[t] = 0; continue; }
    const where = textCols.map((c) => `"${c}" LIKE ?`).join(' OR ');
    counts[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE ${where}`).get(...textCols.map(() => `%${TAG}%`)).c;
  } catch (e) { counts[t] = -1; }
}
db.close();

console.log(`[seed] tagged rows: ${JSON.stringify(counts)}`);
console.log(`[seed] ids: contact=${contact} lead=${lead} customer=${customer} task=${task}`);
console.log(`[seed]      invoice=${invoice} product=${product} stockItem=${stockItem}`);
console.log(`[seed]      brand=${brand} model=${model} stockGroup=${stockGroup} stockCategory=${stockCategory}`);
const anyOk = Object.values(counts).some((v) => v > 0);
process.exit(anyOk ? 0 : 1);
