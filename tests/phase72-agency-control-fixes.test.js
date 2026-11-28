/**
 * PHASE 72 — regression tests for the Agency Control fixes.
 *
 * Isolated disposable DB clone (createDisposableDb) — never touches production.
 *
 * Covers:
 *   - F71-02: createSubAgency is transactional (success writes company + agency
 *     + parent link together; a rejected create leaves NO partial rows).
 *   - F71-04: customer duplicate-name is tenant-scoped (same name allowed under
 *     a DIFFERENT agency, rejected twice under the SAME agency).
 */
const path = require('node:path');
const { createDisposableDb } = require('../scripts/assert-disposable-db');

const { dbPath: DB_PATH } = createDisposableDb({
  suite: 'phase72-agency-control-fixes.test.js',
  source: path.join(__dirname, '../data/blackstack-crm.db'),
});

const { AgencyControlService } = require('../server/services/agencyControl.service');
const { getConn } = require('../server/utils/db');

process.env.DB_PATH = DB_PATH;
const db = getConn();
const svc = new AgencyControlService(db);

function makeAgencyAdmin(name, email) {
  const userId = `usr_${name.toLowerCase()}`;
  const agencyId = `agy_${name.toLowerCase()}`;
  const companyId = `company_${agencyId}`;
  db.run('INSERT OR IGNORE INTO companies (id, name, status) VALUES (?,?,?)', [companyId, `${name} Company`, 'ACTIVE']);
  db.run(
    `INSERT OR IGNORE INTO agencies (id, company_id, provider_company_id, agency_code, name, status, is_active)
     VALUES (?,?,?,?,?,?,1)`,
    [agencyId, companyId, 'default', `AGY-${name.toUpperCase()}`, `${name} Agency`, 'ACTIVE'],
  );
  db.run('INSERT OR IGNORE INTO users (id, company_id, username, email, password_hash, full_name, role, status, hierarchy_role) VALUES (?,?,?,?,?,?,?,?,?)',
    [userId, companyId, name.toLowerCase(), email, 'not-a-real-password-hash', name, 'USER', 'ACTIVE', 'agency']);
  db.run('INSERT OR IGNORE INTO agency_administrators (id, agency_id, user_id, company_id, role_code, status) VALUES (?,?,?,?,?,?)',
    [`aad_${name.toLowerCase()}`, agencyId, userId, companyId, 'AGENCY_ADMIN', 'ACTIVE']);
  return userId;
}

describe('Phase 72 — Agency Control fixes (isolated disposable DB)', () => {
  let adminA;

  beforeAll(() => {
    adminA = makeAgencyAdmin('Alpha', 'alpha@agency.test');
  });

  it('F71-02: createSubAgency writes company + agency + parent link together', async () => {
    const sub = await svc.createSubAgency(adminA, { name: 'Tx Sub One' });
    expect(sub.status).toBe('PENDING');
    const agency = db.get('SELECT * FROM agencies WHERE id = ?', [sub.id]);
    expect(agency).toBeTruthy();
    expect(agency.company_id).toBeTruthy();
    expect(db.get('SELECT id FROM companies WHERE id = ?', [agency.company_id])).toBeTruthy();
    const rel = db.get('SELECT parent_agency_id FROM agency_parent_relationships WHERE child_agency_id = ?', [sub.id]);
    expect(rel.parent_agency_id).toBe('agy_alpha');
  });

  it('F71-02: a rejected createSubAgency leaves NO partial company/agency rows', async () => {
    const before = db.get('SELECT COUNT(*) c FROM agencies').c;
    const beforeCompanies = db.get('SELECT COUNT(*) c FROM companies').c;
    let threw = null;
    try { await svc.createSubAgency(adminA, { name: 'Ghost Sub', parentAgencyId: 'agy_does_not_exist' }); }
    catch (e) { threw = e; }
    expect(threw).toBeTruthy();
    expect(db.get('SELECT COUNT(*) c FROM agencies').c).toBe(before);
    expect(db.get('SELECT COUNT(*) c FROM companies').c).toBe(beforeCompanies);
    expect(db.get("SELECT id FROM agencies WHERE name = 'Ghost Sub'")).toBeUndefined();
  });

  it('F71-04: same customer name is allowed under a DIFFERENT agency, rejected twice under the SAME agency', async () => {
    const sub = await svc.createSubAgency(adminA, { name: 'Cust Scope Sub' });
    const a = await svc.createCustomer(adminA, { name: 'Shared Name', agencyId: 'agy_alpha' });
    expect(a.agencyId).toBe('agy_alpha');
    // Same name under a different (in-scope) agency must be allowed.
    const b = await svc.createCustomer(adminA, { name: 'Shared Name', agencyId: sub.id });
    expect(b.agencyId).toBe(sub.id);
    // Twice under the SAME agency must be rejected.
    let dupErr = null;
    try { await svc.createCustomer(adminA, { name: 'Shared Name', agencyId: 'agy_alpha' }); }
    catch (e) { dupErr = e; }
    expect(dupErr).toBeTruthy();
    expect(dupErr.code).toBe('VALIDATION_ERROR');
    expect(dupErr.fields.name).toBeTruthy();
  });
});