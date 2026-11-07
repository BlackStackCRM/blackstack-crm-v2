const { findAuthUserByEmail, ensureAgencyAuthUser } = require('../server/services/agency-admin-auth');

describe('agency Auth directory lookup', () => {
  it('paginates until it finds a case-insensitive email match', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, i) => ({ id: `page1-${i}`, email: `user${i}@example.test` }));
    const listUsers = vi.fn(async ({ page }) => ({
      data: { users: page === 1 ? firstPage : [{ id: 'auth-existing', email: 'JINU123@gmail.com', app_metadata: {} }] },
      error: null,
    }));
    const client = { auth: { admin: { listUsers } } };

    await expect(findAuthUserByEmail(client, 'jinu123@gmail.com')).resolves.toMatchObject({ id: 'auth-existing' });
    expect(listUsers).toHaveBeenNthCalledWith(1, { page: 1, perPage: 1000 });
    expect(listUsers).toHaveBeenNthCalledWith(2, { page: 2, perPage: 1000 });
  });

  it('returns 409 for an Auth identity already linked to a different agency', async () => {
    const client = { auth: { admin: { listUsers: vi.fn(async () => ({
      data: { users: [{ id: 'auth-user', email: 'owner@example.test', app_metadata: { role: 'agency', agency_id: 'agency-one' } }] },
      error: null,
    })) } } };
    await expect(ensureAgencyAuthUser(client, {
      email: 'owner@example.test', username: 'owner', password: 'TemporaryPass123!', agencyId: 'agency-two',
    })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
  });
});
