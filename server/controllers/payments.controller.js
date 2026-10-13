const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');
const { validateCurrency } = require('../utils/currency');

class PaymentsController {
  constructor() {
    this.conn = getConn();
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req);
      const { status, invoice_id, contact_id, payment_method, date_from, date_to } = req.query;

      const where = ['p.company_id = ?'];
      const params = [req.user.companyId];
      if (status) { where.push('p.status = ?'); params.push(status); }
      if (invoice_id) { where.push('p.invoice_id = ?'); params.push(invoice_id); }
      if (contact_id) { where.push('p.contact_id = ?'); params.push(contact_id); }
      if (payment_method) { where.push('p.payment_method = ?'); params.push(payment_method); }
      if (date_from) { where.push('p.payment_date >= ?'); params.push(date_from); }
      if (date_to) { where.push('p.payment_date <= ?'); params.push(date_to); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const items = this.conn.all(
        `SELECT p.* FROM payments p ${whereSql} ORDER BY p.payment_date DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      const total = this.conn.get(`SELECT COUNT(*) as total FROM payments p ${whereSql}`, params).total;
      res.json(paginatedResponse(items, total, page, limit));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      const item = this.conn.get('SELECT * FROM payments WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!item) throw new NotFoundError('Payment', req.params.id);
      res.json(successResponse(item));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const { invoice_id, contact_id, amount, currency, payment_method, reference_number, notes, payment_date, status } = req.body;
      if (!invoice_id) throw new ValidationError('invoice_id is required');
      if (!contact_id) throw new ValidationError('contact_id is required');
      if (amount === undefined || amount <= 0) throw new ValidationError('amount must be greater than 0');

      const invoice = this.conn.get('SELECT id, total, paid_amount, balance, currency FROM invoices WHERE id = ? AND company_id = ?', [invoice_id, req.user.companyId]);
      if (!invoice) throw new NotFoundError('Invoice', invoice_id);

      const id = req.body.id || generateId('pay');
      const now = new Date().toISOString();
      const date = payment_date || now.slice(0, 10);
      const payStatus = status || 'COMPLETED';
      const paymentCurrency = validateCurrency(currency || invoice.currency || 'USD');

      this.conn.transaction(() => {
        this.conn.run(
          'INSERT INTO payments (id, invoice_id, contact_id, amount, currency, payment_method, status, reference_number, notes, payment_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, invoice_id, contact_id, amount, paymentCurrency, payment_method || 'OTHER', payStatus, reference_number, notes || null, date, now, now]
        );

        if (payStatus === 'COMPLETED') {
          const newPaid = (invoice.paid_amount || 0) + amount;
          const newBalance = Math.max((invoice.total || 0) - newPaid, 0);
          const newStatus = newBalance <= 0 ? 'PAID' : 'PARTIALLY_PAID';
          this.conn.run('UPDATE invoices SET paid_amount = ?, balance = ?, status = ?, updated_at = ? WHERE id = ? AND company_id = ?',
            [newPaid, newBalance, newStatus, now, invoice_id, req.user.companyId]);
        }
      })();

      res.status(201).json(successResponse(this.conn.get('SELECT * FROM payments WHERE id = ? AND company_id = ?', [id, req.user.companyId]), 201));
    } catch (err) { next(err); }
  }

  async refund(req, res, next) {
    try {
      const payment = this.conn.get('SELECT * FROM payments WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!payment) throw new NotFoundError('Payment', req.params.id);
      if (payment.status === 'REFUNDED') throw new ValidationError('Payment already refunded');

      const refundAmount = req.body.amount !== undefined ? req.body.amount : payment.amount;
      const now = new Date().toISOString();
      this.conn.run('UPDATE payments SET status = ?, notes = COALESCE(notes, \'\') || ?, updated_at = ? WHERE id = ? AND company_id = ?',
        ['REFUNDED', `Refunded ${refundAmount} on ${now}`, now, req.params.id, req.user.companyId]);

      const invoice = this.conn.get('SELECT id, total, paid_amount FROM invoices WHERE id = ? AND company_id = ?', [payment.invoice_id, req.user.companyId]);
      if (invoice) {
        const newPaid = Math.max((invoice.paid_amount || 0) - refundAmount, 0);
        const newBalance = (invoice.total || 0) - newPaid;
        const newStatus = newPaid <= 0 ? 'SENT' : 'PARTIALLY_PAID';
        this.conn.run('UPDATE invoices SET paid_amount = ?, balance = ?, status = ?, updated_at = ? WHERE id = ? AND company_id = ?',
          [newPaid, newBalance, newStatus, now, invoice.id, req.user.companyId]);
      }

      res.json(successResponse(this.conn.get('SELECT * FROM payments WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId])));
    } catch (err) { next(err); }
  }
}

module.exports = { PaymentsController };
