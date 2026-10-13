const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { PasswordService } = require('../auth/password');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');

class UsersController {
  constructor() {
    this.conn = getConn();
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req);
      const { search, status, role } = req.query;

      const where = [];
      const params = [];
      where.push('company_id = ?');
      params.push(req.user.companyId);
      if (search) { where.push('(email LIKE ? OR full_name LIKE ?)'); const s = `%${search}%`; params.push(s, s); }
      if (status) { where.push('status = ?'); params.push(status); }
      if (role) { where.push('role = ?'); params.push(role); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const items = this.conn.all(
        `SELECT id, email, full_name, role, status, last_login_at, created_at, updated_at FROM users ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      const total = this.conn.get(`SELECT COUNT(*) as total FROM users ${whereSql}`, params).total;
      res.json(paginatedResponse(items, total, page, limit));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      const item = this.conn.get('SELECT id, email, full_name, role, status, last_login_at, created_at, updated_at FROM users WHERE id = ? AND company_id = ? LIMIT 1', [req.params.id, req.user.companyId]);
      if (!item) throw new NotFoundError('User', req.params.id);
      res.json(successResponse(item));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const { email, password, full_name, role, status } = req.body;
      if (!email) throw new ValidationError('Email is required');
      if (!password || password.length < 8) throw new ValidationError('Password must be at least 8 characters');
      if (!full_name) throw new ValidationError('Full name is required');

      const existing = this.conn.get('SELECT id FROM users WHERE email = ? AND company_id = ?', [email.toLowerCase(), req.user.companyId]);
      if (existing) throw new ValidationError('Email already in use');

      const id = req.body.id ? undefined : generateId('usr');
      if (req.body.id) throw new ValidationError('id must not be supplied by the client');
      const hash = await PasswordService.hash(password);
      const now = new Date().toISOString();
      this.conn.run(`
        INSERT INTO users (id, company_id, email, password_hash, full_name, role, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, req.user.companyId, email.toLowerCase(), hash, full_name, role || 'USER', status || 'ACTIVE', now, now]);

      res.status(201).json(successResponse(this.conn.get('SELECT id, email, full_name, role, status, created_at FROM users WHERE id = ? AND company_id = ?', [id, req.user.companyId]), 201));
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      const existing = this.conn.get('SELECT id FROM users WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('User', req.params.id);

      const allowed = ['full_name', 'role', 'status', 'email'];
      const sets = [];
      const params = [];
      for (const f of allowed) {
        if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(f === 'email' ? req.body[f].toLowerCase() : req.body[f]); }
      }
      if (req.body.password) {
        if (req.body.password.length < 8) throw new ValidationError('Password must be at least 8 characters');
        sets.push('password_hash = ?');
        params.push(await PasswordService.hash(req.body.password));
      }
      if (!sets.length) throw new ValidationError('No fields to update');

      sets.push('updated_at = ?'); params.push(new Date().toISOString());
      params.push(req.params.id, req.user.companyId);
      this.conn.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND company_id = ?`, params);
      res.json(successResponse(this.conn.get('SELECT id, email, full_name, role, status, last_login_at, created_at, updated_at FROM users WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId])));
    } catch (err) { next(err); }
  }

  async remove(req, res, next) {
    try {
      const existing = this.conn.get('SELECT id FROM users WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('User', req.params.id);
      const now = new Date().toISOString();
      this.conn.run(`UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND company_id = ?`, ['INACTIVE', now, req.params.id, req.user.companyId]);
      res.json(successResponse({ id: req.params.id, deactivated: true }));
    } catch (err) { next(err); }
  }
}

module.exports = { UsersController };