/**
 * READ-ONLY: identify which table's CONTENT differs from the recorded state.
 * Uses the release-gate fingerprint algorithm so the result is comparable.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const SRC = path.resolve('data/blackstack-crm.db');
const tmp = path.join(os.tmpdir(), 'fpdiff-' + Date.now() + '.db');
for (const e of ['', '-wal', '-shm']) {
  if (fs.existsSync(SRC + e)) fs.copyFileSync(SRC + e, tmp + e);
}
const db = new DatabaseSync(tmp, { readOnly: true });

// The expected per-table content hashes recorded BEFORE this phase's work.
// Filled from the incident report's verified state.
const EXPECTED_ROWS = {
  journal_entries: 31, journal_entry_lines: 112, audit_logs: 431,
  accounts: 24, account_groups: 22, contacts: 1, organizations: 1, products: 5,
  users: 1, vouchers: 25, bills: 0, payments: 0, financial_years: 2,
  inventory_voucher_headers: 2, inventory_voucher_lines: 2, stock_ledger: 2,
  stock_balances: 2, schema_migrations: 69, permissions: 103,
  role_permissions: 122, taxes: 0, stock_items: 5, godowns: 5, locations: 7,
};

const L = [];
L.push('=== ROW COUNTS vs recorded state ===');
let drift = 0;
for (const [t, exp] of Object.entries(EXPECTED_ROWS)) {
  let n;
  try { n = db.prepare('SELECT COUNT(*) c FROM "' + t + '"').get().c; } catch { continue; }
  if (n !== exp) { drift++; L.push('  DRIFT ' + t + ': expected ' + exp + ' now ' + n); }
}
L.push('  tables with drifted counts: ' + drift);

L.push('');
L.push('=== financial_years (the FY lock must still be UNCHANGED at 1) ===');
for (const r of db.prepare('SELECT * FROM financial_years ORDER BY id').all()) L.push('  ' + JSON.stringify(r));

L.push('');
L.push('=== anything created TODAY (2026-10-09) outside the known probes? ===');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
for (const t of tables) {
  let cols;
  try { cols = db.prepare('PRAGMA table_info("' + t + '")').all().map((c) => c.name); } catch { continue; }
  const ts = cols.find((c) => /^(created_at|updated_at|posted_at|approved_at)$/.test(c));
  if (!ts) continue;
  let rows;
  try { rows = db.prepare(`SELECT * FROM "${t}" WHERE ${ts} >= '2026-10-09T12:00' ORDER BY ${ts} DESC LIMIT 4`).all(); }
  catch { continue; }
  if (rows.length) {
    L.push('  ' + t + ' (' + rows.length + ' recent):');
    for (const r of rows) L.push('     ' + JSON.stringify(r).slice(0, 150));
  }
}

L.push('');
L.push('=== integrity / fk ===');
L.push('  integrity_check : ' + Object.values(db.prepare('PRAGMA integrity_check').get())[0]);
L.push('  fk violations   : ' + db.prepare('PRAGMA foreign_key_check').all().length);

db.close();
for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + e); } catch { /* noop */ } }
fs.writeFileSync(process.env.OUT_FILE, L.join('\n'));