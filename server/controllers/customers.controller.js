const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');
const { EventHooksService } = require('../services/event-hooks.service');

class CustomersController {
  constructor() {
    this.conn = getConn();
    this.hooks = new EventHooksService();
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req);
      const { search, onboarding_status, retention_status, contact_id } = req.query;
      const where = ['c.company_id = ?'];
      const params = [req.user.companyId];
      if (onboarding_status) { where.push('c.onboarding_status = ?'); params.push(onboarding_status); }
      if (retention_status) { where.push('c.retention_status = ?'); params.push(retention_status); }
      if (contact_id) { where.push('c.contact_id = ?'); params.push(contact_id); }
      if (search) {
        const q = `%${search.toLowerCase()}%`;
        where.push('(LOWER(ct.first_name) LIKE ? OR LOWER(ct.last_name) LIKE ? OR LOWER(ct.email) LIKE ?)');
        params.push(q, q, q);
      }
      const whereSql = where.join(' AND ');
      const sql = `
        SELECT c.*, ct.first_name, ct.last_name, ct.email, ct.phone, ct.organization_id
        FROM customers c
        JOIN contacts ct ON ct.id = c.contact_id
        WHERE ${whereSql}
        ORDER BY c.created_at DESC LIMIT ? OFFSET ?
      `;
      const countSql = `SELECT COUNT(*) as total FROM customers c WHERE ${whereSql}`;
      const total = this.conn.get(countSql, params)?.total || 0;
      const items = this.conn.all(sql, [...params, limit, offset]);
      res.json(paginatedResponse(items, total, page, limit));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      const item = this.conn.get(`
        SELECT c.*, ct.first_name, ct.last_name, ct.email, ct.phone, ct.organization_id
        FROM customers c
        JOIN contacts ct ON ct.id = c.contact_id
        WHERE c.id = ? AND c.company_id = ? LIMIT 1
      `, [req.params.id, req.user.companyId]);
      if (!item) throw new NotFoundError('Customer', req.params.id);
      res.json(successResponse(item));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const { contact_id, onboarding_status, retention_status, account_manager_id, notes } = req.body;
      if (!contact_id) throw new ValidationError('contact_id is required');

      const existing = this.conn.get('SELECT * FROM customers WHERE company_id = ? AND contact_id = ?', [req.user.companyId, contact_id]);
      if (existing) throw new ValidationError('Customer already exists for this contact');

      const id = req.body.id ? undefined : generateId('cust');
      if (req.body.id) throw new ValidationError('id must not be supplied');
      const now = new Date().toISOString();
      this.conn.run(`
        INSERT INTO customers (id, company_id, contact_id, onboarding_status, retention_status, account_manager_id, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, req.user.companyId, contact_id, onboarding_status || 'PENDING', retention_status || 'ACTIVE', account_manager_id || null, notes || null, now, now]);

      this.conn.run('UPDATE contacts SET customer_status = ?, updated_at = ? WHERE id = ? AND company_id = ?', ['ACTIVE', now, contact_id, req.user.companyId]);

      res.status(201).json(successResponse(this.conn.get(`
        SELECT c.*, ct.first_name, ct.last_name, ct.email, ct.phone
        FROM customers c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ? AND c.company_id = ?
      `, [id, req.user.companyId]), 201));
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      const existing = this.conn.get('SELECT * FROM customers WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Customer', req.params.id);

      const allowed = ['onboarding_status', 'retention_status', 'lifetime_value', 'churn_risk', 'account_manager_id', 'notes'];
      const sets = [];
      const params = [];
      for (const f of allowed) {
        if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); }
      }
      if (!sets.length) throw new ValidationError('No fields to update');

      const now = new Date().toISOString();
      this.conn.run(`UPDATE customers SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND company_id = ?`, [...params, now, req.params.id, req.user.companyId]);
      res.json(successResponse(this.conn.get(`
        SELECT c.*, ct.first_name, ct.last_name, ct.email, ct.phone
        FROM customers c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ? AND c.company_id = ?
      `, [req.params.id, req.user.companyId])));
    } catch (err) { next(err); }
  }

  async remove(req, res, next) {
    try {
      const result = this.conn.run('DELETE FROM customers WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (result.changes === 0) throw new NotFoundError('Customer', req.params.id);
      res.json(successResponse({ id: req.params.id, deleted: true }));
    } catch (err) { next(err); }
  }
}

module.exports = { CustomersController };
