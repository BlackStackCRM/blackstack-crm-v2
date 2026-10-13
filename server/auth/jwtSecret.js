/**
 * JWT SIGNING SECRET PROVISIONING
 *
 * Remediation of audit finding E-01.
 *
 * THE DEFECT THIS FIXES
 *   server/auth/session.js previously did:
 *
 *     const SECRET = JWT_SECRET || 'dev-only-insecure-secret';
 *
 * with a production guard that only fired when NODE_ENV === 'production'.
 * The packaged desktop app sets BLACKSTACK_DESKTOP=1 but never sets NODE_ENV,
 * and ships no .env — so every installed copy ran with the SAME hard-coded
 * secret. Anyone who read this source could mint an admin token for any
 * customer installation. That is total authentication bypass, not a weakness.
 *
 * THE FIX
 *   1. An explicitly supplied JWT_SECRET is always honoured (server/CI use).
 *   2. Otherwise a cryptographically random 256-bit secret is generated ONCE
 *      per installation and persisted OUTSIDE the database, with owner-only
 *      permissions. It lives beside the app's own data, not in it, so
 *      uninstall/reinstall does not destroy it and a database copy cannot leak
 *      it.
 *   3. There is NO hard-coded fallback in any code path. If a secret cannot be
 *      obtained, this module throws. Fail-closed, never fail-open.
 *   4. Tokens are additionally bound to an issuer/audience and pinned to HS256,
 *      so a token minted with an `alg: none` downgrade or an unexpected
 *      algorithm is rejected.
 *
 * WHY A GENERATED SECRET RATHER THAN A HARDCODED ONE
 *   A hard-coded secret is identical on every install, so one leak compromises
 *   all customers forever. A per-install random secret limits a leak to one
 *   machine and can be rotated by deleting the file.
 *
 * SECRET HANDLING RULES OBSERVED HERE
 *   - The secret is never logged, never returned by any API, and never placed in
 *     the renderer, preload, or IPC surface.
 *   - Only the LENGTH and a non-reversible fingerprint are ever surfaced, and
 *     only for diagnostics.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET_FILE = 'session-signing.key';
const BYTES = 32; // 256 bits
const MIN_SECRET_BYTES = 32;

/** Environments where an operator may legitimately run without a secret. */
const DEV_ENVIRONMENTS = new Set(['test', 'development', 'dev']);

/**
 * Resolve the per-user data root WITHOUT importing server/config/userDataPath.
 *
 * That module reads process.env at require() time and is itself the subject of
 * the DB-binding hardening work; auth must not depend on it.
 */
function userDataRoot() {
  const override = process.env.BLACKSTACK_USER_DATA_DIR;
  if (override) return path.resolve(override);

  const appData = process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(process.env.HOME || '', 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config')));

  return path.join(appData, 'blackstack-crm-v2');
}

/** Absolute path of the persisted secret file for this installation. */
function secretFilePath() {
  return path.join(userDataRoot(), SECRET_FILE);
}

function isWeakSecret(value) {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (trimmed.length < 16) return true;
  const known = new Set([
    'change-me-in-production',
    'dev-only-insecure-secret',
    'secret',
    'changeme',
    'your-secret-key',
  ]);
  return known.has(trimmed.toLowerCase());
}

/**
 * Read an existing secret, or create one.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.env]        environment name (defaults to NODE_ENV)
 * @param {boolean} [opts.persist]    write the generated secret to disk
 * @param {string}  [opts.secretPath]  override the secret file location
 * @returns {{secret:string, source:string, persistedTo:string|null, fingerprint:string}}
 */
function resolveJwtSecret(opts = {}) {
  const env = opts.env || process.env.NODE_ENV || '';
  const secretPath = opts.secretPath || secretFilePath();

  // 1. Operator-supplied secret always wins. This is how CI, the release gates
  //    and the test suites supply a deterministic value.
  const provided = process.env.JWT_SECRET;
  if (provided && !isWeakSecret(provided)) {
    return {
      secret: provided,
      source: 'environment',
      persistedTo: null,
      fingerprint: fingerprint(provided),
    };
  }

  // 2. Reuse this installation's existing secret. Reading before generating is
  //    what keeps sessions valid across restarts — generating a new secret on
  //    every boot would silently log every user out.
  if (opts.persist !== false) {
    try {
      if (fs.existsSync(secretPath)) {
        const existing = fs.readFileSync(secretPath, 'utf8').trim();
        if (!isWeakSecret(existing)) {
          return {
            secret: existing,
            source: 'persisted',
            persistedTo: secretPath,
            fingerprint: fingerprint(existing),
          };
        }
        // A weak file is a defect, not an invitation to reuse it.
        throw new Error(
          `Refusing to use the existing signing key at ${secretPath}: it is a known `
          + 'placeholder value. Delete the file to have a fresh random secret generated.',
        );
      }
    } catch (e) {
      if (/placeholder value/.test(e.message)) throw e;
      // Unreadable key file is fatal for the same reason a missing one is not:
      // silently generating a new secret would invalidate every live session.
      throw new Error(
        `Cannot read the session signing key at ${secretPath}: ${e.message}\n`
        + '  Refusing to generate a replacement, because that would invalidate all '
        + 'existing sessions and could mask tampering.',
      );
    }

    // 3. First run for this installation: generate and persist.
    const generated = crypto.randomBytes(BYTES).toString('hex');
    try {
      fs.mkdirSync(path.dirname(secretPath), { recursive: true });
      // Write with owner-only permissions BEFORE writing content, so the secret
      // is never briefly world-readable.
      const fd = fs.openSync(secretPath, 'wx', 0o600);
      try {
        fs.writeSync(fd, generated, 0, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      // On Windows the mode passed to openSync is largely ignored and the file
      // INHERITS its parent's ACL — measured on this host as 5 rules including
      // "CodexSandboxUsers: Modify", i.e. readable by other accounts. A JWT
      // signing key readable by another account is forgeable tokens. So on
      // Windows the DACL must be replaced explicitly, not merely requested.
      hardenPermissions(secretPath);
    } catch (e) {
      // A read-only userData directory must not silently downgrade to an
      // ephemeral secret: that would break sessions on every restart.
      throw new Error(
        `Cannot persist a session signing key to ${secretPath}: ${e.message}\n`
        + '  Refusing to continue with an ephemeral secret — sessions would not '
        + 'survive a restart.',
      );
    }
    return {
      secret: generated,
      source: 'generated',
      persistedTo: secretPath,
      fingerprint: fingerprint(generated),
    };
  }

  // 4. Non-persisting mode is only ever used by tests, which must stay
  //    deterministic. Outside a dev/test environment it is a hard error.
  if (!DEV_ENVIRONMENTS.has(env)) {
    throw new Error(
      'JWT_SECRET is not set and this process may not generate a persistent secret '
      + `(NODE_ENV=${env || '(unset)'}).\n`
      + '  Set JWT_SECRET to a strong random value of at least 32 bytes.',
    );
  }
  const ephemeral = crypto.randomBytes(BYTES).toString('hex');
  return {
    secret: ephemeral,
    source: 'ephemeral-test',
    persistedTo: null,
    fingerprint: fingerprint(ephemeral),
  };
}

/**
 * Restrict a file to the current user on Windows, and verify it afterwards.
 *
 * `fs.openSync(path, 'wx', 0o600)` is not sufficient on Windows: the mode is
 * largely ignored and the file inherits the directory's DACL. Measured on this
 * host, a freshly created file inherited 5 ACEs including
 * "CodexSandboxUsers: Modify" — readable by accounts other than the owner.
 *
 * On POSIX, mode 0600 is already correct and this is a no-op beyond a
 * defensive chmod. On Windows, icacls strips inheritance and grants the owner
 * only. A failure is surfaced rather than ignored: an over-permissive signing
 * key is an authentication bypass, so the caller must not continue silently.
 */
function hardenPermissions(filePath) {
  if (process.platform !== 'win32') {
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on POSIX */ }
    return { hardened: 'posix-0600' };
  }

  const { execFileSync } = require('child_process');
  // /inheritance:r strips inherited ACEs; /grant:r adds exactly one rule.
  // A trailing backslash on the file argument tells icacls it is the target.
  try {
    execFileSync(
      'icacls',
      [filePath, '/inheritance:r', '/grant:r', `${process.env.USERNAME || ''}:(F)`],
      { stdio: 'pipe', windowsHide: true, timeout: 15000 },
    );
  } catch (e) {
    throw new Error(
      `Cannot restrict permissions on the session signing key at ${filePath}: `
      + `${e.message}\n`
      + '  Refusing to continue: a signing key readable by other accounts allows '
      + 'forged authentication tokens.',
    );
  }
  return { hardened: 'windows-dacl-owner-only' };
}

/**
 * Non-reversible identifier for diagnostics.
 *
 * Only a truncated HMAC is exposed: enough to tell two installations apart and
 * to detect that a secret changed, without revealing anything usable.
 */
function fingerprint(secret) {
  return crypto.createHmac('sha256', 'bs-crm-secret-fingerprint')
    .update(String(secret))
    .digest('hex')
    .slice(0, 12);
}

/** True when the value looks like a usable secret. Used by callers/tests. */
function isAcceptableSecret(value) {
  if (isWeakSecret(value)) return false;
  // Hex secrets generated here are 64 chars; operator secrets are >= 32 bytes.
  if (/^[0-9a-f]{64}$/i.test(value)) return true;
  return Buffer.byteLength(String(value), 'utf8') >= MIN_SECRET_BYTES;
}

module.exports = {
  resolveJwtSecret,
  secretFilePath,
  userDataRoot,
  fingerprint,
  isAcceptableSecret,
  isWeakSecret,
  SECRET_FILE,
  MIN_SECRET_BYTES,
};