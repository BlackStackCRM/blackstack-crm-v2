/**
 * PHASE 1 DATA-SAFETY TESTS
 * Run: npx vitest run tests/data-safety.test.js
 *
 * All tests run against an isolated copy of the database in a temp
 * user-data dir (BLACKSTACK_USER_DATA_DIR / DB_PATH) — the production
 * data/blackstack-crm.db is NEVER touched.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

let tmpRoot;
let dbPath;
let backupsDir;

function freshEnv(extra = {}) {
  return { ...process.env, ...extra };
}

function setupIsolatedDb() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-safety-'));
  backupsDir = path.join(tmpRoot, 'backups');
  // Start every test from a copy of the real production database, if present,
  // else create an empty file that migrations will initialize.
  const prodDb = path.resolve(__dirname, '../data/blackstack-crm.db');
  dbPath = path.join(tmpRoot, 'blackstack-crm.db');
  fs.copyFileSync(prodDb, dbPath);
  for (const s of ['-wal', '-shm']) {
    const side = prodDb + s;
    if (fs.existsSync(side)) fs.copyFileSync(side, dbPath + s);
  }
}

// PHASE 3A — DEFENCE IN DEPTH.
//
// This suite builds its own temp clone and assigns process.env.DB_PATH. That is
// correct only while nothing else in this vitest worker has already opened a
// database, because the connection path is frozen on FIRST connect(). If a
// sibling suite connected first, this suite's assignment would be ignored and
// every statement below — including a DROP TABLE — would hit PRODUCTION.
//
// assertDisposableDbIsActive() asks SQLite which file is really open and refuses
// before anything is written. It is cheap and non-creating.
function assertIsolated(suite) {
  const { assertDisposableDbIsActive } = require('../scripts/assert-disposable-db.js');
  assertDisposableDbIsActive({ suite, tmpDir: tmpRoot, expected: dbPath });
}

beforeEach(() => {
  setupIsolatedDb();
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

describe('Phase 1 data safety', () => {
  it('creates and VERIFIES a backup (Test 4)', async () => {
    process.env.DB_PATH = dbPath;
    assertIsolated('data-safety');
    process.env.BLACKSTACK_USER_DATA_DIR = tmpRoot;
    jestModules();
    const { createBackup, verifyBackup } = await import('../server/services/backupService.js');
    const meta = createBackup({ label: 'test' });
    expect(fs.existsSync(meta.file)).toBe(true);
    const check = verifyBackup(meta.file);
    expect(check.valid).toBe(true);
    expect(check.errors).toEqual([]);
  });

  it('existing data survives safe migrations + restart (Tests 1 & 2)', async () => {
    process.env.DB_PATH = dbPath;
    assertIsolated('data-safety');
    process.env.BLACKSTACK_USER_DATA_DIR = tmpRoot;
    const { runSafeMigrations, snapshotCounts } = await jestModules();
    const first = await runSafeMigrations({ backup: false, verbose: false });
    expect(first.status).toBe('OK');

    // Simulate app restart: run again — idempotent, no data loss.
    const countsBefore = first.counts;
    const second = await runSafeMigrations({ backup: false, verbose: false });
    expect(second.status).toBe('OK');
    for (const [t, c] of Object.entries(countsBefore)) {
      expect(second.counts[t]).toBe(c);
    }
  });

  it('migration lock prevents concurrent runs and reports recovery (Test / lock)', async () => {
    process.env.DB_PATH = dbPath;
    assertIsolated('data-safety');
    process.env.BLACKSTACK_USER_DATA_DIR = tmpRoot;
    const { acquireLock, releaseLock, LOCK_FILE, runSafeMigrations } = await jestModules();
    const l = acquireLock();
    expect(l.acquired).toBe(true);
    const blocked = await runSafeMigrations({ backup: false, verbose: false });
    expect(blocked.status).toBe('RECOVERY_REQUIRED');
    expect(fs.existsSync(dbPath)).toBe(true);
    releaseLock();
    const ok = await runSafeMigrations({ backup: false, verbose: false });
    expect(ok.status).toBe('OK');
    void LOCK_FILE;
  });

  it('restore returns database to previous state after simulated failure (Tests 5 & 6)', async () => {
    process.env.DB_PATH = dbPath;
    assertIsolated('data-safety');
    process.env.BLACKSTACK_USER_DATA_DIR = tmpRoot;
    const mods = await jestModules();
    const { createBackup, restoreBackup, verifyBackup } = mods;
    const { runSafeMigrations, snapshotCounts } = mods;

    // Migrate and record counts.
    await runSafeMigrations({ backup: false, verbose: false });
    const { DatabaseConnection } = await import('../server/database/connection.js');
    const conn = new DatabaseConnection().connect();
    const counts = snapshotCounts(conn);
    conn.close();

    // Backup, then simulate data loss (corrupt/drop a table) on a scratch copy.
    const meta = createBackup({ label: 'pre-failure' });
    expect(verifyBackup(meta.file).valid).toBe(true);

    const broken = dbPath + '.broken';
    fs.copyFileSync(dbPath, broken);
    const c2 = new DatabaseSync(broken);
    c2.exec('DROP TABLE IF EXISTS tasks'); // simulated destructive failure
    c2.close();

    // Restore backup over the broken file — data must come back.
    const result = restoreBackup(meta.file, { livePath: broken });
    expect(result.restored).toBe(true);
    const c3 = new DatabaseSync(broken);
    const restoredCounts = snapshotCountsRaw(c3);
    c3.close();
    for (const [t, n] of Object.entries(counts)) {
      expect(restoredCounts[t]).toBe(n);
    }
  });

  it('rejects invalid backups for restore (Test 5 negative)', async () => {
    process.env.DB_PATH = dbPath;
    assertIsolated('data-safety');
    process.env.BLACKSTACK_USER_DATA_DIR = tmpRoot;
    const { restoreBackup, verifyBackup } = await jestModules();
    const bad = path.join(tmpRoot, 'bad.sqlite');
    fs.writeFileSync(bad, 'this is not a sqlite database');
    expect(verifyBackup(bad).valid).toBe(false);
    expect(() => restoreBackup(bad, { livePath: path.join(tmpRoot, 'live.sqlite') })).toThrow();
  });
});

/** Count rows using a raw node:sqlite handle. */
function snapshotCountsRaw(db) {
  const candidates = [
    'customers', 'contacts', 'leads', 'organizations', 'deals', 'tasks',
    'appointments', 'products', 'invoices', 'payments', 'stock_items',
    'journal_entries', 'users', 'activities', 'workflows',
  ];
  const existing = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name)
  );
  const counts = {};
  for (const t of candidates) {
    if (!existing.has(t)) continue;
    try { counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; } catch { counts[t] = -1; }
  }
  return counts;
}

/** Fresh-module loader so env vars set above are honoured. */
async function jestModules() {
  const suffix = '?v=' + Date.now() + Math.random();
  const userData = await import('../server/config/userDataPath.js' + suffix);
  const backup = await import('../server/services/backupService.js' + suffix);
  const runner = await import('../server/services/safeMigrationRunner.js' + suffix);
  return { ...userData, ...backup, ...runner };
}
void execSync;
