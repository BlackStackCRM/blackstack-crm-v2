const { WorkflowRepository } = require('../repositories/workflow.repository');
const { Authorizer } = require('../auth/authorizer');
const { NotFoundError, ValidationError } = require('../utils/errors');

class WorkflowService {
  constructor(conn) {
    this.conn = conn;
  }

  async list(context, query = {}) {
    const repo = new WorkflowRepository(this.conn);
    Authorizer.assertPermission(context, 'workflows.view');

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 20;
    const offset = (page - 1) * limit;

    const result = await repo.search({
      companyId: context.companyId,
      isActive: query.isActive,
      query: query.q,
      limit,
      offset
    });

    return { items: result.items, total: result.total };
  }

  async get(id, context) {
    const repo = new WorkflowRepository(this.conn);
    Authorizer.assertPermission(context, 'workflows.view');

    const item = await repo.findById(id, context.companyId);
    if (!item) throw new NotFoundError('Workflow', id);
    return item;
  }

  async create(data, context) {
    const repo = new WorkflowRepository(this.conn);
    Authorizer.assertPermission(context, 'workflows.manage');

    if (!data.name || !data.name.trim()) {
      throw new ValidationError('Workflow name is required');
    }
    if (!data.trigger_type) {
      throw new ValidationError('Trigger type is required');
    }

    const id = require('../utils/generateId').generateId('wf');
    const now = new Date().toISOString();

    const workflow = await repo.create({
      id,
      name: data.name.trim(),
      trigger_type: data.trigger_type,
      conditions_json: data.conditions_json ? JSON.stringify(data.conditions_json) : null,
      actions_json: JSON.stringify(data.actions_json || []),
      is_active: data.is_active ? 1 : 0,
      company_id: context.companyId,
      created_at: now,
      updated_at: now
    });

    return workflow;
  }

  async update(id, data, context) {
    const repo = new WorkflowRepository(this.conn);
    Authorizer.assertPermission(context, 'workflows.manage');

    const existing = await repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Workflow', id);

    const updated = await repo.update(id, context.companyId, {
      name: data.name || existing.name,
      trigger_type: data.trigger_type || existing.trigger_type,
      conditions_json: data.conditions_json !== undefined ? JSON.stringify(data.conditions_json) : existing.conditions_json,
      actions_json: data.actions_json ? JSON.stringify(data.actions_json) : existing.actions_json,
      is_active: data.is_active !== undefined ? (data.is_active ? 1 : 0) : existing.is_active
    });

    return updated;
  }

  async remove(id, context) {
    const repo = new WorkflowRepository(this.conn);
    Authorizer.assertPermission(context, 'workflows.manage');

    const existing = await repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Workflow', id);

    await repo.delete(id, context.companyId);
    return { success: true };
  }
}

module.exports = { WorkflowService };
