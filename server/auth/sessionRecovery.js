/**
 * SESSION RECOVERY / REFRESH SERVICE (P2.5, audit §26.9 T-03)
 *
 * Restores a cloud session after a device restart or network interruption:
 *   1. Reads the DPAPI-encrypted refresh token from the secure store
 *      (electron/secure-session-store.js — populated via session:save IPC).
 *   2. Exchanges it at the Supabase Auth token endpoint (POST /auth/v1/token)
 *      for a fresh access + refresh pair.
 *   3. Persists the ROTATED refresh token (Supabase rotates on every use;
 *      reuse of an old token invalidates the family — that detection is what
 *      limits replay damage).
 *
 * Fail-closed: no stored token, network error, or refresh rejection all
 * resolve to null — the caller must show the login screen. There is NO local
 * fallback authentication.
 *
 * Runs in the MAIN process (server-side helper invoked through the local
 * API). The plaintext token never reaches the renderer.
 */

// Store file name only — the store module itself lives in electron/ and
// must never be loaded into the server process.
const STORE_FILE = 'cloud-session.bin';

function tokenEndpoint(supabaseUrl) {
  return String(supabaseUrl || '').replace(/\/+$/, '') + '/auth/v1/token?grant_type=refresh_token';
}

/**
 * @param {{getStoredRefreshToken:()=>string|null, saveStoredRefreshToken:(t:string)=>void,
 *          clearStoredRefreshToken:()=>void, supabaseUrl:string, anonKey:string,
 *          fetch?:typeof fetch}} deps  fully injected (testable, no Electron import)
 * @returns {Promise<{access_token:string, refresh_token:string, expires_in:number, user:{id:string,email?:string}}|null>}
 */
async function refreshCloudSession(deps) {
  const stored = deps.getStoredRefreshToken();
  if (!stored) return null;
  if (!deps.supabaseUrl || !deps.anonKey) return null;
  const doFetch = deps.fetch || global.fetch;
  if (!doFetch) return null;

  try {
    const res = await doFetch(tokenEndpoint(deps.supabaseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': deps.anonKey,
        'Authorization': 'Bearer ' + deps.anonKey,
      },
      body: JSON.stringify({ refresh_token: stored }),
    });
    if (!res.ok) {
      // 400 = refresh token reuse/expired -> the whole family is invalidated.
      deps.clearStoredRefreshToken();
      return null;
    }
    const data = await res.json();
    if (!data || !data.access_token || !data.refresh_token || !data.user) return null;
    // Persist the ROTATED refresh token (idempotent overwrite).
    deps.saveStoredRefreshToken(data.refresh_token);
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in || 3600,
      user: { id: data.user.id, email: data.user.email },
    };
  } catch {
    // Network interruption: keep the stored token — a retry after
    // connectivity returns may still succeed (refresh tokens outlive
    // access tokens by design).
    return null;
  }
}

/** Diagnostic helper: does this userData dir hold a persisted session? */
function hasStoredSession(userDataDir) {
  const fs = require('fs');
  const path = require('path');
  try { return fs.existsSync(path.join(userDataDir, STORE_FILE)); } catch { return false; }
}

module.exports = { refreshCloudSession, tokenEndpoint, hasStoredSession };
