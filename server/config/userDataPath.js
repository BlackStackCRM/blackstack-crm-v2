/**
 * USER DATA PATH RESOLUTION
 *
 * Phase 1 architecture: application code and user data must be logically
 * separated so a future Electron installer/update (Phase 2) can replace
 * application files without ever touching user data.
 *
 * Resolution order for the user-data root:
 *   1. BLACKSTACK_USER_DATA_DIR  (explicit override — used by tests)
 *   2. Portable default: <project>/user-data (current behaviour; keeps the
 *      existing local database where it is — nothing is moved or copied,
 *      so existing data is preserved exactly as-is).
 *
 * In Phase 2 the Electron main process will set BLACKSTACK_USER_DATA_DIR to
 * app.getPath('userData') (e.g. %APPDATA%/BlackStackCRM) before the server
 * boots; this module already honours it, so no further changes are needed.
 *
 * NEVER call fs.rmSync / fs.rmdirSync recursive on any path returned here.
 */
const path = require('path');

function getUserDataRoot() {
  if (process.env.BLACKSTACK_USER_DATA_DIR) {
    return path.resolve(process.env.BLACKSTACK_USER_DATA_DIR);
  }
  // Portable layout: user-data lives beside the app but is never replaced
  // by an installer/update (packaging excludes it).
  return path.resolve(__dirname, '../../user-data');
}

/** Current database file location. Existing production data stays here. */
function getDatabasePath() {
  if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH);
  // Legacy location preserved so existing databases are opened, not recreated.
  return path.resolve(__dirname, '../data/blackstack-crm.db');
}

const paths = {
  database: getDatabasePath,
  /** Folder where backups are written (never the app folder). */
  backups: () => path.join(getUserDataRoot(), 'backups'),
  /** Future home of uploaded files / attachments (not yet used by the app). */
  uploads: () => path.join(getUserDataRoot(), 'uploads'),
  /** User preferences / exported settings. */
  preferences: () => path.join(getUserDataRoot(), 'preferences'),
  /** Migration lock file location. */
  locks: () => path.join(getUserDataRoot(), 'locks'),
  /** Update-service state (Phase 2). */
  updates: () => path.join(getUserDataRoot(), 'updates'),
};

function ensureDir(dir) {
  const fs = require('fs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { getUserDataRoot, getDatabasePath, paths, ensureDir };
