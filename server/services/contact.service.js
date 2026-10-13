const { ContactRepository } = require('../repositories/contact.repository');
const { Authorizer } = require('../auth/authorizer');
const { NotFoundError, ValidationError } = require('../utils/errors');

class ContactService {
  constructor(conn) {
    this.conn = conn;
  }

  async list(context, query = {}) {
    const repo = new ContactRepository(this.conn);
    Authorizer.assertPermission(context, 'contacts.view');

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 20;
    const offset = (page - 1) * limit;

    const result = await repo.search({
      query: query.q,
      organizationId: query.organizationId,
      limit,
      offset
    });

    return {
      items: result.items,
      total: result.total
    };
  }

  async get(id, context) {
    const repo = new ContactRepository(this.conn);
    Authorizer.assertPermission(context, 'contacts.view');

    const item = await repo.getContactWithTags(id, context.companyId);
    if (!item) {
      throw new NotFoundError('Contact', id);
    }

    return item;
  }

  async create(data, context) {
    const repo = new ContactRepository(this.conn);
    Authorizer.assertPermission(context, 'contacts.create');

    if (!data.first_name || !data.first_name.trim()) {
      throw new ValidationError('First name is required');
    }

    const id = require('../utils/generateId').generateId('cnt');
    const now = new Date().toISOString();

    const contact = await repo.create({
      id,
      first_name: data.first_name.trim(),
      last_name: data.last_name || null,
      email: data.email || null,
      phone: data.phone || null,
      job_title: data.job_title || null,
      organization_id: data.organization_id || null,
      address: data.address || null,
      city: data.city || null,
      state: data.state || null,
      postal_code: data.postal_code || null,
      country: data.country || null,
      notes: data.notes || null,
      status: data.status || 'ACTIVE',
      company_id: context.companyId,
      created_at: now,
      updated_at: now
    });

    return contact;
  }

  async update(id, data, context) {
    const repo = new ContactRepository(this.conn);
    Authorizer.assertPermission(context, 'contacts.edit');

    const existing = await repo.findById(id, context.companyId);
    if (!existing) {
      throw new NotFoundError('Contact', id);
    }

    const updated = await repo.update(id, context.companyId, {
      first_name: data.first_name || existing.first_name,
      last_name: data.last_name !== undefined ? data.last_name : existing.last_name,
      email: data.email !== undefined ? data.email : existing.email,
      phone: data.phone !== undefined ? data.phone : existing.phone,
      job_title: data.job_title !== undefined ? data.job_title : existing.job_title,
      organization_id: data.organization_id !== undefined ? data.organization_id : existing.organization_id,
      address: data.address !== undefined ? data.address : existing.address,
      city: data.city !== undefined ? data.city : existing.city,
      state: data.state !== undefined ? data.state : existing.state,
      postal_code: data.postal_code !== undefined ? data.postal_code : existing.postal_code,
      country: data.country !== undefined ? data.country : existing.country,
      notes: data.notes !== undefined ? data.notes : existing.notes,
      status: data.status || existing.status
    });

    return updated;
  }

  async remove(id, context) {
    const repo = new ContactRepository(this.conn);
    Authorizer.assertPermission(context, 'contacts.delete');

    const existing = await repo.findById(id, context.companyId);
    if (!existing) {
      throw new NotFoundError('Contact', id);
    }

    await repo.delete(id, context.companyId);
    return { success: true };
  }
}

module.exports = { ContactService };
