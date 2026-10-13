const express = require('express');
const { body, validationResult } = require('express-validator');
const { WorkflowsController } = require('../controllers/workflows.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new WorkflowsController();

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

router.get('/', authMiddleware, requirePermission('workflows.view'), controller.list.bind(controller));
router.get('/:id', authMiddleware, controller.getOne.bind(controller));
router.post('/', authMiddleware, requirePermission('workflows.manage'),
  [body('name').notEmpty(), body('trigger_type').notEmpty()],
  handle, controller.create.bind(controller));
router.put('/:id', authMiddleware, requirePermission('workflows.manage'), controller.update.bind(controller));
router.delete('/:id', authMiddleware, requirePermission('workflows.manage'), controller.remove.bind(controller));
router.post('/:id/trigger', authMiddleware, controller.trigger.bind(controller));

module.exports = router;