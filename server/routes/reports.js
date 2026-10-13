const express = require('express');
const { ReportsController } = require('../controllers/reports.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

const router = express.Router();
const controller = new ReportsController();

const auth = [authMiddleware, requirePermission('reports.view')];

router.get('/revenue', ...auth, controller.revenue.bind(controller));
router.get('/sales', ...auth, controller.sales.bind(controller));
router.get('/pipeline', ...auth, controller.pipeline.bind(controller));
router.get('/team', ...auth, controller.team.bind(controller));

module.exports = router;