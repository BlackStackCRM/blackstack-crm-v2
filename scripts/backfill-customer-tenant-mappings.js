// throwaway: backfill missing customer_tenant_agencies rows from the users table
require('dotenv').config({ quiet: true });
const { DatabaseConnection } = require('../server/database/connection');
const { generateId } = require('../server/utils/generateId');
const db = new DatabaseConnection().connect();

const orphans = db.all(
  `SELECT u.id AS user_id, u.email, u.company_id, u.parent_user_id
   FROM users u
   WHERE u.hierarchy_role = 'customer_tenant'
     AND NOT EXISTS (SELECT 1 FROM customer_tenant_agencies cta WHERE cta.company_id = u.company_id)`,
);
console.log('orphan customer tenants:', orphans.length);
for (const o of orphans) {
  // Derive the owning agency from the parent user's agency link (never hardcoded).
  let agencyId = null;
  if (o.parent_user_id) {
    const link = db.get(
      "SELECT agency_id FROM agency_administrators WHERE user_id = ? AND status = 'ACTIVE' LIMIT 1",
      [o.parent_user_id],
    );
    if (link) agencyId = link.agency_id;
  }
  if (!agencyId) {
    // fall back to an agency sharing the parent's tenant company
    const pu = o.parent_user_id ? db.get('SELECT company_id FROM users WHERE id = ?', [o.parent_user_id]) : null;
    if (pu) {
      const byCompany = db.get('SELECT id FROM agencies WHERE company_id = ? LIMIT 1', [pu.company_id]);
      if (byCompany) agencyId = byCompany.id;
    }
  }
  if (!agencyId) { console.log('SKIP', o.email, '- no resolvable parent agency'); continue; }

  // provider company = the parent agency's own tenant company
  const pa = db.get('SELECT company_id FROM agencies WHERE id = ?', [agencyId]);
  const provider = (pa && pa.company_id) || 'default';
  db.transaction(() => {
    db.run(
      'INSERT OR IGNORE INTO customer_tenant_agencies (company_id, agency_id, provider_company_id, assigned_by) VALUES (?,?,?,?)',
      [o.company_id, agencyId, provider, o.parent_user_id],
    );
    db.run(
      'INSERT INTO customer_tenant_agency_history (id, company_id, old_agency_id, new_agency_id, changed_by) VALUES (?,?,?,?,?)',
      [generateId('ctah'), o.company_id, null, agencyId, o.parent_user_id],
    );
  })();
  console.log('BACKFILLED', o.email, '→ agency', agencyId);
}
console.log('done');
