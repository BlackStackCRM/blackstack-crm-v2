/**
 * DATABASE BACKUP / VERIFY / RESTORE SERVICE
 *
 * Phase 1 data-safety: before any migration or future update, the database
 * must be backed up, VERIFIED, and only then may the operation continue.
 * If a migration fails, the last verified backup can be restored.
 *
 * Guarantees:
 *  - Never overwrites an existing backup (timestamped filenames).
 *  - Verification: file exists, non-empty, readable, opens as SQLite,
 *    passes PRAGMA integrity_check, and has the schema_migrations table.
 *  - Restore: copies the backup over the live database only after the
 *    backup itself re-verifies, and writes the restore event to a log.
 *
 * Note: because the live DB is opened with WAL, a plain file copy only
 * captures data present in the .db file, so the -wal sidecar must be captured
 * too.
 *
 * PHASE D STEP 1.5 (2026-10-07) — source-DB mutation removed.
 * This service previously ran `PRAGMA wal_checkpoint(TRUNCATE)` against the
 * SOURCE database to make a single-file copy complete. A checkpoint is a WRITE:
 * it folds pending WAL frames into the main .db, changing the file's bytes (and
 * therefore its fingerprint) with no change to any logical row. Reproduced in
 * isolation - main DB md5 changed 5cfa9fd13506 -> 155a289c162e while all 143
 * tables' row counts, integrity_check and foreign_key_check stayed identical.
 *
 * `createBackup({ sourcePath })` made this reachable on a database the user
 * merely wanted READ: electron/db-migration.js#migratePortableDatabase passes
 * the production portable DB as sourcePath, so merely launching a packaged app
 * mutated it.
 *
 * The checkpoint is still required, but it now runs on a THROWAWAY COPY of the
 * source, never the source itself. That preserves backup completeness (the
 * resulting file contains every committed row) while guaranteeing the caller's
 * database is byte-identical before and after.
 */
const fs = require('fs');
const path = require('path');
const { paths, ensureDir, getDatabasePath } = require('../config/userDataPath');
const { APP_VERSION } = require('../version');

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/**
 * Produce a self-contained copy of a WAL database at `destPath`, WITHOUT
 * modifying `srcPath` or its sidecars.
 *
 * A checkpoint is a write, so it is performed on a temporary working copy. The
 * caller gets a single-file snapshot containing every committed row; the source
 * keeps its exact bytes.
 *
 * Falls back to a plain copy (plus sidecars) if the working copy cannot be
 * prepared - the snapshot is then still written, just not self-contained.
 */
function snapshotWalDatabase(srcPath, destPath) {
  const { DatabaseSync } = require('node:sqlite');
  const workDir = path.join(path.dirname(destPath), `.walfold-${process.pid}-${Date.now()}`);
  const workDb = path.join(workDir, 'fold.sqlite');
  let folded = false;

  try {
    // 1. Copy the database AND its sidecars - the -wal holds committed frames
    //    that are not yet in the main file.
    fs.mkdirSync(workDir, { recursive: true });
    fs.copyFileSync(srcPath, workDb);
    for (const suffix of ['-wal', '-shm']) {
      const side = srcPath + suffix;
      if (fs.existsSync(side)) fs.copyFileSync(side, workDb + suffix);
    }

    // 2. Fold the working copy's WAL into it. The SOURCE is never opened.
    const db = new DatabaseSync(workDb);
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
    folded = true;

    // 3. Publish the now self-contained file.
    fs.copyFileSync(workDb, destPath);
  } catch {
    // Fallback: plain copy of the .db plus any sidecars. createBackup copies the
    // sidecars alongside, so nothing is silently lost.
    if (!fs.existsSync(destPath)) fs.copyFileSync(srcPath, destPath);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  return { folded, sourceMutated: false };
}

/**
 * Force a WAL checkpoint on a database by rewriting it via a temporary copy.
 *
 * Retained for callers that legitimately need a folded, self-contained file on
 * disk. It no longer checkpoints the source database in place.
 */
function checkpointWal(dbPath) {
  const workDir = path.join(path.dirname(dbPath), `.walfold-${process.pid}-${Date.now()}`);
  const workDb = path.join(workDir, 'fold.sqlite');
  let folded = false;
  try {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(workDir, { recursive: true });
    fs.copyFileSync(dbPath, workDb);
    for (const suffix of ['-wal', '-shm']) {
      const side = dbPath + suffix;
      if (fs.existsSync(side)) fs.copyFileSync(side, workDb + suffix);
    }
    const db = new DatabaseSync(workDb);
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
    finally { try { db.close(); } catch { /* already closed */ } }
    fs.copyFileSync(workDb, dbPath);
    folded = true;
  } catch { /* best effort - the caller's file is left exactly as it was */ }
  finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return { folded };
}

/** Create a verified backup. Returns metadata or throws (caller must STOP). */
function createBackup({ label = 'manual', sourcePath = null } = {}) {
  const src = sourcePath || getDatabasePath();
  if (!fs.existsSync(src)) {
    throw new Error(`Backup aborted: database not found at ${src}`);
  }
  ensureDir(paths.backups());

  // Snapshot WITHOUT mutating the source (§ Step 1.5). The published backup is
  // a folded, self-contained file containing every committed row; `src` keeps
  // its exact bytes, which is what matters when `src` is the user's live or
  // portable database and we were only asked to READ it.
  const base = `database-v${APP_VERSION}-${timestamp()}-${label}`;
  const destDb = path.join(paths.backups(), `${base}.sqlite`);
  const snap = snapshotWalDatabase(src, destDb);

  // Carry any remaining sidecars alongside the snapshot, for the fallback path
  // where the fold could not be completed.
  for (const suffix of ['-wal', '-shm']) {
    const side = src + suffix;
    if (fs.existsSync(side)) {
      try { fs.copyFileSync(side, destDb.replace(/\.sqlite$/, suffix)); } catch { /* ok */ }
    }
  }

  const meta = {
    id: base,
    file: destDb,
    sizeBytes: fs.statSync(destDb).size,
    createdAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    label,
    source: src,
    walFolded: snap.folded,
    sourceMutated: false,
  };
  fs.writeFileSync(path.join(paths.backups(), `${base}.json`), JSON.stringify(meta, null, 2));

  // Phase 2: enforce retention policy after every successful backup (§5/§6).
  try { rotateBackups(); } catch { /* rotation must never break backups */ }
  return meta;
}

/**
 * Verify a backup file: exists, readable, opens as SQLite, integrity_check ok,
 * schema_migrations present. Returns { valid, errors, tables? }.
 */
function verifyBackup(backupFile) {
  const errors = [];
  try {
    if (!fs.existsSync(backupFile)) errors.push('File does not exist');
    else if (fs.statSync(backupFile).size === 0) errors.push('File is empty');
    if (errors.length) return { valid: false, errors };

    const { DatabaseSync } = require('node:sqlite');
    // readOnly: verification must never write to, or checkpoint, the file it is
    // asked to verify (§ Step 1.5). A default handle is read-WRITE.
    const db = new DatabaseSync(backupFile, { readOnly: true }); // throws if not a valid SQLite db
    try {
      let integrityOk = false;
      try {
        const row = db.prepare('PRAGMA integrity_check').get();
        integrityOk = !!row && /ok/i.test(Object.values(row)[0]);
        if (!integrityOk) errors.push('integrity_check failed');
      } catch (e) {
        // e.g. "file is not a database" — the file opens as SQLite but is not valid.
        errors.push('integrity_check failed: ' + e.message);
      }
      if (integrityOk) {
        const mig = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
        if (!mig) errors.push('schema_migrations table missing (not a CRM database?)');
      }
    } finally {
      db.close();
    }
  } catch (err) {
    errors.push(String(err.message || err));
  }
  return { valid: errors.length === 0, errors, file: backupFile };
}

/** List backups (newest first). */
function listBackups() {
  const dir = paths.backups();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Restore a backup over the live database (emergency recovery). */
function restoreBackup(backupFile, { targetPath = null, livePath = null } = {}) {
  const live = livePath || getDatabasePath();
  const check = verifyBackup(backupFile);
  if (!check.valid) {
    throw new Error(`Refusing restore: backup verification failed: ${check.errors.join('; ')}`);
  }
  // No checkpoint needed here: this function is about to REPLACE `live` with the
  // backup, so folding its WAL first would only add an unnecessary write. The
  // stale -wal/-shm are removed after the copy below.

  // Safety: keep a copy of the current (broken) live db before overwriting.
  if (fs.existsSync(live)) {
    ensureDir(paths.backups());
    const quarantine = path.join(paths.backups(), `pre-restore-${timestamp()}.sqlite`);
    fs.copyFileSync(live, quarantine);
  }

  // Close any cached live connection so the file can be replaced.
  try {
    const { _closeCachedConnection } = require('../utils/db');
    if (_closeCachedConnection) _closeCachedConnection();
  } catch { /* standalone usage */ }

  fs.copyFileSync(backupFile, live);
  // Remove stale WAL/SHM so the restored file is the authoritative snapshot.
  for (const suffix of ['-wal', '-shm']) {
    const side = live + suffix;
    if (fs.existsSync(side)) { try { fs.unlinkSync(side); } catch { /* ok */ } }
  }

  // Post-restore verification against the live file.
  const post = verifyBackup(live);
  if (!post.valid) {
    throw new Error(`Post-restore verification failed: ${post.errors.join('; ')}`);
  }
  logRestoreEvent({ backupFile, live, at: new Date().toISOString() });
  return { restored: true, from: backupFile, to: live };
}

function logRestoreEvent(event) {
  try {
    ensureDir(paths.preferences());
    const logFile = path.join(paths.preferences(), 'restore-events.log');
    fs.appendFileSync(logFile, JSON.stringify(event) + '\n');
  } catch { /* logging must never block recovery */ }
}

// ─── PHASE 2: ROTATION, STATUS, SAFE RESTORE ────────────────────────────────

/** Active backup/restore/update operation guard (§6.6/6.7). */
let operationActive = false;
function withOperationLock(fn) {
  if (operationActive) throw new Error('A backup/restore operation is already in progress.');
  operationActive = true;
  try { return fn(); } finally { operationActive = false; }
}

/**
 * Backup retention policy (§5). Centralized; configurable via env, with a
 * sane floor so misconfiguration cannot disable all recovery points.
 */
function getRetentionPolicy() {
  const max = parseInt(process.env.BLACKSTACK_BACKUP_RETENTION || '5', 10);
  return { maxVerifiedBackups: Math.max(1, Number.isFinite(max) ? max : 5) };
}

/** Backups newest-first with verification state attached. */
function listBackupsVerified() {
  const withState = listBackups().map((meta) => {
    let verified = false;
    try { verified = verifyBackup(meta.file).valid; } catch { verified = false; }
    return { ...meta, verified };
  });
  return withState;
}

/**
 * Rotate backups per policy (§6):
 *  - only VERIFIED backups count as recovery points;
 *  - never delete while an operation is active;
 *  - never delete the newest verified backup unless another verified backup
 *    exists (a valid second recovery point);
 *  - unverified backups are removed only when they are stale failures and
 *    we still keep >= 1 valid recovery point (they are not recovery points).
 * Never throws into the caller's critical path; returns a report.
 */
function rotateBackups({ retention = getRetentionPolicy() } = {}) {
  const report = { deleted: [], kept: 0, errors: [], skipped: false };
  try {
    if (operationActive) { report.skipped = true; return report; }
    const all = listBackupsVerified();
    const verified = all.filter((b) => b.verified);
    if (verified.length === 0) {
      // No valid recovery point exists — remove nothing (§6.4).
      report.skipped = true;
      report.reason = 'no-verified-backup';
      return report;
    }
    if (verified.length <= retention.maxVerifiedBackups) {
      // Within policy; still clean up unverified junk (not recovery points),
      // but never touch any verified backup.
      report.kept = verified.length;
      const removals = all.filter((b) => !b.verified);
      for (const b of removals) {
        try {
          fs.unlinkSync(b.file);
          const metaJson = b.file.replace(/\.sqlite$/, '.json');
          if (fs.existsSync(metaJson)) fs.unlinkSync(metaJson);
          report.deleted.push(b.id || path.basename(b.file));
        } catch (e) { report.errors.push(`${path.basename(b.file)}: ${e.message}`); }
      }
      return report;
    }
    // verified is newest-first (listBackups sorts newest first).
    const survivors = verified.slice(0, retention.maxVerifiedBackups);
    const removals = [
      ...verified.slice(retention.maxVerifiedBackups),
      ...all.filter((b) => !b.verified), // unverified = not a recovery point
    ];
    for (const b of removals) {
      try {
        fs.unlinkSync(b.file);
        const metaJson = b.file.replace(/\.sqlite$/, '.json');
        if (fs.existsSync(metaJson)) fs.unlinkSync(metaJson);
        report.deleted.push(b.id || path.basename(b.file));
      } catch (e) {
        report.errors.push(`${path.basename(b.file)}: ${e.message}`);
      }
    }
    report.kept = survivors.length;
    if (report.errors.length) {
      try {
        ensureDir(paths.preferences());
        fs.appendFileSync(path.join(paths.preferences(), 'rotation-events.log'),
          JSON.stringify({ at: new Date().toISOString(), errors: report.errors }) + '\n');
      } catch { /* best effort */ }
    }
  } catch (e) {
    report.skipped = true;
    report.errors.push('rotation failed: ' + e.message);
  }
  return report;
}

/** Directory size (BlackStack-owned dirs only — §18). */
function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  let stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; } catch { /* file vanished */ } }
    }
  }
  return total;
}

/**
 * Safe restore (§8): verify backup → quarantine+pre-restore backup of the
 * live DB → restore → integrity + FK + schema checks → on failure, restore
 * the pre-restore backup so the app never runs against an unverified DB.
 */
function safeRestoreBackup(backupFile, { livePath = null } = {}) {
  return withOperationLock(() => {
    const live = livePath || getDatabasePath();
    const check = verifyBackup(backupFile);
    if (!check.valid) {
      const err = new Error(`Refusing restore: backup verification failed: ${check.errors.join('; ')}`);
      err.code = 'BACKUP_VERIFICATION_FAILED';
      throw err;
    }
    // Pre-restore backup of the live DB (if it exists and has data).
    let preRestoreBackup = null;
    try {
      if (fs.existsSync(live) && fs.statSync(live).size > 4096) {
        const meta = createBackup({ label: 'pre-restore' });
        if (verifyBackup(meta.file).valid) preRestoreBackup = meta.file;
      }
    } catch { /* proceed without; quarantine copy below still exists */ }

    let restoreOk = false;
    try {
      restoreBackup(backupFile, { livePath: live }); // includes quarantine + post-restore verify
      restoreOk = true;
    } catch (err) {
      if (preRestoreBackup) {
        try {
          restoreBackup(preRestoreBackup, { livePath: live });
        } catch (rollbackErr) {
          throw new Error(`Restore failed (${err.message}) AND rollback failed (${rollbackErr.message}). Previous DB quarantined in backups/.`);
        }
        const recheck = verifyBackup(live);
        if (!recheck.valid) {
          throw new Error(`Restore failed (${err.message}); rollback re-verification failed: ${recheck.errors.join('; ')}`);
        }
        const rerr = new Error(`Restore failed and was rolled back; previous database restored. Cause: ${err.message}`);
        rerr.code = 'RESTORE_FAILED_ROLLED_BACK';
        throw rerr;
      }
      throw err;
    }

    // Post-restore FK + schema checks (§8.5-6).
    const { DatabaseSync } = require('node:sqlite');
    const probe = new DatabaseSync(live, { readOnly: true });
    try {
      const fk = probe.prepare('PRAGMA foreign_key_check').all();
      const mig = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
      if (!mig) throw new Error('restored database has no schema_migrations table');
      if (fk.length > 0) throw new Error(`foreign_key_check reported ${fk.length} violation(s)`);
    } catch (e) {
      // FK/schema verification failed: roll back to pre-restore backup.
      if (preRestoreBackup) {
        try { restoreBackup(preRestoreBackup, { livePath: live }); } catch { /* quarantine remains */ }
      }
      const err = new Error(`Post-restore verification failed (${e.message}); previous database restored.`);
      err.code = 'RESTORE_VERIFY_FAILED';
      throw err;
    } finally { try { probe.close(); } catch { /* noop */ } }

    logRestoreEvent({ event: 'safe-restore', backupFile, preRestoreBackup, at: new Date().toISOString(), restoreOk });
    return { restored: true, from: backupFile, to: live, preRestoreBackup };
  });
}

/**
 * Backup + storage status for the UI (§9/§18/§19/§20). Read-only.
 */
function getBackupStatus() {
  const all = listBackupsVerified();
  const verified = all.filter((b) => b.verified);
  const lastVerified = verified[0] || null;
  return {
    totalBackups: all.length,
    verifiedBackups: verified.length,
    lastBackup: all[0] ? { id: all[0].id, createdAt: all[0].createdAt, verified: all[0].verified } : null,
    lastVerifiedBackup: lastVerified ? { id: lastVerified.id, createdAt: lastVerified.createdAt } : null,
    backupStorageBytes: dirSize(paths.backups()),
    retention: getRetentionPolicy(),
  };
}

module.exports = {
  createBackup, verifyBackup, listBackups, restoreBackup, timestamp,
  snapshotWalDatabase, checkpointWal,
  rotateBackups, listBackupsVerified, getRetentionPolicy, getBackupStatus,
  dirSize, safeRestoreBackup, withOperationLock,
};
