const { generateId } = require('../utils/generateId');

class AccountingAuditRepository {
  constructor(conn) {
    this.conn = conn;
  }

  log(entry) {
    const id = entry.id || generateId('aud');
    this.conn.run(
      `INSERT INTO accounting_audit
        (id, company_id, user_id, action, entity_type, entity_id, old_values_json, new_values_json, ip_address, user_agent, session_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        entry.company_id || 'default',
        entry.user_id || 'system',
        entry.action,
        entry.entity_type || null,
        entry.entity_id || null,
        entry.old_values_json || null,
        entry.new_values_json || null,
        entry.ip_address || null,
        entry.user_agent || null,
        entry.session_id || null,
        new Date().toISOString()
      ]
    );
    return { id };
  }

  search(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const companyId = options.companyId || 'default';
    const where = ['company_id = ?'];
    const params = [companyId];

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
    if (options.action) {
      where.push('action = ?');
      params.push(options.action);
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
    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM accounting_audit WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;
    const items = this.conn.all(
      `SELECT * FROM accounting_audit WHERE ${whereStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { items, total };
  }
}

module.exports = { AccountingAuditRepository };
