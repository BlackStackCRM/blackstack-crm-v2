/**
 * SECURE REFRESH-TOKEN STORE (P2, audit §26.2 R5)
 *
 * Persists the Supabase refresh token OUTSIDE the renderer using Electron's
 * safeStorage (DPAPI on Windows — encrypted to the OS user account). The
 * plaintext token never touches localStorage, the renderer's JS context, or
 * any file readable by other local accounts.
 *
 * Storage layout: one encrypted blob per device in the userData directory:
 *   <userData>/cloud-session.bin   (safeStorage.encryptString output)
 *
 * Main-process only. NEVER require() this from preload or renderer.
 */

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'cloud-session.bin';

/** Resolve the file path lazily — electron.app is unavailable at import time
 *  in some test harnesses. */
function storePath(electronApp) {
  return path.join(electronApp.getPath('userData'), FILE_NAME);
}

function isEncryptionAvailable(safeStorage) {
  try {
    return Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function'
      && safeStorage.isEncryptionAvailable());
  } catch {
    return false;
  }
}

/**
 * Persist the refresh token.
 * @param {{app:object, safeStorage:object}} electron  injected Electron bits
 * @param {string} refreshToken
 * @returns {{stored:boolean, reason?:string}}
 */
function saveRefreshToken(electron, refreshToken) {
  const { app, safeStorage } = electron;
  if (!refreshToken) return { stored: false, reason: 'NO_TOKEN' };
  if (!isEncryptionAvailable(safeStorage)) {
    // Fail CLOSED: never write plaintext as a fallback.
    console.warn('[secure-session] safeStorage unavailable — refresh token NOT persisted');
    return { stored: false, reason: 'ENCRYPTION_UNAVAILABLE' };
  }
  try {
    const encrypted = safeStorage.encryptString(String(refreshToken));
    fs.mkdirSync(path.dirname(storePath(app)), { recursive: true });
    fs.writeFileSync(storePath(app), encrypted, { mode: 0o600 });
    return { stored: true };
  } catch (e) {
    console.warn('[secure-session] persist failed:', e.message);
    return { stored: false, reason: 'WRITE_FAILED' };
  }
}

/**
 * Load the persisted refresh token, or null. A read/unencrypt failure is
 * indistinguishable from "no session" — the user just signs in again.
 */
function loadRefreshToken(electron) {
  const { app, safeStorage } = electron;
  try {
    const p = storePath(app);
    if (!fs.existsSync(p)) return null;
    const blob = fs.readFileSync(p);
    if (!isEncryptionAvailable(safeStorage)) return null;
    const plain = safeStorage.decryptString(blob);
    return typeof plain === 'string' && plain.length > 0 ? plain : null;
  } catch (e) {
    console.warn('[secure-session] load failed (treating as no session):', e.message);
    return null;
  }
}

/** Remove the persisted token (logout, global revocation, corrupt state). */
function clearRefreshToken(electron) {
  try {
    const p = storePath(electron.app);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = { saveRefreshToken, loadRefreshToken, clearRefreshToken, storePath, FILE_NAME };
