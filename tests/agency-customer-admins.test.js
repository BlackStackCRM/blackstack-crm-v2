const path = require('node:path');
const { createDisposableDb } = require('../scripts/assert-disposable-db');

const { dbPath } = createDisposableDb({
  suite: 'agency-customer-admins.test.js',
  source: path.join(__dirname, '../data/blackstack-crm.db'),
});
process.env.DB_PATH = dbPath;
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const { getConn, _closeCachedConnection } = require('../server/utils/db');
const { AgencyControlService } = require('../server/services/agencyControl.service');
const { localIdToCloudUuid } = require('../server/services/supabase.service');
const db = getConn();

const ids = {
  agency: 'agy_customer_admin_flow',
  company: 'cmp_customer_admin_flow',
  sourceCustomer: 'cmp_customer_admin_source',
  targetCustomer: 'cmp_customer_admin_target',
  platform: 'usr_customer_admin_platform',
  agencyUser: 'usr_customer_admin_agency',
  customerUser: 'usr_customer_admin_existing',
  dependentUser: 'usr_customer_admin_dependent',
};

db.run("INSERT OR IGNORE INTO companies (id,name,status) VALUES (?,?,'ACTIVE')", [ids.company, 'Customer Admin Test Agency']);
db.run("INSERT OR IGNORE INTO companies (id,name,status) VALUES (?,?,'ACTIVE')", [ids.sourceCustomer, 'Existing Customer Tenant']);
db.run("INSERT OR IGNORE INTO companies (id,name,status) VALUES (?,?,'ACTIVE')", [ids.targetCustomer, 'Selected Customer Tenant']);
db.run(
  "INSERT OR IGNORE INTO agencies (id,company_id,provider_company_id,name,agency_code,status) VALUES (?,?, 'default',?,?, 'ACTIVE')",
  [ids.agency, ids.company, 'Customer Admin Test Agency', 'AGY-CUSTADMINTEST'],
);
db.run(
  `INSERT OR IGNORE INTO users (id,company_id,username,email,password_hash,full_name,role,status,hierarchy_role)
   VALUES (?,?,?,?,'unused','Platform Test','ADMIN','ACTIVE','platform')`,
  [ids.platform, ids.company, 'customer-admin-platform', 'customer-admin-platform@example.test'],
);
db.run(
  `INSERT OR IGNORE INTO users (id,company_id,username,email,password_hash,full_name,role,status,hierarchy_role)
   VALUES (?,?,?,?,'unused','Agency Test','AGENCY','ACTIVE','agency')`,
  [ids.agencyUser, ids.company, 'customer-admin-agency', 'customer-admin-agency@example.test'],
);
db.run(
  `INSERT OR IGNORE INTO agency_administrators (id,agency_id,user_id,company_id,role_code,status)
   VALUES (?,?,?,?,'AGENCY_ADMIN','ACTIVE')`,
  ['aad_customer_admin_agency', ids.agency, ids.agencyUser, ids.company],
);
db.run(
  `INSERT OR IGNORE INTO customer_tenant_agencies (company_id,agency_id,provider_company_id,assigned_by)
   VALUES (?,?,?,?)`,
  [ids.sourceCustomer, ids.agency, ids.company, ids.platform],
);
db.run(
  `INSERT OR IGNORE INTO customer_tenant_agencies (company_id,agency_id,provider_company_id,assigned_by)
   VALUES (?,?,?,?)`,
  [ids.targetCustomer, ids.agency, ids.company, ids.platform],
);
db.run(
  `INSERT OR IGNORE INTO users (id,company_id,username,email,password_hash,full_name,role,status,hierarchy_role)
   VALUES (?,?,?,?,?,'Existing Customer Admin','CUSTOMER_ADMIN','ACTIVE','customer_tenant')`,
  [ids.customerUser, ids.sourceCustomer, 'alen-customer-test', 'alen-customer-test@example.test', 'keep-this-password-hash'],
);

describe('existing customer administrator assignment', () => {
  afterAll(() => _closeCachedConnection());

  it('resolves a cloud UUID for a locally mirrored customer to its local tenant id', async () => {
    const service = new AgencyControlService(db);
    await expect(service.ensureLocalCustomer(ids.platform, localIdToCloudUuid(ids.targetCustomer)))
      .resolves.toBe(ids.targetCustomer);
  });

  it('moves an existing customer login to the selected tenant and preserves its password', async () => {
    const service = new AgencyControlService(db);
    const result = await service.reassignExistingCustomerAdmin(
      ids.platform, ids.targetCustomer, 'ALEN-CUSTOMER-TEST@example.test',
    );
    expect(result).toMatchObject({
      id: ids.customerUser,
      customerId: ids.targetCustomer,
      previousCompanyId: ids.sourceCustomer,
      reassigned: true,
      crmDataRemainsWithPreviousCompany: true,
    });
    expect(db.get('SELECT company_id,role,hierarchy_role,password_hash FROM users WHERE id=?', [ids.customerUser]))
      .toEqual({
        company_id: ids.targetCustomer,
        role: 'CUSTOMER_ADMIN',
        hierarchy_role: 'customer_tenant',
        password_hash: 'keep-this-password-hash',
      });
  });

  it('does not allow an agency operator to move a customer login between tenants', async () => {
    const service = new AgencyControlService(db);
    await expect(service.reassignExistingCustomerAdmin(
      ids.agencyUser, ids.targetCustomer, 'alen-customer-test@example.test',
    )).rejects.toMatchObject({ status: 403 });
  });

  it('returns customer and administrator details, and denies another agency with 403', async () => {
    db.run(
      `INSERT OR IGNORE INTO users (id,company_id,username,email,password_hash,full_name,role,status,hierarchy_role)
       VALUES (?,?,?,?,? ,?,'CUSTOMER_ADMIN','ACTIVE','customer_tenant')`,
      ['usr_customer_details_target', ids.targetCustomer, 'details-target-admin', 'details-target@example.test', 'hash', 'Target Customer Admin'],
    );
    const service = new AgencyControlService(db);
    const details = await service.getCustomerDetails(ids.platform, ids.targetCustomer);
    expect(details).toMatchObject({
      customerName: 'Selected Customer Tenant',
      companyName: 'Selected Customer Tenant',
      parentAgencyName: 'Customer Admin Test Agency',
      status: 'ACTIVE',
    });
    expect(details.administrators).toEqual(expect.arrayContaining([
      expect.objectContaining({ fullName: 'Target Customer Admin', email: 'details-target@example.test', status: 'ACTIVE' }),
    ]));

    const otherCompany = 'cmp_customer_details_other_agency';
    const otherAgency = 'agy_customer_details_other_agency';
    const otherCustomer = 'cmp_customer_details_other_tenant';
    const otherUser = 'usr_customer_details_other_agency';
    db.run("INSERT OR IGNORE INTO companies (id,name,status) VALUES (?,?,'ACTIVE')", [otherCompany, 'Other Agency Company']);
    db.run("INSERT OR IGNORE INTO companies (id,name,status) VALUES (?,?,'ACTIVE')", [otherCustomer, 'Other Agency Customer']);
    db.run("INSERT OR IGNORE INTO agencies (id,company_id,provider_company_id,name,agency_code,status) VALUES (?,?, 'default',?,?, 'ACTIVE')", [otherAgency, otherCompany, 'Other Agency', 'AGY-OTHERDETAILS']);
    db.run("INSERT OR IGNORE INTO users (id,company_id,username,email,password_hash,full_name,role,status,hierarchy_role) VALUES (?,?,?,?,'hash','Other Agency Admin','AGENCY','ACTIVE','agency')", [otherUser, otherCompany, 'other-details-admin', 'other-details@example.test']);
    db.run("INSERT OR IGNORE INTO agency_administrators (id,agency_id,user_id,company_id,role_code,status) VALUES (?,?,?,?,'AGENCY_ADMIN','ACTIVE')", ['aad_customer_details_other', otherAgency, otherUser, otherCompany]);
    db.run("INSERT OR IGNORE INTO customer_tenant_agencies (company_id,agency_id,provider_company_id,assigned_by) VALUES (?,?,?,?)", [otherCustomer, otherAgency, otherCompany, otherUser]);
    await expect(service.getCustomerDetails(ids.agencyUser, otherCustomer))
      .rejects.toMatchObject({ status: 403, code: 'AUTHORIZATION_ERROR' });
  });

  it('blocks permanent removal when dependent records exist, then removes only the login', async () => {
    db.run(
      `INSERT OR IGNORE INTO users (id,company_id,username,email,password_hash,full_name,role,status,hierarchy_role,parent_user_id)
       VALUES (?,?,?,?,'unused','Dependent Login','USER','ACTIVE','customer_tenant',?)`,
      [ids.dependentUser, ids.targetCustomer, 'dependent-customer-login', 'dependent-customer@example.test', ids.customerUser],
    );
    const service = new AgencyControlService(db);
    await expect(service.permanentlyDeleteCustomerAdminByEmail(
      ids.platform, ids.targetCustomer, 'alen-customer-test@example.test',
    )).rejects.toMatchObject({ status: 409, code: 'ENTITY_HAS_DEPENDENCIES' });

    db.run('DELETE FROM users WHERE id=?', [ids.dependentUser]);
    const result = await service.permanentlyDeleteCustomerAdminByEmail(
      ids.platform, ids.targetCustomer, 'alen-customer-test@example.test',
    );
    expect(result).toMatchObject({ id: ids.customerUser, deleted: true, customerDataDeleted: false });
    expect(db.get('SELECT id FROM users WHERE id=?', [ids.customerUser])).toBeUndefined();
    expect(db.get('SELECT id FROM companies WHERE id=?', [ids.targetCustomer])).toBeTruthy();
  });
});
