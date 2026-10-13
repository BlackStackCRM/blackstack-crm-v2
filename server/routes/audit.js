const express = require('express');
const { AuditController } = require('../controllers/audit.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

const router = express.Router();
const controller = new AuditController();

router.get('/', authMiddleware, requirePermission('audit.view'), controller.list.bind(controller));
router.get('/:entity_type/:id', authMiddleware, requirePermission('audit.view'), controller.entity.bind(controller));

module.exports = router;