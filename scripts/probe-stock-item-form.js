/**
 * Dump the REAL DOM of the Stock Item form.
 *
 * Test 11 reports "#inv-master-form appeared, but it contains zero <select>
 * elements" while public/js/pages/inventory-sub.js appears to define uom_id /
 * group_id / brand_id selects. Reading the source has produced two contradictory
 * answers, so read the rendered DOM instead — one page load, no guessing.
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

  const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'bscrm-si-'));
  const testDb = path.join(tmpDir, 'si.db');
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
  p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

  await p.goto('http://localhost:${PORT}/login.html', { waitUntil: 'load' });
  await p.waitForSelector('#login-email', { timeout: 20000 });
  await p.fill('#login-email', 'admin@blackstack.local');
  await p.fill('#login-password', 'admin123');
  await p.click('#login-submit');
  await p.waitForURL(/index\\.html/, { timeout: 25000 }).catch(() => {});

  // Go straight to the stock items sub-route.
  await p.goto('http://localhost:${PORT}/index.html#inventory/stock_items', { waitUntil: 'load' });
  await p.waitForTimeout(4000);

  const before = await p.evaluate(() => ({
    hash: location.hash,
    newBtn: !!document.querySelector('#inv-master-new'),
    forms: [...document.querySelectorAll('form')].map((f) => f.id || '(no id)'),
  }));
  console.log('BEFORE CLICK: ' + JSON.stringify(before, null, 2));

  if (before.newBtn) {
    await p.click('#inv-master-new');
    await p.waitForTimeout(6000);
  }

  const after = await p.evaluate(() => {
    const f = document.querySelector('#inv-master-form');
    return {
      formFound: !!f,
      allForms: [...document.querySelectorAll('form')].map((x) => x.id || '(no id)'),
      // Every control in the document, with the attribute form actually used.
      controls: [...document.querySelectorAll('input,select,textarea')]
        .map((e) => ({ tag: e.tagName, name: e.getAttribute('name'), id: e.id || null })),
      selectsInForm: f ? [...f.querySelectorAll('select')].map((s) => ({
        nameAttr: s.getAttribute('name'), nameProp: s.name, options: s.options.length,
      })) : null,
      submitButtons: f ? [...f.querySelectorAll('button[type=submit], button:not([type])')]
        .map((b) => ({ id: b.id || null, text: b.textContent.trim().slice(0, 30), type: b.getAttribute('type') })) : null,
      formHtmlHead: f ? f.innerHTML.slice(0, 1200) : null,
    };
  });
  console.log('AFTER CLICK: ' + JSON.stringify(after, null, 2));
  console.log('PAGE ERRORS: ' + JSON.stringify(errs, null, 2));
  await b.close();
})();
`);

  const run = spawnSync(process.execPath, [probe], { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
  process.stdout.write(`${run.stdout || ''}${run.stderr || ''}`);

  stop();
  await new Promise((r) => setTimeout(r, 700));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });