/**
 * AGENCY CONTROL — service-level tests against a DISPOSABLE database clone.
 *
 * Covers: sub-agency creation + hierarchy, scoped listing, status transitions,
 * customer tenant create/reassign/access, duplicate rejection, and cross-tenant
 * isolation (a second agency admin cannot see or touch the first's records —
 * reported as NOT FOUND, never 403).
 *
 * Uses createDisposableDb() per project convention: production is cloned into
 * os.tmpdir() and DB_PATH re-pointed, so no live row can be reached.
 */

const path = require('node:path');
const { createDisposableDb } = require('../scripts/assert-disposable-db');

const { dbPath: DB_PATH } = createDisposableDb({
  suite: 'agency-control.test.js',
  source: path.join(__dirname, '../data/blackstack-crm.db'),
});

const { AgencyControlService } = require('../server/services/agencyControl.service');
const { getConn } = require('../server/utils/db');

process.env.DB_PATH = DB_PATH;
const db = getConn();
const svc = new AgencyControlService(db);

describe('AgencyControlService (isolated disposable DB)', () => {
// ── Fixtures: two INDEPENDENT agency admins ─────────────────────────────────
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
  db.run('INSERT OR IGNORE INTO users (id, company_id, username, email, full_name, role, status, hierarchy_role) VALUES (?,?,?,?,?,?,?,?)',
    [userId, companyId, name.toLowerCase(), email, name, 'USER', 'ACTIVE', 'agency']);
  db.run('INSERT OR IGNORE INTO agency_administrators (id, agency_id, user_id, company_id, role_code, status) VALUES (?,?,?,?,?,?)',
    [`aad_${name.toLowerCase()}`, agencyId, userId, companyId, 'AGENCY_ADMIN', 'ACTIVE']);
  return userId;
}

let adminA;
let adminB;
let subId;
let customerId;

beforeAll(() => {
  adminA = makeAgencyAdmin('Alpha', 'alpha@agency.test');
  adminB = makeAgencyAdmin('Beta', 'beta@agency.test');
});

it('scope discovery: parent resolves; fresh scope is empty; non-admin gets empty', async () => {
  const scope = await svc.listSubAgencies(adminA);
  expect(scope.parentAgency.name).toBe('Alpha Agency');
  expect(scope.agencies.length).toBe(0);
  expect((await svc.listSubAgencies('usr_nobody')).agencies.length).toBe(0);
});

it('create sub-agency: PENDING, parent linked, non-admin rejected; same-name allowed (audit fix)', async () => {
  const sub = await svc.createSubAgency(adminA, { name: 'Alpha Sub One' });
  subId = sub.id;
  expect(sub.status).toBe('PENDING');
  expect(sub.agencyCode).toMatch(/^SUB-/);
  const rel = db.get('SELECT parent_agency_id FROM agency_parent_relationships WHERE child_agency_id = ?', [subId]);
  expect(rel.parent_agency_id).toBe('agy_alpha');
  // FIX (audit 2026-11-02): duplicate NAMES are allowed by design — identity is
  // the generated agency_code. A case-variant of an existing name must CREATE,
  // not throw (the old global name-uniqueness check caused the UI contradiction).
  const dup = await svc.createSubAgency(adminA, { name: 'alpha sub one' });
  expect(dup.status).toBe('PENDING');
  expect(dup.agencyCode).toMatch(/^SUB-/);
  expect(dup.agencyCode).not.toBe(sub.agencyCode);
  try { await svc.createSubAgency(adminA, { name: '' }); throw new Error('should fail'); }
  catch (e) { expect(e.code).toBe('VALIDATION_ERROR'); expect(e.fields.name).toBeTruthy(); }
  try { await svc.createSubAgency('usr_nobody', { name: 'Rogue' }); throw new Error('should fail'); }
  catch (e) { expect(e.code).toBe('AUTHORIZATION_ERROR'); }
});

it('scoped listing: parent sees the sub-agencies; other admin does not', async () => {
  const scope = await svc.listSubAgencies(adminA);
  expect(scope.agencies.length).toBe(2); // 'Alpha Sub One' + case-variant from the create test
  expect(scope.agencies[0].id).toBe(subId);
  expect((await svc.listSubAgencies(adminB)).agencies.length).toBe(0);
});

it('status transitions: valid move ok; same/invalid/cross-tenant rejected; history written', async () => {
  const updated = await svc.changeSubAgencyStatus(adminA, subId, { status: 'ACTIVE', reason: 'onboarding done' });
  expect(updated.status).toBe('ACTIVE');
  try { await svc.changeSubAgencyStatus(adminA, subId, { status: 'ACTIVE' }); throw new Error('should fail'); } catch { /* same status */ }
  try { await svc.changeSubAgencyStatus(adminA, subId, { status: 'PENDING' }); throw new Error('should fail'); } catch { /* invalid transition */ }
  try { await svc.changeSubAgencyStatus(adminB, subId, { status: 'SUSPENDED' }); throw new Error('should fail'); }
  catch (e) { expect(e.code).toBe('NOT_FOUND'); expect(e.status).toBe(404); }
  expect(db.get('SELECT COUNT(*) c FROM agency_status_history WHERE agency_id = ?', [subId]).c).toBe(1);
});

it('customer tenants: create, list scoped, duplicates and out-of-scope rejected', async () => {
  const c = await svc.createCustomer(adminA, { name: 'Customer Ten Alpha', agencyId: 'agy_alpha' });
  customerId = c.id;
  expect(c.agencyId).toBe('agy_alpha');
  expect(c.status).toBe('ACTIVE');
  expect((await svc.listCustomers(adminA)).customers.length).toBe(1);
  expect((await svc.listCustomers(adminB)).customers.length).toBe(0);
  try { await svc.createCustomer(adminA, { name: 'Customer Ten Alpha', agencyId: 'agy_alpha' }); throw new Error('should fail'); }
  catch (e) { expect(e.code).toBe('VALIDATION_ERROR'); expect(e.fields.name).toBeTruthy(); }
  try { await svc.createCustomer(adminA, { name: 'Rogue Cust', agencyId: 'agy_beta' }); throw new Error('should fail'); }
  catch (e) { expect(e.code).toBe('NOT_FOUND'); expect(e.status).toBe(404); }
});

it('reassign + access: in-scope move ok, out-of-scope 404, toggle persists, invalid value rejected', async () => {
  const sub2 = await svc.createSubAgency(adminA, { name: 'Alpha Sub Two' });
  await svc.changeSubAgencyStatus(adminA, sub2.id, { status: 'ACTIVE' });
  const moved = await svc.reassignCustomer(adminA, customerId, { agencyId: sub2.id });
  expect(moved.agencyId).toBe(sub2.id);
  expect(db.get('SELECT COUNT(*) c FROM customer_tenant_agency_history WHERE company_id = ?', [customerId]).c).toBe(2);
  try { await svc.reassignCustomer(adminB, customerId, { agencyId: 'agy_beta' }); throw new Error('should fail'); }
  catch (e) { expect(e.code).toBe('NOT_FOUND'); expect(e.status).toBe(404); }
  expect((await svc.changeCustomerAccess(adminA, customerId, { status: 'SUSPENDED' })).status).toBe('SUSPENDED');
  expect(db.get('SELECT status FROM companies WHERE id = ?', [customerId]).status).toBe('SUSPENDED');
  try { await svc.changeCustomerAccess(adminA, customerId, { status: 'TERMINATED' }); throw new Error('should fail'); } catch { /* invalid value */ }
  try { await svc.changeCustomerAccess(adminB, customerId, { status: 'ACTIVE' }); throw new Error('should fail'); }
  catch (e) { expect(e.code).toBe('NOT_FOUND'); expect(e.status).toBe(404); }
});

it('hierarchy details and administrator listings enforce agency scope; customer removal retains CRM company data', async () => {
  await expect(svc.getSubAgency(adminB, subId)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  await expect(svc.listSubAgencyAdministrators(adminB, subId)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  await expect(svc.listCustomerAdministrators(adminB, customerId)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

  const removed = await svc.removeHierarchyEntity(adminA, 'customer_tenant', customerId);
  expect(removed).toMatchObject({ id: customerId, deleted: true });
  expect(db.get('SELECT id FROM companies WHERE id=?', [customerId])).toBeTruthy();
  expect(db.get('SELECT company_id FROM customer_tenant_agencies WHERE company_id=?', [customerId])).toBeUndefined();
});

});
