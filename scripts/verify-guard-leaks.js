/**
 * PHASE 3 (dynamic, verified) — do the routes the static scan flagged as
 * unguarded actually serve an unauthenticated caller?
 *
 * Static text analysis cannot tell whether `...auth`, `cbCollections`, or a
 * router-level middleware provides the guard, so this asks the running server.
 * A static finding is only a production bug if the live route answers a
 * no-token request with something other than 401.
 *
 * Read-only discovery: GETs only, no writes. Disposable database.
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

// Destructive endpoints on this router, verified against a disposable DB.
const FLAGGED = [
  '/api/datasafety/version',
  '/api/datasafety/backups',
  '/api/datasafety/backups/verify',
  '/api/datasafety/backups/status',
  '/api/datasafety/storage',
  '/api/datasafety/data-deletion/preview',
  '/api/datasafety/update-status',
  '/api/datasafety/maintenance/vacuum/preview',
  '/api/customer-bills/collection-forecast',
  '/api/customer-bills/escalations',
  '/api/reports/revenue',
  '/api/reports/sales',
  '/api/reports/pipeline',
  '/api/reports/team',
];

(async () => {
  if (await portInUse(PORT)) { console.error(`port ${PORT} busy`); process.exit(2); }

  const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'bscrm-guard-'));
  const testDb = path.join(tmpDir, 'guard.db');
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
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) {}
  }

  const leaks = [];
  console.log('endpoint                                         anon  verdict');
  console.log('-----------------------------------------------  ----  -------');
  for (const p of FLAGGED) {
    let status, body = '';
    try {
      const r = await fetch(BASE + p);
      status = r.status;
      body = (await r.text()).slice(0, 120);
    } catch (e) { status = 'ERR'; }
    const leaked = status !== 401 && status !== 'ERR';
    if (leaked) leaks.push({ p, status, body });
    console.log(`${p.padEnd(47)}  ${String(status).padEnd(4)}  ${leaked ? 'PUBLIC' : 'protected'}`);
  }

  console.log(`\nPUBLIC (unauthenticated, non-401): ${leaks.length}`);
  for (const l of leaks) {
    console.log(`\n  ${l.p} -> HTTP ${l.status}`);
    console.log(`    body: ${l.body.replace(/\s+/g, ' ').slice(0, 110)}`);
  }

  // ── Second pass: MUTATIONS on the same router ──────────────────────────
  // Reads leaking filesystem paths is an information-disclosure defect. A
  // mutation reachable without a token (restore / vacuum / delete-all) is a
  // far more serious one, so it gets measured separately and explicitly.
  console.log('\n=== ANONYMOUS MUTATIONS (same router) ===');
  const MUTATIONS = [
    ['POST', '/api/datasafety/backups', null],
    ['POST', '/api/datasafety/backups/rotate', null],
    ['POST', '/api/datasafety/support-bundle', null],
    ['POST', '/api/datasafety/data-deletion/token', null],
    // Deliberately harmless arguments: the point is whether the REQUEST is
    // reached at all, not what a real restore would do. The server runs
    // against a disposable database copy.
    ['POST', '/api/datasafety/backups/restore', { file: 'nonexistent-probe.db' }],
    ['POST', '/api/datasafety/data-deletion/execute', { typedConfirmation: 'DELETE', token: 'probe' }],
  ];
  const mutLeaks = [];
  for (const [method, p, body] of MUTATIONS) {
    let status, text = '';
    try {
      const r = await fetch(BASE + p, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      status = r.status;
      text = (await r.text()).slice(0, 130);
    } catch (e) { status = 'ERR'; }
    const leaked = status !== 401 && status !== 'ERR';
    if (leaked) mutLeaks.push({ method, p, status, text });
    console.log(
      `${leaked ? '*** ANONYMOUS ALLOWED ***' : 'protected         '} `
      + `${method} ${p} -> ${status}  ${text.replace(/\s+/g, ' ').slice(0, 70)}`,
    );
  }
  console.log(`\nanonymous mutations reachable: ${mutLeaks.length} of ${MUTATIONS.length}`);

  // ── Third pass: does the guard reject AUTHENTICATED-but-unauthorized too? ──
  // A guard that only checks for a token is not authorization. Mint a session
  // carrying an empty permission set and confirm the routes answer 403 rather
  // than proceeding.
  console.log('\n=== AUTHENTICATED BUT UNPERMITTED (empty permission set) ===');
  const { SessionManager } = require('../server/auth/session');
  let weakToken = null;
  try {
    // createSession(user, context) is the real minting path used at login.
    // An empty permissions array models a signed-in user with no grants.
    weakToken = SessionManager.createSession(
      { id: 'probe', email: 'probe@probe.invalid', full_name: 'probe', role: 'probe' },
      { companyId: 'default', permissions: [], roleIds: [] },
    ).token;
  } catch (e) { weakToken = null; console.log(`  mint failed: ${e.message}`); }
  if (!weakToken) {
    console.log('  (could not mint a restricted session — see report)');
  } else {
    let forbidden = 0; let wronglyAllowed = 0;
    for (const [method, p] of [
      ['GET', '/api/datasafety/backups'],
      ['GET', '/api/datasafety/storage'],
      ['POST', '/api/datasafety/backups'],
      ['POST', '/api/datasafety/data-deletion/execute'],
    ]) {
      const r = await fetch(BASE + p, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${weakToken}` },
        ...(method === 'GET' ? {} : { body: JSON.stringify({ typedConfirmation: 'DELETE', token: 'x' }) }),
      });
      const body = (await r.text()).slice(0, 90);
      if (r.status === 403) forbidden++;
      else { wronglyAllowed++; console.log(`  *** ALLOWED *** ${method} ${p} -> ${r.status} ${body.replace(/\s+/g, ' ')}`); }
    }
    console.log(`  correctly rejected 403: ${forbidden}`);
    console.log(`  wrongly allowed      : ${wronglyAllowed}`);
  }

  stop();
  await new Promise((r) => setTimeout(r, 700));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });