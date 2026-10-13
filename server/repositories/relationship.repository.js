const { BaseRepository } = require('./BaseRepository');

class RelationshipRepository extends BaseRepository {
  constructor(conn) {
    super(conn, 'relationships');
  }

  listByContact(companyId, contactId) {
    return this.conn.all('SELECT * FROM relationships WHERE company_id = ? AND (person_a_id = ? OR person_b_id = ?) ORDER BY created_at DESC;', [companyId, contactId, contactId]);
  }

  listByOrganization(companyId, organizationId) {
    return this.conn.all('SELECT * FROM relationships WHERE company_id = ? AND organization_id = ? ORDER BY created_at DESC;', [companyId, organizationId]);
  }

  search(companyId, options = {}) {
    const where = ['company_id = ?'];
    const params = [companyId];
    if (options.relationshipType) { where.push('relationship_type = ?'); params.push(options.relationshipType); }
    if (options.status) { where.push('status = ?'); params.push(options.status); }
    if (options.organizationId) { where.push('organization_id = ?'); params.push(options.organizationId); }
    if (options.contactId) { where.push('(person_a_id = ? OR person_b_id = ?)'); params.push(options.contactId, options.contactId); }

    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const items = this.conn.all(`SELECT * FROM relationships WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?;`, [...params, limit, offset]);
    const row = this.conn.get(`SELECT COUNT(*) AS total FROM relationships WHERE ${where.join(' AND ')};`, params);
    return { items, total: row?.total || 0 };
  }
}

module.exports = { RelationshipRepository };