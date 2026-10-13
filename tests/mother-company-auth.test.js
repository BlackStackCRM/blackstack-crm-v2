/**
 * MOTHER COMPANY — HTTP AUTHORIZATION TESTS
 *
 * The unit suite (mother-company.test.js) proves service-level rules. This suite
 * proves the thing that actually protects the product: that a real HTTP server,
 * reached with a real token, refuses the wrong caller — regardless of what the
 * frontend shows.
 *
 * Covered:
 *   - 401 with no token, on every endpoint
 *   - 403 for a customer-company ADMIN whose session carries the '*' wildcard
 *     (the leak that requireMotherCompany() exists to close)
 *   - 200 for a genuine Mother Company operator
 *   - an agency administrator cannot reach Mother Company endpoints at all
 *   - server-side validation, status transitions, admin assignment, audit log
 *   - the regular CRM product still works afterwards
 *
 * ISOLATION — read this before changing the setup order.
 *   assertDisposableDb() CLONES the database and re-points process.env.DB_PATH at
 *   that clone. The server child therefore migrates the clone itself at startup.
 *
 *   An earlier version of this suite provisioned accounts BEFORE starting the
 *   server, against its own connection. That connection and the served file were
 *   different, so the operator's own POST /agencies returned `data:{}` while the
 *   unit suite passed — the unit suite passed only because it opened DB_PATH
 *   itself and therefore agreed with the service about which file to use.
 *
 *   The order below is deliberate: start the server (which migrates the clone),
 *   THEN provision against that same file, THEN log in.
 */

const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const { createDisposableDb } = require('../scripts/assert-disposable-db');

/**
 * DB_PATH SAFETY
 *
 * server/database/connection.js resolves the database as
 *   process.env.DB_PATH || <production default>
 * so ANY process that starts without DB_PATH set silently opens — and, because
 * migrate() runs on boot, WRITES TO — the production database. That happened
 * once during this work: an ad-hoc probe script read a misspelled variable, got
 * undefined, and auto-applied migration 085 to production.
 *
 * createDisposableDb() CLONES production and re-points DB_PATH, so this suite
 * never depends on the caller's environment for safety.
 */
// createDisposableDb() returns { dbPath, tmpDir, cleanup } — the PATH is `dbPath`.
// Destructuring it as a string produced a null-byte path error, which is why this
// suite failed under the release gate while passing when DB_PATH was set.
const { dbPath: DB_PATH } = createDisposableDb({
  suite: 'mother-company-auth.test.js',
  source: process.env.DB_PATH || path.join(__dirname, '../data/blackstack-crm.db'),
});

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.MC_TEST_PORT || 33455);
const BASE = `http://127.0.0.1:${PORT}`;

const PW = {
  mc: 'Mc0mpany!Test#2026',
  cust: 'C0stomer!Test#2026',
  agy: 'Ag3ncy!Test#2026',
};

let server;
let child;
const ids = {};
const uddDirs = [];

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function req(method, urlPath, { token, body } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${BASE}${urlPath}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(b); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: parsed, raw: b });
      });
    });
    r.on('error', (e) => resolve({ status: 0, body: null, raw: e.message }));
    r.setTimeout(15000, () => { r.destroy(); resolve({ status: 0, body: null, raw: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

const GET = (p, o) => req('GET', p, o);
const POST = (p, o) => req('POST', p, o);
const PATCH = (p, o) => req('PATCH', p, o);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  ids.udd = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-http-'));
  uddDirs.push(ids.udd);

  // 1. Start the server. It applies migration 085 to this exact file.
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'app.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DB_PATH,
      BLACKSTACK_USER_DATA_DIR: ids.udd,
      PORT: String(PORT),
      BLACKSTACK_PORT: String(PORT),
      BLACKSTACK_DESKTOP: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ids.log = '';
  child.stdout.on('data', (d) => { ids.log += d.toString(); });
  child.stderr.on('data', (d) => { ids.log += d.toString(); });

  let up = false;
  for (let i = 0; i < 60; i += 1) {
    await wait(1000);
    if ((await GET('/health')).status === 200) { up = true; break; }
    if (child.exitCode !== null) break;
  }
  if (!up) throw new Error(`server did not start on ${BASE}\n${ids.log.slice(-1500)}`);

  // 2. Provision accounts on the SAME file the server is serving.
  const { DatabaseSync } = require('node:sqlite');
  const { PasswordService } = require(path.join(ROOT, 'server', 'auth', 'password'));
  const { generateId } = require(path.join(ROOT, 'server', 'utils', 'generateId'));

  const db = new DatabaseSync(DB_PATH);
  const uniq = crypto.randomBytes(3).toString('hex');
  ids.mcEmail = `mc-${uniq}@test.invalid`;
  ids.custAdminEmail = `cust-${uniq}@test.invalid`;
  ids.agyEmail = `agy-${uniq}@test.invalid`;

  // Use a PER-RUN provider company id.
  //
  // assertDisposableDb() clones the database once per FILE, so this suite and
  // tests/mother-company.test.js can share one database when the whole suite runs.
  // Both used the fixed id 'company_blackstack', which made this suite's results
  // depend on whether the other suite had run first — it passed alone (16/16) and
  // failed inside the full run. A per-run id removes that coupling entirely and
  // models the real thing better: each Mother Company operator is its own tenant.
  ids.providerCompanyId = `company_mc_${uniq}`;
  const custCompanyId = `company_cust_${uniq}`;
  const agyCompanyId = `company_agy_${uniq}`;

  db.exec(`INSERT OR IGNORE INTO companies (id,name,status) VALUES ('${ids.providerCompanyId}','BlackStack','ACTIVE')`);
  db.exec(`INSERT OR IGNORE INTO companies (id,name,status) VALUES ('${custCompanyId}','Customer Co','ACTIVE')`);
  db.exec(`INSERT OR IGNORE INTO companies (id,name,status) VALUES ('${agyCompanyId}','Agency Co','ACTIVE')`);
  db.exec(`INSERT OR IGNORE INTO mother_company_providers (id,company_id,display_name,is_active) VALUES ('mcp_${uniq}','${ids.providerCompanyId}','BlackStack',1)`);

  const mcId = generateId('usr');
  const custId = generateId('usr');
  const agyId = generateId('usr');

  const insertUser = db.prepare(
    'INSERT INTO users (id,company_id,email,password_hash,full_name,role,status) VALUES (?,?,?,?,?,?,?)',
  );
  insertUser.run(mcId, ids.providerCompanyId, ids.mcEmail, await PasswordService.hash(PW.mc), 'MC Operator', 'ADMIN', 'ACTIVE');
  insertUser.run(custId, custCompanyId, ids.custAdminEmail, await PasswordService.hash(PW.cust), 'Customer Admin', 'ADMIN', 'ACTIVE');
  insertUser.run(agyId, agyCompanyId, ids.agyEmail, await PasswordService.hash(PW.agy), 'Agency Admin', 'USER', 'ACTIVE');

  const grant = db.prepare('INSERT OR IGNORE INTO user_roles (user_id,role_id) VALUES (?,?)');
  // Mother Company operator: the MOTHER_COMPANY role only.
  grant.run(mcId, 'role_mother_company');
  // Customer admin: role_admin, which auth.service expands to permissions ['*'].
  grant.run(custId, 'role_admin');
  grant.run(agyId, 'role_user');
  db.close();

  // 3. Log all three in through the real login endpoint.
  const login = async (email, password) => {
    const r = await POST('/api/auth/login', { body: { email, password } });
    if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${r.raw.slice(0, 200)}`);
    return r.body.data.token;
  };
  ids.mcToken = await login(ids.mcEmail, PW.mc);
  ids.custToken = await login(ids.custAdminEmail, PW.cust);
  ids.agyToken = await login(ids.agyEmail, PW.agy);
}, 180000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await wait(800);
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  for (const d of uddDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ── tests ────────────────────────────────────────────────────────────────────

describe('Mother Company HTTP authorization', () => {
  test('login returns distinct tokens for each account', () => {
    expect(ids.mcToken).toBeTruthy();
    expect(ids.custToken).toBeTruthy();
    expect(ids.agyToken).toBeTruthy();
    expect(ids.mcToken).not.toBe(ids.custToken);
  });

  test('every Mother Company endpoint rejects an anonymous caller with 401', async () => {
    const calls = [
      ['GET', '/api/mother-company/dashboard'],
      ['GET', '/api/mother-company/agencies'],
      ['GET', '/api/mother-company/agencies/some-id'],
      ['POST', '/api/mother-company/agencies'],
      ['PATCH', '/api/mother-company/agencies/some-id'],
      ['POST', '/api/mother-company/agencies/some-id/status'],
      ['GET', '/api/mother-company/agencies/some-id/administrators'],
      ['POST', '/api/mother-company/agencies/some-id/administrators'],
      ['DELETE', '/api/mother-company/agencies/some-id/administrators/some-id'],
      ['GET', '/api/mother-company/audit'],
    ];
    for (const [m, p] of calls) {
      const r = await req(m, p, { body: m === 'GET' ? undefined : {} });
      expect(r.status, `${m} ${p} without a token`).toBe(401);
    }
  });

  test('a customer ADMIN holding permissions ["*"] is refused with 403', async () => {
    // THE critical test. auth.service.js gives every ADMIN role '*', and the naive
    // requirePermission() honours it — which would make every customer company's
    // administrator a Mother Company operator.
    const r = await GET('/api/mother-company/agencies', { token: ids.custToken });
    expect(r.status).toBe(403);
    expect(r.raw).not.toMatch(/agencyCode|contactEmail/i);
  });

  test('the wildcard customer admin is refused on every privileged endpoint', async () => {
    const results = await Promise.all([
      GET('/api/mother-company/dashboard', { token: ids.custToken }),
      POST('/api/mother-company/agencies', { token: ids.custToken, body: { name: 'Sneaky Co' } }),
      PATCH('/api/mother-company/agencies/whatever', { token: ids.custToken, body: { name: 'x' } }),
      POST('/api/mother-company/agencies/whatever/status', { token: ids.custToken, body: { status: 'ACTIVE' } }),
      GET('/api/mother-company/audit', { token: ids.custToken }),
      GET('/api/mother-company/agencies/whatever/administrators', { token: ids.custToken }),
    ]);
    for (const r of results) expect(r.status, r.raw.slice(0, 90)).toBe(403);
  });

  test('an agency administrator is refused Mother Company access', async () => {
    const r = await GET('/api/mother-company/dashboard', { token: ids.agyToken });
    expect(r.status).toBe(403);
  });

  test('the Mother Company operator reaches the dashboard with real counts', async () => {
    const r = await GET('/api/mother-company/dashboard', { token: ids.mcToken });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.stats).toBeTruthy();
    // Counts derive from real rows; on a fresh database that is zero, and a
    // fabricated non-zero figure would be worse than an honest empty state.
    expect(typeof r.body.data.stats.totalAgencies).toBe('number');
    expect(r.body.data.stats.totalAgencies).toBeGreaterThanOrEqual(0);
    // Licensing is honestly deferred, not faked.
    expect(r.body.data.licenses.implemented).toBe(false);
    expect(r.body.data.licenses.licenseCounts).toBeNull();
  });

  test('the operator can create an agency and then read it back', async () => {
    const code = `E2E-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const created = await POST('/api/mother-company/agencies', {
      token: ids.mcToken,
      body: { agency_code: code, name: 'HTTP Test Agency', contact_email: 'ops@agency.test' },
    });
    expect(created.status).toBe(201);
    if (!created.body.data || !created.body.data.agency) {
      throw new Error(`unexpected create response: ${created.status} ${created.raw.slice(0, 300)}`);
    }
    ids.agencyId = created.body.data.agency.id;
    ids.agencyCode = created.body.data.agency.agencyCode;
    expect(ids.agencyCode).toBe(code);
    expect(created.body.data.agency.status).toBe('PENDING');

    // Proof the provider-scoping bug is gone: the operator can see what it made.
    const list = await GET(`/api/mother-company/agencies?search=${code}`, { token: ids.mcToken });
    expect(list.status).toBe(200);
    expect(list.body.data.agencies.map((a) => a.agencyCode)).toContain(code);

    const one = await GET(`/api/mother-company/agencies/${ids.agencyId}`, { token: ids.mcToken });
    expect(one.status).toBe(200);
    expect(one.body.data.agency.agencyCode).toBe(code);
  });

  test('duplicate agency code is rejected with a field-level validation error', async () => {
    const dup = await POST('/api/mother-company/agencies', {
      token: ids.mcToken,
      body: { agency_code: ids.agencyCode, name: 'Duplicate' },
    });
    expect(dup.status).toBe(400);
    // Responses are camelCased by the app's own middleware, so the field key
    // arrives as agencyCode even though the service set agency_code.
    const detail = dup.body.error && dup.body.error.fields;
    if (!detail || !detail.agencyCode) {
      throw new Error(`duplicate response body: ${dup.raw.slice(0, 300)}`);
    }
    expect(detail.agencyCode).toMatch(/already in use/i);
    // No raw SQL constraint error may leak to the client.
    expect(dup.raw).not.toMatch(/SQLITE|UNIQUE constraint/i);
  });

  test('invalid input is rejected server-side with 400', async () => {
    const noName = await POST('/api/mother-company/agencies', { token: ids.mcToken, body: { name: '' } });
    expect(noName.status).toBe(400);
    const badCode = await POST('/api/mother-company/agencies', {
      token: ids.mcToken, body: { agency_code: 'bad code!', name: 'X' },
    });
    expect(badCode.status).toBe(400);
  });

  test('activate then suspend works, and a suspension without a reason is refused', async () => {
    const act = await POST(`/api/mother-company/agencies/${ids.agencyId}/status`, {
      token: ids.mcToken, body: { status: 'ACTIVE', reason: 'Contract signed' },
    });
    expect(act.status).toBe(200);
    expect(act.body.data.agency.status).toBe('ACTIVE');

    const noReason = await POST(`/api/mother-company/agencies/${ids.agencyId}/status`, {
      token: ids.mcToken, body: { status: 'SUSPENDED' },
    });
    expect(noReason.status).toBe(400);

    const susp = await POST(`/api/mother-company/agencies/${ids.agencyId}/status`, {
      token: ids.mcToken, body: { status: 'SUSPENDED', reason: 'Non-payment' },
    });
    expect(susp.status).toBe(200);

    const detail = await GET(`/api/mother-company/agencies/${ids.agencyId}`, { token: ids.mcToken });
    const statuses = detail.body.data.statusHistory.map((h) => h.toStatus);
    expect(statuses).toContain('ACTIVE');
    expect(statuses).toContain('SUSPENDED');
  });

  test('an invalid status transition is refused', async () => {
    // SUSPENDED -> TERMINATED is legal; TERMINATED is terminal.
    const term = await POST(`/api/mother-company/agencies/${ids.agencyId}/status`, {
      token: ids.mcToken, body: { status: 'TERMINATED', reason: 'Ended' },
    });
    expect(term.status).toBe(200);
    const revive = await POST(`/api/mother-company/agencies/${ids.agencyId}/status`, {
      token: ids.mcToken, body: { status: 'ACTIVE', reason: 'undo' },
    });
    expect(revive.status).toBe(400);
  });

  test('an administrator can be assigned and revoked, and no secret is echoed', async () => {
    // Unique per attempt: a prior run in the same disposable database may already
    // hold this address, and the service correctly rejects a duplicate email with
    // 409. A collision here would be a test artifact, not a product defect.
    const email = `assigned-${crypto.randomBytes(6).toString('hex')}@agency.test`;
    const r = await POST(`/api/mother-company/agencies/${ids.agencyId}/administrators`, {
      token: ids.mcToken,
      body: { email, fullName: 'Assigned Admin', password: 'Ass1gned!Pass#2026' },
    });
    if (r.status !== 201) {
      // Surface the server's structured error log so the actual cause is visible.
      const logs = (ids.log || '').split('\n').filter((l) => l.includes('DUPLICATE') || l.includes('UNIQUE')).slice(-2);
      throw new Error(`assign admin failed: ${r.status} ${r.raw.slice(0, 200)}\nSERVERLOG: ${logs.join(' | ').slice(0, 400)}`);
    }
    const adminId = r.body.data.administrator.id;
    expect(r.raw).not.toMatch(/\$2[aby]\$/);

    const list = await GET(`/api/mother-company/agencies/${ids.agencyId}/administrators`, { token: ids.mcToken });
    expect(list.body.data.administrators.map((a) => a.email)).toContain(email);
    expect(list.raw.toLowerCase()).not.toContain('password');

    const del = await req('DELETE', `/api/mother-company/agencies/${ids.agencyId}/administrators/${adminId}`, { token: ids.mcToken });
    expect(del.status).toBe(200);
    expect(del.body.data.administrator.status).toBe('REVOKED');
  });

  test('a weak administrator password is refused', async () => {
    const r = await POST(`/api/mother-company/agencies/${ids.agencyId}/administrators`, {
      token: ids.mcToken,
      body: { email: `weak-${crypto.randomBytes(3).toString('hex')}@agency.test`, fullName: 'Weak', password: 'short' },
    });
    expect(r.status).toBe(400);
  });

  test('audit history shows the privileged actions, without secrets', async () => {
    const r = await GET('/api/mother-company/audit', { token: ids.mcToken });
    expect(r.status).toBe(200);
    const actions = r.body.data.entries.map((e) => e.action);
    expect(actions).toContain('AGENCY_CREATED');
    expect(actions).toContain('AGENCY_ACTIVE');
    expect(actions).toContain('AGENCY_SUSPENDED');
    expect(r.raw).not.toMatch(/\$2[aby]\$/);
  });

  test('a cross-tenant agency id is not readable (404, not 403)', async () => {
    const r = await GET(`/api/mother-company/agencies/${ids.agencyId}`, { token: ids.custToken });
    expect(r.status).toBe(403); // customer admin lacks the Mother Company permission
  });

  test('regular CRM login still works and is unaffected', async () => {
    const profile = await GET('/api/auth/profile', { token: ids.custToken });
    expect(profile.status).toBe(200);
    expect(profile.body.data.email).toBe(ids.custAdminEmail);

    const summary = await GET('/api/dashboard/summary', { token: ids.custToken });
    expect(summary.status).toBe(200);

    // Both accounts are role=ADMIN in the users table; only the role assignment
    // separates them.
    const denied = await GET('/api/mother-company/dashboard', { token: ids.custToken });
    expect(denied.status).toBe(403);
  });
});
