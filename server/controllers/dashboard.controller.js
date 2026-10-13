const { getConn } = require('../utils/db');
const { successResponse } = require('../utils/response');

class DashboardController {
  constructor() {
    this.conn = getConn();
  }

  async getMetrics(req, res, next) {
    try {
      const cId = req.user.companyId;
      const period = parseInt(req.query.period || '30', 10);

      const now = new Date();
      const endDate = now.toISOString().split('T')[0];
      const startDate = new Date(now.getTime() - period * 86400000).toISOString().split('T')[0];
      const prevStartDate = new Date(now.getTime() - (period * 2) * 86400000).toISOString().split('T')[0];
      const prevEndDate = startDate;

      const won = this.conn.get(
        `SELECT COALESCE(SUM(value), 0) as total, COUNT(*) as count
         FROM deals WHERE company_id = ? AND status = 'WON'
         AND actual_close_date >= ? AND actual_close_date <= ?`,
        [cId, startDate, endDate]
      );

      const wonPrev = this.conn.get(
        `SELECT COALESCE(SUM(value), 0) as total, COUNT(*) as count
         FROM deals WHERE company_id = ? AND status = 'WON'
         AND actual_close_date >= ? AND actual_close_date <= ?`,
        [cId, prevStartDate, prevEndDate]
      );

      const active = this.conn.get(
        `SELECT COUNT(*) as count FROM deals WHERE company_id = ? AND status = 'OPEN'`,
        [cId]
      );

      const tasksDue = this.conn.get(
        `SELECT COUNT(*) as c FROM tasks WHERE company_id = ? AND status != 'COMPLETED'`,
        [cId]
      );

      const newLeads = this.conn.get(
        `SELECT COUNT(*) as c FROM leads WHERE company_id = ? AND lead_status = 'NEW'`,
        [cId]
      );

      const qualifiedLeads = this.conn.get(
        `SELECT COUNT(*) as c FROM leads WHERE company_id = ? AND lead_status = 'QUALIFIED'`,
        [cId]
      );

      const customers = this.conn.get(
        `SELECT COUNT(*) as c FROM customers WHERE company_id = ?`,
        [cId]
      );

      const appointments = this.conn.get(
        `SELECT COUNT(*) as c FROM appointments WHERE company_id = ? AND outcome IS NULL AND start_time >= datetime('now')`,
        [cId]
      );

      const pipeline = this.conn.all(
        `SELECT ps.name as stage, COALESCE(SUM(d.value), 0) as value
         FROM deals d
         JOIN pipeline_stages ps ON ps.id = d.stage_id
         WHERE d.company_id = ? AND d.status = 'OPEN'
         GROUP BY ps.id, ps.name
         ORDER BY ps.stage_order`,
        [cId]
      );

      const revenueTrend = this.conn.all(
        `SELECT date(actual_close_date) as label, COALESCE(SUM(value), 0) as value
         FROM deals WHERE company_id = ? AND status = 'WON'
         AND actual_close_date IS NOT NULL
         AND actual_close_date >= ? AND actual_close_date <= ?
         GROUP BY date(actual_close_date)
         ORDER BY label`,
        [cId, startDate, endDate]
      );

      const recentActivity = this.conn.all(
        `SELECT a.id, a.type, a.title, a.created_at as createdAt,
                c.first_name || ' ' || c.last_name as contactName,
                d.title as dealTitle
         FROM activities a
         LEFT JOIN contacts c ON c.id = a.contact_id
         LEFT JOIN deals d ON d.id = a.deal_id
         WHERE a.company_id = ?
         ORDER BY a.created_at DESC LIMIT 10`,
        [cId]
      );

      const teamPerformance = [];

      const revenueChange = wonPrev.total > 0
        ? ((won.total - wonPrev.total) / wonPrev.total) * 100
        : 0;
      const dealsWonChange = wonPrev.count > 0
        ? ((won.count - wonPrev.count) / wonPrev.count) * 100
        : 0;

      res.json(successResponse({
        revenue: won.total || 0,
        revenueChange: parseFloat(revenueChange.toFixed(1)),
        dealsWon: won.count || 0,
        dealsWonChange: parseFloat(dealsWonChange.toFixed(1)),
        activeDeals: active?.count || 0,
        activeDealsChange: 0,
        tasksDue: tasksDue?.c || 0,
        newLeads: newLeads?.c || 0,
        qualifiedLeads: qualifiedLeads?.c || 0,
        customers: customers?.c || 0,
        appointments: appointments?.c || 0,
        revenueTrend,
        pipeline,
        recentActivity,
        teamPerformance
      }));
    } catch (err) {
      next(err);
    }
  }
}

module.exports = { DashboardController };
