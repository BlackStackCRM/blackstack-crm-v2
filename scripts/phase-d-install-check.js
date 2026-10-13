/**
 * PHASE D — §12 completion check.
 *
 * The packaged v1 reached INSTALLING and electron-updater really did spawn the
 * v2 NSIS installer (verified by observing the process). The install itself
 * then waits at the assisted-installer wizard, because this app is built with
 * `nsis.oneClick = false` and electron-updater passes `isSilent = false`.
 * Driving a click-through installer wizard is not something this harness can do
 * reliably headlessly, so this script runs the SAME installer electron-updater
 * would spawn, with the silent flag it would pass for a one-click build, and
 * then asserts the resulting installation.
 *
 * What this does and does not prove is stated explicitly in the report: it
 * proves the artifact installs over v1 and produces a runnable v2; it does not
 * prove the interactive wizard's own UI.
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const V1_DIR = path.join(ROOT, 'dist-phase-d', 'v1', 'win-unpacked');
const V2_DIR = path.join(ROOT, 'dist-phase-d', 'v2');
const INSTALL_ROOT = path.join(process.env.LOCALAPPDATA || '', 'Temp', 'phase-d-install');
const TARGET = path.join(INSTALL_ROOT, 'BlackStack CRM');

const args = process.argv.slice(2);
const silent = !args.includes('--ui');
// The directory we seed v1 into, install over, and then VERIFY must be the same
// variable. Reading TARGET here while installing to --dir= made the checker
// assert against a stale tree and report "NOT v2" for a successful install.
const requestedDir = (args.find((a) => a.startsWith('--dir=')) || '').slice(6);
const installDir = requestedDir ? path.resolve(requestedDir) : TARGET;

function sh(cmd, a) {
  try { return execFileSync(cmd, a, { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}

console.log('mode        :', silent ? 'silent (/S) — unattended install' : 'interactive wizard');
console.log('install dir :', installDir);
fs.rmSync(installDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(installDir), { recursive: true });

// 1. Copy the v1 "installed" tree, so we are genuinely installing OVER v1.
// Remove leftovers from earlier runs with the wrong argument order.
for (const junk of fs.readdirSync(INSTALL_ROOT)) {
  if (junk.includes('--') || /force-run/i.test(junk)) {
    console.log('removing mangled dir from a previous run:', junk);
    fs.rmSync(path.join(INSTALL_ROOT, junk), { recursive: true, force: true });
  }
}

const cp = spawnSync('robocopy', [V1_DIR, installDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { encoding: 'utf8' });
void cp;
console.log('v1 tree in place :', fs.existsSync(path.join(installDir, 'BlackStack CRM.exe')));

const installer = fs.readdirSync(V2_DIR).find((f) => /^BlackStack CRM Setup .*\.exe$/.test(f));
const installerPath = path.join(V2_DIR, installer);
console.log('installer        :', installer);

// electron-updater's args for this build: --updated and /D=<dir>, plus
// --force-run so the app relaunches.
//
// NSIS requires /D= to be the LAST argument and unquoted. When anything follows
// it, /D swallows the remaining tokens as part of the path — an earlier version
// of this script put --force-run after /D=, so NSIS silently installed to a
// directory literally named "BlackStack CRM --force-run S" and left the real
// target untouched while still exiting 0.
const a = ['--updated', '--force-run'];
if (silent) a.push('/S');
a.push(`/D=${installDir}`);
console.log('installer args   :', a.join(' '));

const t0 = Date.now();
const r = spawnSync(installerPath, a, { encoding: 'utf8', timeout: 600000 });
console.log('installer exit   :', r.status, `(${Math.round((Date.now() - t0) / 1000)}s)`);
if (r.error) console.log('installer error  :', r.error.message);

// 2. What got installed?
const targetExe = path.join(installDir, 'BlackStack CRM.exe');
const asar = path.join(installDir, 'resources', 'app.asar');
console.log('\n--- result ---');
console.log('app exe present  :', fs.existsSync(targetExe));
console.log('app.asar present :', fs.existsSync(asar));

// 3. Read the installed version straight out of the shipped bundle. Do NOT
//    grep the installer binary for "1.0.1": that string also occurs inside
//    unrelated byte sequences, so a substring search reports a match that does
//    not mean the payload carries v2.
let version = null;
if (fs.existsSync(asar)) {
  try {
    const asarLib = require('@electron/asar');
    version = JSON.parse(asarLib.extractFile(asar, 'package.json').toString()).version;
  } catch (e) { console.log('version read err :', e.message); }
}
console.log('installed version:', version);

// 4. Prove the payload is genuinely v2 by comparing the installed asar against
//    the one electron-builder produced for v2, byte for byte.
const srcAsar = path.join(ROOT, 'dist-phase-d', 'v2', 'win-unpacked', 'resources', 'app.asar');
let sameAsV2 = null;
if (fs.existsSync(asar) && fs.existsSync(srcAsar)) {
  const crypto = require('crypto');
  const h = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  sameAsV2 = h(asar) === h(srcAsar);
  console.log('asar == v2 build :', sameAsV2 ? 'YES (byte-identical)' : `NO (installed ${h(asar).slice(0, 16)} vs v2 ${h(srcAsar).slice(0, 16)})`);
}

const ok = version === '1.0.1' && sameAsV2 === true;
console.log('\nVERDICT          :', ok ? 'v2 installed over v1 - PASS' : 'NOT v2 - investigate');
process.exit(ok ? 0 : 1);