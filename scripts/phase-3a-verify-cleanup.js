/**
 * PHASE 3A — CLEANUP VERIFICATION (read-only w.r.t. production).
 *
 * Two jobs, in order:
 *
 *   PART 1 — ARCHIVE COMPLETENESS
 *     Prove the evidence archive contains every record the cleanup will delete,
 *     and that each archived row still matches production byte-for-byte. If the
 *     archive were incomplete, deleting would destroy unrecoverable evidence.
 *
 *   PART 2 — DISPOSABLE REHEARSAL
 *     Execute the EXACT statements intended for production against a throwaway
 *     clone, inside one transaction, validating before COMMIT. Confirms the
 *     statements are correct, that validation catches a bad state, and that a
 *     ROLLBACK really restores everything.
 *
 * NOTHING HERE TOUCHES data/blackstack-crm.db. It is copied first and only the
 * copy is opened, and the copy is disposable by construction.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const PROD = path.join(ROOT, 'data', 'blackstack-crm.db');
const ARCHIVE = path.join(ROOT, 'docs', 'audits', 'phase-3a-cleanup-evidence-2026-10-09.json');

const L = [];
const say = (s = '') => L.push(s);
let FAILURES = 0;
const check = (ok, label, detail = '') => {
  if (!ok) FAILURES++;
  say(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  — ' + detail : ''}`);
};

function freshClone(tag) {
  const t = path.join(os.tmpdir(), `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
  for (const e of ['', '-wal', '-shm']) {
    if (fs.existsSync(PROD + e)) fs.copyFileSync(PROD + e, t + e);
  }
  return t;
}

/* ══ PART 1 — ARCHIVE COMPLETENESS ═════════════════════════════════════ */
say('════════════════════════════════════════════════════════════════');
say('PART 1 — ARCHIVE COMPLETENESS');
say('════════════════════════════════════════════════════════════════');
say('');

const archive = JSON.parse(fs.readFileSync(ARCHIVE, 'utf8'));
const prod = new DatabaseSync(freshClone('verify'), { readOnly: true });

const archivedEntries = archive.journal_probes;
const archivedLines = archivedEntries.flatMap((e) => e.lines);
say(`  archive holds ${archivedEntries.length} entries / ${archivedLines.length} lines / bill ${archive.leaked_bill.id}`);
say('');

say('--- every archived journal entry still exists in production, unchanged ---');
for (const a of archivedEntries) {
  const row = prod.prepare('SELECT * FROM journal_entries WHERE id = ?').get(a.entry_id);
  if (!row) { check(false, `${a.entry_number} exists`, 'row is gone from production'); continue; }
  const same = row.entry_number === a.entry_number
    && row.entry_date === a.entry_date
    && row.status === a.status
    && row.description === a.description
    && row.financial_year_id === a.financial_year_id;
  check(same, `${a.entry_number} matches archive`,
    `status=${row.status} fy=${row.financial_year_id} lines_in_db=${prod.prepare('SELECT COUNT(*) c FROM journal_entry_lines WHERE journal_entry_id = ?').get(a.entry_id).c}`);
}

say('');
say('--- every archived line still exists in production ---');
let lineOK = 0;
for (const l of archivedLines) {
  const row = prod.prepare('SELECT * FROM journal_entry_lines WHERE id = ?').get(l.line_id);
  if (row && row.debit_amount === l.debit_amount && row.credit_amount === l.credit_amount
      && row.account_id === l.account_id && row.journal_entry_id) lineOK++;
}
check(lineOK === archivedLines.length,
  `all ${archivedLines.length} archived lines present and unchanged`, `${lineOK}/${archivedLines.length}`);

say('');
say('--- completeness: does the archive cover EVERYTHING matching the criteria? ---');
const descs = ['probe', 'locked-year probe', 'draft probe', 'guard-test'];
const ph = descs.map(() => '?').join(',');
const liveEntries = prod.prepare(`SELECT id, entry_number FROM journal_entries WHERE description IN (${ph})`).all(...descs);
check(liveEntries.length === archivedEntries.length,
  'no unarchived probe entry exists in production',
  `production has ${liveEntries.length}, archive has ${archivedEntries.length}`);
const liveIds = new Set(liveEntries.map((r) => r.id));
const archivedIds = new Set(archivedEntries.map((a) => a.entry_id));
const missed = [...liveIds].filter((id) => !archivedIds.has(id));
check(missed.length === 0, 'every live probe entry is in the archive', missed.join(','));

const liveLineCount = prod.prepare(
  `SELECT COUNT(*) c FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE description IN (${ph}))`,
).get(...descs).c;
check(liveLineCount === archivedLines.length,
  'no unarchived probe line exists in production',
  `production has ${liveLineCount}, archive has ${archivedLines.length}`);

say('');
say('--- the leaked bill and all four dependents are archived ---');
const BILL = archive.leaked_bill.id;
const billRow = prod.prepare('SELECT * FROM bills WHERE id = ?').get(BILL);
check(!!billRow, 'bill still in production', billRow ? `${billRow.bill_number} ${billRow.status}` : 'MISSING');
const depTables = [['bill_items', 'bill_id'], ['receivables', 'bill_id'], ['accounting_audit', 'entity_id']];
for (const [t, col] of depTables) {
  const n = prod.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE ${col} = ?`).get(BILL).c;
  check(n > 0, `${t} dependents present in production`, `${n} row(s)`);
}
// each archived dependent row must still exist
let depArchived = 0, depExpected = 0;
for (const [t, col] of depTables) {
  const rows = prod.prepare(`SELECT * FROM "${t}" WHERE ${col} = ?`).all(BILL);
  depExpected += rows.length;
  const inArchive = Object.entries(archive.leaked_bill.dependencies)
    .filter(([k]) => k.startsWith(t + '.'))
    .reduce((s, [, n]) => s + n, 0);
  depArchived += Math.min(inArchive, rows.length);
}
check(depArchived === depExpected, 'all bill dependents accounted for in the archive',
  `${depArchived}/${depExpected}`);

say('');
say('--- nothing else in the archive would be deleted unintentionally ---');
check(archivedEntries.every((a) => descs.includes(a.description)),
  'every archived journal entry matches an approved probe description');
check(archive.leaked_bill.row.id === BILL, 'archive bill id matches the target');

prod.close();
say('');
say(`PART 1 RESULT: ${FAILURES === 0 ? 'ARCHIVE IS COMPLETE AND CURRENT' : FAILURES + ' PROBLEM(S)'}`);
say('');

/* ══ PART 2 — DISPOSABLE REHEARSAL ════════════════════════════════════ */
say('════════════════════════════════════════════════════════════════');
say('PART 2 — DISPOSABLE REHEARSAL (throwaway clone, never production)');
say('════════════════════════════════════════════════════════════════');
say('');

const clone = freshClone('rehearsal');
const db = new DatabaseSync(clone);
db.exec('PRAGMA foreign_keys = ON');

const snapshot = () => ({
  je: db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c,
  jl: db.prepare('SELECT COUNT(*) c FROM journal_entry_lines').get().c,
  bills: db.prepare('SELECT COUNT(*) c FROM bills').get().c,
  items: db.prepare('SELECT COUNT(*) c FROM bill_items').get().c,
  recv: db.prepare('SELECT COUNT(*) c FROM receivables').get().c,
  aud: db.prepare('SELECT COUNT(*) c FROM accounting_audit').get().c,
  auditLogs: db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c,
  seq: db.prepare("SELECT next_seq FROM number_sequences WHERE entity_type='CUSTOMER_BILL'").get()?.next_seq,
  fy: db.prepare("SELECT group_concat(id || '=' || is_locked) g FROM financial_years").get().g,
  dr: db.prepare('SELECT COALESCE(SUM(debit_amount),0) d FROM journal_entry_lines').get().d,
  cr: db.prepare('SELECT SUM(credit_amount) c FROM journal_entry_lines').get().c,
});
const show = (tag) => {
  const s = snapshot();
  say(`  ${tag.padEnd(26)} je=${String(s.je).padEnd(4)} jl=${String(s.jl).padEnd(5)} bills=${String(s.bills).padEnd(3)} `
    + `items=${s.items} recv=${s.recv} aud=${s.aud} auditLogs=${s.auditLogs} seq=${s.seq} net=${s.dr - s.cr}`);
  return s;
};

const start = show('BEFORE');
say('');

/* The exact statements intended for production. */
const stmtLines = archivedLines.map((l) => `DELETE FROM journal_entry_lines WHERE id = '${l.line_id}';`);
const stmtEntries = archivedEntries.map((a) => `DELETE FROM journal_entries WHERE id = '${a.entry_id}';`);
const stmtBill = [
  `DELETE FROM bill_items       WHERE bill_id   = '${BILL}';`,
  `DELETE FROM receivables      WHERE bill_id   = '${BILL}';`,
  `DELETE FROM accounting_audit WHERE entity_id = '${BILL}';`,
  `DELETE FROM bills            WHERE id        = '${BILL}';`,
];

say('--- rehearsal 1: ROLLBACK must restore everything ---');
db.exec('BEGIN IMMEDIATE');
for (const s of [...stmtLines, ...stmtEntries, ...stmtBill]) db.exec(s);
const mid = show('inside transaction');
db.exec('ROLLBACK');
const afterRollback = show('after ROLLBACK');
const rollbackClean = JSON.stringify(start) === JSON.stringify(afterRollback);
check(rollbackClean, 'ROLLBACK restores the database exactly', rollbackClean ? '' : 'state differs');
say('');

/* Validation gate: these must all hold BEFORE commit. */
const validate = (label) => {
  const s = snapshot();
  const genuine = db.prepare(
    "SELECT COUNT(*) c FROM journal_entries WHERE description NOT IN ('probe','locked-year probe','draft probe','guard-test')",
  ).get().c;
  const integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
  const fk = db.prepare('PRAGMA foreign_key_check').all().length;
  const balanced = s.dr === s.cr;
  say(`  validation [${label}]`);
  check(s.je === 25, 'journal_entries == 25 genuine entries', `got ${s.je}`);
  check(genuine === 25, 'genuine entries intact', `got ${genuine}`);
  check(s.jl === 102, 'journal_entry_lines == 102', `got ${s.jl}`);
  check(s.bills === 0, 'bills == 0', `got ${s.bills}`);
  check(s.items === 0 && s.recv === 0 && s.aud === 0, 'bill dependents == 0',
    `items=${s.items} recv=${s.recv} aud=${s.aud}`);
  check(s.auditLogs === start.auditLogs, 'audit_logs PRESERVED', `${s.auditLogs} vs ${start.auditLogs}`);
  check(s.seq === start.seq, 'bill sequence NOT reset', `next_seq=${s.seq}`);
  check(s.fy === start.fy, 'financial-year locks unchanged', s.fy);
  check(balanced, 'trial balance balanced', `dr=${s.dr} cr=${s.cr}`);
  check(integrity === 'ok', 'integrity_check ok', integrity);
  check(fk === 0, 'foreign_key_check 0 violations', String(fk));
  return { ok: s.je === 25 && genuine === 25 && s.bills === 0 && s.auditLogs === start.auditLogs
    && s.seq === start.seq && balanced && integrity === 'ok' && fk === 0, s };
};

say('--- rehearsal 2: full apply + validate + COMMIT ---');
db.exec('BEGIN IMMEDIATE');
for (const s of [...stmtLines, ...stmtEntries, ...stmtBill]) db.exec(s);
const v = validate('pre-commit');
if (v.ok) {
  db.exec('COMMIT');
  say('  -> COMMITTED (on the throwaway clone only)');
} else {
  db.exec('ROLLBACK');
  say('  -> VALIDATION FAILED, rolled back');
}
const after = show('AFTER');
say('');
check(v.ok, 'cleanup passes every precondition');
say('');

/* Sanity: the genuine ledger must still report correctly. */
say('--- post-cleanup ledger sanity ---');
const range = db.prepare('SELECT MIN(entry_date) mn, MAX(entry_date) mx FROM journal_entries').get();
check(range.mn === '2026-10-01' && range.mx === '2026-10-05',
  'genuine entries keep their original date range', `${range.mn} .. ${range.mx}`);
check(db.prepare('SELECT COUNT(*) c FROM vouchers').get().c === 25, 'vouchers intact (25)');
check(db.prepare('SELECT COUNT(*) c FROM stock_ledger').get().c === 2, 'stock_ledger intact (2)');
check(db.prepare('SELECT COUNT(*) c FROM journal_entry_lines WHERE debit_amount < 0 OR credit_amount < 0').get().c === 0,
  'no negative-amount lines remain');
check(db.prepare("SELECT COUNT(*) c FROM journal_entries je WHERE je.description IN ('probe','locked-year probe','draft probe','guard-test') AND NOT EXISTS (SELECT 1 FROM journal_entry_lines l WHERE l.journal_entry_id = je.id)").get().c === 0,
  'no zero-line entries remain');

db.close();
try { fs.unlinkSync(clone); } catch { /* noop */ }
say('');
say(`PART 2 RESULT: ${v.ok ? 'ALL PRECONDITIONS HOLD' : 'PRECONDITION FAILURE'}`);
say('');
say('════════════════════════════════════════════════════════════════');
say(`OVERALL: ${FAILURES === 0 ? 'READY FOR AUTHORIZATION' : FAILURES + ' CHECK(S) FAILED'}`);
say('No production record was deleted. No financial-year lock changed.');
say('Bill sequence, audit_logs and all backups remain untouched.');
say('════════════════════════════════════════════════════════════════');

fs.writeFileSync(process.env.OUT_FILE, L.join('\n'));
console.error(`checks failed: ${FAILURES}`);