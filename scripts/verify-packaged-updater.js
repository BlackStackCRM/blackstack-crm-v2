/**
 * Read-only check: does a packaged build actually ship electron-updater?
 *
 * Written as a FILE rather than an inline `node -e` because the check has to
 * survive three levels of shell quoting on Windows. Inline versions of this
 * check disagreed with each other purely because of escaping:
 * `npx asar list` prints `node_modules\electron-updater\...` (backslash, no
 * leading slash), so a forward-slash matcher reports 0 on a build that does
 * contain the module. This version counts both separators and prints the
 * evidence so a wrong answer is visible rather than silent.
 *
 * Usage: node scripts/verify-packaged-updater.js <distPhaseDSubdir> [...]
 */
const fs = require('fs');
const path = require('path');
// Use the @electron/asar JS API, never the `asar` CLI.
//
// The CLI truncates at the first space when invoked with shell:true, and this
// project path contains a space ("CB CRM V2"). That silently produced ENOENT on
// "D:\...\CB" — which an earlier inline check misread as "the module is absent"
// even though the build did contain it. Reading the archive in-process has no
// quoting hazard at all.
const asarLib = require('@electron/asar');

const ROOT = path.resolve(__dirname, '..');
const targets = process.argv.slice(2);
if (!targets.length) targets.push('v1', 'v2');

let allOk = true;

for (const which of targets) {
  const asar = path.join(ROOT, 'dist-phase-d', which, 'win-unpacked', 'resources', 'app.asar');
  console.log(`\n=== ${which} ===`);
  console.log(`  asar: ${asar}`);

  if (!fs.existsSync(asar)) {
    console.log('  MISSING — build not present');
    allOk = false;
    continue;
  }

  let listing = '';
  try {
    listing = asarLib.listPackage(asar);
  } catch (e) {
    console.log('  ERROR reading asar: ' + String(e.message).slice(0, 160));
    allOk = false;
    continue;
  }

  // listPackage returns the ENTIRE archive as ONE comma-joined string, not one
  // entry per line, so split on a comma character literal. No regex: a character
  // class containing CR/LF gets written as literal newlines by some editors and
  // silently breaks the file.
  const NL = String.fromCharCode(10);
  const entries = String(listing)
    .split(',')
    .flatMap((chunk) => chunk.split(NL))
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter(Boolean);

  // Match tolerating either separator and an optional leading slash.
  const updaterRe = /(^|[\\/])node_modules[\\/]electron-updater[\\/]/;
  const nmRe = /(^|[\\/])node_modules[\\/]/;
  const updaterFiles = entries.filter((l) => updaterRe.test(l));
  const totalNodeModules = entries.filter((l) => nmRe.test(l)).length;

  console.log('  total node_modules entries : ' + totalNodeModules);
  console.log('  electron-updater entries   : ' + updaterFiles.length);
  if (updaterFiles.length) {
    console.log('  sample                     : ' + updaterFiles.slice(0, 3).join(' | ').slice(0, 160));
  }

  // Also confirm the runtime entry point and its deps are present, since a
  // partial copy would still fail at require() time.
  const needs = [
    /node_modules[\\/]electron-updater[\\/]out[\\/]main\.js/,
    /node_modules[\\/]electron-updater[\\/]package\.json/,
    /node_modules[\\/]builder-util-runtime[\\/]/,
    /node_modules[\\/]lazy-val[\\/]/,
  ];
  for (const re of needs) {
    const hit = entries.some((l) => re.test(l));
    console.log(`  ${hit ? 'OK     ' : 'MISSING'} ${re.source}`);
    if (!hit) allOk = false;
  }

  const ok = updaterFiles.length > 0;
  console.log(`  => packaged updater ${ok ? 'PRESENT' : 'ABSENT'}`);
  if (!ok) allOk = false;
}

console.log(`\n${allOk ? 'RESULT: both builds ship a usable electron-updater.' : 'RESULT: at least one build CANNOT self-update.'}`);
process.exit(allOk ? 0 : 1);
