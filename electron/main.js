/**
 * ELECTRON MAIN PROCESS — BlackStack CRM
 *
 * Responsibilities:
 *  - Enforce single instance
 *  - Keep app support files in app.getPath('userData')
 *  - Load the same external .env as the web server and use its shared DB_PATH
 *  - Start the existing Express CRM server in-process
 *  - Show the window as soon as the local server responds
 *  - Auto-update via electron-updater (GitHub releases), background check,
 *    pre-update verified backup before install
 *  - Graceful shutdown: stop server, close DB, quit
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// ── Single instance ─────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap() {
  // ── User data directory (must be set before requiring server modules) ─────
  // BLACKSTACK_USER_DATA_DIR override: support/testing isolation. When set,
  // all data (DB, backups, logs) is directed there instead of the default
  // %APPDATA%\BlackStack CRM. The override path must exist or be creatable
  // and must NOT be inside the install directory (data-safety rule §2).
  let userDataDir = app.getPath('userData');
  const override = process.env.BLACKSTACK_USER_DATA_DIR;
  if (override && app.isPackaged) {
    const resolved = path.resolve(override);
    if (resolved.toLowerCase().startsWith(path.dirname(process.execPath).toLowerCase())) {
      dialog.showErrorBox('BlackStack CRM', 'BLACKSTACK_USER_DATA_DIR must not point inside the application install directory.\n\nUsing the default per-user data location instead.');
    } else {
      userDataDir = resolved;
    }
  }
  process.env.BLACKSTACK_USER_DATA_DIR = userDataDir;
  for (const sub of ['backups', 'uploads', 'preferences', 'locks', 'updates', 'logs', 'database']) {
    fs.mkdirSync(path.join(userDataDir, sub), { recursive: true });
  }

  // Logging (plain text, no sensitive data)
  const logFile = path.join(userDataDir, 'logs', `app-${new Date().toISOString().slice(0, 10)}.log`);
  function log(msg) {
    try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* noop */ }
    console.log('[main]', msg);
  }
  global.__crmLog = log;
  log('userData dir: ' + userDataDir + (override && userDataDir === path.resolve(override) ? ' (BLACKSTACK_USER_DATA_DIR override)' : ' (default)'));

  // Both the web server and Electron must load the same external environment
  // file. In packaged installs, the prior safe-migration marker identifies the
  // source project; shared-env-path.txt or BLACKSTACK_ENV_PATH can override it.
  let sharedRuntime;
  try {
    const runtimeEnvironment = require(path.join(__dirname, '../server/config/runtimeEnvironment'));
    const envPath = runtimeEnvironment.resolveSharedEnvPath({
      explicitPath: process.env.BLACKSTACK_ENV_PATH,
      userDataDir,
      appPath: app.getAppPath(),
    });
    sharedRuntime = runtimeEnvironment.loadRuntimeEnvironment({ envPath, required: true });
    if (!sharedRuntime.dbPath) {
      process.env.DB_PATH = path.resolve(sharedRuntime.envDir, 'data/blackstack-crm.db');
      sharedRuntime.dbPath = process.env.DB_PATH;
    }
    log('Shared environment file: ' + sharedRuntime.envPath);
    log('Shared SQLite database: ' + sharedRuntime.dbPath);
    const { isConfigured } = require(path.join(__dirname, '../server/config/supabase'));
    log('Shared Supabase configuration: ' + (isConfigured() ? 'configured' : 'missing required variables'));
    const legacyDb = path.join(userDataDir, 'database', 'blackstack-crm.db');
    if (fs.existsSync(legacyDb) && path.resolve(legacyDb) !== path.resolve(sharedRuntime.dbPath)) {
      log('Legacy isolated Electron database preserved and unused: ' + legacyDb);
    }
  } catch (error) {
    log('FATAL: shared environment/database setup failed: ' + error.message);
    dialog.showErrorBox(
      'BlackStack CRM configuration required',
      'BlackStack could not load the shared environment and database configuration.\n\n'
        + 'Set BLACKSTACK_ENV_PATH to the web server .env file, or create shared-env-path.txt in the Electron user-data folder containing that path.\n\n'
        + 'The shared database folder must be writable. No fallback database was opened.\n\nDetails: ' + error.message,
    );
    app.exit(1);
    return;
  }

  const { APP_VERSION } = require(path.join(__dirname, '../server/version'));
  const { updateLogger } = require('./update-logger');
  updateLogger.init(path.join(userDataDir, 'logs'));
  updateLogger.event('app-start', { version: APP_VERSION, userData: userDataDir });

  // Phase 2: log maintenance (30-day cleanup) at startup — best effort.
  try {
    const { maintain } = require(path.join(__dirname, '../server/services/logManager'));
    maintain(path.join(userDataDir, 'logs'));
  } catch { /* never block startup */ }

  // ── Start the CRM server (existing Express app) ───────────────────────────
  // Desktop default port; server-host performs availability check + documented
  // fallback range and records the final selection (spec §20).
  const PORT = parseInt(process.env.PORT || '34567', 10);
  process.env.PORT = String(PORT);
  let serverProcess = null;
  let server = null;

  const { startServer } = require('./server-host');
  let mainWindow = null;

  async function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1024,
      minHeight: 640,
      title: 'BlackStack CRM',
      backgroundColor: '#fafafa',
      icon: path.join(__dirname, 'icons', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // preload needs require() for the tiny safe API
        spellcheck: false,
      },
    });
    mainWindow.setMenuBarVisibility(false);
    // Wait for local server, then load. Retry — server boot includes migrations.
    const url = `http://127.0.0.1:${PORT}`;
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      try {
        const res = await fetch(url + '/health');
        if (res.ok) ready = true;
      } catch { /* not up yet */ }
      if (!ready) await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) {
      log('Server did not become ready in time');
      try { require('./eventLog').logEvent('ERROR', 'Application startup failure: CRM server did not become healthy.', 1001); } catch { /* non-fatal */ }
      dialog.showErrorBox('BlackStack CRM', 'The CRM server did not start in time. Your data is safe — please restart the app.');
      app.quit();
      return;
    }
    // ERR_ABORTED (-3) here is NOT a failure: the auth guard legitimately
    // redirects an unauthenticated session to login.html while the initial
    // load is still in flight, which aborts that load. Previously the rejected
    // promise propagated out of createWindow(), so app.whenReady()'s chain
    // stopped before setupAutoUpdate() — the updater silently never initialised
    // and "App ready" was never logged. Treat the abort as a successful load and
    // let any other error surface.
    try {
      await mainWindow.loadURL(url);
    } catch (e) {
      const aborted = e && (e.code === 'ERR_ABORTED' || /ERR_ABORTED/.test(String(e.message || '')));
      if (!aborted) {
        log('Window load failed: ' + (e && e.message));
        throw e;
      }
      log('Initial load aborted by client-side redirect (expected on a fresh session)');
    }
    log('Window loaded: ' + url);
  }

  // ── Auto-update (electron-updater, background only) ───────────────────────
  //
  // Phase C changes, all additive:
  //   * lifecycle state moved into server/services/updateState.js (persisted, not
  //     an in-memory global) so a downloaded update survives a restart;
  //   * REAL progress is forwarded (percent / transferred / total /
  //     bytesPerSecond) instead of percent alone;
  //   * download is user-initiated — "Update Now", not automatic on detection;
  //   * autoInstallOnAppQuit = false so "Later" is actually honoured;
  //   * every event is logged to updates.log as before.
  //
  // The updater object, its events and the safety sequence around
  // quitAndInstall are unchanged.
  /**
 * Re-point the updater at an installer it already downloaded in an earlier
 * session.
 *
 * electron-updater records the downloaded installer only in memory
 * (`downloadedUpdateHelper`). It never restores that from its own on-disk
 * `pending/` folder, so after any restart `installerPath` is null and
 * `install()` fails with "No update filepath provided". This rebuilds the helper
 * from electron-updater's own `update-info.json`, verifying SHA-512 first, so
 * "Restart & Update" works on the launch after "Later" rather than only in the
 * session that performed the download.
 */
/**
 * Read the `updaterCacheDirName` scalar from app-update.yml.
 *
 * app-update.yml is a two-level YAML document; this reads the one key we need
 * without pulling in a YAML parser for the packaged app.
 */
function yamlUpdaterCacheDirName(text) {
  const m = /^[ \t]*updaterCacheDirName[ \t]*:[ \t]*['"]?([^'"\r\n#]+)['"]?[ \t]*$/m.exec(text || '');
  return m ? m[1].trim() : null;
}

function rehydrateStagedInstaller() {
  let updaterMod;
  try { updaterMod = require('electron-updater'); } catch { return; }
  const autoUpdater = updaterMod.autoUpdater;

  // Resolve the cache dir EXACTLY as electron-updater does
  // (AppUpdater.getOrCreateDownloadHelper): it prefers `updaterCacheDirName`
  // from app-update.yml and only falls back to app.name. Using app.name alone
  // resolved "blackstack-crm-v2" while the real staging folder was
  // "blackstack-crm-v2-updater", so rehydration silently found nothing.
  let dirName = null;
  try {
    const cfgPath = path.join(process.resourcesPath, 'app-update.yml');
    dirName = yamlUpdaterCacheDirName(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    log('Could not read updaterCacheDirName from app-update.yml: ' + e.message);
  }
  const cacheDir = path.join(autoUpdater.app.baseCachePath, dirName || autoUpdater.app.name);
  if (autoUpdater.downloadedUpdateHelper && autoUpdater.downloadedUpdateHelper.file) {
    // This session already downloaded the update; the live helper is correct.
    return;
  }

  const pendingDir = path.join(cacheDir, 'pending');
  const infoPath = path.join(pendingDir, 'update-info.json');
  if (!fs.existsSync(infoPath)) {
    log('No staged installer metadata to rehydrate (' + infoPath + ')');
    return;
  }

  let info;
  try { info = JSON.parse(fs.readFileSync(infoPath, 'utf8')); } catch (e) {
    log('Staged installer metadata unreadable: ' + e.message);
    return;
  }
  const installer = path.join(pendingDir, info.fileName);
  if (!fs.existsSync(installer)) {
    log('Staged installer missing on disk: ' + installer);
    return;
  }

  // Verify the SHA-512 electron-updater recorded. Installing a tampered or
  // truncated installer is precisely what these safety checks exist to prevent.
  const digest = require('crypto').createHash('sha512').update(fs.readFileSync(installer)).digest('base64');
  if (info.sha512 && digest !== info.sha512) {
    log('Staged installer FAILED sha512 verification - not rehydrating');
    updateLogger.event('staged-installer-rejected', { reason: 'sha512-mismatch' });
    return;
  }

  // A structural stand-in is enough and avoids depending on electron-updater's
  // private class: BaseUpdater.install() reads only .file, .packageFile and
  // .downloadedFileInfo.isAdminRightsRequired from this object.
  autoUpdater.downloadedUpdateHelper = {
    cacheDir,
    get file() { return installer; },
    get packageFile() { return null; },
    get downloadedFileInfo() {
      return { fileName: info.fileName, sha512: info.sha512, isAdminRightsRequired: !!info.isAdminRightsRequired };
    },
    clear: async () => {},
  };

  log('Rehydrated staged installer: ' + installer);
  updateLogger.event('staged-installer-rehydrated', { file: info.fileName });
}

function setupAutoUpdate() {
    if (!app.isPackaged) { log('Dev mode — auto-update disabled'); return; }
    let autoUpdater;
    try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { log('electron-updater unavailable: ' + e.message); return; }
    // Phase 3: channel preference (stable default; beta opts into prereleases).
    let channel = 'stable';
    try { channel = require(path.join(__dirname, '../server/services/updateService')).getChannel(); } catch { /* stable */ }
    autoUpdater.allowPrerelease = channel === 'beta';
    autoUpdater.channel = channel;
    log('Update channel: ' + channel);

    // ── Phase C: user-initiated download ──────────────────────────────────
    // autoDownload was true, so an available update started downloading the
    // instant it was detected and the user never chose. Now detection only
    // ANNOUNCES; the download starts when the user clicks "Update Now".
    autoUpdater.autoDownload = false;

    // ── Phase C: "Later" must actually mean later ────────────────────────
    // autoInstallOnAppQuit = true installed a pending update on the next
    // ordinary quit, which directly contradicted choosing "Later". The update
    // now installs ONLY via the explicit "Restart & Update" path.
    autoUpdater.autoInstallOnAppQuit = false;

    const { sendToRenderer } = require('./ipc');
    const ipc = require('./ipc');
    const U = require(path.join(__dirname, '../server/services/updateState'));

    /** Apply a lifecycle transition, persist it, and mirror it to the renderer. */
    const emit = (status, patch = {}, opts = {}) => {
      const next = U.setState(status, patch, opts);
      sendToRenderer('update-status', {
        status: next.status,
        currentVersion: next.currentVersion,
        targetVersion: next.targetVersion,
        percent: next.percent,
        transferred: next.transferred,
        total: next.total,
        bytesPerSecond: next.bytesPerSecond,
        postponed: next.postponed,
        error: next.error,
      });
      return next;
    };

    // Restore any update that was already downloaded before this launch. The
    // updater's own package cache survives, so there is nothing to re-download —
    // the user just needs to be told it is waiting.
    if (U.hasPendingUpdate()) {
      const s = U.readState();
      log(`Restored pending update state: ${s.status} (v${s.targetVersion || '?'})`);
      updateLogger.event('update-state-restored', { status: s.status, version: s.targetVersion });
      setTimeout(() => emit(s.status, { force: true }), 500);

      // electron-updater keeps the path of the downloaded installer ONLY in
      // memory (`downloadedUpdateHelper.file`), and it never rebuilds that from
      // its on-disk `pending/` folder. So after a restart — including the restart
      // that follows the user choosing "Later" — `autoUpdater.install()` finds
      // installerPath == null and fails with
      //   "No update filepath provided, can't quit and install"
      // even though the verified installer is sitting on disk. Rehydrate the
      // helper from electron-updater's own staging metadata so "Restart &
      // Update" works on the next launch, not only in the session that
      // downloaded it.
      rehydrateStagedInstaller();
    }

    autoUpdater.on('checking-for-update', () => {
      log('Update check started');
      updateLogger.event(updateLogger.EVENTS.CHECK_STARTED, { channel });
      emit('CHECKING', { currentVersion: APP_VERSION, error: null });
    });

    autoUpdater.on('update-available', (info) => {
      log(`Update available: ${info.version}`);
      updateLogger.event(updateLogger.EVENTS.AVAILABLE, { from: APP_VERSION, to: info.version });

      // A re-check must NOT clobber a download the user already finished and
      // postponed. Without this, the periodic check 15s after launch overwrites
      // POSTPONED back to AVAILABLE, and app:installUpdate — which only accepts
      // READY or POSTPONED — refuses forever, so "Restart & Update" could never
      // install an update the user had already downloaded. The pending update is
      // still perfectly valid; only the *announcement* is redundant.
      const cur = U.readState();
      const stillPending = (cur.status === U.STATES.READY || cur.status === U.STATES.POSTPONED)
        && cur.targetVersion === info.version;
      if (stillPending) {
        log(`Update ${info.version} already downloaded and pending — keeping state ${cur.status}`);
        updateLogger.event('update-still-pending', { version: info.version, state: cur.status });
        return;
      }

      // ANNOUNCE ONLY. The download begins when the user asks for it.
      emit('AVAILABLE', {
        currentVersion: APP_VERSION,
        targetVersion: info.version,
        percent: null, transferred: null, total: null, bytesPerSecond: null,
        error: null,
      });
    });

    autoUpdater.on('update-not-available', () => {
      log('No update available');
      emit('UP_TO_DATE', { currentVersion: APP_VERSION, percent: null });
    });

    autoUpdater.on('download-progress', (p) => {
      // REAL values from electron-updater only. `transferred`/`total` are the
      // byte counts it reports; they are passed through as-is and the UI decides
      // how to render them. Nothing is synthesized: if the updater omits a value
      // it arrives as undefined rather than being invented.
      emit('DOWNLOADING', {
        currentVersion: APP_VERSION,
        percent: p && typeof p.percent === 'number' ? p.percent : null,
        transferred: p && typeof p.transferred === 'number' ? p.transferred : null,
        total: p && typeof p.total === 'number' ? p.total : null,
        bytesPerSecond: p && typeof p.bytesPerSecond === 'number' ? p.bytesPerSecond : null,
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      // electron-updater has verified the package by this point; that IS the
      // verification step, so it is recorded explicitly rather than invented.
      log('Update downloaded and verified: ' + info.version);
      global.__pendingUpdateVersion = info.version;
      updateLogger.event(updateLogger.EVENTS.DOWNLOAD_COMPLETED, { version: info.version });
      emit('READY', {
        currentVersion: APP_VERSION,
        targetVersion: info.version,
        percent: 100,
        postponed: false,
        error: null,
      }, { force: true });
    });

    autoUpdater.on('error', (e) => {
      const msg = (e && e.message) || 'unknown update error';
      log('Updater error (non-fatal): ' + msg);
      try { require('./eventLog').logEvent('WARNING', 'Update check failed: ' + msg); } catch { /* non-fatal */ }
      // The CRM keeps running either way. Distinguish an offline check from a
      // real failure so the UI can say something truthful.
      const offline = /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|network/i.test(msg);
      emit(offline ? 'OFFLINE' : 'ERROR', { error: msg }, { force: true });
    });

    // Background check, never blocking startup; ignore failures.
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((e) => log('Update check failed (ignored): ' + e.message));
    }, 15000);
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
    global.__autoUpdater = autoUpdater;
    global.__updateEmit = emit;
    global.__updateState = U;
  }

  // ── IPC from renderer (update UI) ─────────────────────────────────────────
  ipcMain.handle('app:getInfo', () => ({ version: APP_VERSION, platform: process.platform, packaged: app.isPackaged }));

  // ── Phase C: current lifecycle state ────────────────────────────────────
  // Lets the UI render the correct screen on open, and lets a renderer that
  // loaded before the update events started catch up.
  ipcMain.handle('app:getUpdateState', () => {
    try {
      const U = require(path.join(__dirname, '../server/services/updateState'));
      const s = U.readState();
      return {
        ok: true,
        state: {
          status: s.status,
          currentVersion: s.currentVersion || APP_VERSION,
          targetVersion: s.targetVersion,
          percent: s.percent,
          transferred: s.transferred,
          total: s.total,
          bytesPerSecond: s.bytesPerSecond,
          postponed: s.postponed,
          error: s.error,
        },
      };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('app:checkForUpdate', async () => {
    const au = global.__autoUpdater;
    if (!au) return { status: 'DISABLED', message: 'Updates are only available in the installed app.' };
    try { await au.checkForUpdates(); return { status: 'CHECKING' }; }
    catch (e) { return { status: 'OFFLINE', message: e.message }; }
  });

  // ── Phase C: "Update Now" — user-initiated download ────────────────────
  // autoDownload is false, so this is the ONLY way a download starts. It runs in
  // the main process and is deliberately NOT awaited by the UI: the renderer
  // receives progress through the 'update-status' broadcast, which is what lets
  // the user minimize the update screen and keep working.
  ipcMain.handle('app:startDownload', async () => {
    const au = global.__autoUpdater;
    if (!au) return { ok: false, status: 'DISABLED', message: 'Updates are only available in the installed app.' };
    try {
      const U = require(path.join(__dirname, '../server/services/updateState'));
      const cur = U.readState();
      // An already-downloaded update needs no second download; jump straight to
      // the ready screen instead of fetching it again.
      if (cur.status === U.STATES.READY || cur.status === U.STATES.POSTPONED) {
        const next = U.setState('READY', { postponed: false }, { force: true });
        require('./ipc').sendToRenderer('update-status', { status: next.status, targetVersion: next.targetVersion, percent: 100 });
        return { ok: true, status: 'READY', alreadyDownloaded: true };
      }
      U.setState('DOWNLOADING', { percent: 0, error: null }, { force: true });
      updateLogger.event(updateLogger.EVENTS.DOWNLOAD_STARTED, { to: cur.targetVersion || null });
      // Fire and forget: progress arrives via 'update-status'.
      au.downloadUpdate().catch((e) => {
        log('Download failed: ' + e.message);
        updateLogger.event(updateLogger.EVENTS.INSTALL_FAILED, { phase: 'download', error: e.message });
        U.setState('ERROR', { error: e.message }, { force: true });
        require('./ipc').sendToRenderer('update-status', {
          status: 'ERROR',
          error: 'Update download failed. BlackStack will continue working normally.',
        });
      });
      return { ok: true, status: 'DOWNLOADING' };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  // ── Phase C: "Later" — postpone, never install on quit ─────────────────
  // Records the decision so a later launch knows an update is waiting. Combined
  // with autoInstallOnAppQuit = false, choosing Later genuinely means the update
  // is not installed merely because the user closed BlackStack.
  ipcMain.handle('app:postponeUpdate', () => {
    try {
      const U = require(path.join(__dirname, '../server/services/updateState'));
      const s = U.setState('POSTPONED', { postponed: true }, { force: true });
      log('Update postponed by user (target v' + (s.targetVersion || '?') + ')');
      updateLogger.event('update-postponed', { version: s.targetVersion });
      require('./ipc').sendToRenderer('update-status', {
        status: 'POSTPONED',
        targetVersion: s.targetVersion,
        postponed: true,
      });
      return { ok: true, status: 'POSTPONED' };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('app:installUpdate', async () => {
    // PRE-UPDATE SAFETY (§8): compatibility check + verified backup before quit.
    try {
      // 1. Schema compatibility gate (§9).
      const upd = require(path.join(__dirname, '../server/services/updateService'));
      const compat = upd.checkSchemaCompatibility({
        targetAppVersion: global.__pendingUpdateVersion || null,
        dbSchemaVersion: upd.getCurrentDbSchemaVersion(),
      });
      if (compat.result === 'INCOMPATIBLE' || compat.result === 'UNSUPPORTED') {
        log('Update blocked: ' + compat.result + ' — ' + compat.reason);
        updateLogger.event(updateLogger.EVENTS.RECOVERY_REQUIRED, { reason: compat.result });
        return { ok: false, blocked: true, message: 'Update blocked. This version of BlackStack CRM cannot safely use the current database schema. Your data has not been modified.' };
      }
      // 2. Verified backup (Phase 1 mechanism reused).
      const { createBackup, verifyBackup } = require(path.join(__dirname, '../server/services/backupService'));
      const meta = createBackup({ label: 'pre-update' });
      const check = verifyBackup(meta.file);
      updateLogger.event('pre-update-backup', { file: meta.file, verified: check.valid });
      if (!check.valid) {
        log('Pre-update backup FAILED verification — update blocked');
        return { ok: false, message: 'Update could not be safely prepared. Your current CRM has not been changed.' };
      }
      log('Pre-update backup verified: ' + meta.file);
    } catch (err) {
      log('Pre-update safety threw: ' + err.message);
      return { ok: false, message: 'Update could not be safely prepared. Your current CRM has not been changed. (' + err.message + ')' };
    }
    const au = global.__autoUpdater;
    if (!au) return { ok: false, message: 'Updater not available.' };
    // 3. Refuse to install anything that is not actually downloaded and verified.
    //    Only the explicit "Restart & Update" path reaches here, and only after a
    //    successful download, but guarding it means a bug elsewhere cannot install
    //    an unverified package.
    const U = require(path.join(__dirname, '../server/services/updateState'));
    const st = U.readState();
    if (st.status !== U.STATES.READY && st.status !== U.STATES.POSTPONED) {
      return {
        ok: false,
        message: 'The update has not finished downloading, so it cannot be installed. '
          + 'BlackStack has not been changed.',
      };
    }
    // 4. Clean shutdown before the installer takes over. The existing
    //    window-all-closed / before-quit handlers stop the server and close the
    //    database connection; quitAndInstall performs the quit.
    try {
      U.setState('INSTALLING', {}, { force: true });
      require('./ipc').sendToRenderer('update-status', { status: 'INSTALLING' });
    } catch { /* state persistence must not block the install */ }
    updateLogger.event(updateLogger.EVENTS.INSTALL_STARTED, { from: APP_VERSION });
    au.quitAndInstall(false, true); // don't run silent installer args; restart app after
    return { ok: true };
  });

  // Phase 3: channel get/set over IPC (used by Settings → Updates).
  ipcMain.handle('app:getChannel', () => {
    try { return { ok: true, channel: require(path.join(__dirname, '../server/services/updateService')).getChannel() }; }
    catch (e) { return { ok: false, message: e.message }; }
  });
  ipcMain.handle('app:setChannel', (_e, channel) => {
    try {
      const ch = require(path.join(__dirname, '../server/services/updateService')).setChannel(channel);
      const au = global.__autoUpdater;
      if (au) { au.allowPrerelease = ch === 'beta'; au.channel = ch; }
      log('Update channel set to: ' + ch);
      return { ok: true, channel: ch };
    } catch (e) { return { ok: false, message: e.message }; }
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    server = await startServer({ log });
    await createWindow();
    setupAutoUpdate();
    log('App ready');
  }).catch((error) => {
    log('FATAL: CRM startup failed: ' + error.message);
    const message = /readonly|read-only|permission denied|access is denied|unable to open database|writable/i.test(error.message)
      ? 'BlackStack could not open the shared SQLite database for writing. Check that the database file and its folder are writable and not blocked by another process. No separate fallback database was opened.'
      : 'BlackStack could not start. Your shared database has not been intentionally replaced. Check the application log for details.';
    dialog.showErrorBox('BlackStack CRM could not start', message + '\n\nDetails: ' + error.message);
    app.quit();
  });

  app.on('window-all-closed', () => {
    // Graceful shutdown: stop server & close DB, then quit.
    (async () => {
      try {
        if (server && server.stop) await server.stop();
        const { _closeCachedConnection } = require(path.join(__dirname, '../server/utils/db'));
        if (_closeCachedConnection) _closeCachedConnection();
      } catch (e) { log('Shutdown warning: ' + e.message); }
      app.quit();
    })();
  });

  app.on('before-quit', () => {
    try {
      const { _closeCachedConnection } = require(path.join(__dirname, '../server/utils/db'));
      if (_closeCachedConnection) _closeCachedConnection();
    } catch { /* noop */ }
  });
}
module.exports = {};
