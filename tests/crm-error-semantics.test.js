/**
 * PHASE 3 STEP 3C — CRM-05 regression: error semantics.
 *
 * REPRODUCES the finding recorded in the Step 2 CRM audit: RESTRICT / constraint
 * failures outside the contacts path returned a generic, and in places
 * factually WRONG, error.
 *
 * Root cause in server/app.js:
 *
 *   const FK_RE = /FOREIGN KEY constraint failed|UNIQUE constraint failed
 *               |NOT NULL constraint failed|CHECK constraint failed/i;
 *   if (FK_RE.test(err.message)) {
 *     // both branches emit the SAME message:
 *     //   'The operation was blocked because related records reference this data.'
 *   }
 *
 * The pattern matches FOUR different failures, but every one of them is reported
 * as a DEPENDENCY problem. So a duplicate-key UNIQUE violation, a CHECK-enum
 * violation and a NOT NULL violation all tell the user that "related records
 * reference this data" — which is false, and sends the user looking in entirely
 * the wrong place.
 *
 * Policy under test:
 *   1. FOREIGN KEY  -> 409 ENTITY_HAS_DEPENDENCIES  (dependency message)
 *   2. UNIQUE        -> 409 DUPLICATE_VALUE          (duplicate, NOT dependency)
 *   3. CHECK         -> 400 VALIDATION_ERROR         (bad value, NOT dependency)
 *   4. NOT NULL      -> 400 VALIDATION_ERROR         (missing required value)
 *   5. Nothing that is genuinely unexpected may be reported as a 4xx.
 *   6. A refused request must not partially mutate data.
 *
 * Real HTTP API, real server, disposable database.
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { createRequire } = require('module');

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.CRM05_TEST_PORT || 3175);
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = `S3C${Date.now().toString(36).toUpperCase().slice(-6)}`;

const RESERVED_PORTS = [3111, 3141, 3143, 3145, 3162, 3171, 3173];

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

/** A contact whose email violates the UNIQUE index (if one exists). */
function uniqueViolatingContact() {
  const idx = q1("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='contacts' AND sql LIKE '%UNIQUE%'");
  return idx ? idx.sql : null;
}

beforeAll(async () => {
  expect(RESERVED_PORTS).not.toContain(PORT);
  expect(await portInUse(PORT)).toBe(false);

  tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'crm05-'));
  dbPath = path.join(tmpDir, 'crm05-e2e.db');
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

describe('CRM-05 — a duplicate must not be reported as a dependency problem', () => {
  test('UNIQUE violation reports DUPLICATE_VALUE, not ENTITY_HAS_DEPENDENCIES', async () => {
    const idx = uniqueViolatingContact();
    // Skip gracefully if the schema has no UNIQUE index we can violate via the API.
    if (!idx) { console.log('      (no UNIQUE index on contacts; covered by the handler unit test)'); return; }

    const email = `${TAG}@example.test`;
    const first = await api('POST', '/api/contacts', { first_name: 'A', last_name: 'One', email });
    expect(first.status, `first create should succeed: ${first.text.slice(0, 160)}`).toBeLessThan(400);

    const second = await api('POST', '/api/contacts', { first_name: 'B', last_name: 'Two', email });

    expect(second.status, `duplicate should be 4xx: ${second.text.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
    expect(second.status, 'duplicate must not be a 5xx').toBeLessThan(500);
    // The defect: it was reported as a dependency problem.
    expect(second.json?.error?.code, 'must not claim a dependency').not.toBe('ENTITY_HAS_DEPENDENCIES');
    expect(second.json?.error?.code).toMatch(/DUPLICATE|CONFLICT|VALIDATION/i);
    // And the message must not blame dependents.
    expect(String(second.json?.error?.message || '')).not.toMatch(/related records reference/i);
  });
});

describe('CRM-05 — the constraint mapping (real module, not a copy)', () => {
  const { classifyError } = require_(path.join(ROOT, 'server', 'utils', 'errorMapping.js'));
  const mk = (message, code = 'ERR_SQLITE_ERROR') => Object.assign(new Error(message), { code });

  test('FOREIGN KEY -> 409 ENTITY_HAS_DEPENDENCIES', () => {
    const r = classifyError(mk('FOREIGN KEY constraint failed'));
    expect(r.status).toBe(409);
    expect(r.code).toBe('ENTITY_HAS_DEPENDENCIES');
    expect(r.message).toMatch(/related records reference/i);
  });

  test('UNIQUE -> 409 DUPLICATE_VALUE, and NOT a dependency message', () => {
    const r = classifyError(mk('UNIQUE constraint failed: accounts.company_id, accounts.code'));
    expect(r.status).toBe(409);
    // THE DEFECT: this used to be ENTITY_HAS_DEPENDENCIES with a dependency message.
    expect(r.code).toBe('DUPLICATE_VALUE');
    expect(r.message).not.toMatch(/related records reference/i);
  });

  test('CHECK -> 400 VALIDATION_ERROR, and NOT a dependency message', () => {
    const r = classifyError(mk("CHECK constraint failed: bill_type IN ('CUSTOMER','SUPPLIER')"));
    expect(r.status).toBe(400);
    expect(r.code).toBe('VALIDATION_ERROR');
    expect(r.message).not.toMatch(/related records reference/i);
  });

  test('NOT NULL -> 400 VALIDATION_ERROR', () => {
    const r = classifyError(mk('NOT NULL constraint failed: bills.due_date'));
    expect(r.status).toBe(400);
    expect(r.code).toBe('VALIDATION_ERROR');
    expect(r.message).not.toMatch(/related records reference/i);
  });

  test('an UNRECOGNISED fault stays 500 — real defects must not be disguised', () => {
    const r = classifyError(mk('no such table: nope'));
    expect(r.status, 'a genuine internal fault must not become a 4xx').toBe(500);
    const r2 = classifyError(new TypeError('x is not a function'));
    expect(r2.status).toBe(500);
  });

  test('an AppError with its own 4xx status is trusted, not re-mapped', () => {
    const { NotFoundError } = require_(path.join(ROOT, 'server', 'utils', 'errors.js'));
    const r = classifyError(new NotFoundError('Deal', 'd1'));
    expect(r.status).toBe(404);
    expect(r.code).toBe('NOT_FOUND');
  });

  test('no classification may claim a dependency unless it really is one', () => {
    for (const msg of [
      'UNIQUE constraint failed: x.y',
      "CHECK constraint failed: z IN ('A')",
      'NOT NULL constraint failed: t.c',
    ]) {
      const r = classifyError(mk(msg));
      expect(r.code, `"${msg}" must not be ENTITY_HAS_DEPENDENCIES`).not.toBe('ENTITY_HAS_DEPENDENCIES');
    }
  });

  // ---- Edge branches of classifyError (utils/errorMapping.js) ---------------

  test('an error carrying status 500 is NOT trusted as-is — it stays internal', () => {
    // Only 4xx statuses are trusted; a 500 must not be laundered through the
    // application-error branch with an arbitrary message exposed to the client.
    const err = Object.assign(new Error('server exploded'), { status: 500, code: 'CUSTOM_500' });
    const r = classifyError(err);
    expect(r.status).toBe(500);
    expect(r.classification).toBe('INTERNAL');
    expect(r.message, 'raw internal message must not leak to the client').not.toMatch(/server exploded/);
  });

  test('a status below 400 is not trusted either', () => {
    const err = Object.assign(new Error('weird'), { status: 302, code: 'REDIRECT' });
    const r = classifyError(err);
    expect(r.status).toBe(500);
    expect(r.classification).toBe('INTERNAL');
  });

  test('a ValidationError with non-string field values drops the fields map', () => {
    // Only a plain string->string map is forwarded; anything else could leak
    // internals to the client, so classifyError must omit `fields` entirely.
    const err = Object.assign(new Error('bad input'), {
      status: 400, code: 'VALIDATION_ERROR',
      fields: { name: 'required', nested: { deep: 'object' } },
    });
    const r = classifyError(err);
    expect(r.status).toBe(400);
    expect(r.fields).toBeUndefined();
  });

  test('a ValidationError with string-only field values keeps the fields map', () => {
    const err = Object.assign(new Error('bad input'), {
      status: 400, code: 'VALIDATION_ERROR',
      fields: { name: 'required', email: 'invalid format' },
    });
    const r = classifyError(err);
    expect(r.status).toBe(400);
    expect(r.fields).toEqual({ name: 'required', email: 'invalid format' });
  });

  test('an error with no status and no fields keeps its original code', () => {
    const err = Object.assign(new Error('boom'), { code: 'MY_ODD_CODE' });
    const r = classifyError(err);
    expect(r.status).toBe(500);
    expect(r.code).toBe('MY_ODD_CODE');
    expect(r.classification).toBe('INTERNAL');
  });

  test('null/undefined error input does not throw', () => {
    expect(() => classifyError(null)).not.toThrow();
    expect(() => classifyError(undefined)).not.toThrow();
    const r = classifyError(undefined);
    expect(r.status).toBe(500);
    expect(r.classification).toBe('INTERNAL');
  });

  test('SQLITE_CONSTRAINT_FOREIGNKEY code maps even when the message is opaque', () => {
    const err = Object.assign(new Error('constraint violation'), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
    const r = classifyError(err);
    expect(r.status).toBe(409);
    expect(r.code).toBe('ENTITY_HAS_DEPENDENCIES');
  });

  test('UNIQUE/CHECK/NOT NULL still classify when err.code is a non-SQLITE value', () => {
    for (const [msg, expectedCode, expectedStatus] of [
      ['UNIQUE constraint failed: t.c', 'DUPLICATE_VALUE', 409],
      ["CHECK constraint failed: t.c IN ('A')", 'VALIDATION_ERROR', 400],
      ['NOT NULL constraint failed: t.c', 'VALIDATION_ERROR', 400],
    ]) {
      const r = classifyError(mk(msg, 'SOME_DRIVER_CODE'));
      expect(r.code, msg).toBe(expectedCode);
      expect(r.status, msg).toBe(expectedStatus);
    }
  });
});

describe('CRM-05 — the handler in server/app.js delegates to that module', () => {
  test('app.js no longer contains the single-message FK_RE branch', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8');
    expect(src).toMatch(/require\(['"]\.\/utils\/errorMapping['"]\)/);
    expect(src, 'the old inline FK_RE branch must be gone').not.toMatch(/FK_RE\.test/);
  });

  test('a REAL UNIQUE violation is classified as DUPLICATE_VALUE', () => {
    // Every UNIQUE index in this schema is pre-checked by its controller, so a
    // duplicate cannot normally reach SQLite through the API. This forces the
    // genuine database error on a disposable clone and runs it through the real
    // classifyError() — proving the mapping, not a copy of it.
    const { realUniqueViolationVerdict } = require_(path.join(__dirname, 'helpers', 'crm05-unique-violation.js'));
    const out = realUniqueViolationVerdict();

    expect(out.raised, 'the second insert must violate a UNIQUE index').toBe(true);
    expect(out.rawMessage, 'the raw error must be a UNIQUE failure').toMatch(/UNIQUE/i);
    expect(out.mapped.status).toBe(409);
    expect(out.mapped.code).toBe('DUPLICATE_VALUE');
    expect(out.mapped.message, 'must not blame dependents').not.toMatch(/related records reference/i);
  });
});

describe('CRM-05 — status codes that are already correct must stay correct', () => {
  test('401 when unauthenticated', async () => {
    const saved = token;
    token = null;
    const res = await api('GET', '/api/deals');
    token = saved;
    expect(res.status).toBe(401);
  });

  test('404 for a non-existent resource', async () => {
    const res = await api('GET', `/api/deals/${TAG}_nope`);
    expect(res.status).toBe(404);
    expect(res.json?.error?.code).toBe('NOT_FOUND');
  });

  test('400 for a validation failure', async () => {
    const res = await api('POST', '/api/deals', {});
    expect(res.status).toBe(400);
    expect(res.json?.error?.code).toBe('VALIDATION_ERROR');
  });

  test('409 for a genuine dependency (contact with a deal)', async () => {
    const contactId = `cnt_${TAG}_dep`;
    exec(`INSERT INTO contacts (id, company_id, first_name, created_at, updated_at)
          VALUES (?, 'default', ?, datetime('now'), datetime('now'))`, [contactId, `${TAG} dep`]);
    exec(`INSERT INTO deals (id, company_id, title, contact_id, stage_id, status, created_at, updated_at)
          VALUES (?, 'default', ?, ?, 'stage_001', 'OPEN', datetime('now'), datetime('now'))`,
    [`deal_${TAG}_dep`, `${TAG} dep deal`, contactId]);

    const res = await api('DELETE', `/api/contacts/${contactId}`);
    expect(res.status, `real dependency should be 409: ${res.text.slice(0, 200)}`).toBe(409);
    expect(res.json?.error?.code).toBe('ENTITY_HAS_DEPENDENCIES');
    // Both rows survive.
    expect(q1('SELECT COUNT(*) AS c FROM contacts WHERE id = ?', [contactId]).c).toBe(1);
    expect(q1('SELECT COUNT(*) AS c FROM deals WHERE id = ?', [`deal_${TAG}_dep`]).c).toBe(1);
  });
});

describe('CRM-05 — deal.service.js remains unwired (recorded, not changed)', () => {
  test('the service is NOT imported by any server file', () => {
    const fsx = require_('fs');
    const pathx = require_('path');
    const offenders = [];
    const walk = (dir) => {
      for (const e of fsx.readdirSync(dir, { withFileTypes: true })) {
        const p = pathx.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!p.endsWith('.js')) continue;
        const t = fsx.readFileSync(p, 'utf8');
        if (t.includes('services/deal.service')) offenders.push(pathx.relative(ROOT, p).replace(/\\/g, '/'));
      }
    };
    walk(pathx.join(ROOT, 'server'));
    expect(offenders, `server files importing the dead service: ${offenders.join(', ')}`).toEqual([]);
  });

  test('documented: markWon/markLost target columns that do not exist', () => {
    // This test records WHY the service must not be wired up as-is.
    const cols = [];
    {
      const d = new DatabaseSync(path.join(ROOT, 'data', 'blackstack-crm.db'), { readOnly: true });
      cols.push(...d.prepare('PRAGMA table_info(deals)').all().map((c) => c.name));
      d.close();
    }
    expect(cols, 'deals.won_at does not exist, so deal.service.markWon would throw').not.toContain('won_at');
    expect(cols, 'deals.lost_at does not exist, so deal.service.markLost would throw').not.toContain('lost_at');
  });
});

describe('CRM-05 — no production database was touched', () => {
  test('no fixture row exists in production', () => {
    const prod = new DatabaseSync(path.join(ROOT, 'data', 'blackstack-crm.db'), { readOnly: true });
    try {
      for (const t of ['contacts', 'deals', 'organizations']) {
        const n = prod.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE id LIKE ?`).get(`%${TAG}%`).c;
        expect(n, `${t} in production contains this run's fixtures`).toBe(0);
      }
    } finally { prod.close(); }
  });
});
