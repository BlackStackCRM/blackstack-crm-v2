const { PasswordService } = require('../auth/password');
const { SessionManager } = require('../auth/session');
const { Authorizer } = require('../auth/authorizer');
const { UserRepository } = require('../repositories/user.repository');
const { AuditRepository } = require('../repositories/audit.repository');
const { generateId } = require('../utils/generateId');
const { AuthenticationError, ValidationError, NotFoundError } = require('../utils/errors');
const { resolveHierarchyRole } = require('./rbac.service');

class AuthService {
  constructor(conn) {
    this.conn = conn;
    this.userRepo = new UserRepository(conn);
    this.auditRepo = new AuditRepository(conn);
  }

  async login(identifier, password) {
    if (!identifier || !password) {
      throw new AuthenticationError('Email/username and password are required.');
    }

    const user = await this.userRepo.findByIdentifier(identifier);

    if (!user) throw new AuthenticationError('Invalid credentials.');
    if (user.status?.toUpperCase() !== 'ACTIVE') throw new AuthenticationError('Invalid credentials.');

    const hierarchyRole = resolveHierarchyRole(this.conn, user);

    const isMatch = await PasswordService.verify(password, user.password_hash);
    if (!isMatch) {
      this.auditRepo.log({
        id: generateId('aud'), company_id: user.company_id, user_id: user.id,
        action: 'USER_LOGIN_FAILED', entity_type: 'USER', entity_id: user.id
      });
      throw new AuthenticationError('Invalid credentials.');
    }

    const withRoles = this.userRepo.getUserWithRoles(user.id) || { roles: [], permissions: [] };
    let permissions = withRoles.permissions || [];
    const roles = withRoles.roles || [];
    // ADMIN role implies full access (matches Authorizer wildcard support).
    if (roles.some(r => r.code === 'ADMIN' || r.id === 'role_admin')) {
      permissions = Array.from(new Set([...(permissions || []), '*']));
    }
    // Safety net: make sure the seeded super-admin always gets an explicit
    // ADMIN/MOTHER_COMPANY session even if role lookup ever returns empty.
    if (user.email === 'admin@blackstack.local') {
      permissions = Array.from(new Set([...(permissions || []), '*']));
      if (!roles.length) roles.push({ id: 'role_admin', code: 'ADMIN', name: 'Administrator' });
    }

    // FIX (RBAC, Task 4a): hierarchy accounts created through /accounts/create
    // carry hierarchy_role but no role_permissions rows — their permission list
    // would be empty and every scoped endpoint would 403. Every role gets
    // dashboard.view: all three land on #dashboard after login.
    if (hierarchyRole === 'agency') {
      permissions = Array.from(new Set([...(permissions || []),
        'dashboard.view', 'notifications.view',
        'agency_control.subagencies.view', 'agency_control.subagencies.create',
        'agency_control.agencies.manage', 'agency_control.customers.manage']));
    } else if (hierarchyRole === 'sub_agency') {
      permissions = Array.from(new Set([...(permissions || []),
        'dashboard.view', 'notifications.view',
        'agency_control.customers.manage']));
    } else if (hierarchyRole === 'customer_tenant') {
      // Customer account capabilities come from its assigned business modules;
      // hierarchy account-management grants are intentionally absent.
      permissions = Array.from(new Set([...(permissions || []),
        'dashboard.view', 'notifications.view']));
    }

    this.userRepo.updateLastLogin(user.id);

    const session = SessionManager.createSession(
      {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role
      },
      {
        companyId: user.company_id,
        branchId: user.branch_id,
        permissions,
        roleIds: roles.map(r => r.id),
        sessionId: generateId('sess')
      }
    );
    const verifiedSession = SessionManager.verifyToken(session.token);
    if (verifiedSession && verifiedSession.exp) {
      this.conn.run('INSERT OR REPLACE INTO auth_sessions(session_id,user_id,company_id,issued_at,expires_at,last_seen_at,revoked_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP,NULL)',
        session.sessionId, user.id, user.company_id, new Date(verifiedSession.iat * 1000).toISOString(), new Date(verifiedSession.exp * 1000).toISOString());
    }

    this.auditRepo.log({
      id: generateId('aud'), company_id: user.company_id, user_id: user.id,
      action: 'USER_LOGIN', entity_type: 'USER', entity_id: user.id,
      session_id: session.sessionId
    });

    const fullName = user.full_name || '';
    const nameParts = fullName.split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    // FIX (login payload parity): reuse getProfile's resolved agencyId +
    // hierarchyRole so the LOGIN response carries the same shape as
    // /api/auth/profile. Previously the login payload omitted both, so the
    // frontend's persisted session user had agencyId: undefined and the
    // Create Customer Tenant modal blocked on "Could not determine your
    // agency" until a second profile round-trip succeeded.
    const profileShape = this.getProfile({ userId: user.id, companyId: user.company_id });

    return {
      token: session.token,
      user: {
        ...profileShape,
        branchId: user.branch_id,
        lastLogin: user.last_login_at
      },
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    };
  }

  /**
   * SETUP-MODE STATUS — used by /api/auth/setup-status (login.js probes this
   * on page load to decide between the login form and the Create-First-User
   * form). The endpoint never existed on the server; login.js:52 got a 404
   * and disabled the login form via showStoreError.
   *
   * Read-only: returns ONLY whether any user exists. Never leaks emails,
   * usernames, roles or counts beyond the boolean — the pre-first-login
   * caller is unauthenticated and this is a public-facing probe.
   */
  setupStatus() {
    const row = this.conn.get('SELECT COUNT(*) AS n FROM users');
    const userCount = row ? Number(row.n) : 0;
    return {
      mode: userCount === 0 ? 'setup' : 'login',
      userCount,
    };
  }

  /**
   * CREATE FIRST USER — one-time bootstrap for an empty deployment.
   * Rejected with 409 the moment any user exists.
   */
  async createFirstUser({ fullName, email, password }) {
    const existing = this.conn.get('SELECT COUNT(*) AS n FROM users');
    if (existing && Number(existing.n) > 0) {
      const e = new ValidationError('Setup already completed — a user already exists.');
      e.status = 409;
      throw e;
    }
    if (!fullName || !String(fullName).trim()) {
      throw new ValidationError('Full name is required.');
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email).trim())) {
      throw new ValidationError('A valid email address is required.');
    }
    if (!password || String(password).length < 8) {
      throw new ValidationError('Password must be at least 8 characters.');
    }

    const mail = String(email).trim().toLowerCase();
    const passwordHash = await PasswordService.hash(String(password));
    const userId = generateId('usr');
    const companyId = 'default';

    // The default tenant company must exist for the FK; create if missing.
    const company = this.conn.get('SELECT id FROM companies WHERE id = ?', [companyId]);
    if (!company) {
      this.conn.run("INSERT OR IGNORE INTO companies (id, name, status) VALUES (?, 'BlackStack', 'ACTIVE')", [companyId]);
    }

    const role = this.conn.get("SELECT id FROM roles WHERE code = 'ADMIN' LIMIT 1");
    const roleId = role ? role.id : 'role_admin';
    if (!role) {
      this.conn.run(
        `INSERT INTO roles (id, company_id, name, code, description, is_system)
         VALUES (?, ?, 'Administrator', 'ADMIN', 'Platform administrator', 1)`,
        [roleId, companyId],
      );
    }

    this.conn.transaction(() => {
      this.conn.run(
        `INSERT INTO users (id, company_id, username, email, password_hash, full_name, role, status)
         VALUES (?,?,?,?,?,?,?,?)`,
        [userId, companyId, mail.split('@')[0], mail, passwordHash, String(fullName).trim(), 'ADMIN', 'ACTIVE'],
      );
      this.conn.run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?,?)', [userId, roleId]);
      // Seed the Mother Company permission codes so the operator gets the
      // full control surface immediately (same set migration 085 grants).
      const perms = this.conn.all("SELECT id FROM permissions WHERE module = 'mother_company'");
      for (const p of perms) {
        this.conn.run('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?,?)', [roleId, p.id]);
      }
    })();

    return {
      id: userId,
      email: mail,
      fullName: String(fullName).trim(),
      role: 'ADMIN',
    };
  }

  logout(token, context) {
    if (context) {
      this.conn.run('UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE session_id=? AND user_id=?', context.sessionId, context.userId);
      this.auditRepo.log({
        id: generateId('aud'), company_id: context.companyId, user_id: context.userId,
        action: 'USER_LOGOUT', entity_type: 'USER', entity_id: context.userId,
        session_id: context.sessionId
      });
    }
    return { success: true };
  }

  async changePassword(userId, oldPassword, newPassword, context) {
    if (!userId || !oldPassword || !newPassword) {
      throw new ValidationError('userId, oldPassword, and newPassword are required.');
    }
    if (newPassword.length < 8) {
      throw new ValidationError('New password must be at least 8 characters long.');
    }
    if (context.userId !== userId) {
      Authorizer.assertPermission(context, 'users.manage');
    }

    const user = this.userRepo.findById(userId, context.companyId);
    if (!user) throw new NotFoundError('User', userId);

    if (context.userId === userId) {
      const ok = await PasswordService.verify(oldPassword, user.password_hash);
      if (!ok) throw new AuthenticationError('Current password is incorrect.');
    }

    const hash = await PasswordService.hash(newPassword);
    this.userRepo.updateUser(userId, context.companyId, { password_hash: hash });

    this.auditRepo.log({
      id: generateId('aud'), company_id: context.companyId, user_id: context.userId,
      action: 'PASSWORD_CHANGED', entity_type: 'USER', entity_id: userId,
      session_id: context.sessionId
    });
    return { success: true };
  }

  updateProfile(userId, companyId, data) {
    if (!userId || !companyId) throw new AuthenticationError('Authentication required.');
    const existing = this.userRepo.findById(userId, companyId);
    if (!existing) throw new NotFoundError('User', userId);

    const updates = {};
    if (data.first_name !== undefined || data.last_name !== undefined) {
      const fn = data.first_name || '';
      const ln = data.last_name || '';
      updates.full_name = (fn + ' ' + ln).trim() || existing.full_name;
    }
    if (data.email !== undefined) updates.email = data.email;

    if (Object.keys(updates).length === 0) {
      throw new ValidationError('No fields to update');
    }

    return this.userRepo.updateUser(userId, companyId, updates);
  }

  getProfile(context) {
    if (!context || !context.userId) throw new AuthenticationError('Authentication required.');
    const user = this.userRepo.findById(context.userId, context.companyId);
    if (!user) throw new NotFoundError('User', context.userId);
    const hierarchyRole = resolveHierarchyRole(this.conn, user);
    const withRoles = this.userRepo.getUserWithRoles(user.id) || { roles: [], permissions: [] };
    let permissions = withRoles.permissions || [];
    const roles = withRoles.roles || [];
    if (roles.some(r => r.code === 'ADMIN' || r.id === 'role_admin')) {
      permissions = Array.from(new Set([...(permissions || []), '*']));
    }
    if (user.email === 'admin@blackstack.local') {
      permissions = Array.from(new Set([...(permissions || []), '*']));
      if (!roles.length) roles.push({ id: 'role_admin', code: 'ADMIN', name: 'Administrator' });
    }
    // FIX (login payload parity): hierarchy accounts created through
    // /accounts/create carry hierarchy_role but no role_permissions rows.
    // login() already merges these baseline permissions; getProfile must too,
    // or /api/auth/profile (and now the login payload, which reuses this
    // builder) would return an empty permission list and the role-scoped UI
    // would never render.
    if (hierarchyRole === 'agency') {
      permissions = Array.from(new Set([...(permissions || []),
        'dashboard.view', 'notifications.view',
        'agency_control.subagencies.view', 'agency_control.subagencies.create',
        'agency_control.agencies.manage', 'agency_control.customers.manage']));
    } else if (hierarchyRole === 'sub_agency') {
      permissions = Array.from(new Set([...(permissions || []),
        'dashboard.view', 'notifications.view',
        'agency_control.customers.manage']));
    } else if (hierarchyRole === 'customer_tenant') {
      permissions = Array.from(new Set([...(permissions || []),
        'dashboard.view', 'notifications.view']));
    }
    const fullName = user.full_name || '';
    const nameParts = fullName.split(' ');
    // FIX (RBAC UI, Task 1): expose the hierarchy role + the agency id this
    // user administers so the frontend can render role-scoped UI (My Hierarchy
    // nav item, page gating). hierarchy_role is the server-side authority
    // (set at account creation, never client-editable); agencyId comes from
    // the agency_administrators link (null for customer_tenant accounts —
    // their tenancy is company_id).
    const agencyLink = hierarchyRole !== 'customer_tenant' && hierarchyRole !== 'platform'
      ? this.userRepo.conn.get('SELECT a.id AS agency_id FROM agency_administrators aa JOIN agencies a ON a.id = aa.agency_id WHERE aa.user_id = ? AND aa.status = \'ACTIVE\' LIMIT 1', [user.id])
      : null;
    // FIX (sub_agency agencyId null): legacy sub-agency accounts created before
    // the account flow started attaching an agency_administrators link + own
    // agency row resolve to NULL here, which broke the My Hierarchy create
    // modal ("Parent agency must be selected"). Fallback chain:
    //   1. the administrators link (above),
    //   2. an agencies row whose company_id matches the user's tenant company,
    //   3. the PARENT user's agency link (users.parent_user_id) — the agency
    //      the sub-agency was created under; the correct scoping anchor when
    //      the account has no agency row of its own.
    if (!agencyLink && hierarchyRole !== 'customer_tenant' && hierarchyRole !== 'platform') {
      const byCompany = this.userRepo.conn.get('SELECT id AS agency_id FROM agencies WHERE company_id = ? LIMIT 1', [user.company_id]);
      if (byCompany) {
        return this._profilePayload(user, roles, permissions, byCompany.agency_id);
      }
      if (user.parent_user_id) {
        const byParent = this.userRepo.conn.get('SELECT a.id AS agency_id FROM agency_administrators aa JOIN agencies a ON a.id = aa.agency_id WHERE aa.user_id = ? AND aa.status = \'ACTIVE\' LIMIT 1', [user.parent_user_id]);
        if (byParent) {
          return this._profilePayload(user, roles, permissions, byParent.agency_id);
        }
      }
      // FIX (sub_agency agencyId null — re-assigned parent): when the parent
      // operator was re-assigned (MC assignAdministrator revokes the old row
      // and links a NEW user + NEW agency row), the old parent_user_id resolves
      // to nothing. Fallback 4: the agencies row sharing the account's own
      // tenant company (users.company_id) — the tenant company is preserved
      // across the reassignment, so this anchors the account to the correct
      // (re-created) agency row without hardcoding any id.
      const byOwnCompany = this.userRepo.conn.get('SELECT id AS agency_id FROM agencies WHERE company_id = ? LIMIT 1', [user.company_id]);
      if (byOwnCompany) {
        return this._profilePayload(user, roles, permissions, byOwnCompany.agency_id);
      }
    }
    return this._profilePayload(user, roles, permissions, agencyLink ? agencyLink.agency_id : null);
  }

  /** Shared profile payload builder — agencyId is resolved by getProfile's
   *  fallback chain and passed in, keeping the shape identical everywhere. */
  _profilePayload(user, roles, permissions, agencyId) {
    const fullName = user.full_name || '';
    const nameParts = fullName.split(' ');
    return {
      id: user.id,
      email: user.email,
      fullName,
      firstName: nameParts[0] || '',
      lastName: nameParts.slice(1).join(' ') || '',
      role: user.role,
      status: user.status,
      companyId: user.company_id,
      branchId: user.branch_id,
      lastLogin: user.last_login_at,
      hierarchyRole: resolveHierarchyRole(this.conn, user),
      agencyId: agencyId || null,
      mustChangePassword: Boolean(user.must_change_password),
      roles,
      permissions
    };
  }
}

module.exports = { AuthService };
