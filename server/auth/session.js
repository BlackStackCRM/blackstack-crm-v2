const jwt = require('jsonwebtoken');
const { resolveJwtSecret, isWeakSecret } = require('./jwtSecret');

/**
 * JWT SESSION MANAGEMENT
 *
 * Remediation of audit finding E-01.
 *
 * There is NO hard-coded secret in this file any more. The previous
 * `'dev-only-insecure-secret'` fallback was reachable in the packaged desktop
 * app, because that app sets BLACKSTACK_DESKTOP=1 but never NODE_ENV — so the
 * production guard never fired and every installed copy shared one secret.
 *
 * The secret now comes from ./jwtSecret (operator-supplied, or a per-install
 * random secret persisted outside the database). If it cannot be obtained,
 * require() throws: this is fail-closed by construction.
 */
const _resolved = resolveJwtSecret();

const SECRET = _resolved.secret;
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';

/**
 * Pin the accepted algorithm and bind tokens to this application.
 *
 * Without `algorithms: ['HS256']`, jsonwebtoken honours the token's own `alg`
 * header, which permits classic downgrade attacks (notably `alg: none`).
 * Issuer/audience prevent a token minted for a different deployment of this
 * codebase from being replayed here.
 */
const VERIFY_OPTIONS = {
  algorithms: ['HS256'],
  issuer: 'blackstack-crm',
  audience: 'blackstack-crm-desktop',
};

// Diagnostics only: never the secret itself.
if (_resolved.source !== 'environment') {
  console.log(
    `[auth] Session signing key ${_resolved.source} `
    + `(fingerprint ${_resolved.fingerprint}, ${Buffer.byteLength(SECRET, 'utf8')} bytes). `
    + 'The secret value is never logged.',
  );
}

if (isWeakSecret(SECRET)) {
  // Defence in depth: jwtSecret should never return one of these, but a
  // regression there must not become a silent authentication bypass.
  throw new Error('Refusing to start: the resolved JWT signing secret is a known placeholder value.');
}

class SessionManager {
  /**
   * JWT Strategy A: the token carries authorization claims (userId, role,
   * companyId, permissions). Claims are built ONLY from trusted database
   * state at login time — never from browser-supplied input.
   */
  static createSession(user, context) {
    if (!context.companyId) {
      throw new Error('Cannot create session without company context.');
    }
    const payload = {
      userId: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      companyId: context.companyId,
      permissions: context.permissions || [],
      roleIds: context.roleIds || [],
      sessionId: context.sessionId || require('../utils/generateId').generateId('sess'),
    };

    const token = jwt.sign(payload, SECRET, {
      expiresIn: JWT_EXPIRY,
      algorithm: 'HS256',
      issuer: VERIFY_OPTIONS.issuer,
      audience: VERIFY_OPTIONS.audience,
    });
    return { token, ...payload };
  }

  /**
   * Verify a token. Returns null on ANY problem — expired, wrong signature,
   * unexpected algorithm, foreign issuer/audience, or malformed.
   */
  static verifyToken(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    try {
      return jwt.verify(token, SECRET, VERIFY_OPTIONS);
    } catch {
      return null;
    }
  }

  /** Non-reversible identifier of the signing key, for diagnostics only. */
  static signingKeyFingerprint() {
    return _resolved.fingerprint;
  }
}

module.exports = { SessionManager };