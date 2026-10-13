/**
 * PHASE 3 STEP 3D — CRM-06 regression: activities has no delete handler.
 *
 * REPRODUCES the finding recorded in the Step 2 CRM audit:
 *
 *   GET /api/activities    -> list
 *   POST /api/activities   -> create
 *   DELETE /api/activities/:id -> DOES NOT EXIST
 *
 * The activities router is mounted at /api/activities but exposes only two verbs.
 * Every comparable CRM entity — tasks, notes, appointments, deals, contacts —
 * can be deleted. Activities cannot, so a logged activity (a call, a meeting, a
 * note-to-self about a deal) is permanent and unretractable through the API.
 *
 * Policy under test — matching the established convention for the sibling
 * entities (tasks, notes, appointments), all of which use a tenant-scoped
 * permanent DELETE:
 *
 *   1. DELETE /api/activities/:id removes the activity.
 *   2. It is tenant-scoped: an activity belonging to another company is NOT
 *      deleted and must report 404.
 *   3. A non-existent activity returns 404.
 *   4. An unauthenticated request is rejected 401 and changes nothing.
 *   5. Deleting is permanent — no soft-delete flag is introduced.
 *
 * Why no dependency pre-check: `activities.id` has ZERO inbound foreign keys
 * (verified against the live schema), so an activity delete cannot cascade into
 * any other table. The siblings in this family are plain deletes for the same
 * reason.
 *
 * Why no `activities.delete` permission is invented here: the permission table
 * has activities.create and activities.view but NO activities.delete. Adding one
 * is a schema + role-grant change, which is outside this step's scope, so this
 * test asserts the EXISTING permission surface is used and that the route is
 * permission-gated consistently with its siblings.
 *
 * Real HTTP API, real server, disposable database.
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { createRequire } = require('module');

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.CRM06_TEST_PORT || 3177);
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = `S3D${Date.now().toString(36).toUpperCase().slice(-6)}`;

const RESERVED_PORTS = [3111, 3141, 3143, 3145, 3162, 3171, 3173, 3175];

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
let dbPath = null;
let token = null;

function exec(sql, params = []) {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare(sql).run(...params); } finally { db.close(); }
}
function q1(sql, params = []) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(sql).get(...params); } finally { db.close(); }
}
const actCount = (id) => q1('SELECT COUNT(*) AS c FROM activities WHERE id = ?', [id]).c;

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json, text: JSON.stringify(json || {}) };
}

/** Insert an activity directly; activities has no create-with-all-columns API. */
function mkActivity(label, companyId = 'default') {
  const id = `act_${TAG}_${label}`;
  exec(`INSERT INTO activities (id, company_id, type, title, description, created_at)
        VALUES (?, ?, 'CALL', ?, ?, datetime('now'))`,
  [id, companyId, `${TAG} activity ${label}`, `${TAG} notes`]);
  return id;
}

beforeAll(async () => {
  expect(RESERVED_PORTS).not.toContain(PORT);
  expect(await portInUse(PORT)).toBe(false);

  tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'crm06-'));
  dbPath = path.join(tmpDir, 'crm06-e2e.db');
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), dbPath);
  for (const s of ['-wal', '-shm']) {
    const src = path.join(ROOT, 'data', 'blackstack-crm.db' + s);
    if (fs.existsSync(src)) fs.copyFileSync(src, dbPath + s);
  }
  {
    const seed = new DatabaseSync(dbPath);
    seed.prepare('UPDATE financial_years SET is_locked = 0 WHERE company_id = ?').run('default');
    seed.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    seed.close();
  }

  const logFd = fs.openSync(path.join(tmpDir, 'server.log'), 'w');
  server = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: dbPath,
      BLACKSTACK_USER_DATA_DIR: path.join(tmpDir, 'ud').split(path.sep).join('/'),
      NODE_ENV: '',
    },
    stdio: ['ignore', logFd, logFd],
  });
  process.on('exit', () => { try { server.kill('SIGKILL'); } catch { /* noop */ } });

  let up = false;
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { const r = await fetch(`${BASE}/health`); if (r.ok) { up = true; break; } } catch { /* retry */ }
  }
  expect(up, 'server did not become ready').toBe(true);

  const login = await api('POST', '/api/auth/login', { email: 'admin@blackstack.local', password: 'admin123' });
  expect(login.status, `login failed: ${login.text.slice(0, 160)}`).toBeLessThan(400);
  token = login.json?.data?.token || login.json?.token;
  expect(token).toBeTruthy();
}, 120000);

afterAll(async () => {
  try { if (server) server.kill('SIGKILL'); } catch { /* noop */ }
  try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('CRM-06 — activities must expose a delete handler', () => {
  test('an activity is permanently deletable', async () => {
    const id = mkActivity('deletable');
    expect(actCount(id)).toBe(1);

    const res = await api('DELETE', `/api/activities/${id}`);

    expect(res.status, `delete must succeed: ${res.text.slice(0, 220)}`).toBeLessThan(400);
    expect(actCount(id), 'the activity must be gone — deletion is permanent').toBe(0);
  });

  test('deleting a NON-EXISTENT activity returns 404', async () => {
    const res = await api('DELETE', `/api/activities/act_${TAG}_ghost`);
    expect(res.status).toBe(404);
    expect(res.json?.error?.code).toBe('NOT_FOUND');
  });

  test('deletion is TENANT-scoped: another company’s activity survives', async () => {
    const other = mkActivity('other-tenant', 'other_company');
    expect(actCount(other)).toBe(1);

    const res = await api('DELETE', `/api/activities/${other}`);

    expect(res.status, `cross-tenant delete must not succeed: ${res.text.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
    expect(actCount(other), 'a row owned by another company must NOT be deleted').toBe(1);
  });

  test('an UNAUTHENTICATED delete is rejected and changes nothing', async () => {
    const id = mkActivity('unauth');
    const saved = token;
    token = null;
    const res = await api('DELETE', `/api/activities/${id}`);
    token = saved;
    expect([401, 403], `expected auth failure, got ${res.status}`).toContain(res.status);
    expect(actCount(id), 'the activity must survive an unauthenticated attempt').toBe(1);
  });

  test('the route is permission-gated like its sibling entities', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'activities.js'), 'utf8');
    // Plain substring checks: an earlier version used regex literals whose
    // escaped slashes Vite rejected outright, and `node --check` passed because
    // it parsed the file as CommonJS.
    expect(src, 'DELETE /:id must exist').toContain("router.delete('/:id'");
    expect(src, 'every verb must be behind authMiddleware').toMatch(/authMiddleware/);
    // The permission must be one that EXISTS. activities.delete does not exist
    // in the permission table, so the route reuses an existing one rather than
    // inventing a code that would deny every role.
    const perms = q1("SELECT COUNT(*) AS c FROM permissions WHERE code = 'activities.delete'").c;
    if (perms === 0) {
      expect(src, 'must use an EXISTING permission code').toMatch(
        /requirePermission\('activities\.(view|create|edit)'\)/,
      );
    }
  });

  test('activities has no inbound foreign keys, so a delete cannot cascade', () => {
    // Structural guarantee behind choosing a plain delete over a
    // refuse-when-referenced policy.
    const d = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
      const inbound = [];
      for (const tb of tables) {
        for (const fk of d.prepare(`PRAGMA foreign_key_list("${tb}")`).all()) {
          if (fk.table === 'activities') inbound.push(`${tb}.${fk.from}`);
        }
      }
      expect(inbound, `activities must have no dependents: ${inbound.join(', ')}`).toEqual([]);
    } finally { d.close(); }
  });
});

describe('CRM-06 — no production database was touched', () => {
  test('no fixture row exists in production', () => {
    const prod = new DatabaseSync(path.join(ROOT, 'data', 'blackstack-crm.db'), { readOnly: true });
    try {
      const n = prod.prepare('SELECT COUNT(*) AS c FROM activities WHERE id LIKE ?').get(`%${TAG}%`).c;
      expect(n, 'production contains this run’s fixtures').toBe(0);
    } finally { prod.close(); }
  });
});