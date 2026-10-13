const express = require('express');
const { body, validationResult } = require('express-validator');
const { OrganizationsController } = require('../controllers/organizations.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new OrganizationsController();

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

router.get('/', authMiddleware, requirePermission('organizations.view'), controller.list.bind(controller));
router.get('/:id', authMiddleware, requirePermission('organizations.view'), controller.getOne.bind(controller));
router.post('/', authMiddleware, requirePermission('organizations.create'),
  [body('name').notEmpty().withMessage('Name is required')], handle, controller.create.bind(controller));
router.put('/:id', authMiddleware, requirePermission('organizations.edit'), controller.update.bind(controller));
router.delete('/:id', authMiddleware, requirePermission('organizations.delete'), controller.remove.bind(controller));

module.exports = router;