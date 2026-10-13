#!/usr/bin/env node
/**
 * Read-only snapshot of a SQLite database, for before/after comparison during
 * the seed fix verification.
 *
 * Opens a SNAPSHOT COPY (plus -wal/-shm): a read-only DatabaseSync open cannot
 * recover a pending -wal, so opening the live file read-only can fail with
 * "database is not open". The source is only ever read.
 *
 * Usage: node scripts/phase-d-snapshot-db.js <dbFile> [--rows]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const src = path.resolve(process.argv[2] || '');
if (!src || !fs.existsSync(src)) { console.error(`not found: ${src}`); process.exit(2); }

const tmp = path.join(os.tmpdir(), `p1snap-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
for (const ext of ['', '-wal', '-shm']) {
  if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, tmp + ext);
}
const db = new DatabaseSync(tmp);

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
).all().map((t) => t.name);

const counts = {};
let totalRows = 0;
for (const t of tables) {
  try {
    const c = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
    counts[t] = c;
    totalRows += c;
  } catch { counts[t] = null; }
}

const out = {
  tables: tables.length,
  totalRows,
  users: db.prepare('SELECT id, username, email, role, status FROM users ORDER BY id').all(),
  userRoles: db.prepare('SELECT user_id, role_id FROM user_roles ORDER BY user_id, role_id').all(),
  keyCounts: {
    contacts: counts.contacts ?? 0,
    accounts: counts.accounts ?? 0,
    invoices: counts.invoices ?? 0,
    products: counts.products ?? 0,
    stock_items: counts.stock_items ?? 0,
    permissions: counts.permissions ?? 0,
    role_permissions: counts.role_permissions ?? 0,
    schema_migrations: counts.schema_migrations ?? 0,
  },
  integrity: Object.values(db.prepare('PRAGMA integrity_check').get())[0],
  foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all().length,
  allCounts: counts,
};
db.close();
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* noop */ } }

console.log(JSON.stringify(out, null, 2));
