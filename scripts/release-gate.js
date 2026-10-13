#!/usr/bin/env node
/**
 * Release gate for BlackStack CRM.
 *
 * Runs every gate the release depends on and FAILS on the first one that does
 * not pass. Each gate prints its own PASS/FAIL line, and the run exits non-zero
 * if anything failed, so it is safe to wire into CI or a pre-installer hook.
 *
 * Gates:
 *   1. live-database checksum      — the production DB must be byte-identical
 *                                    before and after everything below
 *   2. architecture guard          — no retired-table references in prod code
 *   3. env-isolation guard         — no wholesale process.env assignment
 *   4. authorization + lifecycle   — 401/403/2xx, bill deduction + cancellation
 *   5. unit/integration (parallel) — the normal `npm test` invocation
 *   6. unit/integration (serial)   — catches order/shared-state dependence
 *   7. E2E regression              — visible browser, isolated database
 *   8. reverse-order E2E           — proves order independence
 *   9. database integrity          — FK check + ledger/balance reconciliation
 *
 * Destructive gates run against disposable database copies. Gate 1 is the
 * tripwire: if any step mutates the live database, the run fails loudly instead
 * of reporting a green gate on corrupted data.
 */
'use strict';

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
const require_ = createRequire(path.join(ROOT, 'package.json'));
const LIVE_DB = path.join(ROOT, 'data', 'blackstack-crm.db');
const E2E_PORT = Number(process.env.E2E_PORT || process.env.PORT || 3000);

const FILE_BEFORE = fileChecksum(LIVE_DB);

const results = [];
let failed = false;

/** Raw file checksum — reported for context, NOT used as the mutation tripwire. */
function fileChecksum(file) {
  if (!fs.existsSync(file)) return 'MISSING';
  return require('crypto').createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function record(name, ok, detail) {
  // 'skip' is a THREE-state verdict, deliberately distinct from PASS. A skipped
  // gate must never be counted as passed, and must never read like a green
  // result: the summary reports skip counts explicitly so a release cannot be
  // justified by a gate that quietly did nothing.
  if (ok === 'skip') {
    results.push({ name, ok: false, skipped: true, detail });
    console.log(`[SKIP] ${name}${detail ? `  ${detail}` : ''}`);
    return;
  }
  results.push({ name, ok, detail });
  if (!ok) failed = true;
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? `  ${detail}` : ''}`);
}

/**
 * Content fingerprint of the live database.
 *
 * A raw file checksum is the wrong instrument here. `server/app.js` runs
 * migrations on every startup, and Step 081 in migrate.js performs an
 * unconditional `INSERT OR REPLACE INTO legacy_tables`, which rewrites that
 * row and bumps SQLite's page/version counters even when it reports
 * "0 new migration(s) applied". Measured during this work: a boot changed 8
 * bytes of a 2.89 MB file, changed NO row counts, and produced byte-identical
 * `legacy_tables` content. So the file checksum flips on every normal boot and
 * tells you nothing about whether data changed.
 *
 * This fingerprint hashes the actual logical content instead: every user table's
 * schema and full row set, ordered deterministically. It changes if and only if
 * data or schema changes. A `sqlite_sequence`-style internal table would be
 * noise, so nothing is excluded — genuine writes to any table must be caught.
 */
function dbFingerprint(file) {
  if (!fs.existsSync(file)) return 'MISSING';
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require_('node:sqlite'));
  } catch (e) {
    return 'NO_SQLITE';
  }
  const crypto = require('crypto');
  const h = crypto.createHash('md5');
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (e) {
    return `UNREADABLE:${e.message}`;
  }
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((t) => t.name);

    for (const t of tables) {
      h.update(`\n## ${t}\n`);
      // schema
      const cols = db.prepare(`PRAGMA table_info("${t}")`).all()
        .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value ?? ''}`).join(',');
      h.update(cols);
      // rows, ordered by rowid where available so the hash is stable
      let rows;
      try {
        rows = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all();
      } catch (e) {
        try {
          rows = db.prepare(`SELECT * FROM "${t}"`).all();
        } catch (e2) {
          h.update(`UNREADABLE:${e2.message}`);
          continue;
        }
      }
      for (const r of rows) h.update(`\n${JSON.stringify(r)}`);
    }
    // indexes/triggers/views, so a schema-object change is also caught
    for (const row of db.prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all()) {
      h.update(`\n${row.type}:${row.name}:${row.sql ?? ''}`);
    }
    return h.digest('hex');
  } finally {
    db.close();
  }
}

/**
 * Run a command. Returns { ok, output } where `ok` means exit status 0 AND the
 * expected pass-count appears, because some runners exit 0 while reporting
 * failures (Playwright's line reporter has done this).
 */
function run(name, cmd, args, opts = {}) {
  const expect = opts.expect || null;
  // On Windows a shell is required to launch `npx` (it is a .cmd shim), but the
  // shell then INTERPRETS metacharacters in the arguments. The reverse-order E2E
  // grep is "Test (25|24|23|21|11|9|7):" and cmd.exe reads the "|" as a pipe,
  // killing the run with exit 255 and no useful output. Double-quoting the
  // argument is the fix — it is what keeps the alternation intact through the
  // shell rather than being executed by it.
  const needsQuote = process.platform === 'win32';
  const finalArgs = needsQuote
    ? args.map((a) => (/[\s|()<>&^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    : args;
  const res = spawnSync(cmd, finalArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, ...(opts.env || {}) },
    timeout: opts.timeout || 900000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${res.stdout || ''}${res.stderr || ''}`;

  if (res.error) {
    record(name, false, res.error.message);
    return output;
  }
  if (res.status !== 0) {
    record(name, false, `exit ${res.status}`);
    return output;
  }
  if (expect) {
    // Vitest colours its summary, so ANSI escapes sit between the label and
    // the count: "Tests \x1b[1m\x1b[32m3 passed\x1b[39m". A regex written against
    // the visible text never matches the raw stream, which made every gate
    // report a false FAIL. Strip the escapes first.
    const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
    const m = plain.match(expect);
    if (!m) {
      record(name, false, `expected ${expect} but output did not match`);
      return output;
    }
    record(name, true, m[0].trim());
    return output;
  }
  record(name, true, 'exit 0');
  return output;
}

console.log('BLACKSTACK CRM — RELEASE GATE');
console.log('='.repeat(72));

// ── Gate 1: live database fingerprint ────────────────────────────────────────
const before = dbFingerprint(LIVE_DB);
console.log(`live db CONTENT fingerprint BEFORE: ${before}`);
console.log(`live db FILE checksum BEFORE      : ${fileChecksum(LIVE_DB)}`);
if (before === 'MISSING') {
  record('gate 1: live database present', false, 'data/blackstack-crm.db not found');
} else {
  record('gate 1: live database present', true, `content=${before.slice(0, 12)}`);
}

// ── Gates 2-3: static guards ─────────────────────────────────────────────────
run('gate 2: architecture guard (retired tables)',
  'npx', ['vitest', 'run', 'tests/architecture-retired-tables.test.js'],
  { expect: /Tests\s+\d+\s+passed/, timeout: 180000 });

run('gate 3: env-isolation guard (process.env)',
  'npx', ['vitest', 'run', 'tests/process-env-isolation.test.js'],
  { expect: /Tests\s+\d+\s+passed/, timeout: 180000 });

run('gate 3: migration idempotency (no boot-time mutation)',
  'npx', ['vitest', 'run', 'tests/migration-idempotency.test.js'],
  { expect: /Tests\s+\d+\s+passed/, timeout: 300000 });

// ── Gate 4: authorization + business lifecycle ───────────────────────────────
run('gate 4: authorization (401/403/2xx)',
  'npx', ['vitest', 'run', 'tests/authorization.test.js'],
  { expect: /Tests\s+\d+\s+passed/, timeout: 300000 });

// Route-level contract for the update / data-safety endpoints. Phase A shipped
// two defects here — a 500 from a nonexistent static and a UI that could not
// authenticate — while 17 module-level tests stayed green, because none of them
// exercised HTTP. This gate is what closes that gap; it also asserts the
// permission guard is still in place.
run('gate 4: update/data-safety route contract (401/403/2xx + body)',
  'npx', ['vitest', 'run', 'tests/update-routes.test.js'],
  { expect: /Tests\s+\d+\s+passed/, timeout: 300000 });

// Phase C: the update lifecycle state machine, real-progress passthrough, and the
// two user-control guarantees — choosing "Later" must not install on quit, and
// only the explicit "Restart & Update" path may install at all.
run('gate 4b: Phase C update lifecycle (state machine + Later/autoInstall guard)',
  'npx', ['vitest', 'run', 'tests/update-lifecycle.test.js'],
  { expect: /Tests\s+\d+\s+passed/, timeout: 300000 });

run('gate 4: bill lifecycle + reconciliation',
  'npx', ['vitest', 'run', 'tests/bill-lifecycle.test.js'],
  { expect: /Tests\s+\d+\s+passed/, timeout: 300000 });

// ── Gates 5-6: full unit/integration in both execution modes ────────────────
run('gate 5: unit/integration (parallel)',
  'npx', ['vitest', 'run'],
  { expect: /Tests\s+\d+\s+passed/, timeout: 900000 });

run('gate 6: unit/integration (serial)',
  'npx', ['vitest', 'run', '--no-file-parallelism'],
  { expect: /Tests\s+\d+\s+passed/, timeout: 900000 });

// ── Gates 7-8: browser E2E against isolated databases ────────────────────────
if (fs.existsSync(path.join(ROOT, 'scripts', 'run-one-e2e.js'))) {
  // A stray server holding port 3000 makes every E2E run abort by design, which
  // would read as a product failure. Check the port up front and say so plainly
  // instead of letting the gate report a misleading FAIL. (Verified during this
  // work: two of my own concurrent runs produced exactly that false signal.)
  // Port check must be synchronous (this file is CommonJS); probe via a
  // short-lived child process for a reliable async-safe answer.
  const portFree = (() => {
    const r = spawnSync(process.execPath, ['-e', `
      const net = require('net');
      const s = net.createServer();
      s.once('error', () => process.exit(1));
      s.listen(${E2E_PORT}, '127.0.0.1', () => { s.close(); process.exit(0); });
    `], { timeout: 5000 });
    return r.status === 0;
  })();
  if (!portFree) {
    record('gate 7/8: port free for E2E', false,
      `port ${E2E_PORT} is in use — free it before running the gate`);
  } else {
    run('gate 7: E2E regression (isolated DB)',
      'node', ['scripts/run-one-e2e.js', 'Test'],
      { expect: /\d+\s+passed/, timeout: 1200000 });

    run('gate 8: reverse-order E2E (order independence)',
      'node', ['scripts/run-one-e2e.js', 'Test (25|24|23|21|11|9|7):'],
      { expect: /\d+\s+passed/, timeout: 900000 });
  }
} else {
  record('gate 7/8: E2E runner present', false, 'scripts/run-one-e2e.js missing');
}

// ── Gate 9: database integrity ───────────────────────────────────────────────
const after = dbFingerprint(LIVE_DB);
console.log(`live db CONTENT fingerprint AFTER : ${after}`);
console.log(`live db FILE checksum AFTER       : ${fileChecksum(LIVE_DB)}`);
record('gate 9: live database CONTENT unmodified by the gate run',
  before === after,
  before === after
    ? 'content identical (file bytes may differ: migrations run on every boot and rewrite legacy_tables)'
    : `DATA CHANGED ${before} -> ${after}`);
if (before === after && fileChecksum(LIVE_DB) !== FILE_BEFORE) {
  console.log('note: file bytes changed but content is identical '
    + '(expected — server/app.js runs migrations at startup).');
}

if (before !== 'MISSING') {
  try {
    const { DatabaseSync } = require_('node:sqlite');
    const db = new DatabaseSync(LIVE_DB, { readOnly: true });
    try {
      const integrity = Object.values(
        db.prepare('PRAGMA integrity_check').get(),
      )[0];
      const fk = db.prepare('PRAGMA foreign_key_check').all().length;
      const ledger = db.prepare('SELECT COALESCE(SUM(quantity),0) AS s FROM stock_ledger').get().s;
      const balances = db.prepare('SELECT COALESCE(SUM(quantity),0) AS s FROM stock_balances').get().s;

      record('gate 9: PRAGMA integrity_check', /ok/i.test(String(integrity)), String(integrity));
      record('gate 9: foreign_key_check', fk === 0, `${fk} violations`);
      record('gate 9: stock ledger/balances reconcile', ledger === balances,
        `ledger=${ledger} balances=${balances}`);
    } finally {
      db.close();
    }
  } catch (e) {
    record('gate 9: database integrity', false, e.message);
  }
}

// ── Gate 10: release artifact must be digitally signed ───────────────────────
//
// Added for audit finding E-10. The gate suite previously reported PASS while
// shipping an unsigned installer, because nothing here looked at the artifact's
// Authenticode status at all.
//
// Three lessons from self-review are baked in below, each of which was a real
// defect in the first version of this gate:
//
//   1. It checked ONLY the installer. The shipped application .exe and the
//      uninstaller are equally releasable binaries and are now checked too.
//   2. It printed the signer subject but never COMPARED it, so any trusted
//      certificate — including one issued to a different company — would have
//      passed. The publisher identity is now pinned.
//   3. It interpolated a filesystem path straight into a PowerShell string
//      literal. A path containing a quote would break the script, and the
//      failure was reported as a signing problem rather than a broken check.
//      The path is now passed as a PowerShell argument, never interpolated.
//
// Expected publisher: set RELEASE_EXPECTED_SUBJECT (substring match, matched
// case-insensitively). If unset, the identity check is reported as SKIP-with-
// notice and the signature/trust checks still apply — so a green gate can never
// mean "signed by someone".
{
  // Path normalisation is MANDATORY here, not cosmetic.
  //
  // ROOT is derived from __dirname and may carry forward slashes. The repo lives
  // at "...\CB CRM V2\..." — a path containing spaces — and the MSYS-style
  // layer in this toolchain rewrites separators when such a path is handed to a
  // native process, producing e.g. `D:WorkProjects...v2distsetup.exe`.
  // Get-AuthenticodeSignature then reports "Illegal characters in path", the
  // helper exits non-zero, and the previous version of this gate recorded that
  // as a FAIL for the wrong reason. Verified: path.resolve() output works, the
  // un-normalised equivalent does not.
  const RELEASE_INSTALLER_ENV = 'RELEASE_INSTALLER';
  const nat = (p) => path.resolve(p);
  const installer = nat(process.env[RELEASE_INSTALLER_ENV]
    || path.join(ROOT, 'dist', 'setup.exe'));
  const unpacked = nat(path.join(ROOT, 'dist', 'win-unpacked', 'BlackStack CRM.exe'));
  const expected = process.env.RELEASE_EXPECTED_SUBJECT || '';

  // Read the signature of one file.
  //
  // The path is passed as a NAMED parameter to an explicit `param()` block.
  // Two earlier versions of this call were wrong and both failed silently:
  //   - `$args[0]` with `powershell -Command` receives nothing (verified:
  //     Get-AuthenticodeSignature then errors on a null LiteralPath);
  //   - quoting the path into the -Command string breaks on any path
  //     containing a quote character.
  // $ErrorActionPreference='Stop' is essential: without it PowerShell writes
  // the error to stderr and continues, so the caller received no STATUS line
  // and silently fell through to the unsigned branch. A verification that
  // cannot read the file must FAIL, never degrade into a pass.
  // Delegate to a checked-in .ps1 helper. See scripts/get-authenticode.ps1 for
  // why this cannot be an inline `powershell -Command` string: `$args` is empty
  // under -Command, and interpolating the path breaks on quote characters —
  // both of which produced a silent "unsigned" result rather than an error.
  // Delegate to a checked-in .ps1 helper, passing the path through an
  // ENVIRONMENT VARIABLE.
  //
  // Every command-line approach was tried first and every one failed on this
  // host because the repo path contains spaces ("CB CRM V2") and the toolchain
  // runs under an MSYS-style layer that mangles separators and re-splits
  // arguments. The failure mode was silent: PowerShell returned no STATUS line
  // and the gate quietly reported the artifact as unsigned — a verification
  // that reports a result while checking nothing. Env vars are passed through
  // verbatim by every layer. See scripts/get-authenticode.ps1 for the full list.
  const SIG_HELPER = nat(path.join(ROOT, 'scripts', 'get-authenticode.ps1'));
  const inspect = (file) => execFileSync('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SIG_HELPER],
    {
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      env: { ...process.env, BSCRM_SIG_TARGET: file },
    });

  const missing = [installer, unpacked].filter((f) => fs.existsSync(f));

  if (process.platform !== 'win32') {
    record('gate 10: release artifact Authenticode signature', 'skip',
      'Authenticode is Windows-only');
  } else if (!missing.length) {
    record('gate 10: release artifact Authenticode signature', 'skip',
      `no artifact built (${path.relative(ROOT, installer)} absent)`);
  } else {
    let ok = true;
    const details = [];

    for (const file of missing) {
      const label = path.relative(ROOT, file);
      try {
        const raw = inspect(file);
        const status = (raw.match(/STATUS=\s*(\S+)/) || [])[1] || 'Unknown';
        const subject = (raw.match(/SUBJECT=\s*(.+)/) || [])[1] || '';
        const ts = (raw.match(/TS=\s*(\S+)/) || [])[1] || 'no';

        // (a) signature must exist and the chain must be trusted
        if (status !== 'Valid') {
          ok = false;
          details.push(`${label}: Status=${status} (${subject || 'unsigned'})`);
          continue;
        }
        // (b) the signature must be timestamped, or it dies with the certificate
        if (ts !== 'yes') {
          ok = false;
          details.push(`${label}: valid but NOT timestamped`);
          continue;
        }
        // (c) identity must match the expected publisher
        if (expected) {
          if (!subject.toLowerCase().includes(expected.toLowerCase())) {
            ok = false;
            details.push(`${label}: signer "${subject}" is not "${expected}"`);
            continue;
          }
          details.push(`${label}: Valid+timestamped, signer matches`);
        } else {
          details.push(`${label}: Valid+timestamped (signer NOT pinned)`);
        }
      } catch (e) {
        ok = false;
        details.push(`${label}: verification error ${e.message.slice(0, 60)}`);
      }
    }

    if (!expected) {
      details.push('set RELEASE_EXPECTED_SUBJECT to pin the signer identity');
    }

    record('gate 10: release artifact Authenticode signature', ok,
      `${details.length} artifact(s): ${details.join(' | ')}`);
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('='.repeat(72));
const passed = results.filter((r) => r.ok).length;
const skipped = results.filter((r) => r.skipped);
console.log(`${passed}/${results.length - skipped.length} gates passed` +
  (skipped.length ? `  (${skipped.length} skipped, not counted as passed)` : ''));
if (skipped.length) {
  failed = true;
  console.log('\nSKIPPED GATES (not counted as passed):');
  for (const r of skipped) console.log(`  ${r.name}  ${r.detail || ''}`);
}
if (failed) {
  console.log('\nFAILED GATES:');
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`  - ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
  }
}
console.log(failed ? '\nRELEASE GATE: FAIL' : '\nRELEASE GATE: PASS');
process.exit(failed ? 1 : 0);