const { BaseRepository } = require('./BaseRepository');

class ProductRepository extends BaseRepository {
  constructor(conn) {
    super(conn, 'products');
  }

  async search(options = {}) {
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    const where = ['company_id = ?'];
    const params = [options.companyId || 'default'];

    if (options.query) {
      where.push('(LOWER(name) LIKE ? OR LOWER(sku) LIKE ? OR LOWER(category) LIKE ?)');
      params.push(`%${options.query.toLowerCase()}%`, `%${options.query.toLowerCase()}%`, `%${options.query.toLowerCase()}%`);
    }
    if (options.isActive !== undefined) {
      where.push('is_active = ?');
      params.push(options.isActive ? 1 : 0);
    }

    const whereStr = where.join(' AND ');
    const countSql = `SELECT COUNT(*) as total FROM products WHERE ${whereStr}`;
    const countRow = this.conn.get(countSql, params);
    const total = countRow?.total || 0;

    const listSql = `SELECT * FROM products WHERE ${whereStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const items = this.conn.all(listSql, [...params, limit, offset]);

    return { items, total };
  }
}

module.exports = { ProductRepository };
