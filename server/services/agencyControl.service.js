/**
 * AGENCY CONTROL SERVICE — sub-agency hierarchy + customer tenants.
 *
 * Serves public/js/pages/agency-control.js. The caller is a Distribution
 * Agency administrator (or the Mother Company operator): their scope is the
 * agency they administer, per agency_administrators.user_id = caller.
 *
 * TENANT RULES
 *   - A sub-agency is created under the caller's agency (parent link).
 *   - Only the parent agency may change a child's status; transitions follow
 *     the same ALLOWED_TRANSITIONS table as the Mother Company flow.
 *   - Customer tenants are companies assigned to an agency within the caller's
 *     scope (their own agency or one of its sub-agencies).
 *   - Cross-tenant access is reported as NOT FOUND, never 403 (no existence leak).
 */

const { ValidationError, NotFoundError, AuthorizationError, AppError } = require('../utils/errors');
const { generateId } = require('../utils/generateId');
const { getSupabaseClient, isConfigured: isSupabaseConfigured } = require('../config/supabase');
const { forwardAgencyToCloud, localIdToCloudUuid } = require('../services/supabase.service');
const { resolveCaller } = require('./rbac.service');

function isUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(str));
}

function userDeletionBlockers(db, userId) {
  const allowedReferences = new Set([
    'agency_administrators.user_id', 'admin_identity_cleanup_queue.user_id',
    'user_roles.user_id', 'audit_logs.user_id', 'notifications.user_id',
  ]);
  const blockers = [];
  for (const { name: table } of db.all("SELECT name FROM sqlite_master WHERE type='table'")) {
    if (table.startsWith('sqlite_')) continue;
    const quotedTable = `"${table.replace(/"/g, '""')}"`;
    const columns = db.all(`PRAGMA table_info(${quotedTable})`);
    const foreignKeys = db.all(`PRAGMA foreign_key_list(${quotedTable})`);
    const candidates = new Set([
      ...foreignKeys.filter((fk) => fk.table === 'users').map((fk) => fk.from),
      ...columns.filter((col) => /(user|owner|assign|actor|parent_user|manager).*id/i.test(col.name)
        || ['created_by', 'updated_by', 'assigned_by', 'revoked_by', 'actor'].includes(col.name)).map((col) => col.name),
    ]);
    for (const column of candidates) {
      let count = 0;
      try { count = db.get(`SELECT COUNT(*) AS n FROM ${quotedTable} WHERE "${column.replace(/"/g, '""')}" = ?`, [userId]).n; }
      catch { continue; }
      if (count && !allowedReferences.has(`${table}.${column}`)) blockers.push({ table, column, count });
    }
  }
  return blockers;
}

const STATUS_VALUES = ['ACTIVE', 'SUSPENDED', 'PENDING', 'TERMINATED'];

/** Same transition table as AgencyService — one source of truth. */
const ALLOWED_TRANSITIONS = Object.freeze({
  PENDING: ['ACTIVE', 'SUSPENDED', 'TERMINATED'],
  ACTIVE: ['SUSPENDED', 'TERMINATED'],
  SUSPENDED: ['ACTIVE', 'TERMINATED'],
  TERMINATED: [],
});

const toCamelAgency = (a) => a && {
  id: a.id,
  name: a.name,
  agencyCode: a.agency_code,
  status: a.status,
  contactEmail: a.contact_email,
  contactPhone: a.contact_phone,
  address: a.address,
  city: a.city,
  state: a.state,
  country: a.country,
  pincode: a.pincode,
  createdAt: a.created_at,
  updatedAt: a.updated_at,
  activatedAt: a.activated_at,
  suspendedAt: a.suspended_at,
  suspendedReason: a.suspended_reason,
  isActive: a.is_active,
  providerCompanyId: a.provider_company_id,
  companyId: a.company_id,
  legalName: a.legal_name,
  contactName: a.contact_name,
  notes: a.notes,
  createdBy: a.created_by,
  agencyCode: a.agency_code || a.agencyCode,
};

class AgencyControlService {
  constructor(db) {
    this.db = db;
  }

  async getMyAgencyContext(userId) {
    const actor = resolveCaller(this.db, { userId });
    if (!actor || !['agency', 'sub_agency'].includes(actor.role)) {
      throw new AuthorizationError('Only agency accounts can view an agency profile.');
    }
    const assigned = await this.callerAgency(userId);
    const agencyId = assigned?.id || actor.localAgencyId;
    if (!agencyId) throw new NotFoundError('Assigned agency', userId);
    const row = this.db.get(
      `SELECT a.*, p.id AS parent_agency_id, p.name AS parent_agency_name,
              p.agency_code AS parent_agency_code
       FROM agencies a
       LEFT JOIN agency_parent_relationships rel ON rel.child_agency_id=a.id
       LEFT JOIN agencies p ON p.id=rel.parent_agency_id
       WHERE a.id=?`, [agencyId],
    );
    if (!row) throw new NotFoundError('Assigned agency', agencyId);
    const isSubAgency = actor.role === 'sub_agency' || String(row.agency_code || '').toUpperCase().startsWith('SUB-');
    const agency = {
      ...toCamelAgency(row),
      parentAgencyId: isSubAgency ? null : (row.parent_agency_id || null),
      parentAgencyName: isSubAgency ? null : (row.parent_agency_name || null),
      parentAgencyCode: isSubAgency ? null : (row.parent_agency_code || null),
    };
    // A sub-agency may see its own record, but never the parent distribution
    // agency's profile or other identifying details.
    const distributionAgency = isSubAgency ? null : agency;
    const subAgencies = isSubAgency ? [] : this.db.all(
      `SELECT a.*, p.id AS parent_agency_id, p.name AS parent_agency_name,
              p.agency_code AS parent_agency_code
       FROM agency_parent_relationships rel
       JOIN agencies a ON a.id=rel.child_agency_id
       LEFT JOIN agencies p ON p.id=rel.parent_agency_id
       WHERE rel.parent_agency_id=? AND a.status!='TERMINATED'
       ORDER BY a.name COLLATE NOCASE`, [agencyId],
    ).map((item) => ({
      ...toCamelAgency(item),
      parentAgencyId: item.parent_agency_id || null,
      parentAgencyName: item.parent_agency_name || null,
      parentAgencyCode: item.parent_agency_code || null,
    }));
    const visibleAgencyIds = [agencyId, ...subAgencies.map((item) => item.id)];
    const placeholders = visibleAgencyIds.map(() => '?').join(',');
    const customers = this.db.all(
      `SELECT c.id, c.name, c.status, cta.agency_id,
              a.name AS agency_name, a.agency_code AS agency_code
       FROM customer_tenant_agencies cta
       JOIN companies c ON c.id=cta.company_id
       LEFT JOIN agencies a ON a.id=cta.agency_id
       WHERE cta.agency_id IN (${placeholders})
       ORDER BY c.name COLLATE NOCASE`, visibleAgencyIds,
    ).map((customer) => ({
      id: customer.id, name: customer.name, status: customer.status,
      agencyId: customer.agency_id, agencyName: customer.agency_name || '',
      agencyCode: customer.agency_code || '',
    }));
    const administrators = this.db.all(
      `SELECT u.full_name, u.email, u.username, aa.status
       FROM agency_administrators aa
       JOIN users u ON u.id=aa.user_id
       WHERE aa.agency_id=?
       ORDER BY aa.assigned_at DESC`, [agencyId],
    ).map((admin) => ({
      fullName: admin.full_name || '', email: admin.email || '',
      username: admin.username || '', status: admin.status,
    }));
    return {
      role: isSubAgency ? 'sub_agency' : 'agency',
      agency, distributionAgency, administrators, subAgencies, customers,
    };
  }

  async callerAgency(userId) {
    // FIX (audit 2026-11-02): resolve the caller from LOCAL SQLite FIRST.
    // The Supabase-first order made every local-admin flow hang on a cloud
    // round-trip, and — decisive for the sub-agency work — when the process
    // had live Supabase credentials the cloud lookup returned a REMOTE row
    // while local writes went to SQLite, desynchronising create/list/status.
    // Supabase remains the fallback for callers that exist only in the cloud.
    try {
      const row = this.db.get(
        `SELECT a.id, a.agency_code, a.name, a.status, a.company_id
         FROM agency_administrators aa
         JOIN agencies a ON a.id = aa.agency_id
         WHERE aa.user_id = ? AND aa.status = 'ACTIVE'
         LIMIT 1`,
        [userId],
      );
      if (row) return row;
    } catch { /* fall through to cloud */ }
    try {
      const sb = getSupabaseClient();
      const { data, error } = await sb
        .from('agency_administrators')
        .select('agency_id, agencies!inner(id, agency_code, name, status, company_id)')
        .eq('user_id', userId)
        .eq('status', 'ACTIVE')
        .limit(1);
      if (error) throw error;
      const row2 = data && data[0];
      if (!row2) return null;
      const agency = row2.agencies;
      return {
        id: agency.id,
        agency_code: agency.agency_code,
        name: agency.name,
        status: agency.status,
        company_id: agency.company_id,
      };
    } catch {
      return null;
    }
  }

    async listSubAgencies(userId, user) {
    // FIX (parent info, task): each row now carries its PARENT agency's
    // id/name/code via a LEFT JOIN through agency_parent_relationships, so the
    // View Details modal can display which root agency the sub-agency belongs
    // to. (The View modal renders from the list payload.)
    const caller = await this.callerAgency(userId);
    const isAdmin = (user && user.role === 'ADMIN') || (Array.isArray(user && user.permissions) && user.permissions.includes('*'));
    const PARENT_SELECT = `
      SELECT a.*,
             p.id AS parent_agency_id, p.name AS parent_agency_name, p.agency_code AS parent_agency_code
      FROM agencies a
      LEFT JOIN agency_parent_relationships rel ON rel.child_agency_id = a.id
      LEFT JOIN agencies p ON p.id = rel.parent_agency_id`;
    const withParent = (rows) => rows.map((r) => ({
      ...toCamelAgency(r),
      parentAgencyId: r.parent_agency_id || null,
      parentAgencyName: r.parent_agency_name || null,
      parentAgencyCode: r.parent_agency_code || null,
    }));
    if (isAdmin && !caller) {
      const rows = this.db.all(
        `${PARENT_SELECT} WHERE a.agency_code LIKE 'SUB-%' AND a.status != 'TERMINATED' ORDER BY a.name ASC`);
      return { parentAgency: null, agencies: withParent(rows) };
    }
    if (!caller) return { parentAgency: null, agencies: [] };

    // The list shows ONLY the caller's sub-agencies (children) — the caller's
    // own agency row is the header (parentAgency), not a list row. Matches the
    // audited test contract: fresh scope = empty list, parent = own agency.
    const childIds = [];
    try {
      const rels = this.db.all(
        'SELECT child_agency_id AS id FROM agency_parent_relationships WHERE parent_agency_id = ?',
        [caller.id],
      );
      for (const rel of rels) childIds.push(rel.id);
    } catch { /* parent link table missing for this caller; empty list */ }

    const scoped = [...new Set(childIds)].filter(Boolean);
    if (!scoped.length) return { parentAgency: toCamelAgency(caller), agencies: [] };
    const placeholders = scoped.map(() => '?').join(',');
    // SUB- code filter enforced here too — a parent-scoped caller must never
    // see a root agency row in the sub-agency list, even if a stray
    // relationship points at one.
    const rows = this.db.all(
      `${PARENT_SELECT} WHERE a.id IN (${placeholders}) AND a.agency_code LIKE 'SUB-%' AND a.status != 'TERMINATED' ORDER BY a.name ASC`,
      scoped,
    );
    return { parentAgency: toCamelAgency(caller), agencies: withParent(rows) };
  }

  /** ROOT distribution agencies — serves the MOTHER COMPANY page.
   * Strict separation (task: conceptual split): rows whose agency_code does
   * NOT start with 'SUB-'. Sub-agencies (SUB-*) are exclusively the Agency
   * Control page's domain (listSubAgencies above); the Mother Company page
   * manages only top-level distribution agencies, which have no parent link. */
  listRootAgencies() {
    const rows = this.db.all(
      "SELECT * FROM agencies WHERE agency_code NOT LIKE 'SUB-%' AND status != 'TERMINATED' ORDER BY name ASC",
    );
    return { agencies: rows.map(toCamelAgency) };
  }
      async scopedAgencyIds(userId) {
    const parent = await this.callerAgency(userId);
    if (!parent) {
      // ADMIN fallback: allow acting on any agency in Supabase/local
      const localAgencies = this.db.all('SELECT id FROM agencies').map(a => a.id);
      try {
        const sb = getSupabaseClient();
        const { data } = await sb.from('agencies').select('id');
        const cloudAgencies = (data || []).map((a) => a.id);
        return Array.from(new Set([...localAgencies, ...cloudAgencies]));
      } catch {
        return localAgencies;
      }
    }
    let children = [];
    try {
      const sb = getSupabaseClient();
      const { data, error } = await sb
        .from('agency_parent_relationships')
        .select('child_agency_id')
        .eq('parent_agency_id', parent.id);
      if (error) throw error;
      children = (data || []).map((item) => item.child_agency_id);
    } catch {
      const rows = this.db.all(
        'SELECT child_agency_id AS id FROM agency_parent_relationships WHERE parent_agency_id = ?',
        [parent.id],
      );
      children = rows.map((c) => c.id);
    }
    const local = [parent.id, ...children].filter(Boolean);
    // FIX (sub-agency cloud probe 400s): the cloud round-trip below queried
    // `agencies.id = <local agy_*>` — Supabase rejects non-UUID input, the
    // whole block threw, and the previously-returned `local` scope was
    // discarded, collapsing every local-first caller's scope to []. Map local
    // ids to their deterministic cloud UUIDs first (and probe BOTH the local
    // uuid AND its cloud twin), then MERGE with the local scope instead of
    // replacing it. A cloud outage can now only ever narrow the cloud-side
    // extras — never the caller's own local subtree.
    const { localIdToCloudUuid } = require('../services/supabase.service');
    const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
    try {
      const sb = getSupabaseClient();
      const cloudIds = local.filter((id) => !isUuid(id)).map((id) => localIdToCloudUuid(id)).filter(Boolean);
      const probeTargets = [...new Set([...local.filter(isUuid), ...cloudIds])];
      const mapped = (await Promise.all(probeTargets.map(async (id) => {
        const { data, error } = await sb.from('agencies').select('id').eq('id', id).limit(1);
        if (error) return null; // per-probe failure ≠ scope collapse
        return data && data[0] ? data[0].id : null;
      }))).filter(Boolean);
      const cloud = await Promise.all(mapped.filter(Boolean).map(async (parentCloudId) => {
        const { data, error } = await sb.from('agency_parent_relationships').select('child_agency_id').eq('parent_agency_id', parentCloudId);
        if (error) return [];
        return (data || []).map((item) => item.child_agency_id);
      }));
      const cloudChildren = cloud.flat();
      // merge, don't replace: local subtree always survives a cloud error
      const merge = new Set([...local, ...mapped, ...cloudChildren]);
      // translate any cloud-uuid children back to local ids when possible
      for (const cid of cloudChildren) {
        if (!isUuid(cid)) continue;
        const allLocal = this.db.all('SELECT id FROM agencies');
        const match = (allLocal || []).find((r) => localIdToCloudUuid(r.id) === cid);
        if (match) merge.add(match.id);
      }
      return Array.from(merge).filter(Boolean);
    } catch {
      return local;
    }
  }


  async createSubAgency(user, { name, parentAgencyId }) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new ValidationError('Sub-agency validation failed.', { name: 'Name is required.' });
    const actorId = user && (user.userId || user.id || user);
    const actor = resolveCaller(this.db, {
      userId: actorId,
      supabaseUserId: user && user.supabaseUserId,
    });
    if (!actor) throw new AuthorizationError('Authentication required.');
    if (actor.role === 'sub_agency') {
      throw new AuthorizationError('Sub-agencies do not have permission to create other sub-agencies.');
    }
    if (actor.role === 'customer_tenant') {
      throw new AuthorizationError('Customer tenants do not have permission to create accounts.');
    }
    if (!['agency', 'platform'].includes(actor.role)) {
      throw new AuthorizationError('Your role does not have permission to create sub-agencies.');
    }
    // FIX (audit F2, §3.1): id namespace parity restored. The rebuilt version
    // used crypto.randomUUID() + 'SUB-' + Date.now(), producing ids that
    // mismatched generateId('agy') conventions everywhere else and cloud ids
    // that localIdToCloudUuid() would re-hash (create/create sync mismatch).
    // company stub now uses generateId('cmp') — the same namespace
    // createCustomer uses — instead of 'company_' + agencyId.
    const id = generateId('agy');
    const companyId = generateId('cmp');
    const code = 'SUB-' + id.slice(-8).toUpperCase();
    // Resolve the caller BEFORE any write. An agency administrator creates
    // under their own agency by default; a Mother Company ADMIN with no
    // administered agency may still create, but MUST choose a parent from the
    // UI dropdown (validated below against the admin fallback scope).
    const caller = await this.callerAgency(actorId);
    const isAdmin = actor.role === 'platform';
    if (!caller && !isAdmin) {
      throw new AuthorizationError('Only an agency administrator can create sub-agencies.');
    }
    // PARENT SELECTION (task: "Parent Agency" dropdown):
    // The UI now sends the agency the new sub-agency belongs under. Default is
    // the caller's own agency (audited behavior). An explicitly provided parent
    // must exist locally and be inside the caller's scope — otherwise the
    // parent link would silently orphan the new agency (scopedAgencyIds could
    // never see it) or leak cross-tenant structure.
    let parentId = caller ? caller.id : null;
    if (parentAgencyId && String(parentAgencyId).trim() && (!caller || String(parentAgencyId).trim() !== caller.id)) {
      const requested = String(parentAgencyId).trim();
      // FIX (cloud-id parity): the Parent Agency dropdown is populated from
      // /mother-company/agencies, whose rows carry SUPABASE UUID ids — while
      // this table (and agency_parent_relationships) key on LOCAL ids. A UUID
      // parent that is missing locally is NOT an error: resolve cloud → local
      // by agency_code (the audited pattern) and use the local id. Only a
      // genuinely unknown id (neither local nor cloud) is rejected.
      let parentRow = this.db.get('SELECT id, name, status, agency_code FROM agencies WHERE id = ?', [requested]);
      if (!parentRow && isUuid(requested)) {
        try {
          const sb = getSupabaseClient();
          const { data, error } = await sb.from('agencies').select('id, agency_code, name, status').eq('id', requested).limit(1);
          if (!error && data && data[0] && data[0].agency_code) {
            parentRow = this.db.get('SELECT id, name, status, agency_code FROM agencies WHERE agency_code = ?', [data[0].agency_code]);
          }
        } catch { /* cloud lookup unavailable — fall through to the error below */ }
      }
      if (!parentRow) {
        throw new ValidationError('Sub-agency validation failed.', { parentAgencyId: 'Selected parent agency does not exist.' });
      }
      // Scope check against the RESOLVED LOCAL id (a cloud UUID will not be
      // in the local scope list; the local row's id is the canonical key).
      const scoped = await this.scopedAgencyIds(user && (user.userId || user));
      if (!scoped.includes(parentRow.id)) {
        throw new AuthorizationError('The selected parent agency is outside your scope.');
      }
      if (/^SUB-/.test(parentRow.agency_code || '')) {
        // Guard: sub-agencies cannot themselves be parents (one level of
        // hierarchy by design; deep nesting was never specified).
        throw new ValidationError('Sub-agency validation failed.', { parentAgencyId: 'A sub-agency cannot be a parent agency. Choose a distribution agency.' });
      }
      // Use the LOCAL id for the relationship row — agency_parent_relationships
      // keys on local ids (scopedAgencyIds/listSubAgencies join on them).
      parentId = parentRow.id;
    }
    if (actor.role === 'agency' && parentId !== actor.localAgencyId) {
      throw new AuthorizationError('Distribution agencies can create sub-agencies only under their own agency.');
    }
    if (!parentId && !isAdmin) {
      throw new ValidationError('Sub-agency validation failed.', { parentAgencyId: 'Select the parent agency this sub-agency belongs to.' });
    }

    // 1. Save to Local SQLite (Ensure related companies exist first to avoid FK errors)
    try {
      // Ensure the provider company 'default' exists (if not, create a stub)
      this.db.run("INSERT OR IGNORE INTO companies (id, name, status) VALUES ('default', 'Default Provider', 'ACTIVE')");
      // Ensure the agency's own tenant company exists
      this.db.run('INSERT OR IGNORE INTO companies (id, name, status) VALUES (?, ?, ?)', [companyId, cleanName, 'ACTIVE']);

      // Insert the agency
      this.db.run(
        'INSERT INTO agencies (id, company_id, provider_company_id, name, agency_code, status) VALUES (?, ?, ?, ?, ?, ?)',
        [id, companyId, 'default', cleanName, code, 'PENDING']
      );
      // Parent link only when a parent exists. ROOT agencies (created by the
      // Mother Company operator via the MC page) have no parent link by
      // design — strict separation: roots are MC territory, subs are AC.
      if (parentId) {
        this.db.run(
          'INSERT INTO agency_parent_relationships (child_agency_id, parent_agency_id, created_by) VALUES (?,?,?)',
          [id, parentId, user && user.userId],
        );
      }
    } catch (err) {
      console.error('Local create failed:', err);
      throw err;
    }

    // 2. Cloud sync via the canonical forwarder (FIX audit F2): the rebuilt
    // version hand-rolled sb.from('companies').upsert().then(→ agencies.insert),
    // which inserted the LOCAL id into Supabase's UUID PK (fails for agy_* ids)
    // and skipped cloud_sync_status bookkeeping entirely. forwardAgencyToCloud
    // handles the company stub, the UUID mapping (localIdToCloudUuid), the
    // retry-worker sync row, and never blocks the caller.
    const newAgency = this.db.get('SELECT * FROM agencies WHERE id = ?', [id]);
    try {
      forwardAgencyToCloud(this.db, newAgency, user);
    } catch (syncErr) {
      console.error('[agency-control] createSubAgency cloud sync failed:', syncErr && syncErr.message ? syncErr.message : String(syncErr));
    }

    // FIX (audit P0 — F1): the parent-child link was never pushed to Supabase,
    // leaving the cloud hierarchy flat (agency_parent_relationships = 0 rows).
    // Push the relationship using the cloud UUIDs of BOTH agencies (local
    // agy_* ids are deterministic-mapped via localIdToCloudUuid, matching how
    // forwardAgencyToCloud maps the agency row itself). Best-effort: the local
    // link is the authority; a cloud failure is logged, not thrown.
    try {
      const sb = getSupabaseClient();
      const cloudChild = isUuid(id) ? id : localIdToCloudUuid(id);
      const cloudParent = isUuid(parentId) ? parentId : localIdToCloudUuid(parentId);
      const { error: relErr } = await sb.from('agency_parent_relationships').upsert(
        [{ child_agency_id: cloudChild, parent_agency_id: cloudParent, created_by: (user && user.userId) || null }],
        { onConflict: 'child_agency_id' },
      );
      if (relErr) console.error('[agency-control] parent relationship cloud sync failed:', relErr.message || JSON.stringify(relErr));
    } catch (relSyncErr) {
      console.error('[agency-control] parent relationship cloud sync threw:', relSyncErr && relSyncErr.message ? relSyncErr.message : String(relSyncErr));
    }

    return { id, name: cleanName, agencyCode: code, status: 'PENDING', parentAgencyId: parentId };
  }
  async changeSubAgencyStatus(userId, agencyId, { status, reason }) {
    if (!STATUS_VALUES.includes(status)) {
      throw new ValidationError('Invalid status.', { status: `Status must be one of ${STATUS_VALUES.join(', ')}.` });
    }
    const scoped = await this.scopedAgencyIds(userId);
    let agency = await this.db.get('SELECT * FROM agencies WHERE id = ?', [agencyId]);
    let isLocal = true;
    if (!agency) {
      try {
        const sb = getSupabaseClient();
        const { data, error } = await sb.from('agencies').select('*').eq('id', agencyId).limit(1);
        if (!error && data && data[0]) {
          agency = data[0];
          isLocal = false;
        }
      } catch {}
    }
    if (!agency || !scoped.includes(agencyId)) {
      throw new NotFoundError('Agency', agencyId);
    }
    if (agency.status === status) {
      return toCamelAgency(isLocal ? agency : (this.db.get('SELECT * FROM agencies WHERE id = ?', [agencyId]) || agency));
    }
    if (!(ALLOWED_TRANSITIONS[agency.status] || []).includes(status)) {
      throw new ValidationError(`Invalid transition ${agency.status} -> ${status}.`);
    }
    if (isLocal) {
      this.db.transaction(() => {
        const isActive = status === 'ACTIVE' ? 1 : 0;
        this.db.run(
          `UPDATE agencies SET status = ?, is_active = ?,
             activated_at = CASE WHEN ? = 'ACTIVE' THEN CURRENT_TIMESTAMP ELSE activated_at END,
             suspended_at = CASE WHEN ? = 'SUSPENDED' THEN CURRENT_TIMESTAMP ELSE suspended_at END,
             suspended_reason = CASE WHEN ? = 'SUSPENDED' THEN ? ELSE suspended_reason END,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [status, isActive, status, status, status, reason || null, agencyId],
        );
        this.db.run(
          'INSERT INTO agency_status_history (id, agency_id, from_status, to_status, reason, changed_by) VALUES (?,?,?,?,?,?)',
          [generateId('ash'), agencyId, agency.status, status, reason || null, userId],
        );
      })();
      return toCamelAgency(this.db.get('SELECT * FROM agencies WHERE id = ?', [agencyId]));
    }
    const isActive = status === 'ACTIVE' ? 1 : 0;
    const updatePayload = {
      status,
      is_active: isActive,
      activated_at: status === 'ACTIVE' ? new Date().toISOString() : undefined,
      suspended_at: status === 'SUSPENDED' ? new Date().toISOString() : undefined,
      suspended_reason: status === 'SUSPENDED' ? (reason || null) : undefined,
      updated_at: new Date().toISOString(),
    };
    Object.keys(updatePayload).forEach((k) => updatePayload[k] === undefined && delete updatePayload[k]);
    try {
      const sb = getSupabaseClient();
      const { data, error } = await sb.from('agencies').update(updatePayload).eq('id', agencyId).select('*').limit(1);
      if (error) {
        console.error('[agency-control] changeSubAgencyStatus cloud update failed:', JSON.stringify(error));
        throw new Error('Cloud status update failed: ' + (error.message || JSON.stringify(error)));
      }
      if (!data || !data[0]) {
        console.error('[agency-control] changeSubAgencyStatus cloud update returned empty:', JSON.stringify({ agencyId, updatePayload }));
        throw new Error('Cloud status update returned no data.');
      }
      try {
        // FIX (audit F4, §3.3): the old line hashed the input id unconditionally
        // (`localIdToCloudUuid(agencyId) || agencyId`), so for a LOCAL agy_* id
        // it computed a cloud UUID that exists nowhere locally, the `existing`
        // lookup failed, and the INSERT branch created a duplicate local agency
        // row under the cloud id. Only hash when the input is cloud-shaped.
        const localId = isUuid(agencyId) ? localIdToCloudUuid(agencyId) : agencyId;
        const existing = this.db.get('SELECT id FROM agencies WHERE id = ?', [localId]);
        if (existing) {
          this.db.run(
            `UPDATE agencies SET status = ?, is_active = ?, activated_at = ?, suspended_at = ?, suspended_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [status, isActive, updatePayload.activated_at || null, updatePayload.suspended_at || null, updatePayload.suspended_reason || null, localId]
          );
        } else {
          this.db.run(
            `INSERT INTO agencies (id, company_id, provider_company_id, agency_code, name, status, is_active, activated_at, suspended_at, suspended_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [localId, agency.company_id || null, agency.provider_company_id || 'default', agency.agency_code || null, agency.name || null, status, isActive, updatePayload.activated_at || null, updatePayload.suspended_at || null, updatePayload.suspended_reason || null]
          );
        }
      } catch (localErr) {
        console.error('[agency-control] changeSubAgencyStatus local upsert failed:', localErr && localErr.message ? localErr.message : String(localErr));
      }
      return toCamelAgency(data[0]);
    } catch (syncErr) {
      console.error('[agency-control] changeSubAgencyStatus cloud update exception:', syncErr && syncErr.message ? syncErr.message : String(syncErr));
      throw syncErr;
    }
  }

  async bulkSubAgencyStatus(userId, { ids = [], status, reason }) {
    const scoped = await this.scopedAgencyIds(userId);
    const valid = (Array.isArray(ids) ? ids : []).filter((id) => scoped.includes(id));
    if (!valid.length) return { updated: 0 };
    this.db.transaction(() => {
      const placeholders = valid.map(() => '?').join(',');
      const rows = this.db.all(`SELECT id, status FROM agencies WHERE id IN (${placeholders})`, valid);
      for (const row of rows) {
        if (row.status === status) continue;
        if (!(ALLOWED_TRANSITIONS[row.status] || []).includes(status)) continue;
        const isActive = status === 'ACTIVE' ? 1 : 0;
        this.db.run(
          `UPDATE agencies SET status = ?, is_active = ?,
             activated_at = CASE WHEN ? = 'ACTIVE' THEN CURRENT_TIMESTAMP ELSE activated_at END,
             suspended_at = CASE WHEN ? = 'SUSPENDED' THEN CURRENT_TIMESTAMP ELSE suspended_at END,
             suspended_reason = CASE WHEN ? = 'SUSPENDED' THEN ? ELSE suspended_reason END,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [status, isActive, status, status, status, reason || null, row.id],
        );
        this.db.run(
          'INSERT INTO agency_status_history (id, agency_id, from_status, to_status, reason, changed_by) VALUES (?,?,?,?,?,?)',
          [generateId('ash'), row.id, row.status, status, reason || null, userId],
        );
      }
    })();
    return { updated: valid.length };
  }

    async bulkRemoveSubAgencies(userId, { ids = [] }) {
    if (!Array.isArray(ids) || ids.length === 0) return { updated: 0, agencies: [] };
    let deleted = 0;
    const deletedAgencies = [];
    for (const agencyId of ids) {
      try {
        await this.removeHierarchyEntity(userId, 'sub_agency', agencyId);
        deleted++;
        deletedAgencies.push({ id: agencyId });
      } catch (err) {
        console.error('[agency-control] bulkRemoveSubAgencies failed for', agencyId, ':', err.message);
      }
    }
    return { updated: deleted, agencies: deletedAgencies };
  }

  async updateSubAgency(userId, agencyId, body) {
    const scoped = await this.scopedAgencyIds(userId);
    let agency = await this.db.get('SELECT * FROM agencies WHERE id = ?', [agencyId]);
    let isLocal = true;
    if (!agency) {
      try {
        const sb = getSupabaseClient();
        const { data, error } = await sb.from('agencies').select('*').eq('id', agencyId).limit(1);
        if (!error && data && data[0]) { agency = data[0]; isLocal = false; }
      } catch {}
    }
    if (!agency || !scoped.includes(agencyId)) throw new NotFoundError('Agency', agencyId);
    
    const updates = {};
    if (body.name && String(body.name).trim()) updates.name = String(body.name).trim();
    if (body.agencyCode) updates.agency_code = String(body.agencyCode).trim();
    if ('contactEmail' in body) updates.contact_email = String(body.contactEmail || '').trim();
    if ('contactPhone' in body) updates.contact_phone = String(body.contactPhone || '').trim();
    
    // Add new fields
    if ('address' in body) updates.address = String(body.address || '').trim();
    if ('city' in body) updates.city = String(body.city || '').trim();
    if ('state' in body) updates.state = String(body.state || '').trim();
    if ('pincode' in body) updates.pincode = String(body.pincode || '').trim();

    if (!Object.keys(updates).length) return toCamelAgency(isLocal ? agency : this.db.get('SELECT * FROM agencies WHERE id = ?', [agencyId]) || agency);
    
    updates.updated_at = new Date().toISOString();
    let updated = agency;
    
    if (isLocal) {
      const setClause = Object.keys(updates).map((k) => k + ' = ?').join(', ');
      const params = Object.keys(updates).map((k) => updates[k]);
      params.push(agencyId);
      this.db.run('UPDATE agencies SET ' + setClause + ' WHERE id = ?', params);
      updated = this.db.get('SELECT * FROM agencies WHERE id = ?', [agencyId]);
    } else {
      try {
        const sb = getSupabaseClient();
        const { data, error } = await sb.from('agencies').update(updates).eq('id', agencyId).select('*').limit(1);
        if (!error && data && data[0]) updated = data[0];
      } catch (syncErr) { console.error('Cloud update failed:', syncErr); }
    }
    return toCamelAgency(updated);
  }

    async removeSubAgency(userId, agencyId) {
    // FIX (audit F3, §3.2): three defects from the rebuild restored to the
    // audited design:
    //   (a) the local deletes ran OUTSIDE a transaction — partial deletes
    //       persisted if any statement failed mid-sequence;
    //   (b) cloud_sync_status / cloud_sync_log were NOT purged, leaving a
    //       PENDING/FAILED sync row the retry worker would later re-upsert —
    //       the resurrection bug through the front door;
    //   (c) the Supabase deletes used the RAW local agencyId, which matches
    //       ZERO rows for a locally-created agy_* id (silent no-op, error:null)
    //       while the local row WAS deleted — the ghost-row defect. All cloud
    //       deletes now go through the isUuid-mapped cloudId.
    try {
      this.db.transaction(() => {
        this.db.run('DELETE FROM customer_tenant_agencies WHERE agency_id = ?', [agencyId]);
        this.db.run('DELETE FROM agency_parent_relationships WHERE child_agency_id = ? OR parent_agency_id = ?', [agencyId, agencyId]);
        this.db.run('DELETE FROM agency_administrators WHERE agency_id = ?', [agencyId]);
        this.db.run('DELETE FROM agency_status_history WHERE agency_id = ?', [agencyId]);
        this.db.run('DELETE FROM cloud_sync_status WHERE agency_id = ?', [agencyId]);
        this.db.run('DELETE FROM cloud_sync_log WHERE agency_id = ?', [agencyId]);
        this.db.run('DELETE FROM agencies WHERE id = ?', [agencyId]);
      })();
    } catch (err) {
      console.error('Local delete failed:', err);
      throw err;
    }

    // 2. Delete from Supabase with the correct id mapping
    try {
      const sb = getSupabaseClient();
      if (sb) {
        const cloudId = isUuid(agencyId) ? agencyId : localIdToCloudUuid(agencyId);
        await sb.from('customer_tenant_agencies').delete().eq('agency_id', cloudId);
        const orCondition = 'child_agency_id.eq.' + cloudId + ',parent_agency_id.eq.' + cloudId;
        await sb.from('agency_parent_relationships').delete().or(orCondition);
        await sb.from('agency_administrators').delete().eq('agency_id', cloudId);
        await sb.from('agency_status_history').delete().eq('agency_id', cloudId);
        await sb.from('agencies').delete().eq('id', cloudId);
      }
    } catch (e) { console.error('SB Delete Error:', e); }
    
    return true;
  }

  async removeHierarchyEntity(userId, type, entityId) {
    if (type === 'customer_tenant') {
      // Remove only the agency assignment; the customer company is retained
      // because CRM records may still reference it.
      return this.removeCustomer(userId, entityId);
    }
    if (type !== 'sub_agency') throw new ValidationError('Unsupported hierarchy entity type.');

    await this.assertAgencyInScope(userId, entityId);
    const agency = this.db.get('SELECT id, agency_code FROM agencies WHERE id=?', [entityId]);
    if (!agency || !String(agency.agency_code || '').startsWith('SUB-')) {
      throw new NotFoundError('Sub-agency', entityId);
    }
    const childCount = this.db.get(
      'SELECT COUNT(*) AS n FROM agency_parent_relationships WHERE parent_agency_id=?', [entityId],
    ).n;
    const tenantCount = this.db.get(
      'SELECT COUNT(*) AS n FROM customer_tenant_agencies WHERE agency_id=?', [entityId],
    ).n;
    if (childCount || tenantCount) {
      throw new AppError('This sub-agency still has child entities assigned. Remove or reassign them first.', 'ENTITY_HAS_DEPENDENCIES', 409);
    }

    const admins = this.db.all('SELECT id, user_id FROM agency_administrators WHERE agency_id=?', [entityId]);
    for (const admin of admins) {
      if (userDeletionBlockers(this.db, admin.user_id).length) {
        throw new AppError('A sub-agency administrator has dependent records and cannot be permanently deleted.', 'ENTITY_HAS_DEPENDENCIES', 409);
      }
      const links = this.db.get(
        'SELECT COUNT(*) AS n FROM agency_administrators WHERE user_id=? AND id<>?', [admin.user_id, admin.id],
      ).n;
      if (links) throw new AppError('A sub-agency administrator is linked to another agency.', 'ENTITY_HAS_DEPENDENCIES', 409);
    }
    for (const admin of admins) {
      // eslint-disable-next-line no-await-in-loop
      await this.permanentlyDeleteAdministrator(userId, admin.id);
    }
    await this.removeSubAgency(userId, entityId);
    return { id: entityId, deleted: true };
  }

  async addSubAgencyAdmin(userId, agencyId, { fullName, email, username, password }) {
    await this.assertAgencyInScope(userId, agencyId);
    let agency = this.db.get('SELECT * FROM agencies WHERE id = ?', [agencyId]);
    let isLocal = true;
    if (!agency) {
      try {
        const sb = getSupabaseClient();
        const { data, error } = await sb.from('agencies').select('*').eq('id', agencyId).limit(1);
        if (!error && data && data[0]) {
          agency = data[0];
          isLocal = false;
        }
      } catch {}
    }
    if (!agency) throw new NotFoundError('Agency', agencyId);
    if (!isLocal) throw new AppError('Agency must be synchronized to local storage before assigning an administrator.', 'AGENCY_SYNC_REQUIRED', 409);
    const clean = {
      fullName: String(fullName || '').trim(),
      email: String(email || '').trim().toLowerCase(),
      username: String(username || '').trim(),
      password: String(password || ''),
    };
    const missing = {};
    if (!clean.fullName) missing.fullName = 'Full name is required.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) missing.email = 'A valid email address is required.';
    if (!clean.username) missing.username = 'Username is required.';
    if (clean.password.length < 10) missing.password = 'Password must be at least 10 characters.';
    if (Object.keys(missing).length) throw new ValidationError('Admin validation failed.', missing);

    const localUser = this.db.get('SELECT * FROM users WHERE lower(trim(email)) = lower(?)', [clean.email]);
    const usernameOwner = this.db.get('SELECT id, email FROM users WHERE lower(username) = lower(?)', [clean.username]);
    const existingLink = localUser && this.db.get(
      'SELECT id, agency_id, status FROM agency_administrators WHERE user_id = ?', [localUser.id],
    );
    const { isConfigured, getSupabaseClient } = require('../config/supabase');
    const supabase = isConfigured() ? getSupabaseClient() : null;
    const { ensureAgencyAuthUser, findAuthUserByEmail } = require('./agency-admin-auth');
    const authMatch = supabase ? await findAuthUserByEmail(supabase, clean.email) : null;
    if (usernameOwner && (!localUser || usernameOwner.id !== localUser.id)) {
      throw new AppError('That username is already assigned to another user.', 'CONFLICT', 409);
    }
    if (existingLink && existingLink.agency_id !== agencyId) {
      throw new AppError('This account is already linked to another agency.', 'CONFLICT', 409);
    }
    if (localUser && String(localUser.status).toUpperCase() === 'ACTIVE'
      && existingLink && String(existingLink.status).toUpperCase() === 'ACTIVE') {
      throw new AppError('This user is already an active administrator for this agency.', 'CONFLICT', 409);
    }

    let authUser = null;
    let authCreated = false;
    if (supabase) {
      const identity = await ensureAgencyAuthUser(supabase, {
        email: clean.email, username: clean.username, password: clean.password,
        agencyId: localIdToCloudUuid(agencyId) || agencyId,
        existingUser: authMatch,
      });
      authUser = identity.user;
      authCreated = identity.created;
    }

    const companyId = agency.company_id || ('company_' + agencyId);
    this.db.run(
      "INSERT OR IGNORE INTO companies (id, name, status) VALUES (?, ?, 'ACTIVE')",
      [companyId, agency ? (agency.name || agencyId) : agencyId],
    );

    const adminId = generateId('aa');
    const assignedAdminId = existingLink ? existingLink.id : adminId;
    const userIdForAdmin = localUser ? localUser.id : generateId('usr');
    const passwordHash = await require('../auth/password').PasswordService.hash(clean.password);
    try {
      this.db.transaction(() => {
        if (localUser) {
          this.db.run(
            `UPDATE users SET company_id=COALESCE(company_id,?), username=?, password_hash=?, full_name=?, role='AGENCY_ADMIN',
               status='ACTIVE', hierarchy_role='agency', must_change_password=1,
               supabase_user_id=COALESCE(?, supabase_user_id), updated_at=CURRENT_TIMESTAMP WHERE id=?`,
            [companyId, clean.username, passwordHash, clean.fullName, authUser && authUser.id, userIdForAdmin],
          );
        } else {
          this.db.run(
            `INSERT INTO users (id, company_id, username, email, password_hash, full_name, role, status,
                                hierarchy_role, must_change_password, supabase_user_id, created_at)
             VALUES (?,?,?,?,?,?,?,'ACTIVE','agency',1,?,CURRENT_TIMESTAMP)`,
            [userIdForAdmin, companyId, clean.username, clean.email, passwordHash, clean.fullName, 'AGENCY_ADMIN', authUser && authUser.id],
          );
        }
        if (existingLink) {
          this.db.run(
            `UPDATE agency_administrators SET status='ACTIVE', revoked_at=NULL, revoked_by=NULL,
               assigned_by=?, assigned_at=CURRENT_TIMESTAMP WHERE id=?`,
            [userId, existingLink.id],
          );
        } else {
          this.db.run(
            `INSERT INTO agency_administrators (id, agency_id, user_id, company_id, role_code, assigned_by, assigned_at, status)
             VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,'ACTIVE')`,
            [adminId, agencyId, userIdForAdmin, companyId, 'AGENCY_ADMIN', userId],
          );
        }
      })();
    } catch (error) {
      if (authCreated && authUser && supabase) {
        const { error: rollbackError } = await supabase.auth.admin.deleteUser(authUser.id);
        if (rollbackError && rollbackError.code !== 'user_not_found') {
          console.error('[agency-admin] created Auth identity needs cleanup after local transaction failure', { authUserId: authUser.id, code: rollbackError.code || 'unknown' });
        }
      }
      const msg = String(error && error.message || error);
      if (/UNIQUE constraint failed: users\.(email|username)/i.test(msg)) {
        throw new AppError('A user with this email or username is already assigned.', 'CONFLICT', 409);
      }
      throw error;
    }

    if (supabase && authUser) {
      const { error: profileError } = await supabase.from('profiles').upsert({
        user_id: authUser.id,
        username: clean.username.toLowerCase(),
        role: 'agency',
        agency_id: localIdToCloudUuid(agencyId) || agencyId,
        must_change_password: true,
        is_active: true,
      }, { onConflict: 'user_id' });
      if (profileError) console.error('[agency-admin] profile mirror sync failed', { authUserId: authUser.id, code: profileError.code || 'unknown' });
    }

    // Mirror the local assignment to the public agency table when configured.
    try {
      if (supabase) {
        const cloudAgencyId = localIdToCloudUuid(agencyId) || agencyId;
        const { error } = await supabase.from('agency_administrators').upsert([{
          id: localIdToCloudUuid(assignedAdminId),
          agency_id: cloudAgencyId,
          company_id: companyId,
          user_id: authUser && authUser.id,
          role_code: 'AGENCY_ADMIN',
          assigned_by: userId,
          status: 'ACTIVE',
        }], { onConflict: 'id' });
        if (error) console.error('[agency-admin] public mirror sync failed', { adminId: assignedAdminId, code: error.code || 'unknown' });
      }
    } catch (syncErr) {
      console.error('[agency-admin] public mirror sync exception', { adminId: assignedAdminId, message: syncErr.message });
    }
    
    return { id: assignedAdminId, agencyId, fullName: clean.fullName, email: clean.email, username: clean.username };
  }

  /** Move an existing administrator identity to a selected agency. This is
   *  intentionally platform-only: it changes who administers the agency, but
   *  keeps the user's company_id so their existing CRM data remains intact. */
  async reassignExistingSubAgencyAdmin(actorUserId, agencyId, email) {
    const actor = resolveCaller(this.db, { userId: actorUserId });
    if (!actor || actor.role !== 'platform') {
      throw new AuthorizationError('Only a platform administrator can reassign an account between agencies.');
    }
    await this.assertAgencyInScope(actorUserId, agencyId);
    const target = this.db.get('SELECT * FROM agencies WHERE id = ?', [agencyId]);
    if (!target) throw new NotFoundError('Agency', agencyId);
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new ValidationError('Administrator reassignment failed.', { email: 'A valid email address is required.' });
    }
    const user = this.db.get('SELECT id, email, username, full_name, role, hierarchy_role, supabase_user_id FROM users WHERE lower(trim(email)) = ?', [normalizedEmail]);
    if (!user) throw new NotFoundError('Existing agency administrator', normalizedEmail);
    if (!['agency', 'sub_agency'].includes(String(user.hierarchy_role || '').toLowerCase())
      && !['AGENCY_ADMIN', 'AGENCY'].includes(String(user.role || '').toUpperCase())) {
      throw new AppError('That account is not an agency administrator and cannot be reassigned here.', 'CONFLICT', 409);
    }
    const links = this.db.all(
      `SELECT aa.id, aa.agency_id, aa.status, a.name AS agency_name
       FROM agency_administrators aa LEFT JOIN agencies a ON a.id = aa.agency_id
       WHERE aa.user_id = ?`, [user.id],
    );
    const link = links[0] || null;
    if (links.length === 1 && link.agency_id === agencyId && String(link.status).toUpperCase() === 'ACTIVE') {
      throw new AppError('This user is already an active administrator for this agency.', 'CONFLICT', 409);
    }

    const { isConfigured, getSupabaseClient } = require('../config/supabase');
    if (!isConfigured()) throw new AppError('Supabase is unavailable for reassigning this account.', 'SUPABASE_UNAVAILABLE', 503);
    const supabase = getSupabaseClient();
    const { findAuthUserByEmail } = require('./agency-admin-auth');
    const authUser = await findAuthUserByEmail(supabase, normalizedEmail);
    if (!authUser?.id) throw new NotFoundError('Supabase Auth account', normalizedEmail);
    if (user.supabase_user_id && user.supabase_user_id !== authUser.id) {
      throw new AppError('The local account and Supabase account do not match; reconcile the identity before reassignment.', 'IDENTITY_MISMATCH', 409);
    }
    const authRole = String(authUser.app_metadata?.role || '').toLowerCase();
    if (authRole && !['agency', 'agency_admin'].includes(authRole)) {
      throw new AppError('That Supabase account belongs to a different account type.', 'CONFLICT', 409);
    }

    const cloudAgencyId = localIdToCloudUuid(agencyId) || agencyId;
    const adminLinkId = link ? link.id : generateId('aa');
    const duplicateLinks = links.slice(1);
    const { error: authError } = await supabase.auth.admin.updateUserById(authUser.id, {
      app_metadata: { ...(authUser.app_metadata || {}), role: 'agency', agency_id: cloudAgencyId },
    });
    if (authError) throw new AppError('Supabase rejected the agency reassignment.', 'SUPABASE_AUTH_LINK_FAILED', 502);

    try {
      this.db.transaction(() => {
        if (link) {
          this.db.run(
            `UPDATE agency_administrators SET agency_id=?, company_id=?, status='ACTIVE', revoked_at=NULL,
             revoked_by=NULL, assigned_by=?, assigned_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?`,
            [agencyId, target.company_id, actorUserId, adminLinkId, user.id],
          );
        } else {
          this.db.run(
            `INSERT INTO agency_administrators (id, agency_id, user_id, company_id, role_code, assigned_by, assigned_at, status)
             VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,'ACTIVE')`,
            [adminLinkId, agencyId, user.id, target.company_id, 'AGENCY_ADMIN', actorUserId],
          );
        }
        for (const duplicate of duplicateLinks) {
          this.db.run('DELETE FROM agency_administrators WHERE id=? AND user_id=?', [duplicate.id, user.id]);
        }
        this.db.run('UPDATE users SET hierarchy_role=\'agency\', supabase_user_id=COALESCE(supabase_user_id, ?) WHERE id=?', [authUser.id, user.id]);
      })();
    } catch (error) {
      // The Auth claim has been updated, so keep this failure visible. Retrying
      // the same explicit reassignment is safe and does not recreate the user.
      throw error;
    }
    // SQLite is authoritative for the hierarchy. Cloud mirrors are retried in
    // the existing sync queue and must not turn a committed reassignment into
    // a false failure (which previously left Auth and local ownership split).
    for (const duplicate of duplicateLinks) {
      try {
        const { error } = await supabase.from('agency_administrators').delete()
          .eq('id', localIdToCloudUuid(duplicate.id));
        if (error) console.error('[agency-admin-reassign] duplicate mirror cleanup failed', { code: error.code || 'unknown' });
      } catch (error) {
        console.error('[agency-admin-reassign] duplicate mirror cleanup threw', { message: String(error.message || error).slice(0, 160) });
      }
    }
    try {
      const { error: profileError } = await supabase.from('profiles').upsert({
        user_id: authUser.id, username: String(user.username || '').toLowerCase(),
        role: 'agency', agency_id: cloudAgencyId, is_active: true,
      }, { onConflict: 'user_id' });
      if (profileError && !['PGRST205', '42P01'].includes(profileError.code)) {
        console.error('[agency-admin-reassign] profile mirror sync failed', { code: profileError.code || 'unknown' });
      }
    } catch (error) {
      console.error('[agency-admin-reassign] profile mirror sync threw', { message: String(error.message || error).slice(0, 160) });
    }
    forwardAgencyToCloud(this.db, target, actorUserId);
    return { id: adminLinkId, agencyId, email: normalizedEmail, reassigned: true, consolidatedAssignments: duplicateLinks.length, dataPreserved: true };
  }

  async permanentlyDeleteAdministrator(actorUserId, adminLinkId) {
    const link = this.db.get(
      `SELECT aa.id AS admin_id, aa.agency_id, aa.user_id, u.email, u.supabase_user_id,
              u.role AS user_role
       FROM agency_administrators aa JOIN users u ON u.id = aa.user_id
       WHERE aa.id = ?`,
      [adminLinkId],
    );
    if (!link) throw new NotFoundError('Agency administrator', adminLinkId);

    const isPlatformAdmin = Boolean(this.db.get(
      `SELECT 1 AS ok FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       WHERE u.id = ? AND (upper(u.role) = 'ADMIN' OR ur.role_id = 'role_admin') LIMIT 1`,
      [actorUserId],
    ));
    const owner = this.db.get(
      `SELECT aa.agency_id AS owner_agency_id
       FROM agency_administrators aa
       WHERE aa.user_id = ? AND aa.status = 'ACTIVE' LIMIT 1`,
      [actorUserId],
    );
    const ownsAgency = owner && (owner.owner_agency_id === link.agency_id || this.db.get(
      `SELECT 1 AS ok FROM agency_parent_relationships
       WHERE parent_agency_id = ? AND child_agency_id = ? LIMIT 1`,
      [owner.owner_agency_id, link.agency_id],
    ));
    if (!isPlatformAdmin && !ownsAgency) {
      throw new AuthorizationError('Only a platform administrator or the owning agency administrator can permanently delete this account.');
    }

    const otherLinks = this.db.get(
      'SELECT COUNT(*) AS n FROM agency_administrators WHERE user_id = ? AND id <> ?',
      [link.user_id, link.admin_id],
    ).n;
    if (otherLinks > 0) {
      throw new AppError('This account is linked to another agency; remove only this agency assignment.', 'CONFLICT', 409);
    }

    const blockers = userDeletionBlockers(this.db, link.user_id);
    if (blockers.length) {
      throw new AppError('This user has dependent records and cannot be permanently deleted.', 'ENTITY_HAS_DEPENDENCIES', 409);
    }

    const queueId = `admin-delete-${link.admin_id}`;
    this.db.run(
      `INSERT INTO admin_identity_cleanup_queue (id, agency_admin_id, user_id, supabase_user_id, phase)
       VALUES (?, ?, ?, ?, 'PENDING_AUTH')
       ON CONFLICT(id) DO UPDATE SET attempts=admin_identity_cleanup_queue.attempts+1,
         last_error=NULL, updated_at=CURRENT_TIMESTAMP`,
      [queueId, link.admin_id, link.user_id, link.supabase_user_id || null],
    );

    let supabase = null;
    let authUserId = link.supabase_user_id || null;
    try {
      const { isConfigured, getSupabaseClient } = require('../config/supabase');
      if (isConfigured()) {
        supabase = getSupabaseClient();
        if (!authUserId) {
          const { findAuthUserByEmail } = require('./agency-admin-auth');
          const match = await findAuthUserByEmail(supabase, link.email);
          authUserId = match && match.id;
        }
      } else if (authUserId) {
        throw new AppError('Supabase is unavailable for deleting the linked Auth identity.', 'SUPABASE_UNAVAILABLE', 503);
      }

      if (authUserId && supabase) {
        const { error } = await supabase.auth.admin.deleteUser(authUserId);
        if (error && error.code !== 'user_not_found') throw new AppError('Supabase Auth deletion failed.', 'SUPABASE_AUTH_DELETE_FAILED', 502);
        this.db.run(
          `UPDATE admin_identity_cleanup_queue SET supabase_user_id=?, phase='AUTH_DELETED', updated_at=CURRENT_TIMESTAMP WHERE id=?`,
          [authUserId, queueId],
        );
        const { error: profileError } = await supabase.from('profiles').delete().eq('user_id', authUserId);
        // Some deployments store the Auth identity only and do not have a
        // public.profiles table. A missing optional mirror is already clean.
        if (profileError && !['PGRST205', '42P01'].includes(profileError.code)) {
          throw new AppError('Supabase profile cleanup failed.', 'SUPABASE_PROFILE_DELETE_FAILED', 502);
        }
      } else {
        this.db.run(`UPDATE admin_identity_cleanup_queue SET phase='AUTH_DELETED', updated_at=CURRENT_TIMESTAMP WHERE id=?`, [queueId]);
      }

      if (supabase) {
        const { error: mirrorError } = await supabase.from('agency_administrators')
          .delete()
          .eq('id', localIdToCloudUuid(link.admin_id));
        if (mirrorError) throw new AppError('Supabase administrator mirror cleanup failed.', 'SUPABASE_MIRROR_DELETE_FAILED', 502);
      }
      this.db.run(`UPDATE admin_identity_cleanup_queue SET phase='CLOUD_MIRROR_DELETED', updated_at=CURRENT_TIMESTAMP WHERE id=?`, [queueId]);

      this.db.transaction(() => {
        const currentLink = this.db.get('SELECT user_id FROM agency_administrators WHERE id = ?', [link.admin_id]);
        if (!currentLink || currentLink.user_id !== link.user_id) throw new AppError('Administrator link changed during deletion.', 'CONFLICT', 409);
        this.db.run('DELETE FROM agency_administrators WHERE id = ?', [link.admin_id]);
        this.db.run('DELETE FROM user_roles WHERE user_id = ?', [link.user_id]);
        this.db.run('DELETE FROM users WHERE id = ?', [link.user_id]);
        this.db.run(`UPDATE admin_identity_cleanup_queue SET phase='COMPLETE', updated_at=CURRENT_TIMESTAMP WHERE id=?`, [queueId]);
      })();
      return { id: link.admin_id, deleted: true };
    } catch (error) {
      const message = String(error && error.message || error).slice(0, 500);
      try {
        this.db.run(
          'UPDATE admin_identity_cleanup_queue SET supabase_user_id=COALESCE(?,supabase_user_id), attempts=attempts+1, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
          [authUserId, message, queueId],
        );
      } catch (queueError) {
        console.error('[admin-hard-delete] retry queue update failed', { queueId, message: queueError.message });
      }
      console.error('[admin-hard-delete] cleanup remains pending', { queueId, phase: this.db.get('SELECT phase FROM admin_identity_cleanup_queue WHERE id=?', [queueId])?.phase || 'UNKNOWN' });
      throw error;
    }
  }

  async permanentlyDeleteAdministratorByEmail(actorUserId, email) {
    const actor = resolveCaller(this.db, { userId: actorUserId });
    if (!actor || actor.role !== 'platform') {
      throw new AuthorizationError('Only a platform administrator can permanently remove an account by email.');
    }
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const user = this.db.get(
      'SELECT id, email, role, hierarchy_role, supabase_user_id FROM users WHERE lower(trim(email))=?', [normalizedEmail],
    );
    const links = this.db.all(
      `SELECT aa.id FROM agency_administrators aa JOIN users u ON u.id=aa.user_id
       WHERE lower(trim(u.email))=?`, [normalizedEmail],
    );
    if (!user) throw new NotFoundError('Agency administrator', normalizedEmail);
    if (!links.length && user) {
      if (!['agency', 'sub_agency'].includes(String(user.hierarchy_role || '').toLowerCase())
        && !['AGENCY_ADMIN', 'AGENCY'].includes(String(user.role || '').toUpperCase())) {
        throw new AppError('This account is not an agency administrator and cannot be permanently removed here.', 'CONFLICT', 409);
      }
      return this.permanentlyDeleteUnassignedAdministrator(user);
    }
    if (links.length !== 1) {
      throw new AppError('This account has multiple agency assignments. Remove or reconcile those assignments before permanent deletion.', 'CONFLICT', 409);
    }
    return this.permanentlyDeleteAdministrator(actorUserId, links[0].id);
  }

  async permanentlyDeleteUnassignedAdministrator(user) {
    const blockers = userDeletionBlockers(this.db, user.id);
    if (blockers.length) {
      throw new AppError('This user has dependent records and cannot be permanently deleted.', 'ENTITY_HAS_DEPENDENCIES', 409);
    }
    const queueId = `admin-delete-orphan-${user.id}`;
    this.db.run(
      `INSERT INTO admin_identity_cleanup_queue (id, agency_admin_id, user_id, supabase_user_id, phase)
       VALUES (?, ?, ?, ?, 'PENDING_AUTH')
       ON CONFLICT(id) DO UPDATE SET attempts=admin_identity_cleanup_queue.attempts+1,
         last_error=NULL, updated_at=CURRENT_TIMESTAMP`,
      [queueId, `orphan-${user.id}`, user.id, user.supabase_user_id || null],
    );
    let supabase = null;
    let authUserId = user.supabase_user_id || null;
    try {
      const { isConfigured, getSupabaseClient } = require('../config/supabase');
      if (isConfigured()) {
        supabase = getSupabaseClient();
        if (!authUserId) {
          const { findAuthUserByEmail } = require('./agency-admin-auth');
          const match = await findAuthUserByEmail(supabase, user.email);
          authUserId = match && match.id;
        }
      } else if (authUserId) {
        throw new AppError('Supabase is unavailable for deleting the linked Auth identity.', 'SUPABASE_UNAVAILABLE', 503);
      }
      if (authUserId && supabase) {
        const { error } = await supabase.auth.admin.deleteUser(authUserId);
        if (error && error.code !== 'user_not_found') throw new AppError('Supabase Auth deletion failed.', 'SUPABASE_AUTH_DELETE_FAILED', 502);
        this.db.run(`UPDATE admin_identity_cleanup_queue SET phase='AUTH_DELETED', updated_at=CURRENT_TIMESTAMP WHERE id=?`, [queueId]);
        const { error: profileError } = await supabase.from('profiles').delete().eq('user_id', authUserId);
        if (profileError && !['PGRST205', '42P01'].includes(profileError.code)) {
          throw new AppError('Supabase profile cleanup failed.', 'SUPABASE_PROFILE_DELETE_FAILED', 502);
        }
        const { error: assignmentError } = await supabase.from('agency_administrators').delete().eq('user_id', authUserId);
        if (assignmentError && !['PGRST205', '42P01'].includes(assignmentError.code)) {
          throw new AppError('Supabase administrator mirror cleanup failed.', 'SUPABASE_MIRROR_DELETE_FAILED', 502);
        }
      } else {
        this.db.run(`UPDATE admin_identity_cleanup_queue SET phase='AUTH_DELETED', updated_at=CURRENT_TIMESTAMP WHERE id=?`, [queueId]);
      }
      this.db.run(`UPDATE admin_identity_cleanup_queue SET phase='CLOUD_MIRROR_DELETED', updated_at=CURRENT_TIMESTAMP WHERE id=?`, [queueId]);
      this.db.transaction(() => {
        this.db.run('DELETE FROM user_roles WHERE user_id=?', [user.id]);
        this.db.run('DELETE FROM users WHERE id=?', [user.id]);
        this.db.run(`UPDATE admin_identity_cleanup_queue SET phase='COMPLETE', updated_at=CURRENT_TIMESTAMP WHERE id=?`, [queueId]);
      })();
      return { id: user.id, deleted: true };
    } catch (error) {
      const message = String(error && error.message || error).slice(0, 500);
      this.db.run(
        'UPDATE admin_identity_cleanup_queue SET supabase_user_id=COALESCE(?,supabase_user_id), attempts=attempts+1, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
        [authUserId, message, queueId],
      );
      throw error;
    }
  }

  async resetSubAgencyAdminPassword(userId, agencyId, { password }) {
    await this.assertAgencyInScope(userId, agencyId);
    const value = String(password || '');
    if (value.length < 10) throw new ValidationError('Password reset failed.', { password: 'Password must be at least 10 characters.' });
    const passwordHash = await require('../auth/password').PasswordService.hash(value);
    const admin = this.db.get(
      `SELECT aa.id, aa.user_id, u.supabase_user_id
       FROM agency_administrators aa JOIN users u ON u.id=aa.user_id
       WHERE aa.agency_id=? AND aa.status='ACTIVE' AND u.status='ACTIVE' LIMIT 1`,
      [agencyId],
    );
    if (!admin) {
      throw new NotFoundError('Agency administrator', agencyId);
    }
    if (admin.supabase_user_id) {
      const { isConfigured, getSupabaseClient } = require('../config/supabase');
      if (!isConfigured()) throw new AppError('Supabase is unavailable for resetting this Auth password.', 'SUPABASE_UNAVAILABLE', 503);
      const { error } = await getSupabaseClient().auth.admin.updateUserById(admin.supabase_user_id, { password: value });
      if (error) throw new AppError('Supabase rejected the administrator password reset.', 'SUPABASE_AUTH_UPDATE_FAILED', 502);
    }
    this.db.run('UPDATE users SET password_hash = ?, updated_at=CURRENT_TIMESTAMP WHERE id = ?', [passwordHash, admin.user_id]);
    return { agencyId, updated: true };
  }

    async getSubAgency(userId, agencyId) {
    await this.assertAgencyInScope(userId, agencyId);
    // FIX (parent info): include the parent agency's id/name/code so the View
    // Details modal can show which root agency this sub-agency belongs to.
    const agency = this.db.get(
      `SELECT a.*,
              p.id AS parent_agency_id, p.name AS parent_agency_name, p.agency_code AS parent_agency_code
       FROM agencies a
       LEFT JOIN agency_parent_relationships rel ON rel.child_agency_id = a.id
       LEFT JOIN agencies p ON p.id = rel.parent_agency_id
       WHERE a.id = ?`,
      [agencyId],
    );
    if (!agency) return null;
    return {
      ...toCamelAgency(agency),
      parentAgencyId: agency.parent_agency_id || null,
      parentAgencyName: agency.parent_agency_name || null,
      parentAgencyCode: agency.parent_agency_code || null,
    };
  }

    async listSubAgencyAdministrators(userId, agencyId) {
    await this.assertAgencyInScope(userId, agencyId);
    // FIX: the local agency_administrators table is a LINK table — it has NO
    // full_name/email/username columns. The old SELECT referenced those
    // columns directly, threw "no such column" on every call, and the catch
    // swallowed it → the View modal always showed "No administrators assigned"
    // even with admins present. Identity lives in users (joined via user_id).
    // Local-first id mapping, same policy as the rest of the service: resolve
    // the local agency row from whatever id form arrived (local agy_* text or
    // cloud UUID), then query by that local id; fall back to the raw id.
    try {
      let localAgencyId = agencyId;
      if (isUuid(agencyId)) {
        const localRow = this.db.get('SELECT id FROM agencies WHERE id = ? LIMIT 1', [agencyId]);
        if (!localRow) {
          // Cloud-only agency: no local administrators exist by definition.
          return [];
        }
        localAgencyId = localRow.id;
      }
      const local = this.db.all(
        `SELECT aa.id, aa.agency_id, aa.user_id, aa.role_code, aa.status,
                u.full_name, u.email, u.username
         FROM agency_administrators aa
         LEFT JOIN users u ON u.id = aa.user_id
         WHERE aa.agency_id = ?
         ORDER BY aa.assigned_at DESC`,
        [localAgencyId],
      );
      return local.map((admin) => ({
        id: admin.id,
        agencyId: admin.agency_id,
        userId: admin.user_id,
        roleCode: admin.role_code,
        fullName: admin.full_name || '',
        email: admin.email || '',
        username: admin.username || '',
        status: admin.status,
      }));
    } catch (e) {
      return []; 
    }
  }

  async listCustomers(userId) {
    const scoped = await this.scopedAgencyIds(userId);
    if (!scoped.length) return { customers: [] };
    let rows = [];
    try {
      const sb = getSupabaseClient();
      const { data, error } = await sb
        .from('customer_tenant_agencies')
        .select('company_id, agency_id, companies!inner(id, name, status)')
        .in('agency_id', scoped);
      if (error) throw error;
      rows = (data || [])
        .filter((item) => item.companies)
        .map((item) => ({
          id: item.companies.id,
          name: item.companies.name,
          status: item.companies.status,
          agencyId: item.agency_id,
          agencyName: null,
        }));
      const agencyIds = [...new Set(rows.map((row) => row.agencyId).filter(Boolean))];
      if (agencyIds.length) {
        const { data: agencies } = await sb
          .from('agencies')
          .select('id, name')
          .in('id', agencyIds);
        const agencyMap = new Map((agencies || []).map((a) => [a.id, a.name]));
        for (const row of rows) {
          row.agencyName = agencyMap.get(row.agencyId) || null;
        }
      }
    } catch {
      const placeholders = scoped.map(() => '?').join(',');
      const customers = this.db.all(
        `SELECT c.id, c.name, c.status, cta.agency_id AS agencyId, a.name AS agencyName
         FROM customer_tenant_agencies cta
         JOIN companies c ON c.id = cta.company_id
         LEFT JOIN agencies a ON a.id = cta.agency_id
         WHERE cta.agency_id IN (${placeholders})
         ORDER BY c.name ASC`,
        scoped,
      );
      rows = customers;
    }
    for (const row of rows) {
      const admin = this.db.get(
        "SELECT email FROM users WHERE company_id=? AND role='CUSTOMER_ADMIN' ORDER BY created_at DESC LIMIT 1",
        [row.id],
      );
      row.adminEmail = admin ? admin.email : null;
    }
    return { customers: rows };
  }

  /** Resolve a customer id returned by the cloud-backed list into the local
   * company/membership rows used by CRM writes. Cloud-only customer rows are
   * mirrored locally after their agency has been verified in the caller's
   * scope; this prevents a visible tenant from failing later with a generic
   * 404 when an administrator is assigned. */
  async ensureLocalCustomer(userId, customerId) {
    const id = String(customerId || '').trim();
    if (!id) throw new NotFoundError('Customer', id);
    const localMapping = this.db.get(
      'SELECT company_id, agency_id FROM customer_tenant_agencies WHERE company_id=?', [id],
    );
    if (localMapping) return id;

    // Some older cloud-backed rows use the deterministic UUID of a local
    // customer instead of its local cmp_* key. Resolve that form first.
    const { localIdToCloudUuid } = require('../services/supabase.service');
    const localCustomers = this.db.all('SELECT company_id FROM customer_tenant_agencies');
    const deterministicMatch = localCustomers.find((row) => localIdToCloudUuid(row.company_id) === id);
    if (deterministicMatch) return deterministicMatch.company_id;

    let cloudLink = null;
    try {
      const sb = getSupabaseClient();
      const { data, error } = await sb
        .from('customer_tenant_agencies')
        .select('company_id, agency_id, provider_company_id, companies!inner(id, name, status)')
        .eq('company_id', id)
        .limit(1);
      if (!error && data && data[0] && data[0].companies) cloudLink = data[0];
    } catch { /* handled as not found below */ }
    if (!cloudLink) throw new NotFoundError('Customer', id);

    const scoped = await this.scopedAgencyIds(userId);
    if (!scoped.includes(cloudLink.agency_id)) throw new NotFoundError('Customer', id);
    const agencyRows = this.db.all('SELECT id, company_id, provider_company_id, agency_code FROM agencies');
    let agency = agencyRows.find((row) => row.id === cloudLink.agency_id
      || localIdToCloudUuid(row.id) === cloudLink.agency_id);
    if (!agency) {
      try {
        const sb = getSupabaseClient();
        const { data } = await sb.from('agencies').select('agency_code').eq('id', cloudLink.agency_id).limit(1);
        const code = data && data[0] && data[0].agency_code;
        if (code) agency = agencyRows.find((row) => row.agency_code === code);
      } catch { /* scope remains closed if no local agency can be resolved */ }
    }
    if (!agency) throw new NotFoundError('Customer agency', cloudLink.agency_id);

    const company = cloudLink.companies;
    // Older deployments created company UUIDs directly in Supabase rather
    // than using localIdToCloudUuid(). When the local tenant already exists,
    // match it by the verified agency and exact company name before creating
    // a cloud-UUID mirror; otherwise the same tenant would be duplicated.
    const sameAgencyCompanies = this.db.all(
      `SELECT c.id FROM companies c
       JOIN customer_tenant_agencies cta ON cta.company_id=c.id
       WHERE cta.agency_id=? AND lower(trim(c.name))=lower(trim(?))`,
      [agency.id, company.name],
    );
    if (sameAgencyCompanies.length === 1) return sameAgencyCompanies[0].id;
    if (sameAgencyCompanies.length > 1) throw new NotFoundError('Customer', id);
    this.db.transaction(() => {
      this.db.run('INSERT OR IGNORE INTO companies (id,name,status) VALUES (?,?,?)', [id, company.name, company.status || 'ACTIVE']);
      this.db.run(
        `INSERT OR IGNORE INTO customer_tenant_agencies
         (company_id,agency_id,provider_company_id,assigned_by) VALUES (?,?,?,?)`,
        [id, agency.id, agency.provider_company_id || agency.company_id || cloudLink.provider_company_id || 'default', userId],
      );
    })();
    const confirmed = this.db.get('SELECT company_id FROM customer_tenant_agencies WHERE company_id=? AND agency_id=?', [id, agency.id]);
    if (!confirmed) throw new NotFoundError('Customer', id);
    return id;
  }

  /** Read a customer tenant and its primary administrator inside the caller's
   * agency scope. Unlike mutation/list endpoints that intentionally conceal
   * cross-tenant existence, this details endpoint returns an explicit 403. */
  async getCustomerDetails(userId, customerId) {
    const id = String(customerId || '').trim();
    if (!id) throw new NotFoundError('Customer', id);
    let localId = id;
    let link = this.db.get(
      'SELECT company_id, agency_id FROM customer_tenant_agencies WHERE company_id=?', [localId],
    );
    if (!link) {
      const { localIdToCloudUuid } = require('../services/supabase.service');
      const localRows = this.db.all('SELECT company_id, agency_id FROM customer_tenant_agencies');
      const match = localRows.find((row) => localIdToCloudUuid(row.company_id) === id);
      if (match) {
        localId = match.company_id;
        link = match;
      }
    }

    if (!link) {
      let cloudLink = null;
      try {
        const { data, error } = await getSupabaseClient()
          .from('customer_tenant_agencies')
          .select('company_id, agency_id, companies!inner(id, name, status)')
          .eq('company_id', id)
          .limit(1);
        if (!error && data && data[0] && data[0].companies) cloudLink = data[0];
      } catch { /* handled as not found below */ }
      if (!cloudLink) throw new NotFoundError('Customer', id);
      const scope = await this.scopedAgencyIds(userId);
      if (!scope.includes(cloudLink.agency_id)) {
        throw new AuthorizationError('You do not have access to this customer tenant.');
      }
      localId = await this.ensureLocalCustomer(userId, id);
      link = this.db.get(
        'SELECT company_id, agency_id FROM customer_tenant_agencies WHERE company_id=?', [localId],
      );
    }

    const scope = await this.scopedAgencyIds(userId);
    if (!scope.includes(link.agency_id)) {
      throw new AuthorizationError('You do not have access to this customer tenant.');
    }
    const customer = this.db.get(
      `SELECT c.id, c.name AS customer_name, c.status, c.created_at,
              a.name AS agency_name, a.agency_code, a.contact_email AS agency_email
       FROM customer_tenant_agencies cta
       JOIN companies c ON c.id=cta.company_id
       JOIN agencies a ON a.id=cta.agency_id
       WHERE cta.company_id=? AND cta.agency_id=?`,
      [localId, link.agency_id],
    );
    if (!customer) throw new NotFoundError('Customer', id);
    const administrators = this.db.all(
      `SELECT full_name, email, username, status, created_at
       FROM users WHERE company_id=? AND role='CUSTOMER_ADMIN'
       ORDER BY created_at ASC`,
      [localId],
    ).map((admin) => ({
      fullName: admin.full_name,
      email: admin.email,
      username: admin.username,
      status: admin.status,
      createdAt: admin.created_at,
    }));
    const primaryAdmin = administrators[0] || null;
    return {
      id: customer.id,
      customerName: customer.customer_name,
      fullName: primaryAdmin?.fullName || null,
      email: primaryAdmin?.email || null,
      status: customer.status,
      companyName: customer.customer_name,
      parentAgencyName: customer.agency_name,
      parentAgencyCode: customer.agency_code,
      createdAt: customer.created_at,
      administrators,
    };
  }

  async assertAgencyInScope(userId, agencyId) {
    const scoped = await this.scopedAgencyIds(userId);
    if (!scoped.includes(agencyId)) {
      let exists = false;
      try {
        const sb = getSupabaseClient();
        const { data } = await sb.from('agencies').select('id').eq('id', agencyId).limit(1);
        exists = Boolean(data && data[0]);
      } catch {
        exists = Boolean(this.db.get('SELECT id FROM agencies WHERE id = ?', [agencyId]));
      }
      throw new NotFoundError(exists ? 'Agency scope' : 'Agency', agencyId);
    }
  }

  async createCustomer(userId, { name, agencyId }) {
    const clean = String(name || '').trim();
    if (!clean || clean.length > 200) {
      throw new ValidationError('Customer validation failed.', { name: 'Name is required (max 200 characters).' });
    }
    if (!agencyId) {
      throw new ValidationError('Customer validation failed.', { agencyId: 'An agency must be selected.' });
    }
    const actor = resolveCaller(this.db, { userId });
    if (!actor) throw new AuthorizationError('Authentication required.');
    if (actor.role === 'customer_tenant') {
      throw new AuthorizationError('Customer tenants do not have permission to create accounts.');
    }
    if (!['agency', 'sub_agency', 'platform'].includes(actor.role)) {
      throw new AuthorizationError('Your role does not have permission to create customer tenants.');
    }
    if (['agency', 'sub_agency'].includes(actor.role) && agencyId !== actor.localAgencyId) {
      throw new AuthorizationError('Customer tenants must be created under your own agency.');
    }
    // FIX (audit 2026-11-02): assertAgencyInScope and callerAgency are ASYNC;
    // the former call sites skipped `await`, so the scope guard never ran (a
    // Promise is always truthy) and `.company_id` was read off a Promise
    // (undefined) → NOT NULL constraint failed: provider_company_id.
    await this.assertAgencyInScope(userId, agencyId);
    const dup = this.db.get('SELECT id FROM companies WHERE LOWER(name) = LOWER(?) LIMIT 1', [clean]);
    if (dup) {
      throw new ValidationError('Customer validation failed.', { name: `A company named "${clean}" already exists.` });
    }
    const caller = await this.callerAgency(userId);
    const providerCompanyId = caller && caller.company_id ? caller.company_id : 'default';
    const companyId = this.db.transaction(() => {
      const id = generateId('cmp');
      this.db.run('INSERT INTO companies (id, name, status) VALUES (?,?,?)', [id, clean, 'ACTIVE']);
      this.db.run(
        'INSERT INTO customer_tenant_agencies (company_id, agency_id, provider_company_id, assigned_by) VALUES (?,?,?,?)',
        [id, agencyId, providerCompanyId, userId],
      );
      this.db.run(
        'INSERT INTO customer_tenant_agency_history (id, company_id, old_agency_id, new_agency_id, changed_by) VALUES (?,?,?,?,?)',
        [generateId('ctah'), id, null, agencyId, userId],
      );
      return id;
    })();
    const agency = this.db.get('SELECT name FROM agencies WHERE id = ?', [agencyId]);

    // FIX (audit P1 — F2): the customer mapping was never pushed to Supabase,
    // and pushing it blind would fail the FK customer_tenant_agencies.company_id
    // → companies.id unless the customer's company row exists in the cloud
    // first (this is exactly what blocked the Digisolution mapping).
    // Order matters: (1) company stub, (2) mapping. Best-effort — local is
    // the authority; failures are logged, not thrown.
    try {
      const sb = getSupabaseClient();
      const cloudAgencyId = isUuid(agencyId) ? agencyId : localIdToCloudUuid(agencyId);
      await sb.from('companies').upsert(
        [{ id: companyId, name: clean, status: 'ACTIVE' }],
        { onConflict: 'id' },
      );
      const { error: mapErr } = await sb.from('customer_tenant_agencies').upsert(
        [{ company_id: companyId, agency_id: cloudAgencyId, provider_company_id: providerCompanyId, assigned_by: userId }],
        { onConflict: 'company_id' },
      );
      if (mapErr) console.error('[agency-control] customer mapping cloud sync failed:', mapErr.message || JSON.stringify(mapErr));
    } catch (custSyncErr) {
      console.error('[agency-control] customer mapping cloud sync threw:', custSyncErr && custSyncErr.message ? custSyncErr.message : String(custSyncErr));
    }

    return { id: companyId, name: clean, agencyId, agencyName: agency ? agency.name : null, status: 'ACTIVE' };
  }

  async reassignCustomer(userId, customerId, { agencyId }) {
    customerId = await this.ensureLocalCustomer(userId, customerId);
    if (!agencyId) {
      throw new ValidationError('Reassignment failed.', { agencyId: 'An agency must be selected.' });
    }
    await this.assertAgencyInScope(userId, agencyId);
    const current = this.db.get(
      'SELECT cta.company_id, cta.agency_id FROM customer_tenant_agencies cta WHERE cta.company_id = ?',
      [customerId],
    );
    if (!current) throw new NotFoundError('Customer', customerId);
    await this.assertAgencyInScope(userId, current.agency_id);
    if (current.agency_id === agencyId) {
      throw new ValidationError('Customer is already assigned to that agency.');
    }
    this.db.transaction(() => {
      this.db.run(
        'UPDATE customer_tenant_agencies SET agency_id = ?, assigned_by = ?, assigned_at = CURRENT_TIMESTAMP WHERE company_id = ?',
        [agencyId, userId, customerId],
      );
      this.db.run(
        'INSERT INTO customer_tenant_agency_history (id, company_id, old_agency_id, new_agency_id, changed_by) VALUES (?,?,?,?,?)',
        [generateId('ctah'), customerId, current.agency_id, agencyId, userId],
      );
    })();

    // FIX (audit P1 companion): keep the cloud mapping in sync on reassign —
    // otherwise the cloud row still points at the OLD agency after a local
    // reassignment. Best-effort, local is authoritative.
    try {
      const sb = getSupabaseClient();
      const cloudAgencyId = isUuid(agencyId) ? agencyId : localIdToCloudUuid(agencyId);
      const { error: mapErr } = await sb.from('customer_tenant_agencies')
        .update({ agency_id: cloudAgencyId, assigned_by: userId, assigned_at: new Date().toISOString() })
        .eq('company_id', customerId);
      if (mapErr) console.error('[agency-control] customer reassign cloud sync failed:', mapErr.message || JSON.stringify(mapErr));
    } catch (custSyncErr) {
      console.error('[agency-control] customer reassign cloud sync threw:', custSyncErr && custSyncErr.message ? custSyncErr.message : String(custSyncErr));
    }
    return { id: customerId, agencyId };
  }

  async changeCustomerAccess(userId, customerId, { status }) {
    customerId = await this.ensureLocalCustomer(userId, customerId);
    if (!['ACTIVE', 'SUSPENDED'].includes(status)) {
      throw new ValidationError('Invalid access status.', { status: 'Access must be ACTIVE or SUSPENDED.' });
    }
    const current = this.db.get(
      'SELECT cta.agency_id FROM customer_tenant_agencies cta WHERE cta.company_id = ?',
      [customerId],
    );
    if (!current) throw new NotFoundError('Customer', customerId);
    await this.assertAgencyInScope(userId, current.agency_id);
    const company = this.db.get('SELECT status FROM companies WHERE id = ?', [customerId]);
    if (company.status === status) {
      throw new ValidationError(`Customer is already ${status}.`);
    }
    this.db.run('UPDATE companies SET status = ? WHERE id = ?', [status, customerId]);
    return { id: customerId, status };
  }

  /** Rename a customer tenant (updates the underlying `companies` row). */
  async renameCustomer(userId, customerId, { name, email }) {
    customerId = await this.ensureLocalCustomer(userId, customerId);
    const clean = String(name || '').trim();
    if (!clean || clean.length > 200) {
      throw new ValidationError('Customer validation failed.', { name: 'Name is required (max 200 characters).' });
    }
    const current = this.db.get(
      'SELECT cta.agency_id AS agency_id FROM customer_tenant_agencies cta WHERE cta.company_id = ?',
      [customerId],
    );
    if (!current) throw new NotFoundError('Customer', customerId);
    await this.assertAgencyInScope(userId, current.agency_id);
    const dup = this.db.get('SELECT id FROM companies WHERE LOWER(name) = LOWER(?) AND id != ? LIMIT 1', [clean, customerId]);
    if (dup) {
      throw new ValidationError('Customer validation failed.', { name: `A company named "${clean}" already exists.` });
    }
    const cleanEmail = String(email || '').trim();
    const admin = cleanEmail ? this.db.get(
      "SELECT id,email,username,supabase_user_id FROM users WHERE company_id=? AND role='CUSTOMER_ADMIN' ORDER BY created_at DESC LIMIT 1",
      [customerId],
    ) : null;
    if (cleanEmail && !admin) throw new ValidationError('Customer update failed.', { email: 'Add a customer administrator before changing its email.' });
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      throw new ValidationError('Customer update failed.', { email: 'Enter a valid email address.' });
    }
    if (admin && cleanEmail && cleanEmail.toLowerCase() !== admin.email.toLowerCase()) {
      const duplicate = this.db.get('SELECT id FROM users WHERE lower(email)=lower(?) AND id<>?', [cleanEmail, admin.id]);
      if (duplicate) throw new ValidationError('Customer update failed.', { email: 'This email is already in use.' });
    }
    const changingEmail = admin && cleanEmail && cleanEmail.toLowerCase() !== admin.email.toLowerCase();
    let supabase = null;
    if (changingEmail && admin.supabase_user_id) {
      const { isConfigured, getSupabaseClient } = require('../config/supabase');
      if (!isConfigured()) throw new AppError('Supabase is unavailable for updating this administrator email.', 'SUPABASE_UNAVAILABLE', 503);
      supabase = getSupabaseClient();
      const { error } = await supabase.auth.admin.updateUserById(admin.supabase_user_id, { email: cleanEmail, email_confirm: true });
      if (error) throw new AppError('Supabase rejected the administrator email update.', 'SUPABASE_AUTH_UPDATE_FAILED', 502);
    }
    try {
      this.db.transaction(() => {
        this.db.run('UPDATE companies SET name = ? WHERE id = ?', [clean, customerId]);
        if (changingEmail) {
          const username = admin.username && admin.username.toLowerCase() === admin.email.toLowerCase() ? cleanEmail : admin.username;
          this.db.run('UPDATE users SET email=?, username=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [cleanEmail, username, admin.id]);
        }
      })();
    } catch (error) {
      if (supabase && changingEmail) {
        try { await supabase.auth.admin.updateUserById(admin.supabase_user_id, { email: admin.email, email_confirm: true }); }
        catch (rollbackError) { console.error('[agency-control] failed to roll back cloud email update', { code: rollbackError.code || 'unknown' }); }
      }
      throw error;
    }
    return { id: customerId, name: clean, agencyId: current.agency_id };
  }

  /** Resolve an assignment from either store without mirroring cloud-only rows
   * into SQLite. A missing local agency is a valid stale/orphaned cloud state;
   * removal should still be possible when that cloud agency is in caller scope. */
  async customerAssignmentForRemoval(userId, customerId) {
    const id = String(customerId || '').trim();
    if (!id) throw new NotFoundError('Customer', id);
    const local = this.db.get(
      'SELECT company_id, agency_id FROM customer_tenant_agencies WHERE company_id=?', [id],
    );
    let cloud = null;
    if (isSupabaseConfigured()) {
      const sb = getSupabaseClient();
      const cloudId = require('../services/supabase.service').localIdToCloudUuid(id);
      for (const candidate of [...new Set([id, cloudId].filter(Boolean))]) {
        const { data, error } = await sb.from('customer_tenant_agencies')
          .select('company_id, agency_id').eq('company_id', candidate).limit(1);
        if (error) throw new AppError('Could not verify the customer assignment in cloud storage.', 'SUPABASE_LOOKUP_FAILED', 502);
        if (data && data[0]) { cloud = data[0]; break; }
      }
    }
    if (!local && !cloud) throw new NotFoundError('Customer', id);

    const scoped = await this.scopedAgencyIds(userId);
    const agencyIds = [...new Set([local?.agency_id, cloud?.agency_id].filter(Boolean))];
    if (!agencyIds.length || agencyIds.some((agencyId) => !scoped.includes(agencyId))) {
      // Keep cross-tenant records indistinguishable from missing records.
      throw new NotFoundError('Customer', id);
    }
    return { id, local, cloud };
  }

  /** Remove only the customer-to-agency assignment and its assignment history.
   * The customer company and CRM data remain intact. Cloud-only assignments
   * are removed directly instead of being mirrored into a local database whose
   * agency rows may have been purged. */
  async removeCustomer(userId, customerId) {
    const assignment = await this.customerAssignmentForRemoval(userId, customerId);
    await this.removeResolvedCustomerAssignment(assignment);
    return { id: assignment.id, deleted: true };
  }

  async removeResolvedCustomerAssignment(assignment) {
    if (assignment.cloud && isSupabaseConfigured()) {
      const sb = getSupabaseClient();
      const { error: historyError } = await sb.from('customer_tenant_agency_history')
        .delete().eq('company_id', assignment.cloud.company_id);
      if (historyError) throw new AppError('Could not remove the customer assignment history from cloud storage.', 'SUPABASE_DELETE_FAILED', 502);
      const { error } = await sb.from('customer_tenant_agencies').delete()
        .eq('company_id', assignment.cloud.company_id).eq('agency_id', assignment.cloud.agency_id);
      if (error) throw new AppError('Could not remove the customer assignment from cloud storage.', 'SUPABASE_DELETE_FAILED', 502);
    }
    if (assignment.local) {
      this.db.transaction(() => {
        this.db.run('DELETE FROM customer_tenant_agencies WHERE company_id=?', [assignment.local.company_id]);
        this.db.run('DELETE FROM customer_tenant_agency_history WHERE company_id=?', [assignment.local.company_id]);
      })();
    }
  }

  /** Bulk access toggle for multiple customer tenants. Skips out-of-scope ids. */
  async bulkCustomerAccess(userId, { ids = [], status }) {
    ids = await Promise.all(ids.map((id) => this.ensureLocalCustomer(userId, id)));
    if (!['ACTIVE', 'SUSPENDED'].includes(status)) {
      throw new ValidationError('Invalid access status.', { status: 'Access must be ACTIVE or SUSPENDED.' });
    }
    const valid = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (!valid.length) return { updated: 0 };
    const scoped = await this.scopedAgencyIds(userId);
    let updated = 0;
    for (const customerId of valid) {
      const current = this.db.get(
        'SELECT cta.agency_id AS agency_id FROM customer_tenant_agencies cta WHERE cta.company_id = ?',
        [customerId],
      );
      if (!current || !scoped.includes(current.agency_id)) continue;
      this.db.run('UPDATE companies SET status = ? WHERE id = ?', [status, customerId]);
      updated += 1;
    }
    return { updated };
  }

  /** Bulk remove customer tenants (mapping + history only; companies kept). */
  async bulkRemoveCustomers(userId, { ids = [] }) {
    const valid = Array.isArray(ids) ? [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))] : [];
    if (!valid.length) return { removed: 0 };
    // Resolve and authorize the whole selection before the first delete so a
    // mixed-scope request cannot partially remove assignments.
    const assignments = await Promise.all(valid.map((id) => this.customerAssignmentForRemoval(userId, id)));
    // Reuse the already verified assignments; don't re-resolve/partially act
    // on a changed scope between items in one bulk request.
    for (const assignment of assignments) await this.removeResolvedCustomerAssignment(assignment);
    return { removed: assignments.length };
  }

  /** Create a login (users row) for a CUSTOMER TENANT company.
   *  The customer's company_id is the tenant boundary — the new user belongs
   *  to that company, mirroring how agency admins join the agency's own
   *  tenant. Role 'CUSTOMER_ADMIN' scopes them to their own tenant's data.
   *  No agency_administrators link (that table is agency-specific). */
  async addCustomerAdmin(userId, customerId, { fullName, email, username, password }) {
    customerId = await this.ensureLocalCustomer(userId, customerId);
    // 1. Customer must exist and be in the caller's scope.
    const current = this.db.get(
      'SELECT cta.agency_id AS agency_id FROM customer_tenant_agencies cta WHERE cta.company_id = ?',
      [customerId],
    );
    if (!current) throw new NotFoundError('Customer', customerId);
    await this.assertAgencyInScope(userId, current.agency_id);

    const clean = {
      fullName: String(fullName || '').trim(),
      email: String(email || '').trim(),
      username: String(username || '').trim(),
    };
    const passwordStr = String(password || '');
    const missing = {};
    if (!clean.fullName) missing.fullName = 'Full name is required.';
    if (!clean.email) missing.email = 'Email is required.';
    if (passwordStr.length < 10) missing.password = 'Password must be at least 10 characters.';
    if (Object.keys(missing).length) {
      throw new ValidationError('Admin validation failed.', missing);
    }

    // 2. Duplicate email/username check (covers ACTIVE and INACTIVE rows —
    // mirror of the sub-agency admin flow, but with its own error text).
    const dup = this.db.get(
      'SELECT id, status FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?) LIMIT 1',
      [clean.email, clean.username || null],
    );
    if (dup) {
      throw new ValidationError('Admin validation failed.', { email: 'A user with this email/username already exists.' });
    }

    // 3. Hash + insert. The users.company_id FK must exist; the customer's
    // companies row was created by createCustomer, so it does.
    const passwordHash = await require('../auth/password').PasswordService.hash(passwordStr);
    const newUserId = generateId('usr');
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO users (id, company_id, username, email, password_hash, full_name, role, status)
         VALUES (?,?,?,?,?,?,?,?)`,
        [newUserId, customerId, clean.username || null, clean.email, passwordHash, clean.fullName, 'CUSTOMER_ADMIN', 'ACTIVE'],
      );
    })();

    // 4. Cloud sync — best-effort; supabase_users is a read-only mirror and
    // auth accounts are provisioned through Supabase Auth by the login flow,
    // so a silent skip is correct here (same policy as agency admins).
    return { id: newUserId, customerId, fullName: clean.fullName, email: clean.email, username: clean.username || null, role: 'CUSTOMER_ADMIN' };
  }

  /** Move an existing customer login to a selected customer tenant.
   * Platform-only because company_id is the login's tenant boundary. */
  async reassignExistingCustomerAdmin(actorUserId, customerId, email) {
    const actor = resolveCaller(this.db, { userId: actorUserId });
    if (!actor || actor.role !== 'platform') {
      throw new AuthorizationError('Only a platform administrator can reassign an existing customer account.');
    }
    customerId = await this.ensureLocalCustomer(actorUserId, customerId);
    const target = this.db.get(
      'SELECT cta.agency_id FROM customer_tenant_agencies cta WHERE cta.company_id=?', [customerId],
    );
    if (!target) throw new NotFoundError('Customer', customerId);
    await this.assertAgencyInScope(actorUserId, target.agency_id);

    const normalizedEmail = String(email || '').trim().toLowerCase();
    const user = this.db.get(
      `SELECT id, company_id, email, username, role, hierarchy_role, supabase_user_id, status
       FROM users WHERE lower(trim(email))=?`, [normalizedEmail],
    );
    if (!user) throw new NotFoundError('Existing customer account', normalizedEmail);
    if (user.company_id === customerId) {
      throw new AppError('This account already belongs to the selected customer tenant.', 'CONFLICT', 409);
    }
    const agencyLink = this.db.get('SELECT id FROM agency_administrators WHERE user_id=? LIMIT 1', [user.id]);
    if (agencyLink || ['ADMIN', 'AGENCY', 'AGENCY_ADMIN'].includes(String(user.role || '').toUpperCase())) {
      throw new AppError('Only an existing customer account can be assigned to a customer tenant.', 'CONFLICT', 409);
    }
    const sourceIsCustomer = Boolean(this.db.get(
      'SELECT company_id FROM customer_tenant_agencies WHERE company_id=?', [user.company_id],
    ));
    const isCustomerAccount = user.role === 'CUSTOMER_ADMIN'
      || user.hierarchy_role === 'customer_tenant'
      || (user.role === 'USER' && sourceIsCustomer);
    if (!isCustomerAccount) {
      throw new AppError('That login is not classified as a customer account and cannot be reassigned here.', 'CONFLICT', 409);
    }

    let supabase = null;
    let authUser = null;
    const { isConfigured, getSupabaseClient } = require('../config/supabase');
    if (isConfigured()) {
      supabase = getSupabaseClient();
      const { findAuthUserByEmail } = require('./agency-admin-auth');
      authUser = await findAuthUserByEmail(supabase, normalizedEmail);
      if (user.supabase_user_id && (!authUser || authUser.id !== user.supabase_user_id)) {
        throw new AppError('The local customer account and Supabase account do not match.', 'IDENTITY_MISMATCH', 409);
      }
      const authRole = String(authUser?.app_metadata?.role || '').toLowerCase();
      if (authRole && !['customer', 'customer_admin', 'customer_tenant', 'user'].includes(authRole)) {
        throw new AppError('That Supabase login belongs to a different account type.', 'CONFLICT', 409);
      }
    } else if (user.supabase_user_id) {
      throw new AppError('Supabase is unavailable for reassigning this account.', 'SUPABASE_UNAVAILABLE', 503);
    }

    const previousCompanyId = user.company_id;
    const oldMetadata = authUser?.app_metadata || {};
    if (supabase && authUser) {
      const { localIdToCloudUuid } = require('../services/supabase.service');
      const { error } = await supabase.auth.admin.updateUserById(authUser.id, {
        app_metadata: { ...oldMetadata, role: 'customer_tenant', company_id: localIdToCloudUuid(customerId) || customerId },
      });
      if (error) throw new AppError('Supabase rejected the customer account reassignment.', 'SUPABASE_AUTH_LINK_FAILED', 502);
    }
    try {
      this.db.transaction(() => {
        const result = this.db.run(
          `UPDATE users SET company_id=?, role='CUSTOMER_ADMIN', hierarchy_role='customer_tenant',
             status='ACTIVE', supabase_user_id=COALESCE(?,supabase_user_id), updated_at=CURRENT_TIMESTAMP
           WHERE id=? AND company_id=?`,
          [customerId, authUser?.id || null, user.id, previousCompanyId],
        );
        if (Number(result.changes) !== 1) throw new AppError('The customer account changed during reassignment.', 'CONFLICT', 409);
      })();
    } catch (error) {
      if (supabase && authUser) {
        try { await supabase.auth.admin.updateUserById(authUser.id, { app_metadata: oldMetadata }); }
        catch (rollbackError) { console.error('[customer-admin-reassign] Auth metadata rollback failed', { code: rollbackError.code || 'unknown' }); }
      }
      throw error;
    }
    return { id: user.id, customerId, previousCompanyId, email: user.email, reassigned: true, crmDataRemainsWithPreviousCompany: true };
  }

  /** Permanently remove a customer login (never customer CRM records). */
  async permanentlyDeleteCustomerAdminByEmail(actorUserId, customerId, email) {
    const actor = resolveCaller(this.db, { userId: actorUserId });
    if (!actor || actor.role !== 'platform') {
      throw new AuthorizationError('Only a platform administrator can permanently remove an existing customer account.');
    }
    customerId = await this.ensureLocalCustomer(actorUserId, customerId);
    const target = this.db.get(
      'SELECT cta.agency_id FROM customer_tenant_agencies cta WHERE cta.company_id=?', [customerId],
    );
    if (!target) throw new NotFoundError('Customer', customerId);
    await this.assertAgencyInScope(actorUserId, target.agency_id);
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const user = this.db.get(
      'SELECT id, company_id, email, role, hierarchy_role, supabase_user_id FROM users WHERE lower(trim(email))=?',
      [normalizedEmail],
    );
    if (!user) throw new NotFoundError('Customer account', normalizedEmail);
    if (['ADMIN', 'AGENCY', 'AGENCY_ADMIN'].includes(String(user.role || '').toUpperCase())
      || this.db.get('SELECT id FROM agency_administrators WHERE user_id=? LIMIT 1', [user.id])) {
      throw new AppError('This is an agency account. It cannot be deleted as a customer administrator.', 'CONFLICT', 409);
    }
    const sourceIsCustomer = Boolean(this.db.get(
      'SELECT company_id FROM customer_tenant_agencies WHERE company_id=?', [user.company_id],
    ));
    if (user.role !== 'CUSTOMER_ADMIN' && user.hierarchy_role !== 'customer_tenant'
      && !(user.role === 'USER' && sourceIsCustomer)) {
      throw new AppError('This login is not a customer account and cannot be permanently removed here.', 'CONFLICT', 409);
    }
    const blockers = userDeletionBlockers(this.db, user.id);
    if (blockers.length) {
      throw new AppError('This customer account has dependent records and cannot be permanently deleted.', 'ENTITY_HAS_DEPENDENCIES', 409);
    }

    const queueId = `customer-admin-delete-${user.id}`;
    this.db.run(
      `INSERT INTO admin_identity_cleanup_queue (id, agency_admin_id, user_id, supabase_user_id, phase)
       VALUES (?, ?, ?, ?, 'PENDING_AUTH')
       ON CONFLICT(id) DO UPDATE SET attempts=admin_identity_cleanup_queue.attempts+1,
         last_error=NULL, updated_at=CURRENT_TIMESTAMP`,
      [queueId, `customer-admin-${user.id}`, user.id, user.supabase_user_id || null],
    );
    let supabase = null;
    let authUserId = user.supabase_user_id || null;
    try {
      const { isConfigured, getSupabaseClient } = require('../config/supabase');
      if (isConfigured()) {
        supabase = getSupabaseClient();
        if (!authUserId) {
          const { findAuthUserByEmail } = require('./agency-admin-auth');
          const match = await findAuthUserByEmail(supabase, normalizedEmail);
          authUserId = match?.id || null;
        }
      } else if (authUserId) {
        throw new AppError('Supabase is unavailable for deleting the linked Auth identity.', 'SUPABASE_UNAVAILABLE', 503);
      }
      if (authUserId && supabase) {
        const { error } = await supabase.auth.admin.deleteUser(authUserId);
        if (error && error.code !== 'user_not_found') throw new AppError('Supabase Auth deletion failed.', 'SUPABASE_AUTH_DELETE_FAILED', 502);
        this.db.run("UPDATE admin_identity_cleanup_queue SET supabase_user_id=?,phase='AUTH_DELETED',updated_at=CURRENT_TIMESTAMP WHERE id=?", [authUserId, queueId]);
        const { error: profileError } = await supabase.from('profiles').delete().eq('user_id', authUserId);
        if (profileError && !['PGRST205', '42P01'].includes(profileError.code)) {
          throw new AppError('Supabase profile cleanup failed.', 'SUPABASE_PROFILE_DELETE_FAILED', 502);
        }
      } else {
        this.db.run("UPDATE admin_identity_cleanup_queue SET phase='AUTH_DELETED',updated_at=CURRENT_TIMESTAMP WHERE id=?", [queueId]);
      }
      this.db.run("UPDATE admin_identity_cleanup_queue SET phase='CLOUD_MIRROR_DELETED',updated_at=CURRENT_TIMESTAMP WHERE id=?", [queueId]);
      this.db.transaction(() => {
        this.db.run('DELETE FROM user_roles WHERE user_id=?', [user.id]);
        this.db.run('DELETE FROM users WHERE id=?', [user.id]);
        this.db.run("UPDATE admin_identity_cleanup_queue SET phase='COMPLETE',updated_at=CURRENT_TIMESTAMP WHERE id=?", [queueId]);
      })();
      return { id: user.id, email: user.email, deleted: true, customerDataDeleted: false };
    } catch (error) {
      this.db.run(
        'UPDATE admin_identity_cleanup_queue SET supabase_user_id=COALESCE(?,supabase_user_id),attempts=attempts+1,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',
        [authUserId, String(error && error.message || error).slice(0, 500), queueId],
      );
      throw error;
    }
  }

  async resetCustomerAdminPassword(userId, customerId, { password }) {
    customerId = await this.ensureLocalCustomer(userId, customerId);
    const current = this.db.get(
      'SELECT agency_id FROM customer_tenant_agencies WHERE company_id=?', [customerId],
    );
    if (!current) throw new NotFoundError('Customer', customerId);
    await this.assertAgencyInScope(userId, current.agency_id);
    const value = String(password || '');
    if (value.length < 10) throw new ValidationError('Password reset failed.', { password: 'Password must be at least 10 characters.' });
    const admin = this.db.get(
      "SELECT id,email,supabase_user_id FROM users WHERE company_id=? AND role='CUSTOMER_ADMIN' AND status='ACTIVE' ORDER BY created_at DESC LIMIT 1",
      [customerId],
    );
    if (!admin) throw new NotFoundError('Active customer administrator', customerId);
    const passwordHash = await require('../auth/password').PasswordService.hash(value);
    if (admin.supabase_user_id) {
      const { isConfigured, getSupabaseClient } = require('../config/supabase');
      if (!isConfigured()) throw new AppError('Supabase is unavailable for resetting this Auth password.', 'SUPABASE_UNAVAILABLE', 503);
      const { error } = await getSupabaseClient().auth.admin.updateUserById(admin.supabase_user_id, { password: value });
      if (error) throw new AppError('Supabase rejected the customer administrator password reset.', 'SUPABASE_AUTH_UPDATE_FAILED', 502);
    }
    this.db.run('UPDATE users SET password_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [passwordHash, admin.id]);
    return { customerId, userId: admin.id, email: admin.email, updated: true };
  }

  /** List admins for a customer tenant (users joined on company_id). */
  async listCustomerAdministrators(userId, customerId) {
    customerId = await this.ensureLocalCustomer(userId, customerId);
    const current = this.db.get(
      'SELECT cta.agency_id AS agency_id FROM customer_tenant_agencies cta WHERE cta.company_id = ?',
      [customerId],
    );
    if (!current) throw new NotFoundError('Customer', customerId);
    await this.assertAgencyInScope(userId, current.agency_id);
    const rows = this.db.all(
      `SELECT u.id, u.company_id, u.full_name, u.email, u.username, u.role, u.status
       FROM users u WHERE u.company_id = ? AND u.role = 'CUSTOMER_ADMIN'
       ORDER BY u.created_at DESC`,
      [customerId],
    );
    return rows.map((r) => ({ id: r.id, customerId: r.company_id, fullName: r.full_name, email: r.email, username: r.username, role: r.role, status: r.status }));
  }
}

module.exports = { AgencyControlService, AGENCY_CONTROL_STATUS_VALUES: STATUS_VALUES };
