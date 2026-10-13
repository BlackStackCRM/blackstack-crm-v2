#!/usr/bin/env node
/**
 * PHASE 2 — build the production update release (v1.0.1) WITHOUT mutating the
 * source tree's version.
 *
 * Mirrors scripts/phase-d-build.js's proven approach: stage a temporary copy of
 * package.json with the target version, build into an isolated output dir, then
 * restore. The source `package.json` must be byte-identical afterwards.
 *
 * This does NOT override build.publish — a production build must carry the real
 * production feed. (The Phase D harness deliberately overrode it to a loopback
 * staging feed; that is a test-only concern and is not used here.)
 *
 * Usage: node scripts/phase-2-build-release.js <version> <outDir>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');

const version = process.argv[2];
const outDir = path.resolve(process.argv[3] || '');
if (!version || !outDir) { console.error('usage: phase-2-build-release.js <version> <outDir>'); process.exit(2); }

const before = fs.readFileSync(PKG, 'utf8');
const beforeHash = crypto.createHash('sha256').update(before).digest('hex');
const original = JSON.parse(before);

console.log(`[phase2] target version : ${version}`);
console.log(`[phase2] output dir     : ${outDir}`);
console.log(`[phase2] source pkg sha : ${beforeHash.slice(0, 16)}`);
console.log(`[phase2] publish config : ${JSON.stringify(original.build?.publish)}`);

let built = false;
try {
  fs.rmSync(outDir, { recursive: true, force: true });

  // Stage the version bump on a TEMPORARY copy, leaving the source alone.
  const staged = { ...original, version };
  fs.writeFileSync(PKG, JSON.stringify(staged, null, 2) + '\n', 'utf8');
  console.log(`[phase2] staged version in package.json temporarily`);

  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
    '--win', 'nsis', '--publish', 'never',
    `--config.directories.output=${outDir}`,
  ], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true,
    env: process.env,
  });

  const out = (r.stdout || '') + (r.stderr || '');
  for (const l of out.split(/\r?\n/)) {
    if (/building\s+target=|blockMapFile|⨯|error|ERROR/i.test(l)) console.log(`  ${l.trim().slice(0, 160)}`);
  }
  built = r.status === 0 && fs.existsSync(outDir);
  console.log(`[phase2] electron-builder exit: ${r.status}`);
} finally {
  // ALWAYS restore the source package.json, whatever happened above.
  fs.writeFileSync(PKG, before, 'utf8');
  const afterHash = crypto.createHash('sha256').update(fs.readFileSync(PKG)).digest('hex');
  console.log(`[phase2] package.json restored: ${afterHash === beforeHash} (${afterHash.slice(0, 16)})`);
  if (afterHash !== beforeHash) {
    console.error('[phase2] FATAL: package.json was not restored correctly');
    process.exitCode = 3;
  }
}

// Post-build: the packaged feed config must be production, never staging.
if (built) {
  const auy = path.join(outDir, 'win-unpacked', 'resources', 'app-update.yml');
  if (fs.existsSync(auy)) {
    const txt = fs.readFileSync(auy, 'utf8');
    console.log('[phase2] packaged app-update.yml:');
    for (const l of txt.split('\n')) if (l.trim()) console.log(`    ${l}`);
    if (/127\.0\.0\.1|localhost/.test(txt)) {
      console.error('[phase2] FATAL: staging URL leaked into a production build');
      process.exitCode = 4;
    }
  }
  const asarPkg = (() => {
    try {
      const asar = require('@electron/asar');
      return JSON.parse(asar.extractFile(path.join(outDir, 'win-unpacked', 'resources', 'app.asar'), 'package.json')).version;
    } catch { return null; }
  })();
  console.log(`[phase2] packaged app.asar version: ${asarPkg}`);
  if (asarPkg !== version) {
    console.error(`[phase2] FATAL: packaged version ${asarPkg} != requested ${version}`);
    process.exitCode = 5;
  }
}

process.exitCode = built && !process.exitCode ? 0 : (process.exitCode || 1);
console.log(built ? '[phase2] build OK' : '[phase2] build FAILED');
