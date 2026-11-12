const { AuthService } = require('../services/auth.service');
const { getConn } = require('../utils/db');
const { successResponse } = require('../utils/response');

class AuthController {
  constructor() {
    this.service = new AuthService(getConn());
  }

  async login(req, res, next) {
    try {
      const { username, email, identifier, password } = req.body;
      const id = (identifier || email || username || '').toString().trim().toLowerCase();
      const result = await this.service.login(id, password);
      this.logHierarchyProfileContext('login', result && result.user);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async logout(req, res, next) {
    try {
      await this.service.logout(req.headers.authorization?.split(' ')[1], req.user);
      res.json(successResponse({ message: 'Logged out successfully' }));
    } catch (err) {
      next(err);
    }
  }

  /**
   * SETUP-MODE STATUS (public, unauthenticated). Read-only: mode + userCount.
   * Used by login.js to decide between login and Create-First-User forms.
   * The endpoint was referenced by the frontend but never implemented — a 404
   * on page load disabled the login form via showStoreError().
   */
  setupStatus(req, res) {
    res.json(successResponse(this.service.setupStatus()));
  }

  /**
   * CREATE FIRST USER (public, unauthenticated). 409 if a user already
   * exists. Returns a login-ready session so the operator lands on the
   * dashboard right after setup.
   */
  async createFirstUser(req, res, next) {
    try {
      const b = req.body || {};
      const payload = {
        fullName: b.full_name || b.fullName,
        email: b.email,
        password: b.password,
      };
      await this.service.createFirstUser(payload);
      // Auto-login with the freshly created credentials.
      const result = await this.service.login(payload.email, payload.password);
      res.status(201).json(successResponse(result, 201));
    } catch (err) {
      next(err);
    }
  }

  async getProfile(req, res, next) {
    try {
      const user = await this.service.getProfile(req.user);
      this.logHierarchyProfileContext('profile', user);
      res.json(successResponse(user));
    } catch (err) {
      next(err);
    }
  }

  // Opt-in, non-secret diagnostics for agencyId resolution. Do not dump the
  // full profile: it contains personal fields and must never expose credentials.
  logHierarchyProfileContext(source, user) {
    if (process.env.DEBUG_HIERARCHY_PROFILE !== '1' || !user) return;
    console.info('[auth] hierarchy profile context', {
      source,
      userId: user.id || null,
      hierarchyRole: user.hierarchyRole || null,
      agencyId: user.agencyId || null,
    });
  }

  async updateProfile(req, res, next) {
    try {
      const result = this.service.updateProfile(req.user.userId, req.user.companyId, req.body);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async changePassword(req, res, next) {
    try {
      const { current_password, old_password, new_password } = req.body;
      await this.service.changePassword(req.user.userId, current_password || old_password, new_password, req.user);
      res.json(successResponse({ message: 'Password changed successfully' }));
    } catch (err) {
      next(err);
    }
  }
}

module.exports = { AuthController };
