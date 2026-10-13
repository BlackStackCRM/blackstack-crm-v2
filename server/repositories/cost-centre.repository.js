const { AccountingBaseRepository } = require('./accounting-base.repository');

class CostCentreRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'cost_centres');
  }

  find(opts = {}) {
    const { companyId, page = 1, limit = 50, activeOnly = true } = opts;
    const offset = (page - 1) * limit;
    let sql = 'SELECT * FROM cost_centres WHERE company_id = ?';
    const params = [companyId];
    if (activeOnly) { sql += ' AND is_active = 1'; }
    sql += ' ORDER BY code LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const items = this.conn.all(sql, params);
    const countRow = this.conn.get(
      'SELECT COUNT(*) as total FROM cost_centres WHERE company_id = ?' + (activeOnly ? ' AND is_active = 1' : ''),
      activeOnly ? [companyId] : [companyId]
    );
    return { items, total: countRow?.total || 0 };
  }

  getByCode(code, companyId) {
    return this.conn.get('SELECT * FROM cost_centres WHERE code = ? AND company_id = ?', [code, companyId]);
  }
}

module.exports = { CostCentreRepository };
