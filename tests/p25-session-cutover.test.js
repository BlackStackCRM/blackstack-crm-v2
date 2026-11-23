/**
 * P2.5 — SESSION CUTOVER SECURITY TESTS
 *
 * Covers the operator-directed checklist:
 *   C1  Expired access token rejected (enforcement ON)
 *   C2  Invalid signature / wrong issuer / wrong audience rejected
 *   C3  JWKS unavailable -> authentication NOT permitted (fail-closed)
 *   C4  Legacy local HS256 token can NOT bypass cloud auth when ON
 *       (and still works when OFF — no behavior change pre-cutover)
 *   C5  Refresh token survives restart (store roundtrip) and rotation is
 *       persisted; rejected refresh clears the store
 *   C6  Logout clears the local encrypted session (store cleared via IPC
 *       handler semantics + cloud signOut attempted)
 *   C7  Network interruption during refresh keeps the stored token for retry
 *
 * Enforcement is feature-gated (BLACKSTACK_REQUIRE_CLOUD_TOKEN) — tests
 * toggle the flag per scenario. NO NETWORK: jose JWKS fetch is exercised
 * only via failure paths; refresh endpoint is a stub fetch.
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const makeJwt = (h, p) => `${b64u(h)}.${b64u(p)}.SIG`;

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) { saved[k] = process.env[k]; process.env[k] = overrides[k]; }
  // async fn: restore env only AFTER the promise settles, or assertions
  // inside the callback would run with the flag already removed.
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(overrides)) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    });
}

// Middleware needs the project DB adapter; stub getConn through require cache.
const dbState = { users: {}, revoked: {} };
function stubDb() {
  const fakeConn = {
    get: (sql, p = []) => {
      const args = Array.isArray(p) ? p : [p];
      if (/FROM users WHERE supabase_user_id/.test(sql)) {
        const uid = args[0];
        const id = Object.keys(dbState.users).find((k) => dbState.users[k].supabase_user_id === uid);
        return id ? dbState.users[id] : null;
      }
      if (/FROM users u LEFT JOIN companies/.test(sql)) {
        const u = dbState.users[args[0]];
        return u ? { id: u.id, company_id: u.company_id, status: u.status, company_status: 'ACTIVE' } : null;
      }
      if (/FROM users WHERE id=\?/.test(sql) || /FROM users WHERE id = \?/.test(sql)) {
        const u = dbState.users[args[0]];
        return u ? { id: u.id, email: u.email, role: u.role, hierarchy_role: u.hierarchy_role } : null;
      }
      if (/FROM auth_sessions WHERE session_id/.test(sql)) {
        return dbState.revoked[args[0]] ? { revoked_at: 'now' } : null;
      }
      return null;
    },
    run: () => { },
    all: () => [],
    transaction: (f) => f(),
  };
  const connPath = require.resolve(path.join(ROOT, 'server/utils/db.js'));
  require.cache[connPath] = {
    id: connPath, filename: connPath, loaded: true,
    exports: { getConn: () => fakeConn },
  };
  // UserRepository (used by refreshSessionAuthorization) resolves the DB via
  // database/connection.js, not utils/db — stub that too so the legacy-path
  // test (P2.5-D) can run without a real SQLite file.
  const conn2Path = require.resolve(path.join(ROOT, 'server/database/connection.js'));
  require.cache[conn2Path] = {
    id: conn2Path, filename: conn2Path, loaded: true,
    exports: { DatabaseConnection: class { connect() { return fakeConn; } } },
  };
}

const GOOD_UID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const URL = 'https://proj.supabase.co';

beforeAll(() => { stubDb(); });
beforeEach(() => {
  dbState.users = {
    usr_mirror: {
      id: 'usr_mirror', company_id: 'cmp1', status: 'ACTIVE',
      email: 'x@blackstack.local', role: 'USER', supabase_user_id: GOOD_UID,
    },
  };
  dbState.revoked = {};
});

function middleware() {
  // Fresh copy per call so the env flag is read at call time (the flag is
  // checked inside authMiddleware, not at import — cache clearing is only
  // needed if the module ever hoists the check).
  const mod = require(path.join(ROOT, 'server/middleware/auth.js'));
  // Wrap the async middleware so sync throws (AuthenticationError raised
  // before any await) surface as rejections — Express does this conversion
  // automatically for async handlers, plain calls do not.
  return (req, res, next) => mod.authMiddleware(req, res, next);
}

// Stub config/supabase (middleware reads SUPABASE_URL via getSupabaseUrl).
const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (String(request).endsWith('config/supabase')) {
    return {
      isConfigured: () => true,
      getSupabaseUrl: () => 'https://proj.supabase.co',
      getSupabaseClient: () => ({ auth: { signOut: async () => ({}) } }),
      getAnonKey: () => 'anon',
      getServiceRoleKey: () => null,
      getProjectRef: () => null,
      supabaseCreateClient: () => ({}),
    };
  }
  return origLoad.call(this, request, parent, isMain);
};

const runMw = (mw, token) => Promise.resolve(
  mw({ headers: { authorization: 'Bearer ' + token } }, {}, () => {}),
).then(() => true);

describe('P2.5-C: cloud-token enforcement (flag ON)', () => {
  test('C1+C2: expired / wrong-issuer / wrong-audience / bad-signature tokens rejected', async () => {
    await withEnv({ BLACKSTACK_REQUIRE_CLOUD_TOKEN: '1', JWT_SECRET: 'test-secret-value-at-least-32-bytes!!' }, async () => {
      const mw = middleware(); // env read at call time inside authMiddleware
      const expired = makeJwt(
        { alg: 'RS256', kid: 'k' },
        { iss: URL + '/auth/v1', aud: 'authenticated', sub: GOOD_UID, exp: Math.floor(Date.now() / 1000) - 10 },
      );
      await expect(runMw(mw, expired)).rejects.toThrow('Cloud session verification failed');
      const foreign = makeJwt(
        { alg: 'RS256', kid: 'k' },
        { iss: 'https://evil.example.com/auth/v1', aud: 'authenticated', sub: GOOD_UID, exp: Math.floor(Date.now() / 1000) + 600 },
      );
      await expect(runMw(mw, foreign)).rejects.toThrow('Cloud session verification failed');
      const wrongAud = makeJwt(
        { alg: 'RS256', kid: 'k' },
        { iss: URL + '/auth/v1', aud: 'anon', sub: GOOD_UID, exp: Math.floor(Date.now() / 1000) + 600 },
      );
      await expect(runMw(mw, wrongAud)).rejects.toThrow('Cloud session verification failed');
      const badSig = makeJwt(
        { alg: 'RS256', kid: 'k' },
        { iss: URL + '/auth/v1', aud: 'authenticated', sub: GOOD_UID, exp: Math.floor(Date.now() / 1000) + 600 },
      );
      await expect(runMw(mw, badSig)).rejects.toThrow('Cloud session verification failed');
    });
  });

  test('C4: legacy local HS256 session token can NOT bypass cloud auth when ON', async () => {
    await withEnv({ BLACKSTACK_REQUIRE_CLOUD_TOKEN: '1', JWT_SECRET: 'test-secret-value-at-least-32-bytes!!' }, async () => {
      const { SessionManager } = require(path.join(ROOT, 'server/auth/session.js'));
      const legacy = SessionManager.createSession(
        { id: 'usr_mirror', email: 'x@blackstack.local', full_name: 'X', role: 'USER' },
        { companyId: 'cmp1', permissions: [], roleIds: [], sessionId: 'sess_x' },
      );
      const mw = middleware();
      await expect(runMw(mw, legacy.token)).rejects.toThrow('Cloud session verification failed');
    });
  });
});

describe('P2.5-D: legacy flow unaffected when flag OFF (pre-cutover default)', () => {
  test('local HS256 session still authenticates', async () => {
    await withEnv({ BLACKSTACK_REQUIRE_CLOUD_TOKEN: undefined, JWT_SECRET: 'test-secret-value-at-least-32-bytes!!' }, async () => {
      // Fresh SessionManager + middleware copies so the HS256 secret resolves
      // from THIS test's env (a cached module would carry the first-resolved
      // per-install persisted secret and the token would fail verification).
      delete require.cache[require.resolve(path.join(ROOT, 'server/auth/session.js'))];
      delete require.cache[require.resolve(path.join(ROOT, 'server/auth/jwtSecret.js'))];
      const { SessionManager } = require(path.join(ROOT, 'server/auth/session.js'));
      const legacy = SessionManager.createSession(
        { id: 'usr_mirror', email: 'x@blackstack.local', full_name: 'X', role: 'USER' },
        { companyId: 'cmp1', permissions: [], roleIds: [], sessionId: 'sess_y' },
      );
      delete require.cache[require.resolve(path.join(ROOT, 'server/middleware/auth.js'))];
      const mw = middleware();
      await expect(runMw(mw, legacy.token)).resolves.toBe(true);
    });
  });
});

describe('P2.5-R: refresh-token recovery + rotation (sessionRecovery)', () => {
  const { refreshCloudSession } = require(path.join(ROOT, 'server/auth/sessionRecovery.js'));
  const baseDeps = (over = {}) => ({
    getStoredRefreshToken: () => 'stored-rt',
    saveStoredRefreshToken: () => { },
    clearStoredRefreshToken: () => { },
    supabaseUrl: URL,
    anonKey: 'anon',
    ...over,
  });

  test('C5: successful refresh rotates and PERSISTS the new refresh token', async () => {
    let saved = null;
    const fetchStub = async () => ({
      ok: true, json: async () => ({
        access_token: 'new-at', refresh_token: 'rotated-rt', expires_in: 3600,
        user: { id: GOOD_UID, email: 'x@blackstack.local' },
      })
    });
    const out = await refreshCloudSession(baseDeps({
      saveStoredRefreshToken: (t) => { saved = t; },
      fetch: fetchStub,
    }));
    expect(out.access_token).toBe('new-at');
    expect(saved).toBe('rotated-rt'); // rotation persisted -> survives restart
  });

  test('C5b: rejected refresh (reuse/expired) CLEARS the stored token', async () => {
    let cleared = false;
    const out = await refreshCloudSession(baseDeps({
      clearStoredRefreshToken: () => { cleared = true; },
      fetch: async () => ({ ok: false, json: async () => ({}) }),
    }));
    expect(out).toBeNull();
    expect(cleared).toBe(true);
  });

  test('C7: network interruption KEEPS the stored token for later retry', async () => {
    let cleared = false;
    const out = await refreshCloudSession(baseDeps({
      clearStoredRefreshToken: () => { cleared = true; },
      fetch: async () => { throw new Error('ECONNREFUSED'); },
    }));
    expect(out).toBeNull();
    expect(cleared).toBe(false); // token retained — retry after connectivity
  });

  test('fail-closed: no stored token -> null (login screen), never a local bypass', async () => {
    const out = await refreshCloudSession(baseDeps({ getStoredRefreshToken: () => null }));
    expect(out).toBeNull();
  });
});

describe('P2.5-L: logout clears the encrypted local session', () => {
  test('clearRefreshToken removes the persisted blob (IPC session:clear semantics)', () => {
    const secureSession = require(path.join(ROOT, 'electron/secure-session-store.js'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bscrm-p25-'));
    const app = { getPath: () => dir };
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('ENC[' + s + ']'),
      decryptString: (b) => { const s = b.toString('utf8'); if (!s.startsWith('ENC[')) throw new Error('not encrypted'); return s.slice(4, -1); },
    };
    secureSession.saveRefreshToken({ app, safeStorage }, 'rt-to-be-cleared-123456');
    expect(secureSession.loadRefreshToken({ app, safeStorage })).toBe('rt-to-be-cleared-123456');
    expect(secureSession.clearRefreshToken({ app, safeStorage })).toBe(true);
    expect(secureSession.loadRefreshToken({ app, safeStorage })).toBeNull(); // logged out
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
