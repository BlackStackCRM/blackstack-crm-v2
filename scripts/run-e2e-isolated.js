/**
 * Safely run the Playwright inventory E2E suite against an ISOLATED database.
 *
 * ── Why this wrapper exists ────────────────────────────────────────────────
 * On 2026-10-05 the live database was wiped by an E2E run. The chain:
 *   * a server was ALREADY on port 3000 using ./data/blackstack-crm.db
 *   * the suite's cleanTestDB() deletes inventory masters from
 *     process.env.DB_PATH, defaulting to ../data/blackstack-crm.db
 *   * the suites hardcode BASE_URL = http://localhost:3000
 * So even a correctly-scoped DB_PATH is not enough: if the suite's own DB_PATH
 * and the server's DB_PATH disagree, one of the two is the live database.
 *
 * This wrapper guarantees they agree, by construction:
 *   1. refuse to run if port 3000 is already occupied
 *   2. build a fresh DB copy and pass it as BOTH the server's DB_PATH and the
 *      test process's DB_PATH
 *   3. start the server on 3000 bound to that copy
 *   4. verify, before running, that the live database is untouched
 *   5. verify again afterwards
 *
 *   node scripts/run-e2e-isolated.js [suite ...]
 *
 * ── Delegation note (2026-10-06) ───────────────────────────────────────────
 * This script used to spawn `npx playwright test` with `shell: true`. On Windows
 * a shell is required to launch `npx` (a .cmd shim), but the shell then CONCATENATES
 * the argument list rather than escaping it, so any forwarded flag was silently
 * dropped: `--grep "Test 7:"` ran the entire suite instead of one test, and
 * `--grep "Test (7|9|11):"` died because cmd.exe read the `|` as a pipe. Two
 * runners, one of which quietly ignored its arguments, is how a suite gets
 * diagnosed against the wrong test set.
 *
 * scripts/run-one-e2e.js already solves this by invoking the Playwright CLI entry
 * directly with no shell. So this wrapper is retained as a thin, backward-
 * compatible entry point that delegates, and argument handling lives in exactly
 * one tested place.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
const runner = path.join(__dirname, 'run-one-e2e.js');

// Accept BOTH invocation styles so existing muscle memory and any CI step that
// passes Playwright flags directly keep working:
//
//   node scripts/run-e2e-isolated.js --grep "Test 23:"     <- Playwright style
//   node scripts/run-e2e-isolated.js "Test 23:"            <- runner style
//
// run-one-e2e.js takes the grep pattern as a POSITIONAL argument. Forwarding
// `--grep` untouched made Playwright reject the run ("You may need to escape
// symbols...") — the flag would arrive with its value consumed as the
// positional, leaving no pattern. Normalise it here, at the boundary.
const passthrough = [];
let grepPattern = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--grep' || a === '-g') {
    grepPattern = args[i + 1];
    i++;
  } else if (a.startsWith('--grep=')) {
    grepPattern = a.slice('--grep='.length);
  } else if (a === '--headed' || a === '--visible') {
    passthrough.push('--headed');
  } else if (a.startsWith('-')) {
    // Any other Playwright flag is passed through untouched.
    passthrough.push(a);
  } else {
    // A bare argument is the suite path OR the grep pattern. run-one-e2e.js
    // currently treats its single positional as the grep, so only forward it
    // when no explicit --grep was supplied.
    if (grepPattern === null && /test/i.test(a) && !/\.test\.[cm]?js$/.test(a)) {
      grepPattern = a;
    } else {
      passthrough.push(a);
    }
  }
}

if (grepPattern !== null) passthrough.unshift(grepPattern);

const result = spawnSync(process.execPath, [runner, ...passthrough], {
  cwd: ROOT,
  stdio: 'inherit',
  // run-one-e2e.js owns the temp copy, the server lifecycle, the port guard and
  // the live-database verification, so no timeout is needed here beyond its own.
  timeout: 30 * 60 * 1000,
});

process.exit(result.status === null ? 1 : result.status);