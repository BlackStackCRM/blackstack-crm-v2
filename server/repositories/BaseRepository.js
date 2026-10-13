const { DatabaseConnection } = require('../database/connection');
const { NotFoundError } = require('../utils/errors');
const { generateId } = require('../utils/generateId');

class BaseRepository {
  constructor(conn, tableName) {
    this.conn = conn;
    this.tableName = tableName;
  }

  findById(id, companyId) {
    const sql = `SELECT * FROM ${this.tableName} WHERE id = ? AND company_id = ? LIMIT 1;`;
    return this.conn.get(sql, [id, companyId]);
  }

  list(companyId, options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const orderBy = /^[a-zA-Z0-9_]+$/.test(options.orderBy) ? options.orderBy : 'created_at';
    const orderDir = options.orderDir === 'ASC' ? 'ASC' : 'DESC';

    const sql = `SELECT * FROM ${this.tableName} WHERE company_id = ? ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?;`;
    return this.conn.all(sql, [companyId, limit, offset]);
  }

  count(companyId) {
    const sql = `SELECT COUNT(*) as total FROM ${this.tableName} WHERE company_id = ?;`;
    const row = this.conn.get(sql, [companyId]);
    return row?.total || 0;
  }

  create(data) {
    const id = data.id || generateId(this.getPrefix());
    const now = new Date().toISOString();
    const keys = Object.keys(data);
    const placeholders = keys.map(() => '?').join(', ');
    const values = keys.map(k => data[k] !== undefined ? data[k] : null);

    const sql = `INSERT INTO ${this.tableName} (id, ${keys.join(', ')}, created_at, updated_at) VALUES (?, ${placeholders}, ?, ?);`;
    this.conn.run(sql, [id, ...values, now, now]);
    return { id, ...data, created_at: now, updated_at: now };
  }

  update(id, companyId, data) {
    const now = new Date().toISOString();
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const values = Object.values(data);
    const sql = `UPDATE ${this.tableName} SET ${sets}, updated_at = ? WHERE id = ? AND company_id = ?;`;
    this.conn.run(sql, [...values, now, id, companyId]);
    return { id, ...data, updated_at: now };
  }

  delete(id, companyId) {
    const sql = `DELETE FROM ${this.tableName} WHERE id = ? AND company_id = ?;`;
    const result = this.conn.run(sql, [id, companyId]);
    return result.changes > 0;
  }

  getPrefix() {
    return this.tableName.substring(0, 4);
  }
}

module.exports = { BaseRepository };
