/**
 * PROVES tests/update-routes.test.js detects the Phase A defects.
 *
 * A guard that cannot fail is not a guard. Reintroduce each defect in turn and
 * require the suite to go red, then restore. Reverting is done on a temporary
 * copy of the file and the original is always restored in a finally block.
 *
 * Read-only with respect to the database and to application behaviour: only two
 * source files are edited, and both are restored before the script exits.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEST = 'tests/update-routes.test.js';
const ROUTE_FILE = path.join(ROOT, 'server', 'routes', 'dataSafety.js');
const UI_FILE = path.join(ROOT, 'public', 'js', 'pages', 'settings.js');

function runTests() {
  const r = spawnSync('npx', ['vitest', 'run', TEST], {
    cwd: ROOT, encoding: 'utf8', shell: true, timeout: 400000,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  const m = plain.match(/Tests\s+(\d+)\s+failed/);
  return { failedCount: m ? Number(m[1]) : 0, exit: r.status, plain };
}

/** Substitute the WHOLE module import + the call sites. Fragments leave dangling
 *  syntax, and a swallowed SyntaxError can masquerade as a passing guard. */
function reintroduceStaticBug(src) {
  const importLine = /const \{ UpdateService[^}]*\} = require\('\.\.\/services\/updateService'\);/;
  if (!importLine.test(src)) throw new Error('module import line not found');
  let out = src.replace(importLine, "const { UpdateService } = require('../services/updateService');");
  for (const [from, to] of [
    ['getChannel()', 'UpdateService.getChannel()'],
    ['setChannel(channel)', 'UpdateService.setChannel(channel)'],
    ['checkSchemaCompatibility({', 'UpdateService.checkSchemaCompatibility({'],
    ['getCurrentDbSchemaVersion()', 'UpdateService.getCurrentDbSchemaVersion()'],
  ]) {
    out = out.replace(from, to);
  }
  return out;
}

/** Put one unauthenticated fetch() back into the Settings UI. */
function reintroduceBareFetch(src) {
  const anchor = "const j = await window.API.get('/datasafety/update-channel');";
  if (!src.includes(anchor)) throw new Error('converted API call not found');
  return src.replace(
    anchor,
    "const r = await fetch('/api/datasafety/update-channel'); const j = await r.json();",
  );
}

/** Remove the permission gate from the guard. */
function reintroduceMissingGuard(src) {
  const line = "const requireDataSafety = [authMiddleware, requirePermission('settings.manage')];";
  if (!src.includes(line)) throw new Error('guard declaration not found');
  return src.replace(line, 'const requireDataSafety = [];');
}

const scenarios = [
  {
    name: 'Finding 2/3 — routes call nonexistent UpdateService statics',
    file: ROUTE_FILE,
    transform: reintroduceStaticBug,
  },
  {
    name: 'Finding 1 — Settings UI uses an unauthenticated fetch()',
    file: UI_FILE,
    transform: reintroduceBareFetch,
  },
  {
    name: 'Security — permission guard removed from /api/datasafety',
    file: ROUTE_FILE,
    transform: reintroduceMissingGuard,
  },
];

let ok = true;
const originals = new Map();
for (const s of scenarios) originals.set(s.file, fs.readFileSync(s.file, 'utf8'));

try {
  // Baseline: the suite must be green before we prove it can go red.
  const base = runTests();
  console.log(`baseline (fixes in place)  -> failing tests: ${base.failedCount}`);
  if (base.failedCount !== 0) {
    ok = false;
    console.log('  ERROR: suite is not green with the fixes applied — cannot validate detection');
  }

  for (const s of scenarios) {
    const mutated = s.transform(originals.get(s.file));
    if (mutated === originals.get(s.file)) {
      ok = false;
      console.log(`  ERROR: transform for "${s.name}" changed nothing`);
      continue;
    }
    fs.writeFileSync(s.file, mutated);
    const r = runTests();
    fs.writeFileSync(s.file, originals.get(s.file)); // restore immediately

    const detected = r.failedCount > 0 || r.exit !== 0;
    if (!detected) ok = false;
    console.log(`${detected ? 'detected  ' : 'MISSED    '} ${s.name} -> failing tests: ${r.failedCount}`);
    if (detected) {
      const first = r.plain.split('\n').find((l) => /×|FAIL/.test(l));
      if (first) console.log(`            ${first.trim().slice(0, 120)}`);
    }
  }
} finally {
  for (const [file, content] of originals) fs.writeFileSync(file, content);
}

console.log(ok ? '\nGUARD VERIFIED: detects all three regressions' : '\nGUARD NOT VERIFIED');
process.exit(ok ? 0 : 1);