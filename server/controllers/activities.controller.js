const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { ValidationError } = require('../utils/errors');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');

class ActivitiesController {
  constructor() {
    this.conn = getConn();
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req, { limit: 50 });
      const { type, contact_id, organization_id, deal_id, user_id, date_from, date_to } = req.query;

      const where = [];
      const params = [];
      where.push('company_id = ?');
      params.push(req.user.companyId);
      if (type) { where.push('type = ?'); params.push(type); }
      if (contact_id) { where.push('contact_id = ?'); params.push(contact_id); }
      if (organization_id) { where.push('organization_id = ?'); params.push(organization_id); }
      if (deal_id) { where.push('deal_id = ?'); params.push(deal_id); }
      if (user_id) { where.push('user_id = ?'); params.push(user_id); }
      if (date_from) { where.push('created_at >= ?'); params.push(date_from); }
      if (date_to) { where.push('created_at <= ?'); params.push(date_to); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const items = this.conn.all(
        `SELECT * FROM activities ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      const total = this.conn.get(`SELECT COUNT(*) as total FROM activities ${whereSql}`, params).total;
      res.json(paginatedResponse(items, total, page, limit));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const { type, title, description, contact_id, organization_id, deal_id, metadata } = req.body;
      if (!type) throw new ValidationError('type is required');
      if (!title) throw new ValidationError('title is required');

      const id = generateId('act');
      this.conn.run(`
        INSERT INTO activities (id, company_id, type, title, description, contact_id, organization_id, deal_id, user_id, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, req.user.companyId, type, title, description, contact_id, organization_id, deal_id, req.user?.userId, metadata ? JSON.stringify(metadata) : null, new Date().toISOString()]);

      res.status(201).json(successResponse(this.conn.get('SELECT * FROM activities WHERE id = ? AND company_id = ?', [id, req.user.companyId]), 201));
    } catch (err) { next(err); }
  }

  /**
   * Permanently delete an activity.
   *
   * CRM-06. `activities` was mounted at /api/activities but exposed only GET and
   * POST, so a logged activity could never be retracted — while every sibling
   * entity (tasks, notes, appointments, deals, contacts) can be deleted.
   *
   * This is deliberately a plain tenant-scoped DELETE, matching tasks, notes and
   * appointments, and NOT the refuse-when-referenced policy used for contacts,
   * deals and organizations. The reason is measured, not assumed:
   * `activities.id` has ZERO inbound foreign keys, so an activity delete cannot
   * cascade into any other table. There is nothing to protect and nothing to
   * check, so a dependency gate would reject nothing while adding a code path
   * and a second failure mode.
   *
   * The statement is scoped by company_id, so a row owned by another tenant is
   * never touched; that case reports 404 rather than 403, which also avoids
   * confirming the existence of another tenant's record.
   */
  async remove(req, res, next) {
    const { NotFoundError } = require('../utils/errors');
    try {
      const result = this.conn.run(
        'DELETE FROM activities WHERE id = ? AND company_id = ?',
        [req.params.id, req.user.companyId],
      );
      if (result.changes === 0) throw new NotFoundError('Activity', req.params.id);
      res.json(successResponse({ id: req.params.id, deleted: true }));
    } catch (err) { next(err); }
  }
}

module.exports = { ActivitiesController };