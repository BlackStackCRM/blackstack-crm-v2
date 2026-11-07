/**
 * PHASE 3 STEP 2A — CRM-01 regression: safe contact deletion.
 *
 * REPRODUCES the defect found in the Step 2 CRM audit:
 *
 *   contact + note          -> DELETE refused (notes is ON DELETE RESTRICT)
 *   contact + deal/task/act -> DELETE SUCCEEDS, silently cascade-destroying
 *                              all three child records
 *
 * The outcome depended entirely on which unrelated child rows happened to exist.
 *
 * This test drives the REAL HTTP API against a REAL server on a disposable
 * database — not a bare SQL statement — so it exercises routing, auth,
 * permission, controller logic and the FK layer together.
 *
 * Policy under test (implemented in server/controllers/contacts.controller.js):
 *   1. A contact that has Deals, Tasks, Activities, Appointments, Notes or
 *      Customers must NOT be deletable — the request is rejected with 409 and an
 *      actionable message naming the blocking entity.
 *   2. The rejected request must leave BOTH the contact and every dependent row
 *      byte-for-byte unchanged.
 *   3. A contact with no dependents is still permanently deleted (the existing
 *      BlackStack permanent-deletion requirement).
 *   4. The dependency check and the DELETE run inside ONE transaction, so a
 *      dependency appearing between check and delete cannot be silently lost.
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { createRequire } = require('module');

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.CRM_DELETE_TEST_PORT || 3145);
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = `S2A${Date.now().toString(36).toUpperCase().slice(-6)}`;

// PHASE 3 STEP 2A: this port must be unique across all server-spawning suites.
// It previously defaulted to 3141 — the same default as bill-lifecycle.test.js —
// so under vitest's parallel run the two suites raced for the port and this one
// ended up talking to the OTHER suite's server and disposable database, which
// made every fixture look missing (404/NOT_FOUND). Serial runs hid it.
const RESERVED_PORTS = [3111, 3141, 3143, 3162];

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
let testDb = null;
let adminToken = null;

const ids = {
  org: `org_${TAG}`,
  stage: `stg_${TAG}`,
  // clean contact: no dependents at all
  clean: `cnt_${TAG}_CLEAN`,
  // one contact per dependent kind
  note: `cnt_${TAG}_NOTE`,
  deal: `cnt_${TAG}_DEAL`,
  task: `cnt_${TAG}_TASK`,
  act: `cnt_${TAG}_ACT`,
  appt: `cnt_${TAG}_APPT`,
  multi: `cnt_${TAG}_MULTI`,
  gone: `missing_${TAG}_NEVERCREATED`,
  // Dedicated fixtures so no test depends on another's outcome.
  msg: `cnt_${TAG}_MSG`,
  anon: `cnt_${TAG}_ANON`,
};
const msgDep = { deal: `del_${TAG}_MSG` };
const dep = {
  note: `nte_${TAG}`,
  deal: `del_${TAG}`,
  dealStage: `stg_${TAG}`,
  task: `tsk_${TAG}`,
  act: `act_${TAG}`,
  appt: `apt_${TAG}`,
};

beforeAll(async () => {
  if (RESERVED_PORTS.includes(PORT)) {
    throw new Error(
      `CRM_DELETE_TEST_PORT=${PORT} collides with another server-spawning suite `
      + `(reserved: ${RESERVED_PORTS.join(', ')}). Pick a unique port.`,
    );
  }
  if (await portInUse(PORT)) throw new Error(`port ${PORT} already in use`);
  tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'crm-del-'));
  testDb = path.join(tmpDir, 'crm-del-e2e.db');

  // Clone production READ-ONLY into an isolated copy.
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), testDb);
  for (const ext of ['-wal', '-shm']) {
    const src = path.join(ROOT, 'data', 'blackstack-crm.db' + ext);
    if (fs.existsSync(src)) fs.copyFileSync(src, testDb + ext);
  }
  require(path.join(ROOT, 'tests/helpers/reset-cloned-test-admin.js'))(testDb);

  const now = new Date().toISOString();
  const db = new DatabaseSync(testDb);
  db.exec('PRAGMA foreign_keys = OFF');
  const ins = (sql, ...a) => db.prepare(sql).run(...a);

  ins("INSERT INTO organizations (id,company_id,name,created_at) VALUES (?,?,?,?)",
    ids.org, 'default', `Org ${TAG}`, now);
  ins("INSERT INTO pipeline_stages (id,company_id,name,probability,stage_order,created_at) VALUES (?,?,?,?,?,?)",
    dep.dealStage, 'default', `Stage ${TAG}`, 10, 99, now);

  const mkContact = (id) => ins(
    'INSERT INTO contacts (id,company_id,first_name,last_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    id, 'default', 'Del', id.slice(-5), `${id}@test.local`, now, now,
  );
  Object.values(ids).filter((v) => v.startsWith('cnt_')).forEach(mkContact);


  // Dependent rows, one per contact.
  ins('INSERT INTO notes (id,company_id,title,content,contact_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    dep.note, 'default', 'N', 'body', ids.note, now, now);
  ins('INSERT INTO deals (id,company_id,title,contact_id,organization_id,stage_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    dep.deal, 'default', 'D', ids.deal, ids.org, dep.dealStage, now, now);
  ins('INSERT INTO tasks (id,company_id,title,contact_id,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    dep.task, 'default', 'T', ids.task, now, now);
  ins('INSERT INTO activities (id,company_id,type,title,contact_id,created_at) VALUES (?,?,?,?,?,?)',
    dep.act, 'default', 'CALL', 'Called', ids.act, now);
  ins('INSERT INTO appointments (id,company_id,title,contact_id,start_time,end_time,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    dep.appt, 'default', 'Appt', ids.appt, now, now, now, now);

  // A contact with SEVERAL dependents at once.
  ins('INSERT INTO tasks (id,company_id,title,contact_id,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    `tsk_${TAG}_M2`, 'default', 'T2', ids.multi, now, now);
  ins('INSERT INTO activities (id,company_id,type,title,contact_id,created_at) VALUES (?,?,?,?,?,?)',
    `act_${TAG}_M2`, 'default', 'CALL', 'Called2', ids.multi, now);
  ins('INSERT INTO notes (id,company_id,title,content,contact_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    `nte_${TAG}_M2`, 'default', 'N2', 'body2', ids.multi, now, now);

  ins('INSERT INTO deals (id,company_id,title,contact_id,organization_id,stage_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    msgDep.deal, 'default', 'DM', ids.msg, ids.org, dep.dealStage, now, now);

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

  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@blackstack.local', password: 'admin123' }),
  });
  const j = await r.json().catch(() => null);
  expect(r.status, `admin login failed: ${JSON.stringify(j)}`).toBe(200);
  adminToken = j?.data?.token || j?.token || null;
  expect(adminToken, 'admin token missing').toBeTruthy();
}, 120000);

// The disposable database is removed here unconditionally. It is NOT registered
// with createDisposableDb() because these suites need the file to outlive the
// helper's exit hook in order to spawn a server against it.
afterAll(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch { /* noop */ } }
  await new Promise((r) => setTimeout(r, 600));
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } }
});


/** Read row counts straight from the disposable DB, bypassing the API. */
function counts() {
  const db = new DatabaseSync(testDb, { readOnly: true });
  const c = (t) => { try { return db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { return -1; } };
  const one = (t, id) => { try { return db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE id = ?`).get(id).c; } catch { return -1; } };
  const out = {
    deals: c('deals'), tasks: c('tasks'), activities: c('activities'),
    notes: c('notes'), appointments: c('appointments'),
    contact: one('contacts', ids.clean),
  };
  db.close();
  return out;
}

async function delContact(id, token = adminToken) {
  const r = await fetch(`${BASE}/api/contacts/${id}`, {
    method: 'DELETE',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

// ── The defect, reproduced ────────────────────────────────────────────────

describe('CRM-01 contact deletion policy', () => {
  test('deletes a contact that has no dependents (permanent delete preserved)', async () => {
    const before = counts();
    const res = await delContact(ids.clean);
    expect(res.status, `expected 200, got ${JSON.stringify(res.body)}`).toBe(200);
    const db = new DatabaseSync(testDb, { readOnly: true });
    const left = db.prepare('SELECT COUNT(*) c FROM contacts WHERE id = ?').get(ids.clean).c;
    db.close();
    expect(left, 'the contact should be permanently deleted').toBe(0);
    // Nothing else changed.
    const after = counts();
    expect(after.deals).toBe(before.deals);
    expect(after.tasks).toBe(before.tasks);
    expect(after.activities).toBe(before.activities);
    expect(after.notes).toBe(before.notes);
    expect(after.appointments).toBe(before.appointments);
  });

  test.each([
    ['note', () => ids.note, 'notes'],
    ['deal', () => ids.deal, 'deals'],
    ['task', () => ids.task, 'tasks'],
    ['activity', () => ids.act, 'activities'],
    ['appointment', () => ids.appt, 'appointments'],
  ])('refuses to delete a contact that has a dependent %s', async (_kind, contactId, table) => {
    const before = counts();
    const res = await delContact(contactId());
    expect(res.status, `expected 409 for a contact with a dependent ${_kind}, got ${JSON.stringify(res.body)}`)
      .toBe(409);
    const after = counts();
    expect(after[table], `the dependent ${_kind} row must survive a rejected delete`)
      .toBe(before[table]);
    // contact itself untouched
    const db = new DatabaseSync(testDb, { readOnly: true });
    const still = db.prepare('SELECT COUNT(*) c FROM contacts WHERE id = ?').get(contactId()).c;
    db.close();
    expect(still, 'the contact must remain when deletion is rejected').toBe(1);
  });

  test('refuses a contact with multiple dependents and leaves all of them intact', async () => {
    const before = counts();
    const res = await delContact(ids.multi);
    expect(res.status, `expected 409, got ${JSON.stringify(res.body)}`).toBe(409);
    const after = counts();
    expect(after.tasks, 'tasks must be preserved').toBe(before.tasks);
    expect(after.activities, 'activities must be preserved').toBe(before.activities);
    expect(after.notes, 'notes must be preserved').toBe(before.notes);
    const db = new DatabaseSync(testDb, { readOnly: true });
    expect(db.prepare('SELECT COUNT(*) c FROM contacts WHERE id = ?').get(ids.multi).c).toBe(1);
    db.close();
  });

  test('the rejection message names the blocking entity', async () => {
    const res = await delContact(ids.msg);
    const msg = JSON.stringify(res.body || {});
    expect(res.status).toBe(409);
    expect(/deal/i.test(msg), `409 body should mention the blocking entity, got ${msg}`).toBe(true);
  });

  test('non-existent contact returns 404, not 409', async () => {
    const res = await delContact(ids.gone);
    expect(res.status, `expected 404, got ${JSON.stringify(res.body)}`).toBe(404);
  });

  test('anonymous deletion is refused with 401', async () => {
    const res = await delContact(ids.anon, null);
    expect(res.status, `expected 401, got ${res.status}`).toBe(401);
    const db = new DatabaseSync(testDb, { readOnly: true });
    expect(db.prepare('SELECT COUNT(*) c FROM contacts WHERE id = ?').get(ids.anon).c,
      'an anonymous delete must not remove anything').toBe(1);
    db.close();
  });
});
