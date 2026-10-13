#!/usr/bin/env node
/**
 * PHASE 3A.1 — NEGATIVE SAFETY TEST for the E2E production-isolation guard.
 *
 * PROVES the claim: "even if someone accidentally configures the wrong URL
 * later, the test harness refuses to touch production."
 *
 * Every case below MUST be refused. A case that is allowed through is a FAILURE
 * and makes this script exit non-zero. This test never opens the production
 * database and never starts a browser.
 *
 * Usage: node scripts/phase-3a-1-isolation-negative-test.js
 */
const { spawnSync } = require('child_process');
const path = require('path');

const {
  assertNotProductionUrl,
  assertE2eIsolation,
  isProductionPort,
  PRODUCTION_PORTS,
} = require('./assert-e2e-isolation');

let passed = 0;
let failed = 0;

function record(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}

function expectRefusal(name, fn) {
  try {
    fn();
    record(name, false, 'was ALLOWED but should have been refused');
  } catch (e) {
    record(name, true, '');
    console.log(`          refused: ${String(e.message).split('\n').find((l) => l.trim())?.trim().slice(0, 110)}`);
  }
}

async function expectRefusalAsync(name, fn) {
  try {
    await fn();
    record(name, false, 'was ALLOWED but should have been refused');
  } catch (e) {
    record(name, true, '');
    console.log(`          refused: ${String(e.message).split('\n').find((l) => l.trim())?.trim().slice(0, 110)}`);
  }
}

console.log('\n' + '='.repeat(74));
console.log('PHASE 3A.1 — E2E PRODUCTION-ISOLATION NEGATIVE TEST');
console.log('='.repeat(74));

(async () => {
  // ── Group 1: absolute production URLs must be rejected ────────────────────
  console.log('\nGROUP 1 — assertNotProductionUrl rejects production targets');
  for (const port of PRODUCTION_PORTS) {
    expectRefusal(`rejects http://localhost:${port}`, () =>
      assertNotProductionUrl(`http://localhost:${port}/login.html`, 'inventory.e2e'));
  }
  expectRefusal('rejects http://127.0.0.1:3000 (loopback form)', () =>
    assertNotProductionUrl('http://127.0.0.1:3000/login.html', 'inventory.e2e'));
  expectRefusal('rejects the exact literal found in inventory.e2e.test.js:17', () =>
    assertNotProductionUrl('http://localhost:3000', 'inventory.e2e'));
  expectRefusal('rejects product-hierarchy-ui literal :3133', () =>
    assertNotProductionUrl('http://localhost:3133', 'product-hierarchy.e2e'));
  expectRefusal('rejects a relative URL (no host at all)', () =>
    assertNotProductionUrl('/login.html', 'inventory.e2e'));
  expectRefusal('rejects an unparseable URL', () =>
    assertNotProductionUrl('http://', 'inventory.e2e'));

  // ── Group 2: an isolated target must still be ALLOWED (no over-blocking) ──
  console.log('\nGROUP 2 — isolated targets are still permitted');
  let allowedOk = true;
  try {
    assertNotProductionUrl('http://localhost:3199/login.html', 'inventory.e2e');
  } catch (e) {
    allowedOk = false;
    console.log('          UNEXPECTED refusal: ' + e.message.split('\n')[0]);
  }
  record('allows http://localhost:3199 (isolated port)', allowedOk);

  // ── Group 3: the full harness assertion fails closed ─────────────────────
  console.log('\nGROUP 3 — assertE2eIsolation refuses unsafe environments');

  // 3a. E2E_PORT unset -> must refuse (no silent default to 3000)
  await expectRefusalAsync('refuses when E2E_PORT is unset', () =>
    assertE2eIsolation({ suite: 'neg-test' }));

  // 3b. E2E_PORT = 3000 (the exact production port) -> must refuse
  const savedPort = process.env.E2E_PORT;
  process.env.E2E_PORT = '3000';
  await expectRefusalAsync('refuses E2E_PORT=3000 (production port)', () =>
    assertE2eIsolation({ suite: 'neg-test' }));

  // 3c. E2E_PORT isolated but DB_PATH = production -> must refuse
  process.env.E2E_PORT = '3199';
  const savedDb = process.env.DB_PATH;
  process.env.DB_PATH = path.join(__dirname, '..', 'data', 'blackstack-crm.db');
  await expectRefusalAsync('refuses when DB_PATH is the live database', () =>
    assertE2eIsolation({ suite: 'neg-test' }));

  // 3d. DB_PATH unset -> must refuse (no default to production)
  delete process.env.DB_PATH;
  await expectRefusalAsync('refuses when DB_PATH is unset', () =>
    assertE2eIsolation({ suite: 'neg-test' }));

  // 3e. DB_PATH = a named-but-unmarked file -> must refuse (allow-list)
  process.env.DB_PATH = path.join(__dirname, '..', 'data', 'prod.sqlite');
  await expectRefusalAsync('refuses an unmarked DB_PATH (allow-list)', () =>
    assertE2eIsolation({ suite: 'neg-test' }));

  // 3f. occupied port -> must refuse. Occupy a throwaway port first.
  const net = require('net');
  const busyPort = 32117;
  const blocker = net.createServer(() => {});
  await new Promise((res) => blocker.listen(busyPort, '127.0.0.1', res));
  process.env.E2E_PORT = String(busyPort);
  process.env.DB_PATH = path.join(require('os').tmpdir(), 'negtest-suite-e2e.db');
  await expectRefusalAsync('refuses when the E2E port is already occupied', () =>
    assertE2eIsolation({ suite: 'neg-test' }));
  await new Promise((res) => blocker.close(res));

  // ── Group 4: a correctly isolated environment must be ACCEPTED ───────────
  console.log('\nGROUP 4 — a correctly isolated environment is accepted');
  process.env.E2E_PORT = '32118';
  process.env.DB_PATH = path.join(require('os').tmpdir(), 'negtest-suite-e2e.db');
  let accepted = null;
  try {
    accepted = await assertE2eIsolation({ suite: 'neg-test' });
    record('accepts isolated port + disposable DB', true);
    console.log(`          baseURL = ${accepted.baseURL}`);
    console.log(`          dbPath  = ${accepted.dbPath}`);
    record('derived baseURL is NOT a production URL',
      !isProductionPort(accepted.port));
  } catch (e) {
    record('accepts isolated port + disposable DB', false, e.message.split('\n')[0]);
  }

  // restore env
  if (savedPort === undefined) delete process.env.E2E_PORT; else process.env.E2E_PORT = savedPort;
  if (savedDb === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = savedDb;

  // ── Group 5: the real suite must now be guarded in code ──────────────────
  console.log('\nGROUP 5 — the vulnerable suites are guarded in source');
  const suites = [
    ['tests/inventory.e2e.test.js', 'assert-e2e-isolation'],
    ['tests/product-hierarchy-ui.e2e.test.js', 'assert-e2e-isolation'],
    ['tests/alternate-units-ui.e2e.test.js', 'assert-e2e-isolation'],
  ];
  const fs = require('fs');
  for (const [file, marker] of suites) {
    const p = path.join(__dirname, '..', file);
    if (!fs.existsSync(p)) { record(`${file} exists`, false, 'missing'); continue; }
    const src = fs.readFileSync(p, 'utf8');
    const guarded = src.includes(marker);
    record(`${file} calls ${marker}`, guarded);
    // Strip comments before checking for hardcoded hosts: the fix deliberately
    // NAMES the old literal in an explanatory comment, and matching that text
    // would report a false failure.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))   // line comments
      .join('\n');
    const stillHardcoded = /https?:\/\/(?:localhost|127\.0\.0\.1):(?:3000|3001|8080|3133|4173|5173)/.test(code);
    record(`${file} executable code has NO production URL`, !stillHardcoded,
      stillHardcoded ? 'a literal production host survives outside comments' : '');
  }

  // ── Group 6: the E2E config must not default to a production port ────────
  console.log('\nGROUP 6 — configs derive their target from E2E_PORT');
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'playwright.e2e.config.js'), 'utf8');
  record('playwright.e2e.config.js derives baseURL from E2E_PORT', /E2E_PORT/.test(cfg));
  const legacyRaw = fs.readFileSync(path.join(__dirname, '..', 'playwright.config.js'), 'utf8');
  const legacyCode = legacyRaw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  record('playwright.config.js executable code no longer pins localhost:3000',
    !/localhost:3000/.test(legacyCode));
  record('playwright.config.js refuses to load on a production port',
    /isProductionPort/.test(legacyCode) && /throw new Error/.test(legacyCode));

  console.log('\n' + '='.repeat(74));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log(failed === 0
    ? 'NEGATIVE TEST PASS — production is unreachable from the E2E harness.'
    : 'NEGATIVE TEST FAIL — the harness is NOT fully isolated.');
  console.log('='.repeat(74));
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
