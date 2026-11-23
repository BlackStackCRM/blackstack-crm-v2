/**
 * STALE TEST TEMP-DIRECTORY SWEEP (incident follow-up, §29.4 / §30)
 *
 * On 2026-11-23 the C:\ drive hit ENOSPC: 343 orphaned `bscrm-*` temp
 * directories (~3 GB) had accumulated from test runs whose process was
 * killed before the in-process exit/signal cleanup could fire (hard crash,
 * IDE stop, power loss). createDisposableDb() already removes its own
 * directory on exit, on SIGINT/SIGTERM and via a delayed sweep — but no
 * handler can run after a hard kill. Those orphans need a NEXT-RUN sweep.
 *
 * WHAT THIS DOES
 *   sweepStaleTempDirs(): removes `bscrm-*` directories in os.tmpdir() that
 *   are older than a grace period. The grace period is the protection the
 *   operator asked for: a directory belonging to a CURRENTLY RUNNING test
 *   was created minutes ago and is never touched; only stale leftovers are.
 *
 * WHEN IT RUNS
 *   Automatically, at most once per day, the first time any suite calls
 *   createDisposableDb() (lazy, non-fatal, never blocks a test run).
 *   Also exported for manual/CI invocation.
 *
 * SAFETY
 *   - Only directories matching the bscrm-* prefix are candidates (same
 *     prefix createDisposableDb uses). Nothing else in tmpdir is considered.
 *   - mtime within GRACE_PERIOD_MS => skipped (active test protection).
 *   - A live lock marker (bscrm-*.lock holding a running PID) => skipped.
 *   - Any per-directory error is counted, never thrown: cleanup must not
 *     fail a test run.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Directories younger than this are assumed ACTIVE and never removed. */
const GRACE_PERIOD_MS = Number(process.env.BSCRM_TEMP_GRACE_MS ?? 30 * 60 * 1000); // 30 min
const PREFIX = 'bscrm-';
const SWEEP_STAMP = path.join(os.tmpdir(), 'bscrm-temp-sweep.stamp');
const SWEEP_MIN_INTERVAL_MS = Number(process.env.BSCRM_SWEEP_MIN_MS ?? 24 * 60 * 60 * 1000); // daily

/**
 * @param {{now?:number, graceMs?:number, tmpDir?:string, dryRun?:boolean}} [opts]
 * @returns {{removed:string[], skipped:number, errors:number, skippedReasons:Record<string,number>}}
 */
function sweepStaleTempDirs(opts = {}) {
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? GRACE_PERIOD_MS;
  const root = opts.tmpDir ?? os.tmpdir();
  const result = { removed: [], skipped: 0, errors: 0, skippedReasons: {} };
  const skip = (why) => { result.skipped++; result.skippedReasons[why] = (result.skippedReasons[why] || 0) + 1; };

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return result; // tmpdir unreadable — never fail a test run for cleanup
  }

  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(PREFIX)) continue;
    const dir = path.join(root, e.name);
    try {
      const st = fs.statSync(dir);
      const age = now - st.mtimeMs;
      if (age < graceMs) { skip('within-grace-period'); continue; }
      // Active-run lock marker protection (createDisposableDb writes none
      // today, but a future harness may; honour it if present).
      const lockPath = path.join(dir, '.bscrm-active');
      if (fs.existsSync(lockPath)) {
        let live = false;
        try {
          const pid = Number(fs.readFileSync(lockPath, 'utf8').trim());
          live = Number.isFinite(pid) && pid > 0 && process.pid !== pid
            ? (() => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } })()
            : pid === process.pid;
        } catch { live = false; }
        if (live) { skip('active-lock'); continue; }
      }
      if (!opts.dryRun) fs.rmSync(dir, { recursive: true, force: true });
      result.removed.push(dir);
    } catch {
      result.errors++; // locked handles etc. — count, continue
    }
  }
  return result;
}

/** Run the sweep at most once per SWEEP_MIN_INTERVAL_MS. Non-fatal. */
function maybeSweepTempDirs(opts = {}) {
  try {
    const now = Date.now();
    if (!opts.force && fs.existsSync(SWEEP_STAMP)) {
      const last = Number(fs.readFileSync(SWEEP_STAMP, 'utf8').trim());
      if (Number.isFinite(last) && now - last < SWEEP_MIN_INTERVAL_MS) {
        return { ran: false, reason: 'recent' };
      }
    }
    const result = sweepStaleTempDirs(opts);
    try { fs.writeFileSync(SWEEP_STAMP, String(now)); } catch { /* tmp read-only */ }
    if (result.removed.length > 0) {
      // One line, diagnostics only — never per-directory noise.
      console.log(`[test-hygiene] swept ${result.removed.length} stale bscrm-* temp dir(s)`
        + (result.errors ? `, ${result.errors} error(s)` : ''));
    }
    return { ran: true, ...result };
  } catch {
    return { ran: false, reason: 'error' }; // cleanup must never break a run
  }
}

module.exports = { sweepStaleTempDirs, maybeSweepTempDirs, GRACE_PERIOD_MS, PREFIX };
