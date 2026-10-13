const express = require('express');
const { body, validationResult } = require('express-validator');
const { PaymentController } = require('../controllers/payment.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new PaymentController();

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

router.get('/', authMiddleware, requirePermission('payments.view'), controller.list.bind(controller));
router.get('/:id', authMiddleware, requirePermission('payments.view'), controller.getOne.bind(controller));
router.post('/', authMiddleware, requirePermission('payments.create'),
  [body('invoice_id').notEmpty(), body('amount').isFloat({ gt: 0 }).withMessage('amount must be greater than 0')],
  handle, controller.create.bind(controller));
router.post('/:id/refund', authMiddleware, requirePermission('payments.refund'), controller.refund.bind(controller));

module.exports = router;