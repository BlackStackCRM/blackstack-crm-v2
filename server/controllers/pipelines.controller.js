const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { successResponse } = require('../utils/response');

class PipelinesController {
  constructor() {
    this.conn = getConn();
  }

  async list(req, res, next) {
    try {
      const items = this.conn.all('SELECT * FROM pipelines WHERE company_id = ? ORDER BY created_at DESC', [req.user.companyId]);
      const stagesByPipeline = {};
      for (const p of items) {
        stagesByPipeline[p.id] = this.conn.all('SELECT * FROM pipeline_stages WHERE company_id = ? ORDER BY stage_order ASC', [req.user.companyId]);
      }
      res.json(successResponse(items.map(p => ({ ...p, stages: stagesByPipeline[p.id] }))));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      const item = this.conn.get('SELECT * FROM pipelines WHERE id = ? AND company_id = ? LIMIT 1', [req.params.id, req.user.companyId]);
      if (!item) throw new NotFoundError('Pipeline', req.params.id);
      item.stages = this.conn.all('SELECT * FROM pipeline_stages WHERE company_id = ? ORDER BY stage_order ASC', [req.user.companyId]);
      res.json(successResponse(item));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const { name, is_default } = req.body;
      if (!name) throw new ValidationError('Name is required');
      const id = req.body.id ? undefined : generateId('pipe');
      if (req.body.id) throw new ValidationError('id must not be supplied by the client');
      this.conn.run(`INSERT INTO pipelines (id, company_id, name, is_default) VALUES (?, ?, ?, ?)`,
        [id, req.user.companyId, name, is_default ? 1 : 0]);
      res.status(201).json(successResponse(this.conn.get('SELECT * FROM pipelines WHERE id = ? AND company_id = ?', [id, req.user.companyId]), 201));
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      const existing = this.conn.get('SELECT id FROM pipelines WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Pipeline', req.params.id);

      const sets = [];
      const params = [];
      if (req.body.name !== undefined) { sets.push('name = ?'); params.push(req.body.name); }
      if (req.body.is_default !== undefined) { sets.push('is_default = ?'); params.push(req.body.is_default ? 1 : 0); }
      if (!sets.length) throw new ValidationError('No fields to update');

      this.conn.run(`UPDATE pipelines SET ${sets.join(', ')} WHERE id = ? AND company_id = ?`, [...params, req.params.id, req.user.companyId]);
      res.json(successResponse(this.conn.get('SELECT * FROM pipelines WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId])));
    } catch (err) { next(err); }
  }

  async remove(req, res, next) {
    try {
      const result = this.conn.run('DELETE FROM pipelines WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (result.changes === 0) throw new NotFoundError('Pipeline', req.params.id);
      res.json(successResponse({ id: req.params.id, deleted: true }));
    } catch (err) { next(err); }
  }

  async getStages(req, res, next) {
    try {
      const items = this.conn.all('SELECT * FROM pipeline_stages WHERE company_id = ? ORDER BY stage_order ASC', [req.user.companyId]);
      res.json(successResponse(items));
    } catch (err) { next(err); }
  }
}

module.exports = { PipelinesController };