#!/usr/bin/env node
/**
 * Step 3 preflight — registered-installation guard.
 *
 * Electron-builder's NSIS target writes an HKLM uninstall registration. A
 * silent install invoked while such a registration exists aborts with exit 199,
 * because the installer sees an install already present.
 *
 * That means an "isolated" test install is NOT isolated: NSIS resolves the
 * registered install and writes to it. Before any Step 3 installer test runs,
 * this preflight must therefore find out who owns the registration.
 *
 * Classification:
 *   PROTECTED   — evidence of pre-existing user data or an unknown origin.
 *                 The harness must not touch it and must not install.
 *   DISPOSABLE  — the installed payload is byte-identical to a build this
 *                 harness produced AND no user data is associated with it.
 *
 * Usage: node scripts/phase-d-step-3-install-preflight.js [--json]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const V2_ASAR = path.join(ROOT, 'dist-phase-d', 'v2', 'win-unpacked', 'resources', 'app.asar');

const UNINSTALL_ROOTS = [
  ['HKLM', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'],
  ['HKLM64', 'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'],
  ['HKCU', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'],
];

function regQuery(key) {
  try {
    return execFileSync('reg', ['query', key, '/s'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

function sha256(f) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; }
}

/** Every registered BlackStack CRM uninstall entry, with its scope. */
function findRegistrations() {
  const found = [];
  for (const [scope, root] of UNINSTALL_ROOTS) {
    let listing = '';
    try { listing = execFileSync('reg', ['query', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch { continue; }
    const subkeys = [...listing.matchAll(/^HKEY_[^\r\n]+$/gm)].map((m) => m[0].trim());
    for (const k of subkeys) {
      const body = regQuery(k);
      const name = (body.match(/DisplayName\s+REG_SZ\s+(.+)/) || [])[1];
      if (!name || !/BlackStack/i.test(name)) continue;
      found.push({
        scope,
        key: k,
        displayName: name.trim(),
        displayVersion: ((body.match(/DisplayVersion\s+REG_SZ\s+(.+)/) || [])[1] || '').trim(),
        installLocation: ((body.match(/InstallLocation\s+REG_SZ\s+(.+)/) || [])[1] || '').trim(),
        uninstallString: ((body.match(/UninstallString\s+REG_SZ\s+(.+)/) || [])[1] || '').trim(),
        estimatedSize: ((body.match(/EstimatedSize\s+REG_DWORD\s+(.+)/) || [])[1] || '').trim(),
      });
    }
  }
  return found;
}

/** Does the registration point at a directory that exists, and what is in it? */
function inspectInstallDir(reg) {
  const loc = reg.installLocation || (reg.uninstallString.match(/^"([^"]+)"/) || [])[1] || '';
  const dir = loc ? path.dirname(loc) : '';
  const out = { installLocation: dir, exists: false, asarSha256: null, matchesOurV2Build: false, payloadTimestamps: [] };
  if (!dir || !fs.existsSync(dir)) return out;
  out.exists = true;

  const asar = path.join(dir, 'resources', 'app.asar');
  out.asarSha256 = sha256(asar);
  const ours = sha256(V2_ASAR);
  out.matchesOurV2Build = !!out.asarSha256 && out.asarSha256 === ours;

  // A payload copied from our build keeps OUR build timestamps; the directory
  // mtime only records when the copy happened. Comparing the two is what
  // separates "someone installed this long ago" from "a test copied it".
  try {
    for (const f of ['BlackStack CRM.exe', 'resources/app.asar']) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) {
        out.payloadTimestamps.push({ file: f, mtime: fs.statSync(p).mtime.toISOString() });
      }
    }
    out.dirMtime = fs.statSync(dir).mtime.toISOString();
    out.exeSha256 = sha256(path.join(dir, 'BlackStack CRM.exe'));
  } catch { /* partial */ }
  return out;
}

/** Per-user userData for this app — real user state, always protected. */
function inspectUserData() {
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'blackstack-crm-v2'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'BlackStack CRM'),
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    const db = path.join(c, 'database', 'blackstack-crm.db');
    let dbInfo = null;
    if (fs.existsSync(db)) {
      const st = fs.statSync(db);
      dbInfo = { path: db, size: st.size, mtime: st.mtime.toISOString(), md5: sha256(db) };
    }
    return { root: c, exists: true, database: dbInfo, hasBackups: fs.existsSync(path.join(c, 'backups')) };
  }
  return { root: null, exists: false, database: null, hasBackups: false };
}

function classify(regs) {
  if (!regs.length) return 'NONE';
  const details = regs.map((r) => ({ reg: r, info: inspectInstallDir(r) }));
  const userData = inspectUserData();

  // PROTECTED wins outright. Any real per-user userData on the machine means
  // there is user state a careless uninstall could destroy, even if the
  // registration itself looks harness-made.
  if (userData.exists && userData.database) return 'PROTECTED';

  // Otherwise the registration is disposable only if every one of its payloads
  // is byte-identical to a build this harness produced.
  const allOurs = details.every((d) => d.info.exists && d.info.matchesOurV2Build);
  return allOurs ? 'DISPOSABLE' : 'PROTECTED';
}

function main() {
  const regs = findRegistrations();
  const details = regs.map((r) => ({ registration: r, install: inspectInstallDir(r) }));
  const userData = inspectUserData();
  const classification = classify(regs);

  const report = {
    generatedAt: new Date().toISOString(),
    ourV2BuildAsarSha256: sha256(V2_ASAR),
    registrations: details,
    userData,
    classification,
    mayInstall: classification === 'NONE' || classification === 'DISPOSABLE',
    reason: {
      NONE: 'no registered BlackStack installation; an isolated install is safe',
      DISPOSABLE: 'every registered payload is byte-identical to a build this harness produced and no per-user userData database exists',
      PROTECTED: 'a registered install and/or real per-user userData exists; installing would overwrite or collide with it',
    }[classification],
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('='.repeat(72));
    console.log('STEP 3 PREFLIGHT — registered installation guard');
    console.log('='.repeat(72));
    console.log(`our v2 build asar sha256 : ${report.ourV2BuildAsarSha256}`);
    console.log(`registrations found     : ${details.length}`);
    for (const d of details) {
      console.log(`\n  [${d.registration.scope}] ${d.registration.displayName}  (${d.registration.displayVersion})`);
      console.log(`    registry key        : ${d.registration.key}`);
      console.log(`    InstallLocation     : ${d.registration.installLocation}`);
      console.log(`    UninstallString     : ${d.registration.uninstallString}`);
      console.log(`    dir exists          : ${d.install.exists}`);
      console.log(`    installed asar sha  : ${d.install.asarSha256}`);
      console.log(`    == our v2 build     : ${d.install.matchesOurV2Build}`);
      console.log(`    dir mtime           : ${d.install.dirMtime || 'n/a'}`);
      for (const t of d.install.payloadTimestamps) console.log(`    payload ${t.file}: ${t.mtime}`);
    }
    console.log(`\nper-user userData       : ${userData.exists ? userData.root : '(none)'}`);
    if (userData.database) {
      console.log(`  user database         : ${userData.database.path}`);
      console.log(`    size / mtime        : ${userData.database.size} bytes, ${userData.database.mtime}`);
      console.log(`    md5                 : ${userData.database.md5}`);
    }
    console.log(`\nCLASSIFICATION          : ${classification}`);
    console.log(`reason                 : ${report.reason}`);
    console.log(`may run installer tests: ${report.mayInstall}`);
  }

  // Hard gate: protected -> non-zero so no caller can proceed by accident.
  process.exitCode = report.mayInstall ? 0 : 3;
}

if (require.main === module) main();
module.exports = { findRegistrations, inspectInstallDir, inspectUserData, classify };
