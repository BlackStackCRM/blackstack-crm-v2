#!/usr/bin/env node
/**
 * PHASE D STEP 3 — Failure Recovery & Production Release Verification.
 *
 * Covers the Step 2 recovery gaps:
 *   A. corrupted update artifact (truncated / tampered / bad sha512)
 *   B. installer failure (controlled)
 *   C. migration failure mid-transaction
 *   D. backup restore after failed migration
 *   E. interrupted update (download killed mid-flight)
 *   F. process-interruption model at 4 points
 *
 * Every destructive step runs against an isolated copy. Production is moved
 * aside by the same fail-closed isolation module Step 2 uses, and both the
 * content fingerprint and the file checksum are compared at the end.
 *
 * Run:  node scripts/phase-d-step-3-recovery.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { DatabaseSync } = require('node:sqlite');

const isolation = require('./phase-d-isolation');
const DECOY_PATH = isolation.DECOY_PATH;

const V1_DIR = path.join(ROOT, 'dist-phase-d', 'v1', 'win-unpacked');
const V2_DIR = path.join(ROOT, 'dist-phase-d', 'v2', 'win-unpacked');
const PROD_DB = path.join(ROOT, 'data', 'blackstack-crm.db');
// The builds pin their feed via resources/app-update.yml to 34811.
const FEED_PORT = 34811;
const THROTTLE = process.env.PHASE_D_THROTTLE_MS || '30';

const BASE = path.join(process.env.LOCALAPPDATA, 'Temp', 'phase-d-step3');

let passCount = 0, failCount = 0, skipCount = 0;
const failures = [];
const skips = [];

const D = (s) => console.log(`\n[d] ${s}`);
function pass(n, d = '') { passCount++; console.log(`  PASS  ${n}${d ? ' — ' + d : ''}`); }
function bad(n, d = '') { failCount++; failures.push(`${n}: ${d}`); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); }
function assert(c, n, d = '') { c ? pass(n, d) : bad(n, d); return c; }
function skip(n, why) { skipCount++; skips.push(`${n}: ${why}`); console.log(`  SKIP  ${n} — ${why}`); }
function section(t) { console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (f) => { try { return crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };
const sha512 = (f) => { try { return crypto.createHash('sha512').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };

function killBlackStack() {
  try {
    execSync('powershell -NoProfile -Command "Get-Process | Where-Object { $_.ProcessName -like \'*BlackStack*\' } | ForEach-Object { try { $_.Kill() } catch {} }"', { stdio: 'pipe', timeout: 30000 });
  } catch { /* noop */ }
}
function countBlackStack() {
  try {
    const out = execSync('tasklist', { encoding: 'utf8' });
    return (out.match(/BlackStack/g) || []).length;
  } catch { return 0; }
}
function countInstallers() {
  try {
    const out = execSync('tasklist', { encoding: 'utf8' });
    return (out.match(/BlackStack CRM Setup/g) || []).length;
  } catch { return 0; }
}

// ── content fingerprint: same algorithm as scripts/release-gate.js ───────────
// Must stay identical to the set in scripts/phase-d-inspect-db.js, otherwise a
// fingerprint taken by one is not comparable with the other.
const VOLATILE_TABLES = new Set([
  'audit_logs', 'audit_log', 'logs', 'log',
]);

function contentFingerprint(file) {
  if (!fs.existsSync(file)) return 'MISSING';
  let db;
  const tmp = path.join(os.tmpdir(), `pd3-fp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
  try {
    for (const ext of ['', '-wal', '-shm']) {
      if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, tmp + ext);
    }
    db = new DatabaseSync(tmp);
  } catch (e) { return `UNREADABLE:${e.message.slice(0, 60)}`; }
  const h = crypto.createHash('md5');
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => t.name);
    // Append-only audit/log tables change whenever the app does anything —
    // including recording a failed update check, which is exactly the recovery
    // evidence these tests look for. Excluding them keeps the fingerprint a
    // measure of BUSINESS data. They are asserted separately.
    for (const t of tables.filter((x) => !VOLATILE_TABLES.has(x.toLowerCase()))) {
      h.update(`\n## ${t}\n`);
      h.update(db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value ?? ''}`).join(','));
      for (const r of db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()) h.update(JSON.stringify(r));
    }
  } catch (e) { return `ERROR:${e.message.slice(0, 60)}`; }
  finally { try { db.close(); } catch {} for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch {} } }
  return h.digest('hex');
}

function httpJson(url, { method = 'GET', body = null, token = null, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, timeout,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { let p = null; try { p = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: p, raw }); });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) req.write(data);
    req.end();
  });
}

async function waitForPort(port, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await httpJson(`http://127.0.0.1:${port}/health`, { timeout: 2000 });
    if (r.status === 200) return true;
    await sleep(1000);
  }
  return false;
}

function serverPortFromLog(logFile) {
  // The app log contains BOTH the CDP debugger port and the HTTP server port.
  // Matching the first 127.0.0.1:<port> silently targets the debugger (404s).
  try {
    const m = fs.readFileSync(logFile, 'utf8').match(/Window loaded: http:\/\/127\.0\.0\.1:(\d+)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

function httpGetText(url, timeout = 15000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, timeout }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.end();
  });
}

async function login(port) {
  const r = await httpJson(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    body: { email: 'phase-d-admin@blackstack.local', password: 'PhaseD-Admin-2026' },
  });
  return r.body?.data?.token || null;
}

// After the renderer signs in, the session lives in localStorage under
// crm_user / crm_token. Reuse that token so HTTP assertions speak as the same
// user the UI is acting as.
async function tokenFromRenderer(app) {
  const t = await cdpEval(app.cdp, `(() => localStorage.getItem('crm_token'))()`);
  return t || null;
}

// ── app control over the real IPC surface, driven through CDP ────────────────
let activeCdpPort = 0;

async function cdpEval(port, expression, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/json', method: 'GET', timeout: 5000 }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let targets = [];
        try { targets = JSON.parse(raw).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl); } catch { /* noop */ }
        // There is exactly ONE page target. Before sign-in its URL is
        // login.html; the SAME target then navigates to "/" (the SPA). Prefer the
        // app page when present, else fall back to the single page target.
        const local = targets.filter((t) => /127\.0\.0\.1/.test(t.url));
        const appPages = local.filter((t) => !/login\.html/.test(t.url));
        const page = appPages[0] || local[0] || targets[0];
        if (!page) return resolve(undefined);
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        let settled = false;
        const finish = (v) => {
          if (settled) return;
          settled = true;
          try { ws.close(); } catch { /* noop */ }
          resolve(v);
        };
        const timer = setTimeout(() => finish(undefined), timeoutMs);
        ws.onopen = () => {
          ws.send(JSON.stringify({
            id: 1, method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true },
          }));
        };
        ws.onmessage = (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.id === 1) {
            clearTimeout(timer);
            if (m.result?.exceptionDetails) return finish(undefined);
            finish(m.result?.result?.value);
          }
        };
        ws.onerror = () => { clearTimeout(timer); finish(undefined); };
      });
    });
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => { req.destroy(); resolve(undefined); });
    req.end();
  });
}

// ── feed ─────────────────────────────────────────────────────────────────────
function startFeed(feedDir, port, extraEnv = {}) {
  const env = { ...process.env, PHASE_D_THROTTLE_MS: THROTTLE, ...extraEnv };
  const p = spawn(process.execPath, [path.join(__dirname, 'phase-d-staging-feed.js'), feedDir, String(port)],
    { env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  return p;
}
async function waitForFeed(port, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await httpGetText(`http://127.0.0.1:${port}/latest.yml`, 3000);
    if (r.status === 200) return true;
    await sleep(500);
  }
  return false;
}

function killTree(pid) {
  try { spawnSync('taskkill', ['/F', '/PID', String(pid), '/T'], { stdio: 'pipe' }); } catch { /* noop */ }
}

// ── isolated client app ─────────────────────────────────────────────────────
let cdpSeq = 33100;

async function launchClient(args) {
  // A just-terminated app can still hold the server port for a moment. Try
  // once, and if the server never binds, make sure everything is gone and
  // retry — a failed launch is a harness artefact, not a product result.
  let last = await launchClientOnce(args);
  if (last.port) return last;
  killBlackStack();
  await sleep(4000);
  last = await launchClientOnce(args);
  return last;
}

async function launchClientOnce({ userData, exeDir, logName, label }) {
  const dbDir = path.join(userData, 'database');
  fs.mkdirSync(dbDir, { recursive: true });
  const localApp = path.join(userData, 'localappdata');
  fs.mkdirSync(localApp, { recursive: true });
  const logFile = path.join(userData, logName || `${label || 'app'}.log`);
  const port = ++cdpSeq;
  activeCdpPort = port;

  const env = {
    ...process.env,
    DEMO_MODE: 'true',
    BLACKSTACK_USER_DATA_DIR: userData,
    // Never let the client adopt the repo's portable (production) database.
    PORTABLE_DB_PATH: DECOY_PATH,
    BOOTSTRAP_ADMIN_EMAIL: 'phase-d-admin@blackstack.local',
    BOOTSTRAP_ADMIN_PASSWORD: 'PhaseD-Admin-2026',
    LOCALAPPDATA: localApp,
  };
  const proc = spawn(path.join(exeDir, 'BlackStack CRM.exe'), [`--remote-debugging-port=${port}`], {
    env, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
  });
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  proc.stdout.pipe(log); proc.stderr.pipe(log);

  // Wait for the server line in the log, then for the port.
  const end = Date.now() + 90000;
  let sp = null;
  while (Date.now() < end && !sp) {
    sp = serverPortFromLog(logFile);
    if (sp) break;
    await sleep(700);
  }
  if (!sp) return { proc, port: null, cdp: port, logFile };
  const ok = await waitForPort(sp, 90000);
  return { proc, port: ok ? sp : null, cdp: port, logFile };
}

async function uiSignIn(app) {
  // public/js/pages/login.js:21 binds the handler to the FORM's submit event and
  // line 23 calls checkValidity(). Setting .value through the prototype setter
  // satisfies the model but the fields still need to pass native validation, and
  // a synthetic 'submit' event does not run the browser's constraint check the
  // same way. Click the real submit button instead: it is type="submit" inside
  // the form, so the browser dispatches a genuine submit with validation.
  const r = await cdpEval(app.cdp, `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const email = document.querySelector('#login-email') || document.querySelector('input[name=email]');
    const pass = document.querySelector('#login-password') || document.querySelector('input[type=password]');
    const form = document.querySelector('#login-form') || document.querySelector('form');
    const btn = document.querySelector('#login-submit');
    if (!email || !pass || !form) {
      return { ok: !/login\.html/.test(location.pathname), reason: 'no login form', href: location.href };
    }
    const setV = (el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setV(email, 'phase-d-admin@blackstack.local');
    setV(pass, 'PhaseD-Admin-2026');
    // Click the real submit button so the browser performs native validation
    // and dispatches a trusted submit event.
    if (btn) btn.click();
    else form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 60 && /login\.html/.test(location.pathname); i++) {
      await sleep(500);
      const err = document.querySelector('#login-error');
      if (err && !err.classList.contains('hidden') && /invalid|incorrect|fail/i.test(err.textContent || '')) {
        return { ok: false, reason: err.textContent.trim().slice(0, 90) };
      }
    }
    return { ok: !/login\.html/.test(location.pathname), reason: location.pathname };
  })()`);
  return r;
}

async function updaterState(app) {
  const r = await cdpEval(app.cdp, `(async () => {
    const s = await window.desktop.getUpdateState();
    return s && s.state ? s.state : s;
  })()`);
  return r || {};
}

async function uiCall(app, method, arg) {
  return cdpEval(app.cdp, `(async () => {
    const r = await window.desktop.${method}(${arg ? JSON.stringify(arg) : ''});
    return r === undefined ? null : r;
  })()`);
}

async function waitState(app, want, timeoutMs = 180000) {
  const want_ = Array.isArray(want) ? want : [want];
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await updaterState(app);
    if (last && want_.includes(last.status)) return last;
    await sleep(1500);
  }
  return null;
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* noop */ } }

module.exports = {
  ROOT, V1_DIR, V2_DIR, PROD_DB, BASE, FEED_PORT,
  pass, bad, assert, skip, section, D, sleep, md5, sha512,
  killBlackStack, countBlackStack, countInstallers, isolation,
  contentFingerprint, httpJson, httpGetText, waitForPort, serverPortFromLog,
  login, tokenFromRenderer, cdpEval, activeCdpPort, startFeed, waitForFeed, killTree,
  launchClient, uiSignIn, updaterState, uiCall, waitState, rmrf,
  get passCount() { return passCount; },
  get failCount() { return failCount; },
  get skipCount() { return skipCount; },
  get failures() { return failures; },
  get skips() { return skips; },
};
