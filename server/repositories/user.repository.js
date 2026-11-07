const { BaseRepository } = require('./BaseRepository');

class UserRepository extends BaseRepository {
  constructor(conn) {
    super(conn, 'users');
  }

  async findByEmail(email) {
    return this.conn.get('SELECT * FROM users WHERE email = ? COLLATE NOCASE LIMIT 1', [email]);
  }

  async findByUsername(username) {
    return this.conn.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE LIMIT 1', [username]);
  }

  /** Login identifier: matches email OR username, case-insensitively. */
  async findByIdentifier(identifier) {
    const id = String(identifier || '').trim();
    if (!id) return null;
    return this.conn.get(
      'SELECT * FROM users WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE LIMIT 1',
      [id, id]
    );
  }

  /**
   * Role/permission context is loaded from trusted DB state at login time
   * (JWT Strategy A: authorization claims are embedded, never client-supplied).
   */
  getUserWithRoles(userId) {
    const roles = this.conn.all(`
      SELECT r.id, r.name, r.code FROM roles r
      JOIN user_roles ur ON ur.role_id = r.id
      WHERE ur.user_id = ?
    `, [userId]);
    const roleIds = roles.map(r => r.id);
    let permissions = [];
    if (roleIds.length) {
      const placeholders = roleIds.map(() => '?').join(',');
      permissions = this.conn.all(
        `SELECT DISTINCT p.code FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         WHERE rp.role_id IN (${placeholders})`, roleIds
      ).map(p => p.code);
    }
    // Keep explicitly assigned permissions (including Mother Company grants)
    // alongside the CRM-wide admin wildcard. Control-plane middleware checks
    // for a named grant and deliberately ignores '*'.
    if (roles.some(r => r.code === 'ADMIN')) permissions = Array.from(new Set([...permissions, '*']));
    return { roles, permissions };
  }

  updateLastLogin(userId) {
    this.conn.run('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?',
      [new Date().toISOString(), new Date().toISOString(), userId]);
  }

  updateUser(id, companyId, data) {
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    this.conn.run(`UPDATE users SET ${sets}, updated_at = ? WHERE id = ? AND company_id = ?`,
      [...Object.values(data), new Date().toISOString(), id, companyId]);
    return { id, ...data };
  }

  async search(options = {}) {
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    const where = ['1 = 1'];
    const params = [];

    if (options.query) {
      where.push('(LOWER(full_name) LIKE ? OR LOWER(email) LIKE ?)');
      params.push(`%${options.query.toLowerCase()}%`, `%${options.query.toLowerCase()}%`);
    }
    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }

    const whereStr = where.join(' AND ');
    const countSql = `SELECT COUNT(*) as total FROM users WHERE ${whereStr}`;
    const countRow = this.conn.get(countSql, params);
    const total = countRow?.total || 0;

    const listSql = `SELECT id, email, full_name, role, status, last_login_at, created_at FROM users WHERE ${whereStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const items = this.conn.all(listSql, [...params, limit, offset]);

    return { items, total };
  }
}

module.exports = { UserRepository };
