const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');
const { assertTenantRefs } = require('../utils/tenantScope');

class NotesController {
  constructor() {
    this.conn = getConn();
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req);
      const { contact_id, organization_id, deal_id, search } = req.query;

      const where = [];
      const params = [];
      where.push('n.company_id = ?');
      params.push(req.user.companyId);
      if (contact_id) { where.push('n.contact_id = ?'); params.push(contact_id); }
      if (organization_id) { where.push('n.organization_id = ?'); params.push(organization_id); }
      if (deal_id) { where.push('n.deal_id = ?'); params.push(deal_id); }
      if (search) { where.push('(n.title LIKE ? OR n.content LIKE ?)'); const s = `%${search}%`; params.push(s, s); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const items = this.conn.all(`
        SELECT n.*,
          c.first_name as related_contact_name, c.last_name as related_contact_last_name,
          o.name as related_organization_name,
          d.title as related_deal_name
        FROM notes n
        LEFT JOIN contacts c ON c.id = n.contact_id
        LEFT JOIN organizations o ON o.id = n.organization_id
        LEFT JOIN deals d ON d.id = n.deal_id
        ${whereSql}
        ORDER BY n.created_at DESC LIMIT ? OFFSET ?
      `, [...params, limit, offset]);
      const total = this.conn.get(`SELECT COUNT(*) as total FROM notes n ${whereSql}`, params).total;
      res.json(paginatedResponse(items, total, page, limit));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      const item = this.conn.get(`
        SELECT n.*,
          c.first_name as related_contact_name, c.last_name as related_contact_last_name,
          o.name as related_organization_name,
          d.title as related_deal_name
        FROM notes n
        LEFT JOIN contacts c ON c.id = n.contact_id
        LEFT JOIN organizations o ON o.id = n.organization_id
        LEFT JOIN deals d ON d.id = n.deal_id
        WHERE n.id = ? AND n.company_id = ? LIMIT 1
      `, [req.params.id, req.user.companyId]);
      if (!item) throw new NotFoundError('Note', req.params.id);
      res.json(successResponse(item));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const { title, content, contact_id, organization_id, deal_id } = req.body;
      if (!title) throw new ValidationError('Title is required');
      if (!contact_id && !organization_id && !deal_id) {
        // Allow notes without relationships (just title + content)
      }
      assertTenantRefs(this.conn, req.user.companyId, { contact_id, organization_id, deal_id });

      const id = req.body.id ? undefined : generateId('note');
      if (req.body.id) throw new ValidationError('id must not be supplied by the client');
      const now = new Date().toISOString();
      this.conn.run(
        `INSERT INTO notes (id, company_id, title, content, contact_id, organization_id, deal_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, req.user.companyId, title, content, contact_id || null, organization_id || null, deal_id || null, now, now]
      );

      res.status(201).json(successResponse(this.conn.get(`
        SELECT n.*,
          c.first_name as related_contact_name, c.last_name as related_contact_last_name,
          o.name as related_organization_name,
          d.title as related_deal_name
        FROM notes n
        LEFT JOIN contacts c ON c.id = n.contact_id
        LEFT JOIN organizations o ON o.id = n.organization_id
        LEFT JOIN deals d ON d.id = n.deal_id
        WHERE n.id = ? AND n.company_id = ?
      `, [id, req.user.companyId]), 201));
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      const existing = this.conn.get('SELECT id FROM notes WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Note', req.params.id);

      const allowed = ['title', 'content', 'contact_id', 'organization_id', 'deal_id'];
      const sets = [];
      const params = [];
      for (const f of allowed) {
        if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); }
      }
      if (!sets.length) throw new ValidationError('No fields to update');

      const now = new Date().toISOString();
      this.conn.run(`UPDATE notes SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND company_id = ?`, [...params, now, req.params.id, req.user.companyId]);
      res.json(successResponse(this.conn.get(`
        SELECT n.*,
          c.first_name as related_contact_name, c.last_name as related_contact_last_name,
          o.name as related_organization_name,
          d.title as related_deal_name
        FROM notes n
        LEFT JOIN contacts c ON c.id = n.contact_id
        LEFT JOIN organizations o ON o.id = n.organization_id
        LEFT JOIN deals d ON d.id = n.deal_id
        WHERE n.id = ? AND n.company_id = ?
      `, [req.params.id, req.user.companyId])));
    } catch (err) { next(err); }
  }

  async remove(req, res, next) {
    try {
      const result = this.conn.run('DELETE FROM notes WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (result.changes === 0) throw new NotFoundError('Note', req.params.id);
      res.json(successResponse({ id: req.params.id, deleted: true }));
    } catch (err) { next(err); }
  }
}

module.exports = { NotesController };
