/**
 * PHASE 3A — READ-ONLY FINANCIAL YEAR CONFIGURATION AUDIT.
 *
 * STRICTLY READ-ONLY. Copies the database plus its -wal/-shm sidecars into a
 * temp snapshot and inspects that, so the live file is never opened for write.
 *
 * Purpose: establish what the intended financial-year configuration is, whether
 * the 2026-10-01..2026-10-05 genuine journal entries actually fall inside a
 * configured year, and how posting paths resolve and enforce the year.
 *
 * Context: the 2026-10-09 audit incident ran
 *   UPDATE financial_years SET is_locked = 1
 * against production. Both years now read is_locked=1. This audit does NOT judge
 * that value — it documents the configuration so the owner can decide.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SRC = path.resolve('data/blackstack-crm.db');
const tmp = path.join(os.tmpdir(), 'fyaudit-' + Date.now() + '.db');
for (const e of ['', '-wal', '-shm']) {
  if (fs.existsSync(SRC + e)) fs.copyFileSync(SRC + e, tmp + e);
}
const db = new DatabaseSync(tmp, { readOnly: true });
const L = [];
const one = (s, ...a) => db.prepare(s).get(...a);
const all = (s, ...a) => db.prepare(s).all(...a);

L.push('=== 1. FINANCIAL YEAR RECORDS (verbatim) ===');
const fys = all('SELECT * FROM financial_years ORDER BY start_date');
for (const f of fys) L.push('   ' + JSON.stringify(f));
L.push('');
L.push('  active  : ' + (fys.filter((f) => f.is_active).map((f) => f.id).join(', ') || '(none)'));
L.push('  locked  : ' + (fys.filter((f) => f.is_locked).map((f) => f.id).join(', ') || '(none)'));
L.push('  columns : ' + all('PRAGMA table_info(financial_years)').map((c) => c.name).join(', '));

L.push('');
L.push('=== 2. WHICH YEAR DO THE 25 GENUINE ENTRIES BELONG TO? ===');
const genuine = all(`
  SELECT je.id, je.entry_number, je.entry_date, je.status, je.financial_year_id,
         je.total_debit, je.total_credit
    FROM journal_entries je
   WHERE je.entry_number LIKE 'JV-%'
   ORDER BY je.entry_number`);
L.push('  genuine JV-* entries: ' + genuine.length);

const dates = genuine.map((g) => g.entry_date).sort();
L.push('  entry_date range   : ' + dates[0] + '  ..  ' + dates[dates.length - 1]);

// Resolve each entry's date against the configured years.
const unresolved = [];
for (const g of genuine) {
  const hit = fys.find((f) => g.entry_date >= f.start_date && g.entry_date <= f.end_date);
  if (!hit) unresolved.push(g);
}
L.push('  entries whose date falls INSIDE a configured year : ' + (genuine.length - unresolved.length) + '/' + genuine.length);
L.push('  entries whose date falls OUTSIDE every year       : ' + unresolved.length + '/' + genuine.length);
if (unresolved.length) {
  L.push('  OUTSIDE entries:');
  for (const g of unresolved.slice(0, 30)) {
    L.push('     ' + g.entry_number + '  date=' + g.entry_date + '  fy_id=' + g.financial_year_id + '  status=' + g.status);
  }
}

L.push('');
L.push('  stored financial_year_id on genuine entries:');
const byFyId = {};
for (const g of genuine) byFyId[g.financial_year_id === null ? '(null)' : g.financial_year_id] =
  (byFyId[g.financial_year_id === null ? '(null)' : g.financial_year_id] || 0) + 1;
for (const [k, v] of Object.entries(byFyId)) L.push('     ' + k + ' -> ' + v + ' entries');

L.push('');
L.push('  DISTINCT entry_date values on genuine entries:');
for (const r of all(`SELECT entry_date, COUNT(*) n FROM journal_entries
                      WHERE entry_number LIKE 'JV-%' GROUP BY entry_date ORDER BY entry_date`)) {
  L.push('     ' + r.entry_date + '  ->  ' + r.n);
}

L.push('');
L.push('=== 3. DOES ANY OTHER TABLE CARRY A financial_year_id? ===');
const tables = all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((t) => t.name);
for (const t of tables) {
  const cols = all('PRAGMA table_info("' + t + '")').map((c) => c.name);
  if (cols.includes('financial_year_id')) {
    const n = one('SELECT COUNT(*) c FROM "' + t + '" WHERE financial_year_id IS NOT NULL').c;
    const distinct = all('SELECT DISTINCT financial_year_id FROM "' + t + '" WHERE financial_year_id IS NOT NULL').map((r) => r.financial_year_id);
    L.push('   ' + t.padEnd(24) + ' rows_with_fy=' + String(n).padStart(3) + '  values=' + JSON.stringify(distinct));
  }
}

L.push('');
L.push('=== 4. year_end_closings / locking artefacts ===');
for (const t of ['year_end_closings', 'accounting_audit', 'audit_logs']) {
  if (!tables.includes(t)) { L.push('   ' + t + ': ABSENT'); continue; }
  L.push('   ' + t + ': ' + one('SELECT COUNT(*) c FROM "' + t + '"').c + ' rows');
}
const yc = all("SELECT * FROM year_end_closings");
if (yc.length) for (const r of yc) L.push('     ' + JSON.stringify(r).slice(0, 150));

L.push('');
L.push('=== 5. WHICH ACCOUNTING TABLES USE financial_years AT ALL (code reference) ===');
L.push('   (populated by the caller-side scan; DB facts above are authoritative)');

db.close();
for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + e); } catch { /* noop */ } }
fs.writeFileSync(process.env.OUT_FILE, L.join('\n'));