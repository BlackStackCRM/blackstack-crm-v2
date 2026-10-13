const { DealRepository } = require('../repositories/deal.repository');
const { PipelineRepository } = require('../repositories/pipeline.repository');
const { Authorizer } = require('../auth/authorizer');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { validateCurrency, SUPPORTED_CURRENCIES } = require('../utils/currency');

class DealService {
  constructor(conn) {
    this.conn = conn;
  }

  _getDefaultCurrency(companyId) {
    const row = this.conn.get('SELECT value FROM system_metadata WHERE key = ?', ['default_currency']);
    return validateCurrency(row ? row.value : 'USD');
  }

  async list(context, query = {}) {
    const repo = new DealRepository(this.conn);
    Authorizer.assertPermission(context, 'deals.view');

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 20;
    const offset = (page - 1) * limit;

    const result = await repo.search({
      companyId: context.companyId,
      status: query.status,
      stageId: query.stageId,
      contactId: query.contactId,
      query: query.q,
      limit,
      offset
    });

    return { items: result.items, total: result.total };
  }

  async get(id, context) {
    const repo = new DealRepository(this.conn);
    Authorizer.assertPermission(context, 'deals.view');

    const item = await repo.findById(id, context.companyId);
    if (!item) throw new NotFoundError('Deal', id);
    return item;
  }

  async create(data, context) {
    const repo = new DealRepository(this.conn);
    Authorizer.assertPermission(context, 'deals.create');

    if (!data.title || !data.title.trim()) {
      throw new ValidationError('Deal title is required');
    }

    const id = require('../utils/generateId').generateId('deal');
    const now = new Date().toISOString();

    const deal = await repo.create({
      id,
      title: data.title.trim(),
      description: data.description || null,
      contact_id: data.contact_id,
      organization_id: data.organization_id || null,
      pipeline_id: data.pipeline_id || null,
      stage_id: data.stage_id,
      value: parseFloat(data.value) || 0,
      currency: data.currency && SUPPORTED_CURRENCIES.includes(data.currency) ? data.currency : this._getDefaultCurrency(context.companyId),
      probability: parseFloat(data.probability) || 0,
      expected_close_date: data.expected_close_date || null,
      status: 'OPEN',
      notes: data.notes || null,
      company_id: context.companyId,
      created_at: now,
      updated_at: now
    });

    return deal;
  }

  async update(id, data, context) {
    const repo = new DealRepository(this.conn);
    Authorizer.assertPermission(context, 'deals.edit');

    const existing = await repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Deal', id);

    const updated = await repo.update(id, context.companyId, {
      title: data.title || existing.title,
      description: data.description !== undefined ? data.description : existing.description,
      stage_id: data.stage_id || existing.stage_id,
      value: data.value !== undefined ? parseFloat(data.value) : existing.value,
      probability: data.probability !== undefined ? parseFloat(data.probability) : existing.probability,
      expected_close_date: data.expected_close_date !== undefined ? data.expected_close_date : existing.expected_close_date,
      notes: data.notes !== undefined ? data.notes : existing.notes
    });

    return updated;
  }

  async updateStage(id, stageId, context) {
    const repo = new DealRepository(this.conn);
    Authorizer.assertPermission(context, 'deals.edit');

    const existing = await repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Deal', id);

    const pipelineRepo = new PipelineRepository(this.conn);
    const stage = await pipelineRepo.getStageById(stageId, context.companyId);
    if (!stage) throw new ValidationError('Invalid stage');

    const updated = await repo.update(id, context.companyId, {
      stage_id: stageId,
      probability: stage.probability
    });

    return updated;
  }

  async markWon(id, context) {
    const repo = new DealRepository(this.conn);
    Authorizer.assertPermission(context, 'deals.edit');

    const existing = await repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Deal', id);

    const now = new Date().toISOString();
    await repo.update(id, context.companyId, {
      status: 'WON',
      actual_close_date: now.split('T')[0],
      won_at: now
    });

    return { success: true };
  }

  async markLost(id, reason, context) {
    const repo = new DealRepository(this.conn);
    Authorizer.assertPermission(context, 'deals.edit');

    const existing = await repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Deal', id);

    const now = new Date().toISOString();
    await repo.update(id, context.companyId, {
      status: 'LOST',
      lost_reason: reason || null,
      lost_at: now
    });

    return { success: true };
  }

  async remove(id, context) {
    const repo = new DealRepository(this.conn);
    Authorizer.assertPermission(context, 'deals.delete');

    const existing = await repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Deal', id);

    await repo.delete(id, context.companyId);
    return { success: true };
  }
}

module.exports = { DealService };
