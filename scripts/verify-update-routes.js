/**
 * PHASE B — route-level verification of the update / data-safety endpoints.
 *
 * Phase A proved the routes were broken and the UI could not authenticate. This
 * script measures the FULL contract that the unit tests never checked:
 *
 *   anonymous                     -> 401
 *   authenticated, no permission  -> 403
 *   authenticated admin           -> 2xx WITH A VALID BODY
 *
 * Bodies are asserted, not just status codes. Phase A's two defects were a 500 and
 * a 400 that a status-only test could have reported as "protected but working".
 *
 * Read-only apart from channel PUT (which writes a preferences file inside the
 * disposable user-data dir) and backup create/rotate. The live database is never
 * opened for writing.
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.VERIFY_PORT || 3161);
const BASE = `http://127.0.0.1:${PORT}`;
const require_ = createRequire(path.join(ROOT, 'package.json'));
const { DatabaseSync } = require_('node:sqlite');

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1200);
  });
}

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, token: j?.data?.token || null };
}

async function call(method, p, token, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  if (await portInUse(PORT)) { console.error(`port ${PORT} busy`); process.exit(2); }

  const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'bscrm-verify-'));
  const testDb = path.join(tmpDir, 'verify.db');
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), testDb);

  // Seed a low-privilege user bound to role_manager (20 permissions, deliberately
  // NOT settings.manage) so the 403 case is a genuine authorization test.
  {
    const db = new DatabaseSync(testDb);
    const admin = db.prepare("SELECT password_hash FROM users WHERE id='admin'").get();
    db.prepare(`INSERT OR REPLACE INTO users
      (id, company_id, username, email, password_hash, full_name, role, status)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run('v_manager', 'default', 'v_manager', 'vmanager@blackstack.local',
        admin.password_hash, 'Verify Manager', 'MANAGER', 'ACTIVE');
    db.exec("DELETE FROM user_roles WHERE user_id='v_manager'");
    db.exec("INSERT INTO user_roles (user_id, role_id) VALUES ('v_manager','role_manager')");
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  }

  const logFd = fs.openSync(path.join(tmpDir, 'server.log'), 'w');
  const server = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: testDb,
      BLACKSTACK_USER_DATA_DIR: path.join(tmpDir, 'ud').replace(/\\/g, '/'),
      NODE_ENV: '',
    },
    stdio: ['ignore', logFd, logFd],
  });
  const stop = () => { try { server.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', stop);
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) {}
  }

  const admin = await login('admin@blackstack.local', 'admin123');
  const manager = await login('vmanager@blackstack.local', 'admin123');
  console.log(`admin login HTTP ${admin.status}; manager login HTTP ${manager.status}\n`);
  if (!admin.token || !manager.token) {
    console.error('could not obtain both tokens');
    process.exit(2);
  }

  // ── The three routes named in the Phase B brief, plus the other endpoints
  //    the Settings → Updates / Data Safety UI actually calls.
  const ROUTES = [
    ['GET',  '/api/datasafety/update-channel',      undefined, 'read update channel'],
    ['PUT',  '/api/datasafety/update-channel',      { channel: 'beta' }, 'write update channel'],
    ['GET',  '/api/datasafety/update-compatibility?target=2.0.0', undefined, 'schema compatibility'],
    ['GET',  '/api/datasafety/update-status',       undefined, 'update status'],
    ['GET',  '/api/datasafety/backups/status',      undefined, 'backup status'],
    ['GET',  '/api/datasafety/storage',             undefined, 'storage dashboard'],
  ];

  console.log('=== 401 / 403 / 2xx matrix ===\n');
  console.log('route                            anon  mgr   admin  verdict');
  console.log('--------------------------------  ----  ----  -----  ---------------');
  for (const [method, p, body, label] of ROUTES) {
    const anon = await call(method, p, null, body);
    const mgr = await call(method, p, manager.token, body);
    const adm = await call(method, p, admin.token, body);
    const ok = anon.status === 401 && mgr.status === 403 && adm.status >= 200 && adm.status < 300;
    check(`${method} ${p} (${label})`, ok,
      `anon=${anon.status} mgr=${mgr.status} admin=${adm.status}`);
  }

  console.log('\n=== response BODIES for authorized admin ===\n');

  {
    const r = await call('GET', '/api/datasafety/update-channel', admin.token);
    const ch = r.json?.data?.channel;
    const chans = r.json?.data?.channels;
    check('update-channel GET returns a channel', typeof ch === 'string' && ch.length > 0, `channel=${ch}`);
    check('update-channel GET returns the channel catalogue',
      !!chans && typeof chans === 'object' && Object.keys(chans).length >= 2,
      `channels=${chans ? Object.keys(chans).join(',') : 'missing'}`);
    check('update-channel GET has no TypeError/500', r.status === 200 && !/is not a function/.test(r.text));
  }

  {
    const r = await call('PUT', '/api/datasafety/update-channel', admin.token, { channel: 'beta' });
    check('update-channel PUT accepts a valid channel',
      r.status === 200 && r.json?.data?.channel === 'beta',
      `HTTP ${r.status} channel=${r.json?.data?.channel}`);
  }

  {
    const r = await call('PUT', '/api/datasafety/update-channel', admin.token, { channel: 'stable' });
    check('update-channel PUT round-trips back to stable',
      r.status === 200 && r.json?.data?.channel === 'stable', `channel=${r.json?.data?.channel}`);
  }

  {
    const r = await call('PUT', '/api/datasafety/update-channel', admin.token, { channel: 'nonsense' });
    check('update-channel PUT still rejects an invalid channel',
      r.status === 400 && r.json?.error?.code === 'INVALID_CHANNEL',
      `HTTP ${r.status} code=${r.json?.error?.code}`);
  }

  {
    const r = await call('GET', '/api/datasafety/update-compatibility?target=2.0.0', admin.token);
    const d = r.json?.data;
    check('update-compatibility GET returns a verdict',
      r.status === 200 && !!d?.result, `HTTP ${r.status} result=${d?.result}`);
    check('update-compatibility body carries schema context',
      typeof d?.currentApp === 'string' && d?.dbSchemaVersion !== undefined,
      `currentApp=${d?.currentApp} dbSchemaVersion=${d?.dbSchemaVersion}`);
    check('update-compatibility has no TypeError/500', !/is not a function/.test(r.text));
  }

  {
    const r = await call('GET', '/api/datasafety/update-compatibility', admin.token);
    check('update-compatibility rejects a missing target', r.status === 400, `HTTP ${r.status}`);
  }

  {
    const r = await call('GET', '/api/datasafety/update-status', admin.token);
    check('update-status returns 2xx', r.status === 200 && r.json?.success === true, `HTTP ${r.status}`);
  }

  console.log('\n=== security not weakened ===');
  {
    const r = await call('GET', '/api/datasafety/version', null);
    check('/version stays public (updater reads it before login)', r.status === 200, `HTTP ${r.status}`);
    const m = await call('GET', '/api/datasafety/storage', manager.token);
    check('manager is still refused storage', m.status === 403, `HTTP ${m.status}`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== ${results.length - failed.length}/${results.length} checks passed =====`);
  for (const f of failed) console.log(`  FAILED: ${f.name} (${f.detail})`);

  stop();
  await new Promise((r) => setTimeout(r, 700));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });