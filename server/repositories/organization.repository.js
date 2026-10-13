const { BaseRepository } = require('./BaseRepository');

class OrganizationRepository extends BaseRepository {
  constructor(conn) {
    super(conn, 'organizations');
  }

  search(companyId, options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const orderBy = /^[a-zA-Z0-9_]+$/.test(options.orderBy) ? options.orderBy : 'created_at';
    const orderDir = options.orderDir === 'ASC' ? 'ASC' : 'DESC';

    const where = ['company_id = ?'];
    const params = [companyId];

    if (options.status) { where.push('status = ?'); params.push(options.status); }
    if (options.search) {
      const search = `%${options.search.toLowerCase()}%`;
      where.push('(LOWER(name) LIKE ? OR LOWER(industry) LIKE ? OR LOWER(email) LIKE ? OR LOWER(website) LIKE ?)');
      params.push(search, search, search, search);
    }

    const items = this.conn.all(`SELECT * FROM organizations WHERE ${where.join(' AND ')} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?;`, [...params, limit, offset]);
    const row = this.conn.get(`SELECT COUNT(*) AS total FROM organizations WHERE ${where.join(' AND ')};`, params);
    return { items, total: row?.total || 0 };
  }

  findByEmail(companyId, email) {
    return this.conn.get('SELECT * FROM organizations WHERE company_id = ? AND LOWER(email) = LOWER(?) LIMIT 1;', [companyId, email]);
  }
}

module.exports = { OrganizationRepository };