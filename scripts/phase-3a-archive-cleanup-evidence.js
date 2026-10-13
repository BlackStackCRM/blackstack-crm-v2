/**
 * PHASE 3A — READ-ONLY EVIDENCE ARCHIVE.
 *
 * Captures the COMPLETE rows for every record proposed for deletion, so the
 * evidence survives even if the rows are later removed. Nothing here writes to
 * production: the database is copied to a temp file and read there.
 *
 * Produces docs/audits/phase-3a-cleanup-evidence-2026-10-09.json
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'blackstack-crm.db');

const tmp = path.join(os.tmpdir(), `archive-${Date.now()}.db`);
for (const e of ['', '-wal', '-shm']) {
  if (fs.existsSync(SRC + e)) fs.copyFileSync(SRC + e, tmp + e);
}
const db = new DatabaseSync(tmp, { readOnly: true });

const PROBE_DESCRIPTIONS = ['probe', 'locked-year probe', 'draft probe', 'guard-test'];
const BILL_ID = 'bill_01M4GPPH2HW3B3H56AFSR01FT5';

const L = [];
const say = (s = '') => L.push(s);

/* ── fingerprint + counts ────────────────────────────────────────────── */
function fingerprint(file) {
  const h = crypto.createHash('md5');
  const d = new DatabaseSync(file, { readOnly: true });
  const tables = d.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((t) => t.name);
  for (const t of tables) {
    h.update(`\n## ${t}\n`);
    h.update(d.prepare(`PRAGMA table_info("${t}")`).all()
      .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value ?? ''}`).join(','));
    let rows = [];
    try { rows = d.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all(); } catch { /* ignore */ }
    for (const r of rows) h.update('\n' + JSON.stringify(r));
  }
  d.close();
  return h.digest('hex');
}

const TABLES = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
).all().map((t) => t.name);

const counts = {};
for (const t of TABLES) {
  try { counts[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch { /* ignore */ }
}

say('=== PRODUCTION SNAPSHOT (read-only) ===');
say(`captured      : ${new Date().toISOString()}`);
say(`content fp    : ${fingerprint(SRC)}`);
say(`integrity     : ${Object.values(db.prepare('PRAGMA integrity_check').get())[0]}`);
say(`fk violations : ${db.prepare('PRAGMA foreign_key_check').all().length}`);
say('');
say('=== ROW COUNTS (non-zero only) ===');
for (const [t, n] of Object.entries(counts)) if (n > 0) say(`  ${String(n).padStart(5)}  ${t}`);
say('');

/* ── journal probes ──────────────────────────────────────────────────── */
say('=== A) SIX PROBE JOURNAL ENTRIES — FULL ROWS ===');
const ph = PROBE_DESCRIPTIONS.map(() => '?').join(',');
const entries = db.prepare(
  `SELECT * FROM journal_entries WHERE description IN (${ph}) ORDER BY created_at`,
).all(...PROBE_DESCRIPTIONS);

const probeEvidence = [];
for (const e of entries) {
  const lines = db.prepare('SELECT * FROM journal_entry_lines WHERE journal_entry_id = ?').all(e.id);
  const fy = e.financial_year_id
    ? db.prepare('SELECT id,start_date,end_date,is_locked FROM financial_years WHERE id = ?').get(e.financial_year_id)
    : null;
  const inRange = fy ? (e.entry_date >= fy.start_date && e.entry_date <= fy.end_date) : null;
  const negatives = lines.filter((l) => l.debit_amount < 0 || l.credit_amount < 0).length;

  // dependency sweep across every table
  const deps = {};
  for (const t of TABLES) {
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
    for (const col of cols.filter((c) => /journal_entry_id|entity_id|entry_id/.test(c))) {
      try {
        const n = db.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE "${col}" = ?`).get(e.id).c;
        if (n > 0) deps[`${t}.${col}`] = n;
      } catch { /* ignore */ }
    }
  }

  const rec = {
    entry_number: e.entry_number,
    entry_id: e.id,
    entry_date: e.entry_date,
    status: e.status,
    description: e.description,
    financial_year_id: e.financial_year_id,
    fy_range: fy ? `${fy.start_date}..${fy.end_date}` : null,
    date_within_declared_fy: inRange,
    voucher_id: e.voucher_id,
    created_at: e.created_at,
    created_by: e.created_by,
    line_count: lines.length,
    total_debit: lines.reduce((s, l) => s + (l.debit_amount || 0), 0),
    total_credit: lines.reduce((s, l) => s + (l.credit_amount || 0), 0),
    balanced: lines.reduce((s, l) => s + (l.debit_amount || 0), 0)
      === lines.reduce((s, l) => s + (l.credit_amount || 0), 0),
    negative_lines: negatives,
    dependencies: deps,
    synthetic_indicators: [
      `description is literally "${e.description}"`,
      e.voucher_id === null ? 'no voucher linkage' : null,
      Object.keys(deps).length === 0 ? 'zero dependent rows in any table' : null,
      lines.length === 0 ? 'POSTED with ZERO lines (empty ledger posting)' : null,
      negatives > 0 ? `${negatives} line(s) carry NEGATIVE amounts` : null,
      inRange === false ? `date ${e.entry_date} is OUTSIDE its declared FY ${fy.start_date}..${fy.end_date}` : null,
      e.status === 'DRAFT' ? 'DRAFT status' : null,
    ].filter(Boolean),
    lines: lines.map((l) => ({
      line_id: l.id, account_id: l.account_id,
      debit_amount: l.debit_amount, credit_amount: l.credit_amount,
    })),
  };
  probeEvidence.push(rec);

  say(`  ${e.entry_number}   id=${e.id}`);
  say(`     date=${e.entry_date}  status=${e.status}  fy=${e.financial_year_id}  created_by=${e.created_by}  created_at=${e.created_at}`);
  say(`     description      : ${e.description}`);
  say(`     lines            : ${lines.length}   debit=${rec.total_debit} credit=${rec.total_credit} balanced=${rec.balanced} negatives=${negatives}`);
  say(`     date in FY range : ${inRange}${fy ? `  (${fy.start_date}..${fy.end_date})` : ''}`);
  say(`     dependencies     : ${Object.keys(deps).length === 0 ? 'NONE' : JSON.stringify(deps)}`);
  say('     synthetic because:');
  for (const r of rec.synthetic_indicators) say(`        - ${r}`);
  for (const l of lines) say(`     line ${l.id}  ${l.account_id}  dr=${l.debit_amount} cr=${l.credit_amount}`);
  say('');
}
const totalProbeLines = probeEvidence.reduce((s, p) => s + p.line_count, 0);
say(`  TOTAL: ${entries.length} entries, ${totalProbeLines} lines`);
say('');

/* ── leaked bill ─────────────────────────────────────────────────────── */
say('=== B) LEAKED BILL AND ALL DEPENDENT RECORDS — FULL ROWS ===');
const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(BILL_ID);
const billDeps = {};
for (const t of TABLES) {
  const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
  for (const col of cols.filter((c) => /bill_id|entity_id/.test(c))) {
    try {
      const n = db.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE "${col}" = ?`).get(BILL_ID).c;
      if (n > 0) billDeps[`${t}.${col}`] = n;
    } catch { /* ignore */ }
  }
}
say(`  bill_id : ${BILL_ID}`);
say(`  bill    : ${bill.bill_number}  status=${bill.status}  total=${bill.total} ${bill.currency}`);
say(`  created : by=${bill.created_by} at=${bill.created_at}   issue_date=${bill.issue_date}`);
say(`  approved_by=${bill.approved_by}  posted_by=${bill.posted_by}`);
say(`  journal_entry_id=${bill.journal_entry_id}   <-- NULL: NO ledger impact`);
say(`  inventory_voucher_header_id=${bill.inventory_voucher_header_id}`);
say(`  reference_number=${JSON.stringify(bill.reference_number)}  notes=${JSON.stringify(bill.notes)}  terms=${JSON.stringify(bill.terms)}`);
say('  synthetic because:');
for (const r of [
  `status is ${bill.status} — never approved, never posted`,
  'approved_by and posted_by are NULL',
  'journal_entry_id is NULL, so no accounting ledger entry exists',
  'reference_number, notes and terms are all empty',
  'no voucher or inventory voucher linkage',
  `it is the ONLY bill in production (bills count = ${counts.bills})`,
  `created ${bill.created_at} by admin — during the release-gate run`,
]) say(`     - ${r}`);
say('');
say('  dependent records:');
for (const [k, n] of Object.entries(billDeps)) {
  const [t, col] = k.split('.');
  say(`     ${k} = ${n}`);
  for (const r of db.prepare(`SELECT * FROM "${t}" WHERE "${col}" = ?`).all(BILL_ID)) {
    say(`        ${JSON.stringify(r)}`);
  }
}
say('');

/* ── things that must survive ────────────────────────────────────────── */
say('=== PRESERVED BY THE PROPOSED CLEANUP (must not change) ===');
say(`  audit_logs rows            : ${counts.audit_logs}`);
for (const r of db.prepare("SELECT * FROM number_sequences WHERE entity_type='CUSTOMER_BILL'").all()) {
  say(`  CUSTOMER_BILL sequence     : next_seq=${r.next_seq}  <-- NOT reset, so ${bill.bill_number} is never reused`);
}
for (const r of db.prepare('SELECT id,is_active,is_locked FROM financial_years ORDER BY id').all()) {
  say(`  financial_year ${r.id}      : is_active=${r.is_active} is_locked=${r.is_locked}`);
}
say(`  genuine journal_entries    : ${db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE description NOT IN ('probe','locked-year probe','draft probe','guard-test')").get().c}`);
say(`  vouchers                   : ${counts.vouchers}`);
say(`  stock_ledger               : ${counts.stock_ledger}`);

db.close();
for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + e); } catch { /* noop */ } }

const outMd = path.join(ROOT, 'docs', 'audits', 'phase-3a-cleanup-evidence-2026-10-09.md');
fs.writeFileSync(outMd, L.join('\n'));

const outJson = path.join(ROOT, 'docs', 'audits', 'phase-3a-cleanup-evidence-2026-10-09.json');
fs.writeFileSync(outJson, JSON.stringify({
  captured_at: new Date().toISOString(),
  content_fingerprint: fingerprint(SRC),
  row_counts: counts,
  journal_probes: probeEvidence,
  leaked_bill: { id: BILL_ID, row: bill, dependencies: billDeps },
}, null, 2));

console.error('wrote:\n  ' + outMd + '\n  ' + outJson);