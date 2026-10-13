#!/usr/bin/env node
/**
 * Verify that the updater-related source files are unchanged relative to the
 * shipped v2 asar.
 *
 * The Step 3 report has to state, with evidence, that this Phase 1 change touched
 * ONLY the seed/data layer. This compares each file's bytes in the package
 * against the working tree. `seed.js` is expected to DIFFER (it is the fix);
 * every updater file must be SAME.
 *
 * Usage: node scripts/phase-d-frozen-check.js
 */
const asar = require('@electron/asar');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ASAR = path.join(ROOT, 'dist-phase-d', 'v2', 'win-unpacked', 'resources', 'app.asar');

// The updater subsystem that Phase D verified and Phase 1 must not disturb.
const FROZEN = [
  'server/services/updateState.js',
  'server/services/updateService.js',
  'server/services/backupService.js',
  'electron/main.js',
  'electron/preload.js',
  'electron/db-migration.js',
  'public/js/pages/settings.js',
  'public/js/api/update.js',
];

// Expected to differ: this is the fix.
const EXPECTED_CHANGES = [
  'server/database/seed.js',
];

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);

// asar.listPackage returns backslash-separated keys with a leading backslash.
// extractFile wants them with EVERY leading separator stripped — the same
// normalisation scripts/verify-build-has-db-fix.js uses.
const clean = (e) => e.replace(/^[/\\]+/, '');
const pkgFiles = asar.listPackage(ASAR);
function shippedBytes(rel) {
  const base = rel.split('/').pop();
  const entry = pkgFiles.find((f) => clean(f).split('\\').join('/') === rel)
    || pkgFiles.find((f) => clean(f).endsWith(base));
  if (!entry) throw new Error(`not packaged: ${rel}`);
  return asar.extractFile(ASAR, clean(entry));
}

let unexpected = 0, expected = 0, missing = 0;

console.log('FROZEN (must be identical to the shipped v2 package):');
for (const rel of FROZEN) {
  const live = path.join(ROOT, rel);
  if (!fs.existsSync(live)) { console.log(`  MISSING  ${rel}`); missing++; continue; }
  let s;
  try { s = sha(shippedBytes(rel)); }
  catch (e) { console.log(`  NOTPKG   ${rel}  (${e.message.slice(0, 40)})`); continue; }
  const l = sha(fs.readFileSync(live));
  const ok = s === l;
  if (!ok) unexpected++;
  console.log(`  ${ok ? 'SAME  ' : 'CHANGED'}  ${rel.padEnd(38)} ${ok ? s : `shipped=${s} source=${l}`}`);
}

console.log('\nEXPECTED TO DIFFER (the Phase 1 fix):');
for (const rel of EXPECTED_CHANGES) {
  const live = path.join(ROOT, rel);
  let s = null;
  try { s = sha(shippedBytes(rel)); } catch { /* not packaged */ }
  const l = fs.existsSync(live) ? sha(fs.readFileSync(live)) : null;
  const differs = !s || s !== l;
  if (differs) expected++;
  console.log(`  ${differs ? 'DIFFERS' : 'UNCHANGED'}  ${rel.padEnd(38)} ${differs ? `shipped=${s} source=${l}` : ''}`);
}

console.log(`\nfrozen files changed : ${unexpected}   (must be 0)`);
console.log(`expected changes seen: ${expected} / ${EXPECTED_CHANGES.length}`);
console.log(`missing files        : ${missing}`);

process.exitCode = unexpected === 0 && expected === EXPECTED_CHANGES.length ? 0 : 1;
