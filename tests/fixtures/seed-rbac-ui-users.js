// Seed UI-only role accounts into an explicitly disposable SQLite clone.
// Never points at Supabase and refuses paths outside the system temp directory.
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const { assertDisposableDb } = require('../../scripts/assert-disposable-db');

const dbPath = assertDisposableDb(process.env.DB_PATH, { suite: 'RBAC UI fixture seeder' });
const tempRoot = path.resolve(process.env.TEMP || process.env.TMP || os.tmpdir()).toLowerCase();
if (!path.resolve(dbPath).toLowerCase().startsWith(tempRoot + path.sep)) {
  throw new Error(`Refusing to seed role fixtures outside the temp directory: ${dbPath}`);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');
const passwordHash = bcrypt.hashSync('RBAC-UI-Test-Password!2026', 10);
const ids = {
  rootCompany: 'cmp_e2e_rbac_ui_root',
  subCompany: 'cmp_e2e_rbac_ui_sub',
  customerCompany: 'cmp_e2e_rbac_ui_customer',
  rootAgency: 'agy_e2e_rbac_ui_root',
  subAgency: 'agy_e2e_rbac_ui_sub',
  agencyUser: 'usr_e2e_rbac_ui_agency',
  subUser: 'usr_e2e_rbac_ui_sub',
  customerUser: 'usr_e2e_rbac_ui_customer',
};

const insertCompany = db.prepare("INSERT OR IGNORE INTO companies (id,name,status) VALUES (?,?,'ACTIVE')");
insertCompany.run(ids.rootCompany, 'RBAC UI E2E Agency');
insertCompany.run(ids.subCompany, 'RBAC UI E2E Sub-agency');
insertCompany.run(ids.customerCompany, 'RBAC UI E2E Customer');

const insertAgency = db.prepare(
  "INSERT OR IGNORE INTO agencies (id,company_id,provider_company_id,name,agency_code,status) VALUES (?,?, 'default',?,?,?)",
);
insertAgency.run(ids.rootAgency, ids.rootCompany, 'RBAC UI E2E Agency', 'AGY-E2ERBACUI', 'ACTIVE');
insertAgency.run(ids.subAgency, ids.subCompany, 'RBAC UI E2E Sub-agency', 'SUB-E2ERBACUI', 'TERMINATED');
// Keep role fixtures outside the operational test hierarchy: the legacy full
// suite edits/removes existing child agencies, while this spec only verifies
// role-scoped rendering and direct-route navigation.

const insertUser = db.prepare(
  `INSERT OR REPLACE INTO users
   (id,company_id,username,email,password_hash,full_name,role,status,hierarchy_role,parent_user_id,must_change_password)
   VALUES (?,?,?,?,?,?,?,'ACTIVE',?,?,0)`,
);
insertUser.run(ids.agencyUser, ids.rootCompany, 'rbac-ui-agency', 'rbac-ui-agency@example.test', passwordHash, 'RBAC UI Agency', 'AGENCY', 'agency', null);
// Deliberately stale hierarchy_role: the active SUB-* agency link must keep
// this account classified as sub_agency and must never grant root agency UI.
insertUser.run(ids.subUser, ids.subCompany, 'rbac-ui-subagency', 'rbac-ui-subagency@example.test', passwordHash, 'RBAC UI Sub-agency', 'AGENCY_ADMIN', 'agency', ids.agencyUser);
insertUser.run(ids.customerUser, ids.customerCompany, 'rbac-ui-customer', 'rbac-ui-customer@example.test', passwordHash, 'RBAC UI Customer', 'USER', 'customer_tenant', ids.subUser);

const insertAdmin = db.prepare(
  `INSERT OR REPLACE INTO agency_administrators
   (id,agency_id,user_id,company_id,role_code,assigned_by,status)
   VALUES (?,?,?,?,? ,?,'ACTIVE')`,
);
insertAdmin.run('aad_e2e_rbac_ui_agency', ids.rootAgency, ids.agencyUser, ids.rootCompany, 'AGENCY_ADMIN', ids.agencyUser);
insertAdmin.run('aad_e2e_rbac_ui_sub', ids.subAgency, ids.subUser, ids.subCompany, 'AGENCY_ADMIN', ids.agencyUser);
db.prepare('INSERT OR REPLACE INTO customer_tenant_agencies (company_id,agency_id,provider_company_id,assigned_by) VALUES (?,?,?,?)')
  .run(ids.customerCompany, ids.rootAgency, ids.rootCompany, ids.subUser);

const platformHash = bcrypt.hashSync('admin123', 10);
const admin = db.prepare("SELECT id FROM users WHERE email='admin@blackstack.local'").get();
if (!admin) throw new Error('The cloned seed database has no admin@blackstack.local test operator.');
db.prepare("UPDATE users SET password_hash=?,status='ACTIVE' WHERE id=?").run(platformHash, admin.id);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
console.log(`Seeded disposable RBAC UI users in ${dbPath}`);
