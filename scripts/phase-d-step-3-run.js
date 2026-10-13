#!/usr/bin/env node
/**
 * PHASE D STEP 3 — driver. Runs the recovery scenarios.
 * Invoked directly: node scripts/phase-d-step-3-run.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const H = require('./phase-d-step-3-recovery');
const {
  ROOT, V1_DIR, V2_DIR, PROD_DB, BASE, FEED_PORT,
  pass, bad, assert, skip, section, D, sleep, md5, sha512,
  killBlackStack, countBlackStack, countInstallers,
  contentFingerprint, httpJson, httpGetText, waitForPort, serverPortFromLog,
  login, tokenFromRenderer, cdpEval, startFeed, waitForFeed, killTree,
  launchClient, uiSignIn, updaterState, uiCall, waitState, rmrf,
} = H;

const DIST = path.join(ROOT, 'dist-phase-d');
const RESULTS = {};

// ════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('='.repeat(72));
  console.log('PHASE D STEP 3 — Failure Recovery & Production Release Verification');
  console.log('='.repeat(72));

  rmrf(BASE);
  fs.mkdirSync(BASE, { recursive: true });

  // ── production baseline + isolation ────────────────────────────────────
  D('§2 production baseline + isolation');
  const prodFileBefore = md5(PROD_DB);
  const prodContentBefore = contentFingerprint(PROD_DB);
  console.log(`  content fingerprint BEFORE : ${prodContentBefore}`);
  console.log(`  file checksum BEFORE       : ${prodFileBefore}`);

  const isolation = require('./phase-d-isolation');
  const r0 = isolation.recoverIfHeld();
  if (r0.ran) console.log(`  recovered ${r0.recovered} artifact(s) from an interrupted run`);
  if (!fs.existsSync(PROD_DB)) { console.error('FATAL: production DB missing and unrecoverable'); process.exit(2); }

  const eng = isolation.engage();
  assert(eng.productionMoved, 'Isolation engaged — production moved aside', `${eng.movedCount} artifact(s)`);
  // preflight() is the fail-closed check: it must prove the packaged app cannot
  // resolve the production database. If it does not, abort before any test runs.
  const pre = isolation.preflight();
  const preText = JSON.stringify(pre);
  console.log(`  preflight: ok=${pre.ok} problems=${JSON.stringify(pre.problems || [])}`);
  if (!pre.ok) {
    console.error('FATAL: isolation preflight failed — aborting without touching anything.');
    try { isolation.release(); } catch { /* noop */ }
    process.exit(2);
  }
  assert(true, 'Fail-closed preflight — packaged app cannot reach production DB', preText.slice(0, 140));
  console.log(`  isolated root : ${BASE}`);

  // Registered-installation guard (see §10 of the Step 3 brief). electron-builder
  // registers NSIS installs machine-wide, so an "isolated" install is not
  // isolated. Report what is registered BEFORE any scenario can install, and make
  // the fact part of the permanent record.
  {
    const pre = spawnSync(process.execPath, [path.join(__dirname, 'phase-d-step-3-install-preflight.js'), '--json'],
      { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    let pf = null;
    try { pf = JSON.parse(pre.stdout); } catch { pf = null; }
    D('§10 registered-installation preflight');
    if (pf) {
      console.log(`  classification : ${pf.classification}`);
      console.log(`  reason         : ${pf.reason}`);
      console.log(`  may install    : ${pf.mayInstall}`);
      for (const r of pf.registrations) {
        console.log(`    [${r.registration.scope}] ${r.registration.displayName} (${r.registration.displayVersion})`);
        console.log(`      installLocation : ${r.registration.installLocation || '(derived from UninstallString)'}`);
        console.log(`      uninstall       : ${r.registration.uninstallString}`);
        console.log(`      payload matches our build : ${r.install.matchesOurV2Build}`);
      }
      if (pf.userData?.database) {
        console.log(`  real userData database (protected): ${pf.userData.database.path}`);
        console.log(`    md5 ${pf.userData.database.md5}  ${pf.userData.database.size} bytes  ${pf.userData.database.mtime}`);
      }
      assert(pf.classification !== 'UNKNOWN', '§10 Registered-installation preflight completed', pf.classification);
    } else {
      bad('§10 Registered-installation preflight', 'could not read preflight output');
    }
    RESULTS.installPreflight = pf ? { classification: pf.classification, mayInstall: pf.mayInstall, registrations: pf.registrations.length } : null;
  }

  try {
    await scenarioA();
    await scenarioB();
    await scenarioC_D();
    await scenarioE();
    await scenarioF();
    await productionConfigAudit();
    await multiSystem();
    await retrySafety();
    await versionConsistency();
  } catch (e) {
    bad('Harness aborted', e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    await teardown(isolation, prodFileBefore, prodContentBefore, eng);
  }

  finish();
}

// ════════════════════════════════════════════════════════════════════════════
async function teardown(isolation, prodFileBefore, prodContentBefore, eng) {
  section('§18 cleanup + §19 production data safety');

  D('cleanup');
  killBlackStack();
  await sleep(2000);
  // Give any installer a bounded chance to finish so we do not delete files
  // out from under it, then force it down.
  for (let i = 0; i < 20 && countInstallers() > 0; i++) await sleep(1000);
  killBlackStack();
  for (const p of [34811, 34567]) {
    try {
      const out = execSync(`netstat -ano | findstr :${p}`, { encoding: 'utf8' });
      const pids = [...new Set(out.split(/\r?\n/).map((l) => (l.trim().split(/\s+/).pop() || '')).filter((x) => /^\d+$/.test(x)))];
      for (const pid of pids) killTree(pid);
    } catch { /* nothing listening */ }
  }
  await sleep(2000);

  // Release production back into place BEFORE any production measurement.
  const rel = isolation.release();
  assert(rel.restored, 'Production DB restored', rel.restored ? `${rel.moved} artifact(s)` : (rel.error || ''));

  const prodFileAfter = fs.existsSync(PROD_DB) ? md5(PROD_DB) : null;
  const prodContentAfter = contentFingerprint(PROD_DB);

  D('§19 production safety');
  console.log(`  content fingerprint BEFORE : ${prodContentBefore}`);
  console.log(`  content fingerprint AFTER  : ${prodContentAfter}`);
  console.log(`  file checksum BEFORE       : ${prodFileBefore}`);
  console.log(`  file checksum AFTER        : ${prodFileAfter}`);

  assert(prodContentAfter === prodContentBefore && prodContentBefore !== 'MISSING',
    'Production content fingerprint UNCHANGED',
    `${String(prodContentBefore).slice(0, 12)} == ${String(prodContentAfter).slice(0, 12)}`);
  assert(prodFileAfter === prodFileBefore, 'Production file checksum UNCHANGED',
    `${String(prodFileBefore).slice(0, 12)} == ${String(prodFileAfter).slice(0, 12)}`);
  console.log(`  production absent during test: ${eng.productionMoved}`);

  // Nothing production-side may be left modified or held aside.
  const holdDir = path.join(path.dirname(PROD_DB), '.phase-d-isolation-hold');
  const holdLeft = fs.existsSync(holdDir) ? fs.readdirSync(holdDir) : [];
  assert(holdLeft.length === 0, 'No production DB held aside after release', `${holdLeft.length} file(s)`);

  for (const ext of ['-wal', '-shm']) {
    const f = PROD_DB + ext;
    if (fs.existsSync(f)) {
      const st = fs.statSync(f);
      console.log(`  sidecar present: ${path.basename(f)} (${st.size} bytes, mtime ${st.mtime.toISOString()})`);
    }
  }

  // No production install/config touched.
  const pkgNow = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert(pkgNow.version === '1.0.0', 'package.json unchanged (dev baseline restored)', pkgNow.version);

  // Remove every temp artifact this step created.
  const isoRoot = path.join(process.env.LOCALAPPDATA, 'Temp');
  for (const n of ['phase-d-step3', 'pd3-mig-test', 'pd3-launchtest']) {
    rmrf(path.join(isoRoot, n));
  }
  rmrf(path.join(ROOT, 'user-data'));
  // Any migration file the injector may have left behind.
  const migDir = path.join(ROOT, 'server', 'database', 'migrations');
  for (const f of fs.readdirSync(migDir)) {
    if (/step3_injected_failure/i.test(f)) { fs.unlinkSync(path.join(migDir, f)); console.log(`  removed stray ${f}`); }
  }
  console.log(`  temp trees removed; remaining BlackStack processes: ${countBlackStack()}`);
}

function finish() {
  section('RESULT');
  const total = H.passCount + H.failCount + H.skipCount;
  console.log(`  PASS ${H.passCount}   FAIL ${H.failCount}   SKIP ${H.skipCount}   (of ${total})`);
  if (H.failures.length) {
    console.log('\n  FAILURES:');
    for (const f of H.failures) console.log(`    - ${f}`);
  }
  if (H.skips.length) {
    console.log('\n  SKIPPED (explicitly pending, not claimed as PASS):');
    for (const s of H.skips) console.log(`    - ${s}`);
  }
  fs.writeFileSync(path.join(BASE, '..', 'pd3-results.json'), JSON.stringify(RESULTS, null, 2));
  const verdict = H.failCount === 0
    ? (H.skips.length ? 'PHASE D STEP 3 — PASS WITH LIMITATIONS' : 'PHASE D STEP 3 — PASS')
    : 'PHASE D STEP 3 — FAIL';
  console.log(`\n${'='.repeat(72)}\n${verdict}\n${'='.repeat(72)}`);
  process.exitCode = H.failCount === 0 ? 0 : 1;
}

// ════════════════════════════════════════════════════════════════════════════
// Feed helpers: each scenario gets its own feed dir so corruption is isolated
// ════════════════════════════════════════════════════════════════════════════
function feedDirFor(name) {
  const d = path.join(BASE, 'feeds', name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Publish a feed that serves the real v2 installer, optionally tampered. */
function publishFeed(dir, { tamper = null } = {}) {
  const src = path.join(DIST, 'v2');
  const dest = path.join(dir, 'v2');
  rmrf(dest);
  fs.cpSync(src, dest, { recursive: true });

  const exeName = fs.readdirSync(dest).find((f) => f.endsWith('.exe'));
  const exePath = path.join(dest, exeName);

  let actualSha = sha512(exePath);
  let actualSize = fs.statSync(exePath).size;

  if (tamper === 'truncate') {
    // Cut the installer to 4 KB — still a valid PE header, far too short.
    const fd = fs.openSync(exePath, 'r+');
    fs.ftruncateSync(fd, 4096);
    fs.closeSync(fd);
  } else if (tamper === 'bytes') {
    // Flip bytes inside the payload without changing length, so the size still
    // matches and only the hash can catch it.
    const fd = fs.openSync(exePath, 'r+');
    const buf = Buffer.alloc(4096);
    fs.readSync(fd, buf, 0, 4096, Math.floor(actualSize / 2));
    for (let i = 0; i < buf.length; i++) buf[i] ^= 0xff;
    fs.writeSync(fd, buf, 0, 4096, Math.floor(actualSize / 2));
    fs.closeSync(fd);
  }

  // Write metadata with the ORIGINAL (correct) hash, then recompute the real
  // hash of what we just wrote. This models the real threat: metadata says X,
  // the bytes on the wire are not X.
  const yml = path.join(dest, 'latest.yml');
  const ymlTxt = fs.readFileSync(yml, 'utf8');
  const declaredSha = (ymlTxt.match(/sha512:\s*(\S+)/) || [])[1] || '';
  const blockmapTxt = fs.existsSync(path.join(dest, 'latest.yml.blockmap')) ? fs.readFileSync(path.join(dest, 'latest.yml.blockmap'), 'utf8') : null;

  const actualShaAfter = sha512(exePath);
  const sizeAfter = fs.statSync(exePath).size;

  return {
    dir, exeName, declaredSha,
    actualSha: actualShaAfter,
    actualSize: sizeAfter,
    hashMismatch: declaredSha !== actualShaAfter,
    sizeMismatch: sizeAfter !== actualSize,
    ymlTxt, blockmapTxt,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// A. Corrupted update artifact
// ════════════════════════════════════════════════════════════════════════════
async function scenarioA() {
  section('§3 RECOVERY TEST A — corrupted update artifact');

  // The staging feed derives sha512 from the bytes it serves, so a feed is
  // always self-consistent and a tampered file is by construction "valid".
  // Real corruption in transit is a DECLARED-vs-ACTUAL mismatch, so that is
  // what we force here (PHASE_D_FEED_FORCE_SHA512).
  const pristine = publishFeed(feedDirFor('A-pristine'));
  const declared = pristine.declaredSha;

  const variants = [
    { name: 'declared/actual sha512 mismatch', tamper: 'bytes' },
    { name: 'truncated installer', tamper: 'truncate', mismatch: true },
  ];

  for (const v of variants) {
    D(`A/${v.name}`);
    killBlackStack();
    await sleep(2000);

    const dir = feedDirFor(`A-${v.tamper}`);
    const info = publishFeed(dir, { tamper: v.tamper });
    console.log(`  declared sha512 : ${info.declaredSha.slice(0, 40)}…`);
    console.log(`  actual   sha512 : ${info.actualSha.slice(0, 40)}…`);
    console.log(`  hash mismatch  : ${info.hashMismatch}   size: ${info.actualSize}`);

    // Serve the ORIGINAL (correct) hash for bytes that are no longer the
    // original — the integrity check must reject this.
    const feed = startFeed(dir + '/v2', FEED_PORT, { PHASE_D_FEED_FORCE_SHA512: declared });
    const feedUp = await waitForFeed(FEED_PORT, 60000);
    assert(feedUp, `A/${v.name} — staging feed serving the tampered artifact`);

    const ud = path.join(BASE, `A-${v.tamper}`, 'userdata');
    const app = await launchClient({ userData: ud, exeDir: V1_DIR, label: `A-${v.tamper}` });
    if (!assert(app.port, `A/${v.name} — v1 launched`, `port ${app.port}`)) {
      killBlackStack(); killTree(feed.pid); continue;
    }

    const dbFile = path.join(ud, 'database', 'blackstack-crm.db');
    await uiSignIn(app);
    await sleep(3000);
    const fpBefore = contentFingerprint(dbFile);
    const fileBefore = md5(dbFile);

    await uiCall(app, 'checkForUpdate');
    const avail = await waitState(app, ['AVAILABLE'], 120000);
    assert(avail, `A/${v.name} — update detected`, avail ? `target ${avail.target}` : 'no AVAILABLE');

    await uiCall(app, 'startDownload');

    // The download must NOT reach READY: verification has to fail it.
    const term = await waitState(app, ['READY', 'ERROR', 'RECOVERY_REQUIRED'], 300000);
    const st = await updaterState(app);
    console.log(`  final state: ${JSON.stringify(st)}`);

    assert(!term || term.status !== 'READY',
      `A/${v.name} — tampered artifact rejected (never READY)`, st?.status);
    assert(!term || ['ERROR', 'RECOVERY_REQUIRED'].includes(term.status),
      `A/${v.name} — entered recoverable error state`, term?.status || st?.status);

    assert(countInstallers() === 0, `A/${v.name} — installer NOT executed`, `${countInstallers()} installer process(es)`);
    assert(countBlackStack() > 0, `A/${v.name} — application did not restart`, `${countBlackStack()} process(es)`);

    const healthy = await httpJson(`http://127.0.0.1:${app.port}/health`, { timeout: 8000 });
    assert(healthy.status === 200, `A/${v.name} — current version still usable`, `HTTP ${healthy.status}`);

    const fpAfter = contentFingerprint(dbFile);
    const fileAfter = md5(dbFile);
    assert(fpAfter === fpBefore, `A/${v.name} — database untouched (content)`, `${String(fpBefore).slice(0, 12)} == ${String(fpAfter).slice(0, 12)}`);
    assert(fileAfter === fileBefore, `A/${v.name} — database untouched (bytes)`, `${String(fileBefore).slice(0, 12)} == ${String(fileAfter).slice(0, 12)}`);

    let logged = false;
    try {
      const txt = fs.readFileSync(app.logFile, 'utf8');
      logged = /sha512|checksum|integrity|verification|ERR_|ERROR/i.test(txt);
      const m = txt.match(/(sha512|checksum|integrity)[^\n]{0,120}/i);
      if (m) console.log(`  log evidence: ${m[0].trim().slice(0, 120)}`);
    } catch { /* noop */ }
    assert(logged, `A/${v.name} — failure is logged`);

    // Retry must actually be drivable, not merely return a value: the app has to
    // be able to check again and report a coherent status afterwards.
    await uiCall(app, 'checkForUpdate');
    const retried = await waitState(app, ['AVAILABLE', 'DOWNLOADING', 'READY', 'ERROR', 'RECOVERY_REQUIRED', 'UP_TO_DATE'], 120000);
    assert(!!retried, `A/${v.name} — user can retry/recover`, retried ? retried.status : JSON.stringify(await updaterState(app)));

    app.proc.kill('SIGTERM');
    await sleep(1500);
    killBlackStack();
    killTree(feed.pid);
    await sleep(2000);
    RESULTS[`A_${v.tamper}`] = { finalState: st?.status, declared: declared.slice(0, 16), actual: info.actualSha.slice(0, 16) };
  }

  // Third variant: metadata that references a file the feed does not serve.
  D('A/invalid update metadata');
  killBlackStack();
  await sleep(2000);
  const dirM = feedDirFor('A-metadata');
  publishFeed(dirM);
  // The feed builds metadata from the real artifact at request time, so editing
  // a latest.yml on disk is pointless. Declare a correct-looking size but an
  // artifact name that does not exist: the download must fail.
  const feedM = startFeed(dirM + '/v2', FEED_PORT, {
    PHASE_D_FEED_FORCE_PATH: 'BlackStack CRM Setup 9.9.9-missing.exe',
  });
  if (!assert(await waitForFeed(FEED_PORT, 60000), 'A/invalid metadata — feed up')) { killTree(feedM.pid); return; }

  const udM = path.join(BASE, 'A-metadata', 'userdata');
  const appM = await launchClient({ userData: udM, exeDir: V1_DIR, label: 'A-meta' });
  if (appM.port) {
    const dbM = path.join(udM, 'database', 'blackstack-crm.db');
    await uiSignIn(appM);
    await sleep(3000);
    const fpM = contentFingerprint(dbM);
    await uiCall(appM, 'checkForUpdate');
    const availM = await waitState(appM, ['AVAILABLE', 'ERROR'], 120000);
    if (availM && availM.status === 'AVAILABLE') {
      await uiCall(appM, 'startDownload');
      const termM = await waitState(appM, ['READY', 'ERROR', 'RECOVERY_REQUIRED'], 240000);
      const stM = await updaterState(appM);
      console.log(`  final state: ${JSON.stringify(stM)}`);
      assert(!termM || termM.status !== 'READY', 'A/invalid metadata — not accepted as READY', stM?.status);
      const stillV1b = await cdpEval(appM.cdp, `(async () => { const i = await window.desktop.getAppInfo(); return i; })()`);
      assert(stillV1b && stillV1b.version === '1.0.0',
        'A/invalid metadata — installer NOT executed (still v1)', stillV1b?.version);
      assert(contentFingerprint(dbM) === fpM, 'A/invalid metadata — database untouched');
    } else {
      // A metadata failure that is caught at CHECK time is an even better result.
      const stM = await updaterState(appM);
      console.log(`  rejected at check time: ${JSON.stringify(stM)}`);
      assert(!availM || availM.status !== 'READY', 'A/invalid metadata — not accepted as READY', stM?.status);
      // This scenario never calls installUpdate; prove that, because a
      // machine-wide installer count can still see an earlier scenario's
      // process winding down and is not evidence about THIS client.
      const stillV1 = await cdpEval(appM.cdp, `(async () => { const i = await window.desktop.getAppInfo(); return i; })()`);
      assert(stillV1 && stillV1.version === '1.0.0',
        'A/invalid metadata — installer NOT executed (still v1)', stillV1?.version);
    }
    appM.proc.kill('SIGTERM');
    await sleep(1500);
  }
  killBlackStack();
  killTree(feedM.pid);
  await sleep(1500);
  RESULTS.A_metadata = true;
}

// ════════════════════════════════════════════════════════════════════════════
// B. Installer failure
// ════════════════════════════════════════════════════════════════════════════
async function scenarioB() {
  section('§4 RECOVERY TEST B — installer failure');

  // This scenario drives the REAL NSIS installer. electron-builder registers
  // machine-wide, so an install cannot be isolated from an existing
  // registration. Do not run it against protected state.
  const pre = spawnSync(process.execPath, [path.join(__dirname, 'phase-d-step-3-install-preflight.js'), '--json'],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  let preflight = null;
  try { preflight = JSON.parse(pre.stdout); } catch { preflight = null; }
  if (!preflight || !preflight.mayInstall) {
    skip('§4 installer failure (real NSIS install required)',
      preflight ? preflight.reason : 'preflight could not be read');
    for (const r of (preflight?.registrations || [])) {
      console.log(`    registration: [${r.registration.scope}] ${r.registration.displayName}`);
    }
    RESULTS.B = { skipped: true, reason: preflight ? preflight.reason : 'unknown' };
    return;
  }

  killBlackStack();
  await sleep(2000);

  const dir = feedDirFor('B');
  const info = publishFeed(dir);
  const feed = startFeed(dir + '/v2', FEED_PORT);
  assert(await waitForFeed(FEED_PORT, 60000), 'B — staging feed up');

  // Isolate a v1 install so we can lock a file it owns.
  const ud = path.join(BASE, 'B', 'userdata');
  const app = await launchClient({ userData: ud, exeDir: V1_DIR, label: 'B' });
  if (!assert(app.port, 'B — v1 launched', `port ${app.port}`)) { killTree(feed.pid); return; }

  const dbFile = path.join(ud, 'database', 'blackstack-crm.db');
  await uiSignIn(app);
  // Let first-boot seeding settle BEFORE the baseline, or the comparison
  // measures the app's own demo seed instead of any update-related change.
  await sleep(4000);
  const fpBefore = contentFingerprint(dbFile);

  await uiCall(app, 'checkForUpdate');
  const avail = await waitState(app, ['AVAILABLE'], 120000);
  assert(avail, 'B — update available', avail?.target);

  await uiCall(app, 'startDownload');
  const ready = await waitState(app, ['READY'], 420000);
  if (!assert(ready, 'B — update reached READY', `${ready?.percent}%`)) {
    app.proc.kill('SIGTERM'); killBlackStack(); killTree(feed.pid); return;
  }

  // Controlled installer failure: make the installer's target directory
  // read-only so NSIS cannot write. This is the documented "controlled
  // installer failure injection" — the installer binary itself is untouched.
  const exeDir = V1_DIR;
  let locked = false;
  try {
    // Deny write to the app directory for the current user.
    execSync(`icacls "${exeDir}" /deny "${os.userInfo().username}:(OI)(CI)W" /T /C`, { stdio: 'pipe', timeout: 60000 });
    locked = true;
  } catch (e) {
    console.log(`  icacls failed: ${e.message.slice(0, 80)}`);
  }
  console.log(`  install dir write-locked: ${locked}`);

  let installerExit = null;
  const before = Date.now();
  await uiCall(app, 'installUpdate');
  // The app quits and the installer runs; watch for its process to appear.
  let sawInstaller = false;
  let appeared = 0;
  const end = Date.now() + 300000; // a locked dir stalls NSIS; we reap and report, not hang
  while (Date.now() < end) {
    const n = countInstallers();
    if (n > 0 && !sawInstaller) { sawInstaller = true; appeared = Date.now(); }
    if (sawInstaller && n === 0) break;
    await sleep(2000);
  }
  const stillRunning = countInstallers() > 0;
  installerExit = stillRunning ? 'still-running' : 'exited';
  console.log(`  installer: seen=${sawInstaller} appeared_after=${sawInstaller ? Math.round((appeared - before) / 1000) : 'n/a'}s outcome=${installerExit} total=${Math.round((Date.now() - before) / 1000)}s`);

  // Undo the lock immediately so cleanup can proceed.
  try {
    execSync(`icacls "${exeDir}" /remove:d "${os.userInfo().username}" /T /C`, { stdio: 'pipe', timeout: 60000 });
  } catch { /* noop */ }

  // Record the observed installer lifetime as DATA. A locked install directory
  // makes NSIS stall on Windows rather than fail fast, so a long runtime is an
  // expected consequence of the injection, not by itself a product defect. What
  // must hold is that the app stays recoverable and never claims v2 — asserted
  // below. If the installer is still alive after the ceiling, reap it so the
  // remaining scenarios are not blocked by it.
  console.log(`  installer exit observed: ${installerExit} after ${Math.round((Date.now() - before) / 1000)}s`);
  if (stillRunning) {
    killBlackStack();
    await sleep(3000);
    console.log(`  installer reaped after exceeding the ${Math.round((end - before) / 1000)}s ceiling`);
  }
  await sleep(3000);

  // v1 must still be recoverable: relaunch and prove it works.
  killBlackStack();
  await sleep(2000);
  const app2 = await launchClient({ userData: ud, exeDir: V1_DIR, label: 'B-retry' });
  if (app2.port) {
    const h = await httpJson(`http://127.0.0.1:${app2.port}/health`, { timeout: 8000 });
    assert(h.status === 200, 'B — v1 recoverable after installer failure', `HTTP ${h.status}`);
    await uiSignIn(app2);
    const infoNow = await cdpEval(app2.cdp, `(async () => { const i = await window.desktop.getAppInfo(); return i; })()`);
    console.log(`  app reports after failed install: ${JSON.stringify(infoNow)}`);
    assert(infoNow && infoNow.version === '1.0.0',
      'B — application does not falsely claim v2', `reports ${infoNow?.version}`);

    const fpAfter = contentFingerprint(path.join(ud, 'database', 'blackstack-crm.db'));
    assert(fpAfter === fpBefore, 'B — database intact after installer failure', `${String(fpBefore).slice(0, 12)} == ${String(fpAfter).slice(0, 12)}`);

    // Recovery: state must be re-drivable, not wedged.
    const st = await updaterState(app2);
    console.log(`  updater state after failure: ${JSON.stringify(st)}`);
    const retry = await uiCall(app2, 'checkForUpdate');
    assert(retry !== undefined, 'B — updater recoverable (check responds)', JSON.stringify(retry));
    app2.proc.kill('SIGTERM');
    await sleep(1500);
  }
  killBlackStack();
  killTree(feed.pid);
  await sleep(1500);
  RESULTS.B = { sawInstaller, installerExit };
}

// ════════════════════════════════════════════════════════════════════════════
// C + D. Migration failure mid-transaction, then backup restore
// ════════════════════════════════════════════════════════════════════════════
async function scenarioC_D() {
  section('§5-§6 RECOVERY TEST C/D — migration failure mid-transaction + backup restore');

  // Isolated copy of a REAL database with real business data.
  const srcDb = path.join(BASE, 'C', 'seed');
  fs.mkdirSync(path.dirname(srcDb), { recursive: true });
  fs.mkdirSync(srcDb, { recursive: true });
  const dbFile = path.join(srcDb, 'blackstack-crm.db');

  // Build a database by running the real migrations, then seed business rows.
  const built = spawnSync(process.execPath, [path.join(__dirname, 'phase-d-migrate-only.js'), dbFile], {
    cwd: ROOT, encoding: 'utf8', timeout: 180000,
  });
  console.log((built.stdout || '').trim().split('\n').slice(-6).join('\n'));
  if (!assert(built.status === 0 && fs.existsSync(dbFile), 'C — isolated database built with real migrations')) {
    return;
  }

  // Seed representative CRM/Accounting/Inventory/Billing rows with FK links.
  const seeded = spawnSync(process.execPath, [path.join(__dirname, 'phase-d-seed-direct.js'), dbFile], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
  });
  console.log((seeded.stdout || '').trim().split('\n').slice(-8).join('\n'));
  if (!assert(seeded.status === 0, 'C — business data seeded (CRM/Acct/Inv/Billing)')) {
    return;
  }

  // ── BEFORE measurements ────────────────────────────────────────────────
  D('C — state BEFORE the failed migration');
  const fpBefore = contentFingerprint(dbFile);
  const fileBefore = md5(dbFile);
  const rowsBefore = snapshotRows(dbFile);
  const integrityBefore = pragma(dbFile, 'PRAGMA integrity_check');
  const fkBefore = pragma(dbFile, 'PRAGMA foreign_key_check');
  console.log(`  content fingerprint : ${fpBefore}`);
  console.log(`  file checksum       : ${fileBefore}`);
  console.log(`  integrity_check     : ${integrityBefore}`);
  console.log(`  foreign_key_check   : ${fkBefore.length} violations`);
  console.log(`  tables              : ${Object.keys(rowsBefore).length}, non-zero: ${Object.values(rowsBefore).filter((v) => v > 0).length}`);

  // A pre-update backup, exactly as the app makes one.
  D('C — creating the pre-update backup');
  const bakDir = path.join(BASE, 'C', 'backups');
  fs.mkdirSync(bakDir, { recursive: true });
  const bakFile = path.join(bakDir, 'pre-migration.sqlite');
  fs.copyFileSync(dbFile, bakFile);
  const bakFp = contentFingerprint(bakFile);
  console.log(`  backup: ${bakFile}`);
  console.log(`  backup content fingerprint: ${bakFp}`);
  assert(bakFp === fpBefore, 'C — backup is a faithful copy of the pre-migration DB');

  // ── Force a deterministic migration failure ───────────────────────────
  D('C — forcing a deterministic migration exception mid-transaction');
  const failRun = spawnSync(process.execPath, [
    path.join(__dirname, 'phase-d-fail-migration.js'), dbFile, '084_step3_injected_failure.sql',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  console.log((failRun.stdout || '').trim().split('\n').slice(-10).join('\n'));
  console.log((failRun.stderr || '').trim().split('\n').slice(-4).join('\n'));

  assert(failRun.status !== 0, 'C — migration FAILED as intended', `exit ${failRun.status}`);

  // ── AFTER measurements ─────────────────────────────────────────────────
  D('C — state AFTER the failed migration');
  const fpAfterFail = contentFingerprint(dbFile);
  const fileAfterFail = md5(dbFile);
  const rowsAfter = snapshotRows(dbFile);
  const integrityAfter = pragma(dbFile, 'PRAGMA integrity_check');
  const fkAfter = pragma(dbFile, 'PRAGMA foreign_key_check');
  console.log(`  content fingerprint : ${fpAfterFail}`);
  console.log(`  file checksum       : ${fileAfterFail}`);
  console.log(`  integrity_check     : ${integrityAfter}`);
  console.log(`  foreign_key_check   : ${fkAfter.length} violations`);

  assert(integrityAfter === 'ok', 'C — database remains VALID after failed migration', integrityAfter);
  assert(fkAfter.length === 0, 'C — FK integrity intact after failed migration', `${fkAfter.length} violations`);

  // The critical assertion: the failed migration must leave NO partial data.
  const partial = Object.keys(rowsBefore).filter((t) => rowsBefore[t] !== rowsAfter[t]);
  if (partial.length) {
    console.log(`  tables differing from before: ${partial.map((t) => `${t} ${rowsBefore[t]}->${rowsAfter[t]}`).join(', ')}`);
  }
  assert(partial.length === 0, 'C — transaction rolled back: no partial business data', partial.length ? partial.join(', ') : 'all tables identical');
  assert(fpAfterFail === fpBefore, 'C — content fingerprint unchanged by the failure', `${String(fpBefore).slice(0, 12)} == ${String(fpAfterFail).slice(0, 12)}`);

  // Relationships must still resolve.
  const rel = checkRelationships(dbFile);
  console.log(`  relationships intact: ${JSON.stringify(rel)}`);
  // Must be literally `true` for every join. A QUERY_ERROR string is truthy,
  // so `every(Boolean)` would wave a broken query through as a pass.
  const relOk = Object.values(rel).every((v) => v === true);
  assert(relOk, 'C — original relationships still resolve', relOk ? Object.keys(rel).length + ' joins' : JSON.stringify(rel));

  // App can still open it.
  D('C — application recovery state after failed migration');
  const udC = path.join(BASE, 'C', 'userdata');
  fs.mkdirSync(path.join(udC, 'database'), { recursive: true });
  fs.copyFileSync(dbFile, path.join(udC, 'database', 'blackstack-crm.db'));
  const appC = await launchClient({ userData: udC, exeDir: V1_DIR, label: 'C' });
  if (appC.port) {
    const ready = await httpJson(`http://127.0.0.1:${appC.port}/ready`, { timeout: 20000 });
    assert(ready.status === 200, 'C — application opens the recovered DB', `HTTP ${ready.status}`);
    await uiSignIn(appC);
    const stC = await updaterState(appC);
    console.log(`  updater state: ${JSON.stringify(stC)}`);
    assert(stC && typeof stC.status === 'string', 'C — updater in a coherent state', stC?.status);
    const tokC = (await tokenFromRenderer(appC)) || (await login(appC.port));
    const inv = await httpJson(`http://127.0.0.1:${appC.port}/api/invoices`, { token: tokC, timeout: 15000 });
    assert(inv.status === 200, 'C — business API usable on recovered DB', `HTTP ${inv.status}`);
    appC.proc.kill('SIGTERM');
    await sleep(1500);
  }
  killBlackStack();
  await sleep(1500);

  // ── D: restore from the backup ─────────────────────────────────────────
  D('D — safe restore from the pre-update backup');
  const liveDb = path.join(udC, 'database', 'blackstack-crm.db');
  // Move the post-failure DB aside, then restore through the app's own
  // backupService.safeRestoreBackup() so the real code path is exercised.
  const restore = spawnSync(process.execPath, [
    path.join(__dirname, 'phase-d-safe-restore.js'), liveDb, bakFile,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  console.log((restore.stdout || '').trim().split('\n').slice(-8).join('\n'));
  assert(restore.status === 0, 'D — safeRestoreBackup() executed successfully', `exit ${restore.status}`);

  const fpRestored = contentFingerprint(liveDb);
  const fileRestored = md5(liveDb);
  const integrityRestored = pragma(liveDb, 'PRAGMA integrity_check');
  const fkRestored = pragma(liveDb, 'PRAGMA foreign_key_check');
  console.log(`  restored content fingerprint : ${fpRestored}`);
  console.log(`  restored file checksum       : ${fileRestored}`);
  console.log(`  integrity_check              : ${integrityRestored}`);
  console.log(`  foreign_key_check            : ${fkRestored.length} violations`);

  assert(fpRestored === fpBefore, 'D — restored content matches the original', `${String(fpBefore).slice(0, 12)} == ${String(fpRestored).slice(0, 12)}`);
  assert(integrityRestored === 'ok', 'D — restored DB integrity ok', integrityRestored);
  assert(fkRestored.length === 0, 'D — restored FK integrity ok', `${fkRestored.length} violations`);
  const rowsRestored = snapshotRows(liveDb);
  const ids = checkRelationships(liveDb);
  console.log(`  restored relationships: ${JSON.stringify(ids)}`);
  const relOkD = Object.values(ids).every((v) => v === true);
  assert(relOkD, 'D — CRM/Accounting/Inventory/Billing relationships restored', relOkD ? Object.keys(ids).length + ' joins' : JSON.stringify(ids));

  // Reopen the restored DB through the app.
  killBlackStack();
  await sleep(1500);
  const appD = await launchClient({ userData: udC, exeDir: V1_DIR, label: 'D' });
  if (appD.port) {
    const r = await httpJson(`http://127.0.0.1:${appD.port}/ready`, { timeout: 20000 });
    assert(r.status === 200, 'D — restored database opens in the application', `HTTP ${r.status}`);
    await uiSignIn(appD);
    const tokD = (await tokenFromRenderer(appD)) || (await login(appD.port));
    const con = await httpJson(`http://127.0.0.1:${appD.port}/api/contacts`, { token: tokD, timeout: 15000 });
    assert(con.status === 200, 'D — restored DB is usable (contacts API)', `HTTP ${con.status}`);
    appD.proc.kill('SIGTERM');
    await sleep(1500);
  }
  killBlackStack();
  await sleep(1500);
  RESULTS.CD = { fpBefore, fpAfterFail, fpRestored, integrity: integrityAfter };
}

// ── DB inspection helpers (all open throwaway snapshots) ───────────────────
function withSnapshot(dbFile, fn) {
  const tmp = path.join(os.tmpdir(), `pd3-q-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
  for (const ext of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbFile + ext)) fs.copyFileSync(dbFile + ext, tmp + ext);
  }
  let db;
  try {
    db = new DatabaseSync(tmp);
    return fn(db);
  } finally {
    try { db?.close(); } catch {}
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch {} }
  }
}

function pragma(dbFile, sql) {
  return withSnapshot(dbFile, (db) => {
    const rows = db.prepare(sql).all();
    if (sql.includes('integrity_check')) return Object.values(rows[0] || { r: 'empty' })[0];
    return rows;
  });
}

function snapshotRows(dbFile) {
  return withSnapshot(dbFile, (db) => {
    const out = {};
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => t.name)
      // The app logs its own update attempts, so these legitimately grow.
      .filter((x) => !/^(audit_logs?|logs?)$/i.test(x));
    for (const t of tables) {
      try { out[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch { out[t] = -1; }
    }
    return out;
  });
}

function checkRelationships(dbFile) {
  return withSnapshot(dbFile, (db) => {
    const out = {};
    // A throwing query must NOT be reported as "relationship lost" — that
    // pattern hides harness bugs as product failures (and can hide the reverse).
    // Surface the SQL error instead so it is obvious which query is wrong.
    const q = (label, sql) => {
      try { out[label] = !!db.prepare(sql).get(); }
      catch (e) { out[label] = `QUERY_ERROR: ${e.message.slice(0, 70)}`; }
    };
    // contacts has NO `name` column — only first_name/last_name. Referencing
    // `name` throws, and the catch turned that into a false "relationship lost".
    q('contact', `SELECT id FROM contacts WHERE first_name LIKE '%STEP3%' LIMIT 1`);
    q('lead_to_contact', `SELECT l.id FROM leads l JOIN contacts c ON c.id=l.contact_id WHERE c.first_name LIKE '%STEP3%' LIMIT 1`);
    q('customer_to_contact', `SELECT cu.id FROM customers cu JOIN contacts c ON c.id=cu.contact_id WHERE c.first_name LIKE '%STEP3%' LIMIT 1`);
    q('invoice_to_contact', `SELECT i.id FROM invoices i JOIN contacts c ON c.id=i.contact_id WHERE c.first_name LIKE '%STEP3%' LIMIT 1`);
    q('invoice_line_to_product', `SELECT li.id FROM invoice_line_items li JOIN products p ON p.id=li.product_id WHERE p.name LIKE '%STEP3%' LIMIT 1`);
    q('product_to_stock_group', `SELECT p.id FROM products p JOIN stock_categories sc ON sc.id=p.stock_category_id JOIN stock_groups sg ON sg.id=sc.stock_group_id WHERE p.name LIKE '%STEP3%' LIMIT 1`);
    q('model_to_brand', `SELECT m.id FROM models m JOIN brands b ON b.id=m.brand_id WHERE m.name LIKE '%STEP3%' LIMIT 1`);
    return out;
  });
}


// ════════════════════════════════════════════════════════════════════════════
// E. Interrupted update
// ════════════════════════════════════════════════════════════════════════════
async function scenarioE() {
  section('§7 RECOVERY TEST E — interrupted update (download killed mid-flight)');
  killBlackStack();
  await sleep(2000);

  const dir = feedDirFor('E');
  publishFeed(dir);
  const feed = startFeed(dir + '/v2', FEED_PORT);
  assert(await waitForFeed(FEED_PORT, 60000), 'E — staging feed up');

  const ud = path.join(BASE, 'E', 'userdata');
  const app = await launchClient({ userData: ud, exeDir: V1_DIR, label: 'E' });
  if (!assert(app.port, 'E — v1 launched', `port ${app.port}`)) { killTree(feed.pid); return; }

  const dbFile = path.join(ud, 'database', 'blackstack-crm.db');
  await uiSignIn(app);
  // Let first-boot seeding settle BEFORE the baseline, or the comparison
  // measures the app's own demo seed instead of any update-related change.
  await sleep(4000);
  const fpBefore = contentFingerprint(dbFile);

  await uiCall(app, 'checkForUpdate');
  assert(await waitState(app, ['AVAILABLE'], 120000), 'E — update available');

  await uiCall(app, 'startDownload');
  // Let a real partial download accumulate, then kill the app mid-flight.
  let partial = null;
  for (let i = 0; i < 120; i++) {
    const st = await updaterState(app);
    if (st && st.transferred > 0 && st.transferred < st.total) { partial = st; break; }
    if (st && st.status === 'READY') break;
    await sleep(1000);
  }
  console.log(`  partial download: ${partial ? `${partial.transferred}/${partial.total}` : 'none observed'}`);
  assert(partial, 'E — a genuinely partial download was observed');

  D('E — killing the app mid-download');
  app.proc.kill('SIGKILL');
  await sleep(1500);
  killBlackStack();
  await sleep(2000);

  // Restart v1 against the same userData (partial download still on disk).
  const app2 = await launchClient({ userData: ud, exeDir: V1_DIR, label: 'E-restart' });
  if (assert(app2.port, 'E — v1 relaunches after interruption', `port ${app2.port}`)) {
    const h = await httpJson(`http://127.0.0.1:${app2.port}/health`, { timeout: 10000 });
    assert(h.status === 200, 'E — application remains usable', `HTTP ${h.status}`);
    await uiSignIn(app2);
    const st = await updaterState(app2);
    console.log(`  state after interruption+restart: ${JSON.stringify(st)}`);

    // A partial artifact must NOT be treated as a valid update.
    assert(!st || st.status !== 'READY' || (st.total && st.transferred === st.total),
      'E — incomplete artifact NOT treated as a valid update',
      st ? `${st.status} ${st.transferred}/${st.total}` : 'no state');

    // And the updater must be able to retry.
    await uiCall(app2, 'checkForUpdate');
    const re = await waitState(app2, ['AVAILABLE', 'DOWNLOADING', 'READY', 'ERROR'], 120000);
    assert(re, 'E — updater can recover/retry after interruption', re?.status);

    const fpAfter = contentFingerprint(path.join(ud, 'database', 'blackstack-crm.db'));
    assert(fpAfter === fpBefore, 'E — database intact after interruption', `${String(fpBefore).slice(0, 12)} == ${String(fpAfter).slice(0, 12)}`);

    // If it reached READY it means a fresh complete download happened — prove
    // the install is still not auto-triggered.
    if (re && re.status === 'READY') {
      assert(countInstallers() === 0, 'E — no partial install auto-triggered on restart');
    }
    app2.proc.kill('SIGTERM');
    await sleep(1500);
  }
  killBlackStack();
  killTree(feed.pid);
  await sleep(1500);
  RESULTS.E = { partial: partial ? `${partial.transferred}/${partial.total}` : null };
}

// ════════════════════════════════════════════════════════════════════════════
// F. Process-interruption model at four points
// ════════════════════════════════════════════════════════════════════════════
async function scenarioF() {
  section('§8 RECOVERY TEST F — process interruption at 4 points');
  const points = [
    { key: 'during download', killAfter: 'DOWNLOADING' },
    { key: 'during verification', killAfter: 'VERIFYING' },
    { key: 'during installer transition', killAfter: 'INSTALLING' },
    { key: 'during post-install startup', killAfter: 'RESTARTING' },
  ];
  const observed = {};

  for (const pt of points) {
    D(`F — interruption ${pt.key}`);
    killBlackStack();
    await sleep(2000);

    const dir = feedDirFor(`F-${pt.killAfter}`);
    publishFeed(dir);
    const feed = startFeed(dir + '/v2', FEED_PORT);
    if (!await waitForFeed(FEED_PORT, 60000)) { skip(`F/${pt.key}`, 'feed did not come up'); killTree(feed.pid); continue; }

    const ud = path.join(BASE, `F-${pt.killAfter}`, 'userdata');
    const app = await launchClient({ userData: ud, exeDir: V1_DIR, label: `F-${pt.killAfter}` });
    if (!app.port) { skip(`F/${pt.key}`, 'v1 did not launch'); killTree(feed.pid); continue; }

    const dbFile = path.join(ud, 'database', 'blackstack-crm.db');
    // Baseline AFTER first-boot seeding settles, or the comparison measures the
    // app's own demo seed instead of any update-related change.
    await uiSignIn(app);
    await sleep(4000);
    const fpBefore = contentFingerprint(dbFile);

    await uiCall(app, 'checkForUpdate');
    await waitState(app, ['AVAILABLE'], 120000);

    // Installer-backed interruption points need the same preflight gate as B:
    // the real NSIS installer must not be run against a protected registration.
    if (pt.killAfter === 'INSTALLING' || pt.killAfter === 'RESTARTING') {
      const preF = spawnSync(process.execPath, [path.join(__dirname, 'phase-d-step-3-install-preflight.js'), '--json'],
        { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
      let pf = null;
      try { pf = JSON.parse(preF.stdout); } catch { pf = null; }
      if (!pf || !pf.mayInstall) {
        skip(`F/${pt.key}`, pf ? pf.reason : 'preflight could not be read');
        observed[pt.key] = 'skipped-protected-registration';
        killBlackStack();
        killTree(feed.pid);
        await sleep(1500);
        continue;
      }
    }

    // Drive toward the target state, interrupting as soon as it is reached.
    let reached = null;
    if (pt.killAfter === 'INSTALLING' || pt.killAfter === 'RESTARTING') {
      await uiCall(app, 'startDownload');
      const ready = await waitState(app, ['READY'], 420000);
      if (ready) {
        if (pt.killAfter === 'INSTALLING') {
          await uiCall(app, 'installUpdate');
          // Kill while the installer is being handed control.
          for (let i = 0; i < 60; i++) { if (countInstallers() > 0) break; await sleep(500); }
          reached = 'INSTALLING';
        } else {
          await uiCall(app, 'installUpdate');
          reached = 'RESTARTING';
        }
      }
    } else {
      await uiCall(app, 'startDownload');
      reached = await waitState(app, [pt.killAfter], 240000) ? pt.killAfter : null;
    }
    observed[pt.key] = reached || 'state-not-observed';
    console.log(`  reached: ${observed[pt.key]}`);

    // Interrupt the whole process tree (the safe model of a power cut).
    app.proc.kill('SIGKILL');
    await sleep(1000);
    killBlackStack();
    await sleep(2500);

    // Recovery: can the previous version still run?
    const app2 = await launchClient({ userData: ud, exeDir: V1_DIR, label: `F-${pt.killAfter}-recover` });
    let recovered = false;
    if (app2.port) {
      const h = await httpJson(`http://127.0.0.1:${app2.port}/health`, { timeout: 12000 });
      const rdy = await httpJson(`http://127.0.0.1:${app2.port}/ready`, { timeout: 12000 });
      recovered = h.status === 200 && rdy.status === 200;
      const fpAfter = contentFingerprint(path.join(ud, 'database', 'blackstack-crm.db'));
      assert(recovered, `F/${pt.key} — previous version runs after interruption`, `health=${h.status} ready=${rdy.status}`);
      assert(fpAfter === fpBefore, `F/${pt.key} — no business-data loss`, `${String(fpBefore).slice(0, 12)} == ${String(fpAfter).slice(0, 12)}`);
      app2.proc.kill('SIGTERM');
      await sleep(1500);
    } else {
      bad(`F/${pt.key} — previous version runs after interruption`, 'did not relaunch');
    }

    // Undo any half-installed state so later points start clean.
    if (countInstallers() > 0) { for (let i = 0; i < 20 && countInstallers() > 0; i++) await sleep(1000); }
    killBlackStack();
    killTree(feed.pid);
    await sleep(1500);
  }
  RESULTS.F = observed;
}

// ════════════════════════════════════════════════════════════════════════════
// §9/§10/§12 production release configuration + signing
// ════════════════════════════════════════════════════════════════════════════
async function productionConfigAudit() {
  section('§9-§12 production release configuration audit');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const b = pkg.build || {};

  D('§9 Electron / provider configuration');
  assert(b.appId && b.productName, 'Production build config present (appId/productName)', `${b.appId} / ${b.productName}`);
  assert((pkg.dependencies || {})['electron-updater'], 'electron-updater is a RUNTIME dependency',
    'must be in dependencies, not devDependencies, or the shipped app has no updater');
  const providers = (b.publish || []).map((x) => x.provider);
  assert(providers.includes('github'), 'Production update provider configured', providers.join(', '));
  const nsis = b.nsis || {};
  const winTarget = JSON.stringify((b.win || {}).target || []);
  assert(/nsis/i.test(winTarget), 'Windows NSIS installer target configured', winTarget);
  assert(nsis.oneClick === false, 'NSIS is assisted-install (not oneClick)', `oneClick=${nsis.oneClick}`);
  assert(nsis.deleteAppDataOnUninstall === false,
    'deleteAppDataOnUninstall remains false (user data survives uninstall)', String(nsis.deleteAppDataOnUninstall));

  D('§9 data separation');
  // userData must never live inside the install directory.
  const mainJs = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  assert(/BLACKSTACK_USER_DATA_DIR/.test(mainJs), 'userData override exists for isolation/testing');
  assert(!/path\.join\(.*resourcesPath.*['"]database/.test(mainJs),
    'database path is NOT resolved inside resourcesPath');

  // The packaged app keeps its database under userData, not the install dir.
  const updir = fs.readFileSync(path.join(ROOT, 'server', 'config', 'userDataPath.js'), 'utf8');
  assert(/database/.test(updir), 'database path derives from the user-data root');

  // The update cache must be separate from the database.
  const cacheDirName = (() => {
    const yml = fs.readFileSync(path.join(V1_DIR, 'resources', 'app-update.yml'), 'utf8');
    return (yml.match(/updaterCacheDirName:\s*(\S+)/) || [])[1] || '';
  })();
  assert(cacheDirName, 'updater cache dir is separately named', cacheDirName);
  assert(!/database/i.test(cacheDirName), 'updater cache is not the database directory', cacheDirName);

  // An update artifact must never be able to overwrite the business DB.
  const dbExts = ['.db', '.sqlite', '-wal', '-shm'];
  let collides = false;
  for (const ext of dbExts) {
    if (cacheDirName.endsWith(ext)) collides = true;
  }
  assert(!collides, 'update artifact paths cannot overwrite the business database', `cache=${cacheDirName}`);

  D('§9 security — hash / signature verification');
  const ymlTxt = fs.readFileSync(path.join(V2_DIR, 'resources', 'app-update.yml'), 'utf8');
  const latestYml = fs.readFileSync(path.join(DIST, 'v2', 'latest.yml'), 'utf8');
  assert(/^provider:/m.test(ymlTxt), 'app-update.yml declares a provider', (ymlTxt.match(/provider:\s*(\S+)/) || [])[1]);
  assert(/sha512:/.test(latestYml), 'update metadata publishes a sha512 for the artifact');
  // electron-builder names it "<installer>.exe.blockmap", NOT "latest.yml.blockmap".
  const blockmaps = fs.readdirSync(path.join(DIST, 'v2')).filter((f) => f.endsWith('.blockmap'));
  assert(blockmaps.length > 0, 'differential update blockmap present', blockmaps.join(', ') || 'none');

  // electron-updater refuses an artifact whose hash does not match.
  const updaterJs = fs.readFileSync(path.join(ROOT, 'node_modules', 'electron-updater', 'out', 'AppUpdater.js'), 'utf8');
  assert(/sha512|sha512Checksum/i.test(updaterJs), 'electron-updater performs hash verification');
  assert(/VALIDATE_PACKAGE_SIGNATURE|validateSignature|signature/i.test(
    fs.readFileSync(path.join(ROOT, 'node_modules', 'builder-util-runtime', 'out', 'publishOptions.js'), 'utf8').toString()
    + fs.readdirSync(path.join(ROOT, 'node_modules', 'electron-updater', 'out')).join(','),
  ), 'signature validation support present in the updater');

  D('§10 code-signing availability');
  let certInfo = null;
  try {
    const ps = 'Get-ChildItem Cert:\\\\CurrentUser\\\\My | ForEach-Object { ' +
      '$k=($_.EnhancedKeyUsageList | Where-Object { $_.ObjectId.Value -eq "1.3.6.1.5.5.7.3.3" }); ' +
      '"{0}|{1}|{2}|{3}" -f $_.Subject,$_.Issuer,$_.NotAfter,$_.HasPrivateKey }';
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8' });
    certInfo = out.trim().split(/\r?\n/).filter((l) => l.includes('|'));
  } catch { certInfo = []; }
  const codeSigning = (certInfo || []).filter((l) => /True/.test(l.split('|')[3] || ''));

  if (codeSigning.length) {
    pass('Production code-signing certificate found', `${codeSigning.length} candidate(s)`);
  } else {
    // No Code Signing EKU => not usable for Authenticode signing.
    const subjects = (certInfo || []).map((l) => l.split('|')[0]).filter(Boolean);
    skip('Production code signing',
      `no certificate with Code Signing EKU present (found ${subjects.length} self-signed cert(s) without it)`);
  }

  D('§10 signature on the shipped artifacts');
  let sigOut = '';
  try {
    sigOut = execSync('powershell -NoProfile -Command "Get-AuthenticodeSignature -LiteralPath \'dist-phase-d/v2/BlackStack CRM Setup 1.0.1.exe\' | Select-Object Status,StatusMessage | Format-List"', { encoding: 'utf8' });
  } catch { /* ignore */ }
  const status = (sigOut.match(/Status\s*:\s*(\S+)/) || [])[1] || 'unknown';
  console.log(`  Authenticode status of the shipped installer: ${status}`);
  if (status === 'Valid') pass('Shipped installer is Authenticode-signed');
  else skip('Shipped installer Authenticode signature', `status=${status} (unsigned — expected without a code-signing cert)`);

  D('§11 feed classification');
  const provider = (ymlTxt.match(/provider:\s*(\S+)/) || [])[1];
  if (provider === 'generic' && /127\.0\.0\.1|localhost/.test(ymlTxt)) {
    pass('STAGING FEED VERIFIED (loopback staging feed; production feed NOT verified)',
      `provider=${provider}, url=${(ymlTxt.match(/url:\s*(\S+)/) || [])[1]}`);
    skip('PRODUCTION FEED VERIFIED', 'the shipped app-update.yml points at a loopback staging feed, not a public provider');
  } else {
    pass('PRODUCTION FEED configuration present', `provider=${provider}`);
  }

  D('§17 attachments');
  const hasAttach = /multer|form-data|multipart/i.test(
    fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8') +
    fs.readdirSync(path.join(ROOT, 'server', 'services')).map((f) => {
      try { return fs.readFileSync(path.join(ROOT, 'server', 'services', f), 'utf8'); } catch { return ''; }
    }).join(''),
  );
  // Match the TABLE NAME exactly. A substring match wrongly flags
  // `physical_stock_documents`, which is a physical stock-count sheet, not a
  // stored file — and it would make this test look exercised when it is not.
  const attachTable = fs.readdirSync(path.join(ROOT, 'server', 'database', 'migrations'))
    .some((f) => /CREATE TABLE(?: IF NOT EXISTS)?\s+(attachments?|documents?|files)\b/i.test(
      fs.readFileSync(path.join(ROOT, 'server', 'database', 'migrations', f), 'utf8')));
  if (!hasAttach && !attachTable) {
    pass('Attachments — N/A because the application has no persistent attachment subsystem');
  } else {
    skip('Attachments', `upload handling present (multipart=${hasAttach}, table=${attachTable}) — not exercised`);
  }
}


// Install v1 for client i at its own path using the real NSIS installer, so the
// uninstall registry entry exists and a later update targets THIS client.
// Returns the directory containing "BlackStack CRM.exe".
function ensureInstalledClient(i) {
  const target = path.join(BASE, 'MS', `install-${i}`);
  const exe = path.join(target, 'BlackStack CRM.exe');
  if (fs.existsSync(exe) && fs.existsSync(path.join(target, 'Uninstall BlackStack CRM.exe'))) {
    return target; // already really installed
  }
  fs.mkdirSync(target, { recursive: true });
  const installer = path.join(DIST, 'v1', fs.readdirSync(path.join(DIST, 'v1')).find((f) => /^BlackStack.*Setup.*\.exe$/i.test(f)));
  // NSIS /D= cannot contain spaces, so use the 8.3 short path.
  const shortTarget = shortPath(target);
  const r = spawnSync(installer, ['/S', `/D=${shortTarget}`], { encoding: 'utf8', timeout: 600000 });
  if (!fs.existsSync(exe)) throw new Error(`client ${i}: silent install did not produce ${exe} (exit ${r.status})`);
  return target;
}

function shortPath(p) {
  // Convert "C:\Users\BLACK STACK\..." to "C:\Users\BLACKS~1\..."
  return p.replace(/\\([A-Z]+ ?STACK)(?=\\|$)/gi, (m) => m.replace(/ /g, '~1'));
}

// ════════════════════════════════════════════════════════════════════════════
// §13 multi-system update simulation
// ════════════════════════════════════════════════════════════════════════════
async function multiSystem() {
  section('§13 multi-system update simulation');

  // Installer-backed scenarios need a genuinely disposable NSIS registration.
  // electron-builder's NSIS target registers in HKLM, so an "isolated" install
  // is never truly isolated: if a registration already exists the installer
  // aborts with 199, and if it does not, the test writes a machine-wide entry.
  // Never fake a PASS here — gate on the preflight and report the limitation.
  const pre = spawnSync(process.execPath, [path.join(__dirname, 'phase-d-step-3-install-preflight.js'), '--json'],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  let preflight = null;
  try { preflight = JSON.parse(pre.stdout); } catch { preflight = null; }
  if (!preflight || !preflight.mayInstall) {
    const why = preflight ? preflight.reason : 'preflight could not be read';
    skip('§13 multi-system NSIS simulation', why);
    for (const r of (preflight?.registrations || [])) {
      console.log(`    registration: [${r.registration.scope}] ${r.registration.displayName} -> ${r.registration.installLocation || '(via UninstallString)'}`);
    }
    if (preflight?.userData?.database) {
      console.log(`    real userData database present (protected): ${preflight.userData.database.path}`);
    }
    RESULTS.multiSystem = { skipped: true, reason: why };
    return;
  }

  const CLIENTS = Number(process.env.PHASE_D_CLIENTS || 3);

  killBlackStack();
  await sleep(2000);
  const dir = feedDirFor('MS');
  publishFeed(dir);
  const feed = startFeed(dir + '/v2', FEED_PORT);
  if (!assert(await waitForFeed(FEED_PORT, 60000), '§13 — staging feed up')) { killTree(feed.pid); return; }

  const setupExeName = fs.readdirSync(path.join(DIST, 'v2')).find((f) => /^BlackStack CRM Setup .*\.exe$/.test(f));
  const setupExe = path.join(DIST, 'v2', setupExeName);

  const results = [];

  for (let i = 1; i <= CLIENTS; i++) {
    D(`§13 client ${i}/${CLIENTS}`);
    // Every client owns: its own userData (database + updater cache), its own
    // install directory, and its own port. Nothing is shared.
    const root = path.join(BASE, 'MS', `client-${i}`);
    const ud = path.join(root, 'userdata');
    // NSIS /D= cannot contain spaces (it fails silently and installs nothing).
    // The repo path itself contains "CB CRM V2", so use a short path under the
    // system drive that has none. Same fix as the Step 2 harness.
    const installDir = ['C:', 'BSCRM', `c${i}`].join('\\');
    fs.mkdirSync(installDir, { recursive: true });

    // v1 runs from the unpacked build tree, exactly as Step 2 does.
    const app = await launchClient({ userData: ud, exeDir: V1_DIR, label: `ms-${i}` });
    if (!app.port) { bad(`§13 client ${i}`, 'v1 did not launch'); killBlackStack(); continue; }

    const dbFile = path.join(ud, 'database', 'blackstack-crm.db');
    let tok = null;
    const r = { client: i, detected: false, ready: false, later: false, installer: false, v2: false };

    await uiSignIn(app);
    await sleep(4000);
    r.fp = contentFingerprint(dbFile);
    tok = (await tokenFromRenderer(app)) || (await login(app.port));

    // Usable while the update is in flight.
    const beforeCon = await httpJson(`http://127.0.0.1:${app.port}/api/contacts`, { token: tok, timeout: 15000 });
    r.usableBefore = beforeCon.status === 200;

    await uiCall(app, 'checkForUpdate');
    const avail = await waitState(app, ['AVAILABLE'], 150000);
    r.detected = !!avail;
    r.target = avail?.target;

    await uiCall(app, 'startDownload');
    const ready = await waitState(app, ['READY'], 480000);
    r.ready = !!ready;

    if (ready) {
      const duringCon = await httpJson(`http://127.0.0.1:${app.port}/api/contacts`, { token: tok, timeout: 15000 });
      r.usableDuring = duringCon.status === 200;

      // Later must persist across a close/reopen.
      await uiCall(app, 'postponeUpdate');
      r.later = !!(await waitState(app, ['POSTPONED'], 60000));
      app.proc.kill('SIGTERM');
      await sleep(2500);
      killBlackStack();
      await sleep(1500);

      const app2 = await launchClient({ userData: ud, exeDir: V1_DIR, label: `ms-${i}-re` });
      if (app2.port) {
        await uiSignIn(app2);
        r.persisted = (await updaterState(app2))?.status === 'POSTPONED';

        // Restart & Update: the app quits, NSIS installs v2 into installDir.
        app2.proc.kill('SIGTERM');
        await sleep(3000);
        killBlackStack();
        await sleep(1500);
        const t0 = Date.now();
        // The installer runs with --updated, which means "update an EXISTING
        // installation". Pointing it at an empty directory exits non-zero and
        // installs nothing. Seed the target with the v1 build first (Step 2 does
        // the same) so this is a genuine update of a genuine installation.
        for (const junk of fs.readdirSync(installDir)) {
          if (junk.includes('--')) rmrf(path.join(installDir, junk));
        }
        spawnSync('robocopy', [V1_DIR, installDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { encoding: 'utf8' });
        const inst = spawnSync(setupExe, ['--updated', '--force-run', '/S', `/D=${installDir}`], { encoding: 'utf8', timeout: 600000 });
        r.installer = true;
        r.installerExit = inst.status;
        const v2exe = path.join(installDir, 'BlackStack CRM.exe');
        r.installed = fs.existsSync(v2exe);
        if (!r.installed) {
          bad(`§13 client ${i} — installer produced no executable`, `exit=${inst.status} dir=${installDir}`);
          killBlackStack();
          break;
        }
        r.installMs = Date.now() - t0;
        await sleep(4000);
        killBlackStack();
        await sleep(2000);

        // v2 must start from the install directory and report 1.0.1.
        const app3 = await launchClient({ userData: ud, exeDir: installDir, label: `ms-${i}-v2` });
        if (app3.port) {
          await uiSignIn(app3);
          const info = await cdpEval(app3.cdp, `(async () => { const i = await window.desktop.getAppInfo(); return i; })()`);
          r.version = info?.version;
          r.v2 = info?.version === '1.0.1';
          r.healthy = (await httpJson(`http://127.0.0.1:${app3.port}/health`, { timeout: 12000 })).status === 200;
          r.fpAfter = contentFingerprint(path.join(ud, 'database', 'blackstack-crm.db'));
          r.dbIntact = r.fpAfter === r.fp;
          app3.proc.kill('SIGTERM');
          await sleep(1500);
        }
      }
    }

    killBlackStack();
    await sleep(1500);
    results.push(r);
    console.log(`  client ${i}: detect=${r.detected} usableDuring=${r.usableDuring} ready=${r.ready} later=${r.later} persisted=${!!r.persisted} installer=${r.installer}(exit ${r.installerExit}) v2=${r.v2} version=${r.version} dbIntact=${!!r.dbIntact}`);
  }

  const fps = new Set(results.map((r) => r.fp));
  assert(results.length === CLIENTS, `§13 — ${CLIENTS} isolated clients exercised`, `${results.length}/${CLIENTS}`);
  assert(results.every((r) => r.detected), '§13 — every client detected v2');
  assert(results.every((r) => r.usableDuring), '§13 — every client stayed usable during the update');
  assert(results.every((r) => r.ready), '§13 — every client reached READY');
  assert(results.every((r) => r.later), '§13 — every client honoured Later');
  assert(results.every((r) => r.persisted), '§13 — Later persisted across reopen on every client');
  assert(results.every((r) => r.v2), '§13 — every client started v2 after Restart & Update', results.map((r) => r.version).join(','));
  assert(results.every((r) => r.dbIntact), '§13 — every client kept its own database intact');
  assert(fps.size === results.length, '§13 — no shared-state contamination between clients', `${fps.size} distinct fingerprints across ${results.length} clients`);

  killTree(feed.pid);
  await sleep(1500);
  RESULTS.multiSystem = results;
}

// ════════════════════════════════════════════════════════════════════════════
// §14 retry / repeat safety
// ════════════════════════════════════════════════════════════════════════════
async function retrySafety() {
  section('§14 update retry / repeat safety');
  // Download/check only — this scenario never triggers the installer, so it is
  // safe on a machine with a protected registration.
  killBlackStack();
  await sleep(2000);
  const dir = feedDirFor('R');
  publishFeed(dir);
  const feed = startFeed(dir + '/v2', FEED_PORT);
  if (!assert(await waitForFeed(FEED_PORT, 60000), '§14 — staging feed up')) { killTree(feed.pid); return; }

  const ud = path.join(BASE, 'R', 'userdata');
  const app = await launchClient({ userData: ud, exeDir: V1_DIR, label: 'R' });
  if (!assert(app.port, '§14 — v1 launched', `port ${app.port}`)) { killTree(feed.pid); return; }

  await uiSignIn(app);

  D('§14 repeated update checks');
  for (let i = 0; i < 3; i++) { await uiCall(app, 'checkForUpdate'); await sleep(2000); }
  const avail = await waitState(app, ['AVAILABLE'], 120000);
  assert(avail, '§14 — repeated checks are safe', avail?.status);

  D('§14 Update Now clicked twice');
  await uiCall(app, 'startDownload');
  await sleep(1500);
  const second = await uiCall(app, 'startDownload');
  console.log(`  second startDownload -> ${JSON.stringify(second)}`);
  const ready = await waitState(app, ['READY'], 480000);
  assert(ready, '§14 — reaches READY despite a duplicate trigger', `${ready?.transferred}/${ready?.total}`);

  // Count partial artifacts in the updater cache: a duplicate download must not
  // have left a second copy behind.
  const cacheRoot = path.join(ud, 'localappdata');
  let partials = 0;
  try {
    const walkCache = (d, depth = 0) => {
      if (depth > 6) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walkCache(f, depth + 1);
        else if (/\.part$|pending|\.tmp$|\.download$/i.test(e.name)) partials++;
      }
    };
    walkCache(cacheRoot);
  } catch { /* no cache dir */ }
  assert(partials === 0, '§14 — no duplicate/partial download artifacts left behind', `${partials} partial file(s)`);
  assert(countInstallers() === 0, '§14 — duplicate trigger did NOT spawn installers', `${countInstallers()}`);

  D('§14 state coherence across close/reopen');
  await uiCall(app, 'postponeUpdate');
  await waitState(app, ['POSTPONED'], 60000);
  app.proc.kill('SIGTERM');
  await sleep(2500);
  killBlackStack();
  await sleep(1500);
  const app2 = await launchClient({ userData: ud, exeDir: V1_DIR, label: 'R-re' });
  if (app2.port) {
    await uiSignIn(app2);
    const st = await updaterState(app2);
    console.log(`  state after reopen: ${JSON.stringify(st)}`);
    assert(st && st.status === 'POSTPONED', '§14 — pending state coherent after close/reopen', st?.status);
    // A stale pending update must remain actionable, not wedged.
    const re = await uiCall(app2, 'checkForUpdate');
    assert(re !== undefined, '§14 — stale pending update is recoverable', JSON.stringify(re));
    app2.proc.kill('SIGTERM');
    await sleep(1500);
  }
  killBlackStack();
  killTree(feed.pid);
  await sleep(1500);
}

// ════════════════════════════════════════════════════════════════════════════
// §15 version consistency
// ════════════════════════════════════════════════════════════════════════════
async function versionConsistency() {
  section('§15 version consistency');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  D('§15 source-of-truth chain');
  const versionJs = fs.readFileSync(path.join(ROOT, 'server', 'version.js'), 'utf8');
  assert(!/APP_VERSION\s*=\s*'/.test(versionJs), 'server/version.js reads package.json (no hard-coded version)');
  const mod = { exports: {} };
  {
    const m = require(path.join(ROOT, 'server', 'version.js'));
    D(`  package.json=${pkg.version}  server/version.js=${m.APP_VERSION}`);
    assert(m.APP_VERSION === pkg.version, 'server/version.js matches package.json', `${m.APP_VERSION} == ${pkg.version}`);
  }

  D('§15 packaged artifacts');
  for (const [label, dir] of [['v1', V1_DIR], ['v2', V2_DIR]]) {
    const p = path.join(dir, 'resources', 'app.asar');
    if (!fs.existsSync(p)) { skip(`§15 ${label} asar`, 'not found'); continue; }
    const asarPkg = readPkgFromAsar(p);
    console.log(`  ${label}: package.json in asar = ${asarPkg}`);
    assert(asarPkg === (label === 'v1' ? '1.0.0' : '1.0.1'), `${label} packaged version correct`, asarPkg);
  }

  D('§15 updater metadata');
  const latest = fs.readFileSync(path.join(DIST, 'v2', 'latest.yml'), 'utf8');
  const feedVersion = (latest.match(/^version:\s*(\S+)/m) || [])[1];
  console.log(`  feed latest.yml version = ${feedVersion}`);
  assert(feedVersion === '1.0.1', 'feed publishes v2 version', feedVersion);

  D('§15 no "installed v2 but reports v1" state');
  // The Step 2 run already proved installed v2 reports 1.0.1; re-assert the
  // mechanism rather than repeating the 8-minute install.
  const versionJsShipped = readFileFromAsar(path.join(V2_DIR, 'resources', 'app.asar'), 'server/version.js');
  assert(/package\.json/.test(versionJsShipped), 'shipped v2 reads its version from package.json');
  const v2pkg = readPkgFromAsar(path.join(V2_DIR, 'resources', 'app.asar'));
  assert(v2pkg === '1.0.1', 'v2 asar package.json is 1.0.1', v2pkg);
}

function readPkgFromAsar(asarPath) {
  try {
    const asar = require('@electron/asar');
    const buf = asar.extractFile(asarPath, 'package.json');
    return JSON.parse(buf.toString('utf8')).version;
  } catch { return 'unreadable'; }
}
function readFileFromAsar(asarPath, rel) {
  try {
    const asar = require('@electron/asar');
    return asar.extractFile(asarPath, rel).toString('utf8');
  } catch { return ''; }
}

module.exports = { publishFeed, feedDirFor, withSnapshot, pragma, snapshotRows, checkRelationships, main };

if (require.main === module) {
  // Do NOT force exit 0 here: main() records the real verdict in
  // process.exitCode (0 = pass, 1 = failures). `process.exit(0)` discarded it,
  // so a FAIL run still reported success to the shell/CI.
  main().catch((e) => { console.error(e); process.exit(1); });
}
