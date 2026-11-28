import crypto from 'node:crypto';
import { verifyAppJwt, authorizeCallerLive } from '../supabase/functions/provision-agency-admin/jwt.ts';

const SECRET = 'test-secret-value-at-least-32-bytes-long!!';
const ISS = 'blackstack-crm';
const AUD = 'blackstack-crm-desktop';

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function sign(payload, secret = SECRET, header = { alg: 'HS256', typ: 'JWT' }) {
  const h = b64url(header);
  const p = b64url(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}
function basePayload(overrides = {}) {
  return {
    userId: 'u1',
    email: 'mc@blackstack.local',
    role: 'ADMIN',
    companyId: 'c1',
    permissions: ['*'],
    iss: ISS,
    aud: AUD,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function makeAdmin({ users = [], listError = null, profile = null, profileError = null } = {}) {
  return {
    auth: { admin: { listUsers: async () => ({ data: { users }, error: listError }) } },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: profile, error: profileError }) }),
      }),
    }),
  };
}

describe('provision-agency-admin jwt (Phase 76)', () => {
  it('accepts a valid HS256 token with correct issuer/audience/exp', async () => {
    const p = await verifyAppJwt(sign(basePayload()), SECRET);
    expect(p.userId).toBe('u1');
  });

  it('rejects an invalid signature', async () => {
    const p = await verifyAppJwt(sign(basePayload(), 'the-wrong-secret-value-at-least-32!!'), SECRET);
    expect(p).toBeNull();
  });

  it('rejects an expired token', async () => {
    const p = await verifyAppJwt(sign(basePayload({ exp: Math.floor(Date.now() / 1000) - 10 })), SECRET);
    expect(p).toBeNull();
  });

  it('rejects a malformed base64url signature without throwing', async () => {
    const t = sign(basePayload());
    const broken = `${t.slice(0, t.lastIndexOf('.') + 1)}!!!`;
    await expect(verifyAppJwt(broken, SECRET)).resolves.toBeNull();
  });

  it('rejects garbage and alg:none tokens', async () => {
    await expect(verifyAppJwt('not.a.jwt', SECRET)).resolves.toBeNull();
    await expect(verifyAppJwt(sign(basePayload(), SECRET, { alg: 'none', typ: 'JWT' }), SECRET)).resolves.toBeNull();
  });

  it('rejects a missing caller identity (fail closed)', async () => {
    const r = await authorizeCallerLive(makeAdmin({ users: [] }), basePayload());
    expect(r).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
  });

  it('rejects a disabled (inactive) account', async () => {
    const admin = makeAdmin({ users: [{ id: 'a1', email: 'mc@blackstack.local', disabled: true }] });
    const r = await authorizeCallerLive(admin, basePayload());
    expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('rejects a banned account', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const admin = makeAdmin({ users: [{ id: 'a1', email: 'mc@blackstack.local', banned_until: future }] });
    const r = await authorizeCallerLive(admin, basePayload());
    expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('rejects a revoked administrator (profiles.is_active=false)', async () => {
    const admin = makeAdmin({
      users: [{ id: 'a1', email: 'mc@blackstack.local' }],
      profile: { role: 'agency', is_active: false },
    });
    const r = await authorizeCallerLive(admin, basePayload());
    expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('rejects a demoted administrator (live role no longer admin)', async () => {
    const admin = makeAdmin({
      users: [{ id: 'a1', email: 'mc@blackstack.local', app_metadata: { role: 'agency' } }],
      profile: null,
    });
    const r = await authorizeCallerLive(admin, basePayload());
    expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('fails closed when the live auth lookup errors', async () => {
    const admin = makeAdmin({ listError: { message: 'boom' } });
    const r = await authorizeCallerLive(admin, basePayload());
    expect(r).toMatchObject({ ok: false, code: 'SUPABASE_AUTH_LOOKUP_FAILED' });
  });

  it('fails closed when the live profile lookup errors', async () => {
    const admin = makeAdmin({
      users: [{ id: 'a1', email: 'mc@blackstack.local' }],
      profileError: { message: 'boom' },
    });
    const r = await authorizeCallerLive(admin, basePayload());
    expect(r).toMatchObject({ ok: false, code: 'SUPABASE_AUTH_LOOKUP_FAILED' });
  });

  it('authorizes a live platform operator', async () => {
    const admin = makeAdmin({
      users: [{ id: 'a1', email: 'mc@blackstack.local', app_metadata: { role: 'platform' } }],
    });
    const r = await authorizeCallerLive(admin, basePayload());
    expect(r).toMatchObject({ ok: true, live: true, role: 'platform' });
  });

  it('denies when no live role can be confirmed (no claims fallback)', async () => {
    const admin = makeAdmin({ users: [{ id: 'a1', email: 'mc@blackstack.local' }] });
    const r = await authorizeCallerLive(admin, basePayload());
    expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('authorizes when profiles.role is an admin role', async () => {
    const admin = makeAdmin({
      users: [{ id: 'a1', email: 'mc@blackstack.local' }],
      profile: { role: 'mother_company', is_active: true },
    });
    const r = await authorizeCallerLive(admin, basePayload());
    expect(r).toMatchObject({ ok: true, live: true, role: 'mother_company' });
  });

  it('denies when the live role is a non-admin agency role', async () => {
    const admin = makeAdmin({
      users: [{ id: 'a1', email: 'mc@blackstack.local' }],
      profile: { role: 'agency', is_active: true },
    });
    const r = await authorizeCallerLive(admin, basePayload());
    expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });
});