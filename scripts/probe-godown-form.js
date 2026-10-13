/**
 * Verify the exact sequence Test 7 performs: create a Location via the API on a
 * database that has just been wiped, then confirm the godown form's select can
 * be populated and the save succeeds.
 *
 *   node scripts/probe-godown-form.js
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'data', 'godown-form-probe-test');
const DB = path.join(WORK, 'godown-form-probe-test.db');
const { assertDisposableDb } = require(path.join(ROOT, 'scripts', 'assert-disposable-db'));
const safePath = assertDisposableDb(DB, { suite: 'probe-godown-form.js' });
const PORT = 3491;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), safePath);
  for (const s of ['-wal', '-shm']) if (fs.existsSync(safePath + s)) fs.copyFileSync(safePath + s, safePath + s);

  // Reproduce beforeAll: wipe the inventory masters exactly as the suite does.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(safePath);
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['godowns', 'locations', 'stock_categories', 'stock_groups', 'brands']) {
    try { db.exec(`DELETE FROM ${t}`); } catch (_) { /* absent */ }
  }
  db.close();
  console.log('wiped godowns/locations/stock_categories/stock_groups/brands');

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
  const H = { Authorization: `Bearer ${login?.data?.token || login?.token}`, 'Content-Type': 'application/json' };

  const call = async (m, ep, body) => {
    const r = await fetch(`${base}${ep}`, { method: m, headers: H, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch (_) {}
    return { status: r.status, body: j, raw: t };
  };

  console.log('\n1. create Location via API (what ensureLocation does)');
  const loc = await call('POST', '/api/inventory/masters/locations', {
    company_id: 'default', name: 'E2E Test Location', code: 'E2E-LOC',
  });
  console.log('   HTTP', loc.status, loc.raw.slice(0, 160));
  const locId = loc.body?.data?.id || loc.body?.id;

  console.log('\n2. list locations (what the form select reads)');
  const list = await call('GET', '/api/inventory/masters/locations?limit=200');
  const items = list.body?.data?.items || list.body?.items || [];
  console.log('   HTTP', list.status, 'items =', items.length, 'first id =', items[0]?.id || 'NONE');

  console.log('\n3. create Godown WITH location_id (what createMaster should send)');
  const gd = await call('POST', '/api/inventory/masters/godowns', {
    company_id: 'default', name: 'E2E Main Warehouse', code: 'E2E-WH', location_id: locId,
  });
  console.log('   HTTP', gd.status, gd.raw.slice(0, 200));

  console.log('\n4. create Godown WITHOUT location_id (the original bug)');
  const gd2 = await call('POST', '/api/inventory/masters/godowns', {
    company_id: 'default', name: 'E2E Bad Warehouse', code: 'E2E-BW',
  });
  console.log('   HTTP', gd2.status, gd2.raw.slice(0, 200));

  stop();
  await sleep(800);
  fs.rmSync(WORK, { recursive: true, force: true });
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
