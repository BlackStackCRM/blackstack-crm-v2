/**
 * PHASE B regression guard — the update / data-safety ROUTE contract.
 *
 * Phase A found two defects that 17 passing unit tests did not catch, because
 * every one of them called `require('server/services/updateService.js')` directly
 * and never exercised HTTP. This suite closes that gap.
 *
 * It asserts the full three-way authorization contract AND the response body:
 *
 *   anonymous                     -> 401
 *   authenticated, no permission  -> 403   (a real role_manager user)
 *   authenticated admin           -> 2xx with a valid payload
 *
 * Bodies matter. Both Phase A defects were a 500 and a 400 — a status-only test
 * would happily have reported "protected but working".
 *
 * Two specific regressions are pinned:
 *   1. `updateService.js` exports getChannel / setChannel / CHANNELS /
 *      checkSchemaCompatibility / getCurrentDbSchemaVersion as MODULE functions,
 *      not statics of the exported UpdateService object. The routes must use the
 *      module contract. A test calling `UpdateService.getChannel()` returns 500.
 *   2. `/api/datasafety/*` must stay behind authMiddleware +
 *      requirePermission('settings.manage'), and the Settings UI must reach those
 *      routes through the authenticated wrapper rather than a bare fetch().
 *
 * Runs entirely against a disposable database copy.
 */
import path from 'path';
import fs from 'fs';
import net from 'net';
import { spawn } from 'child_process';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.UPDATE_ROUTES_TEST_PORT || 3162);
const BASE = `http://127.0.0.1:${PORT}`;

let server = null;
let tmpDir = null;
let adminToken = null;
let managerToken = null;

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1200);
  });
}

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, token: j?.data?.token || null };
}

async function call(method, p, token, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}

beforeAll(async () => {
  expect(await portInUse(PORT)).toBe(false);

  tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'bscrm-updroutes-'));
  const testDb = path.join(tmpDir, 'routes.db');
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), testDb);

  // A real low-privilege account: role_manager holds 20 permissions and
  // deliberately NOT settings.manage, so it is a genuine 403 case rather than a
  // fabricated one.
  {
    const db = new DatabaseSync(testDb);
    const admin = db.prepare("SELECT password_hash FROM users WHERE id='admin'").get();
    db.prepare(`INSERT OR REPLACE INTO users
      (id, company_id, username, email, password_hash, full_name, role, status)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run('rt_manager', 'default', 'rt_manager', 'rt_manager@blackstack.local',
        admin.password_hash, 'Route Test Manager', 'MANAGER', 'ACTIVE');
    db.exec("DELETE FROM user_roles WHERE user_id='rt_manager'");
    db.exec("INSERT INTO user_roles (user_id, role_id) VALUES ('rt_manager','role_manager')");
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  }

  const logFd = fs.openSync(path.join(tmpDir, 'server.log'), 'w');
  server = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: testDb,
      BLACKSTACK_USER_DATA_DIR: path.join(tmpDir, 'ud').replace(/\\/g, '/'),
      NODE_ENV: '',
    },
    stdio: ['ignore', logFd, logFd],
  });
  process.on('exit', () => { try { server.kill('SIGKILL'); } catch (_) {} });

  let up = false;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch (_) {}
  }
  expect(up, 'server did not become ready').toBe(true);

  const admin = await login('admin@blackstack.local', 'admin123');
  const manager = await login('rt_manager@blackstack.local', 'admin123');
  expect(admin.status, `admin login failed: ${JSON.stringify(admin)}`).toBe(200);
  expect(manager.status, `manager login failed: ${JSON.stringify(manager)}`).toBe(200);
  adminToken = admin.token;
  managerToken = manager.token;
}, 120000);

afterAll(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch (_) {} }
  await new Promise((r) => setTimeout(r, 600));
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} }
});

/**
 * Every /api/datasafety route the Settings → Updates / Data Safety UI calls.
 * `target` is supplied where the route requires a query parameter — a 400 for a
 * missing required parameter is correct behaviour, not a defect.
 */
const UI_ROUTES = [
  { method: 'GET', path: '/api/datasafety/update-channel', label: 'read update channel' },
  { method: 'PUT', path: '/api/datasafety/update-channel', body: { channel: 'stable' }, label: 'write update channel' },
  { method: 'GET', path: '/api/datasafety/update-compatibility?target=2.0.0', label: 'schema compatibility' },
  { method: 'GET', path: '/api/datasafety/update-status', label: 'update status' },
  { method: 'GET', path: '/api/datasafety/backups/status', label: 'backup status' },
  { method: 'GET', path: '/api/datasafety/storage', label: 'storage dashboard' },
];

describe('PHASE B — update/data-safety route authorization contract', () => {
  describe.each(UI_ROUTES)('$method $path', ({ method, path: p, body, label }) => {
    test('anonymous -> 401', async () => {
      const r = await call(method, p, null, body);
      expect(r.status, `expected 401, body=${r.text.slice(0, 120)}`).toBe(401);
    });

    test('authenticated without settings.manage -> 403', async () => {
      expect(managerToken, 'manager token missing').toBeTruthy();
      const r = await call(method, p, managerToken, body);
      expect(r.status, `expected 403, body=${r.text.slice(0, 120)}`).toBe(403);
    });

    test('authorized admin -> 2xx with success:true', async () => {
      expect(adminToken, 'admin token missing').toBeTruthy();
      const r = await call(method, p, adminToken, body);
      expect(r.status, `expected 2xx, got ${r.status}: ${r.text.slice(0, 160)}`).toBeGreaterThanOrEqual(200);
      expect(r.status).toBeLessThan(300);
      expect(r.json?.success, `body was not a success envelope: ${r.text.slice(0, 160)}`).toBe(true);
      // Phase A's defects surfaced as 500 / "is not a function". Guard both.
      expect(r.text, 'response leaked a TypeError').not.toMatch(/is not a function/);
    });
  });
});

describe('PHASE B — update-channel behaviour', () => {
  test('GET returns the configured channel and the channel catalogue', async () => {
    const r = await call('GET', '/api/datasafety/update-channel', adminToken);
    expect(r.status).toBe(200);
    expect(typeof r.json?.data?.channel).toBe('string');
    expect(r.json.data.channel.length).toBeGreaterThan(0);
    // The catalogue is what Settings renders its radio group from.
    expect(r.json?.data?.channels).toBeTypeOf('object');
    expect(Object.keys(r.json.data.channels)).toEqual(
      expect.arrayContaining(['stable', 'beta', 'enterprise']),
    );
  });

  test('PUT accepts every valid channel and round-trips', async () => {
    for (const channel of ['beta', 'stable', 'enterprise']) {
      const r = await call('PUT', '/api/datasafety/update-channel', adminToken, { channel });
      expect(r.status, `${channel} -> HTTP ${r.status}`).toBe(200);
      expect(r.json?.data?.channel).toBe(channel);
    }
    // Leave it on the default for later runs.
    await call('PUT', '/api/datasafety/update-channel', adminToken, { channel: 'stable' });
  });

  test('PUT still rejects an unknown channel (validation intact)', async () => {
    const r = await call('PUT', '/api/datasafety/update-channel', adminToken, { channel: 'not-a-channel' });
    expect(r.status).toBe(400);
    expect(r.json?.error?.code).toBe('INVALID_CHANNEL');
  });

  test('PUT rejects a missing channel', async () => {
    const r = await call('PUT', '/api/datasafety/update-channel', adminToken, {});
    expect(r.status).toBe(400);
  });
});

describe('PHASE B — update-compatibility behaviour', () => {
  test('returns a verdict with schema context', async () => {
    const r = await call('GET', '/api/datasafety/update-compatibility?target=2.0.0', adminToken);
    expect(r.status).toBe(200);
    expect(r.json?.data?.result).toBeTruthy();
    expect(typeof r.json.data.currentApp).toBe('string');
    // The real DB schema version is read through getCurrentDbSchemaVersion().
    expect(r.json?.data?.dbSchemaVersion).not.toBeUndefined();
  });

  test('rejects a missing target with 400', async () => {
    const r = await call('GET', '/api/datasafety/update-compatibility', adminToken);
    expect(r.status).toBe(400);
    expect(r.json?.error?.code).toBe('VALIDATION_ERROR');
  });

  test('rejects a malformed target with 400', async () => {
    const r = await call('GET', '/api/datasafety/update-compatibility?target=not-a-version', adminToken);
    expect(r.status).toBe(400);
  });
});

describe('PHASE B — the module/static regression that caused Phase A', () => {
  test('updateService exposes channel/compat as MODULE functions, not UpdateService statics', () => {
    const svc = require_(path.join(ROOT, 'server/services/updateService.js'));

    // These are module-level exports...
    for (const fn of ['getChannel', 'setChannel', 'checkSchemaCompatibility', 'getCurrentDbSchemaVersion']) {
      expect(typeof svc[fn], `${fn} must be a module-level export`).toBe('function');
    }
    expect(svc.CHANNELS).toBeTypeOf('object');

    // ...and deliberately NOT statics of the exported UpdateService object. The
    // routes used to call UpdateService.getChannel(), which is undefined, and
    // every authorized request got a 500. If a future refactor adds them as
    // statics too, that divergence is what let the bug hide — so assert the
    // routes use the module form explicitly.
    expect(typeof svc.UpdateService, 'UpdateService object should still exist').toBe('object');
    expect(
      svc.UpdateService.getChannel,
      'UpdateService.getChannel unexpectedly exists — if the routes were migrated to '
      + 'the static form, this test and the routes must be reconciled deliberately.',
    ).toBeUndefined();
  });

  test('dataSafety.js routes use the module-level contract', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/routes/dataSafety.js'), 'utf8');
    // Strip comments so the explanatory text does not trip the assertions.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const bad of [
      'UpdateService.getChannel',
      'UpdateService.setChannel',
      'UpdateService.CHANNELS',
      'UpdateService.checkSchemaCompatibility',
      'UpdateService.getCurrentDbSchemaVersion',
    ]) {
      expect(code, `${bad} does not exist on the UpdateService object`).not.toContain(bad);
    }
    // getUpdateStatus IS a genuine static and must stay on the static call.
    expect(code).toContain('UpdateService.getUpdateStatus');
  });

  test('Settings UI authenticates its data-safety calls', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/pages/settings.js'), 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // A bare fetch() sends no Authorization header, so every protected
    // /api/datasafety call answered 401 and the Updates tab silently fell back.
    expect(code, 'settings.js must not call protected routes with a bare fetch()')
      .not.toMatch(/fetch\(\s*['"`]\/api\/datasafety/);
    // It must actually use the authenticated wrapper for those routes.
    expect(code).toMatch(/window\.API\.(get|post|put)\(\s*['"`]\/datasafety\//);
  });

  test('the data-safety guard is still applied', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/routes/dataSafety.js'), 'utf8');
    expect(src).toContain("requirePermission('settings.manage')");
    expect(src).toContain('authMiddleware');
    // Every route except the intentionally public /version must sit behind it.
    // Capture what ACTUALLY follows the path in each registration, rather than
    // using a negative lookahead: a lookahead asserted against a multi-token
    // middleware chain does not skip it, so every route looked unguarded.
    const registrations = [...src.matchAll(
      /router\.(?:get|post|put)\(\s*'([^']+)'\s*,([^\n]*)/g,
    )].map((m) => ({ route: m[1], chain: m[2] }));

    expect(registrations.length, 'no routes parsed — the scan is not seeing the file')
      .toBeGreaterThan(10);

    const unguarded = registrations
      .filter((r) => !r.chain.includes('requireDataSafety'))
      // /version is intentionally public: the updater reads it before login.
      .filter((r) => r.route !== '/version')
      .map((r) => r.route);

    expect(unguarded, `routes missing the guard: ${unguarded.join(', ')}`).toEqual([]);
  });
});