const { getConn } = require('../utils/db');
const { AIService } = require('../services/ai.service');
const { successResponse } = require('../utils/response');

class AIController {
  constructor() {
    this.conn = getConn();
    this.ai = new AIService();
  }

  async getLeadRecommendations(req, res, next) {
    try {
      const result = await this.ai.getLeadRecommendations(req.user.companyId, req.params.id);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async getDealRecommendations(req, res, next) {
    try {
      const result = await this.ai.getDealRecommendations(req.user.companyId, req.params.id);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async getActionCenter(req, res, next) {
    try {
      const result = await this.ai.getActionCenter(req.user.companyId, req.user.userId);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }
}

module.exports = { AIController };
