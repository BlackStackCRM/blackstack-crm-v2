const express = require('express');
const { body, validationResult } = require('express-validator');
const { DealsController } = require('../controllers/deals.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new DealsController();

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

router.get('/', authMiddleware, requirePermission('deals.view'), controller.list.bind(controller));
router.get('/:id', authMiddleware, requirePermission('deals.view'), controller.getOne.bind(controller));
router.post('/', authMiddleware, requirePermission('deals.create'),
  [body('title').notEmpty(), body('contact_id').notEmpty(), body('stage_id').notEmpty()],
  handle, controller.create.bind(controller));
router.put('/:id', authMiddleware, requirePermission('deals.edit'), controller.update.bind(controller));
router.delete('/:id', authMiddleware, requirePermission('deals.delete'), controller.remove.bind(controller));
router.post('/:id/stage', authMiddleware, requirePermission('deals.edit'), [body('stage_id').notEmpty()], handle, controller.updateStage.bind(controller));
router.post('/:id/mark-won', authMiddleware, requirePermission('deals.edit'), controller.markWon.bind(controller));
router.post('/:id/mark-lost', authMiddleware, requirePermission('deals.edit'), controller.markLost.bind(controller));
router.post('/:id/reopen', authMiddleware, requirePermission('deals.edit'), controller.markReopen.bind(controller));

module.exports = router;