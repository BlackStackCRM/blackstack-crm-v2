const { AccountingBaseRepository } = require('./accounting-base.repository');

class ReceivableRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'receivables');
  }

  search(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const company = this._company(options.companyId);
    const where = ['r.company_id = ?'];
    const params = [company];

    if (options.contactId) {
      where.push('r.contact_id = ?');
      params.push(options.contactId);
    }
    if (options.status) {
      where.push('r.status = ?');
      params.push(options.status);
    }
    if (options.overdue) {
      where.push('r.days_overdue > 0');
    }
    if (options.startDate) {
      where.push('r.bill_date >= ?');
      params.push(options.startDate);
    }
    if (options.endDate) {
      where.push('r.bill_date <= ?');
      params.push(options.endDate);
    }
    if (options.query) {
      const s = `%${options.query}%`;
      where.push('(SELECT c.first_name || \' \' || c.last_name FROM contacts c WHERE c.id = r.contact_id AND c.company_id = ?) LIKE ?');
      params.push(company, s);
    }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM ${this.tableName} r WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;

    const items = this.conn.all(`
      SELECT r.*, c.first_name, c.last_name, o.name as organization_name
      FROM ${this.tableName} r
      LEFT JOIN contacts c ON c.id = r.contact_id AND c.company_id = r.company_id
      LEFT JOIN organizations o ON o.id = r.organization_id AND o.company_id = r.company_id
      WHERE ${whereStr}
      ORDER BY r.due_date ASC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return { items, total };
  }

  getAgingSummary(companyId) {
    const company = this._company(companyId);
    return this.conn.get(`
      SELECT
        COALESCE(SUM(CASE WHEN days_overdue BETWEEN 0 AND 30 THEN outstanding_amount ELSE 0 END), 0) as aging_0_30,
        COALESCE(SUM(CASE WHEN days_overdue BETWEEN 31 AND 60 THEN outstanding_amount ELSE 0 END), 0) as aging_31_60,
        COALESCE(SUM(CASE WHEN days_overdue BETWEEN 61 AND 90 THEN outstanding_amount ELSE 0 END), 0) as aging_61_90,
        COALESCE(SUM(CASE WHEN days_overdue BETWEEN 91 AND 180 THEN outstanding_amount ELSE 0 END), 0) as aging_91_180,
        COALESCE(SUM(CASE WHEN days_overdue > 180 THEN outstanding_amount ELSE 0 END), 0) as aging_180_plus,
        COALESCE(SUM(CASE WHEN days_overdue > 0 THEN outstanding_amount ELSE 0 END), 0) as total_overdue,
        COALESCE(SUM(outstanding_amount), 0) as total_outstanding
      FROM ${this.tableName}
      WHERE company_id = ? AND status NOT IN ('PAID', 'WRITTEN_OFF')
    `, [company]);
  }

  getTotalOutstanding(companyId) {
    const result = this.conn.get(
      `SELECT COALESCE(SUM(outstanding_amount), 0) as total FROM ${this.tableName}
       WHERE company_id = ? AND status NOT IN ('PAID', 'WRITTEN_OFF')`,
      [this._company(companyId)]
    );
    return result?.total || 0;
  }

  recalcFromAllocations(billId, companyId) {
    const company = this._company(companyId);
    const bill = this.conn.get(
      'SELECT total, paid_amount FROM bills WHERE id = ? AND company_id = ?',
      [billId, company]
    );
    if (!bill) return null;

    const allocRow = this.conn.get(
      `SELECT COALESCE(SUM(amount), 0) as allocated
       FROM bill_allocations ba
       JOIN journal_entries je ON je.id = ba.journal_entry_id
       WHERE ba.bill_id = ? AND je.company_id = ? AND je.status = 'POSTED'`,
      [billId, company]
    );
    const paidAmount = parseFloat(allocRow?.allocated || 0);
    const total = parseFloat(bill.total || 0);
    const balance = Math.max(total - paidAmount, 0);

    const now = new Date().toISOString();
    this.conn.run(
      'UPDATE bills SET paid_amount = ?, balance = ?, updated_at = ? WHERE id = ? AND company_id = ?',
      [paidAmount, balance, now, billId, company]
    );

    const dueDate = this.conn.get('SELECT due_date FROM bills WHERE id = ?', [billId]);
    if (dueDate) {
      let status = 'CURRENT';
      if (balance <= 0) status = 'PAID';
      else if (balance < total) status = 'PARTIALLY_PAID';

      const daysOverdue = dueDate.due_date
        ? Math.floor((Date.now() - new Date(dueDate.due_date).getTime()) / (24 * 60 * 60 * 1000))
        : 0;

      if (daysOverdue > 0 && balance > 0) status = 'OVERDUE';
      else if (daysOverdue > 0 && daysOverdue <= 7) status = 'DUE_SOON';

      this.conn.run(
        `UPDATE receivables SET paid_amount = ?, outstanding_amount = ?, status = ?, days_overdue = ?, updated_at = ?
         WHERE bill_id = ? AND company_id = ?`,
        [paidAmount, balance, status, Math.max(daysOverdue, 0), now, billId, company]
      );
    }
    return { paid_amount: paidAmount, balance };
  }
}

class PayableRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'payables');
  }

  search(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const company = this._company(options.companyId);
    const where = ['p.company_id = ?'];
    const params = [company];

    if (options.organizationId) {
      where.push('p.organization_id = ?');
      params.push(options.organizationId);
    }
    if (options.status) {
      where.push('p.status = ?');
      params.push(options.status);
    }
    if (options.overdue) {
      where.push('p.days_overdue > 0');
    }
    if (options.startDate) {
      where.push('p.due_date >= ?');
      params.push(options.startDate);
    }
    if (options.endDate) {
      where.push('p.due_date <= ?');
      params.push(options.endDate);
    }
    if (options.query) {
      const s = `%${options.query}%`;
      where.push('(SELECT o.name FROM organizations o WHERE o.id = p.organization_id AND o.company_id = ?) LIKE ?');
      params.push(company, s);
    }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM ${this.tableName} p WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;

    const items = this.conn.all(`
      SELECT p.*, o.name as organization_name
      FROM ${this.tableName} p
      LEFT JOIN organizations o ON o.id = p.organization_id AND o.company_id = p.company_id
      WHERE ${whereStr}
      ORDER BY p.due_date ASC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return { items, total };
  }

  getAgingSummary(companyId) {
    const company = this._company(companyId);
    return this.conn.get(`
      SELECT
        COALESCE(SUM(CASE WHEN days_overdue BETWEEN 0 AND 30 THEN outstanding_amount ELSE 0 END), 0) as aging_0_30,
        COALESCE(SUM(CASE WHEN days_overdue BETWEEN 31 AND 60 THEN outstanding_amount ELSE 0 END), 0) as aging_31_60,
        COALESCE(SUM(CASE WHEN days_overdue BETWEEN 61 AND 90 THEN outstanding_amount ELSE 0 END), 0) as aging_61_90,
        COALESCE(SUM(CASE WHEN days_overdue BETWEEN 91 AND 180 THEN outstanding_amount ELSE 0 END), 0) as aging_91_180,
        COALESCE(SUM(CASE WHEN days_overdue > 180 THEN outstanding_amount ELSE 0 END), 0) as aging_180_plus,
        COALESCE(SUM(CASE WHEN days_overdue > 0 THEN outstanding_amount ELSE 0 END), 0) as total_overdue,
        COALESCE(SUM(outstanding_amount), 0) as total_outstanding
      FROM ${this.tableName}
      WHERE company_id = ? AND status NOT IN ('PAID', 'CANCELLED')
    `, [company]);
  }

  getTotalOutstanding(companyId) {
    const result = this.conn.get(
      `SELECT COALESCE(SUM(outstanding_amount), 0) as total FROM ${this.tableName}
       WHERE company_id = ? AND status NOT IN ('PAID', 'CANCELLED')`,
      [this._company(companyId)]
    );
    return result?.total || 0;
  }
}

module.exports = { ReceivableRepository, PayableRepository };
