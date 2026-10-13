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

const router = express.Router();

// Auth first for the whole router, then per-route Mother Company permission.
router.use(authMiddleware);

const svc = () => new AgencyService(getConn());

// ── Dashboard ────────────────────────────────────────────────────────────────

router.get('/dashboard',
  requireAnyMotherCompanyPermission(),
  async (req, res) => {
    const stats = svc().stats(req.user.companyId);
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
  });

// ── Agencies ─────────────────────────────────────────────────────────────────

router.get('/agencies',
  requireMotherCompany(P.AGENCIES_VIEW),
  (req, res) => {
    const { total, agencies } = svc().list({
      providerCompanyId: req.user.companyId,
      search: req.query.search,
      status: req.query.status,
      isActive: req.query.isActive,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json(successResponse({ agencies, total }));
  });

router.get('/agencies/:id',
  requireMotherCompany(P.AGENCIES_VIEW),
  (req, res) => {
    const service = svc();
    const agency = service.getForCompany(req.params.id, req.user.companyId);
    res.json(successResponse({
      agency,
      administrators: service.listAdministrators(agency.id),
      statusHistory: service.statusHistory(agency.id),
    }));
  });

router.post('/agencies',
  requireMotherCompany(P.AGENCIES_CREATE),
  (req, res) => {
    const agency = svc().createAgency({
      payload: req.body || {},
      actor: req.user,
      providerCompanyId: req.user.companyId,
      req,
    });
    res.status(201).json(successResponse({ agency }, 201));
  });

router.patch('/agencies/:id',
  requireMotherCompany(P.AGENCIES_EDIT),
  (req, res) => {
    const agency = svc().updateAgency(req.params.id, {
      payload: req.body || {},
      actor: req.user,
      providerCompanyId: req.user.companyId,
      req,
    });
    res.json(successResponse({ agency }));
  });

router.post('/agencies/:id/status',
  requireMotherCompany(P.AGENCIES_STATUS),
  (req, res) => {
    const { status, reason } = req.body || {};
    const agency = svc().changeStatus(req.params.id, {
      status,
      reason,
      actor: req.user,
      providerCompanyId: req.user.companyId,
      req,
    });
    res.json(successResponse({ agency }));
  });

// ── Agency administrators ────────────────────────────────────────────────────

router.get('/agencies/:id/administrators',
  requireMotherCompany(P.AGENCIES_VIEW),
  (req, res) => {
    const service = svc();
    service.getForCompany(req.params.id, req.user.companyId);
    res.json(successResponse({ administrators: service.listAdministrators(req.params.id) }));
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
      const administrator = await svc().assignAdministrator(req.params.id, {
        email,
        fullName,
        password,
        username,
        actor: req.user,
        providerCompanyId: req.user.companyId,
        req,
      });
      res.status(201).json(successResponse({ administrator }, 201));
    } catch (err) {
      next(err);
    }
  });

router.delete('/agencies/:id/administrators/:adminId',
  requireMotherCompany(P.AGENCIES_ADMINS),
  (req, res) => {
    const administrator = svc().revokeAdministrator(req.params.id, {
      adminId: req.params.adminId,
      actor: req.user,
      providerCompanyId: req.user.companyId,
      req,
    });
    res.json(successResponse({ administrator }));
  });

// ── Audit history ────────────────────────────────────────────────────────────

router.get('/audit',
  requireMotherCompany(P.AUDIT_VIEW),
  (req, res) => {
    res.json(successResponse({ entries: svc().auditHistory(req.user.companyId, { limit: req.query.limit }) }));
  });

module.exports = router;
