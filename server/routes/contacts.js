const express = require('express');
const { body, validationResult } = require('express-validator');
const { ContactsController } = require('../controllers/contacts.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new ContactsController();

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

router.get('/', authMiddleware, requirePermission('contacts.view'), controller.list.bind(controller));
router.get('/tags', authMiddleware, requirePermission('contacts.view'), controller.tags.bind(controller));
router.get('/:id', authMiddleware, requirePermission('contacts.view'), controller.getOne.bind(controller));
router.post('/', authMiddleware, requirePermission('contacts.create'),
  [body('first_name').notEmpty().withMessage('First name is required')], handle, controller.create.bind(controller));
router.put('/:id', authMiddleware, requirePermission('contacts.edit'), controller.update.bind(controller));
router.delete('/:id', authMiddleware, requirePermission('contacts.delete'), controller.remove.bind(controller));

module.exports = router;