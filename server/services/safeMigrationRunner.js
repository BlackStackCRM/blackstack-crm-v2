/**
 * SAFE MIGRATION RUNNER
 *
 * Wraps the existing migrate() system with Phase 1 data-safety:
 *
 *   1. LOCK          — only one migration process at a time; if a previous
 *                      run crashed mid-migration, enter recovery (do NOT
 *                      reset anything; ask the caller to restore a backup).
 *   2. BACKUP        — verified backup before any schema change; if backup
 *                      creation or verification fails, STOP. Never continue
 *                      destructively.
 *   3. INTEGRITY     — record counts of important entities before/after;
 *                      any drop in counts aborts and restores the backup.
 *   4. FAIL-SAFE     — on migration failure, restore the verified backup
 *                      automatically, leaving the CRM in the previous state.
 *
 * The underlying migrate() in ../database/migrate.js is idempotent
 * (schema_migrations table, checksums, IF NOT EXISTS / ADD COLUMN checks) and
 * never drops user tables — it only ever adds columns/tables. We never call
 * any reset/seed logic here.
 */
const fs = require('fs');
const path = require('path');
const { paths, ensureDir, getDatabasePath } = require('../config/userDataPath');
const { createBackup, verifyBackup, restoreBackup } = require('./backupService');

const LOCK_FILE = () => path.join(paths.locks(), 'migration.lock');

/**
 * Windows-safe liveness check. process.kill(pid, 0) does not signal; it only
 * tests existence. Throws EPERM (alive, other user) or ESRCH (no such PID).
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) {
    return e.code === 'EPERM'; // alive but not ours to inspect
  }
}

/**
 * Lock metadata format (v2):
 *   { version: 2, startedAt: ISO, pid: number, host: os.hostname(), dbPath }
 * Old-format locks (no pid) are treated as stale-but-requiring-recovery —
 * we cannot prove the owner is dead, so we never auto-remove them.
 */
function acquireLock({ recoverStale = false } = {}) {
  ensureDir(paths.locks());
  const file = LOCK_FILE();
  if (fs.existsSync(file)) {
    let info = {};
    try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* corrupt lock */ }
    const hasOwner = Number.isInteger(info.pid) && info.pid > 0;
    const ownerAlive = hasOwner && isProcessAlive(info.pid);
    if (ownerAlive) {
      // Another (or our own nested) migration may genuinely be running. Block.
      return {
        acquired: false,
        stale: false,
        reason: 'owner-alive',
        info,
        message: `Migration lock held by running process PID ${info.pid} (started ${info.startedAt}). If this is not another migration, wait or restart that process.`,
      };
    }
    // Owner provably dead (or legacy lock without metadata) = stale.
    if (recoverStale) {
      // Explicit recovery: re-check liveness immediately before deleting so a
      // racing migration cannot lose its lock.
      const reread = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } })();
      const stillAlive = Number.isInteger(reread.pid) && reread.pid > 0 && isProcessAlive(reread.pid);
      if (stillAlive) {
        return { acquired: false, stale: false, reason: 'owner-alive', info: reread, message: 'Lock owner came back alive during recovery; blocking.' };
      }
      try { fs.unlinkSync(file); } catch { /* another process removed it */ }
      // Stale lock removed — fall through to acquire a fresh lock below.
    } else {
      return {
        acquired: false,
        stale: true,
        reason: hasOwner ? 'owner-dead' : 'no-metadata',
        info,
        message: 'A previous migration did not release its lock (owner process is no longer running). ' +
          'The database was NOT touched. Restore the latest verified backup, then re-run with migration lock recovery.',
      };
    }
  }
  const os = require('os');
  fs.writeFileSync(file, JSON.stringify({
    version: 2,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    host: os.hostname(),
    dbPath: getDatabasePath(),
  }));
  return { acquired: true };
}

function releaseLock() {
  const file = LOCK_FILE();
  // Defensive: never delete a lock owned by another live process.
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (info && Number.isInteger(info.pid) && info.pid !== process.pid && isProcessAlive(info.pid)) {
      console.warn('[migrate] releaseLock refused: lock belongs to live PID ' + info.pid);
      return;
    }
  } catch { /* missing/corrupt: fall through and remove */ }
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

/**
 * Count rows of the entity tables that actually exist in this database.
 * Returns a map { tableName: count } for present tables only.
 */
function snapshotCounts(conn) {
  const candidates = [
    'customers', 'contacts', 'leads', 'organizations', 'deals', 'tasks',
    'appointments', 'products', 'invoices', 'payments', 'stock_items',
    'journal_entries', 'users', 'activities', 'workflows',
  ];
  const existing = new Set(
    conn.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name)
  );
  const counts = {};
  for (const t of candidates) {
    if (!existing.has(t)) continue;
    try { counts[t] = conn.all(`SELECT COUNT(*) AS c FROM ${t}`)[0].c; } catch { counts[t] = -1; }
  }
  return counts;
}

function countsMatch(before, after) {
  for (const [table, count] of Object.entries(before)) {
    // Tables only growing is fine; shrinking means data loss.
    if (after[table] !== undefined && after[table] < count) {
      return { ok: false, table, before: count, after: after[table] };
    }
  }
  return { ok: true };
}

/**
 * Run migrations with full safety net.
 * @param {object} opts
 * @param {boolean} opts.backup  create a verified backup first (default true)
 * @param {boolean} opts.rollbackOnFailure  restore backup if migration fails (default true)
 */
async function runSafeMigrations({ backup = true, rollbackOnFailure = true, verbose = true, recoverStaleLock = false } = {}) {
  const log = (...a) => verbose && console.log('[migrate]', ...a);
  const dbPath = getDatabasePath();

  // Fresh (non-cached) connection for counting/management.
  const { DatabaseConnection } = require('../database/connection');

  // 1. LOCK + crash recovery detection
  const lock = acquireLock({ recoverStale: recoverStaleLock });
  if (!lock.acquired) {
    return {
      status: 'RECOVERY_REQUIRED',
      stale: !!lock.stale,
      reason: lock.reason,
      message: lock.message ||
        'A previous migration was interrupted (stale lock found). ' +
        'The database was NOT touched. Restore the latest verified backup via restoreBackup(), then delete ' + LOCK_FILE() + ' and re-run migrations.',
      lockInfo: lock.info,
    };
  }

  const db = new DatabaseConnection();
  const conn = db.connect();
  let backupMeta = null;
  try {
    // 2. BACKUP + VERIFY
    // Only back up a database that already contains CRM data. Merely opening
    // a connection (node:sqlite, below) materializes a 4 KB empty file with
    // no schema; backing that up would fail verification (schema_migrations
    // missing) and abort every FRESH installation. A database that contains
    // CRM tables always has a schema_migrations table, so this predicate
    // cannot skip a legitimate backup of real user data.
    const existingDb = fs.existsSync(dbPath) && fs.statSync(dbPath).size > 4096;
    const hasCrmData = existingDb && (() => {
      try {
        const { DatabaseSync } = require('node:sqlite');
        const probe = new DatabaseSync(dbPath, { readOnly: true });
        try {
          return !!probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
        } finally { probe.close(); }
      } catch { return true; } // unreadable → treat as real data; backup attempt will verify
    })();
    if (backup && hasCrmData) {
      backupMeta = createBackup({ label: 'pre-migration' });
      const check = verifyBackup(backupMeta.file);
      if (!check.valid) {
        return { status: 'ABORTED_BACKUP_FAILED', message: 'Backup verification failed; migration NOT started.', errors: check.errors, backup: backupMeta };
      }
      log('Verified backup created:', backupMeta.file);
    }

    // 3. MIGRATE (existing idempotent system — no resets, no seeds)
    const { migrate } = require('../database/migrate');
    const before = snapshotCounts(conn);
    let migrationError = null;
    let migrationHandle = null;
    try {
      // PHASE 3A — CLOSE THE HANDLE. migrate() returns an open connection and
      // transfers ownership to its caller. Leaving it open leaked a live binding
      // that made the process look pinned to this file, so a suite that
      // legitimately uses a fresh disposable database per test was refused as
      // mis-bound by assertDisposableDbIsActive().
      migrationHandle = await migrate();
    } catch (err) {
      migrationError = err;
    } finally {
      if (migrationHandle) {
        try { migrationHandle.close(); } catch { /* already closed */ }
      }
    }

    if (migrationError) {
      if (rollbackOnFailure && backupMeta) {
        try {
          restoreBackup(backupMeta.file, { livePath: dbPath });
          log('Migration failed; verified backup restored — database returned to previous safe state.');
          return { status: 'MIGRATION_FAILED_RESTORED', message: migrationError.message, restoredFrom: backupMeta.file };
        } catch (restoreErr) {
          return { status: 'MIGRATION_FAILED_RESTORE_FAILED', message: migrationError.message, restoreError: restoreErr.message, backupFile: backupMeta.file };
        }
      }
      return { status: 'MIGRATION_FAILED', message: migrationError.message, backupFile: backupMeta && backupMeta.file };
    }

    // 4. INTEGRITY CHECK (after)
    const after = snapshotCounts(conn);
    const check = countsMatch(before, after);
    if (!check.ok) {
      if (rollbackOnFailure && backupMeta) {
        restoreBackup(backupMeta.file, { livePath: dbPath });
        return {
          status: 'INTEGRITY_FAILURE_RESTORED',
          message: `Row count dropped for '${check.table}' (${check.before} -> ${check.after}); backup restored.`,
        };
      }
      return { status: 'INTEGRITY_FAILURE', ...check };
    }

    log('Migrations complete. Data integrity verified.');
    return { status: 'OK', appliedBackup: backupMeta, counts: after };
  } finally {
    releaseLock();
    try { db.close(); } catch { /* ok */ }
  }
}

module.exports = { runSafeMigrations, acquireLock, releaseLock, isProcessAlive, snapshotCounts, countsMatch, LOCK_FILE };
