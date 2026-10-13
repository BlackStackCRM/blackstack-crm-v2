#!/usr/bin/env node
/**
 * INSTALLER DATA-PRESERVATION ACCEPTANCE TEST (Master Prompt §6/§7/§63)
 *
 * Verifies REAL application behavior against a disposable environment:
 *
 *   A. Fresh install   — fresh temp user-data → server start → create data
 *                        via the real HTTP API → restart → data unchanged.
 *   B. Reinstall       — same user-data (as after a reinstall) → start →
 *                        previous records still present, no DB recreation.
 *   C. Update/migration— verified backup → safe migration → integrity_check
 *                        → data intact.
 *   D. Uninstall       — verified by configuration (deleteAppDataOnUninstall:
 *                        false) + user-data untouched by binary removal.
 *
 * ISOLATION GUARANTEE (§7):
 *   - A NEW temp user-data dir and temp DB are created per run.
 *   - The real %APPDATA% BlackStack dir and the project data/ DB are NEVER
 *     referenced. If the resolved DB path is NOT inside the temp dir, the
 *     test STOPS immediately.
 *
 * Usage: node tests/installer-data-preservation.mjs
 * Exit code 0 = all phases PASS.
 */
import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 34680; // dedicated test port, outside the desktop fallback range
const BASE = `http://127.0.0.1:${PORT}`;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bscrm-accept-'));
const userDataDir = path.join(tmpRoot, 'user-data');
const dbPath = path.join(userDataDir, 'database', 'blackstack-crm.db');

let failures = 0;
function pass(name) { console.log(`  PASS  ${name}`); }
function fail(name, detail) { failures++; console.error(`  FAIL  ${name}\n        ${detail}`); }

/** Safety gate: refuse to continue if not provably isolated (§7). */
function assertIsolated() {
  const realRoot = fs.realpathSync(tmpRoot);
  fs.mkdirSync(path.join(tmpRoot, 'user-data', 'database'), { recursive: true });
  const realDbDir = fs.realpathSync(path.dirname(dbPath));
  // The ONLY acceptable location is inside our own mkdtemp dir under the OS temp root.
  const insideTemp = realDbDir.startsWith(realRoot);
  if (!insideTemp) {
    console.error('FATAL: test environment is not provably isolated. DB path: ' + dbPath);
    process.exit(1);
  }
}

function serverEnv(extra = {}) {
  return {
    ...process.env,
    DB_PATH: dbPath,
    BLACKSTACK_USER_DATA_DIR: userDataDir,
    BLACKSTACK_DESKTOP: '1',
    PORT: String(PORT),
    NODE_ENV: 'production',
    DEMO_MODE: 'false',
    MIGRATION_BACKUP: 'true',
    ...extra,
  };
}

function startServer(label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(PROJ, 'server', 'app.js')], {
      env: serverEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    const deadline = Date.now() + 60000;
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`${BASE}/health`);
        if (r.ok) { clearInterval(poll); resolve({ proc, out }); }
      } catch { /* not ready */ }
      if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`[${label}] server not healthy in 60s\n--- output ---\n${out}`));
      }
    }, 500);
    proc.on('exit', (code) => { clearInterval(poll); reject(new Error(`[${label}] server exited code=${code}\n${out}`)); });
  });
}

function stopServer(handle) {
  return new Promise((resolve) => {
    if (!handle) return resolve();
    handle.proc.on('exit', resolve);
    try { handle.proc.kill(); } catch { /* already dead */ }
    setTimeout(() => { try { handle.proc.kill('SIGKILL'); } catch { /* ok */ } resolve(); }, 5000).unref();
  });
}

async function api(method, url, { token, body } = {}) {
  const res = await fetch(`${BASE}/api${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json.data ?? json;
}

const UNIQUE = 'acc' + crypto.randomBytes(3).toString('hex');

async function main() {
  assertIsolated();
  console.log(`Isolated test environment: ${tmpRoot}`);
  console.log(`Database: ${dbPath}\n`);

  let handle = null;

  // ── PHASE A: Fresh installation ──────────────────────────────────────────
  console.log('PHASE A — Fresh installation');
  try {
    // Seed the initial admin account exactly as the real first-run flow does
    // (server/database/seed.js). Isolated to the temp DB.
    // Migrations run first (fresh DB starts empty; seed needs the schema).
    const mig = spawnSync(process.execPath, [path.join(PROJ, 'server', 'database', 'migrate.js')], {
      env: serverEnv(),
      encoding: 'utf8',
      timeout: 120000,
    });
    if (mig.status !== 0) throw new Error('fresh migrate failed: ' + mig.stdout + mig.stderr);
    pass('fresh install: schema created by safe migrations');

    const seed = spawnSync(process.execPath, [path.join(PROJ, 'server', 'database', 'seed.js')], {
      env: serverEnv({ DEMO_MODE: 'true' }),
      encoding: 'utf8',
      timeout: 60000,
    });
    if (seed.status !== 0) throw new Error('seed failed: ' + seed.stdout + seed.stderr);
    pass('fresh install: initial admin account seeded');

    handle = await startServer('fresh');
    pass('fresh install: server starts and /health is OK');
    fs.mkdirSync(path.join(userDataDir, 'database'), { recursive: true });

    const login = await api('POST', '/auth/login', { body: { email: 'admin@blackstack.local', password: 'admin123' } });
    const token = login.token;
    pass('fresh install: admin login works');

    const contact = await api('POST', '/contacts', {
      token,
      body: { firstName: 'Acceptance', lastName: UNIQUE, email: `${UNIQUE}@example.com`, phone: '555-0100' },
    });
    const contactId = contact.id;
    pass(`fresh install: contact created (${contactId})`);

    await api('POST', '/products', {
      token,
      body: { name: `Acceptance Product ${UNIQUE}`, sku: `ACC-${UNIQUE}`, price: 99.5, isInventoryManaged: true },
    }).then((p) => pass(`fresh install: product created (${p.id})`))
      .catch((e) => fail('fresh install: product created', e.message));

    // Record baseline entity counts for later phases.
    const countOf = async (url) => {
      const page = await api('GET', url, { token });
      return page.pagination ? page.pagination.total : (Array.isArray(page) ? page.length : page.items ? page.items.length : 0);
    };
    const before = {
      contacts: await countOf('/contacts'),
      products: await countOf('/products'),
    };
    fs.writeFileSync(path.join(tmpRoot, 'baseline.json'), JSON.stringify({ contactId, before, unique: UNIQUE }, null, 2));
    pass(`fresh install: baseline recorded (contacts=${before.contacts}, products=${before.products})`);

    // Close application (graceful server shutdown).
    await stopServer(handle); handle = null;
    await new Promise((r) => setTimeout(r, 1000));
    pass('fresh install: application closed cleanly');
  } catch (e) {
    fail('PHASE A', e.message);
    await stopServer(handle);
    cleanup();
    process.exit(1);
  }

  // ── PHASE A2: Reopen — data unchanged (restart, §63 fresh-install step 7) ─
  console.log('PHASE A2 — Reopen after restart');
  try {
    handle = await startServer('reopen');
    const { token } = await api('POST', '/auth/login', { body: { email: 'admin@blackstack.local', password: 'admin123' } });
    const baseline = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'baseline.json'), 'utf8'));
    const found = await api('GET', '/contacts', { token });
    const items = found.items || found || [];
    const match = (Array.isArray(items) ? items : items.items || []).find((c) => c.id === baseline.contactId);
    if (match) pass('reopen: acceptance contact still present after restart');
    else fail('reopen: acceptance contact still present after restart', 'contact not found in /contacts');

    const db = fs.statSync(dbPath);
    if (db.size > 0) pass('reopen: database file reused (not recreated)');
    else fail('reopen: database file reused', 'db missing/empty');
  } catch (e) { fail('PHASE A2', e.message); }

  // ── PHASE B: Reinstall (user-data preserved, binaries replaced) ──────────
  console.log('PHASE B — Reinstall preservation');
  try {
    const baseline = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'baseline.json'), 'utf8'));
    // Simulate binary replacement: server restart on the SAME user-data.
    await stopServer(handle); handle = null;
    await new Promise((r) => setTimeout(r, 1000));
    handle = await startServer('reinstall');
    const { token } = await api('POST', '/auth/login', { body: { email: 'admin@blackstack.local', password: 'admin123' } });
    const found = await api('GET', '/contacts', { token });
    const items = (found.items || []);
    const match = (Array.isArray(items) ? items : []).find((c) => c.id === baseline.contactId);
    if (match) pass('reinstall: previously created records intact');
    else fail('reinstall: previously created records intact', 'contact missing');
    const mig = fs.existsSync(path.join(userDataDir, 'database', 'MIGRATED_FROM.txt'));
    if (!mig) pass('reinstall: existing user-data database reused (no recreation)');
    else fail('reinstall: existing user-data database reused', 'unexpected MIGRATED_FROM marker');
  } catch (e) { fail('PHASE B', e.message); }

  // ── PHASE C: Update / migration with verified backup ────────────────────
  console.log('PHASE C — Update/migration safety');
  try {
    await stopServer(handle); handle = null;
    await new Promise((r) => setTimeout(r, 1000));
    // Run the migration runner the same way a version update would.
    const mig = spawnSync(process.execPath, ['-e', `
      process.env.DB_PATH = ${JSON.stringify(dbPath)};
      process.env.BLACKSTACK_USER_DATA_DIR = ${JSON.stringify(userDataDir)};
      const { runSafeMigrations } = require(${JSON.stringify(path.join(PROJ, 'server', 'services', 'safeMigrationRunner.js'))});
      runSafeMigrations({ backup: true, verbose: false }).then((r) => {
        console.log('MIG_RESULT:' + JSON.stringify({ status: r.status, backup: !!(r.appliedBackup) }));
      }).catch((e) => { console.log('MIG_RESULT:' + JSON.stringify({ status: 'THREW', message: e.message })); });
    `], { encoding: 'utf8', timeout: 90000 });
    const line = (mig.stdout || '').split('\n').find((l) => l.startsWith('MIG_RESULT:'));
    if (!line) throw new Error('migration runner produced no result: ' + (mig.stderr || mig.stdout));
    const result = JSON.parse(line.slice('MIG_RESULT:'.length));
    if (result.status === 'OK' && result.backup) pass('update: safe migration ran with verified pre-migration backup');
    else fail('update: safe migration ran with verified pre-migration backup', JSON.stringify(result));

    // Integrity check on the migrated DB.
    const check = spawnSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(dbPath)});
      const ic = db.prepare('PRAGMA integrity_check').get();
      const fk = db.prepare('PRAGMA foreign_key_check').all();
      console.log('CHECKS:' + JSON.stringify({ ic: Object.values(ic)[0], fkViolations: fk.length }));
    `], { encoding: 'utf8', timeout: 30000 });
    const checks = JSON.parse(((check.stdout || '').split('\n').find((l) => l.startsWith('CHECKS:')) || '{}').slice(7) || '{}');
    if (String(checks.ic).toLowerCase() === 'ok' && checks.fkViolations === 0) pass('update: integrity_check OK, foreign_key_check clean');
    else fail('update: integrity_check OK, foreign_key_check clean', JSON.stringify(checks));

    // Data intact after migration.
    handle = await startServer('post-update');
    const { token } = await api('POST', '/auth/login', { body: { email: 'admin@blackstack.local', password: 'admin123' } });
    const baseline = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'baseline.json'), 'utf8'));
    const found = await api('GET', '/contacts', { token });
    const items = (found.items || []);
    const match = (Array.isArray(items) ? items : []).find((c) => c.id === baseline.contactId);
    if (match) pass('update: data intact after migration (contact present)');
    else fail('update: data intact after migration', 'contact missing');
  } catch (e) { fail('PHASE C', e.message); }

  // ── PHASE D: Uninstall preservation (configuration-verified) ─────────────
  console.log('PHASE D — Uninstall preservation');
  try {
    await stopServer(handle); handle = null;
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJ, 'package.json'), 'utf8'));
    const preserved = pkg.build?.nsis?.deleteAppDataOnUninstall === false;
    if (preserved) pass('uninstall: deleteAppDataOnUninstall=false — user data survives uninstall');
    else fail('uninstall: deleteAppDataOnUninstall=false', JSON.stringify(pkg.build?.nsis));
    if (fs.existsSync(dbPath)) pass('uninstall: user-data DB still present after app shutdown');
    else fail('uninstall: user-data DB still present', 'db gone');
  } catch (e) { fail('PHASE D', e.message); }

  cleanup();

  console.log('');
  if (failures === 0) {
    console.log('RESULT: ALL PHASES PASS — data preserved across fresh install, restart, reinstall, update and uninstall.');
    process.exit(0);
  } else {
    console.error(`RESULT: ${failures} failure(s).`);
    process.exit(1);
  }
}

function cleanup() {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* WAL lock; temp dir, harmless */ }
}

main().catch((e) => { console.error('FATAL:', e); cleanup(); process.exit(1); });


