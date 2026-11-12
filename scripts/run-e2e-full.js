/**
 * PHASE 4 — Full-software E2E runner.
 *
 * `npm run test:e2e` runs the WHOLE application suite by default: every module
 * in tests/e2e/coverage-manifest.js plus the cross-module integration flows.
 * It is not a smoke test and it does not silently narrow to one page.
 *
 * Isolation is inherited from the proven scripts/run-one-e2e.js approach:
 *   - a fresh temp directory OUTSIDE data/
 *   - production copied in, financial years unlocked on the COPY only
 *   - a pre-existing DB_PATH is refused rather than silently overwritten
 *   - assertE2eIsolation() runs BEFORE the server or browser starts
 *   - the port must be free and must not be a production port
 *   - the temp tree is removed on exit unless KEEP_E2E_TMP=1
 *
 * Usage:
 *   node scripts/run-e2e-full.js                    # whole suite
 *   node scripts/run-e2e-full.js --headed           # watch the browser
 *   node scripts/run-e2e-full.js --grep "Chart"    # targeted, for debugging
 *   node scripts/run-e2e-full.js --project=modules # only the module sweep
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { assertE2eIsolation } = require('./assert-e2e-isolation');

const ROOT = path.join(__dirname, '..');
// Never default to 3000: that is the production port, and defaulting to it is
// what caused the 2026-10-08 incident.
const PORT = Number(process.env.E2E_PORT || 3199);
const headed = process.argv.includes('--headed');
const grepArg = (() => {
  const i = process.argv.indexOf('--grep');
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith('--grep='));
  return inline ? inline.split('=').slice(1).join('=') : null;
})();
const projectArg = (() => {
  const i = process.argv.indexOf('--project');
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith('--project='));
  return inline ? inline.split('=').slice(1).join('=') : null;
})();

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
    console.error(`ABORT: port ${PORT} is in use. Free it, or set E2E_PORT to another port.`);
    process.exit(2);
  }

  const tmpDir = fs.mkdtempSync(path.join(
    process.env.TEMP || process.env.TMP || '.', 'bscrm-e2e-full-',
  ));
  const testDb = path.join(tmpDir, 'suite-e2e.db');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), testDb);
  for (const s of ['-wal', '-shm']) {
    const src = path.join(ROOT, 'data', 'blackstack-crm.db' + s);
    if (fs.existsSync(src)) fs.copyFileSync(src, testDb + s);
  }
  // The source DB can contain a disabled admin with an operator-specific
  // password. Normalize credentials on this disposable clone so E2E exercises
  // browser behavior instead of depending on local operator account state.
  require(path.join(ROOT, 'tests', 'helpers', 'reset-cloned-test-admin'))(testDb);

  // Unlock financial years ON THE CLONE. Production's lock state is a separate,
  // still-open question and must not influence test outcomes.
  {
    const { DatabaseSync } = require('node:sqlite');
    const seed = new DatabaseSync(testDb);
    // NOTE: raw node:sqlite run() takes SPREAD args; an array binds as a named
    // parameter and the UPDATE silently does nothing.
    seed.prepare('UPDATE financial_years SET is_locked = 0 WHERE company_id = ?').run('default');
    const lockedLeft = seed.prepare('SELECT COUNT(*) c FROM financial_years WHERE is_locked = 1').get().c;
    seed.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    seed.close();
    if (lockedLeft > 0) {
      console.error(`\nE2E ISOLATION REFUSED — disposable DB still has ${lockedLeft} locked financial year(s).`);
      process.exit(2);
    }
  }

  // Refuse an inherited production DB_PATH rather than quietly ignoring it.
  const inherited = process.env.DB_PATH;
  if (inherited) {
    const resolved = path.resolve(inherited).toLowerCase().replace(/\\/g, '/');
    const isProd = resolved.endsWith('/data/blackstack-crm.db');
    console.error(
      '\n' + '='.repeat(74) + '\n'
      + 'E2E ISOLATION REFUSED — run-e2e-full\n' + '='.repeat(74) + '\n'
      + `  DB_PATH is already set to ${isProd ? 'the LIVE PRODUCTION database' : 'another path'}:\n`
      + `      ${inherited}\n`
      + '  This harness creates its own disposable copy and will not accept an\n'
      + '  inherited target. Unset DB_PATH and re-run.\n',
    );
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    process.exit(2);
  }

  process.env.DB_PATH = testDb;
  // The RBAC UI browser spec needs Agency / Sub-agency / Customer fixtures.
  // Seed them only after the runner has selected its disposable clone; this
  // never creates accounts in the configured Supabase Auth project.
  require(path.join(ROOT, 'tests', 'fixtures', 'seed-rbac-ui-users'));
  try {
    const isolation = await assertE2eIsolation({ suite: 'run-e2e-full', requireFreePort: true });
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
  const stop = () => { try { server.kill('SIGKILL'); } catch { /* noop */ } };
  process.on('exit', stop);

  let up = false;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) { up = true; break; } } catch { /* retry */ }
  }
  if (!up) {
    console.error('server never became ready; log at', path.join(tmpDir, 'server.log'));
    try { console.error(fs.readFileSync(path.join(tmpDir, 'server.log'), 'utf8').slice(-2000)); } catch { /* noop */ }
    process.exit(2);
  }
  console.log(`server ready on ${PORT} (disposable DB: ${path.basename(testDb)})\n`);

  const env = {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: testDb,
    E2E_PORT: String(PORT),
    E2E_BASE_URL: `http://localhost:${PORT}`,
    // Default HEADED: the task requires a visible browser for ordinary local runs.
    // CI sets E2E_HEADLESS=true explicitly.
    E2E_HEADLESS: headed ? 'false' : (process.env.E2E_HEADLESS || 'false'),
    E2E_RUN_TAG: process.env.E2E_RUN_TAG || `E2E${Date.now().toString(36).toUpperCase().slice(-6)}`,
  };

  const cli = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
  const argv = [
    cli, 'test',
    '--config=playwright.full.config.js',
    'tests/e2e',
  ];
  if (grepArg) argv.push('--grep', grepArg);
  if (projectArg) argv.push('--project', projectArg);
  argv.push('--reporter=line');

  console.log(`[run] playwright ${argv.slice(2).join(' ')}`);
  console.log(`[run] browser: ${env.E2E_HEADLESS === 'false' ? 'HEADED (visible)' : 'headless'}\n`);

  const run = spawnSync(process.execPath, argv, {
    cwd: ROOT, encoding: 'utf8', env, timeout: 3600000, stdio: 'pipe',
  });

  const out = `${run.stdout || ''}${run.stderr || ''}`;
  process.stdout.write(out);
  if (!/passed|failed/.test(out)) {
    console.error('\n(playwright produced no pass/fail summary — see output above)');
  }

  stop();
  await new Promise((r) => setTimeout(r, 800));
  if (!process.env.KEEP_E2E_TMP) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  } else {
    console.log(`[tmp kept] ${tmpDir}`);
  }
  process.exit(run.status === null ? 2 : run.status);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
