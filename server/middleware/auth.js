const { SessionManager } = require('../auth/session');
const { AuthenticationError } = require('../utils/errors');
const { getConn } = require('../utils/db');
const { UserRepository } = require('../repositories/user.repository');
const { resolveHierarchyRole } = require('../services/rbac.service');

// Permissions embedded in a JWT can become stale after an administrator
// changes a role's grants. Rebuild the effective permissions from current
// database state on every authenticated request so grant and revoke changes
// take effect immediately without requiring users to sign out.
function refreshSessionAuthorization(session, db = getConn()) {
  const user = db.get(
    'SELECT id, email, role, hierarchy_role FROM users WHERE id=?',
    [session.userId],
  );
  if (!user) throw new AuthenticationError('User account no longer exists');

  const { roles = [], permissions: rolePermissions = [] } = new UserRepository(db).getUserWithRoles(session.userId) || {};
  const permissions = [...rolePermissions];
  if (roles.some((role) => role.code === 'ADMIN' || role.id === 'role_admin')
    || user.email === 'admin@blackstack.local') {
    permissions.push('*');
  }

  const hierarchyRole = resolveHierarchyRole(db, user);
  if (hierarchyRole === 'agency') {
    permissions.push(
      'dashboard.view', 'notifications.view',
      'agency_control.subagencies.view', 'agency_control.subagencies.create',
      'agency_control.agencies.manage', 'agency_control.customers.manage',
    );
  } else if (hierarchyRole === 'sub_agency') {
    permissions.push('dashboard.view', 'notifications.view', 'agency_control.customers.manage');
  } else if (hierarchyRole === 'customer_tenant') {
    permissions.push('dashboard.view', 'notifications.view');
  }

  session.role = user.role;
  session.roleIds = roles.map((role) => role.id);
  session.hierarchyRole = hierarchyRole;
  session.permissions = Array.from(new Set(permissions));
  return session;
}

// Mother Company authorization is intentionally based on explicit named grants,
// never the tenant-wide '*' wildcard. Refresh just those named grants from the
// current role assignments on each request so adding or revoking the designated
// control-plane role takes effect without trusting stale JWT permission claims.
function refreshMotherCompanyPermissions(session, db = getConn()) {
  const current = new UserRepository(db).getUserWithRoles(session.userId);
  const dbPermissions = (current.permissions || []).filter((code) => (
    typeof code === 'string' && code.startsWith('mother_company.')
  ));
  const tokenPermissions = Array.isArray(session.permissions) ? session.permissions : [];
  session.permissions = [
    ...tokenPermissions.filter((code) => typeof code === 'string' && !code.startsWith('mother_company.')),
    ...dbPermissions,
  ];
  return session;
}

// Verify the identity in the token still exists, is active, and the tenant
// context is still valid. Never trust token claims about account state alone.
function assertUserStillValid(session) {
  const db = getConn();
  const user = db.get(
    `SELECT u.id, u.company_id, u.status, c.status as company_status
     FROM users u LEFT JOIN companies c ON c.id = u.company_id
     WHERE u.id = ?`,
    [session.userId]
  );
  if (!user) throw new AuthenticationError('User account no longer exists');
  // Status is stored as 'ACTIVE'/'INACTIVE' (uppercase) in the schema and seeds,
  // so compare case-insensitively instead of hard-coding one casing.
  if (String(user.status).toLowerCase() !== 'active') throw new AuthenticationError('User account is not active');
  if (user.company_status && String(user.company_status).toLowerCase() !== 'active') {
    throw new AuthenticationError('Company account is not active');
  }
  // Tenant claim in the token must match the DB record (guards against
  // stale tokens issued before a user was moved between companies).
  if (session.companyId && user.company_id !== session.companyId) {
    throw new AuthenticationError('Session company context is no longer valid');
  }
}

/**
 * P2.5 SESSION CUTOVER (audit §26.2 / §28.3) — feature-gated enforcement.
 *
 * Enabled ONLY by an explicit operator flag: BLACKSTACK_REQUIRE_CLOUD_TOKEN=1.
 * That flag is set in a packaged build's runtime env AFTER the owner has
 * applied Migration 096 and live E2E has validated real cloud tokens —
 * enforcing JWKS verification before that would break login on every
 * customer device (fail-closed = all sessions rejected).
 *
 * When ENABLED:
 *   - The Bearer token MUST be a verifiable SUPABASE ACCESS TOKEN
 *     (RS256 signature against the project JWKS, iss/aud pinned).
 *   - Local HS256 SessionManager tokens are REJECTED — the old self-minted
 *     session can no longer bypass cloud authentication.
 *   - JWKS unreachable -> verification fails -> 401 (fail-closed).
 * When DISABLED (default, pre-096): behaviour is EXACTLY the legacy local
 * session flow — zero change for existing installs.
 */
function cloudTokenEnforcementEnabled() {
  return process.env.BLACKSTACK_REQUIRE_CLOUD_TOKEN === '1'
    || process.env.BLACKSTACK_REQUIRE_CLOUD_TOKEN === 'true';
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AuthenticationError('Missing or invalid authorization header');
  }

  const token = authHeader.split(' ')[1];

  // P2.5 cloud enforcement branch (only when the operator flag is set).
  if (cloudTokenEnforcementEnabled()) {
    const { verifyCloudAccessToken, isConfigured } = require('../auth/cloudSession.js');
    const { getSupabaseUrl } = require('../config/supabase');
    const cloudSession = await verifyCloudAccessToken(token, { supabaseUrl: getSupabaseUrl() });
    if (!cloudSession) {
      // Covers: expired, invalid signature, wrong issuer/audience, malformed,
      // AND JWKS-unreachable (fail-closed).
      throw new AuthenticationError('Cloud session verification failed');
    }
    // Identity is the cloud UUID; the local mirror row MUST exist (P1 mapping).
    const db = getConn();
    const mirror = db.get('SELECT id, company_id, status FROM users WHERE supabase_user_id = ? LIMIT 1', [cloudSession.sub]);
    if (!mirror) throw new AuthenticationError('No local account linked to this cloud identity');
    const session = {
      userId: mirror.id,
      email: cloudSession.email || null,
      companyId: mirror.company_id,
      cloudSessionId: cloudSession.session_id || null,
      sessionId: null,
    };
    assertUserStillValid(session);
    refreshSessionAuthorization(session);
    req.user = session;
    return next();
  }

  // Legacy local-session flow (pre-cutover default).
  const session = SessionManager.verifyToken(token);

  if (!session) {
    throw new AuthenticationError('Invalid or expired token');
  }

  assertUserStillValid(session);
  if (session.sessionId) {
    const tracked = getConn().get('SELECT revoked_at FROM auth_sessions WHERE session_id=?', [session.sessionId]);
    if (tracked && tracked.revoked_at) throw new AuthenticationError('Session has been revoked');
  }
  refreshSessionAuthorization(session);

  req.user = session;
  next();
}

module.exports = { authMiddleware, refreshMotherCompanyPermissions, refreshSessionAuthorization };
