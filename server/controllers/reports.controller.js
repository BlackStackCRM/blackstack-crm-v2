const { getConn } = require('../utils/db');
const { successResponse } = require('../utils/response');

class ReportsController {
  constructor() {
    this.conn = getConn();
  }

  async revenue(req, res, next) {
    try {
      const { date_from, date_to, group_by = 'month' } = req.query;
      const where = ['status = ?', 'company_id = ?'];
      const params = ['WON', req.user.companyId];
      if (date_from) { where.push('actual_close_date >= ?'); params.push(date_from); }
      if (date_to) { where.push('actual_close_date <= ?'); params.push(date_to); }
      const whereSql = `WHERE ${where.join(' AND ')}`;

      const summary = this.conn.get(`
        SELECT COALESCE(SUM(value), 0) as total_revenue,
               COUNT(*) as deals_won,
               COALESCE(AVG(value), 0) as avg_deal_size
        FROM deals ${whereSql}
      `, params);

      const fmt = group_by === 'day' ? '%Y-%m-%d' : '%Y-%m';
      const series = this.conn.all(`
        SELECT strftime('${fmt}', actual_close_date) as period,
               SUM(value) as revenue,
               COUNT(*) as deal_count
        FROM deals ${whereSql}
        GROUP BY period
        ORDER BY period ASC
      `, params);

      res.json(successResponse({ summary, series, group_by }));
    } catch (err) { next(err); }
  }

  async sales(req, res, next) {
    try {
      const { date_from, date_to } = req.query;
      const where = ['company_id = ?'];
      const params = [req.user.companyId];
      if (date_from) { where.push('created_at >= ?'); params.push(date_from); }
      if (date_to) { where.push('created_at <= ?'); params.push(date_to); }
      const whereSql = `WHERE ${where.join(' AND ')}`;

      const byStatus = this.conn.all(`
        SELECT status, COUNT(*) as count, COALESCE(SUM(value), 0) as total_value
        FROM deals ${whereSql}
        GROUP BY status
      `, params);

      const pipeline = this.conn.get(`
        SELECT COUNT(*) as open_deals,
               COALESCE(SUM(value), 0) as pipeline_value,
               COALESCE(SUM(value * probability), 0) as weighted_value
        FROM deals ${whereSql} AND status = ?
      `, [...params, 'OPEN']);

      res.json(successResponse({ by_status: byStatus, pipeline }));
    } catch (err) { next(err); }
  }

  async pipeline(req, res, next) {
    try {
      const companyId = req.user.companyId;
      const stages = this.conn.all(`
        SELECT ps.id, ps.name, ps.stage_order, ps.probability, ps.color,
               COUNT(d.id) as deal_count,
               COALESCE(SUM(d.value), 0) as total_value,
               COALESCE(SUM(d.value * d.probability), 0) as weighted_value
        FROM pipeline_stages ps
        LEFT JOIN deals d ON d.stage_id = ps.id AND d.status = 'OPEN' AND d.company_id = ?
        GROUP BY ps.id
        ORDER BY ps.stage_order ASC
      `, [companyId]);

      res.json(successResponse({ stages }));
    } catch (err) { next(err); }
  }

  async team(req, res, next) {
    try {
      const { date_from, date_to } = req.query;
      const companyId = req.user.companyId;
      const where = ['t.company_id = ?'];
      const params = [companyId];
      if (date_from) { where.push('t.created_at >= ?'); params.push(date_from); }
      if (date_to) { where.push('t.created_at <= ?'); params.push(date_to); }
      const whereSql = `WHERE ${where.join(' AND ')}`;

      const tasks = this.conn.all(`
        SELECT u.id, u.full_name, u.email,
               COUNT(t.id) as total_tasks,
               SUM(CASE WHEN t.status = 'COMPLETED' THEN 1 ELSE 0 END) as completed_tasks
        FROM users u
        LEFT JOIN tasks t ON t.assigned_to = u.id AND u.company_id = ? ${whereSql.replace('WHERE ', ' AND ')}
        WHERE u.company_id = ?
        GROUP BY u.id
        ORDER BY completed_tasks DESC
      `, [...params, companyId, companyId]);

      const dealsWhere = ['d.company_id = ?'];
      const dealsParams = [companyId];
      if (date_from) { dealsWhere.push('d.created_at >= ?'); dealsParams.push(date_from); }
      if (date_to) { dealsWhere.push('d.created_at <= ?'); dealsParams.push(date_to); }
      const dealsWhereSql = `WHERE ${dealsWhere.join(' AND ')}`;

      const dealsByUser = this.conn.all(`
        SELECT a.user_id, u.full_name,
               COUNT(d.id) as deal_count,
               COALESCE(SUM(d.value), 0) as total_value,
               COALESCE(SUM(CASE WHEN d.status = 'WON' THEN d.value ELSE 0 END), 0) as won_value
        FROM deals d
        LEFT JOIN activities a ON a.deal_id = d.id
        LEFT JOIN users u ON u.id = a.user_id AND u.company_id = ?
        ${dealsWhereSql}
        GROUP BY a.user_id
        ORDER BY won_value DESC
      `, [...dealsParams, companyId]);

      res.json(successResponse({ tasks_summary: tasks, deals_summary: dealsByUser }));
    } catch (err) { next(err); }
  }
}

module.exports = { ReportsController };