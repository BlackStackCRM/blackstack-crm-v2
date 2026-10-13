const { requirePermission } = require('../middleware/rbac');
const express = require('express');
const { body, validationResult } = require('express-validator');
const { NotesController } = require('../controllers/notes.controller');
const { authMiddleware } = require('../middleware/auth');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new NotesController();

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

router.get('/', authMiddleware, requirePermission('notes.view'), controller.list.bind(controller));
router.get('/:id', authMiddleware, requirePermission('notes.view'), controller.getOne.bind(controller));
router.post('/', authMiddleware, requirePermission('notes.create'), [body('title').notEmpty()], handle, controller.create.bind(controller));
router.put('/:id', authMiddleware, requirePermission('notes.edit'), controller.update.bind(controller));
router.delete('/:id', authMiddleware, requirePermission('notes.delete'), controller.remove.bind(controller));

module.exports = router;