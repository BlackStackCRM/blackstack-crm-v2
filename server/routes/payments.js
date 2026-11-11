const express = require('express');
const { body, validationResult } = require('express-validator');
const { PaymentController } = require('../controllers/payment.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { errorResponse } = require('../utils/response');
const crypto = require('crypto');
const { getConn } = require('../utils/db');
const { WalletSubscriptionService } = require('../services/walletSubscription.service');
const { snakeToCamel } = require('../utils/caseConverter');

const router = express.Router();
const controller = new PaymentController();

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

// Provider callback: verify the HMAC against the exact raw request body before
// processing. Configure PAYMENT_WEBHOOK_SECRET with the provider's signing key.
router.post('/webhook', (req, res, next) => {
  try {
    const secret = process.env.PAYMENT_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json(errorResponse('PAYMENT_WEBHOOK_NOT_CONFIGURED', 'Payment webhook is not configured.'));
    const supplied = String(req.get('x-provider-signature') || '').replace(/^sha256=/i, '').toLowerCase();
    if (!req.rawBody || !/^[a-f0-9]{64}$/.test(supplied)) {
      return res.status(401).json(errorResponse('INVALID_PAYMENT_SIGNATURE', 'Payment signature is invalid.'));
    }
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest();
    const actual = Buffer.from(supplied, 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return res.status(401).json(errorResponse('INVALID_PAYMENT_SIGNATURE', 'Payment signature is invalid.'));
    }
    const payload = snakeToCamel(req.body || {});
    const service = new WalletSubscriptionService(getConn());
    const result = String(payload.status || '').toLowerCase() === 'refunded'
      ? service.processProviderRefund(payload)
      : service.processProviderPayment(payload);
    return res.status(200).json({ success: true, data: result });
  } catch (error) { return next(error); }
});

router.get('/', authMiddleware, requirePermission('payments.view'), controller.list.bind(controller));
router.get('/:id', authMiddleware, requirePermission('payments.view'), controller.getOne.bind(controller));
router.post('/', authMiddleware, requirePermission('payments.create'),
  [body('invoice_id').notEmpty(), body('amount').isFloat({ gt: 0 }).withMessage('amount must be greater than 0')],
  handle, controller.create.bind(controller));
router.post('/:id/refund', authMiddleware, requirePermission('payments.refund'), controller.refund.bind(controller));

module.exports = router;
