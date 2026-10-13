#!/usr/bin/env node
/**
 * Installer verification script (npm run release:verify-installer).
 *
 * Verifies that the generated installer in dist/ matches expectations:
 *   - exists
 *   - SHA-256 is stable across two reads (no partial write)
 *   - portable executable header (MZ) present
 *   - NSIS installer magic present (Nullsoft)
 *   - file size is non-trivial
 *
 * Exit 0 = verified. Any problem = non-zero with a clear message.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIST = path.join(__dirname, '..', 'dist');

function findInstaller() {
  const candidates = fs.readdirSync(DIST)
    .filter((f) => /setup.*\.exe$/i.test(f))
    .map((f) => path.join(DIST, f))
    .filter((f) => fs.statSync(f).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] || null;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fail(msg) { console.error('VERIFY-FAIL:', msg); process.exit(1); }

const installer = findInstaller();
if (!installer) fail('No installer found in dist/ (expected *Setup*.exe). Run: npm run electron:build:win');

const stat = fs.statSync(installer);
if (stat.size < 1_000_000) fail(`Installer suspiciously small (${stat.size} bytes): ${path.basename(installer)}`);

const fd = fs.openSync(installer, 'r');
const header = Buffer.alloc(2);
fs.readSync(fd, header, 0, 2, 0);
if (header.toString('ascii') !== 'MZ') fail('File does not start with the Windows PE header (MZ).');
fs.closeSync(fd);

// NSIS installers contain the Nullsoft magic.
const raw = fs.readFileSync(installer);
if (!raw.includes('Nullsoft')) fail('NSIS "Nullsoft" marker not found — not an NSIS installer?');

// Hash twice: stable checksum proves the file is not mid-write.
const h1 = sha256(installer);
const h2 = sha256(installer);
if (h1 !== h2) fail('SHA-256 unstable between reads — file may be mid-write.');

console.log('VERIFY-PASS:', path.basename(installer));
console.log('  size:', stat.size, 'bytes');
console.log('  sha256:', h1);
process.exit(0);
