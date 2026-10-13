/**
 * Ground-truth check: does the pre-fix legacy_tables statement really rewrite
 * `retired_at`, and does the fixed one preserve it?
 *
 * Written after several contradictory results, each explained by a flaw in the
 * method rather than in the code under test:
 *
 *   - Comparing FILE BYTES cannot distinguish the two: SQLite repacks pages on
 *     any rewrite, so both variants change the md5.
 *   - Reverting only a FRAGMENT of the statement leaves a dangling comma, which
 *     is a syntax error that migrate.js swallows in `catch (e) {}`. Nothing is
 *     written, so a test asserting "nothing changed" passes no matter what.
 *
 * So: substitute the WHOLE statement, then compare the one field that can
 * actually differ.
 *
 * Disposable copies only.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
const require_ = createRequire(path.join(ROOT, 'package.json'));
const { DatabaseSync } = require_('node:sqlite');
const MIGRATE = path.join(ROOT, 'server', 'database', 'migrate.js');
const LIVE_DB = path.join(ROOT, 'data', 'blackstack-crm.db');

const STATEMENT_RE = /conn\.prepare\(`INSERT OR REPLACE INTO legacy_tables[\s\S]*?\)\s*`\)/;

const BUGGY = `conn.prepare(\`INSERT OR REPLACE INTO legacy_tables
      (table_name, status, canonical_replacement, reason, rows_at_retirement)
      VALUES ('inv_locations','RETIRED','locations',
              'Consolidated into locations in migration 081. All rows copied with ids preserved; all FK targets repointed.',
              ?)\`)`;

function retiredAt(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare(
      "SELECT retired_at FROM legacy_tables WHERE table_name = 'inv_locations'",
    ).get();
    return row ? row.retired_at : null;
  } finally { db.close(); }
}

/** Run migrate() against a fresh copy of the live DB, return retired_at after. */
function migrateAndRead(label, source) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bscrm-idem-${label}-`));
  const db = path.join(tmp, 'x.db');
  fs.copyFileSync(LIVE_DB, db);
  const before = retiredAt(db);

  // Point the migration at a scratch module so the real file is untouched.
  const scratchMigrate = path.join(tmp, 'migrate-scratch.js');
  fs.writeFileSync(scratchMigrate, source);

  // The scratch copy must resolve ./connection relative to the real server dir.
  const serverDir = path.join(ROOT, 'server', 'database');
  const scratchInPlace = path.join(serverDir, '__verify_idempotency_scratch.js');
  fs.writeFileSync(scratchInPlace, source);

  try {
    for (const m of ['server/database/connection.js', 'server/database/migrate.js']) {
      try { delete require_.cache[require_.resolve(path.join(ROOT, m))]; } catch (_) { /* ok */ }
    }
    try { delete require_.cache[scratchInPlace]; } catch (_) { /* ok */ }

    process.env.DB_PATH = db;
    process.env.BLACKSTACK_USER_DATA_DIR = tmp;
    require_(scratchInPlace).migrate();

    const after = retiredAt(db);
    return { before, after, changed: before !== after };
  } finally {
    try { fs.rmSync(scratchInPlace, { force: true }); } catch (_) { /* ok */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ok */ }
  }
}

const fixed = fs.readFileSync(MIGRATE, 'utf8');
const reverted = fixed.replace(STATEMENT_RE, BUGGY);
if (reverted === fixed) {
  console.error('could not locate the legacy_tables statement — aborting');
  process.exit(2);
}

console.log('Statement-level ground truth\n');
const r1 = migrateAndRead('fixed', fixed);
console.log(`FIXED    : ${r1.before} -> ${r1.after}   changed=${r1.changed}`);
const r2 = migrateAndRead('reverted', reverted);
console.log(`REVERTED : ${r2.before} -> ${r2.after}   changed=${r2.changed}`);

const ok = r1.changed === false && r2.changed === true;
console.log(`\nfix is load-bearing: ${ok ? 'YES' : 'NO'}`);
if (!ok) {
  console.log('  FIXED should preserve the timestamp; REVERTED should advance it.');
}
process.exit(ok ? 0 : 1);