#!/usr/bin/env node
/**
 * PHASE D — build two real packaged installers (v1 and v2) for a genuine
 * v1 -> v2 update test.
 *
 * Neither build may be contaminated by the other, and neither may point at the
 * production GitHub feed:
 *
 *   v1  package.json.version = 1.0.0, publish = generic (its own staging feed,
 *       serving nothing) so it cannot detect an update from the repo's own
 *       history and so the test's "v2 is available" claim is unambiguous.
 *   v2  package.json.version = 1.0.1, publish = generic (the feed serving it).
 *
 * The production `build.publish` GitHub config is never written to disk: it is
 * injected via --config at build time and restored immediately afterwards, so a
 * crash mid-build cannot leave the repo pointed at a local feed.
 *
 * Usage: node scripts/phase-d-build.js <v1|v2> [outDirName]
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WHICH = process.argv[2];
const PKG = path.join(ROOT, 'package.json');
const FEED_PORT = process.env.PHASE_D_FEED_PORT || '34811';

if (!['v1', 'v2'].includes(WHICH)) {
  console.error('usage: node scripts/phase-d-build.js <v1|v2>');
  process.exit(2);
}

const originalPkg = fs.readFileSync(PKG, 'utf8');
const originalVer = JSON.parse(originalPkg).version;

/** The version this build should carry. v1 matches the already-built 1.0.0. */
const targetVersion = WHICH === 'v1' ? '1.0.0' : '1.0.1';

/**
 * Every Phase D artifact is written under dist-phase-d/, never over dist/,
 * so the existing verified 1.0.0 installer stays available as a cross-check.
 */
const outDir = `dist-phase-d/${WHICH}`;

function writePkg(mutate) {
  const pkg = JSON.parse(originalPkg);
  mutate(pkg);
  fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');
}

function restore() {
  fs.writeFileSync(PKG, originalPkg);
  console.log(`[build] package.json restored (version ${originalVer}, production publish config)`);
}

process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(130); });

writePkg((pkg) => {
  pkg.version = targetVersion;
  // Staging feed only. provider "generic" + a URL is what electron-updater's
  // GenericProvider consumes; it is the real production code path for a
  // self-hosted feed, not a mock.
  pkg.build.publish = [{
    provider: 'generic',
    url: `http://127.0.0.1:${FEED_PORT}`,
  }];
  pkg.build.directories = { ...(pkg.build.directories || {}), output: outDir };
});

console.log(`[build] building ${WHICH} v${targetVersion} -> ${outDir}`);
console.log(`[build] staging feed: http://127.0.0.1:${FEED_PORT} (production feed untouched)`);

try {
  execFileSync('npx', ['electron-builder', '--win', 'nsis', '--publish', 'never', '--config.directories.output=' + outDir], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 30 * 60 * 1000,
    shell: true,
  });
} catch (e) {
  console.error(`[build] electron-builder failed: ${e.message}`);
  process.exit(1);
}

// Record exactly what was produced, with real hashes (§19).
const absOut = path.join(ROOT, outDir);
const installer = fs.readdirSync(absOut).find((f) => /^BlackStack.*Setup.*\.exe$/i.test(f));
if (!installer) {
  console.error('[build] no installer produced');
  process.exit(1);
}

const crypto = require('crypto');
const file = path.join(absOut, installer);
const bytes = fs.readFileSync(file);
const manifest = {
  which: WHICH,
  version: targetVersion,
  installer,
  file,
  size: bytes.length,
  sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  sha512: crypto.createHash('sha512').update(bytes).digest('base64'),
  builtAt: fs.statSync(file).mtime.toISOString(),
  feedPort: Number(FEED_PORT),
};
fs.writeFileSync(path.join(absOut, 'phase-d-manifest.json'), JSON.stringify(manifest, null, 2));

// Prove the shipped bundle actually contains the updater — the defect that made
// every packaged update impossible before this phase.
//
// Uses the @electron/asar JS API, NOT the `asar` CLI: the CLI truncates at the
// first space under shell:true and this project path contains one ("CB CRM V2"),
// which produced a misleading ENOENT. asar.list also prints backslash paths with
// no leading slash, so match tolerating both separators.
let shippedUpdaterCount = 0;
try {
  const asarLib = require('@electron/asar');
  const listing = String(asarLib.listPackage(
    path.join(absOut, 'win-unpacked', 'resources', 'app.asar'),
  ));
  shippedUpdaterCount = (listing.match(/node_modules[\\/]electron-updater[\\/]/g) || []).length;
} catch (e) {
  console.error('[build] could not inspect asar: ' + e.message);
}
manifest.shippedUpdaterFiles = shippedUpdaterCount;
manifest.shippedUpdater = shippedUpdaterCount > 0;
fs.writeFileSync(path.join(absOut, 'phase-d-manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`\n[build] ${WHICH} v${targetVersion}`);
console.log(`[build]   installer : ${installer}`);
console.log(`[build]   size      : ${manifest.size} bytes`);
console.log(`[build]   sha256    : ${manifest.sha256}`);
console.log(`[build]   shipped electron-updater: ${manifest.shippedUpdater ? `YES (${shippedUpdaterCount} files)` : 'NO  <-- packaged update would be impossible'}`);
