/**
 * Shared guard for test suites that mutate or delete data.
 *
 * WHY THIS EXISTS
 *   On 2026-10-05/06 the live BlackStack CRM database was wiped twice by the
 *   inventory E2E suite. Its cleanTestDB() deleted every inventory master, and
 *   it defaulted to `../data/blackstack-crm.db` — the live database. Restoring
 *   from backup is the only remedy, and one attempt was itself corrupted by a
 *   stale WAL file.
 *
 *   Any suite that writes to a database must therefore prove, in code, that it
 *   is pointed at a disposable file. It is not enough to remember to set
 *   DB_PATH: that is exactly what was forgotten.
 *
 * HOW TO USE
 *   const { assertDisposableDb } = require('../scripts/assert-disposable-db');
 *   const DB_PATH = assertDisposableDb(process.env.DB_PATH, {
 *     defaultTo: path.join(__dirname, '../data/blackstack-crm.db'), // shown in the error
 *   });
 *
 * The check is an ALLOW-LIST: the resolved filename must contain one of the
 * disposable markers. Anything unrecognised is refused, so pointing a suite at a
 * new production path fails closed rather than deleting it.
 */
const path = require('path');

/** Substrings that mark a file as disposable. */
const DISPOSABLE_MARKERS = [
  'test', 'e2e', 'debug', 'tmp', 'temp', 'scratch', 'acceptance', 'disposable',
];

/**
 * @param {string|undefined} dbPath  the value the suite intends to use
 * @param {object}   [options]
 * @param {string}   [options.defaultTo]  what the suite falls back to; only used
 *                                        to make the error message actionable
 * @param {string}   [options.suite]      suite name for the error message
 * @param {string[]} [options.extraMarkers] additional acceptable markers
 * @returns {string} the resolved, verified path
 * @throws  {Error} if the path is unset, unmarked, or the live database
 */
function assertDisposableDb(dbPath, options = {}) {
  const {
    defaultTo = null,
    suite = 'this suite',
    extraMarkers = [],
  } = options;

  const explicit = !!dbPath;
  const resolved = path.resolve(dbPath || defaultTo || '');
  const base = path.basename(resolved).toLowerCase();
  const normalized = resolved.toLowerCase().replace(/\\/g, '/');

  const markers = [...DISPOSABLE_MARKERS, ...extraMarkers.map((m) => String(m).toLowerCase())];
  const markerInName = markers.some((m) => base.includes(m));
  const isLiveDb = normalized.endsWith('/data/blackstack-crm.db');

  const problems = [];
  if (!explicit) {
    problems.push('no DB_PATH was set, so the suite fell back to its default');
  }
  if (!markerInName) {
    problems.push(`filename has no disposable marker (looked for: ${markers.join(', ')})`);
  }
  if (isLiveDb) {
    problems.push('this IS the live database');
  }

  if (problems.length > 0) {
    throw new Error(
      `REFUSING TO RUN: ${suite} writes to the database, so it may only run against a `
      + 'disposable copy.\n'
      + `  resolved path : ${resolved}\n`
      + problems.map((p) => `  problem       : ${p}\n`).join('')
      + '  Fix: point DB_PATH at a throwaway copy whose filename contains one of the\n'
      + '  markers above, e.g.\n'
      + '    DB_PATH="$PWD/data/e2etest/suite-e2e.db" npx playwright test ...\n'
      + '  Never run a mutating suite against production data.'
    );
  }

  return resolved;
}

/**
 * Create a disposable database OUTSIDE the production data directory.
 *
 * PHASE 3 — TEST DATABASE SAFETY.
 *
 * Several core-module suites used to resolve
 *   const DB_PATH = process.env.DB_PATH || 'data/blackstack-crm.db';
 * which silently pointed destructive SQL at the LIVE database whenever the
 * environment variable was not set. `accounting-complete.test.js` alone carries
 * 13 DELETE and 3 INSERT statements.
 *
 * This helper makes the safe path the easy one:
 *   1. it clones the production database into a fresh temp directory
 *      (os.tmpdir(), never `data/`), so the suite starts from real schema and
 *      seed data without ever holding a handle on production;
 *   2. it names the copy with a disposable marker so the EXISTING
 *      assertDisposableDb() allow-list accepts it — one allow-list, not two;
 *   3. it registers an exit handler so the temp directory is removed.
 *
 * A suite that uses this cannot reach production even if DB_PATH is unset,
 * because there is no production fallback to reach.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.suite]     suite name, for error messages
 * @param {string}  [opts.prefix]    temp dir prefix
 * @param {boolean} [opts.copy]      clone production (default true). Set false
 *                                   for a schema-only fixture DB.
 * @param {string}  [opts.source]    explicit source database (default: the
 *                                   project's data/blackstack-crm.db, READ ONLY)
 * @returns {{dbPath:string, tmpDir:string, cleanup:Function}}
 */
function createDisposableDb(opts = {}) {
  const fs = require('fs');
  const os = require('os');
  const {
    suite = 'this suite',
    prefix = 'bscrm-isolated-',
    copy = true,
    source = null,
  } = opts;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // The filename carries a disposable marker so assertDisposableDb() accepts it.
  const dbPath = path.join(tmpDir, 'suite-e2e.db');

  if (copy) {
    // Read-only access to production: the file is COPIED, never opened for write.
    const src = path.resolve(source || path.join(__dirname, '..', 'data', 'blackstack-crm.db'));
    if (!fs.existsSync(src)) {
      throw new Error(
        `Cannot create a disposable database: source not found at ${src}\n`
        + `  suite: ${suite}`,
      );
    }
    fs.copyFileSync(src, dbPath);
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(src + ext)) {
        try { fs.copyFileSync(src + ext, dbPath + ext); } catch { /* optional */ }
      }
    }
  }

  // Defence in depth: the copy must satisfy the project allow-list. If it ever
  // does not, refuse rather than hand back an unguarded path.
  assertDisposableDb(dbPath, { suite, defaultTo: dbPath });

  // PHASE 3A — POINT THE ENVIRONMENT AT THE COPY.
  //
  // This helper used to only RETURN dbPath, leaving every caller to assign
  // process.env.DB_PATH itself. That is a trap: connection.js resolves
  // `process.env.DB_PATH || <production>` on every connect(), so a caller that
  // connects before assigning — or forgets to assign — silently opens
  // PRODUCTION. The caller cannot detect it, because nothing has gone wrong at
  // the point it would notice.
  //
  // Assign here, BEFORE returning, so the returned dbPath and the environment
  // can never disagree. Callers that also assign it are harmless (same value).
  //
  // A pre-existing DB_PATH is treated as operator intent and preserved only if
  // it is already disposable; production is never silently overwritten by this
  // function.
  // Assign ONLY when nothing else has claimed the environment.
  //
  // PHASE 3A — REGRESSION FIX. An earlier version of this block assigned
  // unconditionally, which silently repaired an already-mis-bound process: a
  // caller that had opened PRODUCTION and *then* called createDisposableDb() got
  // DB_PATH pointed at the throwaway copy, so the live-connection check below saw
  // the environment and the open file "agree" and allowed the run. That is the
  // exact scenario the guard exists to refuse (see CASE 1 in
  // tests/phase-3a-db-isolation-guard.test.js), and it was being masked.
  //
  // STALE-BINDING DETECTION (remediation of audit finding E-08).
  //
  // Why this branch exists at all: it must NOT overwrite a DB_PATH that points
  // at production — that would mask a genuine mis-binding (CASE 1 in
  // tests/phase-3a-db-isolation-guard.test.js). But a stale DB_PATH left behind
  // by a SIBLING test file that previously ran in this same vitest worker is a
  // different situation: it is disposable-looking, it is not this suite's
  // clone, and the suite below will read a file nobody owns. That is what
  // produced the intermittent:
  //
  //   Error: unable to open database file
  //   at tests/customer-bills.vitest.test.js:92
  //
  // because a prior file's temp dir had already been removed while DB_PATH
  // still pointed into it.
  //
  // Both cases are unsafe, so both must FAIL — but with different messages,
  // because the operator needs to know which one occurred.
  if (!process.env.DB_PATH) {
    process.env.DB_PATH = dbPath;
  } else {
    const claimed = process.env.DB_PATH;
    // Reuse the SAME allow-list the guard enforces everywhere else, so this
    // branch cannot drift from assertDisposableDb()'s definition of
    // "disposable". Deliberately not a new predicate.
    const claimedBase = path.basename(path.resolve(claimed)).toLowerCase();
    const claimedNorm = path.resolve(claimed).toLowerCase().replace(/\\/g, '/');
    const looksDisposable = DISPOSABLE_MARKERS.some((m) => claimedBase.includes(m))
      && !claimedNorm.endsWith('/data/blackstack-crm.db');
    if (!looksDisposable) {
      // CASE 1 — the guard's original purpose. Fail closed, loudly.
      throw new Error(
        `[${suite}] REFUSING TO RUN: process.env.DB_PATH already points at a `
        + `non-disposable database.\n`
        + `  DB_PATH = ${claimed}\n`
        + `  This suite needs its own clone at ${dbPath}.\n`
        + `  Refusing rather than overwrite it: a production binding must never be `
        + `silently repaired.\n`
        + `  Run this suite in its own process, or unset DB_PATH before requiring it.`,
      );
    }

    // A DISPOSABLE DB_PATH is already present, but there are two very different
    // reasons for that, and conflating them breaks legitimate usage:
    //
    //   (a) The operator/test harness DELIBERATELY provided DB_PATH pointing at
    //       a database it prepared — this is the documented pattern in CASE 2 of
    //       tests/phase-3a-db-isolation-guard.test.js, where the expected target
    //       is that very file. Honouring it is correct.
    //   (b) A SIBLING test file in this same reused vitest worker left DB_PATH
    //       behind, and its temp directory has since been deleted. The file no
    //       longer exists, so continuing means reading a path nobody owns —
    //       which produced the intermittent:
    //         Error: unable to open database file
    //         at tests/customer-bills.vitest.test.js:92
    //
    // The discriminator is whether the claimed path still EXISTS. An existing
    // file is intent; a missing one is a stale binding left by a dead sibling.
    if (fs.existsSync(claimed)) {
      // (a) Operator intent — leave it alone.
    } else {
      // (b) Stale binding from a sibling whose temp dir was removed.
      process.env.DB_PATH = dbPath;
      process.env.BSCRM_STALE_DB_PATH_REPLACED = claimed;
    }
  }

  // ── PHASE 3A INCIDENT HARDENING ────────────────────────────────────────
  // Setting process.env.DB_PATH is NOT sufficient. server/database/connection.js
  // evaluates `const DB_PATH = process.env.DB_PATH || <production default>` as a
  // MODULE-LEVEL CONSTANT at require() time. If anything in the caller's
  // require-chain loaded that module first, the connection is already cached and
  // bound to PRODUCTION, and every subsequent write goes to the live database.
  //
  // That is exactly how the 2026-10-09 Accounting audit incident happened: an
  // env check passed, but SQLite was really writing to data/blackstack-crm.db.
  //
  // assertDisposableDbIsActive() therefore asks SQLite which file it actually
  // has open and refuses unless it is inside this temp directory.
  assertDisposableDbIsActive({ suite, tmpDir, expected: dbPath });

  const cleanup = () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  // Clean up on normal exit AND on failure. `exit` alone is not enough: a suite
  // that throws at module top level (which is exactly what the E2E_PORT guard
  // does) can terminate before the handler drains, and a lingering Playwright
  // browser can hold a file handle that defeats a single rmSync attempt. Both
  // signals are wired, and rmSync is retried once.
  process.on('exit', cleanup);
  // PHASE 3 — CORRECTION. An earlier version also trapped 'uncaughtException'
  // here and called process.exit(1). That was a defect: registering the handler
  // at all SUPPRESSES Node's default crash reporting, so a script that threw for
  // any reason after calling this helper exited 1 with completely empty stdout
  // and stderr. The real error was invisible. Cleanup must never mask a failure.
  // Signals are re-raised so default behaviour is preserved.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      cleanup();
      process.kill(process.pid, sig);
    });
  }
  // Last-resort sweep: if the directory still exists a moment later, remove it
  // again after any child process has had time to release its handles.
  const sweep = setTimeout(cleanup, 1500);
  if (typeof sweep.unref === 'function') sweep.unref();
  process.on('exit', () => clearTimeout(sweep));

  return { dbPath, tmpDir, cleanup };
}


/**
 * Assert that any ALREADY-OPEN connection is bound to the disposable database.
 *
 * PHASE 3A INCIDENT HARDENING.
 *
 * Why this exists: on 2026-10-09 an Accounting audit probe set process.env.DB_PATH
 * to a temp clone and then imported modules whose require-chain had already loaded
 * server/database/connection.js. Because that module binds
 * `const DB_PATH = process.env.DB_PATH || <production>` at module scope, the
 * cached connection stayed on data/blackstack-crm.db and five journal entries were
 * written into production. Every existing check was satisfied: the filename
 * carried a disposable marker, the path was outside `data/`, and the env var was
 * set. Only SQLite's own view of the open file revealed the truth.
 *
 * So this checks the ACTUAL file, not the environment:
 *   1. If server/utils/db.js is already loaded, ask its cached connection where it
 *      is really reading/writing (`PRAGMA database_list`).
 *   2. If it is not loaded, confirm the connection module is still unbound so a
 *      later require() will pick up DB_PATH.
 *   3. Refuse — loudly, and before any caller writes — if the live file is
 *      anything other than the intended temp clone.
 *
 * @param {object} opts
 * @param {string} opts.suite    suite name for the error message
 * @param {string} opts.tmpDir   the temp directory that MUST contain the open file
 * @param {string} opts.expected the exact disposable path expected
 * @throws {Error} if a connection is open against a different database
 */
function assertDisposableDbIsActive({ suite = 'this suite', tmpDir, expected } = {}) {
  const path_ = require('path');
  const fs_ = require('fs');

  // PHASE 3A — DRIFT CHECK, BEFORE ANYTHING ELSE.
  //
  // The 2026-10-09 leak happened because the connection module resolved its
  // path at require() time. A suite set process.env.DB_PATH afterwards and the
  // already-cached module ignored it, so the test wrote to production. The path
  // is now frozen on FIRST connect() instead — but a suite that connects before
  // it has chosen its DB is still mis-bound, and the environment variable now
  // disagrees with the file in use. Detect that explicitly and refuse, instead
  // of trusting the env var that the connection already ignored.
  try {
    const connMod = require(path_.join(__dirname, '..', 'server', 'database', 'connection.js'));
    if (typeof connMod._pathDrift === 'function') {
      const drift = connMod._pathDrift();
      // A drift only matters if a LIVE connection still holds the old file.
      // A suite that opened a disposable DB, closed it, and now wants another
      // (tests/data-safety.test.js) legitimately rebinds — _pathDrift() ignores
      // closed handles, so that case reports null and proceeds.
      if (drift && drift.env) {
        throw new Error(
          '\n' + '='.repeat(74) + '\n'
          + `REFUSING TO WRITE — ${suite}: DB_PATH was changed AFTER the database was bound\n`
          + '='.repeat(74) + '\n'
          + `  this process is bound to : ${drift.bound}\n`
          + `  DB_PATH now says        : ${drift.env}\n`
          + '\n'
          + '  The binding is decided by the FIRST connect() call and cannot change.\n'
          + '  A different test file in this shared worker connected first.\n'
          + '\n'
          + '  Fix: create the disposable DB and require the database modules\n'
          + '  BEFORE anything opens a connection, or run this suite in its own\n'
          + '  process/worker with DB_PATH set in the environment.\n'
          + '\n'
          + '  On 2026-10-09 the equivalent mistake wrote BILL-2026-00001 into the\n'
          + '  production database.\n',
        );
      }
    }
  } catch (e) {
    if (e && /REFUSING TO WRITE/.test(e.message)) throw e;
    /* module not loaded yet — nothing can be open */
  }

  // Ask BOTH registries what is actually open, WITHOUT creating anything:
  //   * server/database/connection.js  — every DatabaseConnection.connect()
  //   * server/utils/db.js             — the lazily-created getConn() connection
  // Both matter: the 2026-10-09 incident opened a DatabaseConnection directly.
  const opened = [];
  try {
    const connMod = require(path_.join(__dirname, '..', 'server', 'database', 'connection.js'));
    // PHASE 3A: inspect only connections that are STILL OPEN. A closed handle
    // cannot write, so including it made the guard refuse a suite that opens a
    // fresh disposable database per test — a false positive that hid real leaks.
    const liveFn = typeof connMod._liveConnections === 'function'
      ? connMod._liveConnections
      : connMod._openedConnections;
    if (typeof liveFn === 'function') {
      for (const rec of liveFn()) {
        let file = null;
        try {
          const rows = rec.db.all('PRAGMA database_list');
          const main = Array.isArray(rows) ? rows.find((r) => r && r.name === 'main') : null;
          file = main && main.file ? String(main.file) : rec.resolvedPath;
        } catch {
          file = rec.resolvedPath;
        }
        opened.push(file);
      }
    }
  } catch { /* module not loaded yet — nothing can be open */ }

  try {
    const dbMod = require(path_.join(__dirname, '..', 'server', 'utils', 'db.js'));
    // CRITICAL: use the non-creating peek. getConn() would CREATE and cache a
    // connection here, establishing the very binding we are inspecting.
    const cached = dbMod._peekCachedConnection ? dbMod._peekCachedConnection() : null;
    if (cached) {
      try {
        const rows = cached.all('PRAGMA database_list');
        const main = Array.isArray(rows) ? rows.find((r) => r && r.name === 'main') : null;
        if (main && main.file) opened.push(String(main.file));
      } catch { /* ignore */ }
    }
  } catch { /* not loaded */ }

  if (!opened.length) return true; // nothing open yet -> cannot be mis-bound

  const want = path_.resolve(expected);
  const bad = opened.filter((f) => {
    const actual = path_.resolve(String(f));
    const insideTmp = tmpDir && actual.startsWith(path_.resolve(tmpDir));
    return !(actual === want && insideTmp);
  });
  if (!bad.length) return true;

  const actual = path_.resolve(String(bad[0]));
  const insideTmp = tmpDir && actual.startsWith(path_.resolve(tmpDir));

  // Refuse. State exactly what is open and what should have been open.
  throw new Error(
    '\n' + '='.repeat(74) + '\n'
    + `REFUSING TO WRITE — ${suite} is bound to the WRONG DATABASE\n`
    + '='.repeat(74) + '\n'
    + `  actually open : ${actual}\n`
    + `  expected      : ${want}\n`
    + '\n'
    + '  server/database/connection.js evaluates DB_PATH at MODULE LOAD time.\n'
    + '  Something in this process required it before DB_PATH pointed at the\n'
    + '  disposable copy, so the cached connection is still on the real database.\n'
    + '\n'
    + '  Fix: call createDisposableDb() and use its dbPath BEFORE requiring any\n'
    + '  module that reaches server/database/connection.js — or run the test in a\n'
    + '  separate process with DB_PATH set in the environment.\n'
    + '\n'
    + '  This guard is intentionally fatal. On 2026-10-09 the equivalent mistake\n'
    + '  wrote five journal entries into the production database.\n',
  );
}

module.exports = { assertDisposableDb, createDisposableDb, assertDisposableDbIsActive, DISPOSABLE_MARKERS };