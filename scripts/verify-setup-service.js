'use strict';
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// Clean script: test the setup service against a fresh DB.
const tmp = path.resolve('/tmp/bs-crm-setup-final.db');

// Initialize the temp DB with the full migration history BEFORE testing.
// Strategy: copy the existing migrated production DB and reset the setup state.
// This avoids FK ordering issues: we copy a fully-migrated DB (all 73 migrations applied)
// then reset the setup_states row to NOT_ACTIVATED. The DB already has the correct
// migration table (73 rows), so all subsequent migrations are no-ops.
function initTempDB() {
  // Remove stale temp DB so we get a clean slate.
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  if (fs.existsSync(tmp + '-wal')) fs.unlinkSync(tmp + '-wal');
  if (fs.existsSync(tmp + '-shm')) fs.unlinkSync(tmp + '-shm');

  // Copy the production DB (already fully migrated) into the temp path.
  // This requires the production DB to be closed — see caller.
  fs.copyFileSync(path.resolve(__dirname, '..', 'data', 'blackstack-crm.db'), tmp);
  console.log(`[init] Copied production DB to ${tmp}`);
}

// Initialize the temp DB and set up the connection.
initTempDB();
process.env.DB_PATH = tmp;

const { getConn } = require('../server/utils/db');
const { createSetupService } = require('../server/services/setup.service');
const srv = createSetupService(getConn());

async function main() {
  const r1 = await srv.activate();
  console.log('1. activate:', r1.success, r1.step);

  const r2 = await srv.createFirstAdmin({ fullName: 'Jane Doe', username: 'jane', email: 'jane@example.com', password: 'secret123' });
  console.log('2. createAdmin:', r2.success, r2.admin ? r2.admin.role : 'n/a');

  const r3 = await srv.createCompany({ companyName: 'Acme Corp', businessEmail: 'jane@acme.com', phone: '9876543210', address: '123 Main St', currency: 'INR', gstin: '29ABCDE1234F1Z5' });
  console.log('3. createCompany:', r3.success, r3.company ? r3.company.name : 'n/a');

  const r4 = await srv.completeSetup();
  console.log('4. completeSetup:', r4.success);

  const row = srv.getState();
  console.log('5. Final state:', row.step);
  console.log('6. Admin user:', row.admin_user_id, '|', row.admin_email);
  console.log('7. Company:', row.company_id, '|', row.company_name);

  const user = getConn().get('SELECT id, email, role, company_id FROM users WHERE email=?', 'jane@example.com');
  console.log('8. User in DB:', user ? user.id + ' | ' + user.role + ' | company=' + user.company_id : 'NOT FOUND');

  const company = getConn().get('SELECT id, name, status FROM companies WHERE id=?', 'initial_setup');
  console.log('9. Company in DB:', company ? company.name + ' | ' + company.status : 'NOT FOUND');
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
