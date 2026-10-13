const asar = require('@electron/asar');
const fs = require('fs');

const clean = (e) => e.replace(/^[/\\]+/, '');

let allOk = true;
for (const tag of ['v1', 'v2']) {
  const p = `dist-phase-d/${tag}/win-unpacked/resources/app.asar`;
  if (!fs.existsSync(p)) { console.log(`${tag}: NO BUILD`); allOk = false; continue; }

  const files = asar.listPackage(p);
  const bs = asar.extractFile(p, clean(files.find((f) => /backupService\.js$/.test(f)))).toString('utf8');
  const mig = asar.extractFile(p, clean(files.find((f) => /db-migration\.js$/.test(f)))).toString('utf8');

  const verEntry = files.find((f) => /server[\\\/]version\.js$/.test(f));
  const ver = asar.extractFile(p, clean(verEntry)).toString('utf8');

  const checks = {
    'snapshotWalDatabase exists': bs.includes('function snapshotWalDatabase'),
    'createBackup snapshots (no checkpointWal(src))': !bs.includes('checkpointWal(src)'),
    'checkpointWal folds a copy': /fs\.copyFileSync\(dbPath, workDb\)/.test(bs),
    'verifyBackup read-only': bs.includes('new DatabaseSync(backupFile, { readOnly: true })'),
    'safeRestore probe read-only': bs.includes('new DatabaseSync(live, { readOnly: true })'),
    'db-migration source read-only': mig.includes('new DatabaseSync(source, { readOnly: true })'),
    'db-migration verifyDb read-only': mig.includes('new DatabaseSync(dbPath, { readOnly: true })'),
    // Phase D Step 2: the version must come from package.json, not a literal.
    'version reads package.json': ver.includes('readPackageVersion'),
    'no hard-coded APP_VERSION literal': !/const APP_VERSION = '1\.0\.0'/.test(ver),
  };

  console.log(`${tag}:`);
  for (const [k, v] of Object.entries(checks)) {
    console.log(`   ${v ? 'OK  ' : 'MISS'} ${k}`);
    if (!v) allOk = false;
  }
}

console.log();
console.log(allOk ? 'BOTH PACKAGES SHIP THE STEP 1.5 FIX' : 'PACKAGES STILL MISS THE FIX');
process.exit(allOk ? 0 : 1);
