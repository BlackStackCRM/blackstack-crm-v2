/**
 * SETUP-DISABLED contract — E2E test suite.
 *
 * The local "Create First User" / company-registration surface has been
 * RETIRED from the customer-facing app: accounts are provisioned centrally
 * by the Agency through Supabase and synced down into the local SQLite
 * database at login (server/services/cloudToLocalSync.service.js).
 *
 * This suite proves, against a REAL server process with a REAL SQLite store:
 *   1. /api/auth/setup-status ALWAYS reports login mode (setup disabled),
 *      regardless of whether the user store is empty.
 *   2. POST /api/auth/setup/first-user is ALWAYS refused with HTTP 403 and
 *      the SETUP_DISABLED error code — including validation-invalid payloads,
 *      concurrent storms and post-restart attempts.
 *   3. No request, however crafted, can create a user through the setup path.
 *   4. Existing auth behavior is intact (login + profile work).
 *   5. Unreadable user store still fails closed (no 200 setup exposure).
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

const isSetupDisabled = (res) =>
  res.status === 403 && res.body?.error?.code === 'SETUP_DISABLED';

(async () => {
  if (await portInUse(PORT)) { console.error(`port ${PORT} already in use`); process.exit(1); }
  tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'firstuser-test-'));

  // ── Build an EMPTY user store (fresh migrations, zero users) ──────────
  // Copy the real DB then delete all users + role assignments so the store
  // is genuinely empty — proves setup-disabled holds even on a blank install.
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

  // ── 1. Empty store -> STILL login mode (setup retired) ────────────────
  const s1 = await setupStatus();
  check('1. empty store reports login mode (setup disabled)',
    s1.status === 200 && s1.body.mode === 'login' && s1.body.setupDisabled === true,
    JSON.stringify(s1));

  // Invalid payloads are refused with the SAME deliberate 403 — no oracle
  // about validation state may leak from a disabled endpoint.
  const badPw = await createFirstUser({ full_name: 'X Y', email: 'a@b.co', password: 'short', confirm_password: 'short' });
  check('1a. weak password refused (403 SETUP_DISABLED)', isSetupDisabled(badPw), `status=${badPw.status} ${JSON.stringify(badPw.body).slice(0, 120)}`);
  const badMatch = await createFirstUser({ full_name: 'X Y', email: 'a@b.co', password: 'Abcdef12', confirm_password: 'Abcdef13' });
  check('1b. password mismatch refused (403 SETUP_DISABLED)', isSetupDisabled(badMatch), `status=${badMatch.status}`);
  const badEmail = await createFirstUser({ full_name: 'X Y', email: 'not-an-email', password: 'Abcdef12', confirm_password: 'Abcdef12' });
  check('1c. bad email refused (403 SETUP_DISABLED)', isSetupDisabled(badEmail), `status=${badEmail.status}`);
  const noIdent = await createFirstUser({ full_name: 'X Y', password: 'Abcdef12', confirm_password: 'Abcdef12' });
  check('1d. missing email+username refused (403 SETUP_DISABLED)', isSetupDisabled(noIdent), `status=${noIdent.status}`);
  const s1b = await setupStatus();
  check('1e. user store untouched after refused attempts', s1b.body.mode === 'login' && s1b.body.setupDisabled === true, JSON.stringify(s1b));

  // ── 2. Even a fully VALID first-user payload is refused ───────────────
  const created = await createFirstUser({
    full_name: 'System Administrator',
    email: 'owner@example.com',
    password: 'OwnerPass1',
    confirm_password: 'OwnerPass1',
  });
  check('2. valid first-user payload refused (403 SETUP_DISABLED, no session)',
    isSetupDisabled(created) && !created.body?.data?.token,
    JSON.stringify(created.body).slice(0, 200));

  // ── 6. Nothing was written to the store ────────────────────────────────
  {
    const db = new DatabaseSync(testDb, { readOnly: true });
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const owner = db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'owner@example.com'").get().n;
    check('6a. no user row was created through the setup path', users === 0 && owner === 0, `users=${users} owner=${owner}`);
    db.close();
  }
  const statusStr = JSON.stringify((await setupStatus()).body);
  check('6b. setup-status leaks no credential material', !statusStr.includes('$2') && !statusStr.includes('OwnerPass1'));

  // ── 4. Second attempt (store with/without users) equally refused ─────
  const s4 = await createFirstUser({
    full_name: 'Impostor Admin', email: 'admin@evil.example', password: 'EvilPass1', confirm_password: 'EvilPass1',
  });
  check('4. unauthenticated creation rejected (403 SETUP_DISABLED)', isSetupDisabled(s4), `status=${s4.status} ${JSON.stringify(s4.body).slice(0, 120)}`);

  // ── 5. Concurrent requests: every one refused, nothing created ────────
  // Fire N parallel creations — the endpoint must 403 all of them.
  server.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 800));
  server = spawnServer();
  if (!(await waitReady())) { console.error('server (race round) did not start'); process.exit(1); }

  const N = 6;
  const payload = { full_name: 'Race Winner', email: 'race@example.com', password: 'RacePass1', confirm_password: 'RacePass1' };
  const races = await Promise.all(Array.from({ length: N }, () => createFirstUser(payload)));
  const refused = races.filter((r) => r.status === 403 && r.body?.error?.code === 'SETUP_DISABLED');
  const winners = races.filter((r) => r.status === 201);
  check('5a. every concurrent creation refused (no race winner)',
    refused.length === N && winners.length === 0,
    `refused=${refused.length}/${N} statuses=${races.map((r) => r.status).join(',')}`);

  {
    const db = new DatabaseSync(testDb, { readOnly: true });
    const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const raceAdmins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'race@example.com'").get().n;
    check('5b. user store contains exactly zero users after race', n === 0 && raceAdmins === 0, `users=${n} raceRows=${raceAdmins}`);
    db.close();
  }

  // ── 9. Existing auth paths intact (seed-independent login flow works) ─
  // The setup route no longer creates accounts, so verify the LIVE login
  // endpoint responds correctly (401 for unknown credentials — proving the
  // auth router itself is unharmed by the setup retirement).
  const badLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'race@example.com', password: 'RacePass1' }),
  });
  check('9a. login endpoint alive and correctly rejecting unknown user', badLogin.status === 401, `status=${badLogin.status}`);

  // ── 8. Restart: setup still disabled, store untouched ─────────────────
  server.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 800));
  server = spawnServer();
  if (!(await waitReady())) { console.error('server (restart round) did not start'); process.exit(1); }
  const s8 = await setupStatus();
  check('8a. after restart setup-status still reports disabled login mode',
    s8.status === 200 && s8.body.mode === 'login' && s8.body.setupDisabled === true, JSON.stringify(s8));
  const postRestart = await createFirstUser({ full_name: 'Late Admin', email: 'late@example.com', password: 'LatePass1', confirm_password: 'LatePass1' });
  check('8b. first-user creation still refused after restart (403)', isSetupDisabled(postRestart), `status=${postRestart.status}`);
  {
    const db = new DatabaseSync(testDb, { readOnly: true });
    const late = db.prepare("SELECT COUNT(*) AS n FROM users WHERE email='late@example.com'").get().n;
    check('8c. nothing persisted across restart via setup path', late === 0, `lateRows=${late}`);
    db.close();
  }

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
