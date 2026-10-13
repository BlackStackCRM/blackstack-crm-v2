/**
 * Verify the live-database guard protects every suite that mutates data.
 *
 * On 2026-10-05/06 the live BlackStack CRM database was wiped twice by the
 * inventory E2E suite, whose cleanTestDB() deleted all inventory masters and
 * defaulted to ../data/blackstack-crm.db. These tests prove that is now
 * impossible, and that the other data-mutating suites are guarded too.
 *
 *   node scripts/verify-e2e-db-guard.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { assertDisposableDb } = require(path.join(ROOT, 'scripts', 'assert-disposable-db'));

let passed = 0, failed = 0;
const lines = [];
function check(name, cond, detail) {
  if (cond) { passed++; lines.push(`  PASS  ${name}`); }
  else { failed++; lines.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const LIVE = path.join(ROOT, 'data', 'blackstack-crm.db');

console.log('\n' + '='.repeat(70));
console.log('LIVE-DATABASE GUARD — verification');
console.log('='.repeat(70));

// ── Part 1: the shared guard's behaviour ─────────────────────────────────
function refuses(label, dbPath, env = {}) {
  const saved = process.env.DB_PATH;
  if (env.DB_PATH === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = env.DB_PATH;
  try {
    assertDisposableDb(dbPath, { suite: 'probe' });
    check(label, false, 'guard allowed it');
  } catch (e) {
    check(label, /REFUSING TO RUN/.test(e.message), 'wrong error: ' + e.message.split('\n')[0]);
  } finally {
    if (saved === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = saved;
  }
}
function allows(label, dbPath) {
  const saved = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  try {
    const resolved = assertDisposableDb(dbPath, { suite: 'probe' });
    check(label, path.resolve(resolved) === path.resolve(dbPath), `returned ${resolved}`);
  } catch (e) {
    check(label, false, e.message.split('\n')[0]);
  } finally {
    if (saved === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = saved;
  }
}

console.log('\n-- guard behaviour --');
refuses('G1. refuses when DB_PATH is unset', LIVE);
refuses('G2. refuses when DB_PATH IS the live database', LIVE, { DB_PATH: LIVE });
refuses('G3. refuses an unmarked path', path.join(ROOT, 'data', 'prod.db'), { DB_PATH: 'set' });
refuses('G4. refuses a "data" folder file with no marker',
  path.join(ROOT, 'data', 'customers.db'), { DB_PATH: 'set' });
refuses('G5. refuses even a marked file that IS the live db',
  LIVE.replace(/\.db$/, '-test.db').replace(/blackstack-crm-test/, 'blackstack-crm'),
  { DB_PATH: 'set' });
allows('G6. allows *e2e*.db', path.join(ROOT, 'data', 'e2etest', 'inventory-e2e.db'));
allows('G7. allows *test*.db', path.join(ROOT, 'data', 'x', 'unit-test.db'));
allows('G8. allows *tmp*.db', path.join(ROOT, 'data', 'scratch', 'tmp.db'));
allows('G9. allows *acceptance*.db', path.join(ROOT, 'data', 'acceptance.db'));
allows('G10. allows *debug*.db', path.join(ROOT, 'data', 'debug.db'));

// ── Part 2: every mutating suite actually uses the guard ────────────────
console.log('\n-- suite wiring --');
const SUITES = [
  'tests/inventory.e2e.test.js',
  'tests/product-hierarchy-ui.e2e.test.js',
  'tests/alternate-units-ui.e2e.test.js',
];

for (const rel of SUITES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { check(`${rel} exists`, false, 'missing'); continue; }
  const src = fs.readFileSync(p, 'utf8');

  const mutates = /DELETE\s+FROM|DROP\s+TABLE|TRUNCATE/i.test(src);
  const guarded = src.includes('assert-disposable-db');

  if (mutates) {
    check(`${rel} is guarded`, guarded,
      'it deletes rows but does not require assert-disposable-db');
  } else {
    lines.push(`  SKIP  ${rel} does not mutate data; guard not required`);
  }

  // No suite may silently default to the live database.
  const silentLiveDefault =
    /process\.env\.DB_PATH\s*\|\|\s*[^;]*blackstack-crm\.db/.test(src)
    && !guarded;
  check(`${rel} has no unguarded live-DB fallback`, !silentLiveDefault,
    'defaults to blackstack-crm.db without a guard');
}

console.log('\n' + '-'.repeat(70));
lines.forEach((l) => console.log(l));
console.log('-'.repeat(70));
console.log(`\nPASS: ${passed}   FAIL: ${failed}`);
console.log('='.repeat(70) + '\n');
process.exit(failed === 0 ? 0 : 1);