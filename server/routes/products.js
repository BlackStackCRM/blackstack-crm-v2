const express = require('express');
const { body, validationResult } = require('express-validator');
const { ProductsController } = require('../controllers/products.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new ProductsController();

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

router.get('/', authMiddleware, requirePermission('products.view'), controller.list.bind(controller));
router.get('/:id', authMiddleware, requirePermission('products.view'), controller.getOne.bind(controller));
router.post('/', authMiddleware, requirePermission('products.create'),
  [body('name').notEmpty()], handle, controller.create.bind(controller));
router.put('/:id', authMiddleware, requirePermission('products.edit'), controller.update.bind(controller));
router.delete('/:id', authMiddleware, requirePermission('products.delete'), controller.remove.bind(controller));

module.exports = router;
