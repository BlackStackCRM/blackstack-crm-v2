const { BaseRepository } = require('./BaseRepository');

class TaskRepository extends BaseRepository {
  constructor(conn) {
    super(conn, 'tasks');
  }

  async search(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const where = ['company_id = ?'];
    const params = [options.companyId || 'default'];

    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.assignedTo) {
      where.push('assigned_to = ?');
      params.push(options.assignedTo);
    }
    if (options.contactId) {
      where.push('contact_id = ?');
      params.push(options.contactId);
    }
    if (options.dealId) {
      where.push('deal_id = ?');
      params.push(options.dealId);
    }

    const whereStr = where.join(' AND ');
    const countSql = `SELECT COUNT(*) as total FROM tasks WHERE ${whereStr}`;
    const countRow = this.conn.get(countSql, params);
    const total = countRow?.total || 0;

    const listSql = `SELECT * FROM tasks WHERE ${whereStr} ORDER BY due_date ASC, created_at DESC LIMIT ? OFFSET ?`;
    const items = this.conn.all(listSql, [...params, limit, offset]);

    return { items, total };
  }
}

module.exports = { TaskRepository };
