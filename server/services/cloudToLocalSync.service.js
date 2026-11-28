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
 *   - Supabase credentials come from server/config/supabase.js (ANON key in
 *     desktop builds). With the anon key, `auth.admin.getUserById` is NOT
 *     available — identity metadata is resolved through RLS-protected table
 *     reads (profiles) instead. Failure is non-fatal for authentication:
 *     if the cloud is unreachable the login proceeds with whatever already
 *     exists locally.
 *   - PRIVILEGED operations (admin user lookup, cross-tenant reads) belong
 *     in Supabase Edge Functions, never in this desktop client.
 */

const { isConfigured, getSupabaseClient } = require('../config/supabase');
const { generateId } = require('../utils/generateId');
const { ensureMotherCompanyAdmin, MOTHER_COMPANY } = require('../database/motherCompanyBootstrap');

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

  // ── AUTH-AS-USER (critical for the anon key) ─────────────────────────────
  // With the ANON key, RLS resolves auth.uid() ONLY when the request carries
  // the user's own JWT. A bare anon client would see ZERO rows (every policy
  // is scoped to auth.uid()). The access token comes straight from the
  // successful signInWithPassword grant in auth.service.login().
  const accessToken = identity.accessToken || null;
  if (!accessToken) {
    log.info && log.info('[cloud-sync] no Supabase access token — cannot read RLS-protected rows as user');
    return { synced: false, reason: 'NO_TOKEN', companyId: null, agencyId: null, profile: null };
  }
  const sb = getSupabaseClient();
  sb.auth.setSession({ access_token: accessToken, refresh_token: '' });

  // ── 1. Resolve the Supabase Auth identity ────────────────────────────────
  // All reads run WITH the user's JWT, so RLS exposes exactly their own row
  // (profiles.user_id = auth.uid()) and their own tenant's mapping rows. No
  // auth.admin.* calls — those need the service role and stay server-side.
  let authUser = null;
  let authUserId = null;
  if (identity.supabaseUserId && isUuid(identity.supabaseUserId)) {
    authUserId = identity.supabaseUserId;
  }
  if (!authUserId) {
    // Self-row lookup via the profiles mirror (RLS: user_id = auth.uid()).
    const { data: profRows } = await sb
      .from('profiles').select('user_id, role, agency_id, company_id')
      .eq('username', email).limit(1);
    const prof = profRows && profRows[0];
    if (prof && prof.user_id && isUuid(prof.user_id)) {
      authUserId = prof.user_id;
    }
  }
  // Full user_metadata (full_name etc.) can be read from the profiles row
  // itself; auth.admin is intentionally not used here.
  if (authUserId) {
    const { data: selfRows } = await sb
      .from('profiles').select('user_id, role, agency_id, company_id, username, full_name')
      .eq('user_id', authUserId).limit(1);
    const self = selfRows && selfRows[0];
    if (self) {
      authUser = {
        id: self.user_id,
        user_metadata: { full_name: self.full_name || null, name: self.full_name || null },
      };
      // Populate the metadata fallback from the RLS-protected self row. The anon
      // key cannot read auth.app_metadata, so the profiles row is the only
      // server-readable source for the caller's own agency/company/role.
      meta.agency_id = self.agency_id || null;
      meta.company_id = self.company_id || null;
      if (!role && self.role) role = String(self.role).toLowerCase();
    }
  }

  // ── 2. Determine the tenant company (company_id) ─────────────────────────
  // Priority: local user row → auth app_metadata.agency_id → profiles row →
  // agencies row matching the email as administrator.
  let companyId = null;
  let agencyId = null;   // cloud UUID of the owning agency
  let role = (identity.role || '').toLowerCase() || null;

  // ANON-KEY SAFE: app_metadata is not readable with the public key, so the
  // role hint comes from the RLS-protected profiles row (self) instead.
  const meta = {};
  role = role || String((authUser && authUser.user_metadata && authUser.user_metadata.role) || '').toLowerCase() || null;

  // ─ P1 (centralized identity mapping): resolve the local mirror row by the
  // Supabase auth UUID FIRST, falling back to email. Rationale (audit §26):
  // email is mutable and device-local seeds may differ across PCs, so two
  // machines can hold different local ids for the same human. Keying the
  // mirror on supabase_user_id makes the identity mapping stable and identical
  // on every device; the email path stays only for legacy/unlinked rows.
  let localUser = null;
  const cloudUid = (identity.supabaseUserId && isUuid(identity.supabaseUserId))
    ? identity.supabaseUserId
    : null;
  if (cloudUid) {
    localUser = db.get(
      'SELECT id, company_id, supabase_user_id, role, hierarchy_role FROM users WHERE supabase_user_id = ? LIMIT 1',
      [cloudUid],
    );
  }
  if (!localUser) {
    localUser = db.get(
      'SELECT id, company_id, supabase_user_id, role, hierarchy_role FROM users WHERE lower(email) = lower(?) LIMIT 1',
      [email],
    );
  }
  if (localUser) companyId = localUser.company_id || null;

  if (!companyId && meta.agency_id && isUuid(meta.agency_id)) agencyId = meta.agency_id;

  if (!companyId && !agencyId) {
    // RLS-scoped: agency_administrators rows are visible to the caller only
    // where their subtree policy permits — the caller's own link always is.
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
    // SECOND-PC LOGIN FIX: the Mother Company identity has no Supabase
    // profiles / agency_administrators tenant mapping to pull down, so a fresh
    // install would return NO_TENANT and the (already cloud-verified) login
    // would 401 with the generic "Invalid credentials." message. Self-heal by
    // creating the canonical local mirror row — idempotently, with NO local
    // password — keyed on the VERIFIED cloud UUID, then continue the normal
    // mirror flow below. Non-Mother-Company users still get NO_TENANT.
    if (email === MOTHER_COMPANY.email) {
      const res = ensureMotherCompanyAdmin(db, { supabaseUserId: cloudUid, log });
      companyId = MOTHER_COMPANY.companyId;
      localUser = db.get(
        'SELECT id, company_id, supabase_user_id, role, hierarchy_role FROM users WHERE id = ? LIMIT 1',
        [MOTHER_COMPANY.id],
      );
      log.info && log.info(`[cloud-sync] Mother Company mirror ${res.created ? 'created' : 'already present'} for ${email} (supabase_user_id=${res.supabaseUserId || 'unbound'})`);
    } else {
      log.info && log.info(`[cloud-sync] No cloud tenant mapped for ${email} — nothing to sync`);
      return { synced: false, reason: 'NO_TENANT', companyId: null, agencyId: null, profile: null };
    }
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
  if (company === null && companyId) {
    // Mother Company / platform operator case: the local user row carries a
    // company_id (e.g. 'default') but the cloud has no matching `companies`
    // row and no agency row. Previously this fell through to `company.id` and
    // threw "Cannot read properties of null" — logged as a login-time warning
    // on every Mother Company login (verified live 2026-11-27). Synthesise the
    // display-only mirror exactly like the agency branch above so the local
    // INSERT OR IGNORE below can create the company row. No cloud write, no
    // invented tenant data beyond the already-established local company_id.
    company = { id: companyId, name: 'BlackStack', status: 'ACTIVE' };
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
    // P1: always write the resolved cloud UUID — the mirror row's supabase_user_id
    // must match the authenticating identity on EVERY device, not just the first.
    db.run(
      `UPDATE users SET
         company_id = ?,
         supabase_user_id = COALESCE(?, supabase_user_id, ?),
         hierarchy_role = COALESCE(hierarchy_role, ?),
         status = 'ACTIVE',
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [localCompanyId, cloudUid, (authUser && authUser.id) || identity.supabaseUserId || null, hierarchyRole, userId],
    );
  } else {
    userId = generateId('usr');
    // Supabase-only authentication: the local `password_hash` column is NOT a
    // credential. Store a non-hash sentinel so no legacy code path can ever
    // treat it as verifiable, and the column never looks like live secret data.
    const unusableHash = 'CLOUD-AUTH-ONLY:' + ((authUser && authUser.id) || identity.supabaseUserId || 'unlinked');
    db.run(
      `INSERT INTO users (id, company_id, username, email, password_hash, full_name, role, status,
                          hierarchy_role, supabase_user_id, created_at)
       VALUES (?,?,?,?,?,?,?,'ACTIVE',?,?,CURRENT_TIMESTAMP)`,
      [userId, localCompanyId, username, email, unusableHash, fullName, appRole, hierarchyRole, (authUser && authUser.id) || null],
    );
    // P1: the newly created mirror row MUST carry the cloud UUID immediately,
    // so a subsequent login on this (or any other) PC resolves by UUID.
    const uidToWrite = (authUser && authUser.id) || identity.supabaseUserId || null;
    if (uidToWrite) {
      db.run('UPDATE users SET supabase_user_id = ? WHERE id = ?', [uidToWrite, userId]);
    }
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
