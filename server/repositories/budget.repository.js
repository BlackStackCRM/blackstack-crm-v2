const { AccountingBaseRepository } = require('./accounting-base.repository');

class BudgetRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'budgets');
  }

  findWithLines(opts = {}) {
    const { companyId, limit = 50, page = 1 } = opts;
    const offset = (page - 1) * limit;
    const budgets = this.conn.all(
      'SELECT * FROM budgets WHERE company_id = ? ORDER BY name LIMIT ? OFFSET ?',
      [companyId, limit, offset]
    );
    const result = budgets.map(b => {
      const lines = this.conn.all(
        'SELECT * FROM budget_lines WHERE budget_id = ? AND company_id = ?',
        [b.id, companyId]
      );
      const totalBudget = lines.reduce((s, l) => s + (parseFloat(l.budget_amount) || 0), 0);
      const actualTotal = lines.reduce((s, l) => s + (parseFloat(l.actual_amount) || 0), 0);
      return { ...b, lines, _total_budget: totalBudget, _actual_total: actualTotal };
    });
    const countRow = this.conn.get('SELECT COUNT(*) as total FROM budgets WHERE company_id = ?', [companyId]);
    return { items: result, total: countRow?.total || 0 };
  }

  getByFinancialYear(fyId, companyId) {
    return this.conn.all(
      'SELECT * FROM budgets WHERE financial_year_id = ? AND company_id = ?',
      [fyId, companyId]
    );
  }

  getBudgetLines(budgetId, companyId) {
    return this.conn.all(
      'SELECT bl.*, a.code as account_code, a.name as account_name, cc.code as cost_centre_code, cc.name as cost_centre_name ' +
      'FROM budget_lines bl LEFT JOIN accounts a ON bl.account_id = a.id LEFT JOIN cost_centres cc ON bl.cost_centre_id = cc.id ' +
      'WHERE bl.budget_id = ? AND bl.company_id = ?',
      [budgetId, companyId]
    );
  }
}

module.exports = { BudgetRepository };
