const { PipelineRepository } = require('../repositories/pipeline.repository');
const { Authorizer } = require('../auth/authorizer');
const { NotFoundError, ValidationError } = require('../utils/errors');

class PipelineService {
  constructor(conn) {
    this.conn = conn;
  }

  async list(context) {
    const repo = new PipelineRepository(this.conn);
    Authorizer.assertPermission(context, 'deals.view');
    return repo.list(context.companyId);
  }

  async getStages(context) {
    const repo = new PipelineRepository(this.conn);
    Authorizer.assertPermission(context, 'deals.view');
    return repo.getStages(context.companyId);
  }

  async createStage(data, context) {
    const repo = new PipelineRepository(this.conn);
    Authorizer.assertPermission(context, 'deals.edit');

    if (!data.name || !data.name.trim()) {
      throw new ValidationError('Stage name is required');
    }

    const maxOrder = this.conn.get('SELECT MAX(stage_order) as max FROM pipeline_stages WHERE company_id = ?', [context.companyId]);
    const stageOrder = (maxOrder?.max || 0) + 1;

    return repo.createStage({
      name: data.name.trim(),
      stage_order: stageOrder,
      probability: parseFloat(data.probability) || 0,
      color: data.color || '#64748b'
    }, context.companyId);
  }

  async updateStage(id, data, context) {
    const repo = new PipelineRepository(this.conn);
    Authorizer.assertPermission(context, 'deals.edit');

    const existing = await repo.getStageById(id, context.companyId);
    if (!existing) throw new NotFoundError('Stage', id);

    return repo.update(id, context.companyId, {
      name: data.name || existing.name,
      probability: data.probability !== undefined ? parseFloat(data.probability) : existing.probability,
      color: data.color || existing.color
    });
  }

  async deleteStage(id, context) {
    const repo = new PipelineRepository(this.conn);
    Authorizer.assertPermission(context, 'deals.edit');

    const existing = await repo.getStageById(id, context.companyId);
    if (!existing) throw new NotFoundError('Stage', id);

    await repo.delete(id, context.companyId);
    return { success: true };
  }
}

module.exports = { PipelineService };
