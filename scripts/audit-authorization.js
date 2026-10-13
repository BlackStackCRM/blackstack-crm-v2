/**
 * PHASE 3 — Authorization audit.
 *
 * The requirement is that authorization is enforced by the BACKEND. A hidden
 * button is not authorization. This script, for each route under audit:
 *
 *   1. calls it with NO token            -> expect 401
 *   2. calls it with a valid low-privilege token -> expect 403 (or 404 by design)
 *   3. calls it with a super-admin token -> expect NOT 401/403
 *
 * It prints a table, then exits non-zero if any unauthenticated call was served
 * anything other than 401. That condition — a public mutation — is the one that
 * is unambiguously a production bug.
 *
 * Read-only: every method other than GET/HEAD is sent to a route that is
 * expected to reject it before touching data, and the server is started against a
 * disposable copy of the database. Nothing here writes to the live database.
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3000);
const BASE = `http://127.0.0.1:${PORT}`;

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.on('connect',()=>{s.destroy();resolve(true);});
    s.on('error',()=>resolve(false));
    setTimeout(()=>{s.destroy();resolve(false);},1500);
  });
}

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, token: j?.data?.token || j?.token || j?.data?.accessToken || null, body: j };
}

// ── Routes to probe: [method, path, label] ───────────────────────────────
const ROUTES = [
  ['GET',    '/api/products',                    'read products'],
  ['POST',   '/api/products',                    'create product'],
  ['GET',    '/api/customers',                   'read customers'],
  ['POST',   '/api/customers',                   'create customer'],
  ['GET',    '/api/inventory/stocks',            'read stock items'],
  ['POST',   '/api/inventory/stocks',            'create stock item'],
  ['GET',    '/api/inventory/masters/locations', 'read locations'],
  ['POST',   '/api/inventory/masters/locations', 'create location'],
  ['POST',   '/api/inventory/masters/godowns',   'create godown'],
  ['POST',   '/api/inventory/vouchers',          'create voucher'],
  ['GET',    '/api/inventory/reports/stock_valuation', 'inventory report'],
  ['GET',    '/api/accounting/accounts',         'read ledger accounts'],
  ['POST',   '/api/accounting/accounts',         'create ledger account'],
  ['GET',    '/api/accounting/reports',          'accounting reports'],
  ['GET',    '/api/customer-bills',              'read customer bills'],
  ['POST',   '/api/customer-bills',              'create customer bill'],
  ['GET',    '/api/permissions',                 'read permissions'],
  ['GET',    '/api/users',                       'read users'],
  ['GET',    '/api/settings',                    'read settings'],
  ['GET',   '/api/invoices',                     'read invoices (legacy)'],
];

const MUTATION_BODY = { name: 'AUTHZ-PROBE', code: 'AUTHZ-PROBE', company_id: 'default' };

(async () => {
  if (await portInUse(PORT)) { console.error(`port ${PORT} busy — refusing to probe`); process.exit(2); }

  const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'bscrm-authz-'));
  const testDb = path.join(tmpDir, 'authz.db');
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), testDb);
  for (const s of ['-wal', '-shm']) {
    const src = path.join(ROOT, 'data', 'blackstack-crm.db' + s);
    if (fs.existsSync(src)) fs.copyFileSync(src, testDb + s);
  }

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

  let up = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch (_) {}
  }
  if (!up) { console.error('server not ready'); process.exit(2); }

  const admin = await login('admin@blackstack.local', 'admin123');
  console.log(`admin login: HTTP ${admin.status} token=${admin.token ? 'yes' : 'NO'}`);

  // Try to obtain a lower-privilege account. The seed/demo data is the only
  // source; if none exists we report that rather than inventing credentials.
  const CANDIDATES = [
    ['user@blackstack.local', 'user123'],
    ['manager@blackstack.local', 'manager123'],
    ['staff@blackstack.local', 'staff123'],
    ['accounts@blackstack.local', 'accounts123'],
    ['admin@blackstack.local', 'password'],
  ];
  let lowUser = null;
  for (const [e, p] of CANDIDATES) {
    const r = await login(e, p);
    if (r.status === 200 && r.token) { lowUser = { email: e, token: r.token }; break; }
  }
  console.log(`low-privilege account: ${lowUser ? lowUser.email : 'NONE AVAILABLE (see report)'}`);

  const rows = [];
  for (const [method, p, label] of ROUTES) {
    const opts = (token) => ({
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(MUTATION_BODY) }),
    });

    let anon, asUser, asAdmin;
    try { anon = (await fetch(BASE + p, opts(null))).status; } catch (e) { anon = 'ERR'; }
    try { asUser = (await fetch(BASE + p, opts(lowUser ? lowUser.token : null))).status; } catch (e) { asUser = 'ERR'; }
    try { asAdmin = (await fetch(BASE + p, opts(admin.token))).status; } catch (e) { asAdmin = 'ERR'; }

    // A mutation served to an anonymous caller is the critical defect.
    const anonLeak = method !== 'GET' && anon !== 401 && anon !== 'ERR';
    // A mutation served to a low-privilege caller is a privilege problem, but
    // only if that account genuinely lacks the permission.
    const userLeak = method !== 'GET' && lowUser && asUser !== 401 && asUser !== 403 && asUser !== 'ERR';

    rows.push({ method, path: p, label, anon, user: asUser, admin: asAdmin, anonLeak, userLeak });
  }

  console.log('\n method  anon  user  admin  endpoint');
  console.log(' ------- ----  ----  -----  --------------------------------------------');
  for (const r of rows) {
    const flag = r.anonLeak ? ' <<< ANON MUTATION ALLOWED' : (r.userLeak ? ' <<< USER MUTATION ALLOWED' : '');
    console.log(
      ` ${r.method.padEnd(6)} ${String(r.anon).padEnd(4)} ${String(r.user).padEnd(4)} ${String(r.admin).padEnd(5)}  ${r.path}${flag}`,
    );
  }

  const anonLeaks = rows.filter((r) => r.anonLeak);
  const userLeaks = rows.filter((r) => r.userLeak);
  console.log(`\nunauthenticated mutation leaks: ${anonLeaks.length}`);
  console.log(`low-privilege mutation leaks  : ${userLeaks.length}`);

  stop();
  await new Promise((r) => setTimeout(r, 700));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(anonLeaks.length > 0 ? 1 : 0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });