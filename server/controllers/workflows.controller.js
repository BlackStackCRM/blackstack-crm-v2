const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');
const { WorkflowExecutorService } = require('../services/workflow-executor.service');

class WorkflowsController {
  constructor() {
    this.conn = getConn();
    this.executor = new WorkflowExecutorService();
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req);
      const { trigger_type, is_active } = req.query;

      const where = [];
      const params = [];
      where.push('company_id = ?');
      params.push(req.user.companyId);
      if (trigger_type) { where.push('trigger_type = ?'); params.push(trigger_type); }
      if (is_active !== undefined) { where.push('is_active = ?'); params.push(is_active === 'true' ? 1 : 0); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const items = this.conn.all(
        `SELECT * FROM workflow_definitions ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      const total = this.conn.get(`SELECT COUNT(*) as total FROM workflow_definitions ${whereSql}`, params).total;
      res.json(paginatedResponse(items, total, page, limit));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      const item = this.conn.get('SELECT * FROM workflow_definitions WHERE id = ? AND company_id = ? LIMIT 1', [req.params.id, req.user.companyId]);
      if (!item) throw new NotFoundError('Workflow', req.params.id);
      item.recent_instances = this.conn.all(
        'SELECT * FROM workflow_instances WHERE workflow_id = ? ORDER BY started_at DESC LIMIT 20',
        [req.params.id]
      );
      res.json(successResponse(item));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const { name, trigger_type, conditions, actions, is_active } = req.body;
      if (!name) throw new ValidationError('Name is required');
      if (!trigger_type) throw new ValidationError('trigger_type is required');
      if (!actions || (Array.isArray(actions) && actions.length === 0)) {
        throw new ValidationError('actions is required');
      }

      const id = req.body.id ? undefined : generateId('wf');
      if (req.body.id) throw new ValidationError('id must not be supplied by the client');
      const now = new Date().toISOString();
      this.conn.run(`
        INSERT INTO workflow_definitions (id, company_id, name, trigger_type, conditions_json, actions_json, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, req.user.companyId, name, trigger_type,
        conditions ? JSON.stringify(conditions) : null,
        JSON.stringify(actions),
        is_active === false ? 0 : 1, now, now]);

      res.status(201).json(successResponse(this.conn.get('SELECT * FROM workflow_definitions WHERE id = ? AND company_id = ?', [id, req.user.companyId]), 201));
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      const existing = this.conn.get('SELECT id FROM workflow_definitions WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Workflow', req.params.id);

      const sets = [];
      const params = [];
      if (req.body.name !== undefined) { sets.push('name = ?'); params.push(req.body.name); }
      if (req.body.trigger_type !== undefined) { sets.push('trigger_type = ?'); params.push(req.body.trigger_type); }
      if (req.body.conditions !== undefined) { sets.push('conditions_json = ?'); params.push(JSON.stringify(req.body.conditions)); }
      if (req.body.actions !== undefined) { sets.push('actions_json = ?'); params.push(JSON.stringify(req.body.actions)); }
      if (req.body.is_active !== undefined) { sets.push('is_active = ?'); params.push(req.body.is_active ? 1 : 0); }
      if (!sets.length) throw new ValidationError('No fields to update');

      sets.push('updated_at = ?'); params.push(new Date().toISOString());
      params.push(req.params.id, req.user.companyId);
      this.conn.run(`UPDATE workflow_definitions SET ${sets.join(', ')} WHERE id = ? AND company_id = ?`, params);
      res.json(successResponse(this.conn.get('SELECT * FROM workflow_definitions WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId])));
    } catch (err) { next(err); }
  }

  async remove(req, res, next) {
    try {
      const result = this.conn.run('DELETE FROM workflow_definitions WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (result.changes === 0) throw new NotFoundError('Workflow', req.params.id);
      res.json(successResponse({ id: req.params.id, deleted: true }));
    } catch (err) { next(err); }
  }

  async trigger(req, res, next) {
    try {
      const workflow = this.conn.get('SELECT * FROM workflow_definitions WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!workflow) throw new NotFoundError('Workflow', req.params.id);
      if (!workflow.is_active) throw new ValidationError('Workflow is not active');

      const context = {
        companyId: req.user.companyId,
        userId: req.user.userId,
        ...(req.body.context || {})
      };

      const result = await this.executor.execute(req.params.id, context);
      res.status(202).json(successResponse({ ...result, workflowId: req.params.id }, 202));
    } catch (err) { next(err); }
  }
}

module.exports = { WorkflowsController };