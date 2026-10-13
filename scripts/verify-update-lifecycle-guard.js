/**
 * PROVES tests/update-lifecycle.test.js detects the defects it claims to catch.
 *
 * Phase B established the rule: a guard that cannot fail is not a guard. Each
 * mutation below reintroduces a real Phase C defect; the suite must go RED. Then
 * the file is restored and the suite must go GREEN again.
 *
 *   1. autoInstallOnAppQuit = true   → "Later" silently installs on quit
 *   2. autoDownload = true            → update downloads without user consent
 *   3. drop transferred/total         → UI loses real progress data
 *   4. add a synthetic progress timer → fabricated progress bar
 *   5. remove the install state guard → installs an unverified update
 *   6. remove the verified-backup gate → installs with no backup
 *   7. contextIsolation: false        → weakens the preload security model
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'electron/main.js');
const TEST = path.join(ROOT, 'tests/update-lifecycle.test.js');

const originalMain = fs.readFileSync(MAIN, 'utf8');
const originalTest = fs.readFileSync(TEST, 'utf8');

/**
 * Run the suite with a HARD wall-clock ceiling and return the real result.
 *
 * The first version of this harness reported every mutation as green. The cause
 * was not the tests: `execFileSync` against `npx` on Windows returned
 * `status = null` with ZERO captured bytes when vitest failed, because npx is a
 * .cmd shim and Node's sync spawn cannot capture its pipe reliably. An empty
 * output then matched the "all passed" branch.
 *
 * Two fixes, both necessary:
 *   - shell:true so the Windows shim is invoked the way the shell does;
 *   - an explicit timeout, so a hung run FAILS rather than being reported green.
 * A harness that reports green on failure is worse than no harness.
 */
function runSuite() {
  const started = Date.now();
  let res;
  try {
    res = spawnSync(
      'npx vitest run ' + TEST,
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, shell: true, env: { ...process.env } },
    );
  } catch (e) {
    return { pass: false, failed: 1, reason: 'spawn threw: ' + e.message };
  }
  const out = (res.stdout || '') + (res.stderr || '');
  const clean = out.replace(/\u001b\[[0-9;]*m/g, '');

  const summary = clean.match(/Tests\s+(\d+)\s+failed\s*\|\s*(\d+)\s+passed/);
  const passedOnly = clean.match(/Tests\s+(\d+)\s+passed/);
  const failed = summary ? Number(summary[1]) : 0;
  const passed = summary ? Number(summary[2]) : (passedOnly ? Number(passedOnly[1]) : 0);

  if (res.error) {
    return { pass: false, failed: 1, reason: 'spawn error: ' + res.error.message, elapsed: Date.now() - started };
  }
  if (res.signal) {
    return { pass: false, failed: 1, reason: 'killed by signal ' + res.signal, elapsed: Date.now() - started };
  }
  // No recognizable summary at all => something went wrong; treat as FAIL.
  // Reporting "green" here is exactly the bug this rewrite fixes.
  if (!summary && !passedOnly) {
    return {
      pass: false, failed: 1,
      reason: 'no test summary in output (exit ' + res.status + ')',
      elapsed: Date.now() - started,
      tail: clean.slice(-300),
    };
  }
  return {
    pass: res.status === 0 && failed === 0,
    failed,
    passed,
    status: res.status,
    elapsed: Date.now() - started,
  };
}

const MUTATIONS = [
  {
    name: 'autoInstallOnAppQuit = true (Later installs silently on quit)',
    file: MAIN,
    from: 'autoUpdater.autoInstallOnAppQuit = false;',
    to: 'autoUpdater.autoInstallOnAppQuit = true;',
    minFailures: 1,
  },
  {
    name: 'autoDownload = true (downloads without Update Now)',
    file: MAIN,
    from: 'autoUpdater.autoDownload = false;',
    to: 'autoUpdater.autoDownload = true;',
    minFailures: 1,
  },
  {
    name: 'progress drops transferred + total',
    file: MAIN,
    from: /transferred: p && typeof p\.transferred === 'number' \? p\.transferred : null,\s*\n\s*total: p && typeof p\.total === 'number' \? p\.total : null,/,
    to: 'transferred: null,\n        total: null,',
    minFailures: 1,
  },
  {
    name: 'synthetic progress timer added',
    file: MAIN,
    from: "autoUpdater.autoDownload = false;",
    to: "autoUpdater.autoDownload = false;\n    setInterval(() => { global.__fakePercent = Math.min(100, (global.__fakePercent || 0) + 1); percent = global.__fakePercent; }, 1000);",
    minFailures: 1,
  },
  {
    name: 'install guard removed (can install an unverified update)',
    file: MAIN,
    from: /if \(st\.status !== U\.STATES\.READY && st\.status !== U\.STATES\.POSTPONED\) \{[\s\S]*?\n    \}\n/,
    to: '',
    minFailures: 1,
  },
  {
    name: 'verified-backup gate removed',
    file: MAIN,
    from: /if \(!check\.valid\) \{[\s\S]*?\n      \}\n/,
    to: '',
    minFailures: 1,
  },
  {
    name: 'contextIsolation weakened to false',
    file: MAIN,
    from: 'contextIsolation: true,',
    to: 'contextIsolation: false,',
    minFailures: 1,
  },
];

let allGood = true;
console.log('Phase C lifecycle guard verification\n');

for (const mut of MUTATIONS) {
  const src = fs.readFileSync(mut.file, 'utf8');
  const next = typeof mut.from === 'string'
    ? src.replace(mut.from, mut.to)
    : src.replace(mut.from, mut.to);

  if (next === src) {
    console.log(`  ✗ ${mut.name}\n      COULD NOT APPLY — pattern not found (guard may be stale)`);
    allGood = false;
    continue;
  }

  fs.writeFileSync(mut.file, next);
  const r = runSuite();
  fs.writeFileSync(mut.file, src); // restore immediately

  const detected = !r.pass && r.failed >= mut.minFailures;
  if (!detected) allGood = false;
  console.log(`  ${detected ? '✓' : '✗'} ${mut.name}\n      → ${detected ? `${r.failed} failed / ${r.passed} passed (${(r.elapsed / 1000).toFixed(0)}s)` : 'UNDETECTED — ' + (r.reason || 'suite stayed green')}`);
}

// Baseline: everything restored must be green.
const base = runSuite();
fs.writeFileSync(MAIN, originalMain);
fs.writeFileSync(TEST, originalTest);
const restored = runSuite();
if (!restored.pass) allGood = false;
console.log(`\n  ${restored.pass ? '✓' : '✗'} baseline restored → ${restored.pass ? `suite green again (${restored.passed} passed)` : 'suite STILL RED — ' + (restored.reason || (restored.failed + ' failed'))}`);

console.log(`\n${allGood ? 'GUARD VERIFIED: every Phase C regression is detected.' : 'GUARD INCOMPLETE: at least one regression is undetected.'}`);
process.exit(allGood ? 0 : 1);
