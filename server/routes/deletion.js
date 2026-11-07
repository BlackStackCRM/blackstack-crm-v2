/**
 * Deletion controller + routes — the ONLY delete surface for the UI.
 *
 * POST /api/deletion/analyze        { entity_type, entity_id }
 * POST /api/deletion/archive        deprecated; returns ARCHIVE_NOT_SUPPORTED
 * POST /api/deletion/execute        { entity_type, entity_id, confirmationToken, expectedCount? }
 *
 * NOTE: Restore is no longer supported — all deletions are permanent.
 */
const express = require('express');
const { DeletionService } = require('../services/deletion.service');
const { getConn } = require('../utils/db');
const { successResponse } = require('../utils/response');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { AppError, AuthorizationError } = require('../utils/errors');

const router = express.Router();

// Explicit permissions for every supported entity and operation. Missing
// entries fail closed instead of silently skipping authorization.
const ENTITY_PERMISSIONS = {
  contact: { view: 'contacts.view', delete: 'contacts.delete' },
  organization: { view: 'organizations.view', delete: 'organizations.delete' },
  lead: { view: 'leads.view', delete: 'leads.delete' },
  deal: { view: 'deals.view', delete: 'deals.delete' },
  task: { view: 'tasks.view', delete: 'tasks.delete' },
  note: { view: 'notes.view', delete: 'notes.delete' },
  appointment: { view: 'appointments.view', delete: 'appointments.delete' },
  product: { view: 'products.view', delete: 'products.delete' },
  pipeline: { view: 'pipelines.view', delete: 'pipelines.delete' },
  relationship: { view: 'relationships.view', delete: 'relationships.delete' },
  workflow: { view: 'workflows.view', delete: 'workflows.manage' },
  customer: { view: 'customers.view', delete: 'customers.delete' },
  activity: { view: 'activities.view', delete: 'activities.delete' },
  invoice: { view: 'invoices.view', delete: 'invoices.delete' },
  user: { view: 'users.view', delete: 'users.manage' },
  role: { view: 'users.view', delete: 'users.manage' },
};

function getContext(req) {
  return { companyId: req.user.companyId || 'default', userId: req.user.userId };
}

// Global middleware converts incoming JSON snake_case; accept both spellings.
function getParams(req) {
  const b = req.body || {};
  return {
    entityType: b.entity_type ?? b.entityType,
    entityId: b.entity_id ?? b.entityId,
    reason: b.reason,
    confirmationToken: b.confirmation_token ?? b.confirmationToken,
    expectedCount: b.expected_count ?? b.expectedCount,
  };
}

function checkPermission(entityType, action, req) {
  const permission = ENTITY_PERMISSIONS[entityType]?.[action];
  if (!permission) throw new AuthorizationError(`No ${action} permission is configured for this entity type.`);
  requirePermission(permission)(req, {}, (err) => { if (err) throw err; });
}

class DeletionController {
  analyze(req, res, next) {
    try {
      const p = getParams(req);
      checkPermission(p.entityType, 'view', req);
      const svc = new DeletionService(getConn());
      return res.json(successResponse(svc.analyzeDeletion(p.entityType, p.entityId, getContext(req).companyId)));
    } catch (err) { next(err); }
  }

  archive(req, res, next) {
    try {
      const p = getParams(req);
      checkPermission(p.entityType, 'delete', req);
      const svc = new DeletionService(getConn());
      // Soft-delete columns were removed by migration 079. Do not emulate
      // archive with an unsafe direct DELETE; hard deletion is available only
      // through /execute after dependency analysis and confirmation.
      return res.json(successResponse(svc.archiveEntity(p.entityType, p.entityId, p.reason, getContext(req))));
    } catch (err) { next(err); }
  }

  execute(req, res, next) {
    try {
      const p = getParams(req);
      checkPermission(p.entityType, 'delete', req);
      const svc = new DeletionService(getConn());
      return res.json(successResponse(
        svc.deleteEntityWithDependencies(p.entityType, p.entityId, { confirmationToken: p.confirmationToken, expectedCount: p.expectedCount, reason: p.reason }, getContext(req))
      ));
    } catch (err) { next(err); }
  }
}

router.post('/analyze', authMiddleware, (req, res, next) => new DeletionController().analyze(req, res, next));
router.post('/archive', authMiddleware, (req, res, next) => new DeletionController().archive(req, res, next));
// Restore route removed — all deletions are permanent.
router.post('/execute', authMiddleware, (req, res, next) => new DeletionController().execute(req, res, next));

module.exports = router;
