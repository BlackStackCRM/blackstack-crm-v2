/**
 * PHASE D STEP 1.5 — controlled write-path probe.
 *
 * Runs the application's own SQL against an ISOLATED COPY of the production
 * database and records the main-DB / -wal / -shm hashes at each stage, so every
 * physical file mutation can be attributed to a specific statement.
 *
 * Production is never opened for writing by this script: it only reads bytes to
 * make the copy.
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const crypto = require('crypto');

const dbPath = process.argv[2];
const stage = process.argv[3];

function h(p) {
  try { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex').slice(0, 12); }
  catch { return 'ABSENT'; }
}
function s(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}
function snap(tag) {
  return {
    stage: tag,
    db: h(dbPath), dbBytes: s(dbPath),
    wal: h(dbPath + '-wal'), walBytes: s(dbPath + '-wal'),
    shm: h(dbPath + '-shm'), shmBytes: s(dbPath + '-shm'),
  };
}

const out = [snap('T0 before')];

function withDb(fn) {
  const db = new DatabaseSync(dbPath);
  try { return fn(db); } finally { try { db.close(); } catch { /* already closed */ } }
}

// Which stage are we running?
switch (stage) {
  case 'connect':
    // Exactly server/database/connection.js connect()
    withDb((db) => {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA foreign_keys = ON');
      out.push({ ...snap('T1'), journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode });
    });
    break;

  case 'checkpoint':
    // Exactly backupService.js#checkpointWal()
    withDb((db) => { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); });
    out.push(snap('T2 after wal_checkpoint(TRUNCATE)'));
    break;

  case 'openclose':
    withDb(() => {});
    out.push(snap('T2 open+close only'));
    break;

  case 'read':
    withDb((db) => {
      const n = db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
      out.push({ note: 'read schema_migrations', value: n });
    });
    out.push(snap('T2 read-only query'));
    break;

  case 'integrity':
    withDb((db) => {
      const ic = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
      const fk = db.prepare('PRAGMA foreign_key_check').all().length;
      out.push({ integrity: ic, foreignKeyViolations: fk });
    });
    out.push(snap('T2 integrity_check + foreign_key_check'));
    break;

  case 'vacuum':
    withDb((db) => { db.exec('VACUUM'); });
    out.push(snap('T2 after VACUUM'));
    break;

  default:
    out.push({ error: 'unknown stage: ' + stage });
}

for (const o of out) console.log(JSON.stringify(o));
