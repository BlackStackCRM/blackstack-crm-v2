/**
 * MOTHER COMPANY / DISTRIBUTION AGENCY ROUTES — Phase 1
 *
 * Every route below is guarded on the server by BOTH:
 *   1. authMiddleware                 — a valid, unexpired, live session; and
 *   2. requireMotherCompany(<code>)   — an EXPLICIT mother_company.* permission
 *
 * Neither check can be satisfied by the frontend. Hiding a menu entry is a
 * usability measure; these guards are the actual control. A customer-company
 * administrator holding the ADMIN role carries '*' in their session, and that
 * wildcard deliberately does NOT satisfy these guards (see middleware/motherCompany.js).
 */

const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const {
  requireMotherCompany,
  requireAnyMotherCompanyPermission,
  MOTHER_COMPANY_PERMISSIONS: P,
} = require('../middleware/motherCompany');
const { AgencyService } = require('../services/agency.service');
// The app already has a response contract: every endpoint replies through
// successResponse()/errorResponse() and a middleware converts snake_case keys to
// camelCase. Returning a hand-rolled { data: ... } envelope here would make this
// router the only endpoint shape in the API, so it uses the shared helpers.
const { successResponse } = require('../utils/response');
const { getConn } = require('../utils/db');
const { ValidationError } = require('../utils/errors');
const { PasswordService } = require('../auth/password');

const router = express.Router();

// Auth first for the whole router, then per-route Mother Company permission.
router.use(authMiddleware);

const svc = () => new AgencyService(getConn());

// ── Dashboard ────────────────────────────────────────────────────────────────

router.get('/dashboard',
  requireAnyMotherCompanyPermission(),
  async (req, res, next) => {
      try {
    const service = svc();
    let stats;
      try {
      stats = await service.statsFromSupabase(req.user.companyId);
    } catch (supabaseErr) {
      console.warn('[mother-company] Supabase stats unavailable, falling back to local SQLite:', supabaseErr.message);
      stats = service.stats(req.user.companyId);
    }
    const licenses = await new AgencyService(getConn()).getLicenseOverview(req.user.companyId);
    res.json(successResponse({
      stats,
      licenses,
      // Explicitly derived from the session, never from a client-supplied id.
      motherCompany: {
        companyId: req.user.companyId,
        permissions: req.user.permissions.filter((x) => x.startsWith('mother_company.')),
      },
    }));
    } catch (err) { next(err); }
  });

// ── Agencies ─────────────────────────────────────────────────────────────────

router.get('/agencies',
  requireMotherCompany(P.AGENCIES_VIEW),
  async (req, res, next) => {
      try {
      const service = svc();
      const commonOpts = {
        providerCompanyId: req.user.companyId,
        search: req.query.search,
        status: req.query.status,
        isActive: req.query.isActive,
        limit: req.query.limit,
        offset: req.query.offset,
      };
      // Read-through from Supabase Cloud first; fall back to local SQLite on
      // any error (e.g. not configured, network, permission). This keeps the
      // Mother Company dashboard showing live cloud data while remaining
      // fully functional offline.
      // FIX (architecture split): the Mother Company page manages ROOT
      // distribution agencies only. Sub-agencies (agency_code LIKE 'SUB-%')
      // belong exclusively to the Agency Control page.
      //
      // MERGE, don't fall back: the cloud and local stores hold DIFFERENT rows
      // (locally-created agy_* agencies are synced to the cloud under their
      // UUID; cloud-created UUID agencies may have no local mirror). Supabase
      // succeeding with 0 rows used to mask the local rows entirely — the
      // operator saw an empty list. Merge both sources, de-duplicate by
      // agency_code, then apply the root-only filter to the merged set.
      const isRoot = (a) => !String(a.agency_code || a.agencyCode || '').startsWith('SUB-');
      let merged = [];
      try {
        const result = await service.listFromSupabase(commonOpts);
        merged = merged.concat(result.agencies || []);
      } catch (supabaseErr) {
        console.warn('[mother-company] Supabase read unavailable, using local SQLite only:', supabaseErr.message);
      }
      try {
        const localResult = service.list(commonOpts);
        merged = merged.concat(localResult.agencies || []);
      } catch (localErr) {
        console.warn('[mother-company] local list failed:', localErr.message);
      }
      const byCode = new Map();
      for (const a of merged) {
        const code = String(a.agency_code || a.agencyCode || '').toUpperCase();
        if (!code || byCode.has(code)) continue;
        byCode.set(code, a);
      }
      const agencies = [...byCode.values()].filter(isRoot);
      const total = agencies.length;
      res.json(successResponse({ agencies, total }));
    } catch (err) {
      next(err);
    }
  });

router.get('/agencies/:id',
  requireMotherCompany(P.AGENCIES_VIEW),
  async (req, res, next) => {
    const service = svc();
    let agency = null;
    try {
      agency = await service.getByIdFromSupabase(req.params.id);
    } catch (supabaseErr) {
      console.warn('[mother-company] Supabase single-agency lookup failed, falling back to local SQLite:', supabaseErr.message);
      agency = service.getForCompany(req.params.id, req.user.companyId);
    }
    // Supabase IDs are NOT valid local SQLite PKs for related records.
    // Resolve the local agency by code so related queries return data.
    let localAgencyId = req.params.id;
    if (agency && agency.agency_code) {
      const localByCode = service.findByCode(agency.agency_code);
      if (localByCode) {
        localAgencyId = localByCode.id;
      }
    }
    res.json(successResponse({
      agency,
      administrators: service.listAdministrators(localAgencyId),
      statusHistory: service.statusHistory(localAgencyId),
    }));
  });

router.post('/agencies',
  requireMotherCompany(P.AGENCIES_CREATE),
  async (req, res, next) => {
    // Express 4 does NOT catch rejections from async handlers: without this
    // try/catch a ValidationError (e.g. duplicate agency code / admin email)
    // becomes an unhandledRejection and KILLS the server process. Forward to
    // the error middleware instead.
      try {
      const agency = await svc().createAgency({
        payload: req.body || {},
        actor: req.user,
        providerCompanyId: req.user.companyId,
        req,
      });
      res.status(201).json(successResponse({ agency }, 201));
    } catch (err) {
      next(err);
    }
  });

router.patch('/agencies/:id',
  requireMotherCompany(P.AGENCIES_EDIT),
  async (req, res, next) => {
    try {
      // FIX (UI parity task): the list API returns Supabase UUID ids, but this
      // route (and the SQLite service) key on LOCAL ids. Resolve cloud → local
      // by agency_code, exactly like the status route below does; fall back to
      // the raw id when the agency is local-only.
      const service = svc();
      let localId = req.params.id;
      try {
        const supabaseAgency = await service.getByIdFromSupabase(req.params.id);
        if (supabaseAgency && supabaseAgency.agency_code) {
          const localByCode = service.findByCode(supabaseAgency.agency_code);
          if (localByCode) localId = localByCode.id;
        }
      } catch { /* local-only agency: req.params.id is already the local id */ }
      const agency = await service.updateAgency(localId, {
        payload: req.body || {},
        actor: req.user,
        providerCompanyId: req.user.companyId,
        req,
      });
      res.json(successResponse({ agency }));
    } catch (err) {
      next(err);
    }
  });

router.post('/agencies/:id/status',
  requireMotherCompany(P.AGENCIES_STATUS),
  async (req, res, next) => {
    const { status, reason } = req.body || {};
    const service = svc();
    // Resolve the local agency ID because the UI may send a Supabase UUID
    // or an agency_code after the list API started returning cloud IDs.
    const supabaseAgency = await service.getByIdFromSupabase(req.params.id).catch(() => null);
    let agency = null;
    let localId = req.params.id;
    if (supabaseAgency && supabaseAgency.agency_code) {
      agency = service.findByCode(supabaseAgency.agency_code);
    }
    if (!agency) {
      try {
        agency = service.getForCompany(req.params.id, req.user.companyId);
        localId = agency.id;
      } catch (localLookupError) {
        if (!supabaseAgency) {
          return res.status(404).json(successResponse(null, 404, 'Agency not found'));
        }
        // The agency exists in Supabase but not locally: let changeStatus()
        // create the local stub after the Supabase lookup succeeds.
        localId = req.params.id;
      }
    } else {
      localId = agency.id;
    }
    let updated;
    try {
      updated = await service.changeStatus(localId, {
        status,
        reason,
        actor: req.user,
        providerCompanyId: req.user.companyId,
        req,
      });
    } catch (err) {
      return next(err);
    }
    // Also update Supabase if the agency originated there.
    if (supabaseAgency) {
      try {
        const { getSupabaseClient } = require('../config/supabase');
        const sb = getSupabaseClient();
        const { error } = await sb.from('agencies').update({
          status,
          is_active: status === 'ACTIVE' ? 1 : 0,
          activated_at: status === 'ACTIVE' ? new Date().toISOString() : supabaseAgency.activated_at,
          suspended_at: ['SUSPENDED', 'TERMINATED'].includes(status) ? new Date().toISOString() : null,
          suspended_reason: status === 'SUSPENDED' ? (reason ? String(reason).trim() : null) : null,
          updated_at: new Date().toISOString(),
        }).eq('id', supabaseAgency.id);
        if (error) console.warn('[mother-company] Supabase status update failed:', error.message);
      } catch (cloudErr) {
        console.warn('[mother-company] Supabase status update exception:', cloudErr.message);
      }
    }
    res.json(successResponse({ agency: updated }));
  });

// ── Agency administrators ────────────────────────────────────────────────────

router.get('/agencies/:id/administrators',
  requireMotherCompany(P.AGENCIES_VIEW),
  async (req, res, next) => {
    const service = svc();
    let agency = null;
    try {
      agency = await service.getByIdFromSupabase(req.params.id);
    } catch (supabaseErr) {
      console.warn('[mother-company] Supabase single-agency lookup failed, falling back to local SQLite:', supabaseErr.message);
      agency = service.getForCompany(req.params.id, req.user.companyId);
    }
    let localAgencyId = req.params.id;
    if (agency && agency.agency_code) {
      const localByCode = service.findByCode(agency.agency_code);
      if (localByCode) {
        localAgencyId = localByCode.id;
      }
    }
    res.json(successResponse({ administrators: service.listAdministrators(localAgencyId) }));
  });

router.post('/agencies/:id/administrators',
  requireMotherCompany(P.AGENCIES_ADMINS),
  async (req, res, next) => {
    try {
      // NOTE: app.js rewrites req.body to snake_case before any route runs
      // (see the camelToSnake middleware), so routes destructure snake_case keys.
      // Destructuring `fullName` here silently received undefined.
      const {
        email,
        full_name: fullName,
        password,
        username,
      } = req.body || {};
      // Length policy is enforced here, BEFORE hashing: once hashed, the
      // plaintext is gone and the service can no longer judge its strength.
      if (!password || String(password).length < 10) {
        throw new ValidationError('Administrator password must be at least 10 characters.');
      }
      const service = svc();
      let agency = null;
      try {
        agency = await service.getByIdFromSupabase(req.params.id);
      } catch (supabaseErr) {
        console.warn('[mother-company] Supabase single-agency lookup failed, falling back to local SQLite:', supabaseErr.message);
        agency = service.getForCompany(req.params.id, req.user.companyId);
      }
      // Supabase IDs are NOT valid local SQLite PKs. Resolve the local agency
      // by code so the SQLite transaction inserts a valid `agency_id`.
      let localAgencyId = req.params.id;
      if (agency && agency.agency_code) {
        const localByCode = service.findByCode(agency.agency_code);
        if (localByCode) {
          localAgencyId = localByCode.id;
          agency = localByCode;
        }
      }
      const administrator = await service.assignAdministrator(localAgencyId, {
        email,
        fullName,
        username,
        password,
        actor: req.user,
        providerCompanyId: req.user.companyId,
        req,
        agency,
      });

      // FIX (MC-assign flow, task 1): Supabase auth identity for the admin.
      // createNew = a fresh local user (create the auth user + profiles row);
      // linked = an existing ACTIVE local user was granted the admin role
      // (update their auth password to the one-time credential, set
      // must_change_password, mirror app_metadata) — never a raw createUser
      // failure on an existing email.
      try {
        const { isConfigured, getSupabaseClient } = require('../config/supabase');
        if (isConfigured()) {
          const sb = getSupabaseClient();
          const localUser = service.db.get('SELECT id, email, supabase_user_id FROM users WHERE email = ?', [String(email).trim().toLowerCase()]);
          const synthesizedEmail = `${(username || fullName || 'admin').toString().trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')}.${Date.now()}@accounts.blackstack.local`;
          const authEmail = (localUser && localUser.email && !localUser.email.endsWith('@accounts.blackstack.local'))
            ? localUser.email
            : synthesizedEmail;
          const { data: existingAuth } = await sb.auth.admin.listUsers();
          const match = (existingAuth && existingAuth.users || []).find(
            (u) => (u.email || '').toLowerCase() === String(authEmail).toLowerCase());
          if (match) {
            // EXISTING auth user: reset credential to the one-time password +
            // force change on first login, and mirror app_metadata.
            await sb.auth.admin.updateUserById(match.id, {
              password,
              app_metadata: { role: 'agency', agency_id: (agency && agency.id) || localAgencyId },
            });
            await sb.from('profiles').upsert({
              user_id: match.id,
              username: (username || email).toString().trim().toLowerCase(),
              role: 'agency',
              agency_id: (agency && agency.id) || localAgencyId,
              parent_user_id: null,
              must_change_password: true,
              is_active: true,
            }, { onConflict: 'user_id' });
            if (localUser && !localUser.supabase_user_id) {
              service.db.run('UPDATE users SET supabase_user_id = ?, must_change_password = 1 WHERE id = ?', [match.id, localUser.id]);
            }
            console.log('[mother-company] existing auth user linked to agency', { email: authEmail, agencyId: localAgencyId });
          } else {
            // NEW auth user: create with app_metadata (server-set only).
            const { data: created, error: createErr } = await sb.auth.admin.createUser({
              email: authEmail,
              password,
              email_confirm: true,
              app_metadata: { role: 'agency', agency_id: (agency && agency.id) || localAgencyId, parent_user_id: null },
            });
            if (createErr) throw createErr;
            const { error: profErr } = await sb.from('profiles').upsert({
              user_id: created.user.id,
              username: (username || email).toString().trim().toLowerCase(),
              role: 'agency',
              agency_id: (agency && agency.id) || localAgencyId,
              parent_user_id: null,
              must_change_password: true,
              is_active: true,
            }, { onConflict: 'user_id' });
            if (profErr) console.error('[mother-company] profiles mirror failed:', profErr.message);
            if (localUser && !localUser.supabase_user_id) {
              service.db.run('UPDATE users SET supabase_user_id = ?, must_change_password = 1 WHERE id = ?', [created.user.id, localUser.id]);
            }
          }
        }
      } catch (cloudErr) {
        // Best-effort: the local assignment is authoritative; a cloud identity
        // failure must not roll back the operator's action.
        console.error('[mother-company] Supabase admin identity sync failed:', cloudErr instanceof Error ? cloudErr.message : String(cloudErr));
      }

      try {
        const agencyAfter = service.getForCompany(localAgencyId, req.user.companyId);
        console.log('[SYNC] agencyAfter id:', agencyAfter && agencyAfter.id);
        service._syncAgencyToCloud(service.db, agencyAfter, req.user);
      } catch (e) {
        console.error('[SYNC] admin sync threw:', e instanceof Error ? e.message : String(e));
      }
      res.status(201).json(successResponse({ administrator }, 201));
    } catch (err) {
      next(err);
    }
  });

router.delete('/agencies/:id/administrators/:adminId',
  requireMotherCompany(P.AGENCIES_ADMINS),
  async (req, res, next) => {
    try {
      // FIX (cloud-id parity): the list API hands the UI cloud UUID agency ids,
      // but revokeAdministrator() keys on the LOCAL agency id via
      // getForCompany(). Resolve cloud → local by agency_code first (same
      // pattern as the status/edit/delete routes); fall back to the raw id
      // when the agency is local-only. Without this, Remove Admin failed with
      // "Agency with ID <uuid> not found" even though the admin existed.
      const service = svc();
      let localAgencyId = req.params.id;
      try {
        const supabaseAgency = await service.getByIdFromSupabase(req.params.id);
        if (supabaseAgency && supabaseAgency.agency_code) {
          const localByCode = service.findByCode(supabaseAgency.agency_code);
          if (localByCode) localAgencyId = localByCode.id;
        }
      } catch { /* local-only agency: req.params.id is already the local id */ }
      const administrator = service.revokeAdministrator(localAgencyId, {
        adminId: req.params.adminId,
        actor: req.user,
        providerCompanyId: req.user.companyId,
        req,
      });
      res.json(successResponse({ administrator }));
    } catch (err) {
      next(err);
    }
  });

// ── Agency removal (hard delete) ───────────────────────────────────────────
// FIX (UI parity task): the Mother Company page now offers the same full
// Actions menu as the Agency Control page. removeSubAgency() is the audited
// hard-delete path: transactional child-table cleanup (customers, parent
// links, admins, status history, cloud_sync rows) followed by cloud deletes
// with the local→cloud id mapping. Scope note: this route is guarded by
// requireMotherCompany(AGENCIES_EDIT), so only a Mother Company operator can
// reach it — the service's internal callerAgency scope check does not apply
// because the operator is not an agency_administrator; the permission guard
// is the admission control here.
router.delete('/agencies/:id',
  requireMotherCompany(P.AGENCIES_EDIT),
  async (req, res, next) => {
    try {
      // Resolve the local agency id: the list API may hand the UI a cloud UUID
      // or an agency_code (same resolution the status route performs).
      const service = svc();
      let localId = req.params.id;
      try {
        const supabaseAgency = await service.getByIdFromSupabase(req.params.id);
        if (supabaseAgency && supabaseAgency.agency_code) {
          const localByCode = service.findByCode(supabaseAgency.agency_code);
          if (localByCode) localId = localByCode.id;
        }
      } catch { /* local-only agency: req.params.id is already the local id */ }
      const { AgencyControlService } = require('../services/agencyControl.service');
      await new AgencyControlService(getConn()).removeSubAgency(req.user.userId, localId);
      res.json(successResponse({ deleted: true }));
    } catch (err) {
      next(err);
    }
  });

// ── Audit history ────────────────────────────────────────────────────────────

router.get('/audit',
  requireMotherCompany(P.AUDIT_VIEW),
  (req, res) => {
    res.json(successResponse({ entries: svc().auditHistory(req.user.companyId, { limit: req.query.limit }) }));
  });

module.exports = router;
