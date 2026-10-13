/**
 * Starts the existing CRM server in-process and returns a handle with stop().
 * Reuses server/app.js — no duplicate server implementation.
 *
 * Phase 1 desktop hardening (spec §20 / audit G2+G3):
 *  - Sets BLACKSTACK_DESKTOP=1 so server/app.js binds to 127.0.0.1 ONLY.
 *  - Checks port availability BEFORE loading the server module; if the
 *    requested port is occupied, walks a documented fallback range and
 *    records the chosen port (process.env.PORT + log).
 *  - stop() relies on app.js's graceful SIGTERM shutdown (closes the
 *    http.Server, then SQLite), which now exists and is process-safe.
 */
const path = require('path');
const net = require('net');

const DESKTOP_PORT_FALLBACKS = [34567, 34568, 34569, 34570, 34571, 34572];

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickPort(requested, log) {
  if (await isPortFree(requested)) return { port: requested, fellBack: false };
  log(`Port ${requested} is occupied — trying documented fallbacks.`);
  for (const p of DESKTOP_PORT_FALLBACKS) {
    if (p === requested) continue;
    if (await isPortFree(p)) {
      log(`Fallback selected: port ${p}`);
      return { port: p, fellBack: true };
    }
  }
  throw new Error('No free port available in range ' + DESKTOP_PORT_FALLBACKS.join(', '));
}

async function startServer({ log = console.log } = {}) {
  process.env.DEMO_MODE = process.env.DEMO_MODE || 'false';
  process.env.BLACKSTACK_DESKTOP = '1'; // server/app.js binds 127.0.0.1 only

  const requested = parseInt(process.env.PORT || '34567', 10);
  const { port } = await pickPort(requested, log);
  process.env.PORT = String(port);

  // Loading server/app.js runs safe migrations and starts listening (async).
  const appModule = require(path.join(__dirname, '../server/app'));
  log('CRM server module loaded (desktop binding 127.0.0.1, port ' + port + ')');

  return {
    app: appModule,
    port,
    async stop() {
      // Graceful shutdown handled by app.js SIGTERM handler (closes http.Server
      // then SQLite). Runs only at app exit.
      try { process.kill(process.pid, 'SIGTERM'); } catch { /* noop */ }
    },
  };
}

module.exports = { startServer, DESKTOP_PORT_FALLBACKS };
