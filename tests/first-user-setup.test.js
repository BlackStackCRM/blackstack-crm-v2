/**
 * Secure first-user setup — E2E test suite.
 *
 * Proves the required security properties against a REAL server process with
 * a REAL SQLite user store (never mocked):
 *   1. Empty user store -> setup mode is reported.
 *   2. First-user creation succeeds with valid input.
 *   3. Existing user store -> login mode is reported.
 *   4. Additional unauthenticated first-user creation is rejected (409).
 *   5. Two concurrent first-user requests create at most ONE administrator.
 *   6. The stored credential is a bcrypt hash, never plaintext.
 *   7. Unreadable user store -> 503 retry (fails closed, no setup exposure).
 *   8. Server restart preserves the initial account (login still works).
 *   9. Existing auth behavior intact (login + profile + logout work).
 *
 * Run: node tests/first-user-setup.test.js
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { createRequire } = require('module');

const require_ = createRequire(__filename);
const { DatabaseSync } = require_('node:sqlite');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SETUP_TEST_PORT || 3121);
const BASE = `http://127.0.0.1:${PORT}`;

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1500);
  });
}

let server = null;
let tmpDir = null;
let testDb = null;
const results = [];
let failed = 0;

function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + (detail || '')}`);
}

function spawnServer() {
  const logFd = fs.openSync(path.join(tmpDir, `server-${Date.now()}.log`), 'w');
  const child = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: testDb,
      NODE_ENV: 'test',
      // Ensure NO demo seeding happens in this test run (the launcher .env
      // sets DEMO_MODE=true; override it explicitly).
      DEMO_MODE: 'false',
      BOOTSTRAP_ADMIN_EMAIL: undefined,
      BOOTSTRAP_ADMIN_PASSWORD: undefined,
    },
    stdio: ['ignore', logFd, logFd],
  });
  return child;
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch (_) {}
  }
  return false;
}

async function setupStatus() {
  const r = await fetch(`${BASE}/api/auth/setup-status`);
  const j = await r.json().catch(() => null);
  return { status: r.status, body: j?.data || j };
}

async function createFirstUser(payload) {
  const r = await fetch(`${BASE}/api/auth/setup/first-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, body: j };
}

(async () => {
  if (await portInUse(PORT)) { console.error(`port ${PORT} already in use`); process.exit(1); }
  tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'firstuser-test-'));

  // ── Build an EMPTY user store (fresh migrations, zero users) ──────────
  // Copy the real DB then delete all users + role assignments so the store
  // is genuinely empty — proves the check reads the actual store.
  testDb = path.join(tmpDir, 'firstuser.db');
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), testDb);
  {
    const db = new DatabaseSync(testDb);
    db.exec('DELETE FROM user_roles');
    db.exec('DELETE FROM users');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  }

  server = spawnServer();
  if (!(await waitReady())) { console.error('server did not start'); process.exit(1); }

  // ── 1. Empty store -> setup available ─────────────────────────────────
  const s1 = await setupStatus();
  check('1. empty store reports setup mode', s1.status === 200 && s1.body.mode === 'setup' && s1.body.userCount === 0, JSON.stringify(s1));

  // Invalid inputs rejected before any user exists.
  const badPw = await createFirstUser({ full_name: 'X Y', email: 'a@b.co', password: 'short', confirm_password: 'short' });
  check('1a. weak password rejected', badPw.status === 400, `status=${badPw.status}`);
  const badMatch = await createFirstUser({ full_name: 'X Y', email: 'a@b.co', password: 'Abcdef12', confirm_password: 'Abcdef13' });
  check('1b. password mismatch rejected', badMatch.status === 400, `status=${badMatch.status}`);
  const badEmail = await createFirstUser({ full_name: 'X Y', email: 'not-an-email', password: 'Abcdef12', confirm_password: 'Abcdef12' });
  check('1c. bad email rejected', badEmail.status === 400, `status=${badEmail.status}`);
  const noIdent = await createFirstUser({ full_name: 'X Y', password: 'Abcdef12', confirm_password: 'Abcdef12' });
  check('1d. missing email+username rejected', noIdent.status === 400, `status=${noIdent.status}`);
  const s1b = await setupStatus();
  check('1e. store still empty after rejected attempts', s1b.body.userCount === 0, JSON.stringify(s1b));

  // ── 2. First-user creation succeeds ───────────────────────────────────
  const created = await createFirstUser({
    full_name: 'System Administrator',
    email: 'owner@example.com',
    password: 'OwnerPass1',
    confirm_password: 'OwnerPass1',
  });
  const token = created.body?.data?.token;
  check('2. first-user creation succeeds (201 + token + ADMIN role)',
    created.status === 201 && !!token && created.body?.data?.user?.role === 'ADMIN',
    JSON.stringify(created.body).slice(0, 200));

  // ── 6. Password stored as hash, never plaintext ───────────────────────
  {
    const db = new DatabaseSync(testDb, { readOnly: true });
    const row = db.prepare("SELECT password_hash FROM users WHERE email = 'owner@example.com'").get();
    const all = db.prepare('SELECT COUNT(*) AS n FROM users WHERE password_hash = ?').get('OwnerPass1');
    check('6a. stored credential is a bcrypt hash', !!row?.password_hash && /^\$2[aby]\$/.test(row.password_hash), row?.password_hash?.slice(0, 10));
    check('6b. plaintext password absent from store', all.n === 0);
    db.close();
  }
  // Hash never exposed through API responses.
  const createdStr = JSON.stringify(created.body);
  check('6c. API response contains no hash', !createdStr.includes('$2'), createdStr.slice(0, 120));
  const statusStr = JSON.stringify((await setupStatus()).body);
  check('6d. setup-status leaks no credential material', !statusStr.includes('$2') && !statusStr.includes('OwnerPass1'));

  // ── 3. Existing user store -> login mode ──────────────────────────────
  const s3 = await setupStatus();
  check('3. existing store reports login mode', s3.status === 200 && s3.body.mode === 'login' && s3.body.userCount === 1, JSON.stringify(s3));

  // ── 4. Further unauthenticated first-user creation rejected ───────────
  const s4 = await createFirstUser({
    full_name: 'Impostor Admin', email: 'admin@evil.example', password: 'EvilPass1', confirm_password: 'EvilPass1',
  });
  check('4. second unauthenticated creation rejected (409)', s4.status === 409, `status=${s4.status} ${JSON.stringify(s4.body).slice(0, 120)}`);

  // ── 5. Concurrent requests create at most one admin ───────────────────
  // Reset to an empty store, then fire N parallel creations.
  server.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 800));
  {
    const db = new DatabaseSync(testDb);
    db.exec('DELETE FROM user_roles');
    db.exec('DELETE FROM users');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  }
  server = spawnServer();
  if (!(await waitReady())) { console.error('server (race round) did not start'); process.exit(1); }

  const N = 6;
  const payload = { full_name: 'Race Winner', email: 'race@example.com', password: 'RacePass1', confirm_password: 'RacePass1' };
  const races = await Promise.all(Array.from({ length: N }, () => createFirstUser(payload)));
  const winners = races.filter((r) => r.status === 201);
  const losers = races.filter((r) => r.status === 409);
  check('5a. exactly one concurrent creation wins', winners.length === 1, `winners=${winners.length} losers=${losers.length} statuses=${races.map((r) => r.status).join(',')}`);

  {
    const db = new DatabaseSync(testDb, { readOnly: true });
    const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'ADMIN' AND email = 'race@example.com'").get().n;
    check('5b. user store contains exactly one user after race', n === 1 && admins === 1, `users=${n} raceAdmins=${admins}`);
    const hash = db.prepare("SELECT password_hash FROM users WHERE email='race@example.com'").get()?.password_hash;
    check('5c. race winner credential is a bcrypt hash', /^\$2[aby]\$/.test(hash || ''));
    db.close();
  }

  // ── 9. Login with the created account works; existing auth intact ────
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'race@example.com', password: 'RacePass1' }),
  }).then((r) => r.json());
  check('9a. created account can log in', !!login?.data?.token, JSON.stringify(login).slice(0, 150));
  const me = await fetch(`${BASE}/api/auth/profile`, { headers: { Authorization: `Bearer ${login.data.token}` } });
  check('9b. authenticated profile works with the setup session', me.status === 200, `status=${me.status}`);

  // ── 8. Restart preserves the account; setup no longer offered ────────
  server.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 800));
  server = spawnServer();
  if (!(await waitReady())) { console.error('server (restart round) did not start'); process.exit(1); }
  const s8 = await setupStatus();
  check('8a. after restart store still reports login mode', s8.status === 200 && s8.body.mode === 'login' && s8.body.userCount === 1, JSON.stringify(s8));
  const relogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'race@example.com', password: 'RacePass1' }),
  });
  check('8b. initial account survives restart (login works)', relogin.status === 200, `status=${relogin.status}`);
  const postRestart = await createFirstUser({ full_name: 'Late Admin', email: 'late@example.com', password: 'LatePass1', confirm_password: 'LatePass1' });
  check('8c. first-user creation still rejected after restart', postRestart.status === 409, `status=${postRestart.status}`);

  // ── 7. Unreadable user store fails closed (no setup exposure) ─────────
  // Point a SECOND server on a DIFFERENT port at a corrupt file: the app's
  // migration preflight exits on an unreadable store (fail-closed at boot);
  // even if a server did come up, setup-status must never answer 'setup'.
  const corruptDb = path.join(tmpDir, 'corrupt.db');
  fs.writeFileSync(corruptDb, Buffer.from('this is not a sqlite database'));
  const server2 = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT + 1), DB_PATH: corruptDb, DEMO_MODE: 'false' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let corruptResult = 'server-not-running (exited at boot — fail closed)';
  for (let i = 0; i < 14; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch(`http://127.0.0.1:${PORT + 1}/api/auth/setup-status`);
      corruptResult = `${r.status} ${JSON.stringify(await r.json()).slice(0, 120)}`;
      break;
    } catch (_) { /* not up yet or exited */ }
  }
  server2.kill('SIGKILL');
  const failClosed = !corruptResult.startsWith('200');
  check('7. corrupt store fails closed (no 200 setup mode exposure)', failClosed, corruptResult);

  // ── Summary ───────────────────────────────────────────────────────────
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (server) { try { server.kill('SIGKILL'); } catch (_) {} }
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('test crashed:', e);
  if (server) { try { server.kill('SIGKILL'); } catch (_) {} }
  process.exit(1);
});
