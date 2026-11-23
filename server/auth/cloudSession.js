/**
 * CLOUD SESSION TOKEN VERIFICATION (P2, audit §26.2 R5/R8)
 *
 * Verifies a Supabase Auth access JWT WITHOUT accepting a self-minted or
 * cross-project token:
 *   1. Signature  — verified against the project's JWKS (published at
 *      <SUPABASE_URL>/auth/v1/.well-known/jwks.json) using RS256; Supabase
 *      also publishes a symmetric HS256 "legacy" key whose secret equals
 *      the anon JWT secret — that key is used ONLY when jwksKeySecret is
 *      supplied explicitly.
 *   2. Claims     — `iss` must be the project's auth issuer
 *      (<SUPABASE_URL>/auth/v1) and `aud` must be "authenticated".
 *   3. Expiry     — standard exp/nbf checks.
 *
 * NO secret material is shipped or stored here: everything is derived from
 * the runtime configuration (SUPABASE_URL) plus the public JWKS document.
 *
 * Fail-closed: any verification problem returns null. Network failure while
 * fetching JWKS is treated as UNVERIFIED (null) — callers decide policy
 * (authentication middleware MUST fail closed).
 */

const { createRemoteJWKSet, jwtVerify } = (() => {
  try {
    // jose is bundled with @supabase/supabase-js (transitive dep, no new
    // lockfile entry required for verification-only use).
    return require('jose');
  } catch {
    return { createRemoteJWKSet: null, jwtVerify: null };
  }
})();

function authIssuer(supabaseUrl) {
  return String(supabaseUrl || '').replace(/\/+$/, '') + '/auth/v1';
}

function jwksUrl(supabaseUrl) {
  return authIssuer(supabaseUrl) + '/.well-known/jwks.json';
}

/** Shape-check only — never validates a signature. */
function decodeUnsafe(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    return { header, payload };
  } catch {
    return null;
  }
}

/**
 * Verify a Supabase access token.
 * @param {string} token
 * @param {{supabaseUrl:string, jwks?:object}} cfg  runtime config
 * @returns {Promise<{sub:string,email?:string,session_id?:string,role?:string}|null>}
 */
async function verifyCloudAccessToken(token, cfg) {
  if (!createRemoteJWKSet || !jwtVerify) {
    console.warn('[cloud-session] jose unavailable — cloud token verification disabled');
    return null;
  }
  const url = cfg && cfg.supabaseUrl;
  if (!token || !url) return null;

  const expectedIssuer = authIssuer(url);
  // Fast reject before any network: issuer/audience of a foreign project.
  const decoded = decodeUnsafe(token);
  if (!decoded) return null;
  if (decoded.payload.iss !== expectedIssuer || decoded.payload.aud !== 'authenticated') {
    return null;
  }

  try {
    const JWKS = createRemoteJWKSet(new URL(jwksUrl(url)));
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: expectedIssuer,
      audience: 'authenticated',
      algorithms: ['RS256', 'ES256'],
    });
    if (!payload.sub) return null;
    return {
      sub: payload.sub,
      email: payload.email || null,
      session_id: payload.session_id || null,
      role: payload.role || null,
    };
  } catch (e) {
    console.warn('[cloud-session] verification failed:', e && e.message);
    return null;
  }
}

module.exports = {
  verifyCloudAccessToken,
  decodeUnsafe,
  authIssuer,
  jwksUrl,
};
