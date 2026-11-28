/**
 * REFRESH-TOKEN SINK (request-scoped token bridge)
 *
 * The server process must never import Electron's secure store directly. The
 * main process registers a sink at startup; the login path only calls
 * persistRefreshToken(). This keeps the encrypted store (DPAPI/safeStorage)
 * outside the server module graph while letting the login flow persist the
 * Supabase refresh token that the request-scoped provider later exchanges for a
 * short-lived access token.
 *
 * No token value is logged.
 */

let sink = null;

/**
 * @param {{save?:(t:string)=>void, load?:()=>string|null, clear?:()=>void}} s
 */
function setRefreshTokenSink(s) {
  sink = s || null;
}

function persistRefreshToken(token) {
  if (!sink || typeof sink.save !== 'function' || !token) return false;
  try {
    sink.save(String(token));
    return true;
  } catch (e) {
    console.warn('[refresh-token-sink] persist failed:', e && e.message);
    return false;
  }
}

function loadRefreshToken() {
  if (!sink || typeof sink.load !== 'function') return null;
  try {
    return sink.load() || null;
  } catch {
    return null;
  }
}

function clearRefreshToken() {
  if (!sink || typeof sink.clear !== 'function') return false;
  try {
    sink.clear();
    return true;
  } catch {
    return false;
  }
}

module.exports = { setRefreshTokenSink, persistRefreshToken, loadRefreshToken, clearRefreshToken };