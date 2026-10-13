const { BaseRepository } = require('./BaseRepository');

class DealRepository extends BaseRepository {
  constructor(conn) {
    super(conn, 'deals');
  }

  async search(options = {}) {
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    const where = ['company_id = ?'];
    const params = [options.companyId || 'default'];

    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.stageId) {
      where.push('stage_id = ?');
      params.push(options.stageId);
    }
    if (options.contactId) {
      where.push('contact_id = ?');
      params.push(options.contactId);
    }
    if (options.query) {
      where.push('(LOWER(title) LIKE ? OR LOWER(description) LIKE ?)');
      params.push(`%${options.query.toLowerCase()}%`, `%${options.query.toLowerCase()}%`);
    }

    const whereStr = where.join(' AND ');
    const countSql = `SELECT COUNT(*) as total FROM deals WHERE ${whereStr}`;
    const countRow = this.conn.get(countSql, params);
    const total = countRow?.total || 0;

    const listSql = `SELECT * FROM deals WHERE ${whereStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const items = this.conn.all(listSql, [...params, limit, offset]);

    return { items, total };
  }
}

module.exports = { DealRepository };
