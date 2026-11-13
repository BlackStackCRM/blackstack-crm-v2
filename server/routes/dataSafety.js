const express = require('express');
const { getVersionInfo } = require('../version');
const { createBackup, verifyBackup, restoreBackup, rotateBackups, getBackupStatus, listBackupsVerified, safeRestoreBackup } = require('../services/backupService');
const { getStorageStatus } = require('../services/storageMonitor');
const { issueDeleteToken, previewDeletion, performDeletion } = require('../services/dataDeletionService');
const { generateSupportBundle } = require('../services/supportBundle');
const { UpdateService, getChannel, setChannel, checkSchemaCompatibility, getCurrentDbSchemaVersion, CHANNELS } = require('../services/updateService');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { AuthorizationError } = require('../utils/errors');
const { getConn } = require('../utils/db');
const { resolveCaller } = require('../services/rbac.service');

const router = express.Router();

// ─── AUTHENTICATION (security fix) ───────────────────────────────────────
//
// This router previously applied NO authentication. Every endpoint below was
// reachable by any unauthenticated caller on localhost, including:
//
//   POST /backups              → wrote a backup to disk
//   POST /backups/rotate       → deleted old backups
//   POST /support-bundle       → wrote a diagnostic bundle to disk
//   POST /data-deletion/token  → issued a delete-everything token
//   POST /backups/restore      → attempted a live database restore
//   POST /maintenance/vacuum   → VACUUM on the live database
//   GET  /storage, /backups    → disclosed absolute filesystem paths,
//                                backup filenames and page counts
//
// The guard is applied per-route below rather than with a blanket
// `router.use(...)` so the one intentionally-public read (/version, used by the
// updater before login) stays reachable. `/version` leaks only the app version,
// which the client already displays.
//
const requireDataSafety = [authMiddleware, requirePermission('data_safety.view')];
const requireBackupManagement = [authMiddleware, requirePermission('data_safety.manage')];
const requirePlatformAgencyDataSafety = [
  authMiddleware,
  requirePermission('settings.manage'),
  (req, res, next) => {
    const caller = resolveCaller(getConn(), { userId: req.user.userId });
    if (!caller || !['platform', 'agency'].includes(caller.role)) {
      throw new AuthorizationError('This whole-database operation is administrator-only');
    }
    next();
  },
];

function isCustomerTenant(req) {
  return resolveCaller(getConn(), { userId: req.user.userId })?.role === 'customer_tenant';
}

/** Central application version — the single UI/updater-facing source. */
router.get('/version', (req, res) => {
  res.json({ success: true, data: getVersionInfo() });
});

/** List existing verified backups (newest first). */
router.get('/backups', requireDataSafety, (req, res) => {
  const backups = listBackupsVerified();
  // Customer tenants can see backup status but not server file paths or source
  // database paths. They cannot restore these whole-database snapshots.
  const data = isCustomerTenant(req)
    ? backups.map(({ id, sizeBytes, createdAt, appVersion, label, verified }) => ({ id, sizeBytes, createdAt, appVersion, label, verified }))
    : backups;
  res.json({ success: true, data });
});

/** Manually create + verify a backup. */
router.post('/backups', requireBackupManagement, async (req, res) => {
  try {
    const meta = createBackup({ label: 'manual' });
    const check = verifyBackup(meta.file);
    if (!check.valid) {
      return res.status(500).json({ success: false, error: { code: 'BACKUP_VERIFICATION_FAILED', message: check.errors.join('; ') } });
    }
    const data = { ...meta, verified: true };
    if (isCustomerTenant(req)) {
      delete data.file;
      delete data.source;
    }
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'BACKUP_FAILED', message: err.message } });
  }
});

/** Verify a specific backup file. */
router.get('/backups/verify', requirePlatformAgencyDataSafety, (req, res) => {
  const file = String(req.query.file || '');
  res.json({ success: true, data: verifyBackup(file) });
});

/** Emergency restore (explicit action only; never automatic). */
router.post('/backups/restore', requirePlatformAgencyDataSafety, async (req, res) => {
  try {
    const file = req.body && (req.body.file || req.body.backup_file);
    if (!file) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Backup file path required.' } });
    const result = safeRestoreBackup(file);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: err.code || 'RESTORE_FAILED', message: err.message } });
  }
});

// ─── PHASE 2: STORAGE, MAINTENANCE, DELETION, SUPPORT ─────────────────────

/** Backup status summary for Settings → Data Safety (read-only). */
router.get('/backups/status', requireDataSafety, (req, res) => {
  res.json({ success: true, data: getBackupStatus() });
});

/** Run retention rotation manually (safe; preserves newest recovery points). */
router.post('/backups/rotate', requirePlatformAgencyDataSafety, (req, res) => {
  res.json({ success: true, data: rotateBackups() });
});

/** Storage dashboard (§22): sizes + warnings only; never CRM data. */
router.get('/storage', requireDataSafety, (req, res) => {
  res.json({ success: true, data: getStorageStatus() });
});

/** Database maintenance preview (§21): fragmentation estimate; no action. */
router.get('/maintenance/vacuum/preview', requirePlatformAgencyDataSafety, (req, res) => {
  try {
    const { getDatabasePath } = require('../config/userDataPath');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(getDatabasePath(), { readOnly: true });
    try {
      const pageCount = db.prepare('PRAGMA page_count').get().page_count;
      const freelist = db.prepare('PRAGMA freelist_count').get().freelist_count;
      const pageSize = db.prepare('PRAGMA page_size').get().page_size;
      const fragmentation = pageCount > 0 ? (freelist / pageCount) : 0;
      res.json({
        success: true,
        data: {
          page_count: pageCount, freelist_count: freelist, page_size: pageSize,
          fragmentationPercent: Math.round(fragmentation * 1000) / 10,
          recommended: freelist / (pageCount || 1) > 0.25 && pageCount * pageSize > 64 * 1024 * 1024,
          note: 'VACUUM is never run automatically. It requires an explicit confirmation and creates a verified backup first.',
        },
      });
    } finally { db.close(); }
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'MAINTENANCE_PREVIEW_FAILED', message: err.message } });
  }
});

/** VACUUM with safety rails (§21): backup → vacuum → integrity + FK verify. */
router.post('/maintenance/vacuum', requirePlatformAgencyDataSafety, (req, res) => {
  try {
    if (!req.body || req.body.confirm !== 'VACUUM') {
      return res.status(400).json({ success: false, error: { code: 'CONFIRMATION_REQUIRED', message: 'Send {"confirm":"VACUUM"} to run maintenance.' } });
    }
    const { getDatabasePath } = require('../config/userDataPath');
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = getDatabasePath();
    // Verified backup first.
    const meta = createBackup({ label: 'pre-vacuum' });
    if (!verifyBackup(meta.file).valid) {
      return res.status(500).json({ success: false, error: { code: 'BACKUP_VERIFICATION_FAILED', message: 'Pre-maintenance backup failed verification; VACUUM not run.' } });
    }
    const db = new DatabaseSync(dbPath);
    try { db.exec('VACUUM'); } finally { db.close(); }
    // Post-verification.
    const probe = new DatabaseSync(dbPath);
    let integrity, fk;
    try {
      integrity = Object.values(probe.prepare('PRAGMA integrity_check').get())[0];
      fk = probe.prepare('PRAGMA foreign_key_check').all().length;
    } finally { probe.close(); }
    if (!/ok/i.test(String(integrity)) || fk > 0) {
      const { restoreBackup } = require('../services/backupService');
      restoreBackup(meta.file, { livePath: dbPath });
      return res.status(500).json({ success: false, error: { code: 'VACUUM_VERIFY_FAILED', message: 'Post-VACUUM verification failed; pre-maintenance backup restored.' } });
    }
    res.json({ success: true, data: { vacuumed: true, backup: meta.file, integrity, fkViolations: fk } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'VACUUM_FAILED', message: err.message } });
  }
});

/** Deletion preview (step 1): scope + safety information. */
router.get('/data-deletion/preview', requirePlatformAgencyDataSafety, (req, res) => {
  res.json({ success: true, data: previewDeletion() });
});

/** Deletion step 2a: issue one-time token (requires typed confirmation below). */
router.post('/data-deletion/token', requirePlatformAgencyDataSafety, (req, res) => {
  res.json({ success: true, data: issueDeleteToken() });
});

/** Deletion step 2b: execute (needs exact typed "DELETE" + valid token). */
router.post('/data-deletion/execute', requirePlatformAgencyDataSafety, (req, res) => {
  try {
    const { typedConfirmation, token } = req.body || {};
    const result = performDeletion({ typedConfirmation, token });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.code === 'FINAL_BACKUP_FAILED' ? 409 : 400).json({
      success: false, error: { code: err.code || 'DELETION_FAILED', message: err.message },
    });
  }
});

/** Support bundle (§23): manual generation only; sanitized; never auto-sent. */
router.post('/support-bundle', requirePlatformAgencyDataSafety, async (req, res) => {
  try {
    const result = await generateSupportBundle({});
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SUPPORT_BUNDLE_FAILED', message: err.message } });
  }
});

/** Update service status (Phase 1: disabled stub). */
router.get('/update-status', requireDataSafety, async (req, res) => {
  res.json({ success: true, data: await UpdateService.getUpdateStatus() });
});

// ─── PHASE 3: UPDATE CHANNELS + SCHEMA COMPATIBILITY ──────────────────────

/** Current update channel. */
router.get('/update-channel', requireDataSafety, (req, res) => {
  // getChannel / CHANNELS are MODULE-LEVEL exports of updateService.js. They are
  // NOT statics of the exported UpdateService object, which only carries the
  // provider-facing surface (_provider, bindProvider, getCurrentVersion,
  // checkForUpdate, downloadUpdate, installUpdate, getUpdateStatus, isNewerVersion).
  // Calling UpdateService.getChannel() therefore threw a TypeError and surfaced as
  // HTTP 500 for every authorized administrator.
  res.json({ success: true, data: { channel: getChannel(), channels: CHANNELS } });
});

/** Set update channel (validates; persists to user preferences; no DB change). */
router.put('/update-channel', requirePlatformAgencyDataSafety, (req, res) => {
  try {
    const channel = String((req.body && req.body.channel) || '');
    const current = setChannel(channel);
    res.json({ success: true, data: { channel: current } });
  } catch (err) {
    res.status(400).json({ success: false, error: { code: 'INVALID_CHANNEL', message: err.message } });
  }
});

/** Schema compatibility check for a candidate update (read-only). */
router.get('/update-compatibility', requireDataSafety, (req, res) => {
  const target = String(req.query.target || '');
  if (!/^\d+\.\d+\.\d+/.test(target)) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'target version required (semver)' } });
  }
  // Same module-level contract as the two routes above — these were previously
  // UpdateService.* statics that do not exist, so the route returned 500.
  const compat = checkSchemaCompatibility({
    targetAppVersion: target,
    dbSchemaVersion: getCurrentDbSchemaVersion(),
  });
  res.json({ success: true, data: compat });
});

module.exports = router;
