const { Authorizer } = require('../auth/authorizer');
const { DealRepository } = require('../repositories/deal.repository');
const { TaskRepository } = require('../repositories/task.repository');
const { InvoiceRepository } = require('../repositories/invoice.repository');
const { PaymentRepository } = require('../repositories/payment.repository');
const { ActivityRepository } = require('../repositories/activity.repository');

class DashboardService {
  constructor(conn) {
    this.conn = conn;
    this.dealRepo = new DealRepository(conn);
    this.taskRepo = new TaskRepository(conn);
    this.invoiceRepo = new InvoiceRepository(conn);
    this.paymentRepo = new PaymentRepository(conn);
    this.activityRepo = new ActivityRepository(conn);
  }

  async getMetrics(context) {
    Authorizer.assertPermission(context, 'reports.view');
    const companyId = context.companyId;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const today = now.toISOString().split('T')[0];

    const revenueRow = this.paymentRepo.totalForPeriod(companyId, startOfMonth, today);
    const dealsWon = this.dealRepo.wonTotal(companyId, startOfMonth, today);

    const activeDealsRow = this.conn.get(
      `SELECT COUNT(*) AS count, COALESCE(SUM(value), 0) AS value FROM deals WHERE company_id = ? AND status = 'OPEN';`,
      [companyId]
    );

    const tasksDue = this.taskRepo.dueToday(companyId, context.userId);
    const tasksOverdue = this.taskRepo.overdue(companyId, context.userId);

    const recentActivities = this.activityRepo.recent(companyId, 10);

    const pipelineByStage = this.dealRepo.statsByStage(companyId);

    const invoicesRow = this.invoiceRepo.totalsForPeriod(companyId, startOfMonth, today);

    return {
      revenue: {
        count: revenueRow.count || 0,
        period: { from: startOfMonth, to: today }
      },
      accounting: {
        total_receivables: this._getTotalReceivables(companyId),
        total_payables: this._getTotalPayables(companyId),
        net_profit: this._getNetProfit(companyId, startOfMonth, today)
      },
      dealsWon: {
        count: dealsWon.count || 0,
        total: dealsWon.total || 0,
        period: { from: startOfMonth, to: today }
      },
      activeDeals: {
        count: activeDealsRow?.count || 0,
        value: activeDealsRow?.value || 0
      },
      tasks: {
        dueCount: tasksDue.length,
        overdueCount: tasksOverdue.length,
        due: tasksDue,
        overdue: tasksOverdue
      },
      invoices: invoicesRow,
      pipelineByStage,
      recentActivities
    };
  }

  _getTotalReceivables(companyId) {
    const row = this.conn.get(
      'SELECT COALESCE(SUM(outstanding_amount), 0) as total FROM receivables WHERE company_id = ? AND status NOT IN (\'PAID\', \'WRITTEN_OFF\')',
      [companyId]
    );
    return row?.total || 0;
  }

  _getTotalPayables(companyId) {
    const row = this.conn.get(
      'SELECT COALESCE(SUM(outstanding_amount), 0) as total FROM payables WHERE company_id = ? AND status NOT IN (\'PAID\', \'CANCELLED\')',
      [companyId]
    );
    return row?.total || 0;
  }

  _getNetProfit(companyId, startDate, endDate) {
    const params = [companyId];
    let dateClause = '';
    if (startDate) { dateClause += ' AND je.entry_date >= ?'; params.push(startDate); }
    if (endDate) { dateClause += ' AND je.entry_date <= ?'; params.push(endDate); }

    const revenue = this.conn.get(
      `SELECT COALESCE(SUM(CASE WHEN a.debit_credit_nature = 'CREDIT'
        THEN COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0)
        ELSE COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)
        END), 0) AS total
       FROM accounts a
       LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
       LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'POSTED'${dateClause}
       WHERE a.company_id = ? AND a.type = 'INCOME'`,
      [...params, companyId]
    );

    const expenses = this.conn.get(
      `SELECT COALESCE(SUM(CASE WHEN a.debit_credit_nature = 'DEBIT'
        THEN COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)
        ELSE COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0)
        END), 0) AS total
       FROM accounts a
       LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
       LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'POSTED'${dateClause}
       WHERE a.company_id = ? AND a.type = 'EXPENSE'`,
      [...params, companyId]
    );

    return (parseFloat(revenue?.total || 0)) - (parseFloat(expenses?.total || 0));
  }
}

module.exports = { DashboardService };