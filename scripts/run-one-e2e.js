/**
 * Run ONE inventory E2E test against an isolated database.
 *
 * The project's scripts/run-e2e-isolated.js passes Playwright arguments through
 * a Windows shell (`shell: true`, required for the npx shim), which mangles
 * quoted values like --grep "Test 7:". This wrapper quotes defensively so a
 * single test can be run in isolation, which is what makes a failure easy to
 * diagnose instead of re-running the whole 5-minute suite each time.
 *
 *   node scripts/run-one-e2e.js "Test 7:"
 *   node scripts/run-one-e2e.js "Test 11:" --headed
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { assertE2eIsolation } = require('./assert-e2e-isolation');

const ROOT = path.join(__dirname, '..');
// PHASE 3A.1: E2E_PORT must be explicit. The old default of 3000 is the
// production port, and defaulting to it is what let the 2026-10-08 incident
// happen. 3199 is the isolated default used by playwright.e2e.config.js.
const PORT = Number(process.env.E2E_PORT || 3199);

const grep = process.argv[2];
const headed = process.argv.includes('--headed');
if (!grep) {
  console.error('usage: node scripts/run-one-e2e.js "<grep>" [--headed]');
  process.exit(1);
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1500);
  });
}

(async () => {
  if (await portInUse(PORT)) {
    console.error(`ABORT: port ${PORT} is in use. These suites delete inventory masters.`);
    process.exit(2);
  }

  const tmpDir = fs.mkdtempSync(path.join(
    process.env.TEMP || process.env.TMP || '.', 'bscrm-e2e-one-',
  ));
  const testDb = path.join(tmpDir, 'suite-e2e.db');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), testDb);
  for (const s of ['-wal', '-shm']) {
    const src = path.join(ROOT, 'data', 'blackstack-crm.db' + s);
    if (fs.existsSync(src)) fs.copyFileSync(src, testDb + s);
  }

  // PHASE 3A — FINANCIAL YEAR: this clone must not inherit production's
  // financial-year LOCK state.
  //
  // Before this, the E2E suite's outcome depended on production data: the
  // 2026-10-09 audit probe left both production years is_locked=1, and
  // accounting-engine.service.postVoucher() — which inventory posting reaches
  // via server/services/inventory.service.js — refuses a locked year. That made
  // "Test 14: Post draft voucher through UI" fail while touching no E2E code.
  //
  // This is a FIXTURE decision on a throwaway copy, never a production write.
  // Production's intended lock state is a separate, still-open question.
  {
    const { DatabaseSync } = require('node:sqlite');
    const seed = new DatabaseSync(testDb);
    // NOTE: raw node:sqlite run() takes SPREAD args; passing an array binds it
    // as a named parameter and the UPDATE silently does nothing.
    seed.prepare('UPDATE financial_years SET is_locked = 0 WHERE company_id = ?').run('default');
    const lockedLeft = seed.prepare('SELECT COUNT(*) c FROM financial_years WHERE is_locked = 1').get().c;
    seed.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    seed.close();
    if (lockedLeft > 0) {
      console.error(
        `\nE2E ISOLATION REFUSED — disposable DB still has ${lockedLeft} locked financial year(s).\n`
        + '  The clone inherited a locked year and posting paths would fail for a\n'
        + '  reason unrelated to what the suite tests.\n',
      );
      process.exit(2);
    }
  }

  // PHASE 3A.1 — full isolation assertion, run BEFORE the server or the browser
  // starts. It validates the disposable DB this function just created and the
  // port the suite will target, and fails closed if either is unsafe.
  //
  // A pre-existing DB_PATH in the environment is a MISCONFIGURATION and is
  // rejected outright rather than silently overwritten. Overwriting it would let
  // `DB_PATH=<production> npx playwright test` look safe while quietly ignoring
  // the operator's mistake — the same class of silent misdirection that caused
  // the 2026-10-08 incident. This harness owns its own DB path.
  const inheritedDbPath = process.env.DB_PATH;
  if (inheritedDbPath) {
    const resolvedInherited = path.resolve(inheritedDbPath).toLowerCase().replace(/\\/g, '/');
    if (resolvedInherited.endsWith('/data/blackstack-crm.db')) {
      console.error(
        '\n' + '='.repeat(74) + '\n'
        + 'E2E ISOLATION REFUSED — run-one-e2e\n' + '='.repeat(74) + '\n'
        + `  • DB_PATH is set to the LIVE production database:\n`
        + `      ${inheritedDbPath}\n`
        + '  This harness creates its own disposable copy and will not accept a\n'
        + '  production path. Unset DB_PATH and re-run.\n',
      );
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
      process.exit(2);
    }
    console.error(
      'REFUSING TO RUN: DB_PATH is already set in the environment '
      + `(${inheritedDbPath}). This harness manages its own disposable database.\n`
      + '  Unset DB_PATH and re-run, so the target is unambiguous.',
    );
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    process.exit(2);
  }

  process.env.DB_PATH = testDb;
  try {
    const isolation = await assertE2eIsolation({ suite: 'run-one-e2e', requireFreePort: true });
    console.log(`[isolation] verified port ${isolation.port} (non-production, free)`);
    console.log(`[isolation] verified DB    ${isolation.dbPath}`);
  } catch (e) {
    console.error(e.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    process.exit(2);
  }

  const userDir = path.join(tmpDir, 'user-data');
  fs.mkdirSync(userDir, { recursive: true });

  const logFd = fs.openSync(path.join(tmpDir, 'server.log'), 'w');
  const server = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: testDb,
      BLACKSTACK_USER_DATA_DIR: userDir.replace(/\\/g, '/'),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', logFd, logFd],
  });
  const stop = () => { try { server.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', stop);

  // Wait for readiness on /health (mounted at the root, NOT under /api).
  // Retried generously: a 26-test browser run against a cold Node server can take
  // a while to bind on a loaded machine, and one readiness probe being early must
  // not fail the whole suite.
  let up = false;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) { up = true; break; } } catch (_) {}
  }
  if (!up) {
    console.error('server never became ready; log at', path.join(tmpDir, 'server.log'));
    // Surface the tail of the server log — "never ready" is otherwise opaque.
    try {
      console.error(fs.readFileSync(path.join(tmpDir, 'server.log'), 'utf8').slice(-1500));
    } catch (_) { /* log may not exist */ }
    process.exit(2);
  }
  console.log(`server ready on ${PORT} (isolated DB: ${path.basename(testDb)})\n`);

  const env = {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: testDb,
    E2E_PORT: String(PORT),
    E2E_HEADLESS: headed ? 'false' : 'true',
  };

  // Invoke the Playwright CLI entry directly (no shell) so --grep keeps its quotes.
  const cli = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
  const run = spawnSync(process.execPath, [
    cli, 'test',
    '--config=playwright.e2e.config.js',
    'tests/inventory.e2e.test.js',
    '--grep', grep,
    '--reporter=line',
  ], { cwd: ROOT, encoding: 'utf8', env, timeout: 600000, stdio: 'pipe' });

  const out = `${run.stdout || ''}${run.stderr || ''}`;
  process.stdout.write(out);
  if (!/passed|failed/.test(out)) {
    console.error('\n(playwright produced no pass/fail summary — see output above)');
  }

  stop();
  await new Promise((r) => setTimeout(r, 800));
  if (!process.env.KEEP_E2E_TMP) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  } else {
    // PHASE 3A.2 diagnostic: keep the temp dir (and therefore server.log) so a
    // failing run's server-side error can be read. Off unless explicitly set.
    console.log(`[tmp kept] ${tmpDir}`);
  }
  process.exit(run.status === null ? 2 : run.status);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
