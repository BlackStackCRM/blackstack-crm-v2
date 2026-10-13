/**
 * UPDATE SERVICE — Phase 1 stub layer.
 *
 * A clean abstraction for the future Electron auto-update flow (Phase 2).
 * Nothing here performs any real update; functions report status and
 * explicitly no-op. This keeps the UI and future Electron main process
 * programming against a stable interface.
 *
 * Phase 2 will implement this against electron-updater
 * (checkForUpdates / downloadUpdate / quitAndInstall).
 */
const fs = require('fs');
const path = require('path');
const { APP_VERSION, compareVersions } = require('../version');

const UPDATE_STATUS = {
  IDLE: 'IDLE',
  CHECKING: 'CHECKING',
  AVAILABLE: 'AVAILABLE',
  NOT_AVAILABLE: 'NOT_AVAILABLE',
  DOWNLOADING: 'DOWNLOADING',
  DOWNLOADED: 'DOWNLOADED',
  READY_TO_INSTALL: 'READY_TO_INSTALL',
  INSTALLING: 'INSTALLING',
  ERROR: 'ERROR',
  OFFLINE: 'OFFLINE',
  DISABLED: 'DISABLED',
};

// ─── PHASE 3: UPDATE CHANNELS ────────────────────────────────────────────────
const CHANNELS = {
  stable: { label: 'Stable', allowPrerelease: false },
  beta: { label: 'Beta', allowPrerelease: true },
  enterprise: { label: 'Enterprise', allowPrerelease: false },
};
const DEFAULT_CHANNEL = 'stable';

/** Channel preference persisted in the user preferences dir (no DB change). */
function getPreferencesFile() {
  const { paths, ensureDir } = require('../config/userDataPath');
  ensureDir(paths.preferences());
  return path.join(paths.preferences(), 'update-channel.json');
}

function getChannel() {
  try {
    const data = JSON.parse(fs.readFileSync(getPreferencesFile(), 'utf8'));
    if (data && CHANNELS[data.channel]) return data.channel;
  } catch { /* default below */ }
  return DEFAULT_CHANNEL;
}

function setChannel(channel) {
  if (!CHANNELS[channel]) throw new Error(`Unknown update channel: ${channel}`);
  fs.writeFileSync(getPreferencesFile(), JSON.stringify({ channel, changedAt: new Date().toISOString() }, null, 2));
  return getChannel();
}

// ─── PHASE 3: SCHEMA COMPATIBILITY (§9) ────────────────────────────────────
/**
 * Is the current database usable by the TARGET application version?
 * Read-only; never mutates anything.
 * Results: COMPATIBLE | MIGRATION_REQUIRED | INCOMPATIBLE | UNSUPPORTED
 */
function checkSchemaCompatibility({ targetAppVersion, dbSchemaVersion }) {
  const currentApp = APP_VERSION;
  if (dbSchemaVersion == null) {
    return { result: 'INCOMPATIBLE', reason: 'database schema version unknown', currentApp, targetAppVersion };
  }
  const { MIN_SCHEMA_VERSION } = require('../version');
  if (dbSchemaVersion < MIN_SCHEMA_VERSION) {
    return { result: 'UNSUPPORTED', reason: `database schema ${dbSchemaVersion} is below minimum supported ${MIN_SCHEMA_VERSION}`, currentApp, targetAppVersion, dbSchemaVersion, minSupported: MIN_SCHEMA_VERSION };
  }
  if (compareVersions(targetAppVersion, currentApp) > 0) {
    return { result: 'MIGRATION_REQUIRED', reason: 'target application may include new migrations; the safe migration runner applies them with a verified backup', currentApp, targetAppVersion, dbSchemaVersion };
  }
  return { result: 'COMPATIBLE', reason: 'no schema change expected', currentApp, targetAppVersion, dbSchemaVersion };
}

/** Read current DB schema version (MAX schema_migrations.version); null if unavailable. */
function getCurrentDbSchemaVersion() {
  try {
    const { getDatabasePath } = require('../config/userDataPath');
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = getDatabasePath();
    if (!fs.existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
      return row && row.v != null ? row.v : null;
    } finally { db.close(); }
  } catch { return null; }
}

const UpdateService = {
  // Optional provider injected by the Electron main process (Phase 2).
  // Provider contract: checkForUpdate(), downloadUpdate(), installUpdate(), getUpdateStatus().
  _provider: null,
  bindProvider(provider) {
    this._provider = provider;
  },

  async getCurrentVersion() {
    return { version: APP_VERSION, channel: 'stable' };
  },

  async checkForUpdate(_feedUrl) {
    if (this._provider) {
      try { return await this._provider.checkForUpdate(); }
      catch (e) { return { status: UPDATE_STATUS.ERROR, message: String(e && e.message || e), currentVersion: APP_VERSION }; }
    }
    return { status: UPDATE_STATUS.DISABLED, message: 'Update checking is not active in this context.', currentVersion: APP_VERSION };
  },

  async downloadUpdate() {
    if (this._provider) {
      try { return await this._provider.downloadUpdate(); }
      catch (e) { return { status: UPDATE_STATUS.ERROR, message: String(e && e.message || e) }; }
    }
    return { status: UPDATE_STATUS.DISABLED, message: 'Download is not available in this context.' };
  },

  async installUpdate() {
    if (this._provider) {
      try { return await this._provider.installUpdate(); }
      catch (e) { return { status: UPDATE_STATUS.ERROR, message: String(e && e.message || e) }; }
    }
    return { status: UPDATE_STATUS.DISABLED, message: 'Install is not available in this context.' };
  },

  async getUpdateStatus() {
    if (this._provider) {
      try { return await this._provider.getUpdateStatus(); }
      catch { return { status: UPDATE_STATUS.ERROR, currentVersion: APP_VERSION }; }
    }
    return { status: UPDATE_STATUS.DISABLED, currentVersion: APP_VERSION };
  },

  /** Utility used by Phase 2 to decide if a fetched version is newer. */
  isNewerVersion(candidate, current = APP_VERSION) {
    return compareVersions(candidate, current) > 0;
  },
};

module.exports = { UpdateService, UPDATE_STATUS, CHANNELS, DEFAULT_CHANNEL, getChannel, setChannel, checkSchemaCompatibility, getCurrentDbSchemaVersion };
