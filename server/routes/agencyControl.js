/**
 * AGENCY CONTROL ROUTES — sub-agencies and customer tenants.
 *
 * Mounted at /api/agency-control (server/app.js). Auth is the standard
 * authMiddleware; authorization uses the existing agency_control.* permission
 * codes via the standard requirePermission guard. Tenant scoping happens in
 * the service: a caller only ever sees and touches agencies/companies inside
 * their own administered agency's scope, and cross-tenant ids read as 404.
 */
const express = require('express');
const { body, param } = require('express-validator');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { getConn } = require('../utils/db');
const { AgencyControlService } = require('../services/agencyControl.service');
const { successResponse } = require('../utils/response');

const router = express.Router();

const validate = (req, res, next) => {
  const { validationResult } = require('express-validator');
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const fields = {};
    for (const e of errors.array()) fields[e.path || 'input'] = e.msg;
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: errors.array().map((e) => e.msg).join('; '), fields },
    });
  }
  next();
};

const svc = () => new AgencyControlService(getConn());

// ── Sub-agencies ──────────────────────────────────────────────────────────────

router.get('/sub-agencies',
  authMiddleware,
  requirePermission('agency_control.subagencies.view'),
  async (req, res, next) => {
    try {
      const data = await svc().listSubAgencies(req.user.userId, req.user);
      res.json(successResponse(data));
    } catch (err) {
      next(err);
    }
  });

router.post('/sub-agencies',
  authMiddleware,
  requirePermission('agency_control.subagencies.create'),
  [
    body('name').isString().trim().notEmpty().withMessage('Name is required.').isLength({ max: 200 }).withMessage('Name must be 200 characters or fewer.'),
    // Optional: which agency the new sub-agency belongs under. The frontend's
    // camelCase `parentAgencyId` arrives as `parent_agency_id` via the
    // camelToSnake middleware (same trap as the customers route documents).
    body('parent_agency_id').optional({ values: 'falsy' }).isString().trim().notEmpty().withMessage('Parent agency must be a valid id.'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const payload = req.body || {};
      const cleanName = String(payload.name || '').trim();
      if (!cleanName) {
        throw new ValidationError('Sub-agency validation failed.', { name: 'Name is required.' });
      }
      // Accept both conventions — the middleware chain may or may not have
      // rewritten the frontend's camelCase key.
      const parentAgencyId = payload.parent_agency_id || payload.parentAgencyId || null;
      const agency = await svc().createSubAgency(req.user, { name: cleanName, parentAgencyId });
      res.status(201).json(successResponse({ agency }, 201));
    } catch (err) {
      next(err);
    }
  });

router.post('/sub-agencies/bulk/status',
  authMiddleware,
  requirePermission('agency_control.agencies.manage'),
  [
    body('ids').isArray().withMessage('ids must be an array.').notEmpty().withMessage('ids is required.'),
    body('status').isIn(['ACTIVE', 'SUSPENDED', 'PENDING', 'TERMINATED']).withMessage('Invalid status.'),
    body('reason').optional().isString().isLength({ max: 500 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const result = await svc().bulkSubAgencyStatus(req.user.userId, req.body || {});
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  });

router.post('/sub-agencies/bulk/remove',
  authMiddleware,
  requirePermission('agency_control.agencies.manage'),
  [
    body('ids').isArray().withMessage('ids must be an array.').notEmpty().withMessage('ids is required.'),
  ],
  validate,
  async (req, res, next) => {
    try {
      // FIX (audit F1): authMiddleware + requirePermission restored — this route
      // previously had NO auth gate and fell back to userId='admin', letting an
      // unauthenticated caller bulk-delete agencies. Inline 500 responses were
      // also replaced with next(err) so classifyError sanitizes the payload.
      const ids = req.body.ids || req.body.agencyIds || [];
      const result = await svc().bulkRemoveSubAgencies(req.user.userId, { ids });
      res.json({ success: true, updated: result.updated });
    } catch (err) {
      next(err);
    }
  });

router.post('/sub-agencies/:id/status',
  authMiddleware,
  requirePermission('agency_control.agencies.manage'),
  [
    param('id').isString().notEmpty(),
    body('status').isIn(['ACTIVE', 'SUSPENDED', 'PENDING', 'TERMINATED']).withMessage('Invalid status.'),
    body('reason').optional().isString().isLength({ max: 500 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const agency = await svc().changeSubAgencyStatus(req.user.userId, req.params.id, req.body || {});
      res.json(successResponse({ agency }));
    } catch (err) {
      next(err);
    }
  });

router.put('/sub-agencies/:id',
  authMiddleware,
  requirePermission('agency_control.agencies.manage'),
  [
    param('id').isString().notEmpty(),
    body('name').optional().isString().trim().isLength({ max: 200 }),
    body('agency_code').optional().isString().trim().isLength({ max: 50 }),
    body('contact_email').optional().isString().trim().isLength({ max: 200 }),
    body('contact_phone').optional().isString().trim().isLength({ max: 50 }),
    // FIX: address fields from the Edit modal were accepted by the service but
    // never mapped through this route — they were silently dropped, so the View
    // modal always rendered Address/City/State/Pincode as "—" even after saving.
    body('address').optional().isString().trim().isLength({ max: 300 }),
    body('city').optional().isString().trim().isLength({ max: 100 }),
    body('state').optional().isString().trim().isLength({ max: 100 }),
    body('pincode').optional().isString().trim().isLength({ max: 20 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const payload = req.body || {};
      const agency = await svc().updateSubAgency(req.user.userId, req.params.id, {
        name: payload.name,
        agencyCode: payload.agency_code,
        contactEmail: payload.contact_email,
        contactPhone: payload.contact_phone,
        // camelToSnake middleware rewrites the frontend's camelCase keys, so
        // these arrive as-is (single words). Load/round-trip the new fields.
        address: payload.address,
        city: payload.city,
        state: payload.state,
        pincode: payload.pincode,
      });
      res.json(successResponse({ agency }));
    } catch (err) {
      next(err);
    }
  });

router.delete('/sub-agencies/:id',
  authMiddleware,
  requirePermission('agency_control.agencies.manage'),
  [param('id').isString().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      // FIX (audit F1): was unauthenticated with a userId='admin' fallback —
      // anyone could hard-delete an agency. Now gated and error-sanitized.
      await svc().removeSubAgency(req.user.userId, req.params.id);
      res.json({ success: true, deleted: true });
    } catch (err) {
      next(err);
    }
  });

router.delete('/administrators/:id/permanent',
  authMiddleware,
  requirePermission('agency_control.agencies.manage'),
  [param('id').isString().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      const result = await svc().permanentlyDeleteAdministrator(req.user.userId, req.params.id);
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

router.post('/sub-agencies/:id/administrators',
  authMiddleware,
  requirePermission('agency_control.agencies.manage'),
  [
    param('id').isString().notEmpty(),
    body('fullName').optional().isString().trim().isLength({ max: 200 }),
    body('email').optional().isString().trim().isLength({ max: 200 }),
    body('username').optional().isString().trim().isLength({ max: 100 }),
    body('password').optional().isString().isLength({ min: 10 }).withMessage('Password must be at least 10 characters.'),
  ],
  validate,
  async (req, res, next) => {
    try {
      // FIX (audit F1): was unauthenticated; now gated. Route-level password
      // length mirrors the reset-password contract (min 10).
      const payload = {
        fullName: req.body.full_name || req.body.fullName,
        email: req.body.email,
        username: req.body.username,
        password: req.body.password,
      };
      const admin = await svc().addSubAgencyAdmin(req.user.userId, req.params.id, payload);
      res.json({ success: true, data: admin });
    } catch (err) {
      next(err);
    }
  });

router.get('/sub-agencies/:id/administrators',
  authMiddleware,
  requirePermission('agency_control.subagencies.view'),
  [param('id').isString().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      console.log('GET ADMINS ROUTE:', { agencyId: req.params.id });
      // FIX (audit F1): was unauthenticated — user-enumeration leak. Now gated
      // by the view permission; scope enforcement stays in the service.
      const admins = await svc().listSubAgencyAdministrators(req.user.userId, req.params.id);
      console.log('GET ADMINS ROUTE:', { agencyId: req.params.id, count: admins.length });
      res.json({ success: true, data: { administrators: admins } });
    } catch (err) {
      next(err);
    }
  });

router.get('/sub-agencies/:id',
  authMiddleware,
  requirePermission('agency_control.subagencies.view'),
  [param('id').isString().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      // FIX (audit F1): was unauthenticated. Now gated by the view permission.
      const agency = await svc().getSubAgency(req.user.userId, req.params.id);
      res.json({ success: true, data: { agency } });
    } catch (err) {
      next(err);
    }
  });

router.post('/sub-agencies/:id/reset-password',
  authMiddleware,
  requirePermission('agency_control.agencies.manage'),
  [
    param('id').isString().notEmpty(),
    body('password').isString().isLength({ min: 10 }).withMessage('Password must be at least 10 characters.'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const result = await svc().resetSubAgencyAdminPassword(req.user.userId, req.params.id, req.body || {});
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  });

// ── Customer tenants ─────────────────────────────────────────────────────────

router.get('/customers',
  authMiddleware,
  requirePermission('agency_control.customers.manage'),
  async (req, res, next) => {
    try {
      // FIX (audit): listCustomers is async (scope resolution awaits the
      // caller-agency lookup); the route must await it or the response serialises
      // a Promise → `{}` body / serialisation warnings instead of customer rows.
      const data = await svc().listCustomers(req.user.userId);
      res.json(successResponse(data));
    } catch (err) {
      next(err);
    }
  });

router.post('/customers',
  authMiddleware,
  requirePermission('agency_control.customers.manage'),
  [
    body('name').isString().trim().notEmpty().withMessage('Name is required.').isLength({ max: 200 }).withMessage('Name must be 200 characters or fewer.'),
    // NOTE: app.js rewrites req.body to snake_case before routes run
    // (camelToSnake middleware), so the frontend's `agencyId` arrives as
    // `agency_id` — same trap the motherCompany routes document.
    body('agency_id').isString().notEmpty().withMessage('An agency must be selected.'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const payload = req.body || {};
      // FIX (audit F6, §3.5): the middleware chain may rewrite the body to
      // snake_case (camelToSnake) or leave it as the frontend's camelCase;
      // the old code read only payload.agency_id, so whichever convention
      // wasn't active produced agencyId: undefined → misleading "An agency
      // must be selected" validation error. Accept both.
      const agencyId = payload.agency_id || payload.agencyId;
      const customer = await svc().createCustomer(req.user.userId, { name: payload.name, agencyId });
      res.status(201).json(successResponse({ customer }, 201));
    } catch (err) {
      next(err);
    }
  });

router.patch('/customers/:id/assignment',
  authMiddleware,
  requirePermission('agency_control.customers.manage'),
  [
    param('id').isString().notEmpty(),
    // camelToSnake middleware rewrites agencyId -> agency_id (see note above).
    body('agency_id').isString().notEmpty().withMessage('An agency must be selected.'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const payload = req.body || {};
      // FIX (audit): reassignCustomer is async — await it, and accept both
      // payload conventions (agency_id post-middleware, agencyId raw).
      const agencyId = payload.agency_id || payload.agencyId;
      const customer = await svc().reassignCustomer(req.user.userId, req.params.id, { agencyId });
      res.json(successResponse({ customer }));
    } catch (err) {
      next(err);
    }
  });

// ── Customer tenants: bulk routes (registered BEFORE the parameterized
// /customers/:id/access route — Express matches in registration order, so
// /customers/bulk/access would otherwise be captured by :id/access with
// id="bulk" → "Customer with ID bulk not found") ─────────────────────────────

router.post('/customers/bulk/access',
  authMiddleware,
  requirePermission('agency_control.customers.manage'),
  [
    body('ids').isArray().withMessage('ids must be an array.').notEmpty().withMessage('ids is required.'),
    body('status').isIn(['ACTIVE', 'SUSPENDED']).withMessage('Access must be ACTIVE or SUSPENDED.'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const result = await svc().bulkCustomerAccess(req.user.userId, req.body || {});
      res.json(successResponse(result));
    } catch (err) { next(err); }
  });

router.post('/customers/bulk/remove',
  authMiddleware,
  requirePermission('agency_control.customers.manage'),
  [body('ids').isArray().withMessage('ids must be an array.').notEmpty().withMessage('ids is required.')],
  validate,
  async (req, res, next) => {
    try {
      const result = await svc().bulkRemoveCustomers(req.user.userId, req.body || {});
      res.json(successResponse(result));
    } catch (err) { next(err); }
  });

router.post('/customers/:id/access',
  authMiddleware,
  requirePermission('agency_control.customers.manage'),
  [
    param('id').isString().notEmpty(),
    body('status').isIn(['ACTIVE', 'SUSPENDED']).withMessage('Access must be ACTIVE or SUSPENDED.'),
  ],
  validate,
  async (req, res, next) => {
    try {
      // FIX (audit): changeCustomerAccess is async — await it.
      const customer = await svc().changeCustomerAccess(req.user.userId, req.params.id, req.body || {});
      res.json(successResponse({ customer }));
    } catch (err) {
      next(err);
    }
  });

// ── Customer tenants: edit / remove / bulk (UI parity with sub-agencies) ────

router.put('/customers/:id',
  authMiddleware,
  requirePermission('agency_control.customers.manage'),
  [param('id').isString().notEmpty(), body('name').isString().trim().notEmpty().withMessage('Customer name is required.').isLength({ max: 200 }).withMessage('Name must be 200 characters or fewer.')],
  validate,
  async (req, res, next) => {
    try {
      const customer = await svc().renameCustomer(req.user.userId, req.params.id, req.body || {});
      res.json(successResponse({ customer }));
    } catch (err) { next(err); }
  });

router.delete('/customers/:id',
  authMiddleware,
  requirePermission('agency_control.customers.manage'),
  [param('id').isString().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      await svc().removeCustomer(req.user.userId, req.params.id);
      res.json(successResponse({ deleted: true }));
    } catch (err) { next(err); }
  });

// Customer tenant administrator — creates a login (users row) scoped to the
// customer's own company tenant, role CUSTOMER_ADMIN. Password length is
// validated here (before hashing), mirroring the sub-agency admin route.
router.post('/customers/:id/administrators',
  authMiddleware,
  requirePermission('agency_control.customers.manage'),
  [
    param('id').isString().notEmpty(),
    body('fullName').optional({ values: 'falsy' }).isString().trim().isLength({ max: 200 }),
    body('email').optional({ values: 'falsy' }).isString().trim().isLength({ max: 200 }),
    body('username').optional({ values: 'falsy' }).isString().trim().isLength({ max: 100 }),
    body('password').optional({ values: 'falsy' }).isString().isLength({ min: 10 }).withMessage('Password must be at least 10 characters.'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const b = req.body || {};
      const payload = {
        fullName: b.full_name || b.fullName,
        email: b.email,
        username: b.username,
        password: b.password,
      };
      const admin = await svc().addCustomerAdmin(req.user.userId, req.params.id, payload);
      // No password material in the response.
      res.status(201).json(successResponse({ admin }, 201));
    } catch (err) { next(err); }
  });

router.get('/customers/:id/administrators',
  authMiddleware,
  requirePermission('agency_control.customers.manage'),
  [param('id').isString().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      const admins = await svc().listCustomerAdministrators(req.user.userId, req.params.id);
      res.json(successResponse({ administrators: admins }));
    } catch (err) { next(err); }
  });

module.exports = router;
