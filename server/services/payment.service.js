const { PaymentRepository } = require('../repositories/payment.repository');
const { InvoiceRepository } = require('../repositories/invoice.repository');
const { Authorizer } = require('../auth/authorizer');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { validateCurrency } = require('../utils/currency');

class PaymentService {
  constructor(conn) {
    this.conn = conn;
  }

  async list(context, query = {}) {
    const repo = new PaymentRepository(this.conn);
    Authorizer.assertPermission(context, 'payments.view');

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 20;
    const offset = (page - 1) * limit;

    const result = await repo.search({
      companyId: context.companyId,
      invoiceId: query.invoiceId,
      contactId: query.contactId,
      status: query.status,
      startDate: query.startDate,
      endDate: query.endDate,
      limit,
      offset
    });

    return { items: result.items, total: result.total };
  }

  async get(id, context) {
    const repo = new PaymentRepository(this.conn);
    Authorizer.assertPermission(context, 'payments.view');

    const item = await repo.findById(id, context.companyId);
    if (!item) throw new NotFoundError('Payment', id);
    return item;
  }

  /**
   * Canonical invoice payment calculation — the ONLY place financial state
   * is derived. paid_amount = SUM(completed payments); balance = max(total - paid, 0).
   */
  _recalculateInvoice(invoiceId, companyId) {
    const invoice = this.conn.get(
      'SELECT id, total, paid_amount, status FROM invoices WHERE id = ? AND company_id = ?',
      [invoiceId, companyId]
    );
    if (!invoice) return null;
    const paidRow = this.conn.get(
      `SELECT COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN amount ELSE 0 END), 0) AS paid
       FROM payments WHERE invoice_id = ? AND company_id = ?`,
      [invoiceId, companyId]
    );
    const paid_amount = Math.max(parseFloat(paidRow.paid) || 0, 0);
    const total = parseFloat(invoice.total) || 0;
    const balance = Math.max(total - paid_amount, 0);
    let status = invoice.status;
    if (paid_amount <= 0) {
      if (status === 'PAID' || status === 'PARTIALLY_PAID') status = 'SENT';
    } else if (balance <= 0) {
      status = 'PAID';
    } else {
      status = 'PARTIALLY_PAID';
    }
    this.conn.run(
      'UPDATE invoices SET paid_amount = ?, balance = ?, status = ?, updated_at = ? WHERE id = ? AND company_id = ?',
      [paid_amount, balance, status, new Date().toISOString(), invoiceId, companyId]
    );
    return { paid_amount, balance, status };
  }

  async create(data, context) {
    const repo = new PaymentRepository(this.conn);
    const invoiceRepo = new InvoiceRepository(this.conn);
    Authorizer.assertPermission(context, 'payments.create');

    if (!data.invoice_id) {
      throw new ValidationError('Invoice is required');
    }
    const amount = parseFloat(data.amount);
    if (!amount || amount <= 0) {
      throw new ValidationError('Valid payment amount is required');
    }

    const invoice = await invoiceRepo.findById(data.invoice_id, context.companyId);
    if (!invoice) throw new NotFoundError('Invoice', data.invoice_id);

    const id = require('../utils/generateId').generateId('pay');
    const now = new Date().toISOString();
    const paymentDate = data.payment_date || now.split('T')[0];

    // ATOMIC: payment INSERT + invoice recalculation either both succeed or both fail.
    const payment = this.conn.transaction(() => {
      const created = repo.create({
        id,
        invoice_id: data.invoice_id,
        contact_id: invoice.contact_id,
        amount,
        currency: validateCurrency(data.currency || invoice.currency),
        payment_method: data.payment_method || 'OTHER',
        status: 'COMPLETED',
        reference_number: data.reference_number || null,
        notes: data.notes || null,
        payment_date: paymentDate,
        company_id: context.companyId,
        created_at: now,
        updated_at: now
      });
      this._recalculateInvoice(data.invoice_id, context.companyId);
      return created;
    })();

    return payment;
  }

  async refund(id, context) {
    const repo = new PaymentRepository(this.conn);
    Authorizer.assertPermission(context, 'payments.refund');

    const existing = await repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Payment', id);

    if (existing.status === 'REFUNDED') {
      throw new ValidationError('Payment has already been refunded');
    }

    // ATOMIC: refund status change + invoice recalculation.
    this.conn.transaction(() => {
      repo.update(id, context.companyId, {
        status: 'REFUNDED',
        updated_at: new Date().toISOString()
      });
      this._recalculateInvoice(existing.invoice_id, context.companyId);
    })();

    return { success: true };
  }
}

module.exports = { PaymentService };
