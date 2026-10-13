const express = require('express');
const { AIController } = require('../controllers/ai.controller');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const controller = new AIController();

router.get('/leads/:id/recommendations', authMiddleware, controller.getLeadRecommendations.bind(controller));
router.get('/deals/:id/recommendations', authMiddleware, controller.getDealRecommendations.bind(controller));
router.get('/action-center', authMiddleware, controller.getActionCenter.bind(controller));

module.exports = router;
