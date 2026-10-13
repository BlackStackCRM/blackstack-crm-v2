/**
 * PHASE 3A — POST-CLEANUP GATE READINESS.
 *
 * PREPARED, NOT RUN. This script verifies that the full 16-gate suite is SAFE to
 * run, without running it. It exists so that the moment cleanup (A and B) is
 * authorized, gate verification is a single deliberate step rather than an
 * improvisation.
 *
 * WHY THE OWNER WITHHELD THE GATE RUN
 *   Gate 9 ("live database CONTENT unmodified") currently fails because the
 *   leaked bill BILL-2026-00001 is still in production. Running the suite before
 *   cleanup would fail that gate for a known reason, and — more importantly —
 *   would execute the whole suite, including its own E2E server boots, against a
 *   database known to hold test residue. Waiting costs nothing and removes a
 *   variable.
 *
 * WHAT THIS CHECKS
 *   1. Production is in the expected PRE-cleanup state (nothing changed behind us).
 *   2. FY locks are 1/1 and the bill sequence is next_seq = 2, as decided.
 *   3. Both DB backups still exist, still open, and still pass integrity + FK.
 *   4. The evidence archive is complete and matches production.
 *   5. No disposable-DB leak path is known to be open: the isolation tests that
 *      guard against it currently pass.
 *   6. The E2E port is free, so the gate run will not collide.
 *
 * NOTHING HERE DELETES, WRITES, OR BOOTS A SERVER.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROD = path.join(ROOT, 'data', 'blackstack-crm.db');

const L = [];
const say = (s = '') => L.push(s);
let FAIL = 0;
let WARN = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) FAIL++;
  say(`  [${cond ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  — ' + detail : ''}`);
};
const warn = (cond, label, detail = '') => {
  if (!cond) WARN++;
  say(`  [${cond ? 'OK  ' : 'WARN'}] ${label}${detail ? '  — ' + detail : ''}`);
};

function clone(tag) {
  const t = path.join(os.tmpdir(), `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
  for (const e of ['', '-wal', '-shm']) {
    if (fs.existsSync(PROD + e)) fs.copyFileSync(PROD + e, t + e);
  }
  return t;
}

say('════════════════════════════════════════════════════════════════');
say('PHASE 3A — POST-CLEANUP GATE READINESS (prepared, not executed)');
say(`generated: ${new Date().toISOString()}`);
say('════════════════════════════════════════════════════════════════');
say('');
say('Owner decisions in force:');
say('  A (six probe journal entries) .......... HOLD');
say('  B (leaked BILL-2026-00001 + 4 rows) .... HOLD');
say('  financial_years.is_locked ............... keep 1 / 1');
say('  number_sequences CUSTOMER_BILL.next_seq . keep 2');
say('');

/* ── 1. production is in the expected PRE-cleanup state ──────────────── */
say('--- 1. production state (must still be PRE-cleanup) ---');
{
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(clone('ready'), { readOnly: true });
  const je = db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c;
  const jl = db.prepare('SELECT COUNT(*) c FROM journal_entry_lines').get().c;
  const bills = db.prepare('SELECT COUNT(*) c FROM bills').get().c;
  ok(je === 31, 'journal_entries == 31 (25 genuine + 6 probes)', String(je));
  ok(jl === 112, 'journal_entry_lines == 112', String(jl));
  ok(bills === 1, 'bills == 1 (the leaked BILL-2026-00001, not yet removed)', String(bills));

  /* ── 2. FY locks + sequence, per owner decision ───────────────────── */
  say('');
  say('--- 2. preserved-by-decision state ---');
  const fy = db.prepare('SELECT id, is_locked FROM financial_years ORDER BY id').all();
  ok(fy.length === 2, 'two financial years present', String(fy.length));
  ok(fy.every((f) => f.is_locked === 1),
    'BOTH financial years still is_locked = 1', fy.map((f) => `${f.id}=${f.is_locked}`).join(' '));
  const seq = db.prepare("SELECT next_seq FROM number_sequences WHERE entity_type='CUSTOMER_BILL'").get();
  ok(seq && seq.next_seq === 2, 'CUSTOMER_BILL.next_seq == 2 (not reset)', String(seq && seq.next_seq));
  const auditLogs = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c;
  ok(auditLogs === 431, 'audit_logs == 431 (history preserved)', String(auditLogs));
  const integ = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
  const fkv = db.prepare('PRAGMA foreign_key_check').all().length;
  ok(integ === 'ok', 'integrity_check ok', integ);
  ok(fkv === 0, 'foreign_key_check 0 violations', String(fkv));
  db.close();
}

/* ── 3. backups still usable ─────────────────────────────────────────── */
say('');
say('--- 3. backups still restorable ---');
const BK = {
  'pre-leak': path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'bs-backup-20261009-205746', 'db', 'blackstack-crm.db'),
  'current': path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'bs-backup2-20261009-214827', 'db', 'blackstack-crm.db'),
};
for (const [label, p] of Object.entries(BK)) {
  if (!fs.existsSync(p)) { ok(false, `${label} backup exists`, p); continue; }
  const dest = path.join(os.tmpdir(), `ready-${label}-${Date.now()}.db`);
  fs.copyFileSync(p, dest); // the actual restore operation
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dest);
    const integ = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
    const fkv = db.prepare('PRAGMA foreign_key_check').all().length;
    const n = db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c;
    db.close();
    ok(integ === 'ok' && fkv === 0 && n === 31,
      `${label} backup restores cleanly`, `integrity=${integ} fk=${fkv} je=${n}`);
  } finally {
    try { fs.unlinkSync(dest); } catch { /* noop */ }
  }
}

/* ── 4. evidence archive still complete ──────────────────────────────── */
say('');
say('--- 4. evidence archive still complete ---');
{
  const out = path.join(os.tmpdir(), `ready-archive-${Date.now()}.txt`);
  const r = spawnSync(process.execPath, ['scripts/phase-3a-verify-cleanup.js'], {
    cwd: ROOT, encoding: 'utf8', timeout: 180000, env: { ...process.env, OUT_FILE: out },
  });
  if (r.status !== 0) {
    ok(false, 'archive+rehearsal script ran', (r.stderr || '').slice(0, 120));
  } else {
    const text = fs.readFileSync(out, 'utf8');
    ok(!text.includes('[FAIL]'), 'archive completeness + rehearsal: no failed check');
    ok(text.includes('OVERALL: READY FOR AUTHORIZATION'), 'rehearsal reports READY');
  }
}

/* ── 5. isolation guards that prevent a repeat leak are green ────────── */
say('');
say('--- 5. anti-leak guards currently green ---');
{
  const suites = [
    'tests/phase-3a-db-isolation-guard.test.js',
    'tests/phase-3a-db-bind-isolation.test.js',
    'tests/phase-3a-cleanup-plan-verification.test.js',
    'tests/phase-3a-fy-lock-policy.test.js',
  ];
  for (const s of suites) {
    // On Windows, `npx` is a .cmd shim and spawnSync cannot exec it directly
    // (that yields status === null / ENOENT). Use vitest's JS entry directly.
    const r = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', s], {
      cwd: ROOT, encoding: 'utf8', timeout: 420000,
      env: { ...process.env, CI: '1' },
    });
    // vitest writes ANSI colour codes BETWEEN the label and the count, e.g.
    //   " Test Files \e[22m 1 passed"
    // so a plain /Tests\s+(\d+)\s+passed/ never matches. Strip ANSI first.
    const raw = (r.stdout || '') + (r.stderr || '');
    const text = raw.replace(/\u001b\[[0-9;]*m/g, '');
    const m = text.match(/Tests\s+(\d+)\s+passed/);
    const failedCount = text.match(/Tests\s+.*?(\d+)\s+failed/);
    const failed = !!failedCount || text.includes('[FAIL]');
    ok(r.status === 0 && m && !failed, s,
      m ? `${m[1]} passed${failedCount ? `, ${failedCount[1]} FAILED` : ''}` : `exit=${r.status}`);
  }
}

/* ── 6. E2E port free ───────────────────────────────────────────────── */
say('');
say('--- 6. gate preconditions ---');
const port = Number(process.env.E2E_PORT || 32400);
function portIsFree(p) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(p, '127.0.0.1');
  });
}

async function main() {
const free = await portIsFree(port);
warn(free, `E2E_PORT ${port} is free`, free ? '' : 'another process holds it; the gate refuses to run');

const runner = fs.existsSync(path.join(ROOT, 'scripts', 'run-one-e2e.js'));
ok(runner, 'scripts/run-one-e2e.js present (gates 7/8 need it)');

say('');
say('════════════════════════════════════════════════════════════════');
if (FAIL === 0) {
  say('READINESS: READY — the 16-gate suite is safe to run when authorized.');
} else {
  say(`READINESS: NOT READY — ${FAIL} blocking check(s) failed.`);
}
if (WARN) say(`${WARN} warning(s) — non-blocking.`);
say('');
say('The gate suite has NOT been executed by this script. It only confirms the');
say('run would be safe. Run it explicitly with:');
say(`  E2E_PORT=${port} npm run test:release`);
say('');
say('A and B remain unauthorized. No production record has been deleted.');
say('════════════════════════════════════════════════════════════════');

fs.writeFileSync(process.env.OUT_FILE, L.join('\n'));
console.error(`blocking failures: ${FAIL}, warnings: ${WARN}`);
}

main().catch((e) => {
  say('');
  say('READINESS SCRIPT ERROR: ' + (e && e.message));
  fs.writeFileSync(process.env.OUT_FILE, L.join('\n'));
  console.error(e);
  process.exitCode = 1;
});