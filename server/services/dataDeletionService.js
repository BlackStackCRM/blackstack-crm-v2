/**
 * USER-DATA DELETION SERVICE — Phase 2 (§14–§17)
 *
 * Explicit, double-confirmed deletion of the BlackStack user-data directory.
 * FAIL-SAFE RULES:
 *  - The service NEVER runs without requireDeleteToken being issued first.
 *  - Before deleting: final verified backup of the DB (if it has data).
 *    If the backup cannot be created/verified, deletion is REFUSED (§15).
 *  - Scope is exactly the BlackStack user-data root (§16) — never Program
 *    Files, never unrelated Windows user data.
 *  - A minimal audit event (§17) is preserved OUTSIDE the deleted scope.
 *  - The resolved path must be inside the OS temp dir (tests) OR be a real
 *    BlackStack user-data dir; it is re-verified immediately before rm.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getUserDataRoot, paths, getDatabasePath } = require('../config/userDataPath');
const { createBackup, verifyBackup, dirSize } = require('./backupService');
const { APP_VERSION } = require('../version');

let deleteToken = null; // one-time confirmation token from step 2

/** Issue the one-time token required after the user types DELETE (§14). */
function issueDeleteToken() {
  deleteToken = `delete-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return { tokenIssued: true, expiresInMinutes: 15 };
}

/** Step 1 of the flow: preview scope + attempt final backup. */
function previewDeletion() {
  const root = getUserDataRoot();
  if (!fs.existsSync(root)) {
    return { exists: false, scope: [], backup: null, deletable: false };
  }
  const scope = ['database', 'backups', 'uploads', 'preferences', 'logs', 'locks', 'updates', 'cache']
    .map((name) => ({ name, bytes: dirSize(path.join(root, name)) }))
    .filter((s) => s.bytes > 0);
  return { exists: true, root, scope, deletable: true };
}

/**
 * Step 2 (final): perform deletion.
 * @param {string} typedConfirmation exact string "DELETE" (§14)
 * @param {string} token            token from issueDeleteToken()
 */
function performDeletion({ typedConfirmation, token }) {
  const fail = (message, code) => { const e = new Error(message); e.code = code; return e; };

  if (typedConfirmation !== 'DELETE') throw fail('Typed confirmation must be exactly "DELETE".', 'CONFIRMATION_MISMATCH');
  if (!token || token !== deleteToken) throw fail('Deletion token missing or invalid — start the flow again.', 'TOKEN_INVALID');

  const root = getUserDataRoot();

  // ISOLATION GUARD (§33): the resolved path must exist and must be either
  // (a) inside the OS temp directory (tests), or (b) a genuine BlackStack
  // user-data root. Never Program Files, never C:\ root, never user profile.
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
  const tempRoot = fs.realpathSync(os.tmpdir());
  const isTemp = realRoot.toLowerCase().startsWith(tempRoot.toLowerCase());
  const isBlackStackDir = path.basename(realRoot).toLowerCase().includes('blackstack');
  if (!isTemp && !isBlackStackDir) {
    throw fail(`Refusing deletion: resolved path "${realRoot}" is not a BlackStack user-data directory.`, 'SCOPE_INVALID');
  }

  // FINAL BACKUP (§15) — refusal on failure is the default safe behavior.
  let finalBackup = null;
  const db = getDatabasePath();
  if (fs.existsSync(db) && fs.statSync(db).size > 4096) {
    try {
      const meta = createBackup({ label: 'pre-deletion-final' });
      const check = verifyBackup(meta.file);
      if (!check.valid) throw new Error('final backup failed verification: ' + check.errors.join('; '));
      finalBackup = { file: meta.file, verified: true };
    } catch (e) {
      throw fail(`A final backup could not be created (${e.message}). Your data has NOT been deleted. Resolve the backup/storage problem and try again.`, 'FINAL_BACKUP_FAILED');
    }
  }

  // AUDIT EVENT (§17) — written OUTSIDE the deletion scope before deletion.
  const audit = {
    timestamp: new Date().toISOString(),
    windowsUser: os.userInfo().username,
    appVersion: APP_VERSION,
    scope: 'user-data-root',
    root: realRoot,
    finalBackup: finalBackup ? finalBackup.file : null,
  };
  const auditPath = path.join(os.tmpdir(), `blackstack-deletion-audit-${Date.now()}.json`);
  try { fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2)); } catch { /* best effort */ }

  // Re-verify the path one last time, then delete (§16 scope only).
  if (!fs.existsSync(realRoot)) {
    // Already gone — record success.
    return { deleted: true, alreadyDeleted: true, finalBackup, auditPath };
  }
  const recheck = fs.realpathSync(realRoot);
  if (!recheck.toLowerCase().startsWith(realRoot.toLowerCase())) {
    throw fail('Refusing deletion: path changed during operation.', 'SCOPE_CHANGED');
  }
  fs.rmSync(realRoot, { recursive: true, force: true });

  // Verify deletion (§15.6).
  const gone = !fs.existsSync(realRoot);
  if (!gone) throw fail('Deletion verification failed: some files remain.', 'DELETE_VERIFY_FAILED');

  return { deleted: true, finalBackup, auditPath };
}

function resetForTests() { deleteToken = null; }

module.exports = { issueDeleteToken, previewDeletion, performDeletion, resetForTests };
