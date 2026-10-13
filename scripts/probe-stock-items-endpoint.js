/**
 * Which endpoint actually lists stock items?
 *
 * Tests 24 and 25 read /api/inventory/masters/stock_items, while
 * public/js/pages/inventory-sub.js reads /api/inventory/stocks. Reading the
 * source gave two conflicting answers, so ask the running server — the only
 * authority that settles it. Reports the item count and a known name from each.
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3000);

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1500);
  });
}

(async () => {
  if (await portInUse(PORT)) { console.error(`port ${PORT} busy`); process.exit(2); }

  const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'bscrm-siapi-'));
  const testDb = path.join(tmpDir, 'siapi.db');
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), testDb);

  const logFd = fs.openSync(path.join(tmpDir, 'server.log'), 'w');
  const server = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: testDb,
      BLACKSTACK_USER_DATA_DIR: path.join(tmpDir, 'ud').replace(/\\/g, '/'),
    },
    stdio: ['ignore', logFd, logFd],
  });
  const stop = () => { try { server.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', stop);

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) break; } catch (_) {}
  }

  // Authenticate the same way the E2E suite does.
  const login = await fetch(`http://localhost:${PORT}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@blackstack.local', password: 'admin123' }),
  }).catch(() => null);

  let token = null;
  if (login && login.ok) {
    const j = await login.json().catch(() => null);
    token = j?.data?.token || j?.token || j?.data?.accessToken || null;
  }
  if (!token) {
    // Fall back to scraping the known demo creds path if the shape differs.
    console.log('login response was not a token; probing unauthenticated to see the error');
  }
  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  for (const url of [
    '/api/inventory/stocks?limit=200',
    '/api/inventory/masters/stock_items?limit=200',
  ]) {
    const r = await fetch(`http://localhost:${PORT}${url}`, { headers });
    const body = await r.text();
    let j = null; try { j = JSON.parse(body); } catch (_) {}
    const items = j?.data?.items || j?.items || [];
    console.log(`\n${url}`);
    console.log(`  HTTP ${r.status}  items=${items.length}  total=${j?.data?.total ?? j?.total ?? 'n/a'}`);
    console.log(`  names=${JSON.stringify(items.slice(0, 6).map((x) => x.name))}`);
    if (!r.ok) console.log(`  body=${body.slice(0, 200)}`);
  }

  stop();
  await new Promise((r) => setTimeout(r, 700));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });