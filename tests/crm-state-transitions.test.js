/**
 * PHASE 3 STEP 3B — CRM-03 regression: state-transition validation.
 *
 * REPRODUCES the defect recorded in the Step 2 CRM audit:
 *
 *   A deal's `stage_id` is validated for EXISTENCE only. Any stage may be moved
 *   to any other stage, in any direction, with no regard for pipeline order or
 *   terminal states. A deal can jump backwards (Closing -> Discovery), skip
 *   stages, or be reopened after being marked WON/LOST.
 *
 *   A task's `status` has no lifecycle validation at all and no domain
 *   constraint at the schema level: any string is accepted.
 *
 * Additionally uncovered while auditing this finding:
 *
 *   server/services/deal.service.js implements updateStage/markWon/markLost and
 *   looks like the intended lifecycle layer — but NO ROUTE mounts it, and
 *   markWon/markLost write to columns `won_at` / `lost_at` that DO NOT EXIST on
 *   `deals`. It is unreachable dead code that would throw if it were ever wired
 *   up. So there is no lifecycle enforcement anywhere in the request path.
 *
 * Policy under test:
 *   1. A deal's stage may move FORWARD or stay put, never backward.
 *   2. A terminal deal (status WON or LOST) may not have its stage changed.
 *   3. A task's status must be a recognised lifecycle value.
 *   4. A refused transition changes nothing.
 *   5. Legal transitions still work (forward move, terminal marking).
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
const PORT = Number(process.env.CRM03_TEST_PORT || 3173);
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = `S3B${Date.now().toString(36).toUpperCase().slice(-6)}`;

const RESERVED_PORTS = [3111, 3141, 3143, 3145, 3162, 3171];

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
function stages() {
  return q1('SELECT COUNT(*) AS c FROM pipeline_stages').c;
}

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

function mkContact(label) {
  const id = `cnt_${TAG}_${label}`;
  exec(`INSERT INTO contacts (id, company_id, first_name, created_at, updated_at)
        VALUES (?, 'default', ?, datetime('now'), datetime('now'))`, [id, `${TAG} ${label}`]);
  return id;
}
function mkDeal(label, stageId = 'stage_001', status = 'OPEN') {
  const id = `deal_${TAG}_${label}`;
  exec(`INSERT INTO deals (id, company_id, title, contact_id, stage_id, status, created_at, updated_at)
        VALUES (?, 'default', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  [id, `${TAG} deal ${label}`, mkContact(`d_${label}`), stageId, status]);
  return id;
}
function mkTask(label, status = 'TODO') {
  const id = `task_${TAG}_${label}`;
  exec(`INSERT INTO tasks (id, company_id, title, status, created_at, updated_at)
        VALUES (?, 'default', ?, ?, datetime('now'), datetime('now'))`, [id, `${TAG} task ${label}`, status]);
  return id;
}
const dealStage = (id) => q1('SELECT stage_id FROM deals WHERE id = ?', [id]).stage_id;
const dealStatus = (id) => q1('SELECT status FROM deals WHERE id = ?', [id]).status;
const taskStatus = (id) => q1('SELECT status FROM tasks WHERE id = ?', [id]).status;

beforeAll(async () => {
  expect(RESERVED_PORTS).not.toContain(PORT);
  expect(await portInUse(PORT)).toBe(false);

  tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'crm03-'));
  dbPath = path.join(tmpDir, 'crm03-e2e.db');
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), dbPath);
  for (const s of ['-wal', '-shm']) {
    const src = path.join(ROOT, 'data', 'blackstack-crm.db' + s);
    if (fs.existsSync(src)) fs.copyFileSync(src, dbPath + s);
  }
  require_(path.join(ROOT, 'tests/helpers/reset-cloned-test-admin.js'))(dbPath);
  {
    const seed = new DatabaseSync(dbPath);
    seed.prepare('UPDATE financial_years SET is_locked = 0 WHERE company_id = ?').run('default');
    seed.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    seed.close();
  }
  // The transition policy needs an ordered stage set to reason about.
  expect(stages(), 'fixture needs pipeline stages').toBeGreaterThanOrEqual(4);

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

describe('CRM-03 — deal stage transitions must be validated on their merits', () => {
  test('a BACKWARD stage move is refused and the deal is unchanged', async () => {
    // stage_004 (Closing) -> stage_001 (Discovery) is a regression in the funnel.
    const deal = mkDeal('backward', 'stage_004');
    expect(dealStage(deal)).toBe('stage_004');

    const res = await api('POST', `/api/deals/${deal}/stage`, { stage_id: 'stage_001' });

    expect(res.status, `backward move should be refused: ${res.text.slice(0, 200)}`).toBe(409);
    expect(dealStage(deal), 'stage must be unchanged').toBe('stage_004');
  });

  test('a FORWARD stage move is allowed', async () => {
    const deal = mkDeal('forward', 'stage_001');
    const res = await api('POST', `/api/deals/${deal}/stage`, { stage_id: 'stage_003' });
    expect(res.status, `forward move should succeed: ${res.text.slice(0, 200)}`).toBeLessThan(400);
    expect(dealStage(deal)).toBe('stage_003');
  });

  test('re-staging a deal to its CURRENT stage is allowed (no-op)', async () => {
    const deal = mkDeal('same', 'stage_002');
    const res = await api('POST', `/api/deals/${deal}/stage`, { stage_id: 'stage_002' });
    expect(res.status, `same-stage update should succeed: ${res.text.slice(0, 160)}`).toBeLessThan(400);
    expect(dealStage(deal)).toBe('stage_002');
  });

  test('a terminal (WON) deal cannot be moved back into the funnel', async () => {
    const deal = mkDeal('won', 'stage_004', 'WON');
    const res = await api('POST', `/api/deals/${deal}/stage`, { stage_id: 'stage_002' });
    expect(res.status, `terminal deal should refuse a stage change: ${res.text.slice(0, 200)}`).toBe(409);
    expect(dealStage(deal)).toBe('stage_004');
    expect(dealStatus(deal)).toBe('WON');
  });

  test('a terminal (LOST) deal cannot be moved back into the funnel', async () => {
    const deal = mkDeal('lost', 'stage_003', 'LOST');
    const res = await api('POST', `/api/deals/${deal}/stage`, { stage_id: 'stage_001' });
    expect(res.status, `terminal deal should refuse a stage change: ${res.text.slice(0, 200)}`).toBe(409);
    expect(dealStage(deal)).toBe('stage_003');
    expect(dealStatus(deal)).toBe('LOST');
  });

  test('an unknown stage_id is still rejected as invalid', async () => {
    const deal = mkDeal('badstage', 'stage_001');
    const res = await api('POST', `/api/deals/${deal}/stage`, { stage_id: 'stage_999' });
    // The controller raises NotFoundError for an unknown stage, so 404 is the
    // established behaviour. Assert it is refused either way, and unchanged.
    expect(res.status, `unknown stage must be refused: ${res.text.slice(0, 160)}`).toBeGreaterThanOrEqual(400);
    expect(dealStage(deal), 'stage must be unchanged').toBe('stage_001');
  });

  test('staging a NON-EXISTENT deal returns 404 and changes nothing', async () => {
    const res = await api('POST', `/api/deals/deal_${TAG}_ghost/stage`, { stage_id: 'stage_002' });
    expect(res.status).toBe(404);
  });

  test('a stage move with NO stage_id is rejected as invalid', async () => {
    const deal = mkDeal('nostagebody', 'stage_002');
    const res = await api('POST', `/api/deals/${deal}/stage`, {});
    expect(res.status, `missing stage_id must be refused: ${res.text.slice(0, 160)}`).toBeGreaterThanOrEqual(400);
    expect(dealStage(deal)).toBe('stage_002');
  });
});

describe('CRM-03 — task status must be a recognised lifecycle value', () => {
  test('a nonsense status is refused and the task is unchanged', async () => {
    const task = mkTask('bad', 'TODO');
    const res = await api('PUT', `/api/tasks/${task}`, { status: 'BANANA' });
    expect(res.status, `invalid status should be refused: ${res.text.slice(0, 200)}`).toBe(400);
    expect(taskStatus(task)).toBe('TODO');
  });

  test('a recognised status is accepted', async () => {
    const task = mkTask('good', 'TODO');
    const res = await api('PUT', `/api/tasks/${task}`, { status: 'IN_PROGRESS' });
    expect(res.status, `valid status should succeed: ${res.text.slice(0, 160)}`).toBeLessThan(400);
    expect(taskStatus(task)).toBe('IN_PROGRESS');
  });

  test('marking COMPLETED still stamps completed_at', async () => {
    const task = mkTask('done', 'TODO');
    const res = await api('PUT', `/api/tasks/${task}`, { status: 'COMPLETED' });
    expect(res.status).toBeLessThan(400);
    expect(taskStatus(task)).toBe('COMPLETED');
    const row = q1('SELECT completed_at FROM tasks WHERE id = ?', [task]);
    expect(row.completed_at, 'completed_at must be stamped').toBeTruthy();
  });

  test('re-opening a COMPLETED task clears completed_at', async () => {
    const task = mkTask('reopen', 'COMPLETED');
    const res = await api('PUT', `/api/tasks/${task}`, { status: 'TODO' });
    expect(res.status).toBeLessThan(400);
    expect(taskStatus(task)).toBe('TODO');
    const row = q1('SELECT completed_at FROM tasks WHERE id = ?', [task]);
    expect(row.completed_at, 'completed_at must be cleared').toBeFalsy();
  });
});

describe('CRM-03 — no production database was touched', () => {
  test('no fixture row exists in production', () => {
    const prod = new DatabaseSync(path.join(ROOT, 'data', 'blackstack-crm.db'), { readOnly: true });
    try {
      for (const t of ['deals', 'tasks', 'contacts']) {
        const n = prod.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE id LIKE ?`).get(`%${TAG}%`).c;
        expect(n, `${t} in production contains this run's fixtures`).toBe(0);
      }
    } finally { prod.close(); }
  });
});
