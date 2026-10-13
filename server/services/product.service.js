const { ProductRepository } = require('../repositories/product.repository');
const { Authorizer } = require('../auth/authorizer');
const { NotFoundError, ValidationError } = require('../utils/errors');

class ProductService {
  constructor(conn) {
    this.conn = conn;
  }

  async list(context, query = {}) {
    const repo = new ProductRepository(this.conn);
    Authorizer.assertPermission(context, 'products.view');

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 20;
    const offset = (page - 1) * limit;

    const result = await repo.search({
      companyId: context.companyId,
      query: query.q,
      isActive: query.isActive,
      limit,
      offset
    });

    return { items: result.items, total: result.total };
  }

  async get(id, context) {
    const repo = new ProductRepository(this.conn);
    Authorizer.assertPermission(context, 'products.view');

    const item = await repo.findById(id, context.companyId);
    if (!item) throw new NotFoundError('Product', id);
    return item;
  }

  async create(data, context) {
    const repo = new ProductRepository(this.conn);
    Authorizer.assertPermission(context, 'products.create');

    if (!data.name || !data.name.trim()) {
      throw new ValidationError('Product name is required');
    }

    const id = require('../utils/generateId').generateId('prod');
    const now = new Date().toISOString();

    const product = await repo.create({
      id,
      name: data.name.trim(),
      description: data.description || null,
      category: data.category || null,
      sku: data.sku || null,
      price: parseFloat(data.price) || 0,
      cost: parseFloat(data.cost) || 0,
      tax_rate: parseFloat(data.tax_rate) || 0,
      is_service: data.is_service ? 1 : 0,
      is_active: data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1,
      company_id: context.companyId,
      created_at: now,
      updated_at: now
    });

    return product;
  }

  async update(id, data, context) {
    const repo = new ProductRepository(this.conn);
    Authorizer.assertPermission(context, 'products.edit');

    const existing = await repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Product', id);

    const updated = await repo.update(id, context.companyId, {
      name: data.name || existing.name,
      description: data.description !== undefined ? data.description : existing.description,
      category: data.category !== undefined ? data.category : existing.category,
      sku: data.sku !== undefined ? data.sku : existing.sku,
      price: data.price !== undefined ? parseFloat(data.price) : existing.price,
      cost: data.cost !== undefined ? parseFloat(data.cost) : existing.cost,
      tax_rate: data.tax_rate !== undefined ? parseFloat(data.tax_rate) : existing.tax_rate,
      is_service: data.is_service !== undefined ? (data.is_service ? 1 : 0) : existing.is_service,
      is_active: data.is_active !== undefined ? (data.is_active ? 1 : 0) : existing.is_active
    });

    return updated;
  }

  async remove(id, context) {
    const repo = new ProductRepository(this.conn);
    Authorizer.assertPermission(context, 'products.delete');

    const existing = await repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Product', id);

    await repo.delete(id, context.companyId);
    return { success: true };
  }
}

module.exports = { ProductService };
