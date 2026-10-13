const { PaymentService } = require('../services/payment.service');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');

class PaymentController {
  constructor() {
    const { getConnection } = require('../utils/db');
    const { PaymentService } = require('../services/payment.service');
    this.service = new PaymentService(getConnection());
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req);
      const result = await this.service.list(req.user, {
        ...req.query,
        limit,
        offset
      });
      res.json(paginatedResponse(result.items, result.total, page, limit));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      const item = await this.service.get(req.params.id, req.user);
      res.json(successResponse(item));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      // Never trust client-supplied identity/tenancy fields.
      const { id, company_id, created_by, ...body } = req.body;
      const item = await this.service.create(body, req.user);
      res.status(201).json(successResponse(item, 201));
    } catch (err) { next(err); }
  }

  async refund(req, res, next) {
    try {
      const result = await this.service.refund(req.params.id, req.user);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }
}

module.exports = { PaymentController };
