const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');
const { validateCurrency } = require('../utils/currency');
const { EventHooksService } = require('../services/event-hooks.service');

class LeadsController {
  constructor() {
    this.conn = getConn();
    this.hooks = new EventHooksService();
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req);
      const { search, lead_status, source, contact_id } = req.query;
      const where = ['l.company_id = ?'];
      const params = [req.user.companyId];
      if (lead_status) { where.push('l.lead_status = ?'); params.push(lead_status); }
      if (source) { where.push('l.source = ?'); params.push(source); }
      if (contact_id) { where.push('l.contact_id = ?'); params.push(contact_id); }
      if (search) {
        const q = `%${search.toLowerCase()}%`;
        where.push('(LOWER(c.first_name) LIKE ? OR LOWER(c.last_name) LIKE ? OR LOWER(c.email) LIKE ? OR c.phone LIKE ?)');
        params.push(q, q, q, q);
      }
      const whereSql = where.join(' AND ');
      const sql = `
        SELECT l.*, c.first_name, c.last_name, c.email, c.phone, c.organization_id
        FROM leads l
        JOIN contacts c ON c.id = l.contact_id
        WHERE ${whereSql}
        ORDER BY l.created_at DESC LIMIT ? OFFSET ?
      `;
      const countSql = `SELECT COUNT(*) as total FROM leads l WHERE ${whereSql}`;
      const total = this.conn.get(countSql, params)?.total || 0;
      const items = this.conn.all(sql, [...params, limit, offset]);
      res.json(paginatedResponse(items, total, page, limit));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      const item = this.conn.get(`
        SELECT l.*, c.first_name, c.last_name, c.email, c.phone, c.organization_id
        FROM leads l
        JOIN contacts c ON c.id = l.contact_id
        WHERE l.id = ? AND l.company_id = ? LIMIT 1
      `, [req.params.id, req.user.companyId]);
      if (!item) throw new NotFoundError('Lead', req.params.id);
      res.json(successResponse(item));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const { contact_id, source, lead_status, lead_score, budget, timeline, decision_maker, interest_level, qualification_notes } = req.body;
      if (!contact_id) throw new ValidationError('contact_id is required');

      const contact = this.conn.get('SELECT * FROM contacts WHERE id = ? AND company_id = ?', [contact_id, req.user.companyId]);
      if (!contact) throw new NotFoundError('Contact', contact_id);

      const id = req.body.id ? undefined : generateId('lead');
      if (req.body.id) throw new ValidationError('id must not be supplied');
      const now = new Date().toISOString();
      this.conn.run(`
        INSERT INTO leads (id, company_id, contact_id, source, lead_status, lead_score, budget, timeline, decision_maker, interest_level, qualification_notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, req.user.companyId, contact_id, source || 'manual', lead_status || 'NEW', lead_score || 0, budget || null, timeline || null, decision_maker || null, interest_level || null, qualification_notes || null, now, now]);

      this.conn.run('UPDATE contacts SET lead_status = ?, source = ?, updated_at = ? WHERE id = ? AND company_id = ?',
        [lead_status || 'NEW', source || 'manual', now, contact_id, req.user.companyId]);

      const lead = this.conn.get('SELECT * FROM leads WHERE id = ? AND company_id = ?', [id, req.user.companyId]);
      this.hooks.onLeadCreated(req.user.companyId, { ...lead, first_name: contact.first_name, last_name: contact.last_name, assigned_to: req.user.userId });

      res.status(201).json(successResponse(this.conn.get(`
        SELECT l.*, c.first_name, c.last_name, c.email, c.phone
        FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.id = ?
      `, [id]), 201));
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      const existing = this.conn.get('SELECT * FROM leads WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Lead', req.params.id);

      const allowed = ['source', 'lead_status', 'lead_score', 'budget', 'timeline', 'decision_maker', 'interest_level', 'qualification_notes', 'lost_reason'];
      const sets = [];
      const params = [];
      for (const f of allowed) {
        if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); }
      }
      if (!sets.length) throw new ValidationError('No fields to update');

      const oldStatus = existing.lead_status;
      const now = new Date().toISOString();
      this.conn.run(`UPDATE leads SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND company_id = ?`, [...params, now, req.params.id, req.user.companyId]);

      if (req.body.lead_status && req.body.lead_status !== oldStatus) {
        this.conn.run('UPDATE contacts SET lead_status = ?, updated_at = ? WHERE id = ? AND company_id = ?', [req.body.lead_status, now, existing.contact_id, req.user.companyId]);
        this.hooks.onLeadStatusChanged(req.user.companyId, req.params.id, oldStatus, req.body.lead_status);
      }

      res.json(successResponse(this.conn.get(`
        SELECT l.*, c.first_name, c.last_name, c.email, c.phone
        FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.id = ? AND l.company_id = ?
      `, [req.params.id, req.user.companyId])));
    } catch (err) { next(err); }
  }

  async remove(req, res, next) {
    try {
      const result = this.conn.run('DELETE FROM leads WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (result.changes === 0) throw new NotFoundError('Lead', req.params.id);
      res.json(successResponse({ id: req.params.id, deleted: true }));
    } catch (err) { next(err); }
  }

  async convertToOpportunity(req, res, next) {
    try {
      const lead = this.conn.get('SELECT * FROM leads WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!lead) throw new NotFoundError('Lead', req.params.id);

      const contact = this.conn.get('SELECT * FROM contacts WHERE id = ?', [lead.contact_id]);
      const now = new Date().toISOString();
      const dealId = generateId('deal');
      const defaultStage = this.conn.get('SELECT id FROM pipeline_stages WHERE company_id = ? ORDER BY stage_order ASC LIMIT 1', [req.user.companyId]);
      const currencyRow = this.conn.get('SELECT value FROM system_metadata WHERE key = ?', ['default_currency']);
      const dealCurrency = validateCurrency(req.body.currency || (currencyRow ? currencyRow.value : 'USD'));
      this.conn.run(`
        INSERT INTO deals (id, company_id, title, description, contact_id, organization_id, pipeline_id, stage_id, value, currency, probability, status, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [dealId, req.user.companyId, req.body.title || `${contact.first_name} ${contact.last_name} Opportunity`, req.body.description || null, lead.contact_id, contact.organization_id, req.body.pipeline_id || null, req.body.stage_id || defaultStage?.id || null, req.body.value || 0, dealCurrency, 0, 'OPEN', req.body.notes || null, now, now]);

      this.conn.run('UPDATE leads SET lead_status = ?, converted_at = ?, updated_at = ? WHERE id = ? AND company_id = ?', ['CONVERTED', now, now, req.params.id, req.user.companyId]);
      this.conn.run('UPDATE contacts SET lead_status = ?, customer_status = ?, updated_at = ? WHERE id = ? AND company_id = ?', ['CONVERTED', 'PROSPECT', now, lead.contact_id, req.user.companyId]);

      const deal = this.conn.get('SELECT * FROM deals WHERE id = ? AND company_id = ?', [dealId, req.user.companyId]);
      this.hooks.onDealCreated(req.user.companyId, deal);

      res.status(201).json(successResponse(this.conn.get('SELECT * FROM deals WHERE id = ? AND company_id = ?', [dealId, req.user.companyId]), 201));
    } catch (err) { next(err); }
  }
}

module.exports = { LeadsController };
