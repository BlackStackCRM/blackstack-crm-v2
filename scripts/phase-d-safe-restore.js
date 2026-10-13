#!/usr/bin/env node
/**
 * Phase D Step 3 — exercise the application's REAL safe restore path.
 *
 * Calls backupService.safeRestoreBackup(backupFile, { livePath }), which:
 *   1. verifies the backup BEFORE touching the live database,
 *   2. takes a pre-restore backup of the live DB,
 *   3. restores via restoreBackup() (quarantine + post-restore verify),
 *   4. rolls back to the pre-restore backup if the restore throws.
 *
 * Usage: node phase-d-safe-restore.js <liveDb> <backupFile>
 */
const path = require('path');

const live = path.resolve(process.argv[2] || '');
const backup = path.resolve(process.argv[3] || '');
if (!live || !backup) { console.error('usage: phase-d-safe-restore.js <liveDb> <backupFile>'); process.exit(2); }

process.env.DB_PATH = live;
process.env.BLACKSTACK_USER_DATA_DIR = path.join(path.dirname(path.dirname(live)), 'userdata');
process.env.BLACKSTACK_USER_DATA = process.env.BLACKSTACK_USER_DATA_DIR;
process.env.DEMO_MODE = 'true';

async function main() {
  const svc = require('../server/services/backupService');

  // Show what the safety check does on its own first.
  const check = svc.verifyBackup(backup);
  console.log(`[restore] verifyBackup valid : ${check.valid}`);
  if (!check.valid) console.log(`[restore] verifyBackup errors : ${check.errors.join('; ')}`);
  if (!check.valid) { process.exit(3); }

  // Prove the guard rejects a CORRUPT backup rather than restoring it.
  const os = require('os');
  const fs = require('fs');
  const corrupt = path.join(os.tmpdir(), `pd3-corrupt-${Date.now()}.sqlite`);
  const buf = fs.readFileSync(backup);
  for (let i = Math.floor(buf.length / 2); i < Math.floor(buf.length / 2) + 8192; i++) buf[i] ^= 0xff;
  fs.writeFileSync(corrupt, buf);
  const badCheck = svc.verifyBackup(corrupt);
  console.log(`[restore] corrupt backup rejected by verifyBackup: ${badCheck.valid === false}`);
  const beforeCorrupt = fs.existsSync(live) ? fs.readFileSync(live).length : -1;
  try {
    svc.safeRestoreBackup(corrupt, { livePath: live });
    console.log('[restore] ERROR: safeRestoreBackup accepted a corrupt backup');
    process.exitCode = 4;
  } catch (e) {
    console.log(`[restore] corrupt restore refused: ${e.code || ''} ${e.message.slice(0, 110)}`);
  }
  const afterCorrupt = fs.existsSync(live) ? fs.readFileSync(live).length : -1;
  console.log(`[restore] live DB untouched by the refused restore: ${beforeCorrupt === afterCorrupt}`);

  // Now the real restore.
  const res = svc.safeRestoreBackup(backup, { livePath: live });
  console.log(`[restore] safeRestoreBackup -> ${JSON.stringify(res)}`);
  process.exit(res && (res.ok || res.restored || res.success) ? 0 : 1);
}

main().catch((e) => { console.error('[restore] FAILED:', e.message); process.exit(1); });
