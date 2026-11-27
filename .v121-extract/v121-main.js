'use strict';
/**
 * BlackStack CRM — Electron main process.
 *
 * Security model:
 *  - contextIsolation: true, nodeIntegration: false, sandbox: true
 *  - Renderer talks to this process ONLY via the IPC allowlist in preload.js
 *  - The CRM Express server is embedded and bound to 127.0.0.1 on an ephemeral
 *    port; the renderer loads it through that loopback URL.
 *  - License state lives in userData/license; activation codes are validated
 *    here, never in the renderer. Raw codes never cross IPC (only the attempt).
 */
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const LicenseManager = require('./license/license-manager');

const CRM_EMBED_DIR = path.join(__dirname, '..', 'crm');
const isDev = !!process.env.BLACKSTACK_DEV;
const DEV_CRM = process.env.BLACKSTACK_CRM_DIR;

let mainWindow = null;
let splash = null;
let server = null;
let serverPort = null;
let license = null;

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function loadServer() {
  // Embedded CRM (packaged) or dev CRM (BLACKSTACK_CRM_DIR).
  const crmDir = isDev && DEV_CRM ? DEV_CRM : CRM_EMBED_DIR;
  const appModule = path.join(crmDir, 'server', 'app.js');
  if (!fs.existsSync(appModule)) {
    throw new Error('CRM server module not found. Run "npm run build:embed" first.');
  }
  const userData = app.getPath('userData');
  const dbPath = path.join(userData, 'blackstack-crm.db');
  process.env.DB_PATH = dbPath;
  process.env.NODE_ENV = 'production';
  // Loopback-only ephemeral port; the embedded copy of app.js honors these.
  process.env.BLACKSTACK_EMBEDDED = 'true';
  process.env.BLACKSTACK_HOST = '127.0.0.1';
  process.env.PORT = '0';
  // Per-install random JWT secret (never hard-coded, not persisted plaintext
  // alongside the DB; users re-login after a DB-folder reset).
  const secretFile = path.join(userData, '.jwt-secret');
  if (!fs.existsSync(secretFile)) {
    fs.writeFileSync(secretFile, require('crypto').randomBytes(48).toString('hex'), { encoding: 'utf8' });
  }
  process.env.JWT_SECRET = fs.readFileSync(secretFile, 'utf8');

  // First-run data migration: copy the packaged template DB into userData.
  // COPY (never move); the original template stays intact for rollback.
  if (!fs.existsSync(dbPath)) {
    const template = path.join(crmDir, 'data', 'blackstack-crm.db');
    fs.mkdirSync(userData, { recursive: true });
    if (fs.existsSync(template)) fs.copyFileSync(template, dbPath);
  }

  // app.js self-listens (and runs migrations) on require.
  const expressApp = require(appModule);
  return new Promise((resolve, reject) => {
    let waited = 0;
    const tick = () => {
      const port = expressApp.get && expressApp.get('bsPort');
      if (port) return resolve(port);
      waited += 100;
      if (waited > 30000) return reject(new Error('CRM server did not start in time.'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function createSplash() {
  splash = new BrowserWindow({
    width: 420, height: 280, frame: false, resizable: false,
    alwaysOnTop: true, show: true, center: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splash.loadFile(path.join(__dirname, '..', 'desktop', 'splash.html'));
}

function showWindowForState() {
  const status = license.license_status;
  const unlocked = status === 'TRIAL_ACTIVE' || status === 'ACTIVE';
  if (mainWindow) { mainWindow.close(); mainWindow = null; }
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700,
    title: 'BlackStack CRM',
    show: false,
    backgroundColor: '#0f172a',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('page-title-updated', (e) => e.preventDefault());
  if (unlocked) {
    mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
    // Inject trial banner + license page into the CRM renderer.
    mainWindow.webContents.on('did-finish-load', () => {
      if (license && (license.license_status === 'TRIAL_ACTIVE' || license.license_status === 'ACTIVE')) {
        const injectPath = path.join(__dirname, '..', 'desktop', 'inject', 'license-ui.js');
        try {
          mainWindow.webContents.executeJavaScript(require('fs').readFileSync(injectPath, 'utf8'));
        } catch (err) { console.warn('[inject] failed:', err.message); }
      }
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'desktop', 'expired.html'));
  }
  mainWindow.once('ready-to-show', () => {
    if (splash && !splash.isDestroyed()) splash.destroy();
    mainWindow.show();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  // Open external links in the default browser, not in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showErrorWindow(message) {
  if (splash && !splash.isDestroyed()) splash.destroy();
  mainWindow = new BrowserWindow({
    width: 560, height: 320, title: 'BlackStack CRM', show: true, center: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'desktop', 'error.html'), { query: { message } });
}

app.whenReady().then(async () => {
  createSplash();
  try {
    license = new LicenseManager(app.getPath('userData'), app.getVersion());
    const state = license.evaluate();
    serverPort = await loadServer();
    showWindowForState();
    if (state && state.license_status === 'SUSPICIOUS_CLOCK') {
      // Surface once via dialog-free banner: renderer polls license state.
      console.warn('[license] SUSPICIOUS_CLOCK — administrator review required');
    }
  } catch (err) {
    showErrorWindow(String(err && err.message ? err.message : err));
  }
});

app.on('window-all-closed', () => {
  if (server) server.close();
  app.quit();
});

// ---------------------------------------------------------------------------
// IPC allowlist — the ONLY channels the renderer can invoke.
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('license:getState', () => license.getInfo());
  ipcMain.handle('license:activate', (_e, code) => {
    if (typeof code !== 'string' || code.length > 64) {
      return { ...(license.getInfo()), activation_error: 'Invalid activation code format.' };
    }
    const result = license.activate(code);
    // If activation just unlocked the app, swap to the CRM view.
    if (result.license_status === 'ACTIVE' && mainWindow) showWindowForState();
    return result;
  });
  ipcMain.handle('license:getAudit', () => {
    const { readAudit } = require('./license/storage');
    return readAudit(app.getPath('userData'), 100);
  });
  ipcMain.handle('backup:getPath', () => {
    const dbPath = process.env.DB_PATH || path.join(app.getPath('userData'), 'blackstack-crm.db');
    return { dbPath, backupHint: path.join(app.getPath('userData'), 'backups') };
  });
  ipcMain.handle('app:version', () => app.getVersion());
}
registerIpc();
