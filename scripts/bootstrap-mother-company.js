#!/usr/bin/env node
/**
 * SECURE ONE-TIME BOOTSTRAP — Mother Company Admin Account
 * ==========================================================
 *
 * Creates the first Supabase Auth identity for `admin@blackstack.local` and
 * associates it with the existing Mother Company architecture (role_mother_company,
 * mother_company_providers, local SQLite mirror).
 *
 * This is a SERVER-SIDE ONLY script. It requires a Supabase admin secret key,
 * which must NEVER be present in desktop builds, packaged .env files, or
 * frontend bundles.
 *
 * Supported environment variables (precedence order):
 *   SUPABASE_SECRET_KEY  — preferred. New Supabase Secret API Key format
 *                          (`sb_secret_...`). Read from the Supabase project
 *                          dashboard (Settings → API).
 *   SUPABASE_SERVICE_ROLE_KEY — legacy fallback. Legacy service_role JWT key.
 *
 * Precedence: SUPABASE_SECRET_KEY wins if set; otherwise SUPABASE_SERVICE_ROLE_KEY
 * is used. If neither is set, the script fails closed (exit code 1).
 *
 * USAGE:
 *   # Provide password via environment variable (recommended for automation):
 *   SUPABASE_SECRET_KEY=<key> BOOTSTRAP_PASSWORD=<password> node scripts/bootstrap-mother-company.js
 *
 *   # Or provide password interactively with hidden input:
 *   SUPABASE_SECRET_KEY=<key> node scripts/bootstrap-mother-company.js
 *
 *   # Legacy key format:
 *   SUPABASE_SERVICE_ROLE_KEY=<key> BOOTSTRAP_PASSWORD=<password> node scripts/bootstrap-mother-company.js
 *
 * Password security:
 *   - The password is NEVER printed to stdout or stderr.
 *   - The password is NEVER logged, persisted, or returned in structured output.
 *   - Provide it via BOOTSTRAP_PASSWORD environment variable or hidden interactive input.
 *   - Existing Auth users are never password-reset.
 *
 * EXIT CODES:
 *   0 — success (account created or already existed, fully provisioned)
 *   1 — configuration error (missing key, wrong project, etc.)
 *   2 — partial failure (Auth user created, local provisioning failed — manual recovery needed)
 */

'use strict';

const { randomBytes } = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { createClient: supabaseCreateClient } = require('@supabase/supabase-js');

// ── Configuration ─────────────────────────────────────────────────────────

const EXPECTED_PROJECT_REF = 'qzxvcxywotqeqvwerofi';
const TARGET_EMAIL = 'admin@blackstack.local';
const DEFAULT_DB_PATH = path.join(__dirname, '../data/blackstack-crm.db');

function fail(message, code = 1) {
  console.error(`[bootstrap] FATAL: ${message}`);
  process.exit(code);
}

function warn(message) {
  console.error(`[bootstrap] WARN: ${message}`);
}

function info(message) {
  console.log(`[bootstrap] ${message}`);
}

// ── Server-side admin secret key resolution ────────────────────────────────
//
// Reads a Supabase admin secret key exclusively from trusted server-side
// environment variables. Supports two formats:
//
//   1. SUPABASE_SECRET_KEY  — preferred. New Supabase Secret API Key format
//      (`sb_secret_...`). Provided by the Supabase Dashboard.
//   2. SUPABASE_SERVICE_ROLE_KEY — legacy fallback. Legacy service_role JWT key.
//
// Precedence: SUPABASE_SECRET_KEY wins if set; otherwise fall back to
// SUPABASE_SERVICE_ROLE_KEY. Returns null if neither is set (fail-safe).
//
// The key value is NEVER logged, never included in error messages, and never
// returned to callers (only a boolean "is configured" signal is exposed).

function resolveAdminSecretKey() {
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (secretKey && secretKey.trim()) {
    return secretKey.trim();
  }
  if (serviceRoleKey && serviceRoleKey.trim()) {
    return serviceRoleKey.trim();
  }
  return null;
}

function isValidSecretKeyFormat(key) {
  if (!key || !key.trim()) return false;
  const trimmed = key.trim();
  // New format: sb_secret_...  |  Legacy format: non-empty JWT-style string
  return trimmed.startsWith('sb_secret_') || trimmed.length > 0;
}

// ── Secure password input ─────────────────────────────────────────────────

/**
 * Obtains the bootstrap password securely.
 *
 * Precedence:
 *   1. BOOTSTRAP_PASSWORD environment variable (recommended for automation)
 *   2. Hidden interactive input (readline with echo disabled)
 *
 * The password is never echoed, logged, or returned to any output stream.
 */
function resolveBootstrapPassword() {
  const envPassword = process.env.BOOTSTRAP_PASSWORD;
  if (envPassword && envPassword.trim()) {
    return envPassword.trim();
  }

  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  return new Promise((resolve) => {
    process.stdout.write('Enter bootstrap password for admin@blackstack.local: ');

    // Disable echo for hidden input
    process.stdin.setRawMode(true);

    let password = '';
    const onData = (char) => {
      char = char.toString();
      if (char === '\r' || char === '\n') {
        process.stdout.write('\n');
        process.stdin.setRawMode(false);
        process.stdin.removeListener('data', onData);
        rl.close();
        resolve(password);
      } else if (char === '\u0003') {
        // Ctrl+C
        process.stdout.write('\n');
        process.stdin.setRawMode(false);
        process.stdin.removeListener('data', onData);
        rl.close();
        process.exit(1);
      } else if (char === '\u0008' || char === '\u007f') {
        // Backspace / delete
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (char.length === 1) {
        password += char;
        process.stdout.write('*');
      }
    };

    process.stdin.on('data', onData);
  });
}

// ── Environment validation (deferred to main() so the module can be imported for testing) ──

function validateConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const adminSecretKey = resolveAdminSecretKey();

  if (!supabaseUrl || !supabaseUrl.trim()) {
    fail('SUPABASE_URL is not set. Provide it via environment variable.', 1);
  }

  const urlObj = new URL(supabaseUrl);
  const projectRef = urlObj.hostname.split('.')[0];
  if (projectRef !== EXPECTED_PROJECT_REF) {
    fail(
      `Supabase project mismatch: expected ${EXPECTED_PROJECT_REF}, ` +
        `URL points to ${projectRef}. Refusing to operate on wrong project.`,
      1,
    );
  }

  if (!adminSecretKey) {
    fail(
      'No Supabase admin secret key configured. Set SUPABASE_SECRET_KEY (new ' +
        'Secret API Key format, preferred) or SUPABASE_SERVICE_ROLE_KEY (legacy) ' +
        'via environment variable. This key is required for auth.admin.* ' +
        'operations and must NEVER be in desktop builds.',
      1,
    );
  }

  if (!isValidSecretKeyFormat(adminSecretKey)) {
    fail('Configured Supabase admin secret key is empty or invalid.', 1);
  }

  info(`Supabase project confirmed: ${projectRef}`);
  return supabaseUrl;
}

// ── Strong password generation (server-side, never logged) ────────────────

function generateStrongPassword() {
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?';
  const bytes = randomBytes(32);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

// ── Step 1: Check if account already exists in Supabase Auth ─────────────

async function checkExistingAuthUser(sbAdmin) {
  const { data, error } = await sbAdmin.auth.admin.listUsers();
  if (error) {
    fail(`auth.admin.listUsers() failed: ${error.message}`, 1);
  }
  const existing = data.users.find(
    (u) => u.email && u.email.toLowerCase() === TARGET_EMAIL.toLowerCase(),
  );
  if (existing) {
    info(`Supabase Auth account already exists: ${TARGET_EMAIL} (uid=${existing.id})`);
    info('Stopping — no password reset, no identity change (per security constraints).');
    return existing;
  }
  info(`No existing Supabase Auth account for ${TARGET_EMAIL}. Proceeding to create.`);
  return null;
}

// ── Step 2: Create Supabase Auth user ────────────────────────────────────

async function createAuthUser(sbAdmin, password) {
  const { data, error } = await sbAdmin.auth.admin.createUser({
    email: TARGET_EMAIL,
    password,
    email_confirm: true,
    app_metadata: {
      role: 'platform',
      agency_id: 'default',
      parent_user_id: null,
    },
  });
  if (error) {
    fail(`auth.admin.createUser() failed: ${error.message}`, 1);
  }
  if (!data || !data.user) {
    fail('auth.admin.createUser() returned no user data.', 1);
  }
  info(`Supabase Auth account created: ${TARGET_EMAIL} (uid=${data.user.id})`);
  return data.user;
}

// ── Step 3: Provision local SQLite mirror ────────────────────────────────

function provisionLocalMirror(supabaseUserId, password, q, qAll, qRun, localDb) {
  const tx = () => {
    // Ensure the local user row exists (idempotent)
    const existing = q(
      "SELECT id, email, username, role, status, supabase_user_id FROM users WHERE email = ?",
      [TARGET_EMAIL],
    );

    if (existing) {
      info(`Local user row already exists: id=${existing.id}, role=${existing.role}, status=${existing.status}`);
      // Update supabase_user_id if not already bound
      if (!existing.supabase_user_id || existing.supabase_user_id !== supabaseUserId) {
        qRun(
          'UPDATE users SET supabase_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [supabaseUserId, existing.id],
        );
        info(`Bound local user id=${existing.id} to Supabase UUID ${supabaseUserId}`);
      }
    } else {
      // Create the local mirror row
      qRun(
        `INSERT INTO users (id, company_id, username, email, password_hash, full_name, role, status, hierarchy_role, supabase_user_id)
         VALUES (?, ?, ?, ?, ?, ?, 'ADMIN', 'ACTIVE', NULL, ?)`,
        ['admin', 'default', 'admin', TARGET_EMAIL, '', 'System Administrator', supabaseUserId],
      );
      info(`Local user row created: id=admin, email=${TARGET_EMAIL}, role=ADMIN, supabase_user_id=${supabaseUserId}`);
    }

    // Assign role_mother_company (idempotent)
    const role = q("SELECT id FROM roles WHERE code = 'MOTHER_COMPANY'");
    if (!role) {
      throw new Error('role_mother_company not found in roles table — migration 085 may not be applied.');
    }
    const assigned = q(
      'SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ?',
      [existing ? existing.id : 'admin', role.id],
    );
    if (!assigned) {
      qRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [
        existing ? existing.id : 'admin',
        role.id,
      ]);
      info(`Assigned role_mother_company to local user.`);
    } else {
      info(`role_mother_company already assigned to local user.`);
    }

    // Ensure mother_company_providers mapping exists (idempotent)
    const provider = q('SELECT id FROM mother_company_providers WHERE company_id = ?', [
      'default',
    ]);
    if (!provider) {
      qRun(
        `INSERT INTO mother_company_providers (id, company_id, display_name, legal_name, contact_email, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        ['mc_provider_001', 'default', 'BlackStack Mother Company', 'BlackStack CRM', TARGET_EMAIL],
      );
      info(`Created mother_company_providers mapping for company 'default'.`);
    } else {
      info(`mother_company_providers mapping already exists.`);
    }
  };

  localDb.exec('BEGIN');
  try {
    tx();
    localDb.exec('COMMIT');
  } catch (e) {
    localDb.exec('ROLLBACK');
    throw e;
  }
}

// ── Step 4: Verify local state ───────────────────────────────────────────

function verifyLocalState(supabaseUserId, q, qAll) {
  const user = q(
    "SELECT id, email, username, role, status, hierarchy_role, supabase_user_id FROM users WHERE email = ?",
    [TARGET_EMAIL],
  );
  if (!user) throw new Error('Local user row not found after provisioning.');
  if (user.supabase_user_id !== supabaseUserId) {
    throw new Error(
      `Local supabase_user_id (${user.supabase_user_id}) does not match Auth UUID (${supabaseUserId}).`,
    );
  }
  if (user.role !== 'ADMIN') {
    throw new Error(`Local user role is ${user.role}, expected ADMIN.`);
  }
  if (user.status.toUpperCase() !== 'ACTIVE') {
    throw new Error(`Local user status is ${user.status}, expected ACTIVE.`);
  }

  const roles = qAll(
    `SELECT r.code FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?`,
    [user.id],
  );
  const roleCodes = roles.map((r) => r.code);
  if (!roleCodes.includes('MOTHER_COMPANY')) {
    throw new Error('role_mother_company not assigned to local user.');
  }
  if (!roleCodes.includes('ADMIN')) {
    throw new Error('role_admin not assigned to local user.');
  }

  const provider = q(
    'SELECT id FROM mother_company_providers WHERE company_id = ?',
    ['default'],
  );
  if (!provider) {
    throw new Error('mother_company_providers mapping missing for company default.');
  }

  return user;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  // Validate configuration before creating any clients.
  const supabaseUrl = validateConfig();

  let authUser = null;
  let localUser = null;
  let password = null;

  // Create Supabase admin client (server-side only).
  const adminSecretKey = resolveAdminSecretKey();
  const sbAdmin = supabaseCreateClient(supabaseUrl, adminSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Open local SQLite connection.
  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
  const resolvedDbPath = path.isAbsolute(dbPath)
    ? path.normalize(dbPath)
    : path.resolve(process.cwd(), dbPath);

  info(`Local database: ${resolvedDbPath}`);

  let localDb;
  try {
    localDb = new DatabaseSync(resolvedDbPath);
  } catch (e) {
    fail(`Cannot open local database at ${resolvedDbPath}: ${e.message}`, 1);
  }

  function q(sql, params = []) {
    return localDb.prepare(sql).get(...params);
  }

  function qAll(sql, params = []) {
    return localDb.prepare(sql).all(...params);
  }

  function qRun(sql, params = []) {
    return localDb.prepare(sql).run(...params);
  }

  try {
    // Step 1: Check existing
    authUser = await checkExistingAuthUser(sbAdmin);

    if (!authUser) {
      // Step 2: Obtain password securely and create
      password = await resolveBootstrapPassword();
      authUser = await createAuthUser(sbAdmin, password);
    }

    // Step 3: Provision local mirror
    provisionLocalMirror(authUser.id, password, q, qAll, qRun, localDb);

    // Step 4: Verify
    localUser = verifyLocalState(authUser.id, q, qAll);

    info('Bootstrap complete.');
    info(`  Supabase Auth UUID: ${authUser.id}`);
    info(`  Local user id: ${localUser.id}`);
    info(`  Roles: ADMIN, MOTHER_COMPANY`);
    info(`  Provider mapping: default → BlackStack Mother Company`);

    process.exit(0);
  } catch (e) {
    // Partial failure: if Auth user was created but local provisioning failed,
    // preserve the Auth user and report clearly for manual recovery.
    if (authUser && !localUser) {
      warn('PARTIAL FAILURE: Supabase Auth user was created but local provisioning failed.');
      warn(`Auth UUID: ${authUser.id}`);
      warn(`Error: ${e.message}`);
      warn('Do NOT re-run blindly — this would attempt to create a duplicate Auth user.');
      warn('Manual recovery: run this script again; it will detect the existing Auth user and');
      warn('skip creation, then proceed with local provisioning.');
      process.exit(2);
    }
    fail(`Bootstrap failed: ${e.message}`, 1);
  } finally {
    localDb.close();
  }
}

module.exports = {
  validateConfig,
  generateStrongPassword,
  checkExistingAuthUser,
  createAuthUser,
  provisionLocalMirror,
  verifyLocalState,
  resolveAdminSecretKey,
  isValidSecretKeyFormat,
  fail,
  warn,
  info,
};

if (require.main === module) {
  main().catch((e) => {
    fail(`Unexpected error: ${e.message}`, 1);
  });
}
