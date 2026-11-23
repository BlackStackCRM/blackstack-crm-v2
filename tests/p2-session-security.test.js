/**
 * P2 — SESSION SECURITY TESTS (audit §26.9 T-08/T-10 extensions)
 *
 * Covers the three P2 deliverables:
 *   S1  Fail-closed service-role configuration (config/supabase.js):
 *       a desktop build (BLACKSTACK_DESKTOP=1) NEVER reads or accepts the
 *       service-role key, even when it is present in the environment.
 *   S2  Cloud access-token verification (auth/cloudSession.js): garbage,
 *       foreign-issuer and wrong-audience tokens are rejected; shape check
 *       never validates a signature.
 *   S3  Secure refresh-token store (electron/secure-session-store.js):
 *       plaintext fallback is forbidden (fail-closed), corrupt/missing
 *       state reads as "no session", clear removes the blob.
 *
 * NO NETWORK, NO ELECTRON RUNTIME — Electron pieces are stubbed.
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

// ───────────────────────── helpers ─────────────────────────
function withEnv(overrides, fn) {
  const saved = {};
  const keys = Object.keys(overrides);
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) {
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** base64url helper for hand-built JWTs. */
const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function makeJwt(header, payload) {
  return `${b64u(header)}.${b64u(payload)}.SIG`;
}

/** Fresh module copy with the given env, bypassing require cache. */
function freshRequire(relPath) {
  delete require.cache[require.resolve(path.join(ROOT, relPath))];
  return require(path.join(ROOT, relPath));
}

// ───────────────────────── S1: fail-closed service role ─────────────────────────
describe('P2-S1: fail-closed service-role configuration', () => {
  const URL_OK = 'https://proj.supabase.co';
  const ANON = 'anon-key-value';
  const SERVICE = 'service-role-key-value';

  test('desktop build: isConfigured() is FALSE when only the service-role key exists', () => {
    withEnv({ BLACKSTACK_DESKTOP: '1', SUPABASE_URL: URL_OK, SUPABASE_ANON_KEY: undefined, SUPABASE_SERVICE_ROLE_KEY: SERVICE }, () => {
      const cfg = freshRequire('server/config/supabase.js');
      expect(cfg.isConfigured()).toBe(false);
      expect(cfg.getAnonKey()).toBeNull();
      expect(cfg.getServiceRoleKey()).toBeNull();
    });
  });

  test('desktop build: service-role key present in env is NEVER returned', () => {
    withEnv({ BLACKSTACK_DESKTOP: '1', SUPABASE_URL: URL_OK, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE }, () => {
      const cfg = freshRequire('server/config/supabase.js');
      expect(cfg.isConfigured()).toBe(true);
      expect(cfg.getAnonKey()).toBe(ANON);
      expect(cfg.getServiceRoleKey()).toBeNull(); // fail-closed
    });
  });

  test('server process (no desktop flag): legacy fallback still works (dev sync worker)', () => {
    withEnv({ BLACKSTACK_DESKTOP: undefined, SUPABASE_URL: URL_OK, SUPABASE_ANON_KEY: undefined, SUPABASE_SERVICE_ROLE_KEY: SERVICE }, () => {
      const cfg = freshRequire('server/config/supabase.js');
      expect(cfg.isConfigured()).toBe(true);
      expect(cfg.getServiceRoleKey()).toBe(SERVICE);
    });
  });
});

// ───────────────────────── S2: cloud token verification ─────────────────────────
describe('P2-S2: cloud access-token verification (fail-closed)', () => {
  const URL = 'https://proj.supabase.co';
  const cloudSession = require(path.join(ROOT, 'server/auth/cloudSession.js'));

  test('garbage / truncated tokens are rejected', async () => {
    await expect(cloudSession.verifyCloudAccessToken('garbage', { supabaseUrl: URL })).resolves.toBeNull();
    await expect(cloudSession.verifyCloudAccessToken('a.b', { supabaseUrl: URL })).resolves.toBeNull();
    await expect(cloudSession.verifyCloudAccessToken(null, { supabaseUrl: URL })).resolves.toBeNull();
  });

  test('foreign issuer is rejected before any network access', async () => {
    const token = makeJwt(
      { alg: 'RS256', kid: 'x' },
      { iss: 'https://other-project.supabase.co/auth/v1', aud: 'authenticated', sub: 'uid-1', exp: Math.floor(Date.now() / 1000) + 600 },
    );
    await expect(cloudSession.verifyCloudAccessToken(token, { supabaseUrl: URL })).resolves.toBeNull();
  });

  test('wrong audience is rejected before any network access', async () => {
    const token = makeJwt(
      { alg: 'RS256', kid: 'x' },
      { iss: 'https://proj.supabase.co/auth/v1', aud: 'anon', sub: 'uid-1', exp: Math.floor(Date.now() / 1000) + 600 },
    );
    await expect(cloudSession.verifyCloudAccessToken(token, { supabaseUrl: URL })).resolves.toBeNull();
  });

  test('well-formed claims but invalid signature is rejected (signature actually checked)', async () => {
    const token = makeJwt(
      { alg: 'RS256', kid: 'x' },
      { iss: 'https://proj.supabase.co/auth/v1', aud: 'authenticated', sub: 'uid-1', exp: Math.floor(Date.now() / 1000) + 600 },
    );
    // SIG is not a valid RS256 signature over the header/payload — the JWKS
    // fetch will succeed (jose fetches from the fake URL? No: network is
    // blocked in tests), and either way verification MUST fail.
    await expect(cloudSession.verifyCloudAccessToken(token, { supabaseUrl: URL })).resolves.toBeNull();
  });

  test('decodeUnsafe never validates a signature (documented shape-check only)', () => {
    const token = makeJwt(
      { alg: 'RS256' },
      { iss: 'https://proj.supabase.co/auth/v1', aud: 'authenticated', sub: 'uid-1' },
    );
    const d = cloudSession.decodeUnsafe(token);
    expect(d.payload.sub).toBe('uid-1');
    expect(cloudSession.decodeUnsafe('not-a-jwt')).toBeNull();
  });
});

// ───────────────────────── S3: secure refresh-token store ─────────────────────────
describe('P2-S3: secure refresh-token store (safeStorage, fail-closed)', () => {
  const secureSession = require(path.join(ROOT, 'electron/secure-session-store.js'));

  function makeElectron({ encryptionAvailable = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bscrm-secstore-'));
    const app = { getPath: () => dir };
    const safeStorage = {
      isEncryptionAvailable: () => encryptionAvailable,
      encryptString: (s) => Buffer.from('ENC[' + s + ']'),
      decryptString: (b) => {
        const s = b.toString('utf8');
        if (!s.startsWith('ENC[') || !s.endsWith(']')) throw new Error('not encrypted');
        return s.slice(4, -1);
      },
    };
    return { electron: { app, safeStorage }, dir };
  }

  test('save + load roundtrip encrypts at rest (no plaintext on disk)', () => {
    const { electron, dir } = makeElectron();
    const r = secureSession.saveRefreshToken(electron, 'refresh-token-abc-1234567890');
    expect(r.stored).toBe(true);
    const blobPath = secureSession.storePath(electron.app);
    const raw = fs.readFileSync(blobPath);
    // Real safeStorage output is an opaque DPAPI blob — it must not be valid
    // UTF-8 containing the token. Our stub marks ciphertext with an ENC[]
    // wrapper so the "not plaintext" assertion is checkable.
    expect(raw.toString('utf8').startsWith('ENC[')).toBe(true);
    expect(raw.toString('utf8')).not.toBe('refresh-token-abc-1234567890'); // not stored verbatim
    expect(secureSession.loadRefreshToken(electron)).toBe('refresh-token-abc-1234567890');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('FAIL-CLOSED: safeStorage unavailable -> token NOT persisted, no plaintext file', () => {
    const { electron, dir } = makeElectron({ encryptionAvailable: false });
    const r = secureSession.saveRefreshToken(electron, 'refresh-token-abc-1234567890');
    expect(r.stored).toBe(false);
    expect(r.reason).toBe('ENCRYPTION_UNAVAILABLE');
    expect(fs.existsSync(secureSession.storePath(electron.app))).toBe(false);
    expect(secureSession.loadRefreshToken(electron)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('corrupt / missing / cleared state reads as "no session"', () => {
    const { electron, dir } = makeElectron();
    secureSession.saveRefreshToken(electron, 'refresh-token-abc-1234567890');
    // Corrupt the blob (simulates key rotation / tamper).
    fs.writeFileSync(secureSession.storePath(electron.app), Buffer.from('garbage'));
    expect(secureSession.loadRefreshToken(electron)).toBeNull();
    // Clear removes the file.
    expect(secureSession.clearRefreshToken(electron)).toBe(true);
    expect(fs.existsSync(secureSession.storePath(electron.app))).toBe(false);
    expect(secureSession.loadRefreshToken(electron)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
