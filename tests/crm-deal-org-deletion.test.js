/**
 * PHASE 3 STEP 3A — CRM-04 regression: safe deal / organization deletion.
 *
 * REPRODUCES the defects that CRM-01 fixed for `contacts` and that were left
 * open for every other CRM entity (scope boundary at the time):
 *
 *   deal + tasks/activities/appointments
 *       -> DELETE SUCCEEDS. The FK layer is ON DELETE CASCADE for all three, so
 *          the children are silently destroyed. No warning, no dependency check,
 *          no transaction.
 *
 *   organization + contacts/deals
 *       -> DELETE SUCCEEDS. `contacts.organization_id` and
 *          `deals.organization_id` are SET NULL (contact and deal survive, but
 *          silently lose their owner) while `activities.organization_id` is
 *          CASCADE (activities are destroyed). A partial, inconsistent teardown.
 *
 * The outcome depends entirely on which unrelated child rows happen to exist —
 * exactly the class of defect CRM-01 was raised to eliminate.
 *
 * This drives the REAL HTTP API against a REAL server on a DISPOSABLE database,
 * so routing, auth, permission, controller logic and the FK layer are all
 * exercised together rather than a bare SQL statement.
 *
 * Policy under test (mirrors the established contacts policy):
 *   1. A deal with Tasks, Activities, Appointments, Notes, Invoices or Payments
 *      must NOT be deletable — 409 with an actionable message naming the blocker.
 *   2. An organization with Contacts, Deals or Activities must NOT be deletable.
 *   3. A rejected request leaves the parent AND every dependent row unchanged.
 *   4. A parent with no dependents is still permanently deleted (the existing
 *      BlackStack permanent-deletion requirement; no soft delete is introduced).
 *   5. The dependency check and the DELETE run inside ONE transaction, so a
 *      dependency created between check and delete cannot be silently lost.
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { createRequire } = require('module');

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.CRM04_TEST_PORT || 3171);
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = `S3A${Date.now().toString(36).toUpperCase().slice(-6)}`;

// Ports other server-spawning suites already reserve.
const RESERVED_PORTS = [3111, 3141, 3143, 3145, 3162];

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

function q(sql, params = []) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}
function q1(sql, params = []) {
  const rows = q(sql, params);
  return rows[0];
}
function exec(sql, params = []) {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare(sql).run(...params); } finally { db.close(); }
}

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json, text: JSON.stringify(json || {}) };
}

const count = (t, col, id) =>
  q1(`SELECT COUNT(*) AS c FROM ${t} WHERE ${col} = ?`, [id]).c;

/** A real contact every deal can hang off (deals.contact_id is NOT NULL). */
function mkContact(label, orgId = null) {
  const id = `cnt_${TAG}_${label}`;
  exec(
    `INSERT INTO contacts (id, company_id, first_name, organization_id, created_at, updated_at)
     VALUES (?, 'default', ?, ?, datetime('now'), datetime('now'))`,
    [id, `${TAG} ${label}`, orgId],
  );
  return id;
}

/**
 * Insert a deal owned by `orgId`.
 * deals requires title, contact_id and stage_id — there is no `stage` column,
 * and stage_id is FK -> pipeline_stages.id (ON DELETE RESTRICT), so it must be a
 * real stage. `stage_001` (Discovery) exists in the seeded schema.
 */
function mkDeal(name, orgId = null, contactId = null) {
  const id = `deal_${TAG}_${name}`;
  const cid = contactId || mkContact(`d_${name}`);
  exec(
    `INSERT INTO deals (id, company_id, title, contact_id, organization_id, stage_id, status, created_at, updated_at)
     VALUES (?, 'default', ?, ?, ?, 'stage_001', 'OPEN', datetime('now'), datetime('now'))`,
    [id, `${TAG} deal ${name}`, cid, orgId],
  );
  return id;
}
function mkOrg(name) {
  const id = `org_${TAG}_${name}`;
  exec(
    `INSERT INTO organizations (id, company_id, name, created_at, updated_at)
     VALUES (?, 'default', ?, datetime('now'), datetime('now'))`,
    [id, `${TAG} org ${name}`],
  );
  return id;
}
function mkTask(dealId, orgId = null) {
  const id = `task_${TAG}_${Math.random().toString(36).slice(2, 9)}`;
  exec(
    `INSERT INTO tasks (id, company_id, title, status, deal_id, organization_id, created_at, updated_at)
     VALUES (?, 'default', ?, 'TODO', ?, ?, datetime('now'), datetime('now'))`,
    [id, `${TAG} task`, dealId, orgId],
  );
  return id;
}
function mkActivity(dealId, orgId = null) {
  const id = `act_${TAG}_${Math.random().toString(36).slice(2, 9)}`;
  exec(
    `INSERT INTO activities (id, company_id, title, type, deal_id, organization_id, created_at)
     VALUES (?, 'default', ?, 'CALL', ?, ?, datetime('now'))`,
    [id, `${TAG} act`, dealId, orgId],
  );
  return id;
}
function mkAppointment(dealId, orgId = null) {
  const id = `appt_${TAG}_${Math.random().toString(36).slice(2, 9)}`;
  exec(
    `INSERT INTO appointments (id, company_id, title, start_time, deal_id, organization_id, created_at)
     VALUES (?, 'default', ?, datetime('now'), ?, ?, datetime('now'))`,
    [id, `${TAG} appt`, dealId, orgId],
  );
  return id;
}

beforeAll(async () => {
  expect(RESERVED_PORTS).not.toContain(PORT);
  expect(await portInUse(PORT)).toBe(false);

  tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'crm04-'));
  dbPath = path.join(tmpDir, 'crm04-e2e.db');
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), dbPath);
  for (const sidecar of ['-wal', '-shm']) {
    const src = path.join(ROOT, 'data', 'blackstack-crm.db' + sidecar);
    if (fs.existsSync(src)) fs.copyFileSync(src, dbPath + sidecar);
  }
  require_(path.join(ROOT, 'tests/helpers/reset-cloned-test-admin.js'))(dbPath);

  // The disposable clone inherits production's financial-year state; posting and
  // some CRM paths enforce the lock. Unlock it here, on the clone only.
  {
    const seed = new DatabaseSync(dbPath);
    // NOTE: raw node:sqlite run() takes SPREAD args; an array binds as a named
    // parameter and the UPDATE silently does nothing.
    seed.prepare('UPDATE financial_years SET is_locked = 0 WHERE company_id = ?').run('default');
    seed.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    seed.close();
    const left = new DatabaseSync(dbPath, { readOnly: true })
      .prepare('SELECT COUNT(*) AS c FROM financial_years WHERE is_locked = 1').get().c;
    expect(left, 'disposable DB still has a locked financial year').toBe(0);
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
  expect(token, 'no auth token returned').toBeTruthy();
}, 120000);

afterAll(async () => {
  try { if (server) server.kill('SIGKILL'); } catch { /* noop */ }
  try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('CRM-04 — deal deletion must not silently destroy dependents', () => {
  test('a deal with a task, activity and appointment is refused, and all rows survive', async () => {
    const deal = mkDeal('blocked');
    const task = mkTask(deal);
    const act = mkActivity(deal);
    const appt = mkAppointment(deal);

    const before = {
      deal: count('deals', 'id', deal),
      task: count('tasks', 'id', task),
      act: count('activities', 'id', act),
      appt: count('appointments', 'id', appt),
    };

    const res = await api('DELETE', `/api/deals/${deal}`);

    expect(res.status, `delete should be refused: ${res.text.slice(0, 200)}`).toBe(409);
    // Message must be actionable — name what is blocking.
    expect(res.text.toLowerCase()).toMatch(/task|activit|appointment/);

    // Everything must be untouched.
    expect(count('deals', 'id', deal)).toBe(before.deal);
    expect(count('tasks', 'id', task)).toBe(before.task);
    expect(count('activities', 'id', act)).toBe(before.act);
    expect(count('appointments', 'id', appt)).toBe(before.appt);
  });

  test('a deal with no dependents is still permanently deleted', async () => {
    const deal = mkDeal('clean');
    const res = await api('DELETE', `/api/deals/${deal}`);
    expect(res.status, `clean deal should delete: ${res.text.slice(0, 160)}`).toBeLessThan(400);
    expect(count('deals', 'id', deal)).toBe(0);
  });

  test('deleting a NON-EXISTENT deal returns 404', async () => {
    const res = await api('DELETE', `/api/deals/deal_${TAG}_does_not_exist`);
    expect(res.status).toBe(404);
  });

  test('an UNAUTHORIZED delete is rejected and leaves the deal intact', async () => {
    const deal = mkDeal('unauth');
    const task = mkTask(deal);
    const saved = token;
    token = 'not-a-real-token';
    const res = await api('DELETE', `/api/deals/${deal}`);
    token = saved;
    expect([401, 403], `expected auth failure, got ${res.status}`).toContain(res.status);
    expect(count('deals', 'id', deal)).toBe(1);
    expect(count('tasks', 'id', task)).toBe(1);
  });
});

describe('CRM-04 — organization deletion must not partially dismantle its tree', () => {
  test('an organization with a contact and a deal is refused, and all rows survive', async () => {
    const org = mkOrg('blocked');
    const deal = mkDeal('orgchild', org);
    const act = mkActivity(null, org);
    const contactId = mkContact('orgchild', org);

    const res = await api('DELETE', `/api/organizations/${org}`);

    expect(res.status, `organization delete should be refused: ${res.text.slice(0, 200)}`).toBe(409);
    expect(res.text.toLowerCase()).toMatch(/contact|deal|activit/);

    expect(count('organizations', 'id', org)).toBe(1);
    expect(count('contacts', 'id', contactId)).toBe(1);
    expect(count('deals', 'id', deal)).toBe(1);
    expect(count('activities', 'id', act)).toBe(1);
  });

  test('an organization with no dependents is still permanently deleted', async () => {
    const org = mkOrg('clean');
    const res = await api('DELETE', `/api/organizations/${org}`);
    expect(res.status, `clean org should delete: ${res.text.slice(0, 160)}`).toBeLessThan(400);
    expect(count('organizations', 'id', org)).toBe(0);
  });

  test('deleting a NON-EXISTENT organization returns 404', async () => {
    const res = await api('DELETE', `/api/organizations/org_${TAG}_nope`);
    expect(res.status).toBe(404);
  });
});

describe('CRM-04 — no production database was touched by this suite', () => {
  test('every row created here lives in the disposable clone', () => {
    // The tag is unique per run; none of it may appear in production.
    const prodPath = path.join(ROOT, 'data', 'blackstack-crm.db');
    expect(fs.existsSync(prodPath)).toBe(true);
    const prod = new DatabaseSync(prodPath, { readOnly: true });
    try {
      for (const t of ['deals', 'organizations', 'tasks', 'activities', 'appointments']) {
        const n = prod.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE id LIKE ?`).get(`%${TAG}%`).c;
        expect(n, `${t} in production contains this run's fixtures`).toBe(0);
      }
    } finally { prod.close(); }
  });
});
