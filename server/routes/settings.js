const express = require('express');
const { SettingsController } = require('../controllers/settings.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

const router = express.Router();
const controller = new SettingsController();

router.get('/', authMiddleware, requirePermission('settings.view'), controller.get.bind(controller));
router.put('/', authMiddleware, requirePermission('settings.manage'), controller.update.bind(controller));
router.post('/reset-crm-data', authMiddleware, requirePermission('settings.manage'), controller.resetCrmData.bind(controller));

module.exports = router;
