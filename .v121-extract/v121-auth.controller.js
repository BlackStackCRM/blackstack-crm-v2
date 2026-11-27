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

  async getProfile(req, res, next) {
    try {
      const user = await this.service.getProfile(req.user);
      res.json(successResponse(user));
    } catch (err) {
      next(err);
    }
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