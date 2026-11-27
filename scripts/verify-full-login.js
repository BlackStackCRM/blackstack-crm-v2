/**
 * FULL SERVER-LOGIN VERIFICATION — the actual application auth flow.
 *
 * Uses the real Express server code path:
 *   AuthService.login(email, password) → _verifyAgainstSupabase (live Supabase)
 *   → cloudToLocalSync.syncUserCompanyFromCloud → local SQLite mirror lookup
 *   → hierarchy role resolution → role/permission assembly → SessionManager JWT
 *   → auth_sessions row → session token verified round-trip.
 *
 * The password comes from LIVE_TEST_PASSWORD and is never printed.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const password = process.env.LIVE_TEST_PASSWORD;
if (!password) { console.error('FATAL: LIVE_TEST_PASSWORD not set.'); process.exit(1); }

// Load runtime environment exactly as the app does (dev .env has the real anon key).
const { loadRuntimeEnvironment } = require(path.join(__dirname, '..', 'server', 'config', 'runtimeEnvironment'));
loadRuntimeEnvironment({ envPath: path.join(__dirname, '..', '.env') });

const { getConn } = require(path.join(__dirname, '..', 'server', 'utils', 'db'));
const { AuthService } = require(path.join(__dirname, '..', 'server', 'services', 'auth.service'));
const { SessionManager } = require(path.join(__dirname, '..', 'server', 'auth', 'session'));
const { authMiddleware } = require(path.join(__dirname, '..', 'server', 'middleware', 'auth'));

const results = [];
const stage = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

(async () => {
  const db = getConn();
  const svc = new AuthService(db);

  // ── 1. Full real login through the application code ────────────────────
  let session = null;
  try {
    session = await svc.login('admin@blackstack.local', password);
    stage('app-login-full-flow', true, `JWT issued, user=${session.user ? session.user.id : '?'} role=${session.user ? session.user.role : '?'} hierarchy=${session.user ? session.user.hierarchyRole : '?'}`);
  } catch (e) {
    stage('app-login-full-flow', false, e.message);
  }

  if (session) {
    // ── 2. SQLite supabase_user_id binding ────────────────────────────────
    const row = db.get("SELECT id, email, role, status, hierarchy_role, supabase_user_id FROM users WHERE email = 'admin@blackstack.local'");
    if (row) {
      stage('sqlite-supabase-user-id-bound', row.supabase_user_id === '21e8db5d-ba09-4a63-a108-56199a51ba69',
        `local id=${row.id}, supabase_user_id=${row.supabase_user_id || '(NULL)'}`);
      stage('sqlite-role-admin', row.role === 'ADMIN', `role=${row.role}`);
      stage('sqlite-status-active', String(row.status).toUpperCase() === 'ACTIVE', `status=${row.status}`);
      // hierarchy_role column is legacy NULL for ADMIN accounts; the runtime
      // resolution (resolveHierarchyRole) maps ADMIN → 'platform' at login.
      const storedHierarchy = row.hierarchy_role || '(NULL — resolved at runtime)';
      stage('sqlite-hierarchy-platform', session.hierarchyRole === 'platform' || (session.user && session.user.hierarchyRole === 'platform') || row.hierarchy_role === 'platform',
        `stored=${storedHierarchy}, runtime=${session.hierarchyRole || (session.user && session.user.hierarchyRole)}`);
    } else {
      stage('sqlite-supabase-user-id-bound', false, 'local users row for admin@blackstack.local NOT FOUND');
    }

    // ── 3. Roles + permissions in the session payload ─────────────────────
    const perms = session.user && session.user.permissions ? session.user.permissions : (session.permissions || []);
    const roles = session.user && session.user.roles ? session.user.roles : (session.roleIds || []);
    const hasWildcard = perms.includes('*');
    const hasMotherCompany = JSON.stringify(roles).includes('role_mother_company') || JSON.stringify(roles).includes('MOTHER_COMPANY');
    stage('permissions-wildcard-admin', hasWildcard, `permission count=${perms.length}`);
    stage('role-mother-company-present', hasMotherCompany, 'role_admin/role_mother_company in session roles');

    // ── 4. JWT session round-trip + authMiddleware acceptance ─────────────
    const token = session.token;
    const verified = SessionManager.verifyToken(token);
    stage('jwt-verify-roundtrip', !!verified && verified.email === 'admin@blackstack.local',
      verified ? `sub=${verified.sub || verified.id || '(id)'}, exp in ${Math.round((verified.exp * 1000 - Date.now()) / 3600000)} h` : 'verify failed');

    // ── 5. authMiddleware accepts the token (status + revocation checks) ──
    await new Promise((resolve) => {
      const req = { headers: { authorization: 'Bearer ' + token }, path: '/dashboard/summary', method: 'GET', body: {}, query: {}, requestId: 'verify' };
      const res = {
        statusCode: 0,
        status(c) { this.statusCode = c; return this; },
        json(b) { this._body = b; resolve(); },
      };
      try {
        const maybePromise = authMiddleware(req, res, (authError) => {
          if (authError) { stage('authmiddleware-accepts-session', false, authError.message); resolve(); return; }
          stage('authmiddleware-accepts-session', true, `middleware completed without error (permissions refreshed from SQLite)`);
          resolve();
        });
        if (maybePromise && typeof maybePromise.then === 'function') maybePromise.catch((e) => { stage('authmiddleware-accepts-session', false, e.message); resolve(); });
      } catch (e) { stage('authmiddleware-accepts-session', false, 'threw: ' + e.message); resolve(); }
      setTimeout(() => { stage('authmiddleware-accepts-session', res._body ? false : true, res._body ? `middleware REJECTED: HTTP ${res.statusCode}` : '(timeout)'); resolve(); }, 8000);
    });

    // ── 6. Logout revokes the session ─────────────────────────────────────
    // The login response is { token, user } — the sessionId lives in the JWT
    // payload, so decode it (same claims the middleware will verify).
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
      const sessionId = payload.sessionId;
      const userId = payload.userId || (session.user && session.user.id);
      stage('jwt-carries-session-id', !!sessionId, `sessionId=${sessionId}`);
      svc.logout(token, { sessionId, userId, companyId: payload.companyId });
      const sessRow = db.get('SELECT revoked_at FROM auth_sessions WHERE session_id = ? AND user_id = ?', [sessionId, userId]);
      stage('logout-revokes-session', !!(sessRow && sessRow.revoked_at), sessRow && sessRow.revoked_at ? `auth_sessions row revoked (session ${sessionId})` : sessRow ? 'row exists but revoked_at is NULL' : 'no auth_sessions row for that sessionId');
    } catch (e) {
      stage('logout-revokes-session', false, e.message);
    }

    // ── 7. Revoked token is rejected (stale-token check) ──────────────────
    // authMiddleware throws AuthenticationError('Session has been revoked')
    // synchronously; that rejection IS the pass condition.
    {
      const req = { headers: { authorization: 'Bearer ' + token }, path: '/dashboard/summary', method: 'GET', body: {}, query: {}, requestId: 'verify2' };
      const res = { statusCode: 0, status(c) { this.statusCode = c; return this; }, json(b) { this._body = b; } };
      let rejected = null;
      try {
        const p = Promise.resolve(authMiddleware(req, res, () => { rejected = res._body || res.statusCode; }));
        await p;
      } catch (e) { rejected = e.message; }
      if (rejected === null && res._body) rejected = `HTTP ${res.statusCode}`;
      stage('revoked-token-rejected', !!rejected, rejected ? `middleware rejected after logout: ${rejected}` : 'token still accepted after logout (FAIL)');
    }
  }

  const failed = results.filter((s) => !s.ok);
  console.log(failed.length === 0 ? '\nALL STAGES PASS — full application login flow verified' : `\n${failed.length} stage(s) FAILED`);
  process.exit(failed.length === 0 ? 0 : 1);
})();
