/**
 * Trusted server-side Agency Administrator provisioning (Phase 73).
 *
 * The desktop is anon-only and CANNOT call Supabase Auth Admin APIs. When a
 * trusted provisioning endpoint (a Supabase Edge Function) is configured via
 * SUPABASE_PROVISION_URL, the desktop delegates the privileged Auth operation to
 * it, passing the caller's own JWT (never the service role). The endpoint
 * verifies the caller is a Mother Company admin, performs the Auth admin call with
 * the service role (server-side secret), and returns the REAL Auth user id.
 *
 * When SUPABASE_PROVISION_URL is NOT configured, isProvisioningConfigured()
 * returns false and the caller keeps its existing behaviour (no local-only
 * administrator is ever created as a substitute).
 */
const { AppError } = require('../utils/errors');

function isProvisioningConfigured() {
  return Boolean(String(process.env.SUPABASE_PROVISION_URL || '').trim());
}

function endpoint() {
  return String(process.env.SUPABASE_PROVISION_URL || '').trim().replace(/\/+$/, '');
}

async function post(body, callerJwt) {
  const url = endpoint();
  if (!url) throw new AppError('Provisioning is not configured.', 'PROVISION_NOT_CONFIGURED', 503);
  const headers = { 'Content-Type': 'application/json' };
  if (callerJwt) headers.Authorization = callerJwt.startsWith('Bearer ') ? callerJwt : `Bearer ${callerJwt}`;
  const anon = String(process.env.SUPABASE_ANON_KEY || '').trim();
  if (anon) headers.apikey = anon;

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new AppError('Could not reach the provisioning service.', 'PROVISION_UNREACHABLE', 502);
  }
  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const code = (payload && payload.error && payload.error.code) || 'PROVISION_FAILED';
    const message = (payload && payload.error && payload.error.message) || 'Agency administrator provisioning failed.';
    const status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw new AppError(message, code, status);
  }
  return payload || {};
}

/**
 * Create or link the Supabase Auth identity for an agency administrator.
 * Returns { user: { id, email }, created }.
 */
async function provisionAgencyAuthUser({ email, password, agencyId, callerJwt }) {
  return post({ email, password, agencyId }, callerJwt);
}

/**
 * Best-effort rollback of a freshly created Auth identity (no orphaned user).
 */
async function rollbackProvisionedUser({ userId, callerJwt }) {
  if (!userId) return { ok: false };
  try {
    return await post({ action: 'rollback', userId }, callerJwt);
  } catch (e) {
    console.error('[agency-admin-provision] rollback failed:', e && e.message ? e.message : String(e));
    return { ok: false };
  }
}

module.exports = { isProvisioningConfigured, provisionAgencyAuthUser, rollbackProvisionedUser };