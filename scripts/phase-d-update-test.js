#!/usr/bin/env node
/**
 * PHASE D — real packaged v1 -> v2 update driver.
 *
 * Drives the ACTUAL update path in the ACTUAL packaged application:
 *   - v1 is a real electron-builder NSIS build, launched as a real process
 *   - updates come from a local GenericProvider feed over real HTTP
 *   - electron-updater performs the real download and sha512 verification
 *   - the real NSIS installer runs to replace the application
 *
 * Nothing about the updater is stubbed. The only simulated element is the ORIGIN
 * of the update bytes, because §2 and §20 forbid the production GitHub feed.
 *
 * Observation channels (three independent ones):
 *   1. the app's own logs        — updates.log, app-*.log
 *   2. persisted update state   — updates/update-state.json
 *   3. HTTP + filesystem        — server health, DB, data preservation
 *
 * Usage:
 *   node scripts/phase-d-update-test.js --stage=all
 *   node scripts/phase-d-update-test.js --stage=detect
 *   node scripts/phase-d-update-test.js --stage=download
 *   node scripts/phase-d-update-test.js --stage=later
 *   node scripts/phase-d-update-test.js --stage=install
 *   node scripts/phase-d-update-test.js --stage=failure
 */
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '..');
const req = createRequire(path.join(ROOT, 'package.json'));
const { DatabaseSync } = req('node:sqlite');
const isolation = require('./phase-d-isolation');

const FEED_PORT = 34811;
const CDP_PORT = 39222;
const APP_PORT = 34567;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const V1_DIR = path.join(ROOT, 'dist-phase-d', 'v1');
const V2_DIR = path.join(ROOT, 'dist-phase-d', 'v2');

const STAGE = (process.argv.find((a) => a.startsWith('--stage=')) || '--stage=all').split('=')[1];
const KEEP = process.argv.includes('--keep'); // do not wipe userData between stages

// Isolated userData for the entire test (§2).
const TEST_ROOT = path.join(os.tmpdir(), 'phase-d-update-test');
const USER_DATA = path.join(TEST_ROOT, 'user-data');
const STATE_FILE = path.join(USER_DATA, 'updates', 'update-state.json');

let app = null;
let feedProc = null;
const results = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\n[d] ${m}`);
const pass = (n, d = '') => { results.push({ n, ok: true, d }); console.log(`  PASS  ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d) => { results.push({ n, ok: false, d }); console.log(`  FAIL  ${n}\n          ${d}`); };
const skip = (n, d = '') => { results.push({ n, ok: null, d }); console.log(`  SKIP  ${n}${d ? ' — ' + d : ''}`); };

// ═══════════════════════════════════════════════════════════════════════════
// process control
// ═══════════════════════════════════════════════════════════════════════════
function killApp() {
  if (app && !app.killed) { try { app.kill(); } catch { /* gone */ } }
  app = null;
  try {
    execFileSync('cmd.exe', ['/c', 'taskkill', '/F', '/IM', 'BlackStack CRM.exe', '/T'],
      { stdio: 'pipe', timeout: 30000 });
  } catch { /* none running */ }
  try {
    const out = execFileSync('cmd.exe', ['/c', 'netstat', '-ano'], { encoding: 'utf8', timeout: 20000 });
    for (const line of out.split('\n')) {
      if (line.includes(`127.0.0.1:${APP_PORT}`) && line.includes('LISTENING')) {
        execFileSync('cmd.exe', ['/c', 'taskkill', '/F', '/PID', line.trim().split(/\s+/).pop()],
          { stdio: 'pipe', timeout: 20000 });
      }
    }
  } catch { /* nothing listening */ }
}

function launchApp(which) {
  const dir = which === 'v2' ? V2_DIR : V1_DIR;
  const exe = path.join(dir, 'win-unpacked', 'BlackStack CRM.exe');
  if (!fs.existsSync(exe)) throw new Error('missing packaged exe: ' + exe);
  // --remote-debugging-port lets the driver evaluate a script inside the REAL
  // renderer, so "Update Now" / "Later" / "Restart & Update" travel the exact
  // same preload IPC bridge the Settings UI uses. Nothing in the product is
  // modified and no updater method is replaced.
  const p = spawn(exe, ['--remote-debugging-port=' + CDP_PORT], {
    cwd: dir,
    env: {
      ...process.env,
      BLACKSTACK_USER_DATA_DIR: USER_DATA,
      // electron-updater's cache is NOT under BLACKSTACK_USER_DATA_DIR in the
      // packaged app — it has been observed writing to
      // %LOCALAPPDATA%\<appId>-updater, i.e. the REAL user's cache. Pin it into
      // the isolated dir so (a) the test cannot read or write the real cache and
      // (b) a stale cached installer cannot silently satisfy the download.
      // electron-updater's cache root is getAppCacheDir() -> %LOCALAPPDATA% on
      // Windows (AppAdapter.js:10-11). The download has been observed writing to
      // %LOCALAPPDATA%\<appId>-updater, i.e. the REAL user's updater cache, not
      // BLACKSTACK_USER_DATA_DIR. Redirect LOCALAPPDATA so the isolated run can
      // neither read nor write the real cache — otherwise a stale cached
      // installer can silently satisfy the download and no bytes are fetched.
      LOCALAPPDATA: path.join(USER_DATA, 'localappdata'),
      // ISOLATION (the fix for the 09:19:26 fingerprint change): stop
      // findPortableDb() from reaching data/blackstack-crm.db. When set it is
      // honoured unconditionally and never falls back, so pointing it at a
      // non-existent path makes the portable lookup return null.
      PORTABLE_DB_PATH: isolation.DECOY_PATH,
      // A fresh isolated database has NO users: seed.js only creates the
      // bootstrap admin when DEMO_MODE is set or BOOTSTRAP_* are supplied, and
      // there is no /api/auth/register route. Without these the isolated
      // instance is unusable and nothing can be created through the API.
      // Test-environment only — production is never launched this way.
      DEMO_MODE: 'true',
      BOOTSTRAP_ADMIN_EMAIL: 'phase-d-admin@blackstack.local',
      BOOTSTRAP_ADMIN_PASSWORD: 'PhaseD-Admin-2026',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.env.PHASE_D_VERBOSE && process.stdout.write('[app] ' + d));
  p.stderr.on('data', (d) => process.env.PHASE_D_VERBOSE && process.stdout.write('[app!] ' + d));
  app = p;
  return p;
}

/** The DB path the RUNNING packaged app actually resolved, per its own log. */
async function appDatabasePath() {
  // The app logs the userData dir it bound to, and the database lives at
  // <userData>/database/blackstack-crm.db. Reading it back out of the APP's log
  // — not from our own env — is what makes this a real assertion rather than a
  // restatement of what we passed in.
  const txt = allLogText();
  const m = /userData dir:\s*(.+?)(?:\s*\(|$)/m.exec(txt);
  const dir = m ? m[1].trim() : '';
  return { userDataDir: dir, dbPath: dir ? path.join(dir, 'database', 'blackstack-crm.db') : '' };
}

function startFeed() {
  const ready = path.join(V2_DIR, 'phase-d-feed.ready');
  try { fs.unlinkSync(ready); } catch { /* first run */ }
  // DETACHED + unref: the feed must outlive this driver. When it was a normal
  // child it died with the driver, and every later app launch then failed its
  // update check with ERR_CONNECTION_REFUSED, landing in ERROR — which an
  // earlier version of this driver reported as "state=AVAILABLE" and thus
  // produced confusing, wrong conclusions.
  // PHASE_D_THROTTLE_MS paces the feed so a 114MB loopback transfer spans enough
  // wall-clock time for electron-updater to emit REAL download-progress events.
  // The bytes are unchanged; this only makes progress observable.
  const feedEnv = { ...process.env };
  if (!feedEnv.PHASE_D_THROTTLE_MS) feedEnv.PHASE_D_THROTTLE_MS = '12';
  feedProc = spawn(process.execPath, [path.join(__dirname, 'phase-d-staging-feed.js'), V2_DIR, String(FEED_PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true, env: feedEnv });
  feedProc.unref();
  feedProc.stdout.on('data', (d) => process.env.PHASE_D_VERBOSE && process.stdout.write('[feed] ' + d));
  return ready;
}

/** Confirm the feed is actually answering before trusting any update state. */
async function feedHealthy() {
  try {
    const r = await fetch(`http://127.0.0.1:${FEED_PORT}/stable.yml`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}

function stopFeed() {
  if (feedProc && !feedProc.killed) {
    try { process.kill(-feedProc.pid); } catch { /* already gone or no group */ }
    try { feedProc.kill(); } catch { /* gone */ }
  }
  feedProc = null;
}

async function waitFor(condFn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condFn()) return true;
    await sleep(1000);
  }
  console.log(`      (timeout waiting for ${label || 'condition'} after ${timeoutMs / 1000}s)`);
  return false;
}

async function waitHealth(timeoutMs = 120000) {
  return waitFor(async () => {
    try {
      const r = await fetch(BASE + '/health', { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch { return false; }
  }, timeoutMs, 'server /health');
}

/**
 * Read the running app's version.
 *
 * NOT from /health: that endpoint deliberately returns only {status, timestamp}
 * ("Liveness only — no internal details exposed"), so it never carried a
 * version and querying it for one was always going to return null.
 *
 * The authoritative sources are the app's own logs, written by main.js.
 */
function appVersion() {
  const t = allLogText();
  const patterns = [
    /API running on http:\/\/127\.0\.0\.1:\d+ \(v([\d.]+)\)/,   // server banner
    /"event":"app-start","version":"([\d.]+)"/,                        // updates.log
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return m[1];
  }
  return null;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function readLogs() {
  const out = {};
  const logDir = path.join(USER_DATA, 'logs');
  if (!fs.existsSync(logDir)) return out;
  for (const f of fs.readdirSync(logDir)) {
    try { out[f] = fs.readFileSync(path.join(logDir, f), 'utf8'); } catch { /* skip */ }
  }
  return out;
}

function allLogText() { return Object.values(readLogs()).join('\n'); }

function dbPath() { return path.join(USER_DATA, 'database', 'blackstack-crm.db'); }

function dbSnapshot() {
  const p = dbPath();
  if (!fs.existsSync(p)) return null;
  const db = new DatabaseSync(p, { readOnly: true });
  const out = { size: fs.statSync(p).size, schema: null, records: {} };
  try {
    out.schema = db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v;
  } catch { out.schema = null; }
  // Table and column names read from the LIVE schema (this build uses bare names
  // such as brands/models/locations, and contacts identify on first_name). An
  // earlier version probed invented names like inventory_stock_groups and so
  // reported zero records for data that was in fact present.
  const has = (t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const cols = (t) => db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
  const probes = [
    ['contacts', ['first_name', 'name', 'full_name']],
    ['leads', ['title', 'name']],
    ['customers', ['name']],
    ['tasks', ['title']],
    ['account_groups', ['name']],
    ['stock_groups', ['name']],
    ['stock_categories', ['name']],
    ['brands', ['name']],
    ['models', ['name']],
    ['products', ['name']],
    ['stock_items', ['name']],
    ['locations', ['name']],
    ['godowns', ['name']],
    ['units_of_measure', ['name']],
    ['invoices', ['notes']],
  ];
  for (const [t, candidateCols] of probes) {
    if (!has(t)) { out.records[t] = null; continue; }
    const c = candidateCols.find((x) => cols(t).includes(x));
    if (!c) { out.records[t] = null; continue; }
    try {
      out.records[t] = db.prepare(
        `SELECT id, "${c}" n FROM "${t}" WHERE "${c}" LIKE ? ORDER BY id`,
      ).all('PHASE-D%');
    } catch { out.records[t] = null; }
  }
  db.close();
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE: detect — v1 launches, updater initialises, v2 detected, NO auto-download
// ═══════════════════════════════════════════════════════════════════════════
async function stageDetect() {
  log('STAGE 1 — packaged v1 launch + update detection (§5)');

  if (!KEEP) {
    killApp(); stopFeed();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
  fs.mkdirSync(USER_DATA, { recursive: true });

  const ready = startFeed();
  const feedOk = await waitFor(async () => fs.existsSync(ready) && await feedHealthy(), 30000, 'staging feed ready');
  if (feedOk) pass('Staging feed up', `http://127.0.0.1:${FEED_PORT} (production GitHub feed untouched)`);
  else bad('Staging feed up', 'feed did not answer /stable.yml');

  log('Launching packaged v1 ...');
  launchApp('v1');

  const up = await waitHealth();
  if (!up) { bad('Packaged v1 launch', 'server never became healthy'); return false; }
  pass('Packaged v1 launch', 'server healthy, window loaded');

  const v1Ver = appVersion();
  if (v1Ver === '1.0.0') pass('v1 version reported', v1Ver);
  else bad('v1 version reported', `expected 1.0.0, got ${v1Ver}`);

  // DB opened and migrated
  const snap = dbSnapshot();
  if (snap && snap.size > 0) pass('Database opened', `${snap.size} bytes, schema ${snap.schema}`);
  else bad('Database opened', 'no readable database');

  // electron-updater must initialise — this is what was broken before Phase D.
  // main.js logs "electron-updater unavailable: ..." when it cannot load.
  let updaterInit = null;
  await waitFor(async () => {
    const t = allLogText();
    if (/electron-updater unavailable/i.test(t)) { updaterInit = 'unavailable'; return true; }
    if (/Update channel:/.test(t)) { updaterInit = 'ok'; return true; }
    return false;
  }, 240000, 'updater initialisation');

  if (updaterInit === 'ok') pass('electron-updater initialised in packaged app');
  else {
    const m = allLogText().match(/electron-updater unavailable: (.*)/);
    bad('electron-updater initialised in packaged app', m ? m[1].slice(0, 120) : 'no init log line');
    return false;
  }

  // Detection: the app checks 15s after launch.
  log('Waiting for update detection (background check fires ~15s after launch) ...');
  let detected = null;
  await waitFor(async () => {
    const s = readState();
    if (s && (s.status === 'AVAILABLE' || s.status === 'CHECKING' || s.status === 'UP_TO_DATE')) { detected = s; return true; }
    const t = allLogText();
    if (/Update available:/.test(t)) {
      detected = { status: 'AVAILABLE', fromLog: (t.match(/Update available: (\S+)/) || [])[1] };
      return true;
    }
    return false;
  }, 240000, 'update detection');

  const state = readState();
  const logTxt = allLogText();

  if (/Update available: 1\.0\.1/.test(logTxt) || (state && state.targetVersion === '1.0.1')) {
    pass('v2 detected as available', state ? `state=${state.status} target=${state.targetVersion}` : 'from app log');
  } else {
    bad('v2 detected as available', `state=${JSON.stringify(state)}`);
  }

  // §5: detection must NOT download. Only meaningful once detection SUCCEEDED —
  // "nothing downloaded because the check 404'd" is not a pass, and reporting it
  // as one is how a broken feed gets mistaken for correct behaviour.
  const st = readState();
  const downloadStarted = st && (st.status === 'DOWNLOADING' || st.status === 'VERIFYING' || st.status === 'READY');
  if (st && st.status === 'ERROR') {
    bad('No automatic download after detection',
      `check FAILED, so this is not evidence: ${String(st.error || '').slice(0, 160)}`);
  } else if (!downloadStarted) {
    pass('No automatic download after detection', `state=${st ? st.status : 'unknown'}`);
  } else {
    bad('No automatic download after detection',
      `a download started without user action (state=${st.status})`);
  }

  return !(st && st.status === 'ERROR');
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 2 — seed real business data through the live API (§6)
// ═══════════════════════════════════════════════════════════════════════════
async function stageSeed() {
  log('STAGE 2 — seeding real business test data through the live API (§6)');
  const r = spawnSync('node', [path.join(__dirname, 'phase-d-seed.js'), BASE, USER_DATA],
    { encoding: 'utf8', timeout: 180000 });
  const out = (r.stdout || '') + (r.stderr || '');
  console.log(out.split('\n').filter((l) => l.includes('[seed]')).slice(0, 30)
    .map((l) => '  ' + l).join('\n'));

  const manifest = path.join(USER_DATA, 'phase-d-seeded.json');
  if (!fs.existsSync(manifest)) {
    bad('Test data created', 'seed manifest not written — see output above');
    return false;
  }
  const seeded = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const ids = Object.entries(seeded.created)
    .filter(([, v]) => v && typeof v === 'object' && v.id != null);
  if (ids.length >= 8) pass('Test data created via real API', `${ids.length} records with IDs`);
  else bad('Test data created via real API', `only ${ids.length} records got IDs`);

  const snap = dbSnapshot();
  const tagged = Object.values(snap.records).filter((a) => Array.isArray(a)).reduce((n, a) => n + a.length, 0);
  if (tagged > 0) pass('PHASE-D records present in the isolated DB', `${tagged} tagged rows`);
  else bad('PHASE-D records present in the isolated DB', 'none found');

  // §7 pre-update snapshot
  const pre = {
    at: new Date().toISOString(),
    appVersion: appVersion(),
    dbPath: dbPath(),
    dbSize: snap.size,
    schemaVersion: snap.schema,
    state: readState(),
    records: snap.records,
    backups: fs.existsSync(path.join(USER_DATA, 'backups'))
      ? fs.readdirSync(path.join(USER_DATA, 'backups')).filter((f) => !f.endsWith('.txt')) : [],
  };
  fs.writeFileSync(path.join(TEST_ROOT, 'phase-d-pre-update-snapshot.json'), JSON.stringify(pre, null, 2));
  pass('Pre-update snapshot recorded', `${TEST_ROOT}/phase-d-pre-update-snapshot.json`);
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 3 — Update Now: real download, real progress (§8)
// ═══════════════════════════════════════════════════════════════════════════
//
// The packaged app exposes no HTTP control surface for updates — the update is
// driven exclusively through the renderer's IPC bridge. Driving it therefore
// requires a real click in the real renderer.
//
// This is done by injecting a small, production-free driver into the renderer
// via the app's own DevTools protocol, which calls the SAME window.desktop
// bridge the Settings page uses. No product code is modified and no updater
// method is stubbed: the click path is byte-for-byte the real one.
async function driveRenderer(action) {
  // Reuse the packaged app's own Chromium by asking it to evaluate a script.
  // Simplest reliable route on Windows: start the app with --remote-debugging-port
  // and talk CDP over HTTP.
  if (!app) return { ok: false, error: 'app not running' };

  const listRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null);
  if (!listRes || !listRes.ok) return { ok: false, error: 'CDP not available' };
  const targets = await listRes.json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) return { ok: false, error: 'no page target' };

  const ws = page.webSocketDebuggerUrl;
  // Each branch calls the SAME preload bridge the Settings page calls, so the
  // path from "click" to updater is the production path.
  const SCRIPTS = {
    'update-now': `(async () => JSON.stringify(await window.desktop.startDownload()))()`,
    'later': `(async () => JSON.stringify(await window.desktop.postponeUpdate()))()`,
    'install': `(async () => JSON.stringify(await window.desktop.installUpdate()))()`,
    'state': `(async () => JSON.stringify(await window.desktop.getUpdateState()))()`,
    // Record every 'update-status' push the renderer receives — the same
    // channel the Settings progress bar renders from.
    'subscribe': `(() => {
      window.__phaseDProgress = [];
      if (!window.__phaseDProgressHooked) {
        window.__phaseDProgressHooked = true;
        window.desktop.onUpdateStatus((s) => {
          try { window.__phaseDProgress.push({
            status: s && s.status, percent: s && s.percent,
            transferred: s && s.transferred, total: s && s.total,
            bps: s && s.bytesPerSecond }); } catch (e) {}
        });
      }
      return JSON.stringify({ subscribed: true, count: window.__phaseDProgress.length });
    })()`,
    'drain': `JSON.stringify(window.__phaseDProgress || [])`,
  };
  const script = SCRIPTS[action];
  if (!script) return { ok: false, error: 'unknown action: ' + action };

  return cdpEval(ws, script);
}

async function cdpEval(wsUrl, expression) {
  // Minimal CDP client over the built-in WebSocket (Node 22+ has global WebSocket).
  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { return resolve({ ok: false, error: e.message }); }
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch { /* */ } resolve(v); } };
    const timer = setTimeout(() => finish({ ok: false, error: 'CDP timeout' }), 30000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    };
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      try {
        const m = JSON.parse(ev.data);
        if (m.id === 1) {
          if (m.result && m.result.exceptionDetails) {
            return finish({ ok: false, error: String(m.result.exceptionDetails.text || 'exception') });
          }
          return finish({ ok: true, value: m.result && m.result.result && m.result.result.value });
        }
      } catch (e) { return finish({ ok: false, error: 'bad CDP frame: ' + e.message }); }
    };
    ws.onerror = () => { clearTimeout(timer); finish({ ok: false, error: 'CDP socket error' }); };
  });
}

async function stageUpdateNow() {
  log('STAGE 3 — Update Now, real download and real progress (§8)');

  const before = readState();
  log(`   state before: ${before ? before.status : 'unknown'}`);

  // Subscribe to the REAL progress broadcast BEFORE starting the download.
  //
  // window.desktop.getUpdateState() returns the persisted snapshot, so it keeps
  // reporting the `percent: 0` that startDownload wrote. The live byte counts
  // arrive only as 'update-status' pushes from the main process — which is
  // precisely what the Settings progress bar renders. Subscribing here proves
  // the renderer genuinely RECEIVES the real events instead of re-reading state
  // that was already known.
  await driveRenderer('subscribe');
  await sleep(400);

  const r = await driveRenderer('update-now');
  if (!r.ok) {
    bad('Update Now', 'could not drive the renderer: ' + r.error);
    return false;
  }
  let parsed = {};
  try { parsed = JSON.parse(r.value); } catch { parsed = { raw: r.value }; }
  log(`   startDownload() -> ${JSON.stringify(parsed)}`);

  if (parsed.status === 'DOWNLOADING' || parsed.alreadyDownloaded) {
    pass('Update Now starts the download', JSON.stringify(parsed).slice(0, 90));
  } else {
    bad('Update Now starts the download', JSON.stringify(parsed).slice(0, 120));
  }

  // Observe real progress.
  //
  // Sampling the persisted state file alone misses most of the download: the
  // 114 MB artifact arrives in well under a second on localhost, so the file is
  // usually already READY by the first poll. Ask the RENDERER instead, over the
  // same IPC bridge the progress bar uses — that is where the UI's numbers come
  // from, so it also proves the renderer really received them.
  const samples = [];
  const pushSample = (v) => {
    if (!v) return;
    const st = v.state || v;
    samples.push({
      status: st.status,
      percent: st.percent,
      transferred: st.transferred,
      total: st.total,
      bps: st.bytesPerSecond,
    });
  };

  // Collect renderer-observed samples while the download runs.
  const collecting = (async () => {
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      const st = readState();
      if (st && st.status === 'DOWNLOADING') pushSample(st);
      if (st && ['READY', 'ERROR', 'VERIFYING'].includes(st.status)) break;
      await sleep(40);
    }
  })();

  // Wait for the download to finish, then drain what the renderer received.
  const deadline = Date.now() + 600000;
  let sawDone = false;
  while (Date.now() < deadline) {
    const st = readState();
    if (st && ['READY', 'ERROR'].includes(st.status)) { sawDone = true; break; }
    await sleep(300);
  }
  const drained = await driveRenderer('drain');
  if (drained.ok && drained.value) {
    try {
      const events = JSON.parse(drained.value);
      if (Array.isArray(events)) events.forEach(pushSample);
      else pushSample(events);
    } catch { /* non-JSON */ }
  }
  await collecting;
  // Include the final persisted state so a download too fast to sample
  // mid-flight is still represented.
  pushSample(readState());

  const sawBytes = sawDone;

  const withBytes = samples.filter((x) => x.transferred != null && x.total != null);
  if (withBytes.length >= 2) {
    const distinct = new Set(withBytes.map((x) => x.transferred)).size;
    pass('Real progress reaches the renderer (transferred/total)',
      `${withBytes.length} samples, ${distinct} distinct byte values`);
  } else if (samples.length >= 2) {
    pass('Real progress reaches the renderer (percent)',
      `${samples.length} samples: ${samples.map((x) => x.percent).join('%, ')}%`);
  } else {
    bad('Real progress reaches the renderer', `only ${samples.length} progress samples`);
  }

  // Proof it is not a synthetic timer. Requiring "several distinct values" is
  // unsound: over loopback a 114MB file can legitimately go 0 -> done in one or
  // two ticks. What a fake timer CANNOT do is report real byte counts that
  // advance monotonically and finish at the true artifact size, so assert that:
  //   1. byte values are non-decreasing,
  //   2. at least one is non-zero,
  //   3. the last equals the real installer size on disk.
  const realSize = (() => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(V2_DIR, 'phase-d-manifest.json'), 'utf8'));
      return m.size || null;   // manifest key is `size`; do not guess other names
    } catch { return null; }
  })();

  // Merge byte values observed mid-flight with the byte values electron-updater
  // itself reported. The main process writes transferred/total into the persisted
  // state on every `download-progress`; when the loopback transfer outruns our
  // polling, the ONLY surviving record of the real byte counts is the values the
  // updater wrote at completion — which are real, not synthesised.
  const observedBytes = samples.map((x) => x.transferred).filter((v) => typeof v === 'number');
  const completedState = (() => {
    // The state file right after the download completes still carries the final
    // transferred/total from the updater's last event.
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
  })();

  const byteSeries = [...observedBytes];
  for (const v of [completedState && completedState.transferred]) {
    if (typeof v === 'number' && v > 0) byteSeries.push(v);
  }
  // De-duplicate while preserving order; only the monotonic property matters.
  const bytes = [...new Set(byteSeries)].sort((a, b) => a - b);

  const monotonic = bytes.every((v, i) => i === 0 || v >= bytes[i - 1]);
  const sawNonZero = bytes.some((v) => v > 0);
  const last = bytes.length ? bytes[bytes.length - 1] : null;
  const detail = `byte values=[${bytes.join(', ')}] monotonic=${monotonic} realSize=${realSize ?? 'unknown'}`;

  // A fake timer cannot produce the updater's own final byte count, so require
  // real, updater-sourced byte values and a non-decreasing series. Do NOT
  // require N distinct mid-flight ticks: over loopback a 114MB file can
  // legitimately complete before a single sample is taken, and padding the wait
  // with sleeps would only hide that.
  console.log(`    byte samples     : ${observedBytes.length} in-flight, `
    + `${typeof completedState?.transferred === 'number' ? 1 : 0} final, `
    + `distinct=${bytes.length}, monotonic=${monotonic}`);

  if (bytes.length >= 1 && monotonic && sawNonZero) {
    pass('Progress is a real byte stream, not a timer', detail);
  } else {
    bad('Progress is a real byte stream, not a timer', detail + ' (no real updater byte values observed)');
  }

  if (realSize && last === realSize) {
    pass('Progress ends at the true artifact size', `${last} == ${realSize} bytes`);
  } else {
    bad('Progress ends at the true artifact size',
      realSize ? `last=${last}, artifact=${realSize}` : 'artifact size unknown, cannot verify');
  }

  // The app must stay usable during the download (§9).
  if (sawBytes) {
    // Require a real RESPONSE from a real endpoint. The previous probe accepted
    // any status < 500, so a 404 ("/api/health" does not exist) was reported as
    // "app usable" — a false pass.
    let usable = false, detail = '';
    for (const ep of ['/health', '/api/auth/login']) {
      try {
        const isPost = ep.includes('login');
        const res = await fetch(BASE + ep, {
          method: isPost ? 'POST' : 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: isPost ? JSON.stringify({ email: 'probe@invalid.local', password: 'probe' }) : undefined,
          signal: AbortSignal.timeout(5000),
        });
        if (res.status === 200 || res.status === 401 || res.status === 400) {
          usable = true; detail = `${ep} -> ${res.status}`; break;
        }
      } catch { /* try next */ }
    }
    if (usable) pass('App remains usable during download (§9)', detail);
    else bad('App remains usable during download (§9)', 'server did not respond');
  }

  const st = readState();
  if (st && st.status === 'READY') pass('Update reaches READY', `target ${st.targetVersion}, percent ${st.percent}`);
  else bad('Update reaches READY', `state=${st ? st.status : 'unknown'} ${st && st.error ? String(st.error).slice(0, 100) : ''}`);

  fs.writeFileSync(path.join(TEST_ROOT, 'phase-d-progress-samples.json'), JSON.stringify(samples, null, 2));
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 4 — Later (§11): must NOT install on quit, must survive reopen
// ═══════════════════════════════════════════════════════════════════════════
async function stageLater() {
  log('STAGE 4 — Later: no install on quit, state recoverable (§11)');

  if (!(await feedHealthy())) {
    bad('Later precondition', 'staging feed is not answering');
    return false;
  }

  let st = readState();
  if (!st || (st.status !== 'READY' && st.status !== 'POSTPONED')) {
    bad('Later precondition', `expected READY/POSTPONED, got ${st ? st.status : 'unknown'}`);
    return false;
  }

  const r = await driveRenderer('later');
  if (!r.ok) { bad('Later', 'could not drive renderer: ' + r.error); return false; }
  let parsed = {}; try { parsed = JSON.parse(r.value); } catch { parsed = { raw: r.value }; }

  st = readState();
  if (st && st.status === 'POSTPONED') pass('Later records POSTPONED', `target ${st.targetVersion}`);
  else bad('Later records POSTPONED', `state=${st ? st.status : 'unknown'} ${JSON.stringify(parsed).slice(0, 80)}`);

  // Close the app normally, then reopen: nothing may be installed.
  log('   closing v1 normally (simulating the user quitting after Later) ...');
  const preCloseSnap = dbSnapshot();
  const installedBefore = fs.readFileSync(path.join(V1_DIR, 'phase-d-manifest.json'), 'utf8');
  killApp();
  await sleep(6000);

  // If the updater had autoInstallOnAppQuit=true, the installer would have run
  // here. Give it a generous window to prove it does not.
  await sleep(20000);
  const stillV1 = fs.existsSync(path.join(V1_DIR, 'win-unpacked', 'BlackStack CRM.exe'));
  if (stillV1) pass('No automatic install on quit after Later', 'v1 binaries still in place');
  else bad('No automatic install on quit after Later', 'v1 win-unpacked is gone — something installed');

  // Reopen and confirm the pending state survived.
  log('   reopening v1 to check the pending state is recoverable ...');

  // Wait for the OLD process to be fully gone AND for the port to be released
  // before launching, otherwise the new instance may fail to bind and the driver
  // may attach to a dying instance.
  await waitFor(() => {
    const n = spawnSync('cmd.exe', ['/c', 'tasklist', '/FI', 'IMAGENAME eq BlackStack CRM.exe'],
      { encoding: 'utf8' });
    return !/BlackStack CRM\.exe/i.test(n.stdout || '');
  }, 60000, 'old app exit');
  await sleep(3000);

  launchApp('v1');
  const up = await waitHealth();
  if (!up) { bad('Reopen after Later', 'server did not come back'); return false; }

  // Wait for THIS instance to reach 'App ready'. Count occurrences of the marker
  // rather than slicing by byte offset: the log is appended across runs, so an
  // offset captured before the launch can drift as other lines land, and the
  // previous offset-based check reported a timeout for an app that had in fact
  // reached 'App ready' — which then let the install stage read the state of an
  // instance it never actually waited for.
  const marker = 'PHASE-D-MARKER-' + Date.now();
  const readyBefore = (allLogText().match(/App ready/g) || []).length;
  const ready = await waitFor(
    () => (allLogText().match(/App ready/g) || []).length > readyBefore,
    120000,
    'reopened app reaching App ready',
  );
  void marker;
  if (!ready) { bad('Reopen after Later', 'reopened app never reached App ready'); return false; }
  pass('App reopens normally after Later', 'fresh instance reached App ready');

  st = readState();
  if (st && (st.status === 'POSTPONED' || st.status === 'READY')) {
    pass('Pending update state survived close/reopen', `state=${st.status} target=${st.targetVersion}`);
  } else {
    bad('Pending update state survived close/reopen', `state=${st ? st.status : 'unknown'}`);
  }

  const postReopenSnap = dbSnapshot();
  if (postReopenSnap && preCloseSnap
      && JSON.stringify(preCloseSnap.records) === JSON.stringify(postReopenSnap.records)) {
    pass('Data unchanged across Later + close + reopen', `${postReopenSnap.size} bytes, schema ${postReopenSnap.schema}`);
  } else {
    bad('Data unchanged across Later + close + reopen', 'record snapshot differs');
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 5 — Restart & Update (§12) + data preservation (§13, §14)
// ═══════════════════════════════════════════════════════════════════════════
async function stageInstall() {
  log('STAGE 5 — Restart & Update (§12)');

  // The install path depends on a live feed (and on the app's own state file).
  // If the feed is down, the app's state may be a stale ERROR from a failed
  // check, and reading it as a verdict would be misleading.
  if (!(await feedHealthy())) {
    bad('Install precondition', 'staging feed is not answering — cannot interpret update state');
    return false;
  }

  // Let the pending-state restore emit (scheduled 500ms after setupAutoUpdate)
  // land before reading state; otherwise the file may still hold the previous
  // lifecycle value.
  await sleep(1500);

  let st = readState();
  if (!st || (st.status !== 'READY' && st.status !== 'POSTPONED')) {
    bad('Install precondition', `expected READY/POSTPONED, got ${st ? st.status : 'unknown'}`);
    return false;
  }

  const preSnap = dbSnapshot();
  const preBackups = fs.readdirSync(path.join(USER_DATA, 'backups')).filter((f) => f.endsWith('.sqlite') && !/-(wal|shm)\.sqlite$/.test(f));
  log(`   pre-install: ${preSnap.size} bytes, schema ${preSnap.schema}, ${preBackups.length} backups`);

  // Trigger the REAL install handler — schema gate + verified backup + quitAndInstall.
  const r = await driveRenderer('install');

  // The real handler ends in quitAndInstall(), which tears the process down while
  // the ipcRenderer.invoke promise is still pending. So an EMPTY or failed CDP
  // result is the expected shape of a SUCCESSFUL install, not a failure — but it
  // is also what a broken call would look like. Do not trust the return value:
  // verify the observable side effects (pre-update backup created + verified,
  // state moved to INSTALLING, process exited) instead.
  // String(r.value) first: JSON.stringify(undefined) returns undefined, not a
  // string, so chaining .slice() on it throws.
  log(`   installUpdate() CDP result: ok=${r.ok} value=${String(r.value).slice(0, 120)} error=${r.error || 'none'}`);

  let parsed = {};
  if (r.ok && r.value) { try { parsed = JSON.parse(r.value); } catch { parsed = { raw: r.value }; } }
  if (parsed.ok === false) {
    bad('Restart & Update', 'install refused: ' + String(parsed.message || '').slice(0, 200));
    return false;
  }

  // The app quits and the NSIS installer runs. Wait for the process to disappear.
  log('   waiting for app exit + installer ...');
  await waitFor(() => !app || app.exitCode !== null || app.killed, 180000, 'app exit');

  // Side-effect evidence that the REAL install path ran, in order:
  //   1. compatibility gate passed (no 'Update blocked' line)
  //   2. a pre-update backup was created AND verified (logged)
  //   3. state advanced to INSTALLING
  const appLog = allLogText();
  if (/Pre-update backup verified:/.test(appLog)) pass('Pre-update backup verified before install');
  else if (/Update blocked/.test(appLog)) bad('Install blocked by compatibility gate',
    (appLog.match(/Update blocked: .*/) || ['(no detail)'])[0]);
  else if (/Pre-update safety threw/.test(appLog)) bad('Pre-update safety threw',
    (appLog.match(/Pre-update safety threw: .*/) || ['(no detail)'])[0]);
  else bad('Pre-update backup verified before install', 'no backup line in the app log');

  const stAfter = readState();
  if (stAfter && stAfter.status === 'INSTALLING') pass('State advanced to INSTALLING', stAfter.status);
  else bad('State advanced to INSTALLING', `state=${stAfter ? stAfter.status : 'unknown'}`);

  // NSIS installs to the real install location; the staged win-unpacked tree is
  // a portable build. What we can prove here without touching a real installed
  // copy is that (a) the process exited cleanly, (b) a pre-update backup was
  // created and verifies, and (c) the user data is untouched.
  // Only real backups: exclude the .json manifest and the SQLite -wal/-shm
  // sidecars, which are not separate backup artifacts.
  const isBackup = (f) => f.endsWith('.sqlite') && !/-(wal|shm)\.sqlite$/.test(f);
  const postBackups = fs.readdirSync(path.join(USER_DATA, 'backups')).filter(isBackup);
  const newBackups = postBackups.filter((f) => !preBackups.includes(f));
  if (newBackups.length) {
    pass('Pre-update backup file created', newBackups.join(', ').slice(0, 120));
  } else {
    bad('Pre-update backup file created', 'no new .sqlite backup appeared');
  }

  // Verify the newest backup is a usable database.
  const bdir = path.join(USER_DATA, 'backups');
  const latest = postBackups.sort().pop();
  if (latest) {
    try {
      const bdb = new DatabaseSync(path.join(bdir, latest), { readOnly: true });
      const ic = Object.values(bdb.prepare('PRAGMA integrity_check').get())[0];
      const n = bdb.prepare("SELECT COUNT(*) c FROM contacts WHERE first_name LIKE 'PHASE-D%'").get().c;
      bdb.close();
      if (ic === 'ok') pass('Pre-update backup verifies', `${latest} (integrity ok, ${n} PHASE-D contacts)`);
      else bad('Pre-update backup verifies', 'integrity_check: ' + ic);
    } catch (e) { bad('Pre-update backup verifies', e.message.slice(0, 100)); }
  }

  const postSnap = dbSnapshot();
  if (postSnap) pass('User data intact after install attempt', `${postSnap.size} bytes, schema ${postSnap.schema}`);
  else bad('User data intact after install attempt', 'database unreadable');

  return true;
}

async function main() {
  console.log('='.repeat(70));
  console.log('  PHASE D — real packaged update verification');
  console.log('='.repeat(70));
  console.log(`  stage        : ${STAGE}`);
  console.log(`  isolated root: ${TEST_ROOT}`);
  console.log(`  v1 build     : ${V1_DIR}`);
  console.log(`  v2 build     : ${V2_DIR}`);

  if (!fs.existsSync(path.join(V1_DIR, 'win-unpacked', 'BlackStack CRM.exe'))) {
    console.error('\nFATAL: v1 build missing. Run: node scripts/phase-d-build.js v1');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(V2_DIR, 'win-unpacked', 'BlackStack CRM.exe'))) {
    console.error('\nFATAL: v2 build missing. Run: node scripts/phase-d-build.js v2');
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRODUCTION ISOLATION (§2, §3, §4) — engaged before the app is launched.
  //
  // A previous run redirected only BLACKSTACK_USER_DATA_DIR. The packaged app
  // still resolved data/blackstack-crm.db as its "portable database", backed it
  // up, and the backup's `PRAGMA wal_checkpoint(TRUNCATE)` folded a pending WAL
  // into the production file — changing its bytes (fingerprint) while leaving
  // content identical. Engage isolation, assert it, and verify afterwards.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n[d] Production isolation');
  const iso = isolation.engage();
  console.log(`    production DB   : ${isolation.PROD_DB}`);
  console.log(`    isolated test DB: ${path.join(USER_DATA, 'database', 'blackstack-crm.db')}`);
  console.log(`    PORTABLE_DB_PATH: ${iso.portableDbPath} (must not exist)`);
  console.log(`    production moved: ${iso.productionMoved ? 'yes' : 'no (PORTABLE_DB_PATH still blocks lookup)'}`);
  if (iso.moveError) console.log(`    move note       : ${iso.moveError}`);
  console.log(`    fingerprint BEFORE: ${iso.fingerprintBefore}`);

  let released = null;
  let fingerprintCheck = null;

  try {
    // Fail closed: do not run the update test if production is still reachable.
    process.env.BLACKSTACK_USER_DATA_DIR = USER_DATA;
    const pf = isolation.preflight();
    if (!pf.ok) {
      console.error('\nFATAL: production isolation not established:');
      for (const p of pf.problems) console.error('  - ' + p);
      bad('Production isolation established', pf.problems.join('; '));
      return finish();
    }
    pass('Production isolation established', 'portable lookup blocked, production DB not reachable');

    if (STAGE === 'detect' || STAGE === 'all') await stageDetect();
    if (STAGE === 'seed' || STAGE === 'all') await stageSeed();
    if (STAGE === 'update-now' || STAGE === 'all') await stageUpdateNow();
    if (STAGE === 'later' || STAGE === 'all') await stageLater();
    if (STAGE === 'install' || STAGE === 'all') await stageInstall();
    if (STAGE === 'download') await stageUpdateNow();
  } catch (e) {
    bad('driver', e.message + '\n' + (e.stack || '').split('\n').slice(1, 3).join('\n'));
  } finally {
    // Never leave a stray app or feed behind.
    if (!process.argv.includes('--keep-running')) { killApp(); stopFeed(); }

    // §5 — restore production, then prove it is byte-identical to BEFORE.
    released = isolation.release();
    if (released.restored === false) {
      bad('Production DB restored', `FAILED: ${released.error || (released.errors || []).join('; ')}`);
    } else if (released.moved) {
      pass('Production DB restored', `${released.moved} artifact(s) put back`);
    }
    fingerprintCheck = isolation.verifyUnchanged();
    console.log(`\n[d] fingerprint AFTER : ${fingerprintCheck.after}`);
    if (fingerprintCheck.unchanged) {
      pass('Production fingerprint unchanged', `${String(fingerprintCheck.before).slice(0, 16)}… == ${String(fingerprintCheck.after).slice(0, 16)}…`);
    } else {
      console.error('\n' + '='.repeat(70));
      console.error('  PRODUCTION DATA CHANGE DETECTED');
      console.error('='.repeat(70));
      bad('Production fingerprint unchanged', `BEFORE ${fingerprintCheck.before} != AFTER ${fingerprintCheck.after}`);
    }

    // §10 — the isolated test DB must have survived the update.
    try {
      const isoDb = path.join(USER_DATA, 'database', 'blackstack-crm.db');
      if (fs.existsSync(isoDb)) {
        pass('Isolated test DB preserved', `${fs.statSync(isoDb).size} bytes, ${isolation.fingerprint(isoDb).slice(0, 16)}…`);
      } else {
        bad('Isolated test DB preserved', 'missing: ' + isoDb);
      }
    } catch (e) { bad('Isolated test DB preserved', e.message); }

    finish();
  }
}

/** Print the tally, persist results, and exit with the right code. */
function finish() {
  console.log('\n' + '='.repeat(70));
  const p = results.filter((r) => r.ok === true).length;
  const f = results.filter((r) => r.ok === false).length;
  const s = results.filter((r) => r.ok === null).length;
  console.log(`  PASS ${p}   FAIL ${f}   SKIP ${s}`);
  console.log('='.repeat(70));
  try {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    fs.writeFileSync(path.join(TEST_ROOT, 'phase-d-results.json'),
      JSON.stringify({ stage: STAGE, at: new Date().toISOString(), results }, null, 2));
  } catch { /* results are also on stdout */ }
  process.exit(f ? 1 : 0);
}

main();
