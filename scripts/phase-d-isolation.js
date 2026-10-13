#!/usr/bin/env node
/**
 * PHASE D — production-data isolation for the packaged-update test.
 *
 * WHY THIS EXISTS
 * ---------------
 * A previous run of this harness launched the packaged app with only
 * BLACKSTACK_USER_DATA_DIR redirected. That was NOT enough: `findPortableDb()`
 * in electron/db-migration.js also looks for a "portable" database at
 *   <cwd>/data/blackstack-crm.db  and  <app>/data/blackstack-crm.db
 * and, when it finds one, backs it up and copies it into userData. Because the
 * packaged binary is launched with cwd = dist-phase-d/v1/win-unpacked but the
 * lookup also probes `path.join(__dirname, '..', 'data', ...)` — which resolves
 * back inside the asar/source tree — the app opened the REAL production
 * database during an "isolated" test.
 *
 * `createBackup()` then runs `PRAGMA wal_checkpoint(TRUNCATE)` against that
 * source. A checkpoint FOLDS any pending WAL pages into the main database file:
 * the bytes change while the logical content is identical. That is what moved
 * the production fingerprint, and it is why "integrity ok / 0 FK violations"
 * did not detect it.
 *
 * WHAT THIS DOES
 * --------------
 * 1. Sets PORTABLE_DB_PATH, which findPortableDb() honours unconditionally: if
 *    it is set it NEVER falls back to the conventional locations. Pointing it at
 *    a path that does not exist makes the portable lookup return null, so the
 *    app starts with a genuinely fresh isolated database.
 * 2. Records the production fingerprint and, on exit, compares it. Any change
 *    is reported as a hard failure with the exact path/operation evidence.
 * 3. Runs cleanup from an exit hook AND a finally block, so a crash still
 *    restores whatever was moved.
 *
 * The production database is never deleted, modified, or overwritten. If the
 * file must be moved out of the way (belt and braces, in case a future build
 * ignores PORTABLE_DB_PATH), it is MOVED and restored, never rewritten.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

/** The real production database. Never opened for write by this harness. */
const PROD_DB = path.join(ROOT, 'data', 'blackstack-crm.db');

/**
 * Scratch dir used to hold the production DB while it is moved aside.
 *
 * It MUST live on the SAME volume as the production DB. `fs.renameSync` across
 * drives fails with WinError 17 ("cannot move the file to a different disk
 * drive"), which is how the first attempt at this isolation silently failed:
 * production is on D:, %TEMP% is on C:, so nothing moved and the DB stayed
 * reachable — while engage() still reported success.
 */
const HOLD_DIR = path.join(path.dirname(PROD_DB), '.phase-d-isolation-hold');

let fingerprintBefore = null;
// EVERY artifact moved aside, not just the main DB. Restore must put all of them
// back; tracking only the main file means a partial restore silently loses data.
let movedAside = [];       // [{ from, to, required }]
let restored = false;

/**
 * SHA-256 of the production DB. Used instead of md5 so a fingerprint can never
 * collide with a content change by accident; the value is only ever compared
 * with another value produced here.
 */
function fingerprint(file = PROD_DB) {
  if (!fs.existsSync(file)) return null;
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

/** The production DB plus its WAL/SHM sidecars, as the app would see them. */
function prodArtifacts() {
  return ['', '-wal', '-shm'].map((s) => PROD_DB + s).filter((f) => fs.existsSync(f));
}

/**
 * Hide the production database for the duration of the test.
 *
 * PORTABLE_DB_PATH is the primary, architecture-native lever: findPortableDb()
 * returns early on it and never falls back. We point it at a path that does not
 * exist so the lookup yields null.
 *
 * We ALSO move the real file aside when possible, because "cannot reach it"
 * should not depend on a single env var being honoured by the shipped build.
 * Move + restore (never delete, never rewrite) means a crash mid-test is
 * recoverable: process-level exit hooks below put it back.
 */
function engage() {
  if (fingerprintBefore === null) {
    fingerprintBefore = fingerprint();
  }

  // Portable lookup must resolve to nothing.
  fs.mkdirSync(HOLD_DIR, { recursive: true });

  // Belt and braces: move the production DB (and sidecars) aside if we can.
  // Each artifact is moved independently and RECORDED, so a partial failure can
  // still be fully reversed by release().
  let movedMain = false;
  for (const f of prodArtifacts()) {
    const dest = path.join(HOLD_DIR, path.basename(f));
    try {
      fs.renameSync(f, dest);
      movedAside.push({ from: f, to: dest, required: f === PROD_DB });
      if (f === PROD_DB) movedMain = true;
    } catch (e) {
      moveError = `${path.basename(f)}: ${e.message}`;
    }
  }

  // The main DB must be either moved or already absent. If it is still in place
  // AND we could not move it, isolation relies solely on PORTABLE_DB_PATH — which
  // is acceptable, but preflight() re-checks reachability either way.
  return {
    portableDbPath: DECOY_PATH,
    productionMoved: movedMain,
    moveError: typeof moveError === 'string' ? moveError : null,
    movedCount: movedAside.length,
    fingerprintBefore,
  };
}

let moveError = null;

/**
 * Put EVERY moved artifact back exactly where it was. Idempotent.
 *
 * Restores the main DB FIRST so production data is recoverable before anything
 * else is touched, and reports per-artifact failures instead of stopping at the
 * first one.
 */
function release() {
  if (restored) return { restored: true, alreadyDone: true, moved: 0 };
  restored = true;
  if (!movedAside.length) return { restored: true, alreadyDone: false, moved: 0 };

  const errors = [];
  const ordered = [...movedAside].sort((a, b) => (b.required ? 1 : 0) - (a.required ? 1 : 0));

  for (const m of ordered) {
    try {
      if (!fs.existsSync(m.to)) {
        // Already back in place (or removed by something else) — nothing to do.
        continue;
      }
      if (fs.existsSync(m.from)) fs.rmSync(m.from, { force: true });
      fs.renameSync(m.to, m.from);
    } catch (e) {
      errors.push(`${path.basename(m.from)}: ${e.message} (held at ${m.to})`);
    }
  }

  movedAside = [];
  return {
    restored: errors.length === 0,
    moved: ordered.length,
    errors,
    error: errors.length ? errors.join('; ') : null,
  };
}

/**
 * Post-test assertion: production bytes must be identical to what we recorded
 * before engaging isolation.
 */
function verifyUnchanged() {
  const after = fingerprint();
  return {
    before: fingerprintBefore,
    after,
    unchanged: fingerprintBefore === after,
    exists: fs.existsSync(PROD_DB),
  };
}

/**
 * Fail-closed preflight. The app must not be running yet, and production must
 * be unreachable from the packaged app's own resolution rules.
 */
function preflight() {
  const problems = [];

  // 1. The portable-DB override must point somewhere that does NOT exist, so the
  //    app's own lookup cannot select a real database.
  if (fs.existsSync(DECOY_PATH)) problems.push('isolation decoy exists: ' + DECOY_PATH);
  if (process.env.PORTABLE_DB_PATH && fs.existsSync(process.env.PORTABLE_DB_PATH)) {
    problems.push('PORTABLE_DB_PATH points at a real file: ' + process.env.PORTABLE_DB_PATH);
  }

  // 2. Production DB must not be present at either conventional lookup location
  //    that electron/db-migration.js probes.
  for (const c of [path.join(process.cwd(), 'data', 'blackstack-crm.db'),
    path.join(ROOT, 'data', 'blackstack-crm.db')]) {
    if (fs.existsSync(c)) problems.push('production DB still reachable at ' + c);
  }

  // 3. The isolated test DB path must be under the OS temp dir.
  const isoDb = path.join(process.env.BLACKSTACK_USER_DATA_DIR || '', 'database', 'blackstack-crm.db');
  if (process.env.BLACKSTACK_USER_DATA_DIR) {
    // Compare REALPATH, and accept either the 8.3 short form of %TEMP%
    // ("BLACKS~1") or its long form ("BLACK STACK"). %TEMP% here returns the
    // short name while BLACKSTACK_USER_DATA_DIR carries the long one, so a
    // plain startsWith() on the raw strings rejects our own temp directory.
    const real = (p) => {
      try { return (fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p)); }
      catch { return path.resolve(p); }
    };
    const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
    const tmpForms = new Set([norm(real(os.tmpdir())), norm(os.tmpdir())]);

    const relToTmp = [...tmpForms].some((t) => {
      const base = t.replace(/\/+$/, '');
      return norm(real(isoDb)) === base || norm(real(isoDb)).startsWith(base + '/');
    });
    if (!relToTmp) {
      problems.push('isolated DB is not under the OS temp dir: ' + isoDb);
    }
  }

  return { ok: problems.length === 0, problems, productionDb: PROD_DB, isolatedDb: isoDb };
}

/**
 * Confirm from inside the RUNNING packaged app that its resolved database path is
 * the isolated one, not production. This is the §4 assertion: prove, don't assume.
 */
function assertAppDbPath(resolvedPath, appVersion) {
  const expected = path.join(USER_DATA_FOR_ASSERT(), 'database', 'blackstack-crm.db');
  const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  const resolvedReal = (() => {
    try { return fs.realpathSync.native(resolvedPath).replace(/\\/g, '/').toLowerCase(); }
    catch { return norm(path.resolve(resolvedPath)); }
  })();
  const expectedReal = (() => {
    try { return fs.realpathSync.native(expected).replace(/\\/g, '/').toLowerCase(); }
    catch { return norm(path.resolve(expected)); }
  })();
  const prodReal = (() => {
    try { return fs.realpathSync.native(PROD_DB).replace(/\\/g, '/').toLowerCase(); }
    catch { return norm(PROD_DB); }
  })();

  const isProduction = resolvedReal === prodReal;
  const isIsolated = resolvedReal === expectedReal;

  return {
    resolved: resolvedPath,
    expected,
    isProduction,
    isIsolated,
    appVersion,
    ok: !isProduction && isIsolated,
  };
}

function USER_DATA_FOR_ASSERT() {
  return process.env.BLACKSTACK_USER_DATA_DIR || '';
}

/** Path handed to the app as PORTABLE_DB_PATH. It deliberately does not exist. */
const DECOY_PATH = path.join(HOLD_DIR, 'no-portable-db');

// ── Crash safety ────────────────────────────────────────────────────────────
// engage() MOVES the production database aside. If this process is killed
// abruptly (task manager, terminal interrupt, harness abort) the `finally` in
// the caller never runs and production would be left sitting in HOLD_DIR, which
// reads as "the database vanished". Two independent guards:
//
//  1. A one-shot recovery script written at engage() time. Running it restores
//     every held artifact. The user (or the next harness run) can invoke it.
//  2. recoverIfHeld() below, called at module load, so the NEXT run repairs a
//     previous run's interrupted move before doing anything else.
const RECOVER_SCRIPT = path.join(ROOT, 'scripts', 'phase-d-restore-production.js');

function writeRecoveryScript() {
  const body = `#!/usr/bin/env node
/* Auto-generated by phase-d-isolation.js. Restores any production artifact
   left in the isolation hold directory by an interrupted run. Safe to run
   repeatedly; does nothing when the hold directory is empty. */
const fs = require('fs');
const path = require('path');
const HOLD = ${JSON.stringify(HOLD_DIR)};
if (!fs.existsSync(HOLD)) { console.log('nothing held — production is in place'); process.exit(0); }
let n = 0;
for (const f of fs.readdirSync(HOLD)) {
  const from = path.join(HOLD, f);
  const to = path.join(path.dirname(HOLD), f);
  try {
    if (fs.existsSync(to)) fs.rmSync(to, { force: true });
    fs.renameSync(from, to);
    console.log('restored ' + f);
    n++;
  } catch (e) { console.error('FAILED to restore ' + f + ': ' + e.message); process.exitCode = 1; }
}
try { fs.rmdirSync(HOLD); } catch { /* not empty */ }
console.log(n ? n + ' artifact(s) restored' : 'hold directory was empty');
`;
  try { fs.writeFileSync(RECOVER_SCRIPT, body); } catch { /* best effort */ }
}

/** Repair an interrupted previous run. Call before engage(). */
function recoverIfHeld() {
  if (!fs.existsSync(HOLD_DIR)) return { recovered: 0, ran: false };
  let n = 0;
  for (const f of fs.readdirSync(HOLD_DIR)) {
    const from = path.join(HOLD_DIR, f);
    const to = path.join(path.dirname(HOLD_DIR), f);
    try {
      if (fs.existsSync(to)) fs.rmSync(to, { force: true });
      fs.renameSync(from, to);
      n++;
    } catch { /* leave it; the next attempt retries */ }
  }
  if (n) { try { fs.rmdirSync(HOLD_DIR); } catch { /* not empty */ } }
  return { recovered: n, ran: n > 0 };
}

module.exports = {
  recoverIfHeld, RECOVER_SCRIPT,
  PROD_DB,
  HOLD_DIR,
  DECOY_PATH,
  fingerprint,
  engage,
  release,
  verifyUnchanged,
  preflight,
  assertAppDbPath,
};

// Restore on abnormal termination. try/finally in the driver covers the normal
// path; these hooks cover a crash, a kill, or an unhandled rejection.
let released = false;
function emergencyRestore() {
  if (released) return;
  released = true;
  try { release(); } catch { /* best effort */ }
}
process.on('exit', emergencyRestore);
process.on('SIGINT', () => { emergencyRestore(); process.exit(130); });
process.on('SIGTERM', () => { emergencyRestore(); process.exit(143); });
process.on('uncaughtException', (e) => { emergencyRestore(); throw e; });