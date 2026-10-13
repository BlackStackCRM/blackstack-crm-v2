/**
 * E-01 REGRESSION — JWT signing key must never be a hard-coded secret.
 *
 * THE DEFECT
 *   server/auth/session.js previously fell back to the literal string
 *   'dev-only-insecure-secret', behind a guard that only fired when
 *   NODE_ENV === 'production'. The packaged desktop app sets
 *   BLACKSTACK_DESKTOP=1 and ships no .env, so NODE_ENV was never
 *   'production' — every installed copy authenticated with a secret published
 *   in this repository.
 *
 * WHAT IS PINNED HERE
 *   1. No hard-coded fallback exists anywhere in server/ (source assertion).
 *   2. A per-install secret is generated, persisted outside the DB, and is
 *      stable across restarts (so sessions survive a reboot).
 *   3. Two installations do NOT share a secret.
 *   4. A weak/placeholder JWT_SECRET in the environment is refused, not used.
 *   5. The secret file is owner-only on Windows (DACL), not merely 0600-named.
 *   6. Token verification rejects: tampered signature, alg:none downgrade,
 *      wrong issuer, wrong audience, expiry, and malformed input.
 *   7. The secret value never appears in logged output.
 *
 * Uses vitest GLOBALS (vitest.config.js sets globals: true).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const jwtSecretMod = require(path.join(ROOT, 'server', 'auth', 'jwtSecret.js'));

/**
 * Extract the child's JSON result.
 *
 * The child process may emit informational lines before its payload (for
 * example the "[auth] Session signing key ..." startup line). Assuming stdout
 * is pure JSON makes the test fail for a reason that has nothing to do with the
 * behaviour under test.
 */
function parseChildJson(stdout) {
  const lines = String(stdout).trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const t = lines[i].trim();
    if (t.startsWith('{')) return JSON.parse(t);
  }
  throw new Error(`no JSON payload in child output:\n${stdout}`);
}

/** Run code in a clean child process with an isolated userData dir. */
function inChild(code, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e01-'));
  const r = spawnSync(process.execPath, ['-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      BLACKSTACK_USER_DATA_DIR: tmp,
      // Never inherit a real secret from the ambient environment.
      JWT_SECRET: undefined,
      NODE_ENV: 'test',
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', tmp };
}

describe('E-01 — no hard-coded JWT secret exists in the codebase', () => {
  test('the literal fallback string appears only where it is explicitly rejected', () => {
    const session = fs.readFileSync(path.join(ROOT, 'server', 'auth', 'session.js'), 'utf8');
    const secret = fs.readFileSync(path.join(ROOT, 'server', 'auth', 'jwtSecret.js'), 'utf8');

    // It must not be used as a VALUE anywhere.
    expect(session).not.toMatch(/=\s*['"]dev-only-insecure-secret['"]/);
    expect(secret).not.toMatch(/secret\s*[:=]\s*['"]dev-only-insecure-secret['"]/);

    // It is still named in jwtSecret.js purely to be blacklisted.
    expect(secret).toContain('dev-only-insecure-secret');
  });

  test('every file under server/ and electron/ is free of the fallback assignment', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) {
          const c = fs.readFileSync(p, 'utf8');
          if (/=\s*['"]dev-only-insecure-secret['"]/.test(c)) offenders.push(p);
        }
      }
    };
    walk(path.join(ROOT, 'server'));
    walk(path.join(ROOT, 'electron'));
    expect(offenders, `hard-coded secret assignments found: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('E-01 — per-install secret generation', () => {
  test('generates a 256-bit secret and persists it outside the database', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e01-gen-'));
    const before = { env: process.env.BLACKSTACK_USER_DATA_DIR };
    process.env.BLACKSTACK_USER_DATA_DIR = tmp;
    try {
      const r = jwtSecretMod.resolveJwtSecret();
      expect(r.source).toBe('generated');
      expect(Buffer.from(r.secret, 'utf8').length).toBeGreaterThanOrEqual(32);
      expect(r.persistedTo).toBe(path.join(tmp, 'session-signing.key'));
      // Must NOT be written inside the project's data/ directory.
      expect(r.persistedTo.startsWith(path.join(ROOT, 'data'))).toBe(false);
      expect(fs.existsSync(r.persistedTo)).toBe(true);
    } finally {
      if (before.env === undefined) delete process.env.BLACKSTACK_USER_DATA_DIR;
      else process.env.BLACKSTACK_USER_DATA_DIR = before.env;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('the same installation reuses its secret, so sessions survive a restart', () => {
    const r = inChild(`
      const m = require('./server/auth/jwtSecret.js');
      const a = m.resolveJwtSecret();
      const b = m.resolveJwtSecret();
      console.log(JSON.stringify({ same: a.secret === b.secret, src: b.source }));
    `);
    expect(r.status, r.stderr).toBe(0);
    const { same, src } = parseChildJson(r.stdout);
    expect(same, 'a new secret per boot would log every user out').toBe(true);
    expect(src).toBe('persisted');
  });

  test('two different installations do NOT share a secret', () => {
    const a = inChild(`
      const m = require('./server/auth/jwtSecret.js');
      console.log(m.resolveJwtSecret().fingerprint);
    `);
    const b = inChild(`
      const m = require('./server/auth/jwtSecret.js');
      console.log(m.resolveJwtSecret().fingerprint);
    `);
    expect(a.status, a.stderr).toBe(0);
    expect(b.status, b.stderr).toBe(0);
    expect(a.stdout.trim()).not.toBe(b.stdout.trim());
  });

  test('an operator-supplied strong JWT_SECRET is honoured', () => {
    const r = inChild(
      `
      const m = require('./server/auth/jwtSecret.js');
      const x = m.resolveJwtSecret();
      console.log(JSON.stringify({ src: x.source, same: x.secret === process.env.JWT_SECRET }));
      `,
      { JWT_SECRET: 'a-strong-operator-supplied-secret-value-32b' },
    );
    expect(r.status, r.stderr).toBe(0);
    const o = parseChildJson(r.stdout);
    expect(o.src).toBe('environment');
    expect(o.same).toBe(true);
  });

  test('placeholder secrets in the environment are REFUSED, not used', () => {
    for (const bad of ['change-me-in-production', 'dev-only-insecure-secret', 'secret']) {
      const r = inChild(
        `
        const m = require('./server/auth/jwtSecret.js');
        const x = m.resolveJwtSecret();
        console.log(JSON.stringify({ src: x.source, used: x.secret === process.env.JWT_SECRET }));
        `,
        { JWT_SECRET: bad },
      );
      expect(r.status, r.stderr).toBe(0);
      const o = parseChildJson(r.stdout);
      expect(o.used, `"${bad}" must never be adopted as a signing key`).toBe(false);
      expect(o.src).not.toBe('environment');
    }
  });

  test('fails closed when a secret cannot be obtained', () => {
    // persist:false outside a dev/test env must throw rather than invent a key.
    const r = inChild(
      `
      const m = require('./server/auth/jwtSecret.js');
      try {
        m.resolveJwtSecret({ persist: false, env: 'production', secretPath: 'x' });
        console.log(JSON.stringify({ threw: false }));
      } catch (e) {
        console.log(JSON.stringify({ threw: true, msg: e.message }));
      }
      `,
      { NODE_ENV: 'production' },
    );
    expect(r.status, r.stderr).toBe(0);
    const o = parseChildJson(r.stdout);
    expect(o.threw, 'production must not fall back to an ephemeral secret').toBe(true);
  });

  test('a placeholder left in the key file is refused rather than silently reused', () => {
    const r = inChild(`
      const fs = require('fs');
      const path = require('path');
      const m = require('./server/auth/jwtSecret.js');
      const p = path.join(process.env.BLACKSTACK_USER_DATA_DIR, m.SECRET_FILE);
      fs.mkdirSync(process.env.BLACKSTACK_USER_DATA_DIR, { recursive: true });
      fs.writeFileSync(p, 'change-me-in-production');
      try {
        m.resolveJwtSecret();
        console.log(JSON.stringify({ threw: false }));
      } catch (e) {
        console.log(JSON.stringify({ threw: true, msg: e.message }));
      }
    `);
    expect(r.status, r.stderr).toBe(0);
    const o = parseChildJson(r.stdout);
    expect(o.threw).toBe(true);
    expect(o.msg).toMatch(/placeholder/i);
  });
});

describe('E-01 — the secret value is never disclosed', () => {
  test('no diagnostic output contains the secret value', () => {
    const r = inChild(`
      const m = require('./server/auth/jwtSecret.js');
      const x = m.resolveJwtSecret();
      console.log('fingerprint=' + x.fingerprint);
      console.log('fp_matches_secret=' + (x.fingerprint === x.secret));
      console.log('secret_len=' + x.secret.length);
    `);
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout;
    expect(out).not.toMatch(/[0-9a-f]{64}/); // the generated hex secret
    expect(out).toContain('fp_matches_secret=false');
    expect(out).toContain('secret_len=64');
  });

  test('the fingerprint is stable but does not reveal the secret', () => {
    const a = jwtSecretMod.fingerprint('abcdef0123456789');
    const b = jwtSecretMod.fingerprint('abcdef0123456789');
    const c = jwtSecretMod.fingerprint('abcdef0123456780');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.length).toBe(12);
  });

  test('server/auth/session.js exports no secret through any surface', () => {
    const session = fs.readFileSync(path.join(ROOT, 'server', 'auth', 'session.js'), 'utf8');
    expect(session).not.toMatch(/module\.exports\s*=\s*\{[^}]*SECRET/);
    expect(session).not.toMatch(/static\s+getSecret|static\s+secret/i);
  });
});

describe('E-01 — Windows ACL hardening on the key file', () => {
  test.skipIf(process.platform !== 'win32')('the key file is readable only by its owner', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e01-acl-'));
    const before = process.env.BLACKSTACK_USER_DATA_DIR;
    process.env.BLACKSTACK_USER_DATA_DIR = tmp;
    let keyPath;
    try {
      const r = jwtSecretMod.resolveJwtSecret();
      keyPath = r.persistedTo;
      const acl = execFileSync('icacls', [keyPath], { encoding: 'utf8', windowsHide: true });
      // No inheritance must remain: an inherited ACE can grant another account
      // read access, which is equivalent to publishing the key.
      expect(acl).not.toMatch(/\(I\)/);
      // SYSTEM / Administrators / owner are acceptable; broad groups are not.
      expect(acl).not.toMatch(/Everyone|Users\s*:/i);
      expect(acl).not.toMatch(/CodexSandboxUsers/i);
    } finally {
      if (before === undefined) delete process.env.BLACKSTACK_USER_DATA_DIR;
      else process.env.BLACKSTACK_USER_DATA_DIR = before;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('E-01 — token verification is hardened', () => {
  test('rejects tampered, downgraded, foreign, expired and malformed tokens', () => {
    const r = inChild(`
      const jwt = require('jsonwebtoken');
      const { SessionManager } = require('./server/auth/session.js');
      const out = {};

      const good = SessionManager.createSession(
        { id: 'u1', email: 'a@b.c', full_name: 'A', role: 'ADMIN' },
        { companyId: 'default', permissions: ['*'], roleIds: ['r1'] },
      );
      out.valid = !!SessionManager.verifyToken(good.token);

      // 1. tampered payload
      const parts = good.token.split('.');
      const forged = parts[0] + '.' + Buffer.from(JSON.stringify({
        userId: 'u1', companyId: 'default', permissions: ['*'], sub: 'x',
      })).toString('base64url') + '.' + parts[2];
      out.tampered = SessionManager.verifyToken(forged);

      // 2. alg:none downgrade
      try {
        const none = jwt.sign({ userId: 'u1', companyId: 'default', permissions: ['*'] }, '', {
          algorithm: 'none',
          issuer: 'blackstack-crm', audience: 'blackstack-crm-desktop',
        });
        out.algNone = SessionManager.verifyToken(none);
      } catch (e) { out.algNone = 'sign-failed:' + e.message.slice(0, 40); }

      // 3. signed with a foreign secret
      try {
        const other = jwt.sign({ userId: 'u1', companyId: 'default' }, 'another-secret-entirely', {
          expiresIn: '1h', issuer: 'blackstack-crm', audience: 'blackstack-crm-desktop',
        });
        out.foreignSecret = SessionManager.verifyToken(other);
      } catch (e) { out.foreignSecret = 'err'; }

      // 4. wrong issuer
      try {
        const wrongIss = jwt.sign({ userId: 'u1', companyId: 'default' },
          process.env.JWT_SECRET || require('./server/auth/jwtSecret.js').resolveJwtSecret().secret,
          { expiresIn: '1h', issuer: 'some-other-app', audience: 'blackstack-crm-desktop' });
        out.wrongIssuer = SessionManager.verifyToken(wrongIss);
      } catch (e) { out.wrongIssuer = 'err'; }

      // 5. wrong audience
      try {
        const wrongAud = jwt.sign({ userId: 'u1', companyId: 'default' },
          require('./server/auth/jwtSecret.js').resolveJwtSecret().secret,
          { expiresIn: '1h', issuer: 'blackstack-crm', audience: 'some-other-client' });
        out.wrongAudience = SessionManager.verifyToken(wrongAud);
      } catch (e) { out.wrongAudience = 'err'; }

      // 6. expired
      try {
        const exp = jwt.sign({ userId: 'u1', companyId: 'default', iat: Math.floor(Date.now()/1000) - 7200, exp: Math.floor(Date.now()/1000) - 3600 },
          require('./server/auth/jwtSecret.js').resolveJwtSecret().secret,
          { issuer: 'blackstack-crm', audience: 'blackstack-crm-desktop' });
        out.expired = SessionManager.verifyToken(exp);
      } catch (e) { out.expired = 'err'; }

      // 7. malformed / empty / non-string
      out.malformed = SessionManager.verifyToken('not.a.jwt');
      out.empty = SessionManager.verifyToken('');
      out.nullTok = SessionManager.verifyToken(null);
      out.undefinedTok = SessionManager.verifyToken(undefined);
      out.objectTok = SessionManager.verifyToken({ token: 'x' });

      // 8. a token signed by THIS install's key but for a DIFFERENT purpose must
      //    still verify (issuer/audience match) — proves claims are intact.
      out.claimsIntact = (SessionManager.verifyToken(good.token) || {}).companyId;

      console.log(JSON.stringify(out));
    `);
    expect(r.status, r.stderr).toBe(0);
    const o = parseChildJson(r.stdout);
    expect(o.valid, 'a legitimately issued token must verify').toBeTruthy();
    expect(o.tampered, 'tampered payload').toBeNull();
    expect(o.algNone, 'alg:none downgrade').toBeFalsy();
    expect(o.foreignSecret, 'signed with a different secret').toBeNull();
    expect(o.wrongIssuer, 'wrong issuer').toBeNull();
    expect(o.wrongAudience, 'wrong audience').toBeNull();
    expect(o.expired, 'expired token').toBeNull();
    expect(o.malformed, 'malformed').toBeNull();
    expect(o.empty, 'empty string').toBeNull();
    expect(o.nullTok, 'null').toBeNull();
    expect(o.undefinedTok, 'undefined').toBeNull();
    expect(o.objectTok, 'non-string').toBeNull();
    expect(o.claimsIntact).toBe('default');
  });

  test('the server still boots and logs in with the generated secret', () => {
    const r = inChild(`
      const { SessionManager } = require('./server/auth/session.js');
      const s = SessionManager.createSession(
        { id: 'u1', email: 'a@b.c', full_name: 'A', role: 'ADMIN' },
        { companyId: 'default', permissions: ['contacts.view'] },
      );
      console.log(JSON.stringify({ fp: SessionManager.signingKeyFingerprint(), ok: !!SessionManager.verifyToken(s.token) }));
    `);
    expect(r.status, r.stderr).toBe(0);
    const o = parseChildJson(r.stdout);
    expect(o.ok).toBe(true);
    expect(o.fp).toMatch(/^[0-9a-f]{12}$/);
  });
});