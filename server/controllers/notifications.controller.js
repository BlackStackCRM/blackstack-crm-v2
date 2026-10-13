const { getConn } = require('../utils/db');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');
const { NotificationRepository } = require('../repositories/notification.repository');

class NotificationsController {
  constructor() {
    this.conn = getConn();
    this.repo = new NotificationRepository(this.conn);
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req);
      const { is_read, type } = req.query;
      const result = await this.repo.search({
        companyId: req.user.companyId,
        userId: req.user.userId,
        isRead: is_read !== undefined ? is_read === 'true' : undefined,
        type,
        limit,
        offset
      });
      res.json(paginatedResponse(result.items, result.total, page, limit));
    } catch (err) { next(err); }
  }

  async unreadCount(req, res, next) {
    try {
      const count = await this.repo.unreadCount(req.user.companyId, req.user.userId);
      res.json(successResponse({ count }));
    } catch (err) { next(err); }
  }

  async markRead(req, res, next) {
    try {
      await this.repo.markRead(req.params.id, req.user.companyId);
      res.json(successResponse({ success: true }));
    } catch (err) { next(err); }
  }

  async markAllRead(req, res, next) {
    try {
      await this.repo.markAllRead(req.user.companyId, req.user.userId);
      res.json(successResponse({ success: true }));
    } catch (err) { next(err); }
  }
}

module.exports = { NotificationsController };
