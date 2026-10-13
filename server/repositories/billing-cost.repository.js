const { AccountingBaseRepository } = require('./accounting-base.repository');
const { generateId } = require('../utils/generateId');

class BillRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'bills');
  }

  search(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const companyId = this._company(options.companyId);
    const where = ['company_id = ?'];
    const params = [companyId];

    if (options.billType || options.type) {
      where.push('bill_type = ?');
      params.push(options.billType || options.type);
    }
    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.contactId) {
      where.push('contact_id = ?');
      params.push(options.contactId);
    }
    if (options.dealId) {
      where.push('deal_id = ?');
      params.push(options.dealId);
    }
    if (options.startDate) {
      where.push('issue_date >= ?');
      params.push(options.startDate);
    }
    if (options.endDate) {
      where.push('issue_date <= ?');
      params.push(options.endDate);
    }
    if (options.query) {
      const s = `%${options.query}%`;
      where.push('(bill_number LIKE ? OR reference_number LIKE ? OR notes LIKE ?)');
      params.push(s, s, s);
    }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM ${this.tableName} WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;
    const items = this.conn.all(
      `SELECT * FROM ${this.tableName} WHERE ${whereStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { items, total };
  }

  getWithItems(id, companyId) {
    const bill = this.findById(id, companyId);
    if (!bill) return null;
    const items = this.conn.all(
      'SELECT bi.*, p.name as product_name, a.code as gl_code, a.name as gl_name FROM bill_items bi LEFT JOIN products p ON p.id = bi.product_id LEFT JOIN accounts a ON a.id = bi.gl_account_id WHERE bill_id = ?',
      [id]
    );
    return { ...bill, items: items || [] };
  }

  getByNumber(billNumber, companyId) {
    return this.conn.get(
      `SELECT * FROM ${this.tableName} WHERE bill_number = ? AND company_id = ? LIMIT 1`,
      [billNumber, this._company(companyId)]
    );
  }

  getNextBillNumber(companyId) {
    const company = this._company(companyId);
    const last = this.conn.get(
      `SELECT bill_number FROM ${this.tableName}
       WHERE bill_number LIKE 'BILL-%' AND company_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      [company]
    );
    if (!last) return 'BILL-0001';
    const match = last.bill_number.match(/^BILL-(\d+)$/);
    const seq = match ? parseInt(match[1], 10) + 1 : 1;
    return `BILL-${String(seq).padStart(4, '0')}`;
  }

  createBill(bill, lines) {
    return this.conn.transaction(() => {
      const now = new Date().toISOString();
      // `bill_date` is the API-level alias for the `bills.issue_date` column.
      // Strip it (and any other non-column keys) before building the INSERT.
      const { bill_date: _billDate, ...billCols } = bill;
      const validCols = new Set(
        this.conn.all("SELECT name FROM pragma_table_info('bills')").map((c) => c.name)
      );
      for (const k of Object.keys(billCols)) {
        if (!validCols.has(k)) delete billCols[k];
      }
      const allCols = Object.keys(billCols);
      const placeholders = allCols.map(() => '?,').join('');
      const sql = `INSERT INTO bills (${allCols.join(',')}) VALUES (${placeholders.slice(0,-1)})`;
      this.conn.run(sql, allCols.map(k => billCols[k]));

      // Create receivable or payable record for the bill
      if (bill.bill_type === 'CUSTOMER') {
        this.conn.run(`INSERT INTO receivables (id, company_id, bill_id, contact_id, organization_id, deal_id, due_date, original_amount, paid_amount, outstanding_amount, currency, status, days_overdue, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
          [generateId('rec'), bill.company_id, bill.id, bill.contact_id, bill.organization_id || null, bill.deal_id || null, bill.due_date, bill.total, bill.paid_amount || 0, bill.total, bill.currency || 'USD',  'CURRENT', 0]);
      }

      for (const line of lines) {
        const lineObj = { ...line };
        if (!lineObj.id) lineObj.id = generateId('bill_item');
        // `amount` is the API-level alias for the `bill_items.total` column.
        if (lineObj.amount !== undefined && lineObj.total === undefined) {
          lineObj.total = lineObj.amount;
        }
        if (!lineObj.bill_id) {
          lineObj.bill_id = bill.id;
        }
        // Drop any keys that are not actual bill_items columns.
        const itemValidCols = new Set(
          this.conn.all("SELECT name FROM pragma_table_info('bill_items')").map((c) => c.name)
        );
        for (const k of Object.keys(lineObj)) {
          if (!itemValidCols.has(k)) delete lineObj[k];
        }
        const lineCols = Object.keys(lineObj);
        const linePlaceholders = lineCols.map(() => '?,').join('');
        const lineSql = `INSERT INTO bill_items (${lineCols.join(',')}) VALUES (${linePlaceholders.slice(0,-1)})`;
        this.conn.run(lineSql, lineCols.map(k => lineObj[k] || null));
      }
      return { ...bill, lines: lines || [] };
    })();
  }

  // Alias for controller use
  createWithItems(bill, items) {
    // If items are nested in the bill object, extract them
    const actualItems = items || bill.items || [];
    delete bill.items;
    return this.createBill(bill, actualItems);
  }
}

class CostCentreRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'cost_centres');
  }

  search(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const companyId = this._company(options.companyId);
    const where = ['company_id = ?'];
    const params = [companyId];

    if (options.isActive !== undefined) {
      where.push('is_active = ?');
      params.push(options.isActive);
    }
    if (options.query) {
      const s = `%${options.query}%`;
      where.push('(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)');
      params.push(s, s);
    }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM ${this.tableName} WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;
    const items = this.conn.all(
      `SELECT * FROM ${this.tableName} WHERE ${whereStr} ORDER BY code ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { items, total };
  }
}

class CostCategoryRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'cost_categories');
  }

  search(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const companyId = this._company(options.companyId);
    const where = ['company_id = ?'];
    const params = [companyId];

    if (options.isActive !== undefined) {
      where.push('is_active = ?');
      params.push(options.isActive);
    }
    if (options.query) {
      const s = `%${options.query}%`;
      where.push('(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)');
      params.push(s, s);
    }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM ${this.tableName} WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;
    const items = this.conn.all(
      `SELECT * FROM ${this.tableName} WHERE ${whereStr} ORDER BY code ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { items, total };
  }
}

class BankAccountRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'bank_accounts');
  }

  search(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const companyId = this._company(options.companyId);
    const where = ['company_id = ?'];
    const params = [companyId];

    if (options.isActive !== undefined) {
      where.push('is_active = ?');
      params.push(options.isActive);
    }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM ${this.tableName} WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;
    const items = this.conn.all(
      `SELECT * FROM ${this.tableName} WHERE ${whereStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { items, total };
  }

  getByAccountNumber(accountNumber, companyId) {
    return this.conn.get(
      `SELECT * FROM ${this.tableName} WHERE account_number = ? AND company_id = ? LIMIT 1`,
      [accountNumber, this._company(companyId)]
    );
  }
}

class FinancialYearRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'financial_years');
  }

  search(options = {}) {
    const companyId = this._company(options.companyId);
    const where = ['company_id = ?'];
    const params = [companyId];

    if (options.isActive !== undefined) {
      where.push('is_active = ?');
      params.push(options.isActive);
    }

    const whereStr = where.join(' AND ');
    const items = this.conn.all(
      `SELECT * FROM ${this.tableName} WHERE ${whereStr} ORDER BY start_date DESC`,
      params
    );
    return { items, total: items.length };
  }

  getActive(companyId) {
    return this.conn.get(
      `SELECT * FROM ${this.tableName} WHERE company_id = ? AND is_active = 1 LIMIT 1`,
      [this._company(companyId)]
    );
  }

  getByDate(date, companyId) {
    return this.conn.get(
      `SELECT * FROM ${this.tableName} WHERE company_id = ? AND start_date <= ? AND end_date >= ? LIMIT 1`,
      [this._company(companyId), date, date]
    );
  }
}

class BudgetRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'budgets');
  }

  search(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const companyId = this._company(options.companyId);
    const where = ['company_id = ?'];
    const params = [companyId];

    if (options.isActive !== undefined) {
      where.push('is_active = ?');
      params.push(options.isActive);
    }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM ${this.tableName} WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;
    const items = this.conn.all(
      `SELECT * FROM ${this.tableName} WHERE ${whereStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { items, total };
  }

  getWithLines(id, companyId) {
    const budget = this.findById(id, companyId);
    if (!budget) return null;
    const lines = this.conn.all(
      `SELECT bl.*, a.code as account_code, a.name as account_name, cc.code as cost_centre_code, cc.name as cost_centre_name
       FROM budget_lines bl
       LEFT JOIN accounts a ON a.id = bl.account_id
       LEFT JOIN cost_centres cc ON cc.id = bl.cost_centre_id
       WHERE bl.budget_id = ? AND bl.company_id = ?`,
      [id, this._company(companyId)]
    );
    return { ...budget, lines: lines || [] };
  }
}

class CreditRuleRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'credit_rules');
  }

  getByContact(contactId, companyId) {
    return this.conn.get(
      `SELECT * FROM ${this.tableName} WHERE contact_id = ? AND company_id = ? LIMIT 1`,
      [contactId, this._company(companyId)]
    );
  }
}

class InterestConfigRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'interest_configs');
  }

  getActive(companyId) {
    return this.conn.get(
      `SELECT * FROM ${this.tableName} WHERE company_id = ? AND is_active = 1 LIMIT 1`,
      [this._company(companyId)]
    );
  }
}

module.exports = {
  BillRepository, CostCentreRepository, CostCategoryRepository, BankAccountRepository,
  FinancialYearRepository, BudgetRepository, CreditRuleRepository, InterestConfigRepository
};
