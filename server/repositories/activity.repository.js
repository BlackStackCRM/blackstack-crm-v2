const { BaseRepository } = require('./BaseRepository');

class ActivityRepository extends BaseRepository {
  constructor(conn) {
    super(conn, 'activities');
  }

  async search(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const where = ['company_id = ?'];
    const params = [options.companyId || 'default'];

    if (options.type) {
      where.push('type = ?');
      params.push(options.type);
    }
    if (options.contactId) {
      where.push('contact_id = ?');
      params.push(options.contactId);
    }
    if (options.dealId) {
      where.push('deal_id = ?');
      params.push(options.dealId);
    }
    if (options.startDate) {
      where.push('created_at >= ?');
      params.push(options.startDate);
    }

    const whereStr = where.join(' AND ');
    const countSql = `SELECT COUNT(*) as total FROM activities WHERE ${whereStr}`;
    const countRow = this.conn.get(countSql, params);
    const total = countRow?.total || 0;

    const listSql = `SELECT * FROM activities WHERE ${whereStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const items = this.conn.all(listSql, [...params, limit, offset]);

    return { items, total };
  }
}

module.exports = { ActivityRepository };
