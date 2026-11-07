/**
 * Tenant-scoped reference validation.
 * Ensures any contact/organization ID supplied by a client belongs to the
 * caller's company before it is written to a related table.
 */
const { ValidationError } = require('./errors');

const TABLES = {
  contacts: { label: 'Contact' },
  organizations: { label: 'Organization' },
};

/**
 * @param {object} conn - sqlite connection
 * @param {string} companyId - req.user.companyId
 * @param {'contacts'|'organizations'} table
 * @param {string|null} id - reference supplied by client (null/'' allowed)
 * @throws ValidationError when the reference does not exist in this tenant
 */
function assertTenantRef(conn, companyId, table, id) {
  if (!id) return;
  const meta = TABLES[table];
  if (!meta) throw new Error(`Unknown table ${table}`);
  const row = conn.get(`SELECT id FROM ${table} WHERE id = ? AND company_id = ? LIMIT 1`, [id, companyId]);
  if (!row) {
    throw new ValidationError(`${meta.label} ${id} does not exist in your company`);
  }
}

/** Validate a set of references: { contact_id: ..., organization_id: ... } */
function assertTenantRefs(conn, companyId, refs = {}) {
  const safe = refs && typeof refs === 'object' ? refs : {};
  assertTenantRef(conn, companyId, 'contacts', safe.contact_id);
  assertTenantRef(conn, companyId, 'organizations', safe.organization_id);
}

module.exports = { assertTenantRef, assertTenantRefs };
