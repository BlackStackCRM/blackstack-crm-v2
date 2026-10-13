#!/usr/bin/env node
/**
 * Phase D Step 3 — build an isolated database using the application's REAL
 * migration runner. Used by Recovery Test C.
 *
 * server/database/migrate.js runs each migration file inside its own
 * conn.transaction(), which is what makes rollback meaningful when a migration
 * fails partway through.
 *
 * Usage: node phase-d-migrate-only.js <dbFile>
 */
const path = require('path');

const dbFile = path.resolve(process.argv[2] || '');
if (!dbFile) { console.error('usage: phase-d-migrate-only.js <dbFile>'); process.exit(2); }

process.env.DB_PATH = dbFile;
process.env.BLACKSTACK_USER_DATA_DIR = path.join(path.dirname(path.dirname(dbFile)), 'userdata');
process.env.DEMO_MODE = 'true';

async function main() {
  const { migrate } = require('../server/database/migrate');
  await migrate();

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const tables = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c;
  let applied = -1, maxV = -1;
  try {
    applied = db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
    maxV = db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v;
  } catch { /* leave -1 */ }
  db.close();
  console.log(`[migrate] db        : ${dbFile}`);
  console.log(`[migrate] tables    : ${tables}`);
  console.log(`[migrate] migrations: applied=${applied} max_version=${maxV}`);
  process.exit(tables > 0 ? 0 : 1);
}

main().catch((e) => { console.error('[migrate] FAILED:', e.message); process.exit(1); });
