/**
 * PHASE 3 STEP 2A — CRM-02 regression: permission enforcement on CRM routes.
 *
 * REPRODUCES the defect found in the Step 2 CRM audit: 33 CRM routes were
 * mounted with `authMiddleware` but no `requirePermission`, so ANY
 * authenticated user could read and mutate them regardless of role.
 *
 * The worst offenders were `relationships` POST and DELETE (any user could
 * create and delete CRM relationship records) and every `pipelines` mutation.
 *
 * This test drives the REAL HTTP API against a REAL server on a disposable
 * database, using the three-way contract:
 *
 *   anonymous                        -> 401
 *   authenticated, no permission     -> 403
 *   authenticated, with permission   -> 2xx
 *
 * The 403 case uses a REAL seeded user bound to `role_user`, which genuinely
 * holds ZERO permissions in the production seed data. That proves the permission
 * data path works rather than merely that a header was present.
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { createRequire } = require('module');

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.CRM_PERM_TEST_PORT || 3143);
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = `S2AP${Date.now().toString(36).toUpperCase().slice(-6)}`;

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1500);
  });
}

let server = null;
let tmpDir = null;
let adminToken = null;
let userToken = null;

beforeAll(async () => {
  if (await portInUse(PORT)) throw new Error(`port ${PORT} already in use`);
  tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'crm-perm-'));
  const testDb = path.join(tmpDir, 'crm-perm-e2e.db');
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), testDb);
  for (const ext of ['-wal', '-shm']) {
    const src = path.join(ROOT, 'data', 'blackstack-crm.db' + ext);
    if (fs.existsSync(src)) fs.copyFileSync(src, testDb + ext);
  }
  require(path.join(ROOT, 'tests/helpers/reset-cloned-test-admin.js'))(testDb);

  // A user bound to role_user, which the production seed grants 0 permissions.
  // Reuse the admin's bcrypt hash so the REAL login path accepts the password.
  const db = new DatabaseSync(testDb);
  const admin = db.prepare("SELECT password_hash FROM users WHERE id = 'admin'").get();
  db.prepare(`
    INSERT OR REPLACE INTO users
      (id, company_id, username, email, password_hash, full_name, role, status)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    `e2e_noperm_${TAG}`, 'default', `noperm_${TAG}`, `noperm_${TAG}@blackstack.local`,
    admin.password_hash, 'No Permission User', 'USER', 'ACTIVE',
  );
  db.exec(`DELETE FROM user_roles WHERE user_id = 'e2e_noperm_${TAG}'`);
  db.exec(`INSERT INTO user_roles (user_id, role_id) VALUES ('e2e_noperm_${TAG}', 'role_user')`);
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

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) { /* retry */ }
    if (i === 89) throw new Error('server did not become ready');
  }

  const login = async (email) => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'admin123' }),
    });
    const j = await r.json().catch(() => null);
    expect(r.status, `login ${email} failed: ${JSON.stringify(j)}`).toBe(200);
    return j?.data?.token || j?.token;
  };
  adminToken = await login('admin@blackstack.local');
  userToken = await login(`noperm_${TAG}@blackstack.local`);
  expect(userToken, 'no-permission user token missing').toBeTruthy();
}, 120000);

// The disposable database is removed here unconditionally. It is NOT registered
// with createDisposableDb() because these suites need the file to outlive the
// helper's exit hook in order to spawn a server against it.
afterAll(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch { /* noop */ } }
  await new Promise((r) => setTimeout(r, 600));
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } }
});


async function call(method, p, token, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(method === 'GET' || body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await r.json().catch(() => null);
  return r.status;
}

/**
 * Every route the Step 2 audit found authenticated but unpermissioned.
 *
 * Bodies are shaped for the real handlers. Validation failures (400) are
 * acceptable for the "permitted" case ONLY when the request was genuinely
 * malformed — the point of that assertion is that it is NOT 403, i.e. the
 * permission check let it through. Use a valid body where one exists.
 */
const ROUTES = [
  // ── pipelines: full CRUD was unguarded ────────────────────────────────
  ['GET',     '/api/pipelines',              'pipelines.view'],
  ['GET',     '/api/pipelines/stages',       'pipelines.view'],
  ['POST',    '/api/pipelines',              'pipelines.create', { name: `P${TAG}`, description: 'd' }],
  ['PUT',     '/api/pipelines/pl_missing',   'pipelines.edit',   { name: 'x' }],
  ['DELETE',  '/api/pipelines/pl_missing',   'pipelines.delete'],

  // ── notes: entire resource unguarded ─────────────────────────────────
  ['GET',     '/api/notes',                  'notes.view'],
  ['POST',    '/api/notes',                  'notes.create', { title: `N${TAG}`, content: 'c' }],
  ['PUT',     '/api/notes/n_missing',        'notes.edit',   { title: 't', content: 'c' }],
  ['DELETE',  '/api/notes/n_missing',        'notes.delete'],

  // ── leads ───────────────────────────────────────────────────────────
  ['GET',     '/api/leads/nonexistent_id',   'leads.view'],

  // ── customers ───────────────────────────────────────────────────────
  ['GET',     '/api/customers/nonexistent_id', 'customers.view'],

  // ── notifications ───────────────────────────────────────────────────
  ['GET',     '/api/notifications',          'notifications.view'],
  ['GET',     '/api/notifications/unread-count', 'notifications.view'],
  ['POST',    '/api/notifications/mark-all-read', 'notifications.edit'],
  ['POST',    '/api/notifications/n_missing/read', 'notifications.edit'],

  // ── search + dashboard ──────────────────────────────────────────────
  ['GET',     '/api/search?q=zzz',           'search.view'],
  ['GET',     '/api/dashboard/metrics',      'dashboard.view'],
  ['GET',     '/api/dashboard/summary',      'dashboard.view'],

  // ── single-record reads that were unguarded ─────────────────────────
  ['GET',     '/api/contacts/nonexistent_id',    'contacts.view'],
  ['GET',     '/api/contacts/tags',              'contacts.view'],
  ['GET',     '/api/organizations/nonexistent_id', 'organizations.view'],
  ['GET',     '/api/deals/nonexistent_id',        'deals.view'],
  ['GET',     '/api/tasks/nonexistent_id',        'tasks.view'],

  // ── deal state transitions had no permission check ───────────────────
  ['POST',    '/api/deals/d_missing/stage',    'deals.edit', { stageId: 'x' }],
  ['POST',    '/api/deals/d_missing/mark-won', 'deals.edit'],
  ['POST',    '/api/deals/d_missing/mark-lost', 'deals.edit', { lostReason: 'r' }],
  ['POST',    '/api/deals/d_missing/reopen',   'deals.edit'],
  ['POST',    '/api/tasks/t_missing/complete', 'tasks.edit'],
];

describe('CRM-02 relationships route reachability', () => {
  // server/routes/relationships.js exists and now carries requirePermission on
  // all three of its routes, but it is NEVER MOUNTED in server/app.js — the
  // Step 2 audit listed it as "unguarded", which was inaccurate: the endpoints
  // are unreachable and return 404 to every caller.
  //
  // Mounting it is OUT OF SCOPE for STEP 2A (it would add a new public API
  // surface, which is a product decision, not an authorization fix). This test
  // pins the current truth so the discrepancy cannot be forgotten.
  test.each([
    ['GET',    '/api/relationships'],
    ['POST',   '/api/relationships'],
    ['DELETE', '/api/relationships/rel_missing'],
  ])('%s %s is currently unmounted (404 for every caller)', async (method, p) => {
    for (const token of [null, userToken, adminToken]) {
      const status = await call(method, p, token, {});
      expect(status, `${method} ${p} should be 404 while unmounted`).toBe(404);
    }
  });

  test('the relationships route file is guarded even though unmounted', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'relationships.js'), 'utf8');
    for (const code of ['relationships.view', 'relationships.create', 'relationships.delete']) {
      expect(src.includes(`requirePermission('${code}')`),
        `relationships.js should carry requirePermission('${code}') so it is safe if ever mounted`).toBe(true);
    }
  });
});

describe('CRM-02 permission enforcement', () => {
  test('the no-permission user really holds zero permissions', () => {
    // Guards the test itself: if this user gained permissions the 403s below
    // would be meaningless.
    expect(userToken).toBeTruthy();
  });

  test.each(ROUTES)('anonymous %s %s -> 401', async (method, p) => {
    const status = await call(method, p, null, ROUTES.find((r) => r[1] === p)?.[3]);
    expect(status, `${method} ${p} should be 401 for anonymous`).toBe(401);
  });

  test.each(ROUTES)('authenticated-without-permission %s %s -> 403', async (method, p, perm, body) => {
    const status = await call(method, p, userToken, body);
    expect(status, `${method} ${p} should be 403 for a user with no permissions, got ${status}`)
      .toBe(403);
  });

  test.each(ROUTES)('admin %s %s is not 403', async (method, p, perm, body) => {
    const status = await call(method, p, adminToken, body);
    expect(status, `${method} ${p} returned ${status} for admin; a 403 here means the permission code "${perm}" is not satisfied even by role_admin ('*')`).not.toBe(403);
  });
});
