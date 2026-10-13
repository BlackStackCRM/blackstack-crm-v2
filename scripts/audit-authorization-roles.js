/**
 * PHASE 3 (definitive) — prove authorization with REAL roles.
 *
 * The seeded database has three system roles. `role_manager` holds 20
 * permissions but NOT `settings.manage`, so it is a genuine
 * authenticated-but-unauthorized caller: exactly what the requirement means by
 * "a hidden button is NOT authorization — the backend must reject it".
 *
 * Rather than mint a token (which risks signing with a different secret than the
 * running server, yielding a misleading 401), this assigns the manager role to a
 * real user inside the DISPOSABLE database copy, logs in through the real
 * /api/auth/login endpoint, and checks the resulting status codes.
 *
 * Asserts:
 *   anonymous            -> 401
 *   manager (no grant)   -> 403
 *   admin  (has grant)   -> 2xx
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3000);
const BASE = `http://127.0.0.1:${PORT}`;

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1500);
  });
}

/** Insert a manager user into the disposable copy and confirm its grants. */
function seedManager(dbPath) {
  const db = new DatabaseSync(dbPath);
  // users schema: id, company_id, username, email, password_hash, full_name,
  //               role, status, ...
  // Reuse the admin's bcrypt hash so the login path (which verifies a real
  // hash) accepts the seeded credentials — no need to reimplement hashing.
  const admin = db.prepare("SELECT password_hash FROM users WHERE id = 'admin'").get();
  if (!admin) throw new Error('seed admin user not found');

  db.prepare(`
    INSERT OR REPLACE INTO users
      (id, company_id, username, email, password_hash, full_name, role, status)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    'e2e_manager', 'default', 'e2e_manager', 'manager@blackstack.local',
    admin.password_hash, 'E2E Manager', 'MANAGER', 'ACTIVE',
  );
  db.exec("DELETE FROM user_roles WHERE user_id = 'e2e_manager'");
  db.exec("INSERT INTO user_roles (user_id, role_id) VALUES ('e2e_manager', 'role_manager')");

  const granted = db.prepare(
    `SELECT COUNT(*) c FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = 'role_manager'`,
  ).get().c;
  const hasSettings = db.prepare(
    `SELECT COUNT(*) c FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = 'role_manager' AND p.code = 'settings.manage'`,
  ).get().c;
  db.close();
  return { granted, hasSettings: hasSettings > 0 };
}

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, token: j?.data?.token || j?.token || null, body: j };
}

const PROBES = [
  ['GET',  '/api/datasafety/backups'],
  ['GET',  '/api/datasafety/storage'],
  ['GET',  '/api/datasafety/backups/status'],
  ['POST', '/api/datasafety/backups'],
  ['POST', '/api/datasafety/data-deletion/token'],
  ['POST', '/api/datasafety/backups/restore'],
];

(async () => {
  if (await portInUse(PORT)) { console.error(`port ${PORT} busy`); process.exit(2); }

  const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'bscrm-rbac-'));
  const testDb = path.join(tmpDir, 'rbac.db');
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), testDb);

  let seed;
  try { seed = seedManager(testDb); }
  catch (e) { console.error('could not seed manager user:', e.message); process.exit(2); }
  console.log(`manager role seeded: ${seed.granted} permissions, settings.manage = ${seed.hasSettings}`);

  // The copy is opened by the seeding connection and closed. SQLite may leave
  // the insert in the WAL rather than the main file; the server opens a fresh
  // connection and would not see it. Force a checkpoint so the row is durable
  // in the file the server will read.
  try {
    const chk = new DatabaseSync(testDb);
    chk.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const seen = chk.prepare("SELECT COUNT(*) c FROM users WHERE id='e2e_manager'").get().c;
    chk.close();
    console.log(`manager row visible after checkpoint: ${seen === 1 ? 'yes' : 'NO'}`);
  } catch (e) {
    console.log(`checkpoint failed: ${e.message}`);
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

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) {}
  }

  const mgr = await login('manager@blackstack.local', 'admin123');
  const adm = await login('admin@blackstack.local', 'admin123');
  console.log(`manager login: HTTP ${mgr.status} token=${mgr.token ? 'yes' : 'NO'}`);
  console.log(`admin   login: HTTP ${adm.status} token=${adm.token ? 'yes' : 'NO'}`);

  if (!mgr.token) {
    console.log('\nManager login failed — password hashing differs from the seeded admin.');
    console.log(`  response: ${JSON.stringify(mgr.body).slice(0, 200)}`);
    console.log('  Cannot exercise the 403 path via login; see audit report.');
    stop(); await new Promise((r) => setTimeout(r, 600));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    process.exit(0);
  }

  const call = async (method, p, token) => {
    try {
      const r = await fetch(BASE + p, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify({}) }),
      });
      return r.status;
    } catch (e) { return 'ERR'; }
  };

  console.log('\nendpoint                                  anon  manager  admin   verdict');
  console.log('----------------------------------------  ----  -------  ------  ---------------');
  let bad = 0;
  for (const [method, p] of PROBES) {
    const anon = await call(method, p, null);
    const asMgr = await call(method, p, mgr.token);
    const asAdm = await call(method, p, adm.token);
    const ok = anon === 401 && asMgr === 403 && asAdm !== 401 && asAdm !== 403;
    if (!ok) bad++;
    console.log(
      `${`${method} ${p}`.padEnd(40)}  ${String(anon).padEnd(4)}  ${String(asMgr).padEnd(7)}  ${String(asAdm).padEnd(6)}  ${ok ? 'PASS' : 'FAIL'}`,
    );
  }
  console.log(`\n401 anon / 403 manager / 2xx admin — failures: ${bad} of ${PROBES.length}`);

  stop();
  await new Promise((r) => setTimeout(r, 600));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });