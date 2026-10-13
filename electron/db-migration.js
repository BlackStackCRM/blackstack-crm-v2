/**
 * One-time, idempotent migration of a pre-existing portable database
 * (data/blackblackstack-crm.db) into the Electron userData directory.
 *
 * Safety rules (Phase 2 spec §7/§8):
 *  - If a userData DB already exists: use it, do nothing.
 *  - If a portable DB exists: verified backup -> copy -> integrity check ->
 *    schema check -> record-count comparison -> only then done.
 *  - NEVER delete the source DB. Never create a blank DB over a failure.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function findPortableDb() {
  // Explicit override wins (used by tests and portable installs). If set but
  // missing, we honor it as "no portable DB" rather than falling back.
  if (process.env.PORTABLE_DB_PATH !== undefined) {
    const p = process.env.PORTABLE_DB_PATH;
    return p && fs.existsSync(p) ? p : null;
  }
  // Otherwise check conventional locations.
  const candidates = [
    path.join(process.cwd(), 'data', 'blackstack-crm.db'),
    path.join(__dirname, '..', 'data', 'blackstack-crm.db'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* skip */ }
  }
  return null;
}

function countRows(db, table) {
  try { return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c; } catch { return -1; }
}

function importantTables(db) {
  const all = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const wanted = ['customers','contacts','leads','organizations','deals','tasks','appointments','products','invoices','payments','stock_items','journal_entries','users'];
  return wanted.filter((t) => all.includes(t));
}

function verifyDb(dbPath) {
  const errors = [];
  try {
    if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) return { valid: false, errors: ['missing or empty'] };
    // Read-only: verification must never write to (or checkpoint) the file it
    // inspects. A default DatabaseSync handle is read-WRITE (§ Step 1.5).
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const ic = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
      if (!/ok/i.test(String(ic))) errors.push('integrity_check failed');
      const mig = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
      if (!mig) errors.push('schema_migrations missing');
    } finally { db.close(); }
  } catch (e) { errors.push(e.message); }
  return { valid: errors.length === 0, errors };
}

function migratePortableDatabase({ targetPath, log = () => {} }) {
  if (fs.existsSync(targetPath)) return { status: 'existing' };

  const source = findPortableDb();
  if (!source) return { status: 'fresh' };

  log('Found portable database at ' + source + ' — migrating safely...');
  const { paths, ensureDir } = require(path.join(__dirname, '..', 'server', 'config', 'userDataPath'));
  ensureDir(paths.backups());

  // 1. Verified backup BEFORE any copy (spec: create backup -> verify -> copy).
  let backupFile;
  try {
    const { createBackup, verifyBackup } = require(path.join(__dirname, '..', 'server', 'services', 'backupService'));
    const meta = createBackup({ label: 'pre-userdata-migration', sourcePath: source });
    const check = verifyBackup(meta.file);
    if (!check.valid) throw new Error('backup verification failed: ' + check.errors.join('; '));
    backupFile = meta.file;
    log('Verified backup: ' + backupFile);
  } catch (e) {
    // If we cannot even back it up, abort — do not touch anything.
    return { status: 'error', error: 'Could not create verified backup: ' + e.message };
  }

  // 2. Copy to userData/database/
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(source, targetPath);
  for (const s of ['-wal', '-shm']) {
    const side = source + s;
    if (fs.existsSync(side)) { try { fs.copyFileSync(side, targetPath + s); } catch { /* ok */ } }
  }

  // 3. Verify target integrity + schema.
  const check = verifyDb(targetPath);
  if (!check.valid) {
    return { status: 'error', error: 'copied DB failed verification: ' + check.errors.join('; ') + ' (source untouched at ' + source + ')' };
  }

  // 4. Compare record counts source vs target.
  //
  // PHASE D STEP 1.5 — open the source READ-ONLY. A default DatabaseSync handle
  // is read-WRITE: merely opening the user's portable database that way and
  // closing it lets SQLite checkpoint and DELETE the -wal/-shm sidecars, which is
  // a write to the user's data area. We only ever count rows here, so the
  // read-only flag costs nothing and removes the side effect.
  const dbSrc = new DatabaseSync(source, { readOnly: true });
  const dbDst = new DatabaseSync(targetPath, { readOnly: true });
  try {
    for (const t of importantTables(dbSrc)) {
      const a = countRows(dbSrc, t);
      const b = countRows(dbDst, t);
      if (a >= 0 && b >= 0 && b < a) {
        return { status: 'error', error: `row count mismatch for ${t}: ${a} -> ${b} (source untouched)` };
      }
    }
  } finally {
    try { dbSrc.close(); dbDst.close(); } catch { /* noop */ }
  }

  // 5. Mark migration complete (record for idempotency/diagnostics).
  try {
    fs.writeFileSync(path.join(path.dirname(targetPath), 'MIGRATED_FROM.txt'),
      `Migrated from: ${source}\nBackup: ${backupFile}\nAt: ${new Date().toISOString()}\n`);
  } catch { /* noop */ }
  log('Portable DB migration verified OK. Source left in place untouched.');
  return { status: 'migrated', source, backupFile };
}

module.exports = { migratePortableDatabase, verifyDb };
