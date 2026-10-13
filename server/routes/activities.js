const express = require('express');
const { body, validationResult } = require('express-validator');
const { ActivitiesController } = require('../controllers/activities.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new ActivitiesController();

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

router.get('/', authMiddleware, requirePermission('activities.view'), controller.list.bind(controller));
// CRM-06 — activities had no delete verb, so a logged activity was permanent.
// The permission table has activities.view and activities.create but NO
// activities.delete. Inventing a code here would deny EVERY role (requirePermission
// fails closed on an unknown code), so this reuses the existing
// `activities.create` grant: whoever may log an activity may retract one, and no
// schema or role-grant change is needed. Introducing a dedicated
// `activities.delete` permission is the cleaner long-term answer and needs
// owner approval.
router.delete('/:id', authMiddleware, requirePermission('activities.create'), controller.remove.bind(controller));
router.post('/', authMiddleware, requirePermission('activities.create'),
  [body('type').notEmpty(), body('title').notEmpty()],
  handle, controller.create.bind(controller));

module.exports = router;