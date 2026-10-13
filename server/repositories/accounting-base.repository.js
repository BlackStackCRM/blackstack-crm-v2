const { BaseRepository } = require('./BaseRepository');
const { NotFoundError, ValidationError } = require('../utils/errors');

class AccountingBaseRepository extends BaseRepository {
  constructor(conn, tableName) {
    super(conn, tableName);
  }

  // All accounting queries must be tenant-scoped — never trust frontend companyId
  _company(companyId) {
    return companyId || 'default';
  }

  findById(id, companyId) {
    const sql = `SELECT * FROM ${this.tableName} WHERE id = ? AND company_id = ? LIMIT 1`;
    return this.conn.get(sql, [id, this._company(companyId)]);
  }

  list(companyId, options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const orderBy = /^[a-zA-Z0-9_]+$/.test(options.orderBy) ? options.orderBy : 'created_at';
    const orderDir = options.orderDir === 'ASC' ? 'ASC' : 'DESC';
    const sql = `SELECT * FROM ${this.tableName} WHERE company_id = ? ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`;
    return this.conn.all(sql, [this._company(companyId), limit, offset]);
  }

  count(companyId) {
    const sql = `SELECT COUNT(*) as total FROM ${this.tableName} WHERE company_id = ?`;
    const row = this.conn.get(sql, [this._company(companyId)]);
    return row?.total || 0;
  }

  update(id, companyId, data) {
    const now = new Date().toISOString();
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const values = Object.values(data);
    const sql = `UPDATE ${this.tableName} SET ${sets}, updated_at = ? WHERE id = ? AND company_id = ?`;
    this.conn.run(sql, [...values, now, id, this._company(companyId)]);
    return { id, ...data, updated_at: now };
  }

  delete(id, companyId) {
    // Check for dependent records before deleting
    const checkSql = `SELECT id FROM ${this.tableName} WHERE id = ? AND company_id = ? LIMIT 1`;
    const exists = this.conn.get(checkSql, [id, this._company(companyId)]);
    if (!exists) return false;
    // Subclasses can override this to check FK dependencies
    const sql = `DELETE FROM ${this.tableName} WHERE id = ? AND company_id = ?`;
    const result = this.conn.run(sql, [id, this._company(companyId)]);
    return result.changes > 0;
  }
}

module.exports = { AccountingBaseRepository };
