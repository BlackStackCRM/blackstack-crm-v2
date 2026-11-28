/**
 * Phase 73 — trusted provisioning helper tests (mocked fetch; no network).
 * Verifies the desktop delegates to the trusted endpoint with the caller JWT and
 * the anon apikey (never a service role), maps errors to AppError, and that the
 * gate is off when SUPABASE_PROVISION_URL is unset.
 */
const prov = require('../server/services/agency-admin-provision');

const OLD = { ...process.env };

beforeEach(() => {
  delete process.env.SUPABASE_PROVISION_URL;
  delete process.env.SUPABASE_ANON_KEY;
  global.fetch = vi.fn();
});
afterEach(() => {
  process.env.SUPABASE_PROVISION_URL = OLD.SUPABASE_PROVISION_URL;
  process.env.SUPABASE_ANON_KEY = OLD.SUPABASE_ANON_KEY;
  delete global.fetch;
});

describe('agency-admin-provision (Phase 73)', () => {
  it('gate is OFF when SUPABASE_PROVISION_URL is unset', () => {
    expect(prov.isProvisioningConfigured()).toBe(false);
  });

  it('gate is ON when SUPABASE_PROVISION_URL is set', () => {
    process.env.SUPABASE_PROVISION_URL = 'https://x.supabase.co/functions/v1/provision-agency-admin';
    expect(prov.isProvisioningConfigured()).toBe(true);
  });

  it('posts to the endpoint with caller JWT + anon apikey and returns the user', async () => {
    process.env.SUPABASE_PROVISION_URL = 'https://x.supabase.co/functions/v1/provision-agency-admin/';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    global.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ user: { id: 'u_123', email: 'a@b.c' }, created: true }) });

    const out = await prov.provisionAgencyAuthUser({ email: 'a@b.c', password: 'password123', agencyId: 'agy_1', callerJwt: 'jwt-abc' });
    expect(out.user.id).toBe('u_123');
    expect(out.created).toBe(true);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://x.supabase.co/functions/v1/provision-agency-admin');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer jwt-abc');
    expect(opts.headers.apikey).toBe('anon-key');
    expect(JSON.parse(opts.body)).toMatchObject({ email: 'a@b.c', agencyId: 'agy_1' });
  });

  it('maps an error response to an AppError with the server code/status', async () => {
    process.env.SUPABASE_PROVISION_URL = 'https://x/functions/v1/provision-agency-admin';
    global.fetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: { code: 'CONFLICT', message: 'already assigned' } }) });
    await expect(prov.provisionAgencyAuthUser({ email: 'a@b.c', password: 'password123', agencyId: 'agy_1', callerJwt: 'j' }))
      .rejects.toMatchObject({ code: 'CONFLICT', status: 409, message: 'already assigned' });
  });

  it('rollback swallows failures and returns ok:false', async () => {
    process.env.SUPABASE_PROVISION_URL = 'https://x/functions/v1/provision-agency-admin';
    global.fetch.mockRejectedValue(new Error('network down'));
    const out = await prov.rollbackProvisionedUser({ userId: 'u_123', callerJwt: 'j' });
    expect(out.ok).toBe(false);
  });

  it('provisioning throws PROVISION_NOT_CONFIGURED when called unconfigured', async () => {
    await expect(prov.provisionAgencyAuthUser({ email: 'a@b.c', password: 'password123', agencyId: 'a', callerJwt: 'j' }))
      .rejects.toMatchObject({ code: 'PROVISION_NOT_CONFIGURED' });
  });
});