const { BaseRepository } = require('./BaseRepository');

class WorkflowRepository extends BaseRepository {
  constructor(conn) {
    super(conn, 'workflow_definitions');
  }

  async search(options = {}) {
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    const where = ['company_id = ?'];
    const params = [options.companyId || 'default'];

    if (options.isActive !== undefined) {
      where.push('is_active = ?');
      params.push(options.isActive ? 1 : 0);
    }
    if (options.query) {
      where.push('LOWER(name) LIKE ?');
      params.push(`%${options.query.toLowerCase()}%`);
    }

    const whereStr = where.join(' AND ');
    const countSql = `SELECT COUNT(*) as total FROM workflow_definitions WHERE ${whereStr}`;
    const countRow = this.conn.get(countSql, params);
    const total = countRow?.total || 0;

    const listSql = `SELECT * FROM workflow_definitions WHERE ${whereStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const items = this.conn.all(listSql, [...params, limit, offset]);

    return { items, total };
  }
}

module.exports = { WorkflowRepository };
