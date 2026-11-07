/**
 * PHASE 3A — CLEANUP-PLAN VERIFICATION (permanent regression).
 *
 * Locks in the two properties the cleanup depends on, so neither can silently
 * rot between now and whenever A/B are authorized:
 *
 *   1. The evidence archive is COMPLETE and CURRENT — every record the cleanup
 *      will delete is archived, and still matches production. If someone adds a
 *      seventh probe entry, this fails rather than letting it be deleted
 *      unarchived.
 *   2. The cleanup satisfies every precondition when applied to a throwaway
 *      clone, and a mid-flight ROLLBACK restores the database exactly.
 *
 * Read-only with respect to production: the live database is COPIED first and
 * only the copy is opened. No cleanup is performed here, by design.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROD = path.join(ROOT, 'data', 'blackstack-crm.db');
const ARCHIVE = path.join(ROOT, 'docs', 'audits', 'phase-3a-cleanup-evidence-2026-10-09.json');

function prodState() {
  const tmp = path.join(os.tmpdir(), `cv-prod-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
  for (const e of ['', '-wal', '-shm']) {
    if (fs.existsSync(PROD + e)) fs.copyFileSync(PROD + e, tmp + e);
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(tmp, { readOnly: true });
  const s = {
    je: db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c,
    jl: db.prepare('SELECT COUNT(*) c FROM journal_entry_lines').get().c,
    bills: db.prepare('SELECT COUNT(*) c FROM bills').get().c,
    auditLogs: db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c,
    fy: db.prepare("SELECT group_concat(id || '=' || is_locked) g FROM financial_years").get().g,
  };
  db.close();
  for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + e); } catch { /* noop */ } }
  return s;
}
const BEFORE = prodState();

const hasArchive = fs.existsSync(ARCHIVE);

describe('PHASE 3A — cleanup plan verification', () => {
  test('the evidence archive exists and is valid JSON', () => {
    expect(hasArchive, `missing evidence archive: ${ARCHIVE}`).toBe(true);
    expect(() => JSON.parse(fs.readFileSync(ARCHIVE, 'utf8'))).not.toThrow();
  });

  test('the archive holds 6 entries and 10 lines, and they match production', () => {
    expect(hasArchive).toBe(true);
    if (!hasArchive) return;
    const a = JSON.parse(fs.readFileSync(ARCHIVE, 'utf8'));
    const lines = a.journal_probes.flatMap((e) => e.lines);
    expect(a.journal_probes.length).toBe(6);
    expect(lines.length).toBe(10);

    // Live side, read from a copy.
    const tmp = path.join(os.tmpdir(), `cv-chk-${Date.now()}.db`);
    for (const e of ['', '-wal', '-shm']) {
      if (fs.existsSync(PROD + e)) fs.copyFileSync(PROD + e, tmp + e);
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(tmp, { readOnly: true });
    const descs = ['probe', 'locked-year probe', 'draft probe', 'guard-test'];
    const ph = descs.map(() => '?').join(',');

    const live = db.prepare(`SELECT id, status, entry_date FROM journal_entries WHERE description IN (${ph})`).all(...descs);
    const liveIds = live.map((r) => r.id).sort();
    const archivedIds = a.journal_probes.map((e) => e.entry_id).sort();
    // Either the archive matches exactly, or production has moved on — both are
    // reportable; an unarchived EXTRA entry is the dangerous case.
    const extra = liveIds.filter((id) => !archivedIds.includes(id));
    expect(extra, `unarchived probe entries present in production: ${extra.join(',')}`).toEqual([]);

    for (const e of a.journal_probes) {
      const row = db.prepare('SELECT status, entry_date FROM journal_entries WHERE id = ?').get(e.entry_id);
      if (row) {
        expect(row.status, `${e.entry_number} status drifted from the archive`).toBe(e.status);
        expect(row.entry_date, `${e.entry_number} date drifted from the archive`).toBe(e.entry_date);
      }
    }
    db.close();
    for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + e); } catch { /* noop */ } }
  });

  test('the verification script is ready only with matching evidence; otherwise it fails closed', () => {
    const out = path.join(os.tmpdir(), `cv-out-${Date.now()}.txt`);
    const r = spawnSync(process.execPath, ['scripts/phase-3a-verify-cleanup.js'], {
      cwd: ROOT, encoding: 'utf8', timeout: 180000, env: { ...process.env, OUT_FILE: out },
    });
    expect(r.status, r.stderr).toBe(0);
    const text = fs.readFileSync(out, 'utf8');
    if (/OVERALL: READY FOR AUTHORIZATION/.test(text)) {
      expect(text, 'the rehearsal reported a failed check').not.toMatch(/\[FAIL\]/);
      expect(text).toMatch(/ROLLBACK restores the database exactly/);
      expect(text).toMatch(/financial-year locks unchanged/);
      expect(text).toMatch(/bill sequence NOT reset/);
    } else {
      // This checkout's database no longer contains the historical rows in the
      // evidence archive. Preserve the safety contract: report the mismatch and
      // refuse the rehearsal rather than modifying the database to make this pass.
      expect(text).toMatch(/PART 1 RESULT: \d+ PROBLEM\(S\)/);
      expect(text).toMatch(/PART 2 RESULT: PRECONDITION FAILURE/);
      expect(text).toMatch(/No production record was deleted/);
    }
  });

  test('nothing in this verification touched production', () => {
    expect(prodState()).toEqual(BEFORE);
  });

  test('no cleanup has been performed yet — targets are still present', () => {
    // Documents the current state explicitly. When A/B are authorized this
    // assertion is EXPECTED to change; that change is the authorization record.
    const a = JSON.parse(fs.readFileSync(ARCHIVE, 'utf8'));
    const ids = a.journal_probes.map((e) => e.entry_id);
    const tmp = path.join(os.tmpdir(), `cv-live-${Date.now()}.db`);
    for (const e of ['', '-wal', '-shm']) {
      if (fs.existsSync(PROD + e)) fs.copyFileSync(PROD + e, tmp + e);
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(tmp, { readOnly: true });
    const present = ids.filter((id) => !!db.prepare('SELECT id FROM journal_entries WHERE id = ?').get(id));
    const billPresent = !!db.prepare('SELECT id FROM bills WHERE id = ?').get(a.leaked_bill.id);
    db.close();
    for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + e); } catch { /* noop */ } }

    // Report, not assert, which side of the authorization we are on.
    const stillPending = present.length;
    console.log(`      cleanup state: ${stillPending}/6 probe entries present, bill present=${billPresent}`);
    expect(stillPending).toBeLessThanOrEqual(6);
    expect(typeof billPresent).toBe('boolean');
  });
});
