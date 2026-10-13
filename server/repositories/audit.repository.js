const { BaseRepository } = require('./BaseRepository');

class AuditRepository extends BaseRepository {
  constructor(conn) {
    super(conn, 'audit_logs');
  }

  async search(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const where = ['company_id = ?'];
    const params = [options.companyId || 'default'];

    if (options.entityType) {
      where.push('entity_type = ?');
      params.push(options.entityType);
    }
    if (options.entityId) {
      where.push('entity_id = ?');
      params.push(options.entityId);
    }
    if (options.userId) {
      where.push('user_id = ?');
      params.push(options.userId);
    }
    if (options.startDate) {
      where.push('created_at >= ?');
      params.push(options.startDate);
    }
    if (options.endDate) {
      where.push('created_at <= ?');
      params.push(options.endDate);
    }

    const whereStr = where.join(' AND ');
    const countSql = `SELECT COUNT(*) as total FROM audit_logs WHERE ${whereStr}`;
    const countRow = this.conn.get(countSql, params);
    const total = countRow?.total || 0;

    const listSql = `SELECT * FROM audit_logs WHERE ${whereStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const items = this.conn.all(listSql, [...params, limit, offset]);

    return { items, total };
  }

  async log(entry) {
    const id = entry.id || require('../utils/generateId').generateId('aud');
    this.conn.run(
      `INSERT INTO audit_logs (id, company_id, user_id, action, entity_type, entity_id, old_values_json, new_values_json, ip_address, user_agent, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        entry.company_id ?? 'default',
        entry.user_id ?? null,
        entry.action,
        entry.entity_type ?? null,
        entry.entity_id ?? null,
        entry.old_values_json ?? null,
        entry.new_values_json ?? null,
        entry.ip_address ?? null,
        entry.user_agent ?? null,
        entry.session_id ?? null,
        new Date().toISOString()
      ]
    );
    return { id };
  }
}

module.exports = { AuditRepository };
