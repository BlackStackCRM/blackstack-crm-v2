/**
 * BlackStack CRM V2 — Server Launcher
 *
 * A lightweight always-running gateway that sits on port 3000 (the port the
 * user opens in the browser). Its responsibilities:
 *
 *   1. When the CRM backend (port 3001) is NOT running, it serves a branded
 *      "Server Offline / Start CRM Server" page instead of the browser's
 *      ugly "ERR_CONNECTION_REFUSED".
 *   2. Provides an API endpoint that starts the CRM backend using the
 *      project's existing startup mechanism (`node server/app.js`).
 *   3. Polls the CRM /health endpoint to detect when the backend comes up.
 *   4. When the backend is up, it reverse-proxies all requests to the CRM
 *      so the user experiences the app on port 3000 as normal.
 *   5. If the backend is already running when the launcher starts, it skips
 *      the offline page entirely and proxies immediately.
 *
 * The CRM backend runs on port 3001 (LAUNCHER_CRM_PORT). The user-facing
 * URL remains http://localhost:3000 — the existing port. The internal
 * backend port is a non-breaking implementation detail.
 *
 * Uses ONLY Node.js built-in modules (no extra npm dependencies).
 */

'use strict';

const dotenv = require('dotenv');
const path = require('path');
const http = require('http');
const express = require('express');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CRM_APP = path.join(ROOT, 'server', 'app.js');

// Load launcher .env (configures launcher port + CRM env vars like DB_PATH/DEMO_MODE)
dotenv.config({ path: path.join(__dirname, '.env') });

const LAUNCHER_PORT = parseInt(process.env.LAUNCHER_PORT || '3000', 10);
const CRM_PORT = parseInt(process.env.LAUNCHER_CRM_PORT || '3001', 10);
const CRM_HOST = '127.0.0.1';
const HEALTH_PATH = '/health';
const HEALTH_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 1500;           // active polling while starting
const IDLE_POLL_MS = 5000;             // background polling when healthy
const STARTUP_GRACE_MS = 30000;        // give the CRM this long to boot

const STATUS = {
  OFFLINE: 'offline',
  STARTING: 'starting',
  ONLINE: 'online',
  ERROR: 'error',
};

let crmState = STATUS.OFFLINE;
let crmProcess = null;
let lastError = null;
let lastHealthCheck = 0;

const app = express();

// ---------------------------------------------------------------------------
// Health-check helper — raw HTTP request to CRM /health endpoint.
// ---------------------------------------------------------------------------
function checkHealth() {
  return new Promise((resolve) => {
    const req = http.request({
      host: CRM_HOST,
      port: CRM_PORT,
      path: HEALTH_PATH,
      method: 'GET',
      timeout: HEALTH_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ ok: false, status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: '' }); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Reverse-proxy function using Node core http.
// Forwards the incoming Express request to the CRM backend and pipes the
// response back, preserving status, headers, and body.
// ---------------------------------------------------------------------------
function proxyToCrm(req, res) {
  // Build a clean header set — strip hop-by-hop and content-length (we
  // reconstruct the body separately below to avoid mismatches).
  const fwdHeaders = {};
  const skipHeaders = ['host', 'connection', 'keep-alive', 'transfer-encoding',
    'content-length', 'content-encoding', 'x-forwarded-for', 'x-forwarded-proto',
    'x-request-id'];
  Object.keys(req.headers).forEach((key) => {
    if (!skipHeaders.includes(key.toLowerCase())) {
      fwdHeaders[key] = req.headers[key];
    }
  });
  fwdHeaders['host'] = `localhost:${CRM_PORT}`;

  const proxyReq = http.request({
    host: CRM_HOST,
    port: CRM_PORT,
    path: req.url,
    method: req.method,
    headers: fwdHeaders,
  }, (proxyRes) => {
    res.status(proxyRes.statusCode || 502);
    // Forward response headers from CRM, skipping hop-by-hop headers.
    const skipRespHeaders = ['connection', 'keep-alive', 'transfer-encoding', 'content-encoding'];
    Object.keys(proxyRes.headers).forEach((key) => {
      if (!skipRespHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, proxyRes.headers[key]);
      }
    });
    if (req.method === 'HEAD') {
      proxyRes.resume();
      res.end();
      return;
    }
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[launcher] Proxy error:', err.message);
    if (!res.headersSent) {
      if (req.method === 'GET') {
        serveOfflinePage(res);
      } else {
        res.status(503).json({
          success: false,
          error: { code: 'CRM_OFFLINE', message: 'CRM server is not running.' },
        });
      }
    }
  });

  // Forward the raw request body via streaming (works for JSON, form-data, etc.).
  // express.json() is NOT applied to proxied routes, so req.pipe() gets the
  // untouched stream.
  if (req.method === 'GET' || req.method === 'HEAD') {
    proxyReq.end();
  } else {
    req.pipe(proxyReq);
  }
}

// ---------------------------------------------------------------------------
// Background health monitor
// ---------------------------------------------------------------------------
function startHealthMonitor() {
  let pollMs = POLL_INTERVAL_MS;
  let startingSince = null;

  async function tick() {
    const result = await checkHealth();
    lastHealthCheck = Date.now();

    if (result.ok) {
      if (crmState !== STATUS.ONLINE) {
        crmState = STATUS.ONLINE;
        lastError = null;
        startingSince = null;
        console.log('[launcher] CRM backend is ONLINE on port', CRM_PORT);
      }
      pollMs = IDLE_POLL_MS;
    } else {
      if (crmState === STATUS.ONLINE) {
        crmState = STATUS.OFFLINE;
        console.log('[launcher] CRM backend went OFFLINE');
        // Note: we do NOT null crmProcess here — the process 'exit' handler
        // already does that when the process truly terminates. This lets the
        // /api/launcher/stop endpoint reliably kill a launcher-spawned CRM
        // even if the health monitor detected it as offline first.
      }
      pollMs = POLL_INTERVAL_MS;
    }

    // Startup timeout detection
    if (crmState === STATUS.STARTING && !startingSince) {
      startingSince = Date.now();
    } else if (crmState === STATUS.STARTING && startingSince) {
      if (Date.now() - startingSince > STARTUP_GRACE_MS && !result.ok) {
        crmState = STATUS.ERROR;
        lastError = result.status === 0
          ? `CRM backend did not become healthy within ${STARTUP_GRACE_MS / 1000}s of startup.`
          : `CRM backend responded with HTTP ${result.status} during startup. Body: ${(result.body || '').slice(0, 200)}`;
        console.error('[launcher] Startup error:', lastError);
        startingSince = null;
        if (crmProcess && !crmProcess.killed) {
          crmProcess.kill('SIGKILL');
        }
        crmProcess = null;
      }
    }

    if (crmState !== STATUS.STARTING) {
      startingSince = null;
    }

    setTimeout(tick, pollMs);
  }

  tick();
}

// ---------------------------------------------------------------------------
// CRM startup — uses the EXACT existing project startup mechanism.
// Spawns `node server/app.js` with the same env vars the project expects
// (PORT, DB_PATH, DEMO_MODE), reading from .env first then applying override.
// ---------------------------------------------------------------------------
function startCrm() {
  const env = { ...process.env };
  // CRM backend runs on CRM_PORT (3001); launcher stays on LAUNCHER_PORT (3000).
  env.PORT = String(CRM_PORT);
  // DB_PATH / DEMO_MODE are inherited from process.env, preserving the
  // existing server configuration from .env.

  const nodeBin = process.execPath;

  crmProcess = spawn(nodeBin, [CRM_APP], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  crmProcess.on('exit', (code, signal) => {
    console.log(`[launcher] CRM process exited (code=${code}, signal=${signal})`);
    if (crmState === STATUS.STARTING) {
      crmState = STATUS.ERROR;
      lastError = `CRM process exited prematurely with code ${code}` +
        (signal ? ` (signal: ${signal})` : '');
    }
    crmProcess = null;
  });

  crmProcess.on('error', (err) => {
    console.error('[launcher] Failed to spawn CRM process:', err.message);
    lastError = `Failed to spawn CRM process: ${err.message}`;
    crmProcess = null;
  });

  if (crmProcess.stdout) {
    crmProcess.stdout.on('data', (data) => {
      process.stdout.write('[crm-stdout] ' + data.toString());
    });
  }
  if (crmProcess.stderr) {
    crmProcess.stderr.on('data', (data) => {
      process.stderr.write('[crm-stderr] ' + data.toString());
    });
  }
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.get('/api/launcher/status', (req, res) => {
  res.json({
    success: true,
    data: {
      launcherPort: LAUNCHER_PORT,
      crmPort: CRM_PORT,
      crmState,
      crmUrl: `http://${CRM_HOST}:${CRM_PORT}`,
      lastHealthCheck,
      error: lastError,
      nodeVersion: process.version,
    },
  });
});

app.post('/api/launcher/start', (req, res) => {
  if (crmState === STATUS.ONLINE) {
    return res.json({ success: true, data: { state: crmState, alreadyRunning: true } });
  }
  if (crmState === STATUS.STARTING) {
    return res.json({ success: true, data: { state: crmState, alreadyStarting: true } });
  }

  console.log('[launcher] Starting CRM backend...');
  crmState = STATUS.STARTING;
  lastError = null;
  startCrm();

  res.json({ success: true, data: { state: STATUS.STARTING } });
});

app.post('/api/launcher/stop', (req, res) => {
  let killed = false;
  if (crmProcess && !crmProcess.killed) {
    killed = true;
    crmProcess.kill('SIGTERM');
    // Give SIGTERM time to work, then SIGKILL if still alive
    const forceKill = setTimeout(() => {
      if (crmProcess && !crmProcess.killed) {
        crmProcess.kill('SIGKILL');
      }
    }, 3000);
    // Clean up reference once the process exits
    crmProcess.on('exit', () => {
      clearTimeout(forceKill);
    });
  }
  crmProcess = null;
  crmState = STATUS.OFFLINE;
  lastError = null;
  res.json({ success: true, data: { state: crmState, stopped: killed } });
});

app.use(express.static(PUBLIC_DIR));

// JSON parser — ONLY for the launcher's own API routes, not for proxied CRM
// requests (which need their raw body forwarded intact).
app.use('/api/launcher/', express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Serve the offline page with strict no-cache headers (prevents the browser
// from caching the "Server Offline" page after the CRM comes back online).
// ---------------------------------------------------------------------------
function serveOfflinePage(res) {
  res.status(200);
  // Strict no-cache headers — prevents the browser from caching the offline
  // page and showing it even after the CRM comes back online.
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const filePath = path.join(PUBLIC_DIR, 'offline.html');
  return res.sendFile(filePath);
}

// ---------------------------------------------------------------------------
// Gateway middleware: serve offline page or proxy to CRM
// ---------------------------------------------------------------------------
function gatewayMiddleware(req, res, next) {
  const isLauncherApi = req.path.startsWith('/api/launcher/');

  if (isLauncherApi) {
    return next();
  }

  if (crmState === STATUS.ONLINE) {
    return proxyToCrm(req, res);
  }

  // CRM offline/starting/error — serve the offline page for GET navigation
  if (req.method === 'GET') {
    return serveOfflinePage(res);
  }

  // Non-GET when offline
  return res.status(503).json({
    success: false,
    error: { code: 'CRM_OFFLINE', message: 'CRM server is not running.' },
  });
}

app.use(gatewayMiddleware);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = app.listen(LAUNCHER_PORT, () => {
  console.log(`[launcher] BlackStack CRM Launcher listening on http://localhost:${LAUNCHER_PORT}`);
  console.log(`[launcher] CRM backend target: http://${CRM_HOST}:${CRM_PORT}`);
  startHealthMonitor();

  // Immediate health check on startup (detects already-running CRM)
  setTimeout(() => {
    checkHealth().then((result) => {
      if (result.ok) {
        crmState = STATUS.ONLINE;
        lastError = null;
        console.log('[launcher] CRM backend already running — switching to ONLINE');
      } else {
        console.log('[launcher] CRM backend not running — serving offline page');
      }
    });
  }, 500);
});

module.exports = { app, server, STATUS, crmState };
