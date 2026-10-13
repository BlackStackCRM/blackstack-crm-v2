const { getConn } = require('../utils/db');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');

class AuditController {
  constructor() {
    this.conn = getConn();
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req, { limit: 50, maxLimit: 200 });
      const { entity_type, entity_id, user_id, date_from, date_to, action } = req.query;

      const where = ['company_id = ?'];
      const params = [req.user.companyId];
      if (entity_type) { where.push('entity_type = ?'); params.push(entity_type); }
      if (entity_id) { where.push('entity_id = ?'); params.push(entity_id); }
      if (user_id) { where.push('user_id = ?'); params.push(user_id); }
      if (action) { where.push('action = ?'); params.push(action); }
      if (date_from) { where.push('created_at >= ?'); params.push(date_from); }
      if (date_to) { where.push('created_at <= ?'); params.push(date_to); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const items = this.conn.all(
        `SELECT * FROM audit_logs ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      const total = this.conn.get(`SELECT COUNT(*) as total FROM audit_logs ${whereSql}`, params).total;
      res.json(paginatedResponse(items, total, page, limit));
    } catch (err) { next(err); }
  }

  async entity(req, res, next) {
    try {
      const items = this.conn.all(
        'SELECT * FROM audit_logs WHERE entity_type = ? AND entity_id = ? AND company_id = ? ORDER BY created_at DESC LIMIT 50',
        [req.params.entity_type, req.params.id, req.user.companyId]
      );
      res.json(successResponse(items));
    } catch (err) { next(err); }
  }
}

module.exports = { AuditController };