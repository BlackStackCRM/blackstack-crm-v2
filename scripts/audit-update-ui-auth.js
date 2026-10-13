/**
 * AUDIT-ONLY, READ-ONLY. Proves whether the Settings → Updates / Data Safety UI
 * can actually talk to the /api/datasafety routes it calls.
 *
 * Context: during the production-readiness phase, every /api/datasafety route was
 * given `requireDataSafety = [authMiddleware, requirePermission('settings.manage')]`.
 * public/js/pages/settings.js calls those endpoints with a BARE fetch() and no
 * Authorization header. This script measures the actual status codes the UI's own
 * request pattern produces, so the finding rests on evidence rather than reading.
 *
 * Nothing is written: only GET requests are issued, against a disposable copy of
 * the database, and the live database is never opened for writing.
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.AUDIT_PORT || 3151);
const BASE = `http://127.0.0.1:${PORT}`;

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1200);
  });
}

(async () => {
  if (await portInUse(PORT)) { console.error(`port ${PORT} busy`); process.exit(2); }

  const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'bscrm-audit-'));
  const testDb = path.join(tmpDir, 'audit.db');
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), testDb);

  const logFd = fs.openSync(path.join(tmpDir, 'server.log'), 'w');
  const server = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: testDb,
      BLACKSTACK_USER_DATA_DIR: path.join(tmpDir, 'ud').replace(/\\/g, '/'),
      NODE_ENV: '',
    },
    stdio: ['ignore', logFd, logFd],
  });
  const stop = () => { try { server.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', stop);

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) {}
  }

  // Log in exactly as the desktop app does, to obtain a real token.
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@blackstack.local', password: 'admin123' }),
  });
  const token = (await login.json())?.data?.token || null;
  console.log(`admin login: HTTP ${login.status}, token ${token ? 'obtained' : 'MISSING'}\n`);

  // The exact endpoints settings.js calls, with the exact headers it sends.
  const CALLS = [
    ['GET', '/api/datasafety/update-channel',       'Settings: load current channel'],
    ['GET', '/api/datasafety/backups/status',        'Settings: backup status'],
    ['GET', '/api/datasafety/backups',               'Settings: list backups'],
    ['GET', '/api/datasafety/storage',               'Settings: storage dashboard'],
    ['GET', '/api/datasafety/update-compatibility',   'Settings: compatibility probe'],
  ];

  console.log('Replaying settings.js request patterns\n');
  console.log('endpoint                                   UI-style(no auth)  API-style(auth)  verdict');
  console.log('----------------------------------------  ----------------  ---------------  ---------------');

  let broken = 0;
  for (const [method, p, label] of CALLS) {
    // Exactly what settings.js sends: no Authorization header.
    const uiStyle = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
    });
    // What the shared API wrapper would send (token attached).
    const apiStyle = await fetch(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });

    const ok = apiStyle.ok;
    if (!ok) broken++;
    const verdict = uiStyle.status === 401
      ? (ok ? 'UI BROKEN / API OK' : 'BOTH BLOCKED')
      : (ok ? 'both ok' : 'check');
    console.log(
      `${p.padEnd(40)}  ${String(uiStyle.status).padEnd(16)}  ${String(apiStyle.status).padEnd(15)}  ${verdict}`,
    );
    if (uiStyle.status === 401 && ok) broken++;
  }

  console.log(`\nEndpoints the UI cannot reach without a token: ${broken}`);

  // ── Diagnose the authenticated 500 on /update-channel ────────────────────
  console.log('\n--- diagnosing /api/datasafety/update-channel (authenticated 500) ---');
  const tok = token;
  {
    const src = path.join(ROOT, 'server', 'services', 'updateService.js');
    const svcSrc = require('fs').readFileSync(src, 'utf8');
    const isStub = /Nothing here performs any real update/.test(svcSrc);
    const stateCount = (svcSrc.match(/^\s{2}[A-Z_]+: '/gm) || []).length;
    console.log(`  UpdateService self-documents as a stub: ${isStub}`);
    console.log(`  UPDATE_STATUS states declared: ${stateCount}`);
  }
  {
    const log = fs.readFileSync(path.join(tmpDir, 'server.log'), 'utf8');
    const errLines = log.split('\n')
      .filter((l) => /"level":"error"|update-channel|TypeError|ReferenceError/.test(l))
      .slice(-4);
    if (errLines.length) {
      console.log('  server log (structured error entries):');
      for (const l of errLines) {
        try {
          const j = JSON.parse(l);
          console.log(`    path=${j.path} status=${j.status} error=${j.error}`);
        } catch (_) { console.log('    ' + l.slice(0, 200)); }
      }
    } else {
      console.log('  (no matching error line in the server log)');
    }
  }

  // Does the shared API wrapper attach the token automatically?
  const apiSrc = path.join(ROOT, 'public', 'js', 'api', 'client.js');
  const alt = ['public/js/api.js', 'public/js/api/index.js'];
  console.log('\n--- shared API wrapper behaviour ---');
  let found = null;
  for (const cand of [apiSrc, ...alt.map((a) => path.join(ROOT, a))]) {
    if (fs.existsSync(cand)) { found = cand; break; }
  }
  if (found) {
    const src = io0(found);
    const attaches = /Authorization/i.test(src);
    console.log(`  wrapper: ${path.relative(ROOT, found)}`);
    console.log(`  attaches Authorization header: ${attaches}`);
  } else {
    console.log('  (wrapper file not located)');
  }

  stop();
  await new Promise((r) => setTimeout(r, 700));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

function io0(p) {
  return require('fs').readFileSync(p, 'utf8');
}