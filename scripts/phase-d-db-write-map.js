#!/usr/bin/env node
/**
 * PHASE D STEP 1.5 — database write-path investigation.
 *
 * Builds an ISOLATED copy of the production database, gives it a PENDING WAL
 * (the realistic state after the app has run and closed without checkpointing),
 * then runs each application code path against it and records the main-DB /
 * -wal / -shm hashes at every stage.
 *
 * Production is only ever READ (byte copy). Nothing here writes to
 * data/blackstack-crm.db.
 *
 * Usage: node scripts/phase-d-db-write-map.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROD_DB = path.join(ROOT, 'data', 'blackstack-crm.db');
const PROBE = path.join(__dirname, 'phase-d-db-write-probe.js');
const WORK = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'phase-d-db-write-map');

function h(p) {
  try { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex').slice(0, 12); }
  catch { return 'ABSENT'; }
}
function sz(p) { try { return fs.statSync(p).size; } catch { return 0; } }

function snapshot(label) {
  const row = {
    label,
    db: h(WORK + '/db.sqlite'), dbBytes: sz(WORK + '/db.sqlite'),
    wal: h(WORK + '/db.sqlite-wal'), walBytes: sz(WORK + '/db.sqlite-wal'),
    shm: h(WORK + '/db.sqlite-shm'), shmBytes: sz(WORK + '/db.sqlite-shm'),
  };
  return row;
}

function copyProduction() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  for (const s of ['', '-wal', '-shm']) {
    const p = PROD_DB + s;
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(WORK, 'db.sqlite' + s));
  }
}

function runStage(stage) {
  const out = execFileSync(process.execPath, [PROBE, path.join(WORK, 'db.sqlite'), stage],
    { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  return out.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
}

/**
 * Hold a PENDING (un-checkpointed) WAL open.
 *
 * Closing the last SQLite connection auto-checkpoints and deletes the -wal, so a
 * pending WAL only exists while another connection keeps the file open. That is
 * exactly the real condition: the running app holds the DB open, and
 * backupService#checkpointWal opens a SECOND connection to the same file.
 *
 * Returns a keep-alive handle so the frames stay in the -wal for the probe.
 */
let _keepAlive = null;
function makePendingWal() {
  const { DatabaseSync } = require('node:sqlite');
  const p = path.join(WORK, 'db.sqlite');
  const db = new DatabaseSync(p);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA wal_autocheckpoint = 0');   // never fold automatically
  db.exec('CREATE TABLE IF NOT EXISTS phase_d_probe(id INTEGER PRIMARY KEY, note TEXT)');
  db.exec("INSERT INTO phase_d_probe(note) VALUES ('pending-wal-payload')");
  _keepAlive = db;                            // deliberately NOT closed
  return [{ keepAliveOpen: true, note: 'pending frames held in -wal' }];
}

function closeKeepAlive() {
  if (_keepAlive) { try { _keepAlive.close(); } catch { /* already closed */ } _keepAlive = null; }
}

function logicalFingerprint() {
  const { DatabaseSync } = require('node:sqlite');
  const p = path.join(WORK, 'db.sqlite');
  const db = new DatabaseSync(p);
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const counts = {};
    for (const t of tables) {
      try { counts[t.name] = db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get().c; }
      catch { counts[t.name] = 'ERR'; }
    }
    return {
      integrity: Object.values(db.prepare('PRAGMA integrity_check').get())[0],
      fkViolations: db.prepare('PRAGMA foreign_key_check').all().length,
      maxMigration: db.prepare('SELECT MAX(version) v FROM schema_migrations').get()?.v ?? null,
      tableCount: tables.length,
      rowCounts: counts,
    };
  } finally { db.close(); }
}

const results = [];
function stage(label, fn) {
  const before = snapshot(label + ' :: before');
  let notes = [];
  if (fn) notes = fn() || [];
  const after = snapshot(label + ' :: after');
  const changed = before.db !== after.db;
  results.push({
    stage: label,
    dbChanged: changed,
    before: `${before.db} (${before.dbBytes}B)`,
    after: `${after.db} (${after.dbBytes}B)`,
    walBefore: `${before.wal} (${before.walBytes}B)`,
    walAfter: `${after.wal} (${after.walBytes}B)`,
    notes,
  });
}

console.log('PHASE D STEP 1.5 — database write-path investigation');
console.log('production DB (READ ONLY):', PROD_DB);
console.log('isolated work dir       :', WORK);
console.log();

copyProduction();
stage('T0 fresh copy of production');

// Build the realistic precondition: a committed but un-checkpointed WAL held
// open by a live connection, exactly as the running app does.
const walNotes = makePendingWal();
stage('T1 after committing rows (pending WAL held open)', () => walNotes);
console.log('pending WAL in place:', sz(WORK + '/db.sqlite-wal'), 'bytes');
console.log();

const logicalBefore = logicalFingerprint();
console.log('--- logical state BEFORE the write paths ---');
console.log(JSON.stringify({
  integrity: logicalBefore.integrity,
  fkViolations: logicalBefore.fkViolations,
  maxMigration: logicalBefore.maxMigration,
  tableCount: logicalBefore.tableCount,
  totalRows: Object.values(logicalBefore.rowCounts).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0),
}));
console.log();

stage('T2 connection.js connect() pragmas', () => runStage('connect'));
stage('T3 backupService checkpointWal()', () => runStage('checkpoint'));
stage('T4 open + close only', () => runStage('openclose'));
stage('T5 read-only query', () => runStage('read'));
stage('T6 integrity_check + foreign_key_check', () => runStage('integrity'));

closeKeepAlive();
const logicalAfter = logicalFingerprint();

console.log('--- stage results ---');
for (const r of results) {
  console.log(`${r.dbChanged ? 'MUTATED ' : 'unchanged'}  ${r.stage}`);
  console.log(`          db  ${r.before}  ->  ${r.after}`);
  if (r.walBefore !== r.walAfter) console.log(`          wal ${r.walBefore}  ->  ${r.walAfter}`);
  for (const n of r.notes) if (n && !n.stage) console.log(`          ${JSON.stringify(n)}`);
}

console.log();
console.log('--- logical comparison ---');
const sameRows = JSON.stringify(logicalBefore.rowCounts) === JSON.stringify(logicalAfter.rowCounts);
console.log('row counts identical   :', sameRows);
console.log('integrity before/after :', logicalBefore.integrity, '/', logicalAfter.integrity);
console.log('fk violations          :', logicalBefore.fkViolations, '/', logicalAfter.fkViolations);
console.log('max migration          :', logicalBefore.maxMigration, '/', logicalAfter.maxMigration);

const mutated = results.filter((r) => r.dbChanged).map((r) => r.stage);
console.log();
console.log('STAGES THAT MUTATED THE MAIN DB FILE:');
for (const m of mutated) console.log('  -', m);
if (!mutated.length) console.log('  (none)');

fs.writeFileSync(path.join(WORK, 'write-map.json'), JSON.stringify({ results, logicalBefore, logicalAfter }, null, 2));
console.log('\nevidence written to', path.join(WORK, 'write-map.json'));
