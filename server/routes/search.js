const { requirePermission } = require('../middleware/rbac');
const express = require('express');
const { SearchController } = require('../controllers/search.controller');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const controller = new SearchController();

router.get('/', authMiddleware, requirePermission('search.view'), controller.search.bind(controller));

module.exports = router;