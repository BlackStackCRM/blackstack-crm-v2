/**
 * STEP A — READ-ONLY production incident verification.
 *
 * OPENSTRICTLY READ-ONLY. Copies the database (plus -wal/-shm) into a temp
 * snapshot and inspects that, so the live file is never opened for write.
 *
 * Purpose: establish exactly what the five audit-probe journal entries did to
 * production — their IDs, statuses, amounts, and whether they moved any
 * account balance or report total.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SRC = path.resolve('data/blackstack-crm.db');
const tmp = path.join(os.tmpdir(), 'p3a-incident-' + Date.now() + '.db');
for (const e of ['', '-wal', '-shm']) {
  if (fs.existsSync(SRC + e)) fs.copyFileSync(SRC + e, tmp + e);
}
const db = new DatabaseSync(tmp, { readOnly: true });
const L = [];
const one = (s, ...a) => db.prepare(s).get(...a);
const all = (s, ...a) => db.prepare(s).all(...a);

L.push('=== INTEGRITY ===');
L.push('  integrity_check   : ' + Object.values(one('PRAGMA integrity_check'))[0]);
L.push('  foreign_key_check : ' + all('PRAGMA foreign_key_check').length + ' violations');

L.push('');
L.push('=== THE FIVE PROBE ENTRIES (identified by description/entry_number) ===');
const probes = all(`
  SELECT id, entry_number, entry_date, description, status, total_debit, total_credit,
         created_at, posted_at, created_by, financial_year_id, voucher_id
    FROM journal_entries
   WHERE entry_number LIKE 'JE-%' OR description IN ('probe','locked-year probe','draft probe')
   ORDER BY created_at`);
for (const p of probes) {
  L.push('  --------------------------------------------------');
  L.push('  id            : ' + p.id);
  L.push('  entry_number  : ' + p.entry_number);
  L.push('  entry_date    : ' + p.entry_date + '   status: ' + p.status);
  L.push('  description   : ' + p.description);
  L.push('  total_debit   : ' + p.total_debit + '   total_credit: ' + p.total_credit);
  L.push('  created_at    : ' + p.created_at + '   posted_at: ' + (p.posted_at || 'null'));
  L.push('  created_by    : ' + p.created_by + '   fy: ' + p.financial_year_id + '   voucher: ' + p.voucher_id);
  const lines = all('SELECT id, account_id, debit_amount, credit_amount, description FROM journal_entry_lines WHERE journal_entry_id = ? ORDER BY rowid', p.id);
  L.push('  lines (' + lines.length + '):');
  for (const l of lines) {
    L.push('     ' + l.id + '  account=' + l.account_id + '  dr=' + l.debit_amount + '  cr=' + l.credit_amount);
  }
}

L.push('');
L.push('=== GENUINE ENTRIES UNAFFECTED? ===');
const genuine = all("SELECT id, entry_number, entry_date, description FROM journal_entries WHERE entry_number LIKE 'JV-%' ORDER BY entry_number");
L.push('  genuine JV-* entries: ' + genuine.length + ' (expected 25)');
L.push('  first: ' + (genuine[0] ? genuine[0].entry_number + ' ' + genuine[0].entry_date : 'none'));
L.push('  last : ' + (genuine[genuine.length - 1] ? genuine[genuine.length - 1].entry_number + ' ' + genuine[genuine.length - 1].entry_date : 'none'));
const unbalancedGenuine = genuine.filter((g) => {
  const t = one('SELECT COALESCE(SUM(debit_amount),0) d, COALESCE(SUM(credit_amount),0) c FROM journal_entry_lines WHERE journal_entry_id = ?', g.id);
  return Math.abs(Number(t.d) - Number(t.c)) > 0.005;
});
L.push('  genuine entries that are UNBALANCED: ' + unbalancedGenuine.length);

L.push('');
L.push('=== DID THE PROBE ENTRIES MOVE ANY ACCOUNT BALANCE? ===');
const probeIds = probes.map((p) => p.id);
if (probeIds.length) {
  const ph = probeIds.map(() => '?').join(',');
  const moved = all(`
    SELECT a.code, a.name, a.type,
           COALESCE(SUM(l.debit_amount),0) AS dr,
           COALESCE(SUM(l.credit_amount),0) AS cr
      FROM journal_entry_lines l
      JOIN accounts a ON a.id = l.account_id
     WHERE l.journal_entry_id IN (${ph})
     GROUP BY a.id ORDER BY ABS(COALESCE(SUM(l.debit_amount),0) - COALESCE(SUM(l.credit_amount),0)) DESC`, ...probeIds);
  L.push('  accounts touched by probe entries: ' + moved.length);
  for (const m of moved) {
    L.push('     ' + m.code.padEnd(10) + ' ' + String(m.name).slice(0, 30).padEnd(32) +
           ' dr=' + m.dr + ' cr=' + m.cr + '  net=' + (Number(m.dr) - Number(m.cr)));
  }
  L.push('  >> Net across ALL probe lines: ' + (moved.reduce((s, m) => s + Number(m.dr) - Number(m.cr), 0)).toFixed(2) +
         '  (0 means the ledger is still balanced overall)');
}

L.push('');
L.push('=== TRIAL BALANCE — still balanced with the probes included? ===');
const tb = one(`
  SELECT COALESCE(SUM(l.debit_amount),0) AS dr, COALESCE(SUM(l.credit_amount),0) AS cr
    FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id`);
L.push('  all lines   : dr=' + tb.dr + '  cr=' + tb.cr + '  balanced=' + (Math.abs(Number(tb.dr) - Number(tb.cr)) < 0.005));
const tbGenuine = one(`
  SELECT COALESCE(SUM(l.debit_amount),0) AS dr, COALESCE(SUM(l.credit_amount),0) AS cr
    FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
   WHERE je.entry_number LIKE 'JV-%'`);
L.push('  genuine only: dr=' + tbGenuine.dr + '  cr=' + tbGenuine.cr + '  balanced=' + (Math.abs(Number(tbGenuine.dr) - Number(tbGenuine.cr)) < 0.005));

L.push('');
L.push('=== AUDIT LOG evidence ===');
L.push('  audit_logs total: ' + one('SELECT COUNT(*) c FROM audit_logs').c);
for (const a of all('SELECT created_at, action, entity_type, entity_id FROM audit_logs ORDER BY rowid DESC LIMIT 4')) {
  L.push('     ' + a.created_at + '  ' + a.action + '  ' + a.entity_type + '  ' + (a.entity_id || ''));
}
const jeAudit = one("SELECT COUNT(*) c FROM audit_logs WHERE entity_type LIKE '%journal%' OR entity_type LIKE '%Journal%'");
L.push('  audit rows referencing a journal entity: ' + jeAudit.c);

L.push('');
L.push('=== COUNTS ===');
for (const t of ['journal_entries', 'journal_entry_lines', 'accounts', 'audit_logs', 'vouchers',
  'bills', 'payments', 'bill_allocations', 'receivable_allocations', 'inventory_voucher_headers',
  'stock_ledger', 'stock_balances', 'contacts', 'products', 'users', 'organizations']) {
  L.push('  ' + t.padEnd(28) + one('SELECT COUNT(*) c FROM "' + t + '"').c);
}

db.close();
for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + e); } catch { /* noop */ } }
fs.writeFileSync(process.env.OUT_FILE, L.join('\n'));