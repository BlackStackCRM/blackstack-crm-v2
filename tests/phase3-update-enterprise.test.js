/**
 * PHASE 3 TESTS — Updates, rollback, recovery, channels, Event Log.
 * All destructive operations use throwaway temp dirs (§32 hard isolation).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const PROJ = path.resolve(__dirname, '..');

/**
 * Environment isolation.
 *
 * The suite used to snapshot the WHOLE environment and restore it wholesale:
 *
 *     prevEnv = { ...process.env };   // beforeEach
 *     process.env = prevEnv;          // afterEach
 *
 * That is unsafe for two independent reasons.
 *
 * 1. It clobbers concurrent work. Restoring the entire object discards any
 *    variable another test changed while this suite was running — including
 *    variables this suite never touched. Restoring only what was modified is
 *    the correct contract.
 *
 * 2. On Windows it permanently breaks process.env itself. Node's real
 *    process.env is a case-insensitive proxy over the OS environment; assigning
 *    a plain object to process.env replaces that proxy with an ordinary
 *    object. Every later lookup by a differently-cased name then returns
 *    undefined — `PATH` vs `Path`, `TEMP` vs `Temp`, `APPDATA`. Verified
 *    directly: before the assignment `process.env.PathLikeProbe` is readable as
 *    `PATHLIKEPROBE`; afterwards it is not. Tests in this very file read
 *    `process.env.APPDATA`, so the suite sabotaged its own assertions.
 *
 * So: record the two variables this suite sets, and restore exactly those —
 * deleting the key when it was not previously present, and never replacing
 * process.env's identity.
 */

/** The only environment variables this suite mutates. */
const MANAGED_ENV_KEYS = ['DB_PATH', 'BLACKSTACK_USER_DATA_DIR'];

let tmpRoot;
let savedEnv = null;

function setup() {
  // Snapshot ONLY the keys we are about to change, recording whether each was
  // present so an absent key can be deleted again rather than left as undefined.
  savedEnv = new Map();
  for (const key of MANAGED_ENV_KEYS) {
    savedEnv.set(key, Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined);
  }

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bscrm-p3-'));
  const userData = path.join(tmpRoot, 'user-data');
  fs.mkdirSync(path.join(userData, 'database'), { recursive: true });
  process.env.BLACKSTACK_USER_DATA_DIR = userData;
  process.env.DB_PATH = path.join(userData, 'database', 'blackstack-crm.db');
  return { userData, dbPath: process.env.DB_PATH };
}

function teardown() {
  if (savedEnv) {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv = null;
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
}

function freshModules() {
  for (const m of [
    'server/config/userDataPath.js',
    'server/services/backupService.js',
    'server/services/updateService.js',
  ]) delete require.cache[require_(path.join(PROJ, m)).id];
  const userDataPath = require_(path.join(PROJ, 'server/config/userDataPath.js'));
  const backup = require_(path.join(PROJ, 'server/services/backupService.js'));
  const upd = require_(path.join(PROJ, 'server/services/updateService.js'));
  return { userDataPath, backup, upd };
}

function makeCrmDb(dbPath, { schemaVersion = 1, contacts = 2 } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, sha256 TEXT, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
  // PHASE 3A — FIXTURE CHECKSUM FIX.
  //
  // This used to seed sha256 'abc' with name 'test'. migrate() compares the
  // STORED checksum against the real file's hash: a mismatch is treated as "this
  // migration was already applied, but the file changed later", so it only
  // rewrites the checksum and `continue`s — the migration's DDL never runs.
  //
  // That made the fixture lie: schema_migrations claimed version 1 was applied
  // while the schema it creates did not exist. The stale-lock regression test then
  // failed deep inside the suite with:
  //   Migration 14_indexes failed: no such column: organization_id
  // which says nothing about locks and looks like a product fault.
  //
  // Fix: seed the REAL checksum for the version being claimed, so the stored
  // state is consistent and later migrations apply cleanly. Other tests in this
  // file only assert on contacts counts, backups or the schema version itself,
  // none of which depend on the fake name/checksum.
  const realSha = (() => {
    try {
      const fsp = require_('fs');
      const csp = require_('crypto');
      const mdir = path.join(PROJ, 'server', 'database', 'migrations');
      const hit = fsp.readdirSync(mdir)
        .filter((f) => f.endsWith('.sql') && Number(f.slice(0, 3)) === schemaVersion)[0];
      if (!hit) return null;
      return csp.createHash('sha256').update(fsp.readFileSync(path.join(mdir, hit), 'utf8')).digest('hex');
    } catch { return null; }
  })();
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, sha256) VALUES (?, ?, ?)')
    .run(schemaVersion, realSha ? 'fixture' : 'test', realSha || 'abc');

  // PHASE 3A — DO NOT PRE-CREATE `contacts`.
  //
  // This fixture used to run `CREATE TABLE IF NOT EXISTS contacts (id, name)`.
  // That table is a STUB, and it defeated the real schema:
  //   * migration 002 creates the full `contacts` table, including the
  //     organization_id column, but as `CREATE TABLE IF NOT EXISTS`;
  //   * because the stub already existed, 002 became a no-op;
  //   * migration 014 then ran `CREATE INDEX ... ON contacts(organization_id)`
  //     and failed with "no such column: organization_id".
  //
  // Verified against a genuinely empty database: migrations 1..N apply cleanly
  // and `contacts` ends up with its full column set. The stub was the cause; the
  // checksum fix alone could not have cured it.
  //
  // So create only the bookkeeping table and let migrations own the schema.
  // Tests needing contact rows call makeContacts() AFTER migrating.
  db.close();
}

/**
 * Seed rows into an ALREADY-MIGRATED contacts table.
 * Call only after runSafeMigrations() has created the real schema.
 */
/** Apply the real migrations to the current DB_PATH. */
async function runMigrations() {
  const { runSafeMigrations } = require_(path.join(PROJ, 'server/services/safeMigrationRunner.js'));
  const res = await runSafeMigrations({ backup: false, verbose: false });
  if (res.status !== 'OK') throw new Error(`fixture migration failed: ${res.status} ${res.message || ''}`);
}

/**
 * Seed rows into an ALREADY-MIGRATED contacts table.
 * Call only after runSafeMigrations() has created the real schema.
 */
function makeContacts(dbPath, count) {
  const db = new DatabaseSync(dbPath);
  const cols = db.prepare('PRAGMA table_info(contacts)').all().map((c) => c.name);
  if (!cols.includes('id')) { db.close(); return; }
  const sql = cols.includes('first_name')
    ? 'INSERT OR IGNORE INTO contacts (id, first_name) VALUES (?, ?)'
    : 'INSERT OR IGNORE INTO contacts (id, name) VALUES (?, ?)';
  for (let i = 0; i < count; i++) {
    db.prepare(sql).run(`c${i}`, `Contact ${i}`);
  }
  db.close();
}

beforeEach(() => setup());
afterEach(() => teardown());

// ─── UPDATE CHANNELS (§4) ────────────────────────────────────────────────────
describe('update channels', () => {
  it('defaults to stable and persists a channel change', () => {
    const { upd } = freshModules();
    expect(upd.getChannel()).toBe('stable');
    expect(upd.setChannel('beta')).toBe('beta');
    // Re-read from disk with fresh module copy.
    const { upd: upd2 } = freshModules();
    expect(upd2.getChannel()).toBe('beta');
    upd2.setChannel('stable');
  });

  it('rejects unknown channels', () => {
    const { upd } = freshModules();
    expect(() => upd.setChannel('hacker')).toThrowError(/Unknown update channel/);
  });

  it('never writes channel to the database', () => {
    const { upd, userDataPath } = freshModules();
    upd.setChannel('enterprise');
    const dbPath = userDataPath.getDatabasePath();
    makeCrmDb(dbPath);
    const db = new DatabaseSync(dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%channel%'").all();
    db.close();
    expect(tables.length).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(userDataPath.paths.preferences(), 'update-channel.json'), 'utf8')).channel).toBe('enterprise');
    upd.setChannel('stable');
  });
});

// ─── SCHEMA COMPATIBILITY (§9) ───────────────────────────────────────────────
describe('schema compatibility gate', () => {
  it('reports UNSUPPORTED when DB schema is below the minimum', () => {
    const { upd } = freshModules();
    const r = upd.checkSchemaCompatibility({ targetAppVersion: '2.0.0', dbSchemaVersion: -1 });
    expect(['UNSUPPORTED', 'INCOMPATIBLE']).toContain(r.result);
  });

  it('reports MIGRATION_REQUIRED for newer target with valid schema', () => {
    const { upd } = freshModules();
    const r = upd.checkSchemaCompatibility({ targetAppVersion: '9.9.9', dbSchemaVersion: 999 });
    expect(['MIGRATION_REQUIRED', 'COMPATIBLE']).toContain(r.result);
  });

  it('reports COMPATIBLE for same/older targets', () => {
    const { upd } = freshModules();
    const r = upd.checkSchemaCompatibility({ targetAppVersion: '1.0.0', dbSchemaVersion: 999 });
    expect(r.result).toBe('COMPATIBLE');
  });

  it('reports INCOMPATIBLE when schema version is unknown', () => {
    const { upd } = freshModules();
    const r = upd.checkSchemaCompatibility({ targetAppVersion: '1.1.0', dbSchemaVersion: null });
    expect(r.result).toBe('INCOMPATIBLE');
  });

  it('reads the real DB schema version', () => {
    const { upd } = freshModules();
    makeCrmDb(process.env.DB_PATH, { schemaVersion: 42 });
    expect(upd.getCurrentDbSchemaVersion()).toBe(42);
  });
});

// ─── UPDATE SAFETY: BACKUP REQUIRED (§8) ─────────────────────────────────────
describe('pre-update safety', () => {
  it('creates and verifies a pre-update backup', () => {
    const { backup } = freshModules();
    makeCrmDb(process.env.DB_PATH, { contacts: 5 });
    const meta = backup.createBackup({ label: 'pre-update' });
    const check = backup.verifyBackup(meta.file);
    expect(check.valid).toBe(true);
  });

  it('a corrupt backup never counts as verified (blocks update path)', () => {
    const { backup } = freshModules();
    makeCrmDb(process.env.DB_PATH);
    const good = backup.createBackup({ label: 'pre-update' });
    // Corrupt a second file.
    const bad = path.join(path.dirname(good.file), 'bad.sqlite');
    fs.writeFileSync(bad, 'garbage');
    expect(backup.verifyBackup(bad).valid).toBe(false);
    expect(backup.verifyBackup(good.file).valid).toBe(true);
  });
});

// ─── MIGRATION FAILURE RECOVERY (§12 Scenario C) ─────────────────────────────
describe('update/migration failure recovery', () => {
  it('restores the verified backup when a migration throws (data preserved)', async () => {
    const { backup, userDataPath } = freshModules();
    const dbPath = process.env.DB_PATH;
    // PHASE 3A: migrate for real, then seed — the fixture no longer pre-creates
    // `contacts`, because a stub table there breaks migration 014.
    await runMigrations();
    makeContacts(dbPath, 7);
    // Verified backup with 7 contacts.
    const meta = backup.createBackup({ label: 'pre-update' });
    expect(backup.verifyBackup(meta.file).valid).toBe(true);
    // Simulate a destructive/mangled DB (data loss).
    const broken = new DatabaseSync(dbPath);
    broken.exec('DELETE FROM contacts');
    broken.close();
    // Recover via the existing safe restore.
    const result = backup.safeRestoreBackup(meta.file);
    expect(result.restored).toBe(true);
    const db = new DatabaseSync(dbPath);
    const n = db.prepare('SELECT COUNT(*) AS c FROM contacts').get();
    db.close();
    expect(n.c).toBe(7);
    void userDataPath;
  });

  it('restore rolls back when post-restore FK verification fails', async () => {
    const { backup } = freshModules();
    const dbPath = process.env.DB_PATH;
    await runMigrations();
    makeContacts(dbPath, 3);
    const good = backup.createBackup({ label: 'pre-update' });
    // Create a backup that passes integrity but has FK violations.
    const fkBad = path.join(path.dirname(good.file), 'database-v1.0.0-fkbad.sqlite');
    fs.copyFileSync(dbPath, fkBad);
    const mangle = new DatabaseSync(fkBad);
    mangle.exec("PRAGMA foreign_keys=OFF; CREATE TABLE t (id TEXT PRIMARY KEY, other TEXT REFERENCES contacts(id)); INSERT INTO t VALUES ('x', 'missing')");
    mangle.close();
    // saveRestoreBackup must refuse/rollback: the DB has schema_migrations so
    // verification passes but the FK check must fail it. It throws synchronously
    // (via withOperationLock) and automatically restores the previous database.
    expect(() => backup.safeRestoreBackup(fkBad)).toThrow();
    // Original DB must be unchanged (contacts still 3).
    const db = new DatabaseSync(dbPath);
    const n = db.prepare('SELECT COUNT(*) AS c FROM contacts').get();
    db.close();
    expect(n.c).toBe(3);
  });

  it('stale-lock recovery still works (Phase 1 regression guard)', async () => {
    delete require.cache[require_(path.join(PROJ, 'server/services/safeMigrationRunner.js')).id];
    const safeMigrationRunner = require_(path.join(PROJ, 'server/services/safeMigrationRunner.js'));
    const fsMod = require_('fs');

    // PHASE 3A — migrate FIRST, then simulate the interrupted run.
    //
    // The fixture used to call makeCrmDb({contacts: 1}) and then immediately
    // plant a stale lock and ask for recovery. That could never succeed: the
    // "recovery" run is the FIRST migration this database ever sees, and its
    // schema was a stub (`contacts(id, name)`), so migration 014 died on
    // `no such column: organization_id` and the status came back MIGRATION_FAILED.
    //
    // The realistic scenario this guard exists for is: migrations ran, a later
    // run was interrupted and left a lock behind, and the next run recovers it.
    // So: apply the real schema, THEN plant the stale lock.
    await runMigrations();
    makeContacts(process.env.DB_PATH, 1);

    // Simulate a lock from a DEAD process (PID 999999 does not exist).
    fsMod.mkdirSync(require_(path.join(PROJ, 'server/config/userDataPath.js')).paths.locks(), { recursive: true });
    fsMod.writeFileSync(path.join(require_(path.join(PROJ, 'server/config/userDataPath.js')).paths.locks(), 'migration.lock'),
      JSON.stringify({ version: 2, startedAt: new Date().toISOString(), pid: 999999, host: 'test' }));
    const blocked = await safeMigrationRunner.runSafeMigrations({ backup: false, verbose: false });
    expect(blocked.status).toBe('RECOVERY_REQUIRED');
    expect(blocked.stale).toBe(true);
    const recovered = await safeMigrationRunner.runSafeMigrations({ backup: false, verbose: false, recoverStaleLock: true });
    expect(recovered.status).toBe('OK');
  });
});

// ─── UPDATE AUDIT LOG (§13) ─────────────────────────────────────────────────
describe('update audit taxonomy', () => {
  it('writes standardized event names to updates.log', () => {
    const { updateLogger } = require_(path.join(PROJ, 'electron/update-logger.js'));
    const dir = path.join(tmpRoot, 'logs');
    updateLogger.init(dir);
    updateLogger.event(updateLogger.EVENTS.CHECK_STARTED, { channel: 'stable' });
    updateLogger.event(updateLogger.EVENTS.DOWNLOAD_COMPLETED, { version: '1.2.0' });
    const content = fs.readFileSync(path.join(dir, 'updates.log'), 'utf8');
    expect(content).toContain('UPDATE_CHECK_STARTED');
    expect(content).toContain('UPDATE_DOWNLOAD_COMPLETED');
    expect(content).not.toContain('password');
  });
});

// ─── WINDOWS EVENT LOG (§18, non-fatal) ─────────────────────────────────────
describe('windows event log writer', () => {
  it('never throws, even with bad input', () => {
    const { logEvent } = require_(path.join(PROJ, 'electron/eventLog.js'));
    expect(() => logEvent('ERROR', 'test message')).not.toThrow();
    expect(() => logEvent('ERROR', 'password=hunter2 token=abc')).not.toThrow();
    expect(() => logEvent('ERROR', null)).not.toThrow();
  });
});

// ─── ENTERPRISE / ISOLATION (§19/§28/§32) ───────────────────────────────────
describe('enterprise & isolation regressions', () => {
  it('custom user-data dir keeps DB + backups inside it', () => {
    const { userDataPath, backup } = freshModules();
    makeCrmDb(process.env.DB_PATH);
    const meta = backup.createBackup({ label: 'test' });
    const root = fs.realpathSync(userDataPath.getUserDataRoot());
    expect(fs.realpathSync(meta.file).startsWith(root)).toBe(true);
    expect(process.env.DB_PATH.startsWith(root)).toBe(true);
  });

  it('test paths never touch the real user data (hard assertion)', () => {
    const root = fs.realpathSync(path.dirname(process.env.DB_PATH));
    const appData = process.env.APPDATA || '';
    if (appData && root.toLowerCase().startsWith(appData.toLowerCase())) {
      throw new Error('TEST ISOLATION VIOLATION — aborting');
    }
    expect(root.toLowerCase().startsWith(os.tmpdir().toLowerCase()) ||
           fs.realpathSync(os.tmpdir()).startsWith(path.dirname(root))).toBe(true);
  });
});
