const { InvoiceService } = require('../services/invoice.service');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');

class InvoiceController {
  constructor() {
    const { getConnection } = require('../utils/db');
    this.service = new InvoiceService(getConnection());
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req);
      const result = await this.service.list(req.user, { ...req.query, limit, offset });
      res.json(paginatedResponse(result.items, result.total, page, limit));
    } catch (err) { next(err); }
  }

  async get(req, res, next) {
    try {
      const item = await this.service.get(req.params.id, req.user);
      res.json(successResponse(item));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      // Never trust client-supplied identity/tenancy fields.
      const { id, company_id, paid_amount, balance, status, ...body } = req.body;
      const item = await this.service.create(body, req.user);
      res.status(201).json(successResponse(item, 201));
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      const { id, company_id, paid_amount, balance, ...body } = req.body;
      const item = await this.service.update(req.params.id, body, req.user);
      res.json(successResponse(item));
    } catch (err) { next(err); }
  }

  async remove(req, res, next) {
    try {
      const result = await this.service.remove(req.params.id, req.user);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async markPaid(req, res, next) {
    try {
      const result = await this.service.markPaid(req.params.id, req.user);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }
}

module.exports = { InvoiceController };
