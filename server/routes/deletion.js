/**
 * Deletion controller + routes — the ONLY delete surface for the UI.
 *
 * POST /api/deletion/analyze        { entity_type, entity_id }
 * POST /api/deletion/archive        { entity_type, entity_id, reason }  → PERMANENT DELETE
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

// Permission suffix map per entity type
const PERM = {
  contact: 'contacts', organization: 'organizations', lead: 'contacts',
  deal: 'deals', task: 'tasks', note: null, appointment: 'appointments',
  product: 'products', pipeline: null, relationship: null,
  workflow: 'workflows', customer: 'contacts', activity: null,
  invoice: 'invoices', user: 'users', role: 'users',
};

function getContext(req) {
  return { companyId: req.user.companyId || 'default', userId: req.user.userId };
}

// Global middleware converts incoming JSON snake_case; accept both spellings.
const pick = (b, snake, camel) => b?.[snake] ?? b?.[camel];

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
  const prefix = PERM[entityType];
  if (prefix) requirePermission(`${prefix}.${action}`)(req, {}, (err) => {
    if (err) throw new AuthorizationError(`Missing permission ${prefix}.${action}`);
  });
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
      // Archive now performs permanent delete (no soft-delete).
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
