/**
 * PHASE D STEP 1.5 — regression tests for source-DB write safety.
 *
 * A checkpoint is a write. createBackup() previously ran
 * `PRAGMA wal_checkpoint(TRUNCATE)` against the SOURCE database to make a
 * single-file copy complete, which mutated the caller's file even when the
 * caller only asked to READ it (electron/db-migration.js passes the production
 * portable DB as sourcePath).
 *
 * These tests pin the required behaviour:
 *   1. createBackup() leaves the source database byte-identical.
 *   2. The published backup is still complete - it contains every committed row,
 *      including rows that were only in a pending (un-checkpointed) WAL.
 *   3. The backup passes the existing verification (integrity + schema).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require2 = createRequire(import.meta.url);
const { DatabaseSync } = require2('node:sqlite');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backupService = require2(path.join(ROOT, 'server', 'services', 'backupService.js'));
const { createBackup } = backupService;

let WORK;

function md5(p) {
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
}

function fileState(p) {
  return {
    db: fs.existsSync(p) ? md5(p) : null,
    dbBytes: fs.existsSync(p) ? fs.statSync(p).size : null,
    wal: fs.existsSync(p + '-wal') ? md5(p + '-wal') : null,
    walBytes: fs.existsSync(p + '-wal') ? fs.statSync(p + '-wal').size : null,
    shm: fs.existsSync(p + '-shm') ? md5(p + '-shm') : null,
  };
}

/**
 * Build a small WAL database with rows committed into a PENDING wal that is held
 * open by a live connection - the only state in which a checkpoint actually has
 * frames to fold.
 */
function makeDbWithPendingWal(dbPath, rows) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA wal_autocheckpoint = 0');
  // verifyBackup() rejects a file that has no schema_migrations table
  // ("not a CRM database?"), so the fixture must carry one for the backup to
  // verify. That is pre-existing behaviour, not something this change alters.
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT)');
  db.exec('CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  const ins = db.prepare('INSERT INTO notes(body) VALUES (?)');
  for (const r of rows) ins.run(r);
  db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
  return db; // deliberately left OPEN so the frames stay in the -wal
}

describe('backupService — source database is never mutated (§ Step 1.5)', () => {
  let keepAlive = null;
  let dbPath;

  beforeEach(() => {
    WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-backup-safety-'));
    process.env.BLACKSTACK_USER_DATA_DIR = WORK;
    dbPath = path.join(WORK, 'source', 'test.sqlite');
  });

  afterEach(() => {
    if (keepAlive) { try { keepAlive.close(); } catch { /* already closed */ } keepAlive = null; }
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ }
    delete process.env.BLACKSTACK_USER_DATA_DIR;
  });

  it('leaves the source database byte-identical while producing a complete backup', () => {
    const rows = ['alpha', 'beta', 'gamma'];
    keepAlive = makeDbWithPendingWal(dbPath, rows);

    // The precondition that makes this meaningful: real frames are pending.
    expect(fs.existsSync(dbPath + '-wal')).toBe(true);
    expect(fs.statSync(dbPath + '-wal').size).toBeGreaterThan(0);

    const before = fileState(dbPath);
    const meta = createBackup({ label: 'test-source-immutability', sourcePath: dbPath });
    const after = fileState(dbPath);

    // THE REQUIREMENT: the source is untouched, byte for byte.
    expect(after.db).toBe(before.db);
    expect(after.dbBytes).toBe(before.dbBytes);
    expect(after.wal).toBe(before.wal);
    expect(after.shm).toBe(before.shm);

    // The backup exists, verifies, and is self-contained.
    expect(fs.existsSync(meta.file)).toBe(true);
    const check = backupService.verifyBackup(meta.file);
    expect(check.valid).toBe(true);

    // COMPLETENESS: every committed row is in the backup, even though those rows
    // were living only in the pending WAL at the time of the backup.
    const bdb = new DatabaseSync(meta.file);
    try {
      const got = bdb.prepare('SELECT body FROM notes ORDER BY id').all().map((r) => r.body);
      expect(got).toEqual(rows);
    } finally { bdb.close(); }

    // Metadata records that the source was not mutated.
    expect(meta.sourceMutated).toBe(false);
    expect(meta.walFolded).toBe(true);
  });

  it('does not fold the source WAL even when rows are pending', () => {
    keepAlive = makeDbWithPendingWal(dbPath, ['one', 'two']);
    const walBefore = fs.statSync(dbPath + '-wal').size;

    createBackup({ label: 'test-no-source-fold', sourcePath: dbPath });
    const walAfter = fs.statSync(dbPath + '-wal').size;

    // The frames are still in the source WAL - they were NOT checkpointed away.
    expect(walAfter).toBe(walBefore);
    expect(walAfter).toBeGreaterThan(0);
  });

  it('creates a backup for a database with no WAL sidecar', () => {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT)');
    db.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)');
    db.prepare('INSERT INTO notes(body) VALUES (?)').run('solo');
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    db.close();

    const before = fileState(dbPath);
    const meta = createBackup({ label: 'test-no-wal', sourcePath: dbPath });
    const after = fileState(dbPath);

    expect(after.db).toBe(before.db);
    expect(backupService.verifyBackup(meta.file).valid).toBe(true);

    const bdb = new DatabaseSync(meta.file);
    try {
      expect(bdb.prepare('SELECT COUNT(*) c FROM notes').get().c).toBe(1);
    } finally { bdb.close(); }
  });

  it('rejects a backup when the source is missing, without creating anything', () => {
    const missing = path.join(WORK, 'source', 'nope.sqlite');
    expect(() => createBackup({ label: 'test-missing', sourcePath: missing }))
      .toThrow(/not found/i);
  });

  it('leaves no temporary working directory behind', () => {
    keepAlive = makeDbWithPendingWal(dbPath, ['temp-check']);
    createBackup({ label: 'test-no-temp-leftovers', sourcePath: dbPath });

    const backupDir = path.join(WORK, 'backups');
    const leftovers = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter((f) => f.startsWith('.walfold-'))
      : [];
    expect(leftovers).toEqual([]);
  });
});
