const { BaseRepository } = require('./BaseRepository');

class NoteRepository extends BaseRepository {
  constructor(conn) {
    super(conn, 'notes');
  }

  async search(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const where = ['company_id = ?'];
    const params = [options.companyId || 'default'];

    if (options.contactId) {
      where.push('contact_id = ?');
      params.push(options.contactId);
    }
    if (options.organizationId) {
      where.push('organization_id = ?');
      params.push(options.organizationId);
    }
    if (options.dealId) {
      where.push('deal_id = ?');
      params.push(options.dealId);
    }
    if (options.query) {
      where.push('(LOWER(title) LIKE ? OR LOWER(content) LIKE ?)');
      params.push(`%${options.query.toLowerCase()}%`, `%${options.query.toLowerCase()}%`);
    }

    const whereStr = where.join(' AND ');
    const countSql = `SELECT COUNT(*) as total FROM notes WHERE ${whereStr}`;
    const countRow = this.conn.get(countSql, params);
    const total = countRow?.total || 0;

    const listSql = `SELECT * FROM notes WHERE ${whereStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const items = this.conn.all(listSql, [...params, limit, offset]);

    return { items, total };
  }
}

module.exports = { NoteRepository };
