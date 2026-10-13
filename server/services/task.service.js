const { TaskRepository } = require('../repositories/task.repository');
const { Authorizer } = require('../auth/authorizer');
const { NotFoundError, ValidationError } = require('../utils/errors');

class TaskService {
  constructor(conn) {
    this.conn = conn;
  }

  async list(context, query = {}) {
    const repo = new TaskRepository(this.conn);
    Authorizer.assertPermission(context, 'tasks.view');

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 50;
    const offset = (page - 1) * limit;

    const result = await repo.search({
      companyId: context.companyId,
      status: query.status,
      assignedTo: query.assignedTo,
      contactId: query.contactId,
      dealId: query.dealId,
      limit,
      offset
    });

    return { items: result.items, total: result.total };
  }

  async get(id, context) {
    const repo = new TaskRepository(this.conn);
    Authorizer.assertPermission(context, 'tasks.view');

    const item = await repo.findById(id, context.companyId);
    if (!item) throw new NotFoundError('Task', id);
    return item;
  }

  async create(data, context) {
    const repo = new TaskRepository(this.conn);
    Authorizer.assertPermission(context, 'tasks.create');

    if (!data.title || !data.title.trim()) {
      throw new ValidationError('Task title is required');
    }

    const id = require('../utils/generateId').generateId('tsk');
    const now = new Date().toISOString();

    const task = await repo.create({
      id,
      title: data.title.trim(),
      description: data.description || null,
      contact_id: data.contact_id || null,
      deal_id: data.deal_id || null,
      assigned_to: data.assigned_to || context.userId,
      due_date: data.due_date || null,
      priority: data.priority || 'MEDIUM',
      status: 'TODO',
      company_id: context.companyId,
      created_at: now,
      updated_at: now
    });

    return task;
  }

  async update(id, data, context) {
    const repo = new TaskRepository(this.conn);
    Authorizer.assertPermission(context, 'tasks.edit');

    const existing = await repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Task', id);

    const updated = await repo.update(id, context.companyId, {
      title: data.title || existing.title,
      description: data.description !== undefined ? data.description : existing.description,
      assigned_to: data.assigned_to !== undefined ? data.assigned_to : existing.assigned_to,
      due_date: data.due_date !== undefined ? data.due_date : existing.due_date,
      priority: data.priority || existing.priority,
      status: data.status || existing.status,
      completed_at: data.status === 'COMPLETED' ? new Date().toISOString() : existing.completed_at
    });

    return updated;
  }

  async updateStatus(id, status, context) {
    const repo = new TaskRepository(this.conn);
    Authorizer.assertPermission(context, 'tasks.edit');

    const existing = await repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Task', id);

    const completedAt = status === 'COMPLETED' ? new Date().toISOString() : null;
    await repo.update(id, context.companyId, {
      status,
      completed_at: completedAt,
      updated_at: new Date().toISOString()
    });

    return { success: true };
  }

  async remove(id, context) {
    const repo = new TaskRepository(this.conn);
    Authorizer.assertPermission(context, 'tasks.delete');

    const existing = await repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Task', id);

    await repo.delete(id, context.companyId);
    return { success: true };
  }
}

module.exports = { TaskService };
