const { UserRepository } = require('../repositories/user.repository');
const { Authorizer } = require('../auth/authorizer');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { PasswordService } = require('../auth/password');

class UserService {
  constructor(conn) {
    this.conn = conn;
  }

  async list(context, query = {}) {
    const repo = new UserRepository(this.conn);
    Authorizer.assertPermission(context, 'users.view');

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 20;
    const offset = (page - 1) * limit;

    const result = await repo.search({
      query: query.q,
      status: query.status,
      limit,
      offset
    });

    return { items: result.items, total: result.total };
  }

  async get(id, context) {
    const repo = new UserRepository(this.conn);
    Authorizer.assertPermission(context, 'users.view');

    const item = await repo.findById(id);
    if (!item) throw new NotFoundError('User', id);
    return item;
  }

  async create(data, context) {
    const repo = new UserRepository(this.conn);
    Authorizer.assertPermission(context, 'users.manage');

    if (!data.email || !data.email.trim()) {
      throw new ValidationError('Email is required');
    }
    if (!data.password || data.password.length < 8) {
      throw new ValidationError('Password must be at least 8 characters');
    }

    const existing = await repo.findByEmail(data.email.trim());
    if (existing) {
      throw new ValidationError('Email already exists');
    }

    const id = require('../utils/generateId').generateId('usr');
    const passwordHash = await PasswordService.hash(data.password);
    const now = new Date().toISOString();

    const user = await repo.create({
      id,
      email: data.email.trim(),
      password_hash: passwordHash,
      full_name: data.full_name.trim(),
      role: data.role || 'USER',
      status: data.status || 'ACTIVE',
      company_id: context.companyId,
      created_at: now,
      updated_at: now
    });

    return user;
  }

  async update(id, data, context) {
    const repo = new UserRepository(this.conn);
    Authorizer.assertPermission(context, 'users.manage');

    const existing = await repo.findById(id);
    if (!existing) throw new NotFoundError('User', id);

    const updates = {
      full_name: data.full_name || existing.full_name,
      role: data.role || existing.role,
      status: data.status || existing.status
    };

    if (data.password) {
      updates.password_hash = await PasswordService.hash(data.password);
    }

    const updated = await repo.update(id, updates);
    return updated;
  }

  async remove(id, context) {
    const repo = new UserRepository(this.conn);
    Authorizer.assertPermission(context, 'users.manage');

    const existing = await repo.findById(id);
    if (!existing) throw new NotFoundError('User', id);

    await repo.update(id, { status: 'INACTIVE' });
    return { success: true };
  }
}

module.exports = { UserService };
