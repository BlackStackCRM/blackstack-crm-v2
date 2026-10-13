const express = require('express');
const { body, validationResult } = require('express-validator');
const { AppointmentsController } = require('../controllers/appointments.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new AppointmentsController();

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

router.get('/', authMiddleware, requirePermission('appointments.view'), controller.list.bind(controller));
router.get('/:id', authMiddleware, requirePermission('appointments.view'), controller.getOne.bind(controller));
router.post('/', authMiddleware, requirePermission('appointments.create'),
  [body('title').notEmpty(), body('start_time').notEmpty(), handle], controller.create.bind(controller));
router.put('/:id', authMiddleware, requirePermission('appointments.edit'), controller.update.bind(controller));
router.delete('/:id', authMiddleware, requirePermission('appointments.delete'), controller.remove.bind(controller));

module.exports = router;
