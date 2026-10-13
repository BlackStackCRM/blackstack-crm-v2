const { BaseRepository } = require('./BaseRepository');

class ContactRepository extends BaseRepository {
  constructor(conn) {
    super(conn, 'contacts');
  }

  search(companyId, options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const orderBy = /^[a-zA-Z0-9_]+$/.test(options.orderBy) ? options.orderBy : 'created_at';
    const orderDir = options.orderDir === 'ASC' ? 'ASC' : 'DESC';

    const where = ['company_id = ?'];
    const params = [companyId];

    if (options.status) { where.push('status = ?'); params.push(options.status); }
    if (options.organizationId) { where.push('organization_id = ?'); params.push(options.organizationId); }
    if (options.search) {
      const search = `%${options.search.toLowerCase()}%`;
      where.push('(LOWER(first_name) LIKE ? OR LOWER(last_name) LIKE ? OR LOWER(email) LIKE ? OR phone LIKE ?)');
      params.push(search, search, search, search);
    }

    const whereSql = where.join(' AND ');
    const items = this.conn.all(`SELECT * FROM contacts WHERE ${whereSql} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?;`, [...params, limit, offset]);
    const row = this.conn.get(`SELECT COUNT(*) AS total FROM contacts WHERE ${whereSql};`, params);
    return { items, total: row?.total || 0 };
  }

  findByEmail(companyId, email) {
    return this.conn.get('SELECT * FROM contacts WHERE company_id = ? AND LOWER(email) = LOWER(?) LIMIT 1;', [companyId, email]);
  }

  listByOrganization(companyId, organizationId) {
    return this.conn.all('SELECT * FROM contacts WHERE company_id = ? AND organization_id = ? ORDER BY first_name ASC, last_name ASC;', [companyId, organizationId]);
  }

  addTag(contactId, tagId) {
    this.conn.run('INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?);', [contactId, tagId]);
  }

  removeTag(contactId, tagId) {
    this.conn.run('DELETE FROM contact_tags WHERE contact_id = ? AND tag_id = ?;', [contactId, tagId]);
  }

  getTags(contactId) {
    return this.conn.all('SELECT t.* FROM tags t JOIN contact_tags ct ON ct.tag_id = t.id WHERE ct.contact_id = ?;', [contactId]);
  }
}

module.exports = { ContactRepository };