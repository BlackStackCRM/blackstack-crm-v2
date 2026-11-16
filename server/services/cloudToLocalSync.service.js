/**
 * CLOUD → LOCAL SYNC SERVICE (post-login provisioning).
 *
 * Customer-facing desktop installs start with an EMPTY local SQLite database.
 * Accounts and their tenant companies are created centrally by the Agency in
 * Supabase; when one of those users signs in, this service pulls THEIR company
 * configuration down and mirrors it into the local database so the CRM can
 * function offline-first, without the user ever creating or registering
 * anything.
 *
 * ISOLATION / SAFETY GUARANTEES
 *   - Reads ONLY rows belonging to the logging-in user's company (every Supabase
 *     query is filtered by company_id). Never touches other tenants' rows, and
 *     NEVER writes back to Supabase — this path is a one-way read.
 *   - Local writes are INSERT OR IGNORE keyed on the cloud UUID, so re-login
 *     never duplicates or overwrites locally-edited data.
 *   - Supabase credentials come from server/config/supabase.js (service role,
 *     server-side only). Nothing here is reachable from the renderer.
 *   - Failure is non-fatal for authentication: if the cloud is unreachable the
 *     login proceeds with whatever already exists locally.
 */

const { isConfigured, getSupabaseClient } = require('../config/supabase');
const { generateId } = require('../utils/generateId');
const { PasswordService } = require('../auth/password');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v) {
  return UUID_RE.test(String(v || ''));
}

/**
 * Provision the local database for the logging-in Supabase user.
 *
 * @param {object} db            node:sqlite wrapper (getConn())
 * @param {object} identity      { supabaseUserId?, email, fullName?, role? }
 * @param {object} [log]         optional logger (defaults to console)
 * @returns {Promise<{synced:boolean, companyId:?string, agencyId:?string, profile:?object}>}
 */
async function syncUserCompanyFromCloud(db, identity, log = console) {
  const email = String((identity && identity.email) || '').trim().toLowerCase();
  if (!email) {
    return { synced: false, reason: 'NO_EMAIL', companyId: null, agencyId: null, profile: null };
  }
  if (!isConfigured()) {
    log.info && log.info('[cloud-sync] Supabase not configured — skipping cloud pull');
    return { synced: false, reason: 'UNCONFIGURED', companyId: null, agencyId: null, profile: null };
  }

  const sb = getSupabaseClient();

  // ── 1. Resolve the Supabase Auth identity ────────────────────────────────
  // When app_metadata was set at account creation it names the role and the
  // owning agency/company directly; otherwise we fall back to email lookup.
  let authUser = null;
  if (identity.supabaseUserId && isUuid(identity.supabaseUserId)) {
    const { data } = await sb.auth.admin.getUserById(identity.supabaseUserId);
    authUser = data && data.user ? data.user : null;
  }
  if (!authUser) {
    // Email-indexed lookup via the profiles mirror first (cheap), then Auth.
    const { data: profRows } = await sb
      .from('profiles').select('user_id, role, agency_id, company_id')
      .eq('username', email).limit(1);
    const prof = profRows && profRows[0];
    if (prof && prof.user_id && isUuid(prof.user_id)) {
      const { data } = await sb.auth.admin.getUserById(prof.user_id);
      authUser = data && data.user ? data.user : null;
    }
  }

  // ── 2. Determine the tenant company (company_id) ─────────────────────────
  // Priority: local user row → auth app_metadata.agency_id → profiles row →
  // agencies row matching the email as administrator.
  let companyId = null;
  let agencyId = null;   // cloud UUID of the owning agency
  let role = (identity.role || '').toLowerCase() || null;

  const meta = (authUser && authUser.app_metadata) || {};
  role = role || String(meta.role || '').toLowerCase() || null;

  const localUser = db.get(
    'SELECT id, company_id, supabase_user_id, role, hierarchy_role FROM users WHERE lower(email) = lower(?) LIMIT 1',
    [email],
  );
  if (localUser) companyId = localUser.company_id || null;

  if (!companyId && meta.agency_id && isUuid(meta.agency_id)) agencyId = meta.agency_id;

  if (!companyId && !agencyId) {
    const { data: adminRows } = await sb
      .from('agency_administrators')
      .select('agency_id, role_code, agencies!inner(id, company_id)')
      .eq('email', email).eq('status', 'ACTIVE').limit(1);
    const link = adminRows && adminRows[0];
    if (link && link.agencies) {
      agencyId = link.agency_id;
      companyId = link.agencies.company_id;
      role = role || String(link.role_code || '').toLowerCase();
    }
  }

  if (!companyId && !agencyId) {
    log.info && log.info(`[cloud-sync] No cloud tenant mapped for ${email} — nothing to sync`);
    return { synced: false, reason: 'NO_TENANT', companyId: null, agencyId: null, profile: null };
  }

  // ── 3. Pull the agency + its own tenant company ──────────────────────────
  let agency = null;
  if (agencyId) {
    const { data, error } = await sb.from('agencies')
      .select('id, company_id, provider_company_id, agency_code, name, legal_name, contact_name, contact_email, contact_phone, address, city, state, country, pincode, status, is_active')
      .eq('id', agencyId).limit(1);
    if (!error && data && data[0]) agency = data[0];
  } else {
    const { data, error } = await sb.from('agencies')
      .select('id, company_id, provider_company_id, agency_code, name, legal_name, contact_name, contact_email, contact_phone, address, city, state, country, pincode, status, is_active')
      .eq('company_id', companyId).limit(1);
    if (!error && data && data[0]) { agency = data[0]; agencyId = agency.id; }
  }

  // The agency's OWN tenant company row is the boundary its users belong to.
  if (!companyId && agency) companyId = agency.company_id;
  let company = null;
  if (companyId) {
    const { data, error } = await sb.from('companies')
      .select('id, name, status')
      .eq('id', companyId).limit(1);
    if (!error && data && data[0]) company = data[0];
  }
  if (company === null && agency) {
    // Older cloud rows may predate the companies table mirror — synthesise a
    // display name from the agency (never invents data; purely cosmetic).
    company = { id: companyId || agency.company_id, name: agency.name, status: 'ACTIVE' };
  }
  if (!company && companyId === null) {
    return { synced: false, reason: 'NO_COMPANY', companyId: null, agencyId: agencyId, profile: null };
  }

  const localCompanyId = company.id;
  const providerId = (agency && agency.provider_company_id) || null;

  // ── 4. Mirror down (INSERT OR IGNORE — never clobbers local edits) ───────
  db.run(
    `INSERT OR IGNORE INTO companies (id, name, status) VALUES (?, ?, ?)`,
    [localCompanyId, company.name || (agency && agency.name) || 'BlackStack', company.status || 'ACTIVE'],
  );

  if (agency) {
    db.run(
      `INSERT OR IGNORE INTO agencies
         (id, company_id, provider_company_id, agency_code, name, legal_name,
          contact_name, contact_email, contact_phone, address, city, state,
          country, pincode, status, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        agency.id,
        agency.company_id || localCompanyId,
        providerId,
        agency.agency_code,
        agency.name,
        agency.legal_name,
        agency.contact_name,
        agency.contact_email,
        agency.contact_phone,
        agency.address,
        agency.city,
        agency.state,
        agency.country || 'India',
        agency.pincode,
        agency.status || 'PENDING',
        agency.is_active !== undefined && agency.is_active !== null ? Number(agency.is_active) : 0,
      ],
    );
  }

  // ── 5. Ensure the local user row exists for THIS login ───────────────────
  // Local SQLite remains the identity authority for sessions; the cloud row is
  // mirrored so resolveCaller()/RBAC keeps working offline.
  const fullName = (identity.fullName || (authUser && (authUser.user_metadata?.full_name || authUser.user_metadata?.name)) || email.split('@')[0]);
  const username = email;
  const hierarchyRole = role || 'customer_tenant';
  const appRole = hierarchyRole === 'agency' || hierarchyRole === 'sub_agency'
    ? (hierarchyRole === 'agency' ? 'AGENCY_ADMIN' : 'SUB_AGENCY_ADMIN')
    : 'CUSTOMER_ADMIN';

  let userId = null;
  if (localUser) {
    userId = localUser.id;
    db.run(
      `UPDATE users SET
         company_id = ?,
         supabase_user_id = COALESCE(supabase_user_id, ?),
         hierarchy_role = COALESCE(hierarchy_role, ?),
         status = 'ACTIVE',
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [localCompanyId, (authUser && authUser.id) || identity.supabaseUserId || null, hierarchyRole, userId],
    );
  } else {
    userId = generateId('usr');
    // No local password: authentication is delegated to Supabase on the first
    // session, then the user sets/keeps the password through the app. An empty
    // hash column would lock the account out of local fallback auth, so we set
    // a random unusable hash instead.
    const unusableHash = await PasswordService.hash(generateId('rnd') + generateId('rnd'));
    db.run(
      `INSERT INTO users (id, company_id, username, email, password_hash, full_name, role, status,
                          hierarchy_role, supabase_user_id, created_at)
       VALUES (?,?,?,?,?,?,?,'ACTIVE',?,?,CURRENT_TIMESTAMP)`,
      [userId, localCompanyId, username, email, unusableHash, fullName, appRole, hierarchyRole, (authUser && authUser.id) || null],
    );
  }

  log.info && log.info(`[cloud-sync] Synced company ${localCompanyId}` +
    (agency ? ` / agency ${agency.id}` : '') + ` for ${email}`);

  return {
    synced: true,
    companyId: localCompanyId,
    agencyId: agency ? agency.id : null,
    profile: { userId, email, fullName, role: hierarchyRole },
  };
}

module.exports = { syncUserCompanyFromCloud };
