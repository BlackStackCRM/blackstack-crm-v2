const express = require('express');
const { body, validationResult } = require('express-validator');
const { InvoiceController } = require('../controllers/invoice.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new InvoiceController();

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

router.get('/', authMiddleware, requirePermission('invoices.view'), controller.list.bind(controller));
router.get('/:id', authMiddleware, requirePermission('invoices.view'), controller.get.bind(controller));
router.post('/', authMiddleware, requirePermission('invoices.create'),
  [body('contact_id').notEmpty()], handle, controller.create.bind(controller));
router.put('/:id', authMiddleware, requirePermission('invoices.edit'), controller.update.bind(controller));
router.delete('/:id', authMiddleware, requirePermission('invoices.delete'), controller.remove.bind(controller));
router.post('/:id/mark-paid', authMiddleware, requirePermission('invoices.edit'), controller.markPaid.bind(controller));

module.exports = router;