#!/usr/bin/env node
/**
 * PHASE D STEP 1.5 — verify the fix on the REAL migration path.
 *
 * Step 1 of this investigation proved that `createBackup({ sourcePath })` mutated
 * the source database, because backupService#checkpointWal ran
 * `PRAGMA wal_checkpoint(TRUNCATE)` on it. electron/db-migration.js
 * #migratePortableDatabase calls exactly that with the user's portable DB.
 *
 * This script reproduces the REAL migration against an isolated copy and asserts
 * the portable (source) database is byte-identical afterwards.
 *
 * Production is only READ, to make the copy.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROD_DB = path.join(ROOT, 'data', 'blackstack-crm.db');
const WORK = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'phase-d-1-5-verify');

function h(p) {
  try { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); }
  catch { return 'ABSENT'; }
}
function state(dbPath) {
  const o = { db: h(dbPath) };
  for (const s of ['-wal', '-shm']) o[s.replace('-', '')] = h(dbPath + s);
  return o;
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'portable'), { recursive: true });
fs.mkdirSync(path.join(WORK, 'userdata'), { recursive: true });

// The isolated "portable" database: a copy of production content.
const PORTABLE = path.join(WORK, 'portable', 'blackstack-crm.db');
for (const s of ['', '-wal', '-shm']) {
  if (fs.existsSync(PROD_DB + s)) fs.copyFileSync(PROD_DB + s, PORTABLE + s);
}

const TARGET = path.join(WORK, 'userdata', 'database', 'blackstack-crm.db');

console.log('PHASE D STEP 1.5 — real migration path, source immutability');
console.log('portable (source) :', PORTABLE);
console.log('migration target  :', TARGET);
console.log();

const before = state(PORTABLE);
console.log('source BEFORE:', JSON.stringify(before));

// Run the ACTUAL application migration function in a child process, with an
// isolated userData dir, so no production path is involved.
const runner = path.join(__dirname, '_pd15_migrate.js');
fs.writeFileSync(runner, `
const path = require('path');
const { migratePortableDatabase } = require(${JSON.stringify(path.join(ROOT, 'electron', 'db-migration.js'))});
const target = process.argv[2];
const portable = process.argv[3];
// findPortableDb() honours PORTABLE_DB_PATH unconditionally, so pointing it at
// our isolated copy is how the real function is steered away from production.
process.env.PORTABLE_DB_PATH = portable;
const result = migratePortableDatabase({
  targetPath: target,
  log: (m) => console.log('  [migration]', m),
});
console.log('RESULT ' + JSON.stringify(result));
`);

const out = execFileSync(process.execPath, [runner, TARGET, PORTABLE], {
  encoding: 'utf8', cwd: ROOT, env: { ...process.env, BLACKSTACK_USER_DATA_DIR: path.join(WORK, 'userdata') },
});
console.log(out.trim());
console.log();

const after = state(PORTABLE);
console.log('source AFTER :', JSON.stringify(after));
console.log();

const unchanged = before.db === after.db && before.wal === after.wal && before.shm === after.shm;
console.log('SOURCE BYTE-IDENTICAL AFTER REAL MIGRATION:', unchanged ? 'YES' : 'NO');

// The migration must still have worked.
let migrated = false;
try { migrated = fs.existsSync(TARGET) && fs.statSync(TARGET).size > 0; } catch { /* noop */ }
console.log('MIGRATION PRODUCED A DATABASE:', migrated ? 'YES' : 'NO');

if (migrated) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(TARGET);
  try {
    const ic = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
    const fk = db.prepare('PRAGMA foreign_key_check').all().length;
    const mig = db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v;
    console.log('TARGET integrity:', ic, '| fk violations:', fk, '| max migration:', mig);
  } finally { db.close(); }
}

// The backup the migration made must verify.
const bdir = path.join(WORK, 'userdata', 'backups');
if (fs.existsSync(bdir)) {
  const svc = require(path.join(ROOT, 'server', 'services', 'backupService.js'));
  for (const f of fs.readdirSync(bdir).filter((x) => x.endsWith('.sqlite'))) {
    const full = path.join(bdir, f);
    const chk = svc.verifyBackup(full);
    console.log(`BACKUP ${f}: valid=${chk.valid}${chk.valid ? '' : ' :: ' + chk.errors.join('; ')}`);
  }
}

try { fs.unlinkSync(runner); } catch { /* noop */ }

console.log();
console.log(unchanged && migrated ? 'RESULT: PASS — migration works and the source is untouched'
                                  : 'RESULT: FAIL');
process.exit(unchanged && migrated ? 0 : 1);
