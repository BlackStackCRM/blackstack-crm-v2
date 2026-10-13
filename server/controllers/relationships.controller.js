const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');

class RelationshipsController {
  constructor() {
    this.conn = getConn();
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req);
      const { relationship_type, status, organization_id, person_a_id } = req.query;

      const where = [];
      const params = [];
      where.push('company_id = ?');
      params.push(req.user.companyId);
      if (relationship_type) { where.push('relationship_type = ?'); params.push(relationship_type); }
      if (status) { where.push('status = ?'); params.push(status); }
      if (organization_id) { where.push('organization_id = ?'); params.push(organization_id); }
      if (person_a_id) { where.push('person_a_id = ?'); params.push(person_a_id); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const items = this.conn.all(
        `SELECT * FROM relationships ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      const total = this.conn.get(`SELECT COUNT(*) as total FROM relationships ${whereSql}`, params).total;

      res.json(paginatedResponse(items, total, page, limit));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const { relationship_type, person_a_id, person_b_id, organization_id, notes, status } = req.body;
      if (!relationship_type) throw new ValidationError('relationship_type is required');
      if (!person_a_id) throw new ValidationError('person_a_id is required');

      const id = req.body.id ? undefined : generateId('rel');
      if (req.body.id) throw new ValidationError('id must not be supplied by the client');
      const now = new Date().toISOString();
      this.conn.run(`
        INSERT INTO relationships (id, company_id, relationship_type, status, person_a_id, person_b_id, organization_id, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, req.user.companyId, relationship_type, status || 'ACTIVE', person_a_id, person_b_id, organization_id, notes || null, now, now]);

      res.status(201).json(successResponse(this.conn.get('SELECT * FROM relationships WHERE id = ? AND company_id = ?', [id, req.user.companyId]), 201));
    } catch (err) { next(err); }
  }

  async remove(req, res, next) {
    try {
      const result = this.conn.run('DELETE FROM relationships WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (result.changes === 0) throw new NotFoundError('Relationship', req.params.id);
      res.json(successResponse({ id: req.params.id, deleted: true }));
    } catch (err) { next(err); }
  }
}

module.exports = { RelationshipsController };