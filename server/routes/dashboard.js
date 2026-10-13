const { requirePermission } = require('../middleware/rbac');
const express = require('express');
const { DashboardController } = require('../controllers/dashboard.controller');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const controller = new DashboardController();

router.get('/metrics', authMiddleware, requirePermission('dashboard.view'), controller.getMetrics.bind(controller));
// Frontend calls /dashboard/summary — keep it as an alias of metrics.
router.get('/summary', authMiddleware, requirePermission('dashboard.view'), controller.getMetrics.bind(controller));

module.exports = router;