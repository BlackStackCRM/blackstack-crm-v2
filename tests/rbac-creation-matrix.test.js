const { AuthorizationError } = require('../server/utils/errors');
const { assertCanCreate, createChildAccount, CREATION_MATRIX, resolveHierarchyRole } = require('../server/services/rbac.service');

const ownAgency = 'agy_test_parent';
const descendantsOnlyDb = { all: () => [] };

function expectForbidden(fn, message) {
  try {
    fn();
    throw new Error('Expected authorization to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error.status).toBe(403);
    if (message) expect(error.message).toBe(message);
  }
}

describe('account creation role matrix', () => {
  it('does not elevate stale agency metadata when the active assignment is a sub-agency', () => {
    const db = { get: () => ({ agency_code: 'SUB-E2F7QNKY', has_parent: 1 }) };
    const role = resolveHierarchyRole(db, {
      id: 'user-sub-admin', role: 'AGENCY_ADMIN', hierarchy_role: 'agency',
    });
    expect(role).toBe('sub_agency');
    expectForbidden(
      () => assertCanCreate(descendantsOnlyDb, { role, localAgencyId: ownAgency }, { role: 'sub_agency', parentAgencyId: ownAgency }),
      'Sub-agencies do not have permission to create other sub-agencies.',
    );
  });

  it('allows a distribution agency to create a sub-agency and a customer under itself', () => {
    const caller = { role: 'agency', localAgencyId: ownAgency };
    expect(() => assertCanCreate(descendantsOnlyDb, caller, { role: 'sub_agency', parentAgencyId: ownAgency })).not.toThrow();
    expect(() => assertCanCreate(descendantsOnlyDb, caller, { role: 'customer_tenant', parentAgencyId: ownAgency })).not.toThrow();
  });

  it('allows a sub-agency to create a customer under itself', () => {
    const caller = { role: 'sub_agency', localAgencyId: ownAgency };
    expect(() => assertCanCreate(descendantsOnlyDb, caller, { role: 'customer_tenant', parentAgencyId: ownAgency })).not.toThrow();
  });

  it('returns 403 with the required message when a sub-agency tries to create a sub-agency', () => {
    const caller = { role: 'sub_agency', localAgencyId: ownAgency };
    expectForbidden(
      () => assertCanCreate(descendantsOnlyDb, caller, { role: 'sub_agency', parentAgencyId: ownAgency }),
      'Sub-agencies do not have permission to create other sub-agencies.',
    );
  });

  it('rejects the direct account-creation service call before contacting Supabase', async () => {
    await expect(createChildAccount(null, { role: 'sub_agency' }, { targetRole: 'sub_agency' }))
      .rejects.toMatchObject({
        status: 403,
        message: 'Sub-agencies do not have permission to create other sub-agencies.',
      });
  });

  it('prevents agency and sub-agency callers from placing customers under another agency', () => {
    const otherAgency = 'agy_other';
    for (const role of ['agency', 'sub_agency']) {
      expectForbidden(() => assertCanCreate(descendantsOnlyDb, { role, localAgencyId: ownAgency }, {
        role: 'customer_tenant', parentAgencyId: otherAgency,
      }));
    }
  });

  it('blocks customer tenants from every account-creation role', () => {
    const caller = { role: 'customer_tenant', localAgencyId: ownAgency };
    expect(CREATION_MATRIX.customer_tenant).toEqual([]);
    for (const role of ['agency', 'sub_agency', 'customer_tenant']) {
      expectForbidden(() => assertCanCreate(descendantsOnlyDb, caller, { role, parentAgencyId: ownAgency }));
    }
  });
});
