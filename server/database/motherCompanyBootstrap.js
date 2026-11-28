/**
 * MOTHER COMPANY ADMIN MIRROR — idempotent local bootstrap (Second-PC login fix).
 *
 * WHY THIS EXISTS
 *   Authentication is Supabase-only (server/services/auth.service.js): the local
 *   `users.password_hash` column is NEVER used to verify a password. The login
 *   flow verifies the password in Supabase, then resolves a LOCAL mirror row by
 *   the Supabase auth UUID (and email fallback) to build the session.
 *
 *   The Laptop works because its SQLite already holds the Mother Company mirror
 *   row (id='admin', company_id='default', role='ADMIN', status='ACTIVE',
 *   supabase_user_id=21e8db5d-ba09-4a63-a108-56199a51ba69). A Second PC with a
 *   FRESH/EMPTY database has no such row, and the Mother Company identity has no
 *   Supabase `profiles` / `agency_administrators` tenant mapping to pull down, so
 *   cloudToLocalSync returns NO_TENANT and login fails with a generic 401 even
 *   though Supabase verified the password.
 *
 * WHAT THIS DOES
 *   Creates (or repairs) that single canonical mirror row so a cloud-verified
 *   Mother Company login can resolve locally on ANY device. It is:
 *     - IDEMPOTENT: safe to run at every startup AND at every login; it never
 *       creates a duplicate (existence is matched on id / username / email /
 *       supabase_user_id, and the insert is guarded).
 *     - CREDENTIAL-FREE: no bcrypt hash, no local password comparison. The
 *       password_hash column receives a non-verifiable sentinel so no legacy code
 *       path can ever treat it as a credential. Supabase `signInWithPassword`
 *       remains the SOLE password authority.
 *     - IDENTITY-STABLE: binds the verified Supabase auth UUID so the row
 *       resolves by UUID on every device (audit §26 cross-PC mapping).
 *
 * The verified UUID below is the Mother Company's Supabase Auth id, read from
 * the working Laptop mirror row. It is a public identifier (not a secret) and
 * can be overridden with BOOTSTRAP_ADMIN_SUPABASE_ID if the cloud identity is
 * ever rotated.
 */

'use strict';

const MOTHER_COMPANY = Object.freeze({
  id: 'admin',
  username: 'admin',
  email: 'admin@blackstack.local',
  companyId: 'default',
  role: 'ADMIN',
  status: 'ACTIVE',
  fullName: 'System Administrator',
  // Verified from the Laptop's working local mirror row (Phase 66 source of truth).
  defaultSupabaseUserId: '21e8db5d-ba09-4a63-a108-56199a51ba69',
  // Non-verifiable sentinel: proves no local password path can authenticate.
  cloudAuthOnlyHash: 'CLOUD-AUTH-ONLY:bootstrap',
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v) {
  return UUID_RE.test(String(v || ''));
}

/** Normalize an adapter (get/run/all) or a raw node:sqlite handle. */
function accessors(conn) {
  if (conn && typeof conn.get === 'function' && typeof conn.run === 'function') {
    return { get: (sql, p) => conn.get(sql, p), run: (sql, p) => conn.run(sql, p) };
  }
  return {
    get: (sql, p) => conn.prepare(sql).get(...(Array.isArray(p) ? p : [p])),
    run: (sql, p) => conn.prepare(sql).run(...(Array.isArray(p) ? p : [p])),
  };
}

/**
 * Ensure the canonical Mother Company admin mirror row exists.
 *
 * @param {object} conn            connection adapter (get/run) or raw handle
 * @param {object} [opts]
 * @param {string} [opts.supabaseUserId]  verified Supabase auth UUID to bind
 * @param {object} [opts.log]      logger (defaults to console)
 * @returns {{created:boolean, userId:string, supabaseUserId:?string}}
 */
function ensureMotherCompanyAdmin(conn, opts = {}) {
  const log = opts.log || console;
  const { get, run } = accessors(conn);
  const mc = MOTHER_COMPANY;

  const requestedUid = isUuid(opts.supabaseUserId)
    ? String(opts.supabaseUserId)
    : (isUuid(process.env.BOOTSTRAP_ADMIN_SUPABASE_ID) ? process.env.BOOTSTRAP_ADMIN_SUPABASE_ID : mc.defaultSupabaseUserId);

  // The default tenant company must exist for the FK.
  run('INSERT OR IGNORE INTO companies (id, name, status) VALUES (?, ?, ?)', [mc.companyId, 'BlackStack Default Company', 'ACTIVE']);

  // role_admin must exist for the user_roles FK (normally seeded by migration 015;
  // INSERT OR IGNORE keeps this a no-op on a migrated database).
  run(
    `INSERT OR IGNORE INTO roles (id, company_id, name, code, description, is_system)
     VALUES (?, ?, ?, ?, ?, 1)`,
    ['role_admin', mc.companyId, 'Administrator', 'ADMIN', 'Full system access'],
  );

  // Match ANY of the unique constraints the insert could violate (id, username,
  // email) plus the cloud UUID, so a partially-seeded row is repaired, not duplicated.
  const existing = get(
    `SELECT id, company_id, role, status, supabase_user_id
       FROM users
      WHERE id = ? OR lower(username) = lower(?) OR lower(email) = lower(?)
         OR (supabase_user_id IS NOT NULL AND supabase_user_id = ?)
      LIMIT 1`,
    [mc.id, mc.username, mc.email, requestedUid],
  );

  if (!existing) {
    run(
      `INSERT INTO users
         (id, company_id, username, email, password_hash, full_name, role, status,
          hierarchy_role, supabase_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [mc.id, mc.companyId, mc.username, mc.email, mc.cloudAuthOnlyHash, mc.fullName, mc.role, mc.status, requestedUid],
    );
    run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [mc.id, 'role_admin']);
    log.info && log.info(`[mother-company-bootstrap] created Mother Company admin mirror row (supabase_user_id=${requestedUid})`);
    return { created: true, userId: mc.id, supabaseUserId: requestedUid };
  }

  // Row already exists — repair only what is missing, never clobber local edits.
  let effectiveUid = existing.supabase_user_id || null;
  if (!effectiveUid && requestedUid) {
    run('UPDATE users SET supabase_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [requestedUid, existing.id]);
    effectiveUid = requestedUid;
    log.info && log.info(`[mother-company-bootstrap] bound supabase_user_id=${requestedUid} to existing mirror row ${existing.id}`);
  }
  // Guarantee the ADMIN role link (idempotent).
  run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [existing.id, 'role_admin']);

  return { created: false, userId: existing.id, supabaseUserId: effectiveUid };
}

module.exports = { ensureMotherCompanyAdmin, MOTHER_COMPANY, isUuid };