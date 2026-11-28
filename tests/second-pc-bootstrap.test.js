/**
 * SECOND-PC MOTHER COMPANY LOGIN — bootstrap + end-to-end auth regression.
 *
 * Reproduces the Second-PC failure (empty local SQLite, no Supabase
 * profiles/agency_administrators tenant mapping) WITHOUT any network and
 * WITHOUT touching production data:
 *
 *   1. An EMPTY database is initialized by the REAL migration runner.
 *   2. The Mother Company mirror row is created (exactly one) by the login-time
 *      cloud sync self-heal AND by the idempotent bootstrap primitive.
 *   3. Re-running the bootstrap / re-login never duplicates the row.
 *   4. A Supabase-verified credential authenticates (valid) and is rejected
 *      (invalid) — Supabase remains the SOLE credential authority.
 *   5. The authenticated user gets the correct ADMIN / platform hierarchy.
 *   6. /auth/profile (getProfile) succeeds after login.
 *   7. A non-Mother-Company (Laptop-style) user login is unaffected.
 *
 * NO NETWORK: the Supabase client module is replaced with a stub BEFORE the
 * services under test are required (they require config/supabase lazily), so
 * _verifyAgainstSupabase() resolves the stub. All DB work runs against a
 * DISPOSABLE database created by createDisposableDb — production is never
 * touched.
 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const { createDisposableDb } = require('../scripts/assert-disposable-db');
// Empty (schema-less) disposable file: proves a fresh Second-PC DB initializes.
createDisposableDb({ suite: 'second-pc-bootstrap.test.js', copy: false });

// ── Supabase stub (installed before the services are required) ───────────────
const CLOUD_UID = '21e8db5d-ba09-4a63-a108-56199a51ba69'; // verified Laptop UUID
const NORMAL_UID = '99999999-aaaa-bbbb-cccc-dddddddddddd';
const VALID_PW = 'correct-password';

function makeEmptyQuery() {
  const q = {
    select() { return q; },
    eq() { return q; },
    limit() { return Promise.resolve({ data: [], error: null }); },
  };
  return q;
}

const stubAuth = {
  async signInWithPassword({ email, password }) {
    if (password !== VALID_PW) {
      return { data: null, error: { message: 'Invalid login credentials' } };
    }
    const uid = String(email).trim().toLowerCase() === 'admin@blackstack.local' ? CLOUD_UID : NORMAL_UID;
    return { data: { user: { id: uid, email }, session: { access_token: 'stub-access-token' } }, error: null };
  },
  setSession() { return { data: { session: null }, error: null }; },
  async signOut() { return { error: null }; },
};
const stubClient = { auth: stubAuth, from() { return makeEmptyQuery(); } };

const Module = require('node:module');
const supabaseConfigPath = require.resolve(path.join(ROOT, 'server/config/supabase.js'));
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request.endsWith('config/supabase') || request === supabaseConfigPath) {
    return {
      isConfigured: () => true,
      getSupabaseClient: () => stubClient,
      getSupabaseUrl: () => 'https://stub.supabase.co',
      getAnonKey: () => 'stub-anon-key',
      getServiceRoleKey: () => null,
      getProjectRef: () => null,
      supabaseCreateClient: () => stubClient,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { migrate } = require(path.join(ROOT, 'server/database/migrate'));
const { ensureMotherCompanyAdmin, MOTHER_COMPANY } = require(path.join(ROOT, 'server/database/motherCompanyBootstrap'));
const { AuthService } = require(path.join(ROOT, 'server/services/auth.service'));
const { syncUserCompanyFromCloud } = require(path.join(ROOT, 'server/services/cloudToLocalSync.service'));
const { getConn } = require(path.join(ROOT, 'server/utils/db'));

let db;

beforeAll(async () => {
  // 1. Empty Second-PC database initializes correctly via the real migrations.
  const handle = await migrate();
  if (handle && typeof handle.close === 'function') handle.close();
  db = getConn();
});

function adminRows() {
  return db.all(
    `SELECT id, company_id, username, email, role, status, supabase_user_id, password_hash
       FROM users
      WHERE id = 'admin' OR lower(email) = lower('admin@blackstack.local')
         OR lower(username) = lower('admin') OR supabase_user_id = ?`,
    [CLOUD_UID],
  );
}

describe('Second-PC Mother Company bootstrap + login', () => {
  test('1. empty database initializes with the full schema (users table present)', () => {
    const row = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='users'");
    expect(row).toBeTruthy();
    const count = db.get('SELECT COUNT(*) AS n FROM users');
    expect(Number(count.n)).toBe(0); // genuinely empty before any login/bootstrap
  });

  test('2. login-time cloud sync self-heals exactly one Mother Company mirror row (Second-PC scenario)', async () => {
    const res = await syncUserCompanyFromCloud(db, {
      email: 'admin@blackstack.local',
      supabaseUserId: CLOUD_UID,
      accessToken: 'stub-access-token',
    }, { info() {}, warn() {}, log() {} });

    expect(res.synced).toBe(true);
    expect(res.companyId).toBe('default');

    const rows = adminRows();
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.id).toBe('admin');
    expect(r.company_id).toBe('default');
    expect(r.username).toBe('admin');
    expect(String(r.email).toLowerCase()).toBe('admin@blackstack.local');
    expect(r.role).toBe('ADMIN');
    expect(r.status).toBe('ACTIVE');
    expect(r.supabase_user_id).toBe(CLOUD_UID);
    // Credential-free: the local hash is a non-verifiable sentinel, never bcrypt.
    expect(String(r.password_hash).startsWith('CLOUD-AUTH-ONLY')).toBe(true);
    expect(String(r.password_hash)).not.toMatch(/^\$2[aby]\$/);
  });

  test('3. re-running bootstrap and re-login never duplicates the row', async () => {
    // Direct bootstrap primitive (startup path) — idempotent.
    const a = ensureMotherCompanyAdmin(db, { supabaseUserId: CLOUD_UID, log: { info() {} } });
    const b = ensureMotherCompanyAdmin(db, { supabaseUserId: CLOUD_UID, log: { info() {} } });
    expect(a.created).toBe(false);
    expect(b.created).toBe(false);

    // Login path again — still one row.
    await syncUserCompanyFromCloud(db, {
      email: 'admin@blackstack.local', supabaseUserId: CLOUD_UID, accessToken: 'stub-access-token',
    }, { info() {}, warn() {}, log() {} });

    const rows = adminRows();
    expect(rows.length).toBe(1);
    expect(Number(db.get('SELECT COUNT(*) AS n FROM users').n)).toBe(1);
    // Exactly one ADMIN role link.
    const links = db.all("SELECT role_id FROM user_roles WHERE user_id = 'admin'");
    expect(links.filter((l) => l.role_id === 'role_admin').length).toBe(1);
  });

  test('4. Supabase valid credentials authenticate and receive ADMIN/platform hierarchy', async () => {
    const svc = new AuthService(db);
    const result = await svc.login('admin@blackstack.local', VALID_PW);
    expect(result.token).toBeTruthy();
    expect(result.user.id).toBe('admin');
    expect(result.user.email).toBe('admin@blackstack.local');
    expect(result.user.role).toBe('ADMIN');
    expect(result.user.hierarchyRole).toBe('platform');
    expect(result.user.companyId).toBe('default');
    expect(result.user.permissions).toContain('*');
    // A session row was persisted.
    const sessions = db.get("SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = 'admin'");
    expect(Number(sessions.n)).toBeGreaterThanOrEqual(1);
  });

  test('5. invalid credentials remain rejected (no local fallback)', async () => {
    const svc = new AuthService(db);
    await expect(svc.login('admin@blackstack.local', 'wrong-password')).rejects.toThrow('Invalid credentials.');
  });

  test('6. /auth/profile succeeds after login with the correct identity', () => {
    const svc = new AuthService(db);
    const profile = svc.getProfile({ userId: 'admin', companyId: 'default' });
    expect(profile.email).toBe('admin@blackstack.local');
    expect(profile.role).toBe('ADMIN');
    expect(profile.hierarchyRole).toBe('platform');
    expect(profile.permissions).toContain('*');
  });

  test('7. a non-Mother-Company (Laptop-style) user login is unaffected', async () => {
    // Seed a normal local mirror row bound to a DIFFERENT cloud UUID.
    db.run(
      `INSERT INTO users (id, company_id, username, email, password_hash, full_name, role, status, supabase_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      ['usr_normal', 'default', 'normal', 'normal@blackstack.local', 'CLOUD-AUTH-ONLY:test', 'Normal User', 'USER', NORMAL_UID],
    );
    const svc = new AuthService(db);
    const result = await svc.login('normal@blackstack.local', VALID_PW);
    expect(result.token).toBeTruthy();
    expect(result.user.id).toBe('usr_normal');
    expect(result.user.email).toBe('normal@blackstack.local');
    // The Mother Company row is untouched by the normal login.
    expect(adminRows().length).toBe(1);
  });

  test('8. MOTHER_COMPANY constants match the verified Laptop state', () => {
    expect(MOTHER_COMPANY.id).toBe('admin');
    expect(MOTHER_COMPANY.companyId).toBe('default');
    expect(MOTHER_COMPANY.role).toBe('ADMIN');
    expect(MOTHER_COMPANY.status).toBe('ACTIVE');
    expect(MOTHER_COMPANY.defaultSupabaseUserId).toBe(CLOUD_UID);
  });
});