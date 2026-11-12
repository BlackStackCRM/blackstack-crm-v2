const { refreshMotherCompanyPermissions } = require('../server/middleware/auth');

describe('Mother Company session permission refresh', () => {
  it('replaces stale Mother Company JWT grants with current role grants', () => {
    const db = {
      all(sql) {
        if (sql.includes('SELECT r.id')) {
          return [{ id: 'role_admin', code: 'ADMIN' }, { id: 'role_mother_company', code: 'MOTHER_COMPANY' }];
        }
        if (sql.includes('SELECT DISTINCT p.code')) {
          return [{ code: 'mother_company.view' }, { code: 'mother_company.agencies.view' }, { code: 'crm.view' }];
        }
        return [];
      },
    };
    const session = {
      userId: 'admin',
      permissions: ['*', 'mother_company.retired_permission', 'dashboard.view'],
    };

    refreshMotherCompanyPermissions(session, db);

    expect(session.permissions).toEqual([
      '*',
      'dashboard.view',
      'mother_company.view',
      'mother_company.agencies.view',
    ]);
  });
});
