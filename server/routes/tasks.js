const express = require('express');
const { body, validationResult } = require('express-validator');
const { TasksController } = require('../controllers/tasks.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new TasksController();

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

router.get('/', authMiddleware, requirePermission('tasks.view'), controller.list.bind(controller));
router.get('/:id', authMiddleware, requirePermission('tasks.view'), controller.getOne.bind(controller));
router.post('/', authMiddleware, requirePermission('tasks.create'),
  [body('title').notEmpty()], handle, controller.create.bind(controller));
router.put('/:id', authMiddleware, requirePermission('tasks.edit'), controller.update.bind(controller));
router.delete('/:id', authMiddleware, requirePermission('tasks.delete'), controller.remove.bind(controller));
router.post('/:id/complete', authMiddleware, requirePermission('tasks.edit'), controller.complete.bind(controller));

module.exports = router;