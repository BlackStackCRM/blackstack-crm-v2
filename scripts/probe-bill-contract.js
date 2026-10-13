/**
 * Discover the real request contract for the endpoints the lifecycle audit needs.
 *
 * Guessing payload shapes produced three different 400s in one run. Read the
 * validator and the existing passing tests (which already create bills through
 * the service) to get the true shape, then report it — so the lifecycle audit
 * tests the application's contract instead of my assumptions.
 *
 * Read-only: inspection plus one throwaway server on a disposable database.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');

// 1. The bill columns actually present in the database.
console.log('=== bills table columns ===');
const db = new DatabaseSync(path.join(ROOT, 'data', 'blackstack-crm.db'), { readOnly: true });
const cols = db.prepare('PRAGMA table_info(bills)').all();
console.log(cols.map((c) => `${c.name}${c.notnull ? '*' : ''}`).join(', '));
db.close();

// 2. What the service reads off the payload.
console.log('\n=== createBill: payload fields read by the service ===');
const svc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'customer-bill.service.js'), 'utf8');
const m = svc.match(/createBill\s*\([^)]*\)\s*\{([\s\S]{0,3000}?)\n  \}/);
if (m) {
  const fields = [...new Set([...m[1].matchAll(/\bdata\.([a-z_]+)/g)].map((x) => x[1]))];
  console.log(fields.join(', '));
}

// 3. Validation rules that produce the 400s.
console.log('\n=== createBill validation ===');
const v = m ? m[1] : '';
for (const line of v.split('\n')) {
  if (/throw new (ValidationError|BadRequest)/.test(line)) console.log('  ', line.trim());
}

// 4. The existing vitest suite already builds a valid bill — mirror it.
console.log('\n=== how tests/customer-bills.vitest.test.js builds a bill ===');
const t = fs.readFileSync(path.join(ROOT, 'tests', 'customer-bills.vitest.test.js'), 'utf8');
const bill = t.match(/(?:const|let)\s+\w*[bB]ill\w*\s*=\s*\{[\s\S]{0,900}?\n\s*\};/);
if (bill) console.log(bill[0].slice(0, 900));
else {
  const alt = t.match(/contact_id[\s\S]{0,600}/);
  if (alt) console.log(alt[0].slice(0, 600));
}

// 5. Contacts, since bills reference contact_id.
console.log('\n=== contacts table columns ===');
const db2 = new DatabaseSync(path.join(ROOT, 'data', 'blackstack-crm.db'), { readOnly: true });
console.log(db2.prepare('PRAGMA table_info(contacts)').all().map((c) => `${c.name}${c.notnull ? '*' : ''}`).join(', '));
console.log('\nexisting contacts:', JSON.stringify(db2.prepare('SELECT id, name, email FROM contacts LIMIT 3').all()));
db2.close();