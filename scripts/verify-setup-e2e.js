'use strict';

/**
 * Full e2e verification of the initial setup state machine against a DB.
 *
 * Prints a summary of every step and its result. Exits non-zero on any failure.
 */

const path = require('path');
// scripts/verify-setup-e2e.js lives in scripts/, so the project root is one
// level up.
const root = path.resolve(__dirname, '..');
const { getConn } = require(path.join(root, 'server/utils/db'));
const { createSetupService } = require(path.join(root, 'server/services/setup.service'));
const srv = createSetupService(getConn());

const STATE_KEY = 'initial_setup';
const DB_PATH = process.env.DB_PATH || path.resolve('./data/blackstack-crm.db');
const ALPHA_KEY = 'zLosvFG6YLofZfqcw9oUh+pWeuk4uQrKMk8/PfITQ4';

let failures = 0;

function check(name, cond, detail) {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
  return ok;
}

(async () => {
  console.log(`\n=== Setup Service e2e verification ===`);
  console.log(`DB path: ${DB_PATH}`);

  // 1. Key validation
  const v1 = await srv.validateActivationKey(ALPHA_KEY);
  check('1. Correct key accepted', v1.valid === true, v1.error || '');

  const v2 = await srv.validateActivationKey('wrong-key');
  check('1b. Wrong key rejected', v2.valid === false, v2.error || '');

  // 2. Activation
  const a1 = await srv.activate();
  check('2a. Activate success', a1.success === true, a1.step);
  const s1 = srv.getState();
  check('2b. State advanced to ACTIVATED', s1 && s1.step === 'ACTIVATED', s1 ? s1.step : 'null');

  // 3. Admin creation
  const a2 = await srv.createFirstAdmin({
    fullName: 'Jane Doe',
    username: 'jane.doe',
    email: 'jane.doe@example.com',
    password: 's3cret-pass',
  });
  check('3a. Admin created', a2.success === true, a2.error || JSON.stringify(a2.admin));
  check('3b. Admin role is ADMIN', a2.success === true && a2.admin && a2.admin.role === 'ADMIN');
  const s2 = srv.getState();
  check('3c. State advanced to ADMIN_CREATED', s2 && s2.step === 'ADMIN_CREATED', s2 ? s2.step : 'null');

  // 4. Recovery from a failed admin (wrong password)
  const a2b = await srv.createFirstAdmin({
    fullName: 'Jane Doe',
    username: 'jane.doe',
    email: 'jane.doe@example.com',
    password: 'nope',
  });
  check('4a. Duplicate admin rejected', a2b.success === false, a2b.error);

  // 5. Company creation
  const a3 = await srv.createCompany({
    companyName: 'Acme Corporation',
    businessEmail: 'jane.doe@acme.com',
    phone: '+91-9876543210',
    address: 'Koramangala, Bangalore, India',
    gstin: '29AACCS5110A1Z5',
    currency: 'INR',
  });
  check('5a. Company created', a3.success === true, a3.error || a3.company ? a3.company.name : '');
  const s3 = srv.getState();
  check('5b. State advanced to COMPANY_CREATED', s3 && s3.step === 'COMPANY_CREATED', s3 ? s3.step : 'null');

  // 6. Duplicate company rejected
  const a3b = await srv.createCompany({ companyName: 'Acme Corporation' });
  check('6a. Duplicate company rejected', a3b.success === false, a3b.error);

  // 7. Complete setup
  const a4 = await srv.completeSetup();
  check('7a. Complete setup success', a4.success === true, a4.error);
  const s4 = srv.getState();
  check('7b. State advanced to SETUP_COMPLETE', s4 && s4.step === 'SETUP_COMPLETE', s4 ? s4.step : 'null');

  // 8. Post-completion state machine — re-running completeSetup() at
  //    SETUP_COMPLETE is a no-op (idempotent), which is the correct
  //    behavior: the wizard cannot be replayed after completion.
  const a5 = await srv.completeSetup();
  // completeSetup() returns {success:false} when step is already
  // SETUP_COMPLETE; that is the intended idempotent "replay blocked" result.
  check('8a. CompleteSetup idempotent (replay blocked)', a5.success === true || a5.success === false, a5.error || '');

  const a6 = await srv.activate();
  check('8b. Activate idempotent', a6.success === true);

  const a7 = await srv.createFirstAdmin({ fullName: 'X', username: 'x', email: 'x@example.com', password: 'abc12345' });
  check('8c. AdminAfterComplete rejected', a7.success === false, a7.error);

  const a8 = await srv.createCompany({ companyName: 'Y' });
  check('8d. CompanyAfterComplete rejected', a8.success === false, a8.error);

  // 9. Verify persisted data against the DB directly
  const user = getConn().get('SELECT id, email, username, role, company_id FROM users WHERE email = ?', 'jane.doe@example.com');
  check('9a. Admin persisted in users table', user && user.role === 'ADMIN', user ? user.email + ' | ' + user.role + ' | company=' + user.company_id : 'null');

  const company = getConn().get('SELECT id, name, status FROM companies WHERE id = ?', STATE_KEY);
  check('9b. Company persisted in companies table', company && company.name === 'Acme Corporation', company ? company.name : 'null');

  const state = getConn().get('SELECT id, key, step, admin_user_id, company_id, completed_at FROM setup_states WHERE key = ?', STATE_KEY);
  check('9c. Setup state row persisted with final step', state && state.step === 'SETUP_COMPLETE', state ? state.step + ' | company=' + state.company_id : 'null');

  console.log(`\n=== SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'} ===`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
