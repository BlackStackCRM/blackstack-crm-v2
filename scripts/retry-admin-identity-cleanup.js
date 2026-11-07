#!/usr/bin/env node
/* Retry durable agency-admin hard-delete jobs. Dry-run unless --apply is set. */
const { getConn } = require('../server/utils/db');
const { AgencyControlService } = require('../server/services/agencyControl.service');

async function main() {
  const apply = process.argv.includes('--apply');
  const db = getConn();
  const pending = db.all(
    `SELECT agency_admin_id, phase, attempts, last_error
     FROM admin_identity_cleanup_queue WHERE phase <> 'COMPLETE' ORDER BY created_at`,
  );
  console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY_RUN', pending: pending.map((row) => ({
    administratorId: row.agency_admin_id,
    phase: row.phase,
    attempts: row.attempts,
    lastError: row.last_error,
  })) }, null, 2));
  if (!apply || !pending.length) return;

  const admin = db.get("SELECT id FROM users WHERE upper(role)='ADMIN' ORDER BY created_at LIMIT 1");
  if (!admin) throw new Error('No platform administrator is available to authorize pending cleanup retries.');
  const service = new AgencyControlService(db);
  const outcomes = [];
  for (const row of pending) {
    try {
      await service.permanentlyDeleteAdministrator(admin.id, row.agency_admin_id);
      outcomes.push({ administratorId: row.agency_admin_id, completed: true });
    } catch (error) {
      outcomes.push({ administratorId: row.agency_admin_id, completed: false, code: error.code || 'ERROR' });
    }
  }
  console.log(JSON.stringify({ outcomes }, null, 2));
  if (outcomes.some((outcome) => !outcome.completed)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Admin identity cleanup retry failed: ${error.message}`);
  process.exitCode = 1;
});
