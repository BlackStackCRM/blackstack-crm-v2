const path = require('node:path');
const express = require('express');
const { createDisposableDb } = require('../scripts/assert-disposable-db');

const { dbPath } = createDisposableDb({
  suite: 'rbac-account-creation-api.test.js',
  source: path.join(__dirname, '../data/blackstack-crm.db'),
});
process.env.DB_PATH = dbPath;

const { getConn } = require('../server/utils/db');
const { SessionManager } = require('../server/auth/session');
const db = getConn();
const agencyId = 'agy_rbac_api_sub';
const companyId = 'cmp_rbac_api_sub';
const userId = 'usr_rbac_api_sub';

db.run('INSERT OR IGNORE INTO companies (id,name,status) VALUES (?,?,?)', [companyId, 'RBAC API Sub-agency', 'ACTIVE']);
db.run(
  `INSERT OR IGNORE INTO agencies (id,company_id,provider_company_id,name,agency_code,status)
   VALUES (?,?,?,?,?,?)`,
  [agencyId, companyId, 'default', 'RBAC API Sub-agency', 'SUB-RBACAPI', 'ACTIVE'],
);
db.run(
  `INSERT OR IGNORE INTO users (id,company_id,username,email,password_hash,full_name,role,status,hierarchy_role)
   VALUES (?,?,?,?,?,?,?,?,?)`,
  // Stale hierarchy_role must not elevate an AGENCY_ADMIN assigned to SUB-*.
  [userId, companyId, 'rbac-api-sub', 'rbac-api-sub@example.test', 'not-used', 'RBAC API Sub', 'AGENCY_ADMIN', 'ACTIVE', 'agency'],
);
db.run(
  `INSERT OR IGNORE INTO agency_administrators (id,agency_id,user_id,company_id,role_code,status)
   VALUES (?,?,?,?,?,?)`,
  ['aad_rbac_api_sub', agencyId, userId, companyId, 'AGENCY_ADMIN', 'ACTIVE'],
);

const app = express();
app.use(express.json());
app.use('/api', require('../server/routes/rbac'));
app.use((error, req, res, next) => {
  res.status(error.status || 500).json({
    success: false,
    error: { code: error.code || 'INTERNAL_ERROR', message: error.message },
  });
});

describe('POST /api/accounts/create authorization', () => {
  let server;

  beforeAll(async () => {
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  afterAll(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it('authenticates a sub-agency session and returns 403 for sub-agency creation', async () => {
    const token = SessionManager.createSession(
      { id: userId, email: 'rbac-api-sub@example.test', role: 'AGENCY_ADMIN' },
      { companyId, permissions: ['dashboard.view'] },
    ).token;
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/accounts/create`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'new-sub@example.test',
        role: 'sub_agency',
        parentAgencyId: agencyId,
        password: 'A-valid-test-password-123',
      }),
    });
    const result = await response.json();
    expect(response.status).toBe(403);
    expect(result.error.code).toBe('AUTHORIZATION_ERROR');
    expect(result.error.message).toBe('Sub-agencies do not have permission to create other sub-agencies.');
  });
});
