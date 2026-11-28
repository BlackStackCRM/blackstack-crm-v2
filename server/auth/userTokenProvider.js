/**
 * REQUEST-SCOPED SUPABASE USER ACCESS TOKEN
 *
 * The desktop login verifies credentials with signInWithPassword and persists
 * the Supabase refresh token (encrypted, main process). This module exchanges
 * that refresh token for a short-lived access token on demand so server-side
 * Supabase reads can run under the user's own JWT and satisfy RLS
 * (auth.uid() = the caller).
 *
 * The token is cached in memory until shortly before expiry. No token value is
 * logged. There is NO local/offline authentication fallback: if a token cannot
 * be obtained, callers fall back to the existing (RLS-restricted) client.
 */

const { refreshCloudSession } = require('./sessionRecovery');

let cached = null; // { token, expiresAt }

function resetCache() {
  cached = null;
}

async function getUserAccessToken() {
  const now = Date.now();
  if (cached && cached.expiresAt > now + 30_000) return cached.token;

  const sink = require('./refreshTokenSink');
  const { getSupabaseUrl, getAnonKey } = require('../config/supabase');
  const supabaseUrl = getSupabaseUrl();
  const anonKey = getAnonKey();
  if (!supabaseUrl || !anonKey) return null;

  const session = await refreshCloudSession({
    getStoredRefreshToken: () => sink.loadRefreshToken(),
    saveStoredRefreshToken: (t) => sink.persistRefreshToken(t),
    clearStoredRefreshToken: () => sink.clearRefreshToken(),
    supabaseUrl,
    anonKey,
  });
  if (!session || !session.access_token) {
    cached = null;
    return null;
  }
  cached = {
    token: session.access_token,
    expiresAt: now + Math.max(60, (session.expires_in || 3600) - 60) * 1000,
  };
  return cached.token;
}

module.exports = { getUserAccessToken, resetCache };