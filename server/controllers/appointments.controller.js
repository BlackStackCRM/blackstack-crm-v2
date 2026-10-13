const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');
const { EventHooksService } = require('../services/event-hooks.service');
const { assertTenantRefs } = require('../utils/tenantScope');

class AppointmentsController {
  constructor() {
    this.conn = getConn();
    this.hooks = new EventHooksService();
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req);
      const { contact_id, deal_id, lead_id, customer_id, assigned_to, outcome, start_from, start_to } = req.query;
      const where = ['a.company_id = ?'];
      const params = [req.user.companyId];
      if (contact_id) { where.push('a.contact_id = ?'); params.push(contact_id); }
      if (deal_id) { where.push('a.deal_id = ?'); params.push(deal_id); }
      if (lead_id) { where.push('a.lead_id = ?'); params.push(lead_id); }
      if (customer_id) { where.push('a.customer_id = ?'); params.push(customer_id); }
      if (assigned_to) { where.push('a.assigned_to = ?'); params.push(assigned_to); }
      if (outcome) { where.push('a.outcome = ?'); params.push(outcome.toUpperCase()); }
      if (start_from) { where.push('a.start_time >= ?'); params.push(start_from); }
      if (start_to) { where.push('a.start_time <= ?'); params.push(start_to); }
      const whereSql = where.join(' AND ');
      const sql = `
        SELECT a.*, c.first_name, c.last_name, u.full_name as assigned_name
        FROM appointments a
        LEFT JOIN contacts c ON c.id = a.contact_id
        LEFT JOIN users u ON u.id = a.assigned_to
        WHERE ${whereSql}
        ORDER BY a.start_time ASC LIMIT ? OFFSET ?
      `;
      const countSql = `SELECT COUNT(*) as total FROM appointments a WHERE ${whereSql}`;
      const total = this.conn.get(countSql, params)?.total || 0;
      const items = this.conn.all(sql, [...params, limit, offset]);
      res.json(paginatedResponse(items, total, page, limit));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      const item = this.conn.get(`
        SELECT a.*, c.first_name, c.last_name, u.full_name as assigned_name
        FROM appointments a
        LEFT JOIN contacts c ON c.id = a.contact_id
        LEFT JOIN users u ON u.id = a.assigned_to
        WHERE a.id = ? AND a.company_id = ? LIMIT 1
      `, [req.params.id, req.user.companyId]);
      if (!item) throw new NotFoundError('Appointment', req.params.id);
      res.json(successResponse(item));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const { contact_id, organization_id, deal_id, lead_id, customer_id, assigned_to, title, description, start_time, end_time, location, outcome, outcome_notes } = req.body;
      if (!title) throw new ValidationError('Title is required');
      if (!start_time) throw new ValidationError('start_time is required');
      if (!contact_id && !organization_id) throw new ValidationError('contact_id or organization_id is required');
      assertTenantRefs(this.conn, req.user.companyId, { contact_id, organization_id });

      const id = req.body.id ? undefined : generateId('apt');
      if (req.body.id) throw new ValidationError('id must not be supplied');
      const now = new Date().toISOString();
      this.conn.run(`
        INSERT INTO appointments (id, company_id, contact_id, organization_id, deal_id, lead_id, customer_id, assigned_to, title, description, start_time, end_time, location, outcome, outcome_notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, req.user.companyId, contact_id || null, organization_id || null, deal_id || null, lead_id || null, customer_id || null, assigned_to || req.user.userId, title, description || null, start_time, end_time || null, location || null, outcome || null, outcome_notes || null, now, now]);

      const appointment = this.conn.get('SELECT * FROM appointments WHERE id = ? AND company_id = ?', [id, req.user.companyId]);
      this.hooks.onAppointmentCreated(req.user.companyId, id);

      res.status(201).json(successResponse(this.conn.get(`
        SELECT a.*, c.first_name, c.last_name, u.full_name as assigned_name
        FROM appointments a
        LEFT JOIN contacts c ON c.id = a.contact_id
        LEFT JOIN users u ON u.id = a.assigned_to
        WHERE a.id = ? AND a.company_id = ?
      `, [id, req.user.companyId]), 201));
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      const existing = this.conn.get('SELECT * FROM appointments WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Appointment', req.params.id);

      const allowed = ['contact_id', 'organization_id', 'deal_id', 'lead_id', 'customer_id', 'assigned_to', 'title', 'description', 'start_time', 'end_time', 'location', 'outcome', 'outcome_notes'];
      const sets = [];
      const params = [];
      for (const f of allowed) {
        if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); }
      }
      if (!sets.length) throw new ValidationError('No fields to update');

      const now = new Date().toISOString();
      this.conn.run(`UPDATE appointments SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND company_id = ?`, [...params, now, req.params.id, req.user.companyId]);
      res.json(successResponse(this.conn.get(`
        SELECT a.*, c.first_name, c.last_name, u.full_name as assigned_name
        FROM appointments a
        LEFT JOIN contacts c ON c.id = a.contact_id
        LEFT JOIN users u ON u.id = a.assigned_to
        WHERE a.id = ? AND a.company_id = ?
      `, [req.params.id, req.user.companyId])));
    } catch (err) { next(err); }
  }

  async remove(req, res, next) {
    try {
      const result = this.conn.run('DELETE FROM appointments WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (result.changes === 0) throw new NotFoundError('Appointment', req.params.id);
      res.json(successResponse({ id: req.params.id, deleted: true }));
    } catch (err) { next(err); }
  }
}

module.exports = { AppointmentsController };
