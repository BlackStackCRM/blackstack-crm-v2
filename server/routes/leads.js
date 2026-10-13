const express = require('express');
const { body, validationResult } = require('express-validator');
const { LeadsController } = require('../controllers/leads.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new LeadsController();

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

router.get('/', authMiddleware, requirePermission('contacts.view'), controller.list.bind(controller));
router.get('/:id', authMiddleware, requirePermission('leads.view'), controller.getOne.bind(controller));
router.post('/', authMiddleware, requirePermission('contacts.create'),
  [body('contact_id').notEmpty(), handle], controller.create.bind(controller));
router.put('/:id', authMiddleware, requirePermission('contacts.edit'), controller.update.bind(controller));
router.delete('/:id', authMiddleware, requirePermission('contacts.delete'), controller.remove.bind(controller));
router.post('/:id/convert', authMiddleware, requirePermission('deals.create'), controller.convertToOpportunity.bind(controller));

module.exports = router;
