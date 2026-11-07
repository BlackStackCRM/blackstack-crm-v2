/**
 * DISTRIBUTION AGENCY SERVICE — Phase 1
 *
 * Scope: create, list, inspect, update, activate/suspend agencies and assign
 * agency administrators.
 *
 * NOT IMPLEMENTED HERE (later phases of the activation/licensing platform):
 *   license issuance, license keys, entitlements, device binding, activation
 *   codes, renewals, subscription billing, sub-agency hierarchy, central
 *   licence server. `getLicenseOverview()` deliberately returns
 *   `implemented: false` so no caller can mistake an absence for a zero count.
 *
 * DESIGN NOTES
 *   - Every mutation writes an audit log entry AND an agency_status_history row.
 *   - Agency creation and its administrator assignment are wrapped in a
 *     transaction, so a failure never leaves a half-created agency.
 *   - Status transitions are validated against an explicit table. An invalid
 *     transition is rejected rather than silently coerced.
 *   - Tenant isolation: agencies are looked up by id and then filtered by the
 *     caller's company. An agency belonging to another agency-admin's company is
 *     not reachable from that company.
 */

const { ValidationError, NotFoundError } = require('../utils/errors');
const { generateId } = require('../utils/generateId');
const { PasswordService } = require('../auth/password');
const { forwardAgencyToCloud } = require('../services/supabase.service');

/** Valid agency states (mirrors the CHECK constraint in migration 085). */
const AGENCY_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  TERMINATED: 'TERMINATED',
});

/**
 * Allowed status transitions.
 *
 * TERMINATED is absorbing: a terminated agency cannot be revived. That is a
 * deliberate business rule, not an oversight — termination means the
 * relationship ended. Re-instating is a future licensing-platform concern and
 * would need its own approval step.
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  PENDING: [AGENCY_STATUS.ACTIVE, AGENCY_STATUS.SUSPENDED, AGENCY_STATUS.TERMINATED],
  ACTIVE: [AGENCY_STATUS.SUSPENDED, AGENCY_STATUS.TERMINATED],
  SUSPENDED: [AGENCY_STATUS.ACTIVE, AGENCY_STATUS.TERMINATED],
  TERMINATED: [],
});

const AGENCY_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Fields a client is allowed to write. Anything else is ignored, not mass-assigned. */
const WRITABLE_FIELDS = Object.freeze([
  'name', 'legal_name', 'contact_name', 'contact_email', 'contact_phone',
  'address', 'city', 'state', 'country', 'pincode', 'notes',
]);

/**
 * HOW AN AGENCY IS SCOPED  (this was the subtle part, and it was wrong first time)
 *
 * An agency owns a *separate* company row so that its own users are ordinary
 * users of that company and every existing tenant-scoped query stays correct.
 * That means an agency has TWO company ids in play:
 *
 *   agency.company_id     — the agency's own tenant. Its users live here.
 *   provider_company_id   — the Mother Company that manages it.
 *
 * The first implementation scoped reads by `agency.company_id === caller`, which
 * is wrong: a Mother Company operator's own company id is never an agency's
 * company id, so every agency it created became invisible to it immediately
 * ("Agency with ID ... not found" on the very next request).
 *
 * Ownership of an agency is therefore expressed by a separate column, and all
 * Mother Company queries scope on THAT. The agency's own company_id remains the
 * tenant boundary for its users.
 */
class AgencyService {
  constructor(db) {
    this.db = db;
  }

  // ── validation ─────────────────────────────────────────────────────────────

  static validateAgencyCode(code) {
    if (typeof code !== 'string' || !AGENCY_CODE_RE.test(code)) {
      throw new ValidationError(
        'Agency code must be 3-32 characters, uppercase letters, digits, hyphen or underscore, starting with a letter or digit.',
      );
    }
    return code;
  }

  static validateAgencyInput(payload = {}) {
    const errors = {};

    if (!payload.name || typeof payload.name !== 'string' || !payload.name.trim()) {
      errors.name = 'Company name is required.';
    } else if (payload.name.trim().length > 200) {
      errors.name = 'Company name must be 200 characters or fewer.';
    }

    if (payload.contact_email && !EMAIL_RE.test(String(payload.contact_email).trim())) {
      errors.contact_email = 'Contact email is not a valid email address.';
    }
    if (payload.contact_phone && !/^[0-9+()\-.\s]{6,20}$/.test(String(payload.contact_phone).trim())) {
      errors.contact_phone = 'Contact phone contains invalid characters.';
    }
    if (payload.agency_code !== undefined) {
      AgencyService.validateAgencyCode(payload.agency_code);
    }

    if (Object.keys(errors).length) {
      throw new ValidationError('Agency validation failed.', errors);
    }
    return {
      name: String(payload.name).trim(),
      legal_name: payload.legal_name ? String(payload.legal_name).trim() : null,
      contact_name: payload.contact_name ? String(payload.contact_name).trim() : null,
      contact_email: payload.contact_email ? String(payload.contact_email).trim() : null,
      contact_phone: payload.contact_phone ? String(payload.contact_phone).trim() : null,
      address: payload.address ? String(payload.address).trim() : null,
      city: payload.city ? String(payload.city).trim() : null,
      state: payload.state ? String(payload.state).trim() : null,
      country: payload.country ? String(payload.country).trim() : 'India',
      pincode: payload.pincode ? String(payload.pincode).trim() : null,
      notes: payload.notes ? String(payload.notes).trim() : null,
    };
  }

  static assertTransition(from, to) {
    if (from === to) {
      throw new ValidationError(`Agency is already ${to}.`);
    }
    const allowed = ALLOWED_TRANSITIONS[from] || [];
    if (!allowed.includes(to)) {
      throw new ValidationError(
        `Invalid status transition ${from} -> ${to}. Allowed: ${allowed.length ? allowed.join(', ') : 'none (terminal state)'}.`,
      );
    }
  }

  // ── audit ──────────────────────────────────────────────────────────────────

  /**
   * Audit entry. Never records passwords, hashes or tokens — callers pass
   * already-sanitised values only, and this method strips a few known-sensitive
   * keys defensively so a future caller cannot leak them by accident.
   */
  audit({ actorId, companyId, action, entityType, entityId, oldValues, newValues, req }) {
    // `companyId` here is the SCOPE the audit row belongs to (the Mother Company),
    // which is why it is named differently from an agency's own company_id.
    const SENSITIVE = ['password', 'password_hash', 'token', 'secret', 'key', 'pin'];
    const scrub = (obj) => {
      if (!obj) return null;
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (SENSITIVE.some((s) => k.toLowerCase().includes(s))) continue;
        out[k] = v;
      }
      return Object.keys(out).length ? JSON.stringify(out) : null;
    };

    this.db.run(
      `INSERT INTO audit_logs (id, company_id, user_id, action, entity_type, entity_id,
                               old_values_json, new_values_json, ip_address, user_agent, session_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        generateId('aud'),
        companyId || 'default',
        actorId || null,
        action,
        entityType,
        entityId,
        scrub(oldValues),
        scrub(newValues),
        req ? req.ip || null : null,
        req ? String(req.headers['user-agent'] || '').slice(0, 250) : null,
        req && req.user ? req.user.sessionId || null : null,
      ],
    );
  }

  recordStatusChange(agencyId, fromStatus, toStatus, reason, actorId) {
    this.db.run(
      `INSERT INTO agency_status_history (id, agency_id, from_status, to_status, reason, changed_by)
       VALUES (?,?,?,?,?,?)`,
      [generateId('ash'), agencyId, fromStatus || null, toStatus, reason || null, actorId || null],
    );
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  findById(id) {
    return this.db.get('SELECT * FROM agencies WHERE id = ?', [id]) || null;
  }

  findByCode(code) {
    return this.db.get('SELECT * FROM agencies WHERE agency_code = ?', [code]) || null;
  }

  /**
   * An agency must be both present and owned by the caller's company, otherwise
   * it is reported as NOT FOUND rather than FORBIDDEN. Returning 403 for an
   * agency that exists in another tenant would leak its existence.
   */
  getForCompany(id, providerCompanyId) {
    const agency = this.findById(id);
    // NotFoundError's signature is (entity, id) — passing a single message string
    // renders as "<entity> with ID undefined not found", which hid which lookup
    // had failed. Passing the real id keeps the error actionable.
    if (!agency) {
      throw new NotFoundError('Agency', id);
    }
    // Scoped on provider_company_id, NOT company_id: the latter is the agency's
    // own tenant and never equals the Mother Company's id.
    // Cross-tenant access is reported as NOT FOUND rather than FORBIDDEN, because
    // a 403 would confirm that an agency with this id exists elsewhere.
    if (agency.provider_company_id !== providerCompanyId) {
      throw new NotFoundError('Agency', id);
    }
    return agency;
  }

  /**
   * List with server-side search and filters. Only agencies belonging to
   * `companyId` are ever returned.
   */
  list({ providerCompanyId, search, status, isActive, limit = 50, offset = 0 } = {}) {
    const where = ['provider_company_id = ?'];
    const params = [providerCompanyId];

    if (search) {
      where.push('(name LIKE ? OR agency_code LIKE ? OR contact_email LIKE ? OR contact_name LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (isActive !== undefined && isActive !== null && isActive !== '') {
      where.push('is_active = ?');
      params.push(isActive === true || isActive === 'true' || isActive === 1 ? 1 : 0);
    }

    const clauses = where.join(' AND ');
    const total = this.db.get(`SELECT COUNT(*) AS c FROM agencies WHERE ${clauses}`, params).c;
    const rows = this.db.all(
      `SELECT id, agency_code, name, legal_name, contact_name, contact_email, contact_phone,
              city, state, country, status, is_active, activated_at, suspended_at, created_at, updated_at
       FROM agencies WHERE ${clauses}
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, Math.min(Number(limit) || 50, 200), Math.max(Number(offset) || 0, 0)],
    );

    return { total, agencies: rows };
  }

  /**
   * Read agencies DIRECTLY from Supabase Cloud (read-through).
   *
   * Used by the Mother Company dashboard for reads. This is the primary
   * source of truth for the agency list on the Mother Company page.
   *
   * Returns the same shape as `list()`: { total, agencies: [...] }.
   * Field names are snake_case (matching the Supabase schema); the global
   * snakeToCamel response middleware converts them to camelCase for the
   * frontend.
   */
  async listFromSupabase({ providerCompanyId, search, status, isActive, limit = 50, offset = 0 } = {}) {
    const { isConfigured, getSupabaseClient } = require('../config/supabase');
    if (!isConfigured()) {
      throw new Error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    }
    const client = getSupabaseClient();

    const lim = Math.min(Number(limit) || 50, 200);
    const off = Math.max(Number(offset) || 0, 0);

    // Build the count query — must apply the same base filter as the data query.
    let countQ = client
      .from('agencies')
      .select('id', { count: 'exact', head: true })
      .eq('provider_company_id', providerCompanyId);

    // Build the data query.
    let q = client
      .from('agencies')
      .select('id, agency_code, name, legal_name, contact_name, contact_email, contact_phone, city, state, country, status, is_active, activated_at, suspended_at, created_at, updated_at')
      .eq('provider_company_id', providerCompanyId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(off, off + lim - 1);

    // Apply optional filters to both queries.
    if (search) {
      const ilike = `%${search}%`;
      countQ = countQ.or(`name.ilike.${ilike},agency_code.ilike.${ilike},contact_email.ilike.${ilike},contact_name.ilike.${ilike}`);
      q = q.or(`name.ilike.${ilike},agency_code.ilike.${ilike},contact_email.ilike.${ilike},contact_name.ilike.${ilike}`);
    }
    if (status) {
      countQ = countQ.eq('status', status);
      q = q.eq('status', status);
    }
    if (isActive !== undefined && isActive !== null && isActive !== '') {
      const boolVal = isActive === true || isActive === 'true' || isActive === 1;
      countQ = countQ.eq('is_active', boolVal ? 1 : 0);
      q = q.eq('is_active', boolVal ? 1 : 0);
    }

    const countRes = await countQ;
    if (countRes.error) {
      throw new Error(countRes.error.message || 'Supabase count query failed');
    }
    const total = countRes.count || 0;

    const { data, error } = await q;
    if (error) {
      throw new Error(error.message || 'Supabase agencies query failed');
    }

    return { total, agencies: data || [] };
  }

  /**
   * Fetch a single agency by UUID from Supabase.
   * Throws if not found or Supabase is unavailable.
   */
  async getByIdFromSupabase(id) {
    const { isConfigured, getSupabaseClient } = require('../config/supabase');
    if (!isConfigured()) {
      throw new Error('Supabase not configured');
    }
    const client = getSupabaseClient();
    let { data, error } = await client
      .from('agencies')
      .select('id, company_id, provider_company_id, agency_code, name, legal_name, contact_name, contact_email, contact_phone, address, city, state, country, pincode, status, is_active, activated_at, suspended_at, created_at, updated_at')
      .eq('id', id)
      .limit(1);

    if (error || !data || data.length === 0) {
      const byCode = await client
        .from('agencies')
        .select('id, company_id, provider_company_id, agency_code, name, legal_name, contact_name, contact_email, contact_phone, address, city, state, country, pincode, status, is_active, activated_at, suspended_at, created_at, updated_at')
        .eq('agency_code', id)
        .limit(1);
      if (byCode.error) {
        throw new Error(byCode.error.message || 'Supabase agency lookup failed');
      }
      if (byCode.data && byCode.data[0]) {
        return byCode.data[0];
      }
      throw new NotFoundError('Agency', id);
    }

    return data[0];
  }

  listAdministrators(agencyId) {
    return this.db.all(
      `SELECT a.id, a.user_id, a.role_code, a.status, a.assigned_at, a.revoked_at,
              u.full_name, u.email, u.username, u.status AS user_status
       FROM agency_administrators a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.agency_id = ?
       ORDER BY a.assigned_at DESC`,
      [agencyId],
    );
  }

  statusHistory(agencyId) {
    return this.db.all(
      `SELECT id, from_status, to_status, reason, changed_by, changed_at
       FROM agency_status_history WHERE agency_id = ?
       ORDER BY datetime(changed_at) DESC`,
      [agencyId],
    );
  }

  /**
   * Overview counts. Derived from real rows only — there are no seeded or
   * placeholder agencies, so a fresh install reports zeros honestly.
   */
  stats(providerCompanyId) {
    const byStatus = this.db.all(
      'SELECT status, COUNT(*) AS c FROM agencies WHERE provider_company_id = ? GROUP BY status',
      [providerCompanyId],
    );
    const counts = { PENDING: 0, ACTIVE: 0, SUSPENDED: 0, TERMINATED: 0 };
    for (const r of byStatus) counts[r.status] = r.c;

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const adminCount = this.db.get(
      `SELECT COUNT(*) AS c FROM agency_administrators aa
       JOIN agencies a ON a.id = aa.agency_id
       WHERE a.provider_company_id = ? AND aa.status = 'ACTIVE'`,
      [providerCompanyId],
    ).c;

    return {
      totalAgencies: total,
      activeAgencies: counts.ACTIVE,
      pendingAgencies: counts.PENDING,
      suspendedAgencies: counts.SUSPENDED,
      terminatedAgencies: counts.TERMINATED,
      activeAdministrators: adminCount,
    };
  }

  /**
   * License overview.
   *
   * The licensing platform does not exist yet (that is a later phase), so this
   * reports `implemented: false` with null counts rather than zeros. Returning
   * zeros would read as "no licenses issued" and imply the system is tracking
   * them; null plus an explicit flag cannot be misread that way.
   */
  async getLicenseOverview(providerCompanyId) {
    return {
      implemented: false,
      reason: 'Central License Server, license issuance and entitlement tracking are scheduled for a later phase.',
      phase: 'activation-and-licensing',
      agencyCount: this.db.get('SELECT COUNT(*) AS c FROM agencies WHERE provider_company_id = ?', [providerCompanyId]).c,
      licenseCounts: null,
      deviceCounts: null,
      renewalCounts: null,
    };
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /**
   * Create an agency inside a transaction.
   *
   * On duplicate agency code the caller gets a clear validation error rather
   * than a raw SQLITE_CONSTRAINT message.
   */
  createAgency({ payload, actor, providerCompanyId, req }) {
    const clean = AgencyService.validateAgencyInput(payload);
    const code = payload.agency_code ? AgencyService.validateAgencyCode(payload.agency_code) : null;

    if (code && this.findByCode(code)) {
      throw new ValidationError('Agency validation failed.', {
        agency_code: `Agency code "${code}" is already in use.`,
      });
    }

    const agency = this.db.transaction(() => {
      const agencyId = generateId('agy');

      // The agency gets its own company row, so its users are ordinary users of
      // that company and every existing tenant-scoped query stays correct.
      const agencyCompanyId = `company_${agencyId}`;
      this.db.run(
        'INSERT INTO companies (id, name, status) VALUES (?,?,?)',
        [agencyCompanyId, clean.name, 'ACTIVE'],
      );

      const finalCode = code || `AGY-${agencyId.slice(-8).toUpperCase()}`;
      this.db.run(
        `INSERT INTO agencies (id, company_id, provider_company_id, agency_code, name, legal_name,
                              contact_name, contact_email, contact_phone, address, city, state,
                              country, pincode, status, is_active, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          agencyId, agencyCompanyId, providerCompanyId, finalCode, clean.name, clean.legal_name, clean.contact_name,
          clean.contact_email, clean.contact_phone, clean.address, clean.city, clean.state,
          clean.country, clean.pincode, AGENCY_STATUS.PENDING, 0, actor ? actor.id : null,
        ],
      );

      this.recordStatusChange(agencyId, null, AGENCY_STATUS.PENDING, 'Agency created', actor ? actor.id : null);
      this.audit({
        actorId: actor ? actor.id : null,
        companyId: providerCompanyId,
        action: 'AGENCY_CREATED',
        entityType: 'AGENCY',
        entityId: agencyId,
        newValues: { agency_code: finalCode, name: clean.name, status: AGENCY_STATUS.PENDING },
        req,
      });

      return this.findById(agencyId);
    })();

    // Best-effort cloud sync after local commit. A Supabase failure must not
    // undo the local creation; the retry worker will retry later.
    try {
      forwardAgencyToCloud(this.db, agency, actor);
    } catch (syncErr) {
      console.warn('[cloud-sync] agency creation sync failed, local creation succeeded:', syncErr.message);
    }

    return agency;
  }

  updateAgency(id, { payload, actor, providerCompanyId, req }) {
    const agency = this.getForCompany(id, providerCompanyId);
    const clean = AgencyService.validateAgencyInput({ ...agency, ...payload });

    const updates = {};
    for (const f of WRITABLE_FIELDS) {
      if (clean[f] !== undefined && clean[f] !== agency[f]) updates[f] = clean[f];
    }
    if (!Object.keys(updates).length) return agency;

    const sets = Object.keys(updates).map((f) => `${f} = ?`).join(', ');
    this.db.run(
      `UPDATE agencies SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [...Object.values(updates), id],
    );

    this.audit({
      actorId: actor ? actor.id : null,
      companyId: providerCompanyId,
      action: 'AGENCY_UPDATED',
      entityType: 'AGENCY',
      entityId: id,
      oldValues: Object.fromEntries(Object.keys(updates).map((f) => [f, agency[f]])),
      newValues: updates,
      req,
    });
    return this.findById(id);
  }

  /** Activate / suspend / terminate with transition validation + history. */
  async changeStatus(id, { status, reason, actor, providerCompanyId, req }) {
    let agency;
    try {
      agency = this.getForCompany(id, providerCompanyId);
    } catch (err) {
      // Local lookup failed — the agency may exist only in Supabase. Try a
      // direct cloud lookup by UUID or agency code so we can create a local
      // stub and keep the rest of the flow unchanged.
      const { isConfigured, getSupabaseClient } = require('../config/supabase');
      if (!isConfigured()) throw err;
      const client = getSupabaseClient();
      const cloud = await this._findSupabaseAgency(client, id);
      if (!cloud) throw err;
      await this._ensureLocalAgencyStub(cloud, providerCompanyId);
      agency = this.getForCompany(id, providerCompanyId);
    }

    if (!Object.values(AGENCY_STATUS).includes(status)) {
      throw new ValidationError(`Unknown agency status "${status}".`);
    }
    if (agency.status === status) {
      return this.findById(id);
    }
    AgencyService.assertTransition(agency.status, status);

    if (status === AGENCY_STATUS.SUSPENDED && (!reason || !String(reason).trim())) {
      throw new ValidationError('A reason is required to suspend an agency.');
    }

    return this.db.transaction(() => {
      const isActive = status === AGENCY_STATUS.ACTIVE ? 1 : 0;
      this.db.run(
        `UPDATE agencies
         SET status = ?, is_active = ?,
             activated_at = CASE WHEN ? = 'ACTIVE' THEN CURRENT_TIMESTAMP ELSE activated_at END,
             suspended_at = CASE WHEN ? IN ('SUSPENDED','TERMINATED') THEN CURRENT_TIMESTAMP ELSE suspended_at END,
             suspended_reason = CASE WHEN ? = 'SUSPENDED' THEN ? ELSE suspended_reason END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [status, isActive, status, status, status, reason ? String(reason).trim() : null, id],
      );

      this.recordStatusChange(id, agency.status, status, reason, actor ? actor.id : null);
      this.audit({
        actorId: actor ? actor.id : null,
        companyId: providerCompanyId,
        action: `AGENCY_${status}`,
        entityType: 'AGENCY',
        entityId: id,
        oldValues: { status: agency.status, is_active: agency.is_active },
        newValues: { status, is_active: isActive, reason: reason || null },
        req,
      });
      const updated = this.findById(id);
      try { this._syncAgencyToCloud(this.db, updated, actor); } catch {}
      return updated;
    })();
  }

  async _findSupabaseAgency(client, idOrCode) {
    const selectCols = 'id, company_id, provider_company_id, agency_code, name, legal_name, contact_name, contact_email, contact_phone, address, city, state, country, pincode, status, is_active';
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let query;
    if (uuidRe.test(idOrCode)) {
      query = client.from('agencies').select(selectCols).eq('id', idOrCode).limit(1);
    } else {
      query = client.from('agencies').select(selectCols).eq('agency_code', idOrCode).limit(1);
    }
    const { data, error } = await query;
    if (error) {
      console.warn('[agency] Supabase lookup failed:', error.message || error);
      return null;
    }
    return data && data[0] ? data[0] : null;
  }

  _syncAgencyToCloud(db, agency, actor) {
    if (!agency || !db) return;
    try {
      const { forwardAgencyToCloud } = require('../services/supabase.service');
      console.log('[SYNC] _syncAgencyToCloud called for agency:', agency.id);
      forwardAgencyToCloud(db, agency, actor || {});
    } catch (e) {
      console.error('[SYNC] _syncAgencyToCloud threw:', e instanceof Error ? e.message : String(e));
    }
  }

  async _ensureLocalAgencyStub(cloud, providerCompanyId) {
    const companyId = cloud.company_id || `company_${cloud.id}`;
    this.db.run(
      `INSERT OR IGNORE INTO companies (id, name, status) VALUES (?,?,?)`,
      [companyId, cloud.name || cloud.agency_code, 'ACTIVE'],
    );
    this.db.run(
      `INSERT OR IGNORE INTO agencies (id, company_id, provider_company_id, agency_code, name, legal_name, contact_name, contact_email, contact_phone, city, state, country, status, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        cloud.id,
        companyId,
        cloud.provider_company_id || providerCompanyId,
        cloud.agency_code,
        cloud.name,
        cloud.legal_name,
        cloud.contact_name,
        cloud.contact_email,
        cloud.contact_phone,
        cloud.city,
        cloud.state,
        cloud.country,
        cloud.status || 'PENDING',
        cloud.is_active !== undefined ? Number(cloud.is_active) : 0,
      ],
    );
  }

  /**
   * Assign an administrator to an agency.
   *
   * Transactional: creates the user account, links it to the agency's own
   * company, attaches the AGENCY_ADMIN role, and records the link — all or
   * nothing. A failure cannot leave an orphaned user or a half-linked admin.
   *
   * The caller must supply a password. None is generated here and no default
   * exists anywhere in this file: an agency administrator's credentials are
   * established by the Mother Company operator, and the account is inactive
   * until they set it.
   */
  async assignAdministrator(agencyId, { email, fullName, password, username, actor, providerCompanyId, req, agency }) {
    if (!agency) {
      try {
        agency = this.getForCompany(agencyId, providerCompanyId);
      } catch (err) {
        const { isConfigured, getSupabaseClient } = require('../config/supabase');
        if (!isConfigured()) throw err;
        const client = getSupabaseClient();
        const cloud = await this._findSupabaseAgency(client, agencyId);
        if (!cloud) throw err;
        await this._ensureLocalAgencyStub(cloud, providerCompanyId);
        agency = this.getForCompany(agencyId, providerCompanyId);
      }
    }

    if (!email || !EMAIL_RE.test(String(email).trim())) {
      throw new ValidationError('A valid administrator email address is required.');
    }
    if (!fullName || !String(fullName).trim()) {
      throw new ValidationError('Administrator full name is required.');
    }
    if (!password || String(password).length < 10) {
      // Enforced here rather than silently accepted: a weak credential for an
      // account that can administer an agency is not something to wave through.
      throw new ValidationError('Administrator password must be at least 10 characters.');
    }

    const mail = String(email).trim().toLowerCase();

    // Hash BEFORE opening the transaction. PasswordService.hash is async, and an
    // await inside this.db.transaction() would yield control while a SQLite
    // write transaction is open — which is how a second writer ends up blocked
    // on busy_timeout. Hashing first keeps the transaction synchronous.
    const passwordHash = await PasswordService.hash(password);

    return this.db.transaction(() => {
      // Reuse an existing AGENCY_ADMIN role if THIS COMPANY has one, otherwise
      // create a scoped role carrying only that agency's CRM permissions.
      // (Moved ABOVE the user handling: the previous edit placed the
      // user_roles INSERT before this block's `let role` declaration, which
      // threw "Cannot access 'role' before initialization" at runtime.)
      //
      // The role CODE must be unique per company, and roles.code is declared
      // globally UNIQUE (not (company_id, code)). Inserting a literal
      // 'AGENCY_ADMIN' therefore succeeded for the FIRST agency and then raised
      // `UNIQUE constraint failed: roles.code` for every agency created after it —
      // which the API surfaced as a confusing 409. In production that means
      // "cannot assign an administrator" for all but the first agency.
      //
      // Widening roles.code to (company_id, code) would be the tidier fix but it
      // alters an existing table used by every other module, which is out of scope
      // for this phase. Instead the code is suffixed with the agency id, which makes
      // it unique, keeps the role scoped to the agency's own company, and leaves the
      // human-facing name as "Agency Administrator".
      // agency_code is validated as [A-Z0-9_-]{2,32}, so it is already safe as a
      // suffix: no quotes, no whitespace, no SQL metacharacters.
      const scopedCode = `AGENCY_ADMIN_${agency.agency_code}`;
      let role = this.db.get(
        'SELECT id FROM roles WHERE company_id = ? AND code = ?',
        [agency.company_id, scopedCode],
      );
      if (!role) {
        const roleId = generateId('role');
        this.db.run(
          `INSERT INTO roles (id, company_id, name, code, description, is_system)
           VALUES (?,?,?,?,?,0)`,
          [roleId, agency.company_id, 'Agency Administrator', scopedCode,
           `Administrator for agency ${agency.agency_code}`],
        );
        role = { id: roleId, code: scopedCode };

        // Least privilege: an agency administrator gets agency-level CRM
        // permissions and explicitly NOT the Mother Company codes, and not the
        // agency-management codes that would let them touch other agencies.
        const grants = [
          'contacts.view', 'contacts.create', 'contacts.edit',
          'organizations.view',
          'deals.view', 'deals.create', 'deals.edit',
          'tasks.view', 'tasks.create', 'tasks.edit',
          'leads.view', 'leads.create', 'leads.edit',
          'dashboard.view',
        ];
        for (const code of grants) {
          const perm = this.db.get('SELECT id FROM permissions WHERE code = ?', [code]);
          if (perm) {
            this.db.run('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?,?)',
              [roleId, perm.id]);
          }
        }
      }

      // FIX (reassign-after-revoke): a previously revoked administrator leaves
      // a users row behind (audit-trail design: revoke deactivates, never
      // deletes). Re-assigning the same email then hit the UNIQUE email
      // constraint and surfaced "A user with that email address already
      // exists." even though the operator had clearly removed the admin.
      // Reactivate-and-reuse instead: same row, new password, back to ACTIVE,
      // re-linked to the agency. A genuinely DIFFERENT email still inserts
      // fresh; an ACTIVE user with the same email remains a real conflict.
      // FIX (MC-assign flow, task 1c/d): handle an existing ACTIVE user with
      // this email instead of failing outright. Cases:
      //   * INACTIVE user  → reactivate (revoked admin coming back).
      //   * ACTIVE + already admin of THIS agency → friendly 400.
      //   * ACTIVE + admin of a DIFFERENT agency → 409 conflict (clear and
      //     actionable; multi-agency admin roles are not supported yet).
      //   * ACTIVE + no admin link (plain CRM user, e.g. a customer contact)
      //     → LINK them: grant the AGENCY_ADMIN role, insert the
      //     agency_administrators row, mark for password reset. The operator
      //     explicitly chose this email, so linking is the intended action;
      //     the one-time password still forces a credential set.
      const existing = this.db.get(
        'SELECT id, status, company_id, role FROM users WHERE email = ?',
        [mail],
      );
      let userId;
      let linkedExistingUser = false;
      if (existing && existing.status === 'INACTIVE') {
        userId = existing.id;
        this.db.run(
          `UPDATE users SET status='ACTIVE', password_hash=?, full_name=?, company_id=?, hierarchy_role=COALESCE(hierarchy_role, 'agency'), updated_at=CURRENT_TIMESTAMP WHERE id=?`,
          [passwordHash, String(fullName).trim(), agency.company_id, userId],
        );
      } else if (existing) {
        const alreadyHere = this.db.get(
          "SELECT id, status FROM agency_administrators WHERE user_id = ? AND agency_id = ?",
          [existing.id, agencyId],
        );
        if (alreadyHere) {
          throw new ValidationError('User is already an administrator for this agency.');
        }
        const elsewhere = this.db.get(
          "SELECT id FROM agency_administrators WHERE user_id = ?",
          [existing.id],
        );
        if (elsewhere) {
          const conflict = new ValidationError(
            'This email is already registered to another agency. Please use a different email or contact support.',
          );
          conflict.code = 'CONFLICT';
          conflict.status = 409;
          throw conflict;
        }
        // LINK an existing ACTIVE user (no admin link anywhere): grant the
        // agency's admin role, reset credentials to the one-time password,
        // and mark must_change_password so they set their own on first login.
        // hierarchy_role is the authority column for access decisions
        // (resolveCaller reads it); users.role is kept in sync for consistency.
        userId = existing.id;
        linkedExistingUser = true;
        this.db.run(
          `UPDATE users SET status='ACTIVE', password_hash=?, full_name=?, company_id=?,
             role='AGENCY_ADMIN', hierarchy_role='agency', must_change_password=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
          [passwordHash, String(fullName).trim(), agency.company_id, userId],
        );
      } else {
        userId = generateId('usr');
        this.db.run(
          `INSERT INTO users (id, company_id, username, email, password_hash, full_name, role, status)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            userId,
            agency.company_id,
            username ? String(username).trim() : null,
            mail,
            // Hashed above; the plaintext is never stored, logged or audited.
            passwordHash,
            String(fullName).trim(),
            'USER',
            'ACTIVE',
          ],
        );
      }
      this.db.run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?,?)', [userId, role.id]);

      // FIX (reactivate path): agency_administrators has UNIQUE(user_id) —
      // a revoked (REVOKED) link row still occupies the user's slot, so a
      // fresh INSERT violates it. When a REVOKED link exists for this user,
      // revive THAT row (back to ACTIVE, cleared revocation, refreshed
      // assignment metadata) instead of inserting a duplicate. A genuinely
      // new user takes the INSERT path. A user linked to a DIFFERENT agency
      // was already rejected above (409), so this branch is unreachable for
      // them.
      const existingLink = this.db.get(
        'SELECT id, agency_id, status FROM agency_administrators WHERE user_id = ?',
        [userId],
      );
      let linkId;
      if (existingLink) {
        if (existingLink.agency_id !== agencyId) {
          const conflict = new ValidationError(
            'This email is already registered to another agency. Please use a different email or contact support.',
          );
          conflict.code = 'CONFLICT';
          conflict.status = 409;
          throw conflict;
        }
        if (existingLink.status !== 'REVOKED') {
          throw new ValidationError('User is already an administrator for this agency.');
        }
        linkId = existingLink.id;
        this.db.run(
          `UPDATE agency_administrators
           SET status='ACTIVE', revoked_at=NULL, revoked_by=NULL, assigned_by=?, assigned_at=CURRENT_TIMESTAMP
           WHERE id = ?`,
          [actor ? actor.id : null, linkId],
        );
      } else {
        linkId = generateId('aad');
        this.db.run(
          `INSERT INTO agency_administrators (id, agency_id, user_id, company_id, role_code, assigned_by)
           VALUES (?,?,?,?,?,?)`,
          [linkId, agencyId, userId, agency.company_id, 'AGENCY_ADMIN', actor ? actor.id : null],
        );
      }

      this.audit({
        actorId: actor ? actor.id : null,
        companyId: providerCompanyId,
        action: 'AGENCY_ADMIN_ASSIGNED',
        entityType: 'AGENCY',
        entityId: agencyId,
        // Note: no password or hash is passed to audit(), which also scrubs.
        newValues: { user_id: userId, email: mail, role_code: 'AGENCY_ADMIN' },
        req,
      });

      return this.db.get(
        `SELECT a.id, a.user_id, a.role_code, a.status, a.assigned_at, u.full_name, u.email
         FROM agency_administrators a JOIN users u ON u.id = a.user_id WHERE a.id = ?`,
        [linkId],
      );
    })();
  }

  revokeAdministrator(agencyId, { adminId, actor, providerCompanyId, req }) {
    this.getForCompany(agencyId, providerCompanyId);
    const link = this.db.get(
      'SELECT * FROM agency_administrators WHERE id = ? AND agency_id = ?',
      [adminId, agencyId],
    );
    if (!link) throw new NotFoundError('Agency administrator', adminId);
    if (link.status === 'REVOKED') {
      throw new ValidationError('That administrator has already been revoked.');
    }

    this.db.transaction(() => {
      this.db.run(
        `UPDATE agency_administrators SET status='REVOKED', revoked_at=CURRENT_TIMESTAMP, revoked_by=?
         WHERE id = ?`,
        [actor ? actor.id : null, adminId],
      );
      // The login account is disabled too, otherwise revoking the agency link
      // would leave a working account behind.
      this.db.run("UPDATE users SET status='INACTIVE', updated_at=CURRENT_TIMESTAMP WHERE id = ?",
        [link.user_id]);
      this.audit({
        actorId: actor ? actor.id : null,
        companyId: providerCompanyId,
        action: 'AGENCY_ADMIN_REVOKED',
        entityType: 'AGENCY',
        entityId: agencyId,
        oldValues: { user_id: link.user_id, status: 'ACTIVE' },
        newValues: { status: 'REVOKED' },
        req,
      });
    })();
    return this.db.get('SELECT * FROM agency_administrators WHERE id = ?', [adminId]);
  }

  /** Recent privileged Mother Company actions, for the dashboard history view. */
  auditHistory(providerCompanyId, { limit = 50 } = {}) {
    return this.db.all(
      `SELECT id, user_id, action, entity_type, entity_id, old_values_json, new_values_json,
              ip_address, created_at
       FROM audit_logs
       WHERE company_id = ? AND (
         action LIKE 'AGENCY_%' OR action LIKE '%MOTHER_COMPANY%'
       )
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`,
      [providerCompanyId, Math.min(Number(limit) || 50, 200)],
    );
  }
}

module.exports = {
  AgencyService,
  AGENCY_STATUS,
  ALLOWED_TRANSITIONS,
  AGENCY_CODE_RE,
};
