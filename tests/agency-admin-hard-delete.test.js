const fs = require('node:fs');
const path = require('node:path');
const { createDisposableDb } = require('../scripts/assert-disposable-db');

const { dbPath } = createDisposableDb({
  suite: 'agency-admin-hard-delete.test.js',
  source: path.join(__dirname, '../data/blackstack-crm.db'),
});
process.env.DB_PATH = dbPath;
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_PROJECT_REF']) delete process.env[key];

const db = require('../server/utils/db').getConn();
db.exec(fs.readFileSync(path.join(__dirname, '../server/database/migrations/094_admin_identity_cleanup_queue.sql'), 'utf8'));
const { AgencyControlService } = require('../server/services/agencyControl.service');
const service = new AgencyControlService(db);

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
  db.run('INSERT OR IGNORE INTO users (id, company_id, username, email, password_hash, full_name, role, status) VALUES (?,?,?,?,?,?,?,?)',
    [userId, companyId, name.toLowerCase(), email, 'test-hash', name, 'AGENCY_ADMIN', 'ACTIVE']);
  db.run('INSERT OR IGNORE INTO agency_administrators (id, agency_id, user_id, company_id, role_code, status) VALUES (?,?,?,?,?,?)',
    [`aad_${name.toLowerCase()}`, agencyId, userId, companyId, 'AGENCY_ADMIN', 'ACTIVE']);
  return { userId, agencyId };
}

describe('agency administrator identity lifecycle (disposable SQLite, Supabase disabled)', () => {
  it('creates, rejects an active duplicate, blocks dependencies, hard-deletes, and permits recreation', async () => {
    const owner = makeAgencyAdmin('AuditOwner', 'audit-owner@example.test');
    const child = await service.createSubAgency(owner.userId, { name: 'Admin Audit Child' });
    const payload = {
      fullName: 'Temporary Audit User',
      email: 'test_audit_123@domain.com',
      username: 'test_audit_123',
      password: 'TemporaryAuditPass!123',
    };

    const first = await service.addSubAgencyAdmin(owner.userId, child.id, payload);
    const link = db.get('SELECT id, user_id FROM agency_administrators WHERE id = ?', [first.id]);
    expect(db.get('SELECT status FROM users WHERE id = ?', [link.user_id]).status).toBe('ACTIVE');

    await expect(service.addSubAgencyAdmin(owner.userId, child.id, payload))
      .rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    await expect(service.permanentlyDeleteAdministrator('usr_beta', first.id))
      .rejects.toMatchObject({ status: 403, code: 'AUTHORIZATION_ERROR' });

    db.run("UPDATE users SET status='INACTIVE' WHERE id=?", [link.user_id]);
    db.run("UPDATE agency_administrators SET status='REVOKED', revoked_at=CURRENT_TIMESTAMP WHERE id=?", [first.id]);
    const reactivated = await service.addSubAgencyAdmin(owner.userId, child.id, payload);
    expect(reactivated.id).toBe(first.id);
    expect(db.get('SELECT status FROM users WHERE id=?', [link.user_id]).status).toBe('ACTIVE');
    expect(db.get('SELECT status FROM agency_administrators WHERE id=?', [first.id]).status).toBe('ACTIVE');

    const contact = db.get('SELECT id FROM contacts LIMIT 1');
    expect(contact).toBeTruthy();
    db.run('INSERT INTO customers (id, company_id, contact_id, account_manager_id) VALUES (?,?,?,?)',
      ['cust_admin_delete_blocker', 'default', contact.id, link.user_id]);
    await expect(service.permanentlyDeleteAdministrator(owner.userId, first.id))
      .rejects.toMatchObject({ status: 409, code: 'ENTITY_HAS_DEPENDENCIES' });
    expect(db.get('SELECT id FROM users WHERE id = ?', [link.user_id])).toBeTruthy();

    db.run('DELETE FROM customers WHERE id = ?', ['cust_admin_delete_blocker']);
    await expect(service.permanentlyDeleteAdministrator(owner.userId, first.id)).resolves.toMatchObject({ deleted: true });
    expect(db.get('SELECT id FROM users WHERE id = ?', [link.user_id])).toBeUndefined();
    expect(db.get('SELECT id FROM agency_administrators WHERE id = ?', [first.id])).toBeUndefined();
    expect(db.get("SELECT phase FROM admin_identity_cleanup_queue WHERE agency_admin_id = ?", [first.id]).phase).toBe('COMPLETE');

    const recreated = await service.addSubAgencyAdmin(owner.userId, child.id, payload);
    expect(recreated.id).not.toBe(first.id);
    expect(db.get('SELECT status FROM users WHERE email = ?', [payload.email]).status).toBe('ACTIVE');
  });
});
