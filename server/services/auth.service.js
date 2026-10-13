const { PasswordService } = require('../auth/password');
const { SessionManager } = require('../auth/session');
const { Authorizer } = require('../auth/authorizer');
const { UserRepository } = require('../repositories/user.repository');
const { AuditRepository } = require('../repositories/audit.repository');
const { generateId } = require('../utils/generateId');
const { AuthenticationError, ValidationError, NotFoundError } = require('../utils/errors');

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
      permissions = ['*'];
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

    this.auditRepo.log({
      id: generateId('aud'), company_id: user.company_id, user_id: user.id,
      action: 'USER_LOGIN', entity_type: 'USER', entity_id: user.id,
      session_id: session.sessionId
    });

    const fullName = user.full_name || '';
    const nameParts = fullName.split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    return {
      token: session.token,
      user: {
        id: user.id,
        email: user.email,
        fullName,
        firstName,
        lastName,
        role: user.role,
        companyId: user.company_id,
        branchId: user.branch_id,
        lastLogin: user.last_login_at,
        roles,
        permissions
      },
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    };
  }

  logout(token, context) {
    if (context) {
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
    const withRoles = this.userRepo.getUserWithRoles(user.id) || { roles: [], permissions: [] };
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
      roles: withRoles.roles || [],
      permissions: withRoles.permissions || []
    };
  }
}

module.exports = { AuthService };