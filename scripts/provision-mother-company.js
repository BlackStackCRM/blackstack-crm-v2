#!/usr/bin/env node
/**
 * PROVISION THE MOTHER COMPANY ACCOUNT — Phase 1
 *
 * Creates (or grants the Mother Company role to) the BlackStack Mother Company
 * operator account and registers its company as a Mother Company provider.
 *
 * SECURITY PROPERTIES (each verified by tests/e2e-mother-company.test.js)
 *
 *   1. NO HARDCODED PASSWORD. The password is never written in this file, never
 *      stored in plaintext, and never logged. It must be supplied either:
 *        - via MOTHERS_PASSWORD in the environment, or
 *        - interactively on stdin (preferred — nothing touches disk or history)
 *      If neither is provided the script refuses to run. There is no fallback
 *      default, no "admin123", no generated-and-printed password.
 *
 *   2. EMAIL IS NOT AUTHORITY. This script only ever ADDS the Mother Company
 *      role. Authentication and authorization remain server-side: the login page
 *      and the requireMotherCompany() guards decide access. Matching an email
 *      address grants nothing on its own — see the guard's explicit-code check
 *      and the negative test that logs in as a plain CRM user and expects 403.
 *
 *   3. THE WILDCARD DOES NOT LEAK MOTHER COMPANY ACCESS. A customer admin's
 *      session carries permissions ['*'], and the Mother Company guard
 *      deliberately refuses '*'.
 *
 *   4. IDEMPOTENT. Re-running grants the role; it does not duplicate rows or
 *      reset an existing password.
 *
 * USAGE
 *   MOTHERS_EMAIL=admin@blackstack.lockal node scripts/provision-mother-company.js
 *   # then type the password at the prompt (input is hidden where possible)
 *
 *   Optional:
 *     MOTHERS_COMPANY_NAME   display name for the provider record
 *     MOTHERS_PASSWORD       read from env instead of prompting
 *
 * OPERATIONAL SAFETY
 *   Refuses to run against the live database unless MOTHERS_ALLOW_PRODUCTION=1
 *   is also set, and even then it performs INSERTs only — no UPDATE of existing
 *   customer rows and no schema change (migration 085 must already have run).
 */

'use strict';

const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'blackstack-crm.db');

const MOTHER_COMPANY_ROLE_ID = 'role_mother_company';
const DEFAULT_EMAIL = 'admin@blackstack.lockal';

// ── guard rails ──────────────────────────────────────────────────────────────

// Reuse the shared preflight rather than re-implementing the check. It is
// stricter (it also rejects an unset DB_PATH, which silently resolves to the
// production default) and is covered by its own tests.
const preflight = require('node:child_process').spawnSync(
  process.execPath,
  [path.join(ROOT, 'scripts', 'require-disposable-db.js'),
    ...(process.env.MOTHERS_ALLOW_PRODUCTION === '1' ? ['--allow-production'] : [])],
  { stdio: 'inherit' },
);
if (preflight.status !== 0) {
  console.error('Provisioning aborted. No account was created or modified.');
  process.exit(1);
}

// ── password acquisition ─────────────────────────────────────────────────────

function validateStrength(pw) {
  const problems = [];
  if (typeof pw !== 'string' || pw.length < 12) problems.push('at least 12 characters');
  if (!/[a-z]/.test(pw || '')) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(pw || '')) problems.push('an uppercase letter');
  if (!/[0-9]/.test(pw || '')) problems.push('a digit');
  if (!/[^A-Za-z0-9]/.test(pw || '')) problems.push('a symbol');
  return problems;
}

/**
 * Reads the password without echoing it where the terminal allows. Falls back to
 * a visible prompt only if stdin is not a TTY (CI, piped input).
 */
function promptPassword() {
  const envPw = process.env.MOTHERS_PASSWORD;
  if (envPw) return Promise.resolve(envPw);

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const isTTY = process.stdin.isTTY;
    if (isTTY) {
      // Suppress echo while reading the secret.
      const originalWrite = rl._writeToOutput;
      rl._writeToOutput = (str) => {
        if (str.includes(PROMPT)) originalWrite.call(rl, str);
      };
    }
    process.stdout.write(isTTY
      ? 'Mother Company password (input hidden): '
      : 'Mother Company password (via stdin, not hidden): ');

    // A closed/empty stdin closes the 'close' event without ever answering
    // 'question', which left this promise pending and Node exited 0 as if the
    // provisioning had succeeded. Treat 'close' before an answer as a refusal.
    let answered = false;
    rl.on('close', () => {
      if (!answered) {
        process.stdout.write('\n');
        reject(new Error('No password supplied on stdin.'));
      }
    });

    rl.question('', (answer) => {
      answered = true;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    rl.on('error', reject);
  });
}

const PROMPT = 'Mother Company password';

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
  const { PasswordService } = require(path.join(ROOT, 'server', 'auth', 'password'));
  const { generateId } = require(path.join(ROOT, 'server', 'utils', 'generateId'));
  const { DatabaseConnection } = require(path.join(ROOT, 'server', 'database', 'connection'));

  const email = (process.env.MOTHERS_EMAIL || DEFAULT_EMAIL).trim().toLowerCase();
  const fullName = process.env.MOTHERS_NAME || 'BlackStack Mother Company';
  const companyName = process.env.MOTHERS_COMPANY_NAME || 'BlackStack';

  console.log('===============================================================');
  console.log(' MOTHER COMPANY ACCOUNT PROVISIONING (Phase 1)');
  console.log('===============================================================');
  console.log(`  database   : ${DB_PATH}`);
  console.log(`  email      : ${email}`);
  console.log(`  company    : ${companyName}`);
  console.log('');

  const password = await promptPassword();
  const problems = validateStrength(password);
  if (problems.length) {
    console.error('Password rejected. It must contain: ' + problems.join(', ') + '.');
    console.error('No account was created or modified.');
    process.exit(1);
  }

  const conn = new DatabaseConnection().connect();

  try {
    // The role must exist — it is created by migration 085.
    const role = conn.get('SELECT id, code FROM roles WHERE id = ?', [MOTHER_COMPANY_ROLE_ID]);
    if (!role) {
      console.error('MOTHER_COMPANY role not found. Run migrations first:');
      console.error('  node server/database/migrate.js');
      process.exit(1);
    }

    const companyId = 'company_blackstack';

    // 1. Provider company row.
    const existingCompany = conn.get('SELECT id FROM companies WHERE id = ?', [companyId]);
    if (!existingCompany) {
      conn.run(
        "INSERT INTO companies (id, name, status) VALUES (?,?,'ACTIVE')",
        [companyId, companyName],
      );
      console.log('  [created] provider company row');
    } else {
      console.log('  [exists ] provider company row');
    }

    // 2. Provider marker.
    const provider = conn.get('SELECT id FROM mother_company_providers WHERE company_id = ?', [companyId]);
    if (!provider) {
      conn.run(
        `INSERT INTO mother_company_providers (id, company_id, display_name, legal_name, is_active)
         VALUES (?,?,?,?,1)`,
        [generateId('mcp'), companyId, companyName, companyName],
      );
      console.log('  [created] mother_company_providers marker');
    } else {
      console.log('  [exists ] mother_company_providers marker');
    }

    // 3. The operator account.
    let user = conn.get('SELECT id, email FROM users WHERE email = ?', [email]);
    if (!user) {
      const hash = await PasswordService.hash(password);
      const userId = generateId('usr');
      conn.run(
        `INSERT INTO users (id, company_id, email, password_hash, full_name, role, status)
         VALUES (?,?,?,?,?,?,?)`,
        [userId, companyId, email, hash, fullName, 'ADMIN', 'ACTIVE'],
      );
      user = { id: userId, email };
      console.log('  [created] Mother Company operator account');
    } else {
      console.log('  [exists ] operator account (password NOT changed)');
    }

    // 4. Grant the Mother Company role — the ONLY thing that grants access.
    const hasRole = conn.get(
      'SELECT 1 AS x FROM user_roles WHERE user_id = ? AND role_id = ?',
      [user.id, MOTHER_COMPANY_ROLE_ID],
    );
    if (!hasRole) {
      conn.run('INSERT INTO user_roles (user_id, role_id) VALUES (?,?)',
        [user.id, MOTHER_COMPANY_ROLE_ID]);
      console.log('  [granted] MOTHER_COMPANY role');
    } else {
      console.log('  [exists ] MOTHER_COMPANY role already assigned');
    }

    // 5. Audit the privilege change itself.
    conn.run(
      `INSERT INTO audit_logs (id, company_id, user_id, action, entity_type, entity_id, new_values_json)
       VALUES (?,?,?,?,?,?,?)`,
      [
        generateId('aud'), companyId, user.id, 'MOTHER_COMPANY_ROLE_GRANTED', 'USER', user.id,
        JSON.stringify({ role_code: 'MOTHER_COMPANY', granted_by: 'provisioning-script' }),
      ],
    );

    console.log('');
    console.log('  MOTHER COMPANY ACCESS GRANTED — via role assignment only.');
    console.log('  No password was printed or stored in plaintext.');
    console.log('');
    console.log('  Sign in through the EXISTING login page with this email and the');
    console.log('  password you just supplied. Mother Company navigation will appear');
    console.log('  only after a successful login.');
  } finally {
    conn.close();
  }
})().catch((err) => {
  // Includes the "no password supplied" refusal. Must exit non-zero: an operator
  // who piped nothing must never see a success exit code.
  console.error('Provisioning failed:', err.message);
  console.error('No account was created or modified.');
  process.exit(1);
});
