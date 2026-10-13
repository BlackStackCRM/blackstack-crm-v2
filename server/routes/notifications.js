const express = require('express');
const { NotificationsController } = require('../controllers/notifications.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new NotificationsController();

router.get('/', authMiddleware, requirePermission('notifications.view'), controller.list.bind(controller));
router.get('/unread-count', authMiddleware, requirePermission('notifications.view'), controller.unreadCount.bind(controller));
router.post('/:id/read', authMiddleware, requirePermission('notifications.edit'), controller.markRead.bind(controller));
router.post('/mark-all-read', authMiddleware, requirePermission('notifications.edit'), controller.markAllRead.bind(controller));

module.exports = router;
