/**
 * Quick check of the endpoints the E2E suite depends on, against a disposable
 * copy of the database. Faster than a 5-minute browser run when the question is
 * only "does this endpoint return usable data?".
 *
 *   node scripts/probe-e2e-endpoints.js
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'data', 'e2e-endpoint-probe-test');
const DB = path.join(WORK, 'e2e-endpoint-probe-test.db');

const { assertDisposableDb } = require(path.join(ROOT, 'scripts', 'assert-disposable-db'));
const safePath = assertDisposableDb(DB, { suite: 'probe-e2e-endpoints.js' });
const PORT = 3488;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), safePath);
  for (const s of ['-wal', '-shm']) {
    if (fs.existsSync(safePath + s)) fs.copyFileSync(safePath + s, safePath + s);
  }

  const logFd = fs.openSync(path.join(WORK, 'server.log'), 'w');
  const server = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: safePath,
      BLACKSTACK_USER_DATA_DIR: path.join(WORK, 'user-data').replace(/\\/g, '/'),
      NODE_ENV: 'development',
    },
    stdio: ['ignore', logFd, logFd],
  });
  const stop = () => { try { server.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', stop);

  const base = `http://localhost:${PORT}`;
  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch (_) {}
  }
  if (!up) { console.error('server not ready'); process.exit(2); }

  const login = await (await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@blackstack.local', password: 'admin123' }),
  })).json();
  const token = login?.data?.token || login?.token;
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const probes = [
    ['GET', '/api/inventory/masters/locations?limit=1'],
    ['GET', '/api/inventory/locations?limit=1'],
    ['GET', '/api/inventory/masters/godowns?limit=50'],
    ['GET', '/api/inventory/masters/stock_groups?limit=200'],
    ['GET', '/api/inventory/stocks?limit=300'],
    ['GET', '/api/inventory/hierarchy/summary'],
  ];
  for (const [m, ep] of probes) {
    const r = await fetch(`${base}${ep}`, { headers: H });
    const t = await r.text();
    let count = '?';
    try {
      const j = JSON.parse(t);
      const items = j?.data?.items || j?.items || (Array.isArray(j?.data) ? j.data : []);
      count = Array.isArray(items) ? `${items.length} item(s)` : JSON.stringify(j).slice(0, 70);
    } catch (_) { count = t.slice(0, 60); }
    console.log(`  ${r.status} ${ep.padEnd(46)} ${count}`);
  }

  stop();
  await sleep(800);
  fs.rmSync(WORK, { recursive: true, force: true });
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
