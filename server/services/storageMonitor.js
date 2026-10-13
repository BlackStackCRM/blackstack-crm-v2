/**
 * STORAGE MONITOR — Phase 2 (§18–§22)
 *
 * Read-only monitoring of BlackStack-owned user-data directories.
 * NEVER scans the whole user profile; NEVER deletes anything.
 * Sizes and warnings only; warnings are advisory (§7/§19/§20/§32-disk-full).
 */
const fs = require('fs');
const path = require('path');
const { paths, getDatabasePath, getUserDataRoot } = require('../config/userDataPath');
const { dirSize } = require('./backupService');

const THRESHOLDS = {
  databaseWarnBytes: 2 * 1024 * 1024 * 1024,   // 2 GB (§19)
  backupsWarnBytes: 10 * 1024 * 1024 * 1024,   // 10 GB (§20)
  minFreeDiskBytes: 500 * 1024 * 1024,         // 500 MB free-space warning (§7)
};

function databaseSize() {
  try {
    const db = getDatabasePath();
    let total = 0;
    if (fs.existsSync(db)) total += fs.statSync(db).size;
    for (const s of ['-wal', '-shm']) {
      if (fs.existsSync(db + s)) total += fs.statSync(db + s).size;
    }
    return total;
  } catch { return 0; }
}

function availableDiskSpace() { return freeDiskSpace(); }

/**
 * Free disk space for the volume hosting user data, via PowerShell on
 * Windows or statfs elsewhere. Returns bytes or null when unavailable.
 */
function freeDiskSpace() {
  try {
    const dir = getUserDataRoot();
    if (process.platform === 'win32') {
      const { execFileSync } = require('child_process');
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        `(Get-PSDrive -Name ${JSON.stringify(dir.charAt(0))}).Free`,
      ], { encoding: 'utf8', timeout: 10000 });
      const n = parseInt(String(out).trim(), 10);
      return Number.isFinite(n) ? n : null;
    } else {
      const fsmod = require('fs');
      if (fsmod.statfs) {
        const s = fsmod.statfs(dir);
        return s.bavail * s.bsize;
      }
      return null;
    }
  } catch { return null; }
}

/** Pure warning evaluation (testable with synthetic sizes). */
function evaluateWarnings(sizes, free) {
  const warnings = [];
  if (sizes.databaseBytes > THRESHOLDS.databaseWarnBytes) {
    warnings.push({ code: 'DB_LARGE', message: 'Your CRM database is becoming large. Consider reviewing storage and database maintenance options.' });
  }
  if (sizes.backupsBytes > THRESHOLDS.backupsWarnBytes) {
    warnings.push({ code: 'BACKUPS_LARGE', message: 'Backup storage exceeds 10 GB. Review backups and retention — recovery points are preserved.' });
  }
  if (free !== null && free !== undefined && free < THRESHOLDS.minFreeDiskBytes) {
    warnings.push({ code: 'DISK_LOW', message: 'Available disk space is critically low. Free space before creating new backups.' });
  }
  return warnings;
}

/** Full storage snapshot + warnings (advisory only — never destructive). */
function getStorageStatus() {
  const sizes = {
    databaseBytes: databaseSize(),
    backupsBytes: dirSize(paths.backups()),
    uploadsBytes: dirSize(paths.uploads()),
    logsBytes: dirSize(path.join(getUserDataRoot(), 'logs')),
    cacheBytes: dirSize(path.join(getUserDataRoot(), 'cache')),
    preferencesBytes: dirSize(paths.preferences()),
  };
  const free = freeDiskSpace();
  const warnings = evaluateWarnings(sizes, free);
  return {
    userDataRoot: getUserDataRoot(),
    ...sizes,
    availableDiskBytes: free,
    thresholds: THRESHOLDS,
    warnings,
    healthy: warnings.length === 0,
  };
}

module.exports = { getStorageStatus, freeDiskSpace, databaseSize, evaluateWarnings, THRESHOLDS };
