/**
 * Report the inventory cards the dashboard ACTUALLY renders in the browser,
 * against an isolated database. Reading public/js/pages/inventory.js tells us
 * what is configured; this tells us what survives the permission/visibility
 * filter — which is what the E2E suite's card count must match.
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3000);

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1500);
  });
}

(async () => {
  if (await portInUse(PORT)) { console.error(`port ${PORT} busy`); process.exit(2); }

  const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'bscrm-cards-'));
  const testDb = path.join(tmpDir, 'cards.db');
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
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) break; } catch (_) {}
  }

  const probe = path.join(tmpDir, 'probe.js');
  fs.writeFileSync(probe, `
const { chromium } = require('${path.join(ROOT, 'node_modules', 'playwright').replace(/\\/g, '/')}');
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));

  // Same login contract the E2E suite uses (see loginViaUI in
  // tests/inventory.e2e.test.js) — guessing selectors here produced a false
  // "0 cards" reading because the page never authenticated.
  await p.goto('http://localhost:${PORT}/login.html', { waitUntil: 'load' });
  await p.waitForSelector('#login-email', { timeout: 20000 });
  await p.fill('#login-email', 'admin@blackstack.local');
  await p.fill('#login-password', 'admin123');
  await p.click('#login-submit');
  await p.waitForURL(/index\\.html/, { timeout: 25000 }).catch(() => {});

  const tok = await p.evaluate(() => localStorage.getItem('crm_token'));
  if (!tok) { console.log(JSON.stringify({ error: 'login failed', pageErrors: errs })); await b.close(); return; }

  await p.goto('http://localhost:${PORT}/index.html#inventory', { waitUntil: 'load' });
  await p.waitForTimeout(4000);
  const info = await p.evaluate(() => {
    const all = [...document.querySelectorAll('[data-inv-card]')];
    return {
      total: all.length,
      visible: all.filter((c) => c.style.display !== 'none' && c.offsetParent !== null).length,
      keys: all.map((c) => c.getAttribute('data-inv-card')),
      hidden: all.filter((c) => c.style.display === 'none' || c.offsetParent === null)
        .map((c) => c.getAttribute('data-inv-card')),
      sections: [...document.querySelectorAll('[data-inv-section]')].map((s) => ({
        id: s.getAttribute('data-inv-section'),
        display: s.style.display,
        cards: s.querySelectorAll('[data-inv-card]').length,
      })),
    };
  });
  console.log(JSON.stringify({ ...info, pageErrors: errs }, null, 2));
  await b.close();
})();
`);

  const run = spawnSync(process.execPath, [probe], {
    cwd: ROOT, encoding: 'utf8', timeout: 180000,
  });
  process.stdout.write(`${run.stdout || ''}${run.stderr || ''}`);

  stop();
  await new Promise((r) => setTimeout(r, 700));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });