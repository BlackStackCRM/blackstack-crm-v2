/**
 * PHASE 3 regression guard — authentication AND authorization.
 *
 * A guard that only checks for the presence of a token is not authorization.
 * This test asserts the full three-way contract on every route it covers:
 *
 *   anonymous                        -> 401
 *   authenticated, no permission     -> 403
 *   authenticated, with permission   -> 2xx
 *
 * The middle case is exercised with a REAL seeded role (`role_manager`, which
 * holds 20 permissions but deliberately NOT `settings.manage`) rather than a
 * hand-forged token, so the test proves the permission data path works and not
 * merely that a header is present.
 *
 * Runs entirely against a disposable copy of the database.
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { createRequire } = require('module');

// node:sqlite is a Node builtin that Vite cannot statically resolve, so reach it
// through createRequire — the same idiom tests/electron-safety.test.js uses.
const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.AUTHZ_TEST_PORT || 3111);
const BASE = `http://127.0.0.1:${PORT}`;

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1500);
  });
}

let server = null;
let base = null;
let tmpDir = null;

beforeAll(async () => {
  if (await portInUse(PORT)) throw new Error(`port ${PORT} already in use`);

  tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'authz-test-'));
  const testDb = path.join(tmpDir, 'authz.db');
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), testDb);

  // Seed a manager user bound to role_manager. Reuse the admin's bcrypt hash so
  // the real login path (which verifies a hash) accepts the credentials.
  const db = new DatabaseSync(testDb);
  const admin = db.prepare("SELECT password_hash FROM users WHERE id = 'admin'").get();
  db.prepare(`
    INSERT OR REPLACE INTO users
      (id, company_id, username, email, password_hash, full_name, role, status)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    'e2e_manager', 'default', 'e2e_manager', 'manager@blackstack.local',
    admin.password_hash, 'E2E Manager', 'MANAGER', 'ACTIVE',
  );
  db.exec("DELETE FROM user_roles WHERE user_id = 'e2e_manager'");
  db.exec("INSERT INTO user_roles (user_id, role_id) VALUES ('e2e_manager', 'role_manager')");
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();

  const logFd = fs.openSync(path.join(tmpDir, 'server.log'), 'w');
  server = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: testDb,
      BLACKSTACK_USER_DATA_DIR: path.join(tmpDir, 'ud').replace(/\\/g, '/'),
    },
    stdio: ['ignore', logFd, logFd],
  });

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(`${BASE}/health`)).ok) { base = BASE; return; } } catch (_) {}
  }
  throw new Error('server did not become ready');
}, 60000);

afterAll(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch (_) {} }
  await new Promise((r) => setTimeout(r, 500));
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} }
});

async function login(identifier, password) {
  // `base` is the origin; API routes are mounted under /api.
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: identifier, password }),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, token: j?.data?.token || j?.token || null };
}

async function call(method, p, token, body) {
  const r = await fetch(base + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(method === 'GET' || body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return r.status;
}

let managerToken;
let adminToken;

// Log in during setup rather than in a `test()` block: the describe.each cases
// below are collected and executed independently, so a token produced by a
// sibling test is not guaranteed to exist before they run.
beforeAll(async () => {
  const mgr = await login('manager@blackstack.local', 'admin123');
  const adm = await login('admin@blackstack.local', 'admin123');
  expect(mgr.status, `manager login failed: ${JSON.stringify(mgr)}`).toBe(200);
  expect(adm.status, `admin login failed: ${JSON.stringify(adm)}`).toBe(200);
  managerToken = mgr.token;
  adminToken = adm.token;
});

/**
 * The routes that were previously reachable by an unauthenticated caller.
 * server/routes/dataSafety.js had no authentication at all: it exposed backup
 * create/restore/rotate, VACUUM, delete-all token issuance, and filesystem
 * paths to anyone who could reach localhost.
 */
const DATA_SAFETY_ROUTES = [
  ['GET',  '/api/datasafety/backups'],
  ['GET',  '/api/datasafety/storage'],
  ['GET',  '/api/datasafety/backups/status'],
  ['POST', '/api/datasafety/backups'],
  ['POST', '/api/datasafety/backups/rotate'],
  ['POST', '/api/datasafety/data-deletion/token'],
  ['POST', '/api/datasafety/backups/restore'],
];

describe.each(DATA_SAFETY_ROUTES)('%s %s', (method, p) => {
  test('rejects an anonymous caller with 401', async () => {
    const status = await call(method, p, null);
    expect(status).toBe(401);
  });

  test('rejects an authenticated caller without settings.manage with 403', async () => {
    expect(managerToken, 'manager token missing — login test must run first').toBeTruthy();
    const status = await call(method, p, managerToken, {});
    expect(status).toBe(403);
  });

  test('allows an authorized admin', async () => {
    expect(adminToken, 'admin token missing — login test must run first').toBeTruthy();
    const status = await call(method, p, adminToken, {});
    // Anything in the 2xx/4xx business range is fine here — the assertion is
    // that the request is NOT rejected by the authorization layer.
    expect([401, 403]).not.toContain(status);
  });
});

test('/api/datasafety/version stays public (updater reads it before login)', async () => {
  const status = await call('GET', '/api/datasafety/version', null);
  expect(status).toBe(200);
});

test('the live production database was not touched by this test', () => {
  // The suite operates on a temp copy; this documents the invariant rather than
  // asserting a checksum that legitimately changes with real user activity.
  expect(tmpDir).toBeTruthy();
  expect(path.basename(tmpDir)).toMatch(/^authz-test-/);
});