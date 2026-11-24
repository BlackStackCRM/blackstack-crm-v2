/* Read-only runtime diagnostics for the shared SQLite database.
 * Prints no customer data — only counts and status strings. */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH
  || path.join(process.env.APPDATA, 'blackstack-crm-v2', 'data', 'blackstack-crm.db');

console.log('DB_PATH :', DB_PATH);
console.log('exists  :', fs.existsSync(DB_PATH));

if (!fs.existsSync(DB_PATH)) process.exit(1);

const stat = fs.statSync(DB_PATH);
console.log('size    :', stat.size);
console.log('readonly:', (stat.mode & 0o200) === 0 ? 'YES (write bit missing)' : 'no');

// WAL / SHM sidecar states
for (const suffix of ['-wal', '-shm']) {
  const p = DB_PATH + suffix;
  console.log(`${suffix.padEnd(8)}:`, fs.existsSync(p) ? fs.statSync(p).size + ' bytes' : 'absent');
}

let db;
try {
  db = new DatabaseSync(DB_PATH); // read/write open, no creation of a new file expected
} catch (e) {
  console.error('OPEN FAILED:', e.message);
  process.exit(2);
}

try {
  db.exec('PRAGMA busy_timeout = 5000');
  console.log('journal_mode after open:', JSON.stringify(db.prepare('PRAGMA journal_mode').get()));
  db.exec('PRAGMA journal_mode = WAL');
  console.log('journal_mode after WAL :', JSON.stringify(db.prepare('PRAGMA journal_mode').get()));

  const qc = db.prepare('PRAGMA quick_check').get();
  console.log('quick_check            :', JSON.stringify(qc));
  const ic = db.prepare('PRAGMA integrity_check').get();
  console.log('integrity_check        :', JSON.stringify(ic));
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  console.log('foreign_key_check rows :', fk.length);

  const objs = db.prepare('SELECT COUNT(*) n FROM sqlite_master').get();
  console.log('sqlite_master objects  :', objs.n);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  console.log('table names            :', JSON.stringify(tables.map((t) => t.name)));

  // Write test inside a rolled-back transaction — leaves no data change.
  db.exec('BEGIN IMMEDIATE');
  db.exec("CREATE TEMP TABLE __bs_diag_write_test (v TEXT)");
  db.prepare("INSERT INTO __bs_diag_write_test VALUES ('ok')").run();
  const got = db.prepare('SELECT v FROM __bs_diag_write_test').get();
  db.exec('ROLLBACK');
  console.log('write test (temp table):', got && got.v === 'ok' ? 'OK' : 'UNEXPECTED');

  console.log('RESULT: ALL CHECKS PASSED');
} catch (e) {
  console.error('CHECK FAILED:', e.message);
  try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
  process.exitCode = 3;
} finally {
  try { db.close(); } catch { /* already closed */ }
}
