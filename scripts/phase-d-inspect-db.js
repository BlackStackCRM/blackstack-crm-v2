#!/usr/bin/env node
/**
 * Read-only production inspection. Opens a SNAPSHOT COPY of the given database
 * (never the original) and reports:
 *   - content fingerprint, using the same algorithm as scripts/release-gate.js
 *   - PRAGMA integrity_check
 *   - PRAGMA foreign_key_check
 *   - schema_migrations state
 *
 * A read-only DatabaseSync open cannot recover a pending -wal, so the snapshot
 * carries the sidecars across. The source files are only ever read.
 *
 * Usage: node scripts/phase-d-inspect-db.js <dbFile>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const src = path.resolve(process.argv[2] || '');
if (!src || !fs.existsSync(src)) { console.error(`not found: ${src}`); process.exit(2); }

const before = ['-wal', '-shm'].map((e) => {
  const f = src + e;
  return fs.existsSync(f) ? `${e}:${fs.statSync(f).size}B@${fs.statSync(f).mtimeMs}` : `${e}:absent`;
}).join(' ');

const tmp = path.join(os.tmpdir(), `pd3-inspect-${process.pid}-${Date.now()}.db`);
for (const ext of ['', '-wal', '-shm']) {
  if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, tmp + ext);
}

const db = new DatabaseSync(tmp);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => t.name);

const VOLATILE = new Set(['audit_logs', 'audit_log', 'logs', 'log']);
const h = crypto.createHash('md5');
let nonEmpty = 0, totalRows = 0;
for (const t of tables) {
  if (VOLATILE.has(t.toLowerCase())) continue;
  h.update(`\n## ${t}\n`);
  h.update(db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value ?? ''}`).join(','));
  for (const r of db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()) {
    h.update(JSON.stringify(r));
    totalRows++;
  }
  try { if (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c > 0) nonEmpty++; } catch { /* view */ }
}
const fingerprint = h.digest('hex');

const integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
const fk = db.prepare('PRAGMA foreign_key_check').all().length;
let applied = -1, maxV = -1;
try {
  applied = db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
  maxV = db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v;
} catch { /* none */ }
const phaseD = (() => {
  try { return db.prepare("SELECT COUNT(*) c FROM contacts WHERE first_name LIKE '%PHASE-D%' OR first_name LIKE '%STEP3%'").get().c; }
  catch { return -1; }
})();
db.close();

const after = ['-wal', '-shm'].map((e) => {
  const f = src + e;
  return fs.existsSync(f) ? `${e}:${fs.statSync(f).size}B@${fs.statSync(f).mtimeMs}` : `${e}:absent`;
}).join(' ');

for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* noop */ } }

console.log(`file            : ${src}`);
console.log(`sidecars BEFORE : ${before}`);
console.log(`sidecars AFTER  : ${after}`);
console.log(`sidecars stable : ${before === after}`);
console.log(`tables          : ${tables.length} (non-empty: ${nonEmpty}, rows hashed: ${totalRows})`);
console.log(`content fp      : ${fingerprint}`);
console.log(`integrity_check : ${integrity}`);
console.log(`foreign_key_chk : ${fk} violation(s)`);
console.log(`migrations      : applied=${applied} max_version=${maxV}`);
console.log(`test-tagged rows: ${phaseD}`);

process.exit(integrity === 'ok' && fk === 0 ? 0 : 1);
