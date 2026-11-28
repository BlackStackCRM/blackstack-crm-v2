process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'anon';

const sink = require('../server/auth/refreshTokenSink');
const provider = require('../server/auth/userTokenProvider');

function makeSink(initial) {
  let stored = initial || null;
  return {
    save: (t) => { stored = t; },
    load: () => stored,
    clear: () => { stored = null; },
    get: () => stored,
  };
}

beforeEach(() => {
  sink.setRefreshTokenSink(null);
  provider.resetCache();
  global.fetch = undefined;
});

describe('request-scoped token bridge', () => {
  it('persists, loads and clears through the registered sink', () => {
    const s = makeSink(null);
    sink.setRefreshTokenSink(s);
    expect(sink.persistRefreshToken('refresh-1')).toBe(true);
    expect(sink.loadRefreshToken()).toBe('refresh-1');
    expect(sink.clearRefreshToken()).toBe(true);
    expect(sink.loadRefreshToken()).toBeNull();
  });

  it('returns null when no refresh token is stored (no offline fallback)', async () => {
    sink.setRefreshTokenSink(makeSink(null));
    await expect(provider.getUserAccessToken()).resolves.toBeNull();
  });

  it('mints an access token and caches it (single refresh call)', async () => {
    const s = makeSink('refresh-1');
    sink.setRefreshTokenSink(s);
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ access_token: 'access-1', refresh_token: 'refresh-2', expires_in: 3600, user: { id: 'u1', email: 'e@x' } }),
      };
    };
    await expect(provider.getUserAccessToken()).resolves.toBe('access-1');
    await expect(provider.getUserAccessToken()).resolves.toBe('access-1');
    expect(calls).toBe(1);
    expect(s.get()).toBe('refresh-2');
  });

  it('returns null and clears the session when refresh is rejected', async () => {
    const s = makeSink('refresh-1');
    sink.setRefreshTokenSink(s);
    global.fetch = async () => ({ ok: false, json: async () => ({}) });
    await expect(provider.getUserAccessToken()).resolves.toBeNull();
    expect(s.get()).toBeNull();
  });
});