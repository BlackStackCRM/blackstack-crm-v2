const { NoteRepository } = require('../repositories/note.repository');
const { Authorizer } = require('../auth/authorizer');
const { NotFoundError, ValidationError } = require('../utils/errors');

class NoteService {
  constructor(conn) {
    this.conn = conn;
  }

  async list(context, query = {}) {
    const repo = new NoteRepository(this.conn);
    Authorizer.assertPermission(context, 'contacts.view');

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 50;
    const offset = (page - 1) * limit;

    const result = await repo.search({
      companyId: context.companyId,
      contactId: query.contactId,
      organizationId: query.organizationId,
      dealId: query.dealId,
      query: query.q,
      limit,
      offset
    });

    return { items: result.items, total: result.total };
  }

  async get(id, context) {
    const repo = new NoteRepository(this.conn);
    const item = await repo.findById(id, context.companyId);
    if (!item) throw new NotFoundError('Note', id);
    return item;
  }

  async create(data, context) {
    const repo = new NoteRepository(this.conn);
    Authorizer.assertPermission(context, 'contacts.create');

    if (!data.title || !data.title.trim()) {
      throw new ValidationError('Note title is required');
    }

    const id = require('../utils/generateId').generateId('note');
    const now = new Date().toISOString();

    const note = await repo.create({
      id,
      title: data.title.trim(),
      content: data.content || null,
      contact_id: data.contact_id || null,
      organization_id: data.organization_id || null,
      deal_id: data.deal_id || null,
      company_id: context.companyId,
      created_at: now,
      updated_at: now
    });

    return note;
  }

  async update(id, data, context) {
    const repo = new NoteRepository(this.conn);
    const existing = await repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Note', id);

    const updated = await repo.update(id, context.companyId, {
      title: data.title || existing.title,
      content: data.content !== undefined ? data.content : existing.content,
      contact_id: data.contact_id !== undefined ? data.contact_id : existing.contact_id,
      organization_id: data.organization_id !== undefined ? data.organization_id : existing.organization_id,
      deal_id: data.deal_id !== undefined ? data.deal_id : existing.deal_id
    });

    return updated;
  }

  async remove(id, context) {
    const repo = new NoteRepository(this.conn);
    const existing = await repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Note', id);

    await repo.delete(id, context.companyId);
    return { success: true };
  }
}

module.exports = { NoteService };
