const { BaseRepository } = require('./BaseRepository');

class InvoiceRepository extends BaseRepository {
  constructor(conn) {
    super(conn, 'invoices');
  }

  async search(options = {}) {
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    const where = ['company_id = ?'];
    const params = [options.companyId || 'default'];

    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.contactId) {
      where.push('contact_id = ?');
      params.push(options.contactId);
    }
    if (options.query) {
      where.push('(LOWER(invoice_number) LIKE ? OR LOWER(notes) LIKE ?)');
      params.push(`%${options.query.toLowerCase()}%`, `%${options.query.toLowerCase()}%`);
    }

    const whereStr = where.join(' AND ');
    const countSql = `SELECT COUNT(*) as total FROM invoices WHERE ${whereStr}`;
    const countRow = this.conn.get(countSql, params);
    const total = countRow?.total || 0;

    const listSql = `SELECT * FROM invoices WHERE ${whereStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const items = this.conn.all(listSql, [...params, limit, offset]);

    return { items, total };
  }

  async getWithLines(id, companyId) {
    const invoice = this.conn.get('SELECT * FROM invoices WHERE id = ? AND company_id = ? LIMIT 1', [id, companyId]);
    if (!invoice) return null;

    const lines = this.conn.all('SELECT * FROM invoice_line_items WHERE invoice_id = ?', [id]);
    return { ...invoice, lines };
  }

  async createInvoice(invoice, lines) {
    return this.conn.transaction(() => {
      this.conn.run(
        `INSERT INTO invoices (id, invoice_number, contact_id, organization_id, deal_id, currency, status, issue_date, due_date, subtotal, tax, discount, total, paid_amount, balance, notes, terms, company_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [invoice.id, invoice.invoice_number, invoice.contact_id, invoice.organization_id, invoice.deal_id, invoice.currency || 'USD', invoice.status, invoice.issue_date, invoice.due_date, invoice.subtotal, invoice.tax, invoice.discount, invoice.total, invoice.paid_amount, invoice.balance, invoice.notes, invoice.terms, invoice.company_id, invoice.created_at, invoice.updated_at]
      );

      for (const line of lines) {
        this.conn.run(
          `INSERT INTO invoice_line_items (id, invoice_id, product_id, description, quantity, unit_price, tax_rate, discount, total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [line.id, invoice.id, line.product_id, line.description, line.quantity, line.unit_price, line.tax_rate, line.discount, line.total, new Date().toISOString()]
        );
      }

      return invoice;
    })();
  }
}

module.exports = { InvoiceRepository };
