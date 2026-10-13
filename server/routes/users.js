const express = require('express');
const { body, validationResult } = require('express-validator');
const { UsersController } = require('../controllers/users.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new UsersController();

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

router.get('/', authMiddleware, requirePermission('users.view'), controller.list.bind(controller));
router.get('/:id', authMiddleware, controller.getOne.bind(controller));
router.post('/', authMiddleware, requirePermission('users.manage'),
  [body('email').isEmail(), body('full_name').notEmpty(), body('password').isLength({ min: 8 })],
  handle, controller.create.bind(controller));
router.put('/:id', authMiddleware, requirePermission('users.manage'), controller.update.bind(controller));
router.delete('/:id', authMiddleware, requirePermission('users.manage'), controller.remove.bind(controller));

module.exports = router;