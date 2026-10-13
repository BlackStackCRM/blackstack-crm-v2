const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');
const { EventHooksService } = require('../services/event-hooks.service');
const { assertTenantRefs } = require('../utils/tenantScope');

class TasksController {
  /**
   * CRM-03 — the recognised task lifecycle.
   *
   * Taken from what the codebase already uses (`TODO` is the schema default and
   * the only value the controller previously wrote; `COMPLETED` is what
   * dashboards and reports aggregate on; `IN_PROGRESS` / `CANCELLED` are the
   * remaining conventional values used elsewhere in the app). `tasks.status` has
   * no CHECK constraint, so this list is the only thing keeping the column sane.
   */
  static STATUSES = new Set(['TODO', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']);

  constructor() {
    this.conn = getConn();
    this.hooks = new EventHooksService();
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req);
      const { status, priority, assigned_to, contact_id, deal_id, due_from, due_to } = req.query;

      const where = [];
      const params = [];
      where.push('company_id = ?');
      params.push(req.user.companyId);
      if (status) { where.push('status = ?'); params.push(status); }
      if (priority) { where.push('priority = ?'); params.push(priority); }
      if (assigned_to) { where.push('assigned_to = ?'); params.push(assigned_to); }
      if (contact_id) { where.push('contact_id = ?'); params.push(contact_id); }
      if (deal_id) { where.push('deal_id = ?'); params.push(deal_id); }
      if (due_from) { where.push('due_date >= ?'); params.push(due_from); }
      if (due_to) { where.push('due_date <= ?'); params.push(due_to); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const items = this.conn.all(
        `SELECT * FROM tasks ${whereSql} ORDER BY due_date ASC, created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      const total = this.conn.get(`SELECT COUNT(*) as total FROM tasks ${whereSql}`, params).total;
      res.json(paginatedResponse(items, total, page, limit));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      const item = this.conn.get('SELECT * FROM tasks WHERE id = ? AND company_id = ? LIMIT 1', [req.params.id, req.user.companyId]);
      if (!item) throw new NotFoundError('Task', req.params.id);
      res.json(successResponse(item));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const { title, description, contact_id, organization_id, deal_id, assigned_to, due_date, priority, status } = req.body;
      if (!title) throw new ValidationError('Title is required');
      if (!contact_id && !organization_id) throw new ValidationError('contact_id or organization_id is required');
      assertTenantRefs(this.conn, req.user.companyId, { contact_id, organization_id });

      const id = req.body.id ? undefined : generateId('task');
      if (req.body.id) throw new ValidationError('id must not be supplied by the client');
      const now = new Date().toISOString();
      const resolvedStatus = status || 'TODO';
      const completedAt = resolvedStatus === 'COMPLETED' ? now : null;
      this.conn.run(`
        INSERT INTO tasks (id, company_id, title, description, contact_id, organization_id, deal_id, assigned_to, due_date, priority, status, completed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, req.user.companyId, title, description, contact_id, organization_id, deal_id, assigned_to, due_date, priority || 'MEDIUM', resolvedStatus, completedAt, now, now]);

      res.status(201).json(successResponse(this.conn.get('SELECT * FROM tasks WHERE id = ? AND company_id = ?', [id, req.user.companyId]), 201));
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      const existing = this.conn.get('SELECT id FROM tasks WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Task', req.params.id);

      // CRM-03: a task status is a lifecycle value, not free text. The schema has
      // no CHECK constraint on tasks.status, so without this any string ('BANANA')
      // was accepted and silently persisted.
      if (req.body.status !== undefined) {
        if (!TasksController.STATUSES.has(req.body.status)) {
          throw new ValidationError(
            `Invalid task status '${req.body.status}'. Expected one of: ${[...TasksController.STATUSES].join(', ')}.`,
          );
        }
      }

      const allowed = ['title', 'description', 'contact_id', 'organization_id', 'deal_id', 'assigned_to', 'due_date', 'priority', 'status'];
      const sets = [];
      const params = [];
      for (const f of allowed) {
        if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); }
      }
      if (!sets.length) throw new ValidationError('No fields to update');

      const now = new Date().toISOString();
      if (req.body.status === 'COMPLETED' && !req.body.completed_at) {
        sets.push('completed_at = ?');
        params.push(now);
      } else if (req.body.status && req.body.status !== 'COMPLETED' && !req.body.completed_at) {
        sets.push('completed_at = ?');
        params.push(null);
      }
      this.conn.run(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND company_id = ?`, [...params, now, req.params.id, req.user.companyId]);
      res.json(successResponse(this.conn.get('SELECT * FROM tasks WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId])));
    } catch (err) { next(err); }
  }

  async remove(req, res, next) {
    try {
      const result = this.conn.run('DELETE FROM tasks WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (result.changes === 0) throw new NotFoundError('Task', req.params.id);
      res.json(successResponse({ id: req.params.id, deleted: true }));
    } catch (err) { next(err); }
  }

  async complete(req, res, next) {
    try {
      const existing = this.conn.get('SELECT id FROM tasks WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Task', req.params.id);

      const now = new Date().toISOString();
      this.conn.run(`UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND company_id = ?`,
        ['COMPLETED', now, now, req.params.id, req.user.companyId]);
      res.json(successResponse(this.conn.get('SELECT * FROM tasks WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId])));
      this.hooks.onTaskCompleted(req.user.companyId, req.params.id);
    } catch (err) { next(err); }
  }
}

module.exports = { TasksController };