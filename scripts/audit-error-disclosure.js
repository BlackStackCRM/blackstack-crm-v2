/**
 * PHASE 11 probe — is a stack trace returned to the client?
 *
 * server/app.js gates the stack on `NODE_ENV === 'development'`. An earlier
 * probe appeared to show one with NODE_ENV unset, so settle it by triggering a
 * real 500-class error under two NODE_ENV values and comparing the responses.
 *
 * Disposable database. Read-only apart from a deliberate bad login.
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1200);
  });
}

async function trial(port, nodeEnv) {
  const base = `http://127.0.0.1:${port}`;
  const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', `errenv-${nodeEnv || 'unset'}-`));
  const db = path.join(tmpDir, 'e.db');
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), db);

  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: db,
    BLACKSTACK_USER_DATA_DIR: path.join(tmpDir, 'ud').replace(/\\/g, '/'),
  };
  // server/app.js line 1 runs dotenv, which reads a .env from the process
  // working directory. This repo's root .env sets NODE_ENV=development, so a
  // probe launched from the repo root inherits it unless it is overridden.
  // The "unset" trial below therefore sets NODE_ENV='' to model a packaged
  // build, where the electron-builder files allowlist ships no .env.
  env.NODE_ENV = nodeEnv === null ? '' : nodeEnv;

  const fd = fs.openSync(path.join(tmpDir, 's.log'), 'w');
  const srv = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT, env, stdio: ['ignore', fd, fd],
  });
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch (_) {} });

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(`${base}/health`)).ok) break; } catch (_) {}
  }

  // A failed login is the cleanest reproducible error path.
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@nowhere.invalid', password: 'wrong' }),
  });
  const body = await r.text();

  srv.kill('SIGKILL');
  await new Promise((r2) => setTimeout(r2, 600));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  let parsed = null;
  try { parsed = JSON.parse(body); } catch (_) {}
  const hasStack = /"stack"\s*:/.test(body);
  const errObj = parsed?.error || {};
  return {
    status: r.status,
    hasStack,
    message: errObj.message,
    codes: Object.keys(errObj),
    leakedPaths: (body.match(/[A-Z]:\\\\[^\"]{0,60}/g) || []).slice(0, 3),
  };
}

(async () => {
  for (const [label, port, nodeEnv] of [
    ['NODE_ENV unset ', 3121, null],
    ['NODE_ENV=production', 3122, 'production'],
    ['NODE_ENV=development', 3123, 'development'],
  ]) {
    if (await portInUse(port)) { console.log(`${label}: port busy, skipped`); continue; }
    const t = await trial(port, nodeEnv);
    console.log(`${label} -> HTTP ${t.status}  stackExposed=${t.hasStack ? 'YES <<<' : 'no'}`);
    console.log(`    message : ${t.message}`);
    console.log(`    keys    : ${t.codes.join(', ')}`);
    if (t.leakedPaths.length) console.log(`    paths   : ${t.leakedPaths.join(' | ')}`);
  }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });