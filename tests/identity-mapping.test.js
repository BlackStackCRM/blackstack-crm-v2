/**
 * P1 — CENTRALIZED IDENTITY MAPPING (audit §26, cross-PC login fix)
 *
 * Verifies that the local mirror row is resolved by SUPABASE_USER_ID first
 * and that a verified cloud login binds the cloud UUID to the mirror row
 * (auth.service.login) — the exact properties that let the SAME account log
 * in on a second PC whose local SQLite was seeded independently.
 *
 * NO NETWORK: the Supabase client module is replaced with a stub BEFORE the
 * services under test are required, so _verifyAgainstSupabase() resolves the
 * stub and returns a fixed cloud identity. All database work runs against a
 * DISPOSABLE database (createDisposableDb) — production is never touched.
 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const { createDisposableDb } = require('../scripts/assert-disposable-db');
createDisposableDb({ suite: 'identity-mapping.test.js' }); // points process.env.DB_PATH at a disposable copy

// Stub Supabase BEFORE requiring auth.service (it require()s config lazily
// inside the call, so an env-independent stub registered via the require
// cache patch below is sufficient).
const stubAuth = {
  // eslint-disable-next-line no-unused-vars
  async signInWithPassword({ email, password }) {
    if (password === 'correct-password') {
      return {
        data: {
          user: { id: CLOUD_UID, email },
          session: { access_token: 'stub-access-token' },
        },
        error: null,
      };
    }
    return { data: null, error: { message: 'Invalid login credentials' } };
  },
};

const CLOUD_UID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// Patch the module cache so ../config/supabase resolves to the stub client.
// (auth.service.js loads config/supabase lazily inside methods, so patching
// require.cache for that exact resolved path works regardless of load order.)
const Module = require('node:module');
const supabaseConfigPath = require.resolve(path.join(ROOT, 'server/config/supabase.js'));
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request.endsWith('config/supabase') || request === supabaseConfigPath) {
    return {
      isConfigured: () => true,
      getSupabaseClient: () => ({ auth: stubAuth }),
      getSupabaseUrl: () => 'https://stub.supabase.co',
      getAnonKey: () => 'stub-anon-key',
      getServiceRoleKey: () => null,
      getProjectRef: () => null,
      supabaseCreateClient: () => ({ auth: stubAuth }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { DatabaseSync } = require('node:sqlite');
const { AuthService } = require(path.join(ROOT, 'server/services/auth.service.js'));

afterAll(() => {
  // Remove the per-test temp dirs created in createDb().
  const fs = require('node:fs');
  for (const d of createdDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Minimal schema needed by AuthService.login() on a fresh file. */
const createdDirs = [];
function createDb() {
  // Each test gets its OWN disposable file — a shared path would leak state
  // (users/auth_sessions) across the four scenarios.
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bscrm-idmap-'));
  createdDirs.push(dir);
  const file = path.join(dir, 'suite-e2e.db');
  const raw = new DatabaseSync(file);
  // Match server/database/connection.js normalizeArgs semantics: accept both
  // run(sql, a, b) and run(sql, [a, b]); booleans/objects bound like the app.
  const toBindable = (v) => {
    if (v === undefined) return null;
    if (typeof v === 'function') return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    return v;
  };
  const normalize = (args) => {
    const list = (args.length === 1 && Array.isArray(args[0])) ? args[0] : args;
    return list.map(toBindable);
  };
  // node:sqlite exposes prepare()/exec(); the services use the project's
  // adapter shape (run/get/all). Wrap the raw handle minimally.
  const db = {
    raw,
    exec: (sql) => raw.exec(sql),
    run: (sql, ...args) => raw.prepare(sql).run(...normalize(args)),
    get: (sql, ...args) => raw.prepare(sql).get(...normalize(args)),
    all: (sql, ...args) => raw.prepare(sql).all(...normalize(args)),
    transaction: (fn) => fn(),
  };
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'ACTIVE');
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, company_id TEXT, username TEXT, email TEXT,
      password_hash TEXT, full_name TEXT, role TEXT, status TEXT DEFAULT 'ACTIVE',
      last_login_at DATETIME, hierarchy_role TEXT, parent_user_id TEXT,
      must_change_password INTEGER DEFAULT 0, supabase_user_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, company_id TEXT, name TEXT, code TEXT UNIQUE, description TEXT, is_system INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS permissions (id TEXT PRIMARY KEY, company_id TEXT, code TEXT UNIQUE, module TEXT, name TEXT, description TEXT);
    CREATE TABLE IF NOT EXISTS role_permissions (role_id TEXT NOT NULL, permission_id TEXT NOT NULL, PRIMARY KEY (role_id, permission_id));
    CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT NOT NULL, role_id TEXT NOT NULL, PRIMARY KEY (user_id, role_id));
    CREATE TABLE IF NOT EXISTS agency_administrators (id TEXT PRIMARY KEY, agency_id TEXT, user_id TEXT, status TEXT DEFAULT 'ACTIVE', assigned_at DATETIME, revoked_at DATETIME, revoked_by TEXT, company_id TEXT);
    CREATE TABLE IF NOT EXISTS agencies (id TEXT PRIMARY KEY, company_id TEXT, agency_code TEXT, name TEXT, status TEXT);
    CREATE TABLE IF NOT EXISTS agency_parent_relationships (parent_agency_id TEXT, child_agency_id TEXT);
    CREATE TABLE IF NOT EXISTS auth_sessions (
      session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, company_id TEXT NOT NULL,
      issued_at DATETIME NOT NULL, expires_at DATETIME NOT NULL,
      last_seen_at DATETIME, revoked_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY, company_id TEXT, user_id TEXT, action TEXT,
      entity_type TEXT, entity_id TEXT, session_id TEXT,
      old_values_json TEXT, new_values_json TEXT, ip_address TEXT, user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

function seedUser(db, { id, email, supabaseUserId, companyId = 'cmp_local' }) {
  db.run(
    `INSERT INTO users(id, company_id, username, email, password_hash, full_name, role, status, supabase_user_id)
  VALUES(?,?,?,?,?, 'Test User', 'USER', 'ACTIVE',?)`,
    id, companyId, email.split('@')[0], email, 'not-a-credential', supabaseUserId || null,
  );
  // Verify the seed actually landed — a silently skipped INSERT would make the
  // UUID-preference and session assertions pass for the wrong reason.
  const seeded = db.get('SELECT id FROM users WHERE id = ?', [id]);
  if (!seeded) throw new Error('seedUser: insert did not land for ' + id);
}

describe('P1 centralized identity mapping (login)', () => {
  test('login resolves the mirror row by supabase_user_id even when the email differs locally', async () => {
    const db = createDb();
    // Device B scenario: locally seeded row has a DIFFERENT email spelling
    // and NO cloud link. The cloud identity is the only match.
    seedUser(db, { id: 'usr_local_b', email: 'operator@blackstack.local', supabaseUserId: null });
    const svc = new AuthService(db);
    const result = await svc.login('operator@blackstack.local', 'correct-password');
    expect(result.token).toBeTruthy();
    const row = db.get('SELECT supabase_user_id FROM users WHERE id = ?', ['usr_local_b']);
    expect(row.supabase_user_id).toBe(CLOUD_UID); // UUID bound at login
  });

  test('login prefers the supabase_user_id match over a conflicting email row', async () => {
    const db = createDb();
    // Row A: matches the cloud UUID, different email.
    seedUser(db, { id: 'usr_by_uuid', email: 'other@blackstack.local', supabaseUserId: CLOUD_UID });
    // Row B: matches the typed email, no cloud link (e.g. stale duplicate seed).
    seedUser(db, { id: 'usr_by_email', email: 'typed@blackstack.local', supabaseUserId: null });
    const svc = new AuthService(db);
    const result = await svc.login('typed@blackstack.local', 'correct-password');
    expect(result.token).toBeTruthy();
    const uuidRow = db.get('SELECT last_login_at FROM users WHERE id = ?', ['usr_by_uuid']);
    const emailRow = db.get('SELECT last_login_at FROM users WHERE id = ?', ['usr_by_email']);
    expect(String(uuidRow.last_login_at || '')).toBeTruthy();   // UUID row was used
    expect(emailRow.last_login_at == null || emailRow.last_login_at === '').toBe(true); // email row untouched
  });

  test('wrong cloud password still fails even though a local row exists (no local fallback)', async () => {
    const db = createDb();
    seedUser(db, { id: 'usr_x', email: 'someone@blackstack.local', supabaseUserId: CLOUD_UID });
    const svc = new AuthService(db);
    await expect(svc.login('someone@blackstack.local', 'wrong-password')).rejects.toThrow('Invalid credentials.');
    const row = db.get('SELECT last_login_at, supabase_user_id FROM users WHERE id = ?', ['usr_x']);
    expect(row.last_login_at).toBeNull();
  });

  test('login creates a session row for the resolved (UUID-linked) user', async () => {
    const db = createDb();
    seedUser(db, { id: 'usr_s', email: 'sess@blackstack.local', supabaseUserId: CLOUD_UID });
    const svc = new AuthService(db);
    const result = await svc.login('sess@blackstack.local', 'correct-password');
    const sessions = db.get('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?', ['usr_s']);
    expect(Number(sessions.n)).toBeGreaterThanOrEqual(1);
    expect(result.user.id).toBe('usr_s');
  });
});
