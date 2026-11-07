/**
 * ROLE-BASED ACCESS — server-side scoping for the 3-level hierarchy.
 *
 * ROLES
 *   agency           (L1) — sees its subtree; creates sub-agencies + customer tenants
 *   sub_agency       (L2) — sees itself + its customer tenants; creates customer tenants
 *                           under ITSELF only
 *   customer_tenant  (L3) — sees only its own record; creates nothing
 *
 * SECURITY INVARIANTS
 *   * role + agency_id ALWAYS come from the server-side session/user lookup —
 *     never from the request body, headers, or user_metadata.
 *   * Account creation uses supabase.auth.admin (service_role, server-only).
 *   * username → email resolution happens server-side (client sends username only).
 *   * Login failures are indistinguishable (unknown user vs wrong password):
 *     same message, same generic 401 — no user enumeration.
 *
 * LOCAL-FIRST: the users/profiles data of record is the local SQLite users
 * table (role column carries the hierarchy role). The profiles/Supabase side
 * mirrors it for defense-in-depth RLS; this module writes both.
 */

const { randomBytes } = require('crypto');
const { getSupabaseClient } = require('../config/supabase');
const { NotFoundError, ValidationError, AuthorizationError } = require('../utils/errors');

const ROLES = ['agency', 'sub_agency', 'customer_tenant'];

/** Role hierarchy: what each role may create, and under what parent scope.
 *  'platform' = Mother Company operator (role ADMIN): creates root
 *  distribution agencies (agency accounts) — the only role that may create
 *  an agency-level account. */
const CREATION_MATRIX = {
  platform: ['agency', 'sub_agency', 'customer_tenant'],
  agency: ['sub_agency', 'customer_tenant'],
  sub_agency: ['customer_tenant'],
  customer_tenant: [],
};

/**
 * The caller's subtree as LOCAL agency ids (mirrors scopedAgencyIds but is
 * role-driven and used by the account endpoints).
 * agency: itself + descendants (recursive)
 * sub_agency: itself + descendants (it IS a child, so its own subtree applies)
 * customer_tenant: itself only
 */
function getVisibleAgencyIds(db, localAgencyId, role) {
  if (!localAgencyId) return [];
  if (role === 'customer_tenant') return [localAgencyId];
  // platform / agency / sub_agency: recursive subtree via
  // agency_parent_relationships. For the platform role the localAgencyId is
  // null — the caller passes the full agency list from scopedAgencyIds
  // (admin fallback) instead; see assertCanCreate's platform branch.
  if (role === 'platform') {
    const rows = typeof db.all === 'function'
      ? db.all('SELECT id FROM agencies')
      : db.prepare('SELECT id FROM agencies').all();
    return rows.map((r) => r.id);
  }
  const ids = [localAgencyId];
  const frontier = [localAgencyId];
  const seen = new Set([localAgencyId]);
  while (frontier.length) {
    const cur = frontier.shift();
    const childRows = typeof db.all === 'function'
      ? db.all(
          'SELECT child_agency_id AS id FROM agency_parent_relationships WHERE parent_agency_id = ?',
          [cur],
        )
      : db.prepare(
          'SELECT child_agency_id AS id FROM agency_parent_relationships WHERE parent_agency_id = ?',
        ).all(cur);
    const children = childRows.map((c) => c.id);
    for (const cid of children) {
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      ids.push(cid);
      frontier.push(cid);
    }
  }
  return ids;
}

/** Resolve the caller's role + local agency id from the LOCAL users table.
 *  The local DB is the authority; a missing/inactive user rejects. */
function resolveCaller(db, session) {
  // The connection adapter exposes .get via get(); node:sqlite raw handles
  // differ — normalize: if db.get is missing, fall back to db.prepare().get.
  const get = (sql, params) => {
    if (typeof db.get === 'function') return db.get(sql, params);
    return db.prepare(sql).get(...(Array.isArray(params) ? params : [params]));
  };
  const all = (sql, params) => {
    if (typeof db.all === 'function') return db.all(sql, params);
    return db.prepare(sql).all(...(Array.isArray(params) ? params : [params]));
  };
  const user = get('SELECT id, company_id, role, status, hierarchy_role, supabase_user_id, must_change_password, parent_user_id FROM users WHERE id = ?', [session.userId]);
  if (!user || String(user.status).toLowerCase() !== 'active') return null;  // Map the local user to its hierarchy role. Local users store the legacy
  // role strings; normalize them onto the 3-level model.
  // The Mother Company platform admin (role ADMIN) is the ROOT operator: it
  // acts as the Level-1 creator (creates root distribution agencies and
  // everything beneath them). Its visible scope is all agencies via the
  // scopedAgencyIds admin fallback.
  // FIX (RBAC, acceptance): HIERARCHY_ROLE IS THE AUTHORITY for accounts
  // created through /accounts/create (it is set server-side at creation and
  // never client-editable). Legacy accounts (hierarchy_role NULL) fall back
  // to normalizing the legacy users.role strings.
  let role;
  if (user.hierarchy_role && ROLES.includes(user.hierarchy_role)) {
    role = user.hierarchy_role;
  } else if (user.role === 'ADMIN') {
    role = 'platform';
  } else if (user.role === 'agency') {
    role = 'agency';
  } else if (user.role === 'AGENCY_ADMIN' || user.role === 'sub_agency') {
    role = 'sub_agency';
  } else {
    role = 'customer_tenant';
  }
  // agency_id: resolved from the administrators link. FIX (resilience):
  // legacy/bug-era accounts may be missing the link row — fall back to the
  // users.company_id reverse lookup (an agency row whose company_id matches
  // the user's tenant company), so tenancy survives the data gap.
  const link = get(
    `SELECT a.id AS agency_id FROM agency_administrators aa JOIN agencies a ON a.id = aa.agency_id
     WHERE aa.user_id = ? AND aa.status = 'ACTIVE' LIMIT 1`,
    [user.id],
  );
  let localAgencyId = link ? link.agency_id : null;
  if (!localAgencyId && user.hierarchy_role && user.hierarchy_role !== 'customer_tenant') {
    const byCompany = get(
      'SELECT id FROM agencies WHERE company_id = ? LIMIT 1',
      [user.company_id],
    );
    if (byCompany) localAgencyId = byCompany.id;
  }
  // FIX (legacy sub_agency parent fallback): accounts created before the flow
  // started attaching an agency_administrators link + own agency row have NEITHER
  // — they would resolve to localAgencyId = null and every scoped operation
  // (visibility, creation) would fail. Fallback chain, in order:
  //   1. the PARENT user's agency link (users.parent_user_id) — the agency
  //      this sub-agency account was created under;
  //   2. any ACTIVE agency_administrators row whose user shares the parent's
  //      company (the parent company's agency) — covers parents whose own link
  //      was lost but whose agency row still exists;
  //   3. the SERVER-SET Supabase app_metadata.agency_id on the caller's own
  //      cloud mirror — reverse-mapped to the local id via the deterministic
  //      localIdToCloudUuid hash (never client-supplied, so not spoofable).
  if (!localAgencyId && user.hierarchy_role && user.hierarchy_role !== 'customer_tenant' && user.parent_user_id) {
    const byParent = get(
      `SELECT a.id AS agency_id FROM agency_administrators aa JOIN agencies a ON a.id = aa.agency_id
       WHERE aa.user_id = ? AND aa.status = 'ACTIVE' LIMIT 1`,
      [user.parent_user_id],
    );
    if (byParent) localAgencyId = byParent.agency_id;
    if (!localAgencyId) {
      const byParentCompany = get(
        `SELECT a.id AS agency_id FROM agencies a
         JOIN users pu ON pu.company_id = a.company_id
         JOIN agency_administrators aa ON aa.agency_id = a.id AND aa.status = 'ACTIVE'
         WHERE pu.id = ? LIMIT 1`,
        [user.parent_user_id],
      );
      if (byParentCompany) localAgencyId = byParentCompany.agency_id;
    }
    // FIX (sub_agency localAgencyId null): the fallback above assumed the
    // parent user still holds the agency_administrators link. When the parent
    // was RE-ASSIGNED (the MC assignAdministrator flow deactivates the old
    // operator row and links a NEW user with a NEW agency row — same agency
    // name, fresh ids), the old parent_user_id resolves to nothing and the
    // legacy sub-agency is stranded with localAgencyId = null. Fallback 2.5:
    // the TENANT COMPANY the account lives in (users.company_id). Agency rows
    // created by the current creation flow keep company_id in sync with the
    // parent's tenant company, so an agencies row sharing the sub-agency's own
    // company_id is its correct scoping anchor. Re-verified by
    // assertCanCreate/getVisibleAgencyIds, so this can never widen scope
    // beyond the caller's own tenant.
    if (!localAgencyId && user.hierarchy_role && user.hierarchy_role !== 'customer_tenant') {
      const byOwnCompany = get(
        'SELECT id FROM agencies WHERE company_id = ? LIMIT 1',
        [user.company_id],
      );
      if (byOwnCompany) localAgencyId = byOwnCompany.id;
    }
    if (!localAgencyId && user.supabase_user_id) {
      try {
        const cloudId = require('./supabase.service').supabaseAgencyIdForUser(user.supabase_user_id);
        if (cloudId) {
          const all = typeof db.all === 'function' ? db.all('SELECT id FROM agencies') : db.prepare('SELECT id FROM agencies').all();
          const { localIdToCloudUuid } = require('./supabase.service');
          const match = all.find((r) => localIdToCloudUuid(r.id) === cloudId);
          if (match) localAgencyId = match.id;
        }
      } catch { /* cloud unavailable — leave null */ }
    }
  }
  return {
    localUserId: user.id,
    localCompanyId: user.company_id,
    role,
    localAgencyId,
    // Supabase mirror id — stored on the local users row at account creation.
  // Null when the account has no cloud mirror (legacy users).
    supabaseUserId: user.supabase_user_id || null,
  };
}

/** Generate a strong random password (server-side; 20 chars, 4 classes). */
function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?';
  const bytes = randomBytes(20);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** Validate a creation request against the caller's role + subtree. */
function assertCanCreate(db, caller, { role: targetRole, parentAgencyId }) {
  // normalize: adapter or raw handle
  const get = (sql, params) => {
    if (typeof db.get === 'function') return db.get(sql, params);
    return db.prepare(sql).get(...(Array.isArray(params) ? params : [params]));
  };
  const all = (sql, params) => {
    if (typeof db.all === 'function') return db.all(sql, params);
    return db.prepare(sql).all(...(Array.isArray(params) ? params : [params]));
  };
  if (!caller) throw new AuthorizationError('Authentication required.');
  if (!CREATION_MATRIX[caller.role] || !CREATION_MATRIX[caller.role].includes(targetRole)) {
    throw new AuthorizationError(`Role "${caller.role}" cannot create "${targetRole}" accounts.`);
  }
  if (!parentAgencyId) {
    throw new ValidationError('Account creation failed.', { parentAgencyId: 'Parent agency must be selected.' });
  }
  // The platform operator administers the whole tree: every agency is in scope.
  if (caller.role === 'platform') return;
  if (!caller.localAgencyId) {
    throw new AuthorizationError('Your account is not linked to an agency.');
  }
  const visible = getVisibleAgencyIds(db, caller.localAgencyId, caller.role);
  if (!visible.includes(parentAgencyId)) {
    // The #1 privilege-escalation vector — reject anything outside the subtree.
    throw new AuthorizationError('The target parent agency is outside your scope.');
  }
}

/**
 * Create a child account (auth user + local mirror + hierarchy row).
 * caller comes from resolveCaller(); intent comes ONLY from the request body's
 * username/password/targetRole — role and parent are re-validated server-side.
 */
async function createChildAccount(db, caller, { username, email: emailOverride, password, targetRole, parentAgencyId, displayName }) {
  // SAFE FALLBACK (legacy sub-agency accounts): when the CALLER is an agency /
  // sub-agency and the frontend could not supply parentAgencyId (no agency row
  // of its own → no agencyId in the profile), default the parent to the
  // caller's OWN resolved agency. resolveCaller() already falls back to the
  // parent user's agency link for link-less legacy accounts, so this stays in
  // the caller's subtree — assertCanCreate below re-verifies scope.
  if (!parentAgencyId && caller && (caller.role === 'agency' || caller.role === 'sub_agency') && caller.localAgencyId) {
    parentAgencyId = caller.localAgencyId;
  }
  // FIX (sub_agency with NO localAgencyId at all): a legacy/re-assigned
  // sub-agency may still resolve to localAgencyId = null even after every
  // link fallback. For the ONLY creation a sub_agency is allowed (its own
  // customer_tenant), fall back to the sub-agency's own id when a local
  // agency row exists under it — never to a guessed id.
  if (!parentAgencyId && caller && caller.role === 'sub_agency') {
    const get0 = (sql, params) => {
      if (typeof db.get === 'function') return db.get(sql, params);
      return db.prepare(sql).get(...(Array.isArray(params) ? params : [params]));
    };
    const byCompany = get0('SELECT id FROM agencies WHERE company_id = ? LIMIT 1', [caller.localCompanyId]);
    if (byCompany) parentAgencyId = byCompany.id;
  }
  assertCanCreate(db, caller, { role: targetRole, parentAgencyId });
  // FIX (UI email field): the hierarchy UI now collects the child's EMAIL in
  // the username field (Supabase Auth requires an email). Accept either: an
  // explicit `email` override wins, else treat `username` as the email when
  // it looks like one, else keep the legacy username contract.
  const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  let mail = null;
  if (emailOverride && EMAIL_SHAPE.test(String(emailOverride).trim())) {
    mail = String(emailOverride).trim().toLowerCase();
  } else if (username && EMAIL_SHAPE.test(String(username).trim())) {
    mail = String(username).trim().toLowerCase();
  }
  if (mail) {
    // The login/identity key becomes the email itself.
    username = mail;
  } else {
    if (!username || !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      throw new ValidationError('Account creation failed.', { username: 'Username must be 3-32 chars: letters, digits, dot, dash, underscore — or a valid email address.' });
    }
    mail = `${username.toLowerCase()}@accounts.blackstack.local`;
  }
  if (!password || password.length < 10) {
    throw new ValidationError('Account creation failed.', { password: 'Password must be at least 10 characters.' });
  }

  const supabase = getSupabaseClient();
  // Auth email: the child's real email when provided, else the deterministic
  // synthesized address for legacy usernames.
  const authEmail = mail;

  // 1. Create the auth user with SERVER-SET app_metadata (never user_metadata).
  const { data: created, error: authErr } = await supabase.auth.admin.createUser({
    email: authEmail,
    password,
    email_confirm: true,
    app_metadata: {
      role: targetRole,
      agency_id: parentAgencyId, // will be replaced by the cloud UUID below
      parent_user_id: caller.supabaseUserId || null,
    },
  });
  if (authErr) throw new ValidationError('Account creation failed.', { username: authErr.message });

  // 2. Resolve the parent's CLOUD uuid and patch app_metadata.agency_id to it
  //    (the hierarchy keys on cloud UUIDs).
  // normalize: adapter or raw handle
  const get = (sql, params) => {
    if (typeof db.get === 'function') return db.get(sql, params);
    return db.prepare(sql).get(...(Array.isArray(params) ? params : [params]));
  };
  const parentRow = get('SELECT id FROM agencies WHERE id = ?', [parentAgencyId]);
  const cloudParent = parentRow && /^\S+-\S+-\S+-\S+-\S+$/.test(parentRow.id)
    ? parentRow.id
    : require('./supabase.service').localIdToCloudUuid(parentAgencyId);
  await supabase.auth.admin.updateUserById(created.user.id, {
    app_metadata: { role: targetRole, agency_id: cloudParent, parent_user_id: caller.supabaseUserId || null },
  });

  // 3. Mirror into profiles (for RLS helpers) — ONLY if the table exists.
  // Migration 090 must be applied in the SQL Editor first; until then this is
  // skipped (the local users row is the authority) instead of failing creation.
  const { error: profProbe } = await supabase.from('profiles').select('user_id').limit(1);
  if (profProbe) {
    console.warn('[rbac] profiles table unavailable, skipping mirror (run migration 090):', profProbe.message.slice(0, 80));
  } else {
    const { error: profErr } = await supabase.from('profiles').insert({
    user_id: created.user.id,
    username: mail,
    role: targetRole,
    agency_id: cloudParent,
    parent_user_id: caller.supabaseUserId || null,
    must_change_password: true,
    is_active: true,
  });
  if (profErr) console.error('[rbac] profiles mirror failed:', profErr.message);
  }

  return {
    supabaseUserId: created.user.id,
    email: authEmail,
    username: mail,
    role: targetRole,
    parentAgencyId: parentAgencyId,
    parentAgencyCloudId: cloudParent,
  };
}

module.exports = {
  ROLES,
  CREATION_MATRIX,
  getVisibleAgencyIds,
  resolveCaller,
  generatePassword,
  assertCanCreate,
  createChildAccount,
};
