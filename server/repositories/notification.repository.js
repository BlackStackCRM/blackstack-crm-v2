const { BaseRepository } = require('./BaseRepository');

class NotificationRepository extends BaseRepository {
  constructor(conn) {
    super(conn, 'notifications');
  }

  async search(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const where = ['n.company_id = ?'];
    const params = [options.companyId || 'default'];

    if (options.userId) { where.push('n.user_id = ?'); params.push(options.userId); }
    if (options.isRead !== undefined) { where.push('n.is_read = ?'); params.push(options.isRead ? 1 : 0); }
    if (options.type) { where.push('n.type = ?'); params.push(options.type); }

    const whereStr = where.join(' AND ');
    const sql = `SELECT * FROM notifications n WHERE ${whereStr} ORDER BY n.created_at DESC LIMIT ? OFFSET ?`;
    const countSql = `SELECT COUNT(*) as total FROM notifications n WHERE ${whereStr}`;
    const total = this.conn.get(countSql, params)?.total || 0;
    const items = this.conn.all(sql, [...params, limit, offset]);
    return { items, total };
  }

  async unreadCount(companyId, userId) {
    const row = this.conn.get('SELECT COUNT(*) as total FROM notifications WHERE company_id = ? AND user_id = ? AND is_read = 0', [companyId, userId]);
    return row?.total || 0;
  }

  async markRead(id, companyId) {
    const now = new Date().toISOString();
    this.conn.run('UPDATE notifications SET is_read = 1, read_at = ? WHERE id = ? AND company_id = ?', [now, id, companyId]);
  }

  async markAllRead(companyId, userId) {
    const now = new Date().toISOString();
    this.conn.run('UPDATE notifications SET is_read = 1, read_at = ? WHERE company_id = ? AND user_id = ? AND is_read = 0', [now, companyId, userId]);
  }
}

module.exports = { NotificationRepository };
