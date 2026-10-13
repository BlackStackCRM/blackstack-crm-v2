const { requirePermission } = require('../middleware/rbac');
const express = require('express');
const { body, validationResult } = require('express-validator');
const { RelationshipsController } = require('../controllers/relationships.controller');
const { authMiddleware } = require('../middleware/auth');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new RelationshipsController();

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

router.get('/', authMiddleware, requirePermission('relationships.view'), controller.list.bind(controller));
router.post('/', authMiddleware, requirePermission('relationships.create'),
  [body('relationship_type').notEmpty(), body('person_a_id').notEmpty()],
  handle, controller.create.bind(controller));
router.delete('/:id', authMiddleware, requirePermission('relationships.delete'), controller.remove.bind(controller));

module.exports = router;