const { BaseRepository } = require('./BaseRepository');

class PaymentRepository extends BaseRepository {
  constructor(conn) {
    super(conn, 'payments');
  }

  async search(options = {}) {
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    const where = ['company_id = ?'];
    const params = [options.companyId || 'default'];

    if (options.invoiceId) {
      where.push('invoice_id = ?');
      params.push(options.invoiceId);
    }
    if (options.contactId) {
      where.push('contact_id = ?');
      params.push(options.contactId);
    }
    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.startDate) {
      where.push('payment_date >= ?');
      params.push(options.startDate);
    }
    if (options.endDate) {
      where.push('payment_date <= ?');
      params.push(options.endDate);
    }

    const whereStr = where.join(' AND ');
    const countSql = `SELECT COUNT(*) as total FROM payments WHERE ${whereStr}`;
    const countRow = this.conn.get(countSql, params);
    const total = countRow?.total || 0;

    const listSql = `SELECT * FROM payments WHERE ${whereStr} ORDER BY payment_date DESC LIMIT ? OFFSET ?`;
    const items = this.conn.all(listSql, [...params, limit, offset]);

    return { items, total };
  }

  async getTotalPaymentsForInvoice(invoiceId, companyId) {
    const result = this.conn.get(
      'SELECT SUM(amount) as total FROM payments WHERE invoice_id = ? AND company_id = ? AND status = ?',
      [invoiceId, companyId, 'COMPLETED']
    );
    return result?.total || 0;
  }
}

module.exports = { PaymentRepository };
