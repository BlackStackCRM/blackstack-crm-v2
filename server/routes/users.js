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
router.get('/:id', authMiddleware, requirePermission('users.view'), controller.getOne.bind(controller));
router.post('/', authMiddleware, requirePermission('users.manage'),
  [body('email').isEmail(), body('full_name').notEmpty(), body('password').isLength({ min: 8 })],
  handle, controller.create.bind(controller));
router.put('/:id', authMiddleware, requirePermission('users.manage'), controller.update.bind(controller));
router.delete('/:id/permanent', authMiddleware, requirePermission('users.manage'), async (req, res, next) => {
  try {
    const conn = require('../utils/db').getConn();
    const link = conn.get('SELECT id FROM agency_administrators WHERE user_id = ?', [req.params.id]);
    if (!link) return res.status(404).json(errorResponse('NOT_FOUND', 'Agency administrator was not found.'));
    const { AgencyControlService } = require('../services/agencyControl.service');
    const result = await new AgencyControlService(conn).permanentlyDeleteAdministrator(req.user.userId, link.id);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});
router.delete('/:id', authMiddleware, requirePermission('users.manage'), controller.remove.bind(controller));

module.exports = router;
