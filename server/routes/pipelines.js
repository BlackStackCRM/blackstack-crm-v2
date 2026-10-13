const { requirePermission } = require('../middleware/rbac');
const express = require('express');
const { body, validationResult } = require('express-validator');
const { PipelinesController } = require('../controllers/pipelines.controller');
const { authMiddleware } = require('../middleware/auth');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new PipelinesController();

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

router.get('/stages', authMiddleware, requirePermission('pipelines.view'), controller.getStages.bind(controller));
router.get('/', authMiddleware, requirePermission('pipelines.view'), controller.list.bind(controller));
router.get('/:id', authMiddleware, requirePermission('pipelines.view'), controller.getOne.bind(controller));
router.post('/', authMiddleware, requirePermission('pipelines.create'), [body('name').notEmpty()], handle, controller.create.bind(controller));
router.put('/:id', authMiddleware, requirePermission('pipelines.edit'), controller.update.bind(controller));
router.delete('/:id', authMiddleware, requirePermission('pipelines.delete'), controller.remove.bind(controller));

module.exports = router;