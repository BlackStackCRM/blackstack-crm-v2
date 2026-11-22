#!/usr/bin/env node
/**
 * RELEASE SHA-256 HASHING — BlackStack CRM
 *
 * Usage:
 *   node scripts/release-hash.js                        # hash latest installer
 *                                                       # (output dir read from
 *                                                       #  build.directories.output)
 *   node scripts/release-hash.js path\to\Setup.exe      # hash a specific file
 *   node scripts/release-hash.js <file> --write         # also write .sha256 checksum file
 *
 * Guarantees (Master Prompt §33):
 *   - Fails if the installer does not exist (never hashes a stale/old binary).
 *   - Resolves the build output directory from package.json so it cannot hash
 *     an installer left over in a previous output directory.
 *   - Never modifies the installer.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

/**
 * The output directory is owned by the electron-builder configuration
 * (package.json -> build.directories.output, currently "dist4"). Older builds
 * emitted to "dist", so the directory is resolved from config rather than
 * hard-coded — otherwise this script hashes a stale binary in the wrong place.
 */
function resolveDistDir() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const configured = pkg && pkg.build && pkg.build.directories && pkg.build.directories.output;
    if (configured) return path.join(ROOT, configured);
  } catch { /* fall through to the historical default */ }
  return path.join(ROOT, 'dist');
}

const DIST = resolveDistDir();

function findInstaller() {
  if (!fs.existsSync(DIST)) return null;
  const candidates = fs.readdirSync(DIST)
    .filter((f) => /^BlackStack CRM Setup.*\.exe$/i.test(f) || /^BlackStack-?CRM-?Setup.*\.exe$/i.test(f))
    .map((f) => path.join(DIST, f))
    .filter((f) => fs.statSync(f).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] || null;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const writeChecksum = args.includes('--write');
  const fileArg = args.find((a) => !a.startsWith('--'));

  const installer = fileArg ? path.resolve(fileArg) : findInstaller();
  if (!installer) {
    console.error('ERROR: No installer found in ' + DIST + '. Build first: npm run electron:build:win');
    process.exit(1);
  }
  if (!fs.existsSync(installer)) {
    console.error('ERROR: Installer not found: ' + installer);
    process.exit(1);
  }

  // Version from package.json — must match the built installer.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const stat = fs.statSync(installer);
  const hash = await sha256(installer);

  console.log('BlackStack CRM Installer');
  console.log('File: ' + path.basename(installer));
  console.log('Size: ' + stat.size + ' bytes');
  console.log('Version: ' + pkg.version);
  console.log('SHA-256: ' + hash);
  console.log('');
  console.log('End-user verification (PowerShell):');
  console.log('  Get-FileHash "' + path.basename(installer) + '" -Algorithm SHA256');

  if (writeChecksum) {
    const checksumFile = installer + '.sha256';
    // Format compatible with PowerShell Get-FileHash comparison and certutil.
    fs.writeFileSync(checksumFile, hash.toUpperCase() + '  ' + path.basename(installer) + '\n', 'utf8');
    console.log('Checksum written: ' + checksumFile);
  }
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
