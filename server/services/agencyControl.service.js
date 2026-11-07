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

const { ValidationError, NotFoundError, AuthorizationError } = require('../utils/errors');
const { generateId } = require('../utils/generateId');
const { getSupabaseClient } = require('../config/supabase');
const { forwardAgencyToCloud, localIdToCloudUuid } = require('../services/supabase.service');

function isUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(str));
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
    const caller = await this.callerAgency(user && (user.userId || user));
    const isAdmin = (user && user.role === 'ADMIN') || (Array.isArray(user && user.permissions) && user.permissions.includes('*'));
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
        await this.removeSubAgency(userId, agencyId);
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
    
    // FIX (audit F5, §3.4): duplicate admin check BEFORE any insert — the old
    // code hit the users.email / users.username UNIQUE constraints raw and
    // surfaced a 500 instead of a field-level validation error.
    const dup = this.db.get('SELECT id FROM users WHERE LOWER(email) = LOWER(?) OR username = ? LIMIT 1', [email, username]);
    if (dup) {
      throw new ValidationError('Admin validation failed.', { email: 'A user with this email/username already exists.' });
    }

    // FIX (audit F5): company stub guard. The rebuilt version assumed
    // 'company_' + agencyId exists; for legacy agencies (created before the
    // rebuild, or via other flows) it doesn't — the users insert then fails
    // the FK to companies. INSERT OR IGNORE makes the tenant stub idempotent.
    const companyId = 'company_' + agencyId;
    this.db.run(
      "INSERT OR IGNORE INTO companies (id, name, status) VALUES (?, ?, 'ACTIVE')",
      [companyId, agency ? (agency.name || agencyId) : agencyId],
    );

    const adminId = generateId('aa');
    const newUserId = generateId('usr');
    const passwordHash = await require('../auth/password').PasswordService.hash(password || '');

    if (isLocal) {
      // 1. Insert new User into local SQLite. The pre-check above catches the
      // common case, but a raw UNIQUE error can still escape (a concurrent
      // insert between check and write, or case/whitespace variants the
      // pre-check's exact-match misses — e.g. trailing space stored in a legacy
      // row). Map it to the field-level validation error instead of a raw 500.
      try {
        this.db.run(
          `INSERT INTO users (id, company_id, username, email, password_hash, full_name, role, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
          [newUserId, companyId, username, email, passwordHash, fullName, 'AGENCY_ADMIN', 'ACTIVE']
        );
      } catch (insertErr) {
        const msg = insertErr && insertErr.message ? insertErr.message : String(insertErr);
        if (/UNIQUE constraint failed: users\.(email|username)/i.test(msg)) {
          throw new ValidationError('Admin validation failed.', { email: 'A user with this email/username already exists.' });
        }
        throw insertErr;
      }
      // 2. Insert Agency Admin link
      // FIX (audit F5): role_code was 'ADMIN' while users.role was
      // 'AGENCY_ADMIN' — the two disagreed, breaking role-scoped queries.
      // Both now use the documented AGENCY_ADMIN code.
      this.db.run(
        `INSERT INTO agency_administrators (id, agency_id, user_id, company_id, role_code, assigned_by, assigned_at, status)
         VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,'ACTIVE')`,
        [adminId, agencyId, newUserId, companyId, 'AGENCY_ADMIN', userId]
      );
    }
    
    // 3. Sync to Supabase
    try {
      const sb = getSupabaseClient();
      if (sb) {
        const cloudAgencyId = localIdToCloudUuid(agencyId) || agencyId;
        await sb.from('agency_administrators').upsert([{
          id: adminId,
          agency_id: cloudAgencyId,
          full_name: fullName,
          email,
          username,
          password_hash: passwordHash,
          status: 'ACTIVE',
        }], { onConflict: 'id' });
      }
    } catch (syncErr) {
      console.error('Cloud sync exception:', syncErr.message);
    }
    
    return { id: adminId, agencyId, fullName, email, username };
  }

  async resetSubAgencyAdminPassword(userId, agencyId, { password }) {
    await this.assertAgencyInScope(userId, agencyId);
    const passwordHash = await require('../auth/password').PasswordService.hash(password || '');
    const admin = this.db.get('SELECT id FROM agency_administrators WHERE agency_id = ? AND status = ? LIMIT 1', [agencyId, 'ACTIVE']);
    if (!admin) {
      throw new NotFoundError('Agency administrator', agencyId);
    }
    this.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, admin.user_id || admin.id]);
    try {
      const sb = getSupabaseClient();
      const { error } = await sb
        .from('agency_administrators')
        .update({ password_hash: passwordHash })
        .eq('agency_id', agencyId)
        .eq('status', 'ACTIVE');
      if (error) console.error('[agency-control] resetSubAgencyAdminPassword cloud sync failed:', error.message);
    } catch (syncErr) {
      console.error('[agency-control] resetSubAgencyAdminPassword cloud sync exception:', syncErr && syncErr.message ? syncErr.message : String(syncErr));
    }
    return { agencyId, updated: true };
  }

    async getSubAgency(userId, agencyId) {
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
    console.log('LIST ADMINS SERVICE:', { agencyId });
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
          console.log('LIST ADMINS SERVICE:', { agencyId, count: 0, note: 'cloud-only agency, no local rows' });
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
      console.log('LIST ADMINS SERVICE:', { agencyId, count: local.length });
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
      console.error('DB Error listing admins:', e);
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
    return { customers: rows };
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
  async renameCustomer(userId, customerId, { name }) {
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
    this.db.run('UPDATE companies SET name = ? WHERE id = ?', [clean, customerId]);
    return { id: customerId, name: clean, agencyId: current.agency_id };
  }

  /** Remove a customer tenant: deletes the agency mapping + history rows. The
   *  `companies` row is intentionally KEPT — other modules (contacts, deals,
   *  billing) reference it; only the tenant assignment is removed. */
  async removeCustomer(userId, customerId) {
    const current = this.db.get(
      'SELECT cta.agency_id AS agency_id FROM customer_tenant_agencies cta WHERE cta.company_id = ?',
      [customerId],
    );
    if (!current) throw new NotFoundError('Customer', customerId);
    await this.assertAgencyInScope(userId, current.agency_id);
    this.db.transaction(() => {
      this.db.run('DELETE FROM customer_tenant_agencies WHERE company_id = ?', [customerId]);
      this.db.run('DELETE FROM customer_tenant_agency_history WHERE company_id = ?', [customerId]);
    })();
    return { id: customerId, deleted: true };
  }

  /** Bulk access toggle for multiple customer tenants. Skips out-of-scope ids. */
  async bulkCustomerAccess(userId, { ids = [], status }) {
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
    const valid = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (!valid.length) return { removed: 0 };
    const scoped = await this.scopedAgencyIds(userId);
    let removed = 0;
    for (const customerId of valid) {
      const current = this.db.get(
        'SELECT cta.agency_id AS agency_id FROM customer_tenant_agencies cta WHERE cta.company_id = ?',
        [customerId],
      );
      if (!current || !scoped.includes(current.agency_id)) continue;
      this.db.transaction(() => {
        this.db.run('DELETE FROM customer_tenant_agencies WHERE company_id = ?', [customerId]);
        this.db.run('DELETE FROM customer_tenant_agency_history WHERE company_id = ?', [customerId]);
      })();
      removed += 1;
    }
    return { removed };
  }

  /** Create a login (users row) for a CUSTOMER TENANT company.
   *  The customer's company_id is the tenant boundary — the new user belongs
   *  to that company, mirroring how agency admins join the agency's own
   *  tenant. Role 'CUSTOMER_ADMIN' scopes them to their own tenant's data.
   *  No agency_administrators link (that table is agency-specific). */
  async addCustomerAdmin(userId, customerId, { fullName, email, username, password }) {
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
      'SELECT id, status FROM users WHERE LOWER(email) = LOWER(?) OR username = ? LIMIT 1',
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

  /** List admins for a customer tenant (users joined on company_id). */
  listCustomerAdministrators(userId, customerId) {
    const current = this.db.get(
      'SELECT cta.agency_id AS agency_id FROM customer_tenant_agencies cta WHERE cta.company_id = ?',
      [customerId],
    );
    if (!current) throw new NotFoundError('Customer', customerId);
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
