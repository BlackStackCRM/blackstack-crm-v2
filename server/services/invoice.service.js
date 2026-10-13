const { InvoiceRepository } = require('../repositories/invoice.repository');
const { PaymentRepository } = require('../repositories/payment.repository');
const { Authorizer } = require('../auth/authorizer');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { assertTenantRefs } = require('../utils/tenantScope');
const { validateCurrency, SUPPORTED_CURRENCIES } = require('../utils/currency');

class InvoiceService {
  constructor(conn) {
    this.conn = conn;
  }

  _getDefaultCurrency(companyId) {
    const row = this.conn.get('SELECT value FROM system_metadata WHERE key = ?', ['default_currency']);
    return validateCurrency(row ? row.value : 'USD');
  }

  async list(context, query = {}) {
    const repo = new InvoiceRepository(this.conn);
    Authorizer.assertPermission(context, 'invoices.view');

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 20;
    const offset = (page - 1) * limit;

    const result = await repo.search({
      companyId: context.companyId,
      status: query.status,
      contactId: query.contactId,
      query: query.q,
      limit,
      offset
    });

    return { items: result.items, total: result.total };
  }

  async get(id, context) {
    const repo = new InvoiceRepository(this.conn);
    Authorizer.assertPermission(context, 'invoices.view');

    const item = await repo.getWithLines(id, context.companyId);
    if (!item) throw new NotFoundError('Invoice', id);
    return item;
  }

  async create(data, context) {
    const repo = new InvoiceRepository(this.conn);
    Authorizer.assertPermission(context, 'invoices.create');

    if (!data.contact_id) {
      throw new ValidationError('Contact is required');
    }
    // Tenant isolation: contact/organization must belong to the caller's company.
    assertTenantRefs(this.conn, context.companyId, { contact_id: data.contact_id, organization_id: data.organization_id });

    const id = require('../utils/generateId').generateId('inv');
    const invoiceNumber = `INV-${Date.now()}`;
    const now = new Date().toISOString();
    const issueDate = data.issue_date || now.split('T')[0];
    const dueDate = data.due_date || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    let subtotal = 0;
    const lines = (data.lines || []).map(line => {
      const qty = parseFloat(line.quantity) || 1;
      const price = parseFloat(line.unit_price) || 0;
      const lineTotal = qty * price;
      subtotal += lineTotal;
      return {
        id: require('../utils/generateId').generateId('iline'),
        product_id: line.product_id || null,
        description: line.description,
        quantity: qty,
        unit_price: price,
        tax_rate: parseFloat(line.tax_rate) || 0,
        discount: parseFloat(line.discount) || 0,
        total: lineTotal
      };
    });

    const tax = data.tax || 0;
    const discount = data.discount || 0;
    const total = subtotal + tax - discount;

        const invoice = await repo.createInvoice({
      id,
      invoice_number: invoiceNumber,
      contact_id: data.contact_id,
      organization_id: data.organization_id || null,
      deal_id: data.deal_id || null,
      currency: data.currency && SUPPORTED_CURRENCIES.includes(data.currency) ? data.currency : this._getDefaultCurrency(context.companyId),
      status: 'DRAFT',
      issue_date: issueDate,
      due_date: dueDate,
      subtotal,
      tax,
      discount,
      total,
      paid_amount: 0,
      balance: total,
      notes: data.notes || null,
      terms: data.terms || null,
      company_id: context.companyId,
      created_at: now,
      updated_at: now
    }, lines);

    return invoice;
  }

  async update(id, data, context) {
    const repo = new InvoiceRepository(this.conn);
    Authorizer.assertPermission(context, 'invoices.edit');

    const existing = await repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Invoice', id);

    const allowed = ['invoice_number', 'contact_id', 'organization_id', 'deal_id', 'currency',
      'issue_date', 'due_date', 'notes', 'terms'];
    const updates = {};
    for (const f of allowed) {
      if (data[f] !== undefined) updates[f] = data[f];
    }

    if (Object.keys(updates).length === 0) {
      throw new ValidationError('No fields to update');
    }

    const updated = await repo.update(id, context.companyId, {
      ...updates,
      updated_at: new Date().toISOString()
    });

    return updated;
  }

  async remove(id, context) {
    const repo = new InvoiceRepository(this.conn);
    Authorizer.assertPermission(context, 'invoices.delete');

    const existing = await repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Invoice', id);

    await repo.delete(id, context.companyId);
    return { success: true };
  }

  /**
   * markPaid = ADMINISTRATIVE/MANUAL adjustment: force invoice to PAID without
   * recording a payment. It is audited (audit_logs) and preserves ledger math:
   * paid_amount is raised to total only if not already over, and any later
   * payment/refund recalculates from the ledger via PaymentService.
   */
  async markPaid(id, context) {
    const repo = new InvoiceRepository(this.conn);
    const { AuditRepository } = require('../repositories/audit.repository');
    const { generateId } = require('../utils/generateId');
    Authorizer.assertPermission(context, 'invoices.edit');

    const invoice = await repo.findById(id, context.companyId);
    if (!invoice) throw new NotFoundError('Invoice', id);
    if (invoice.status === 'PAID' && (invoice.balance || 0) <= 0) {
      throw new ValidationError('Invoice is already fully paid');
    }

    const now = new Date().toISOString();
    this.conn.transaction(() => {
      repo.update(id, context.companyId, {
        paid_amount: Math.max(invoice.total, invoice.paid_amount || 0),
        balance: 0,
        status: 'PAID',
        updated_at: now
      });
      new AuditRepository(this.conn).log({
        id: generateId('aud'), user_id: context.userId,
        action: 'INVOICE_MARKED_PAID_MANUAL', entity_type: 'INVOICE', entity_id: id,
        old_values_json: JSON.stringify({ status: invoice.status, paid_amount: invoice.paid_amount, balance: invoice.balance }),
        new_values_json: JSON.stringify({ status: 'PAID', paid_amount: Math.max(invoice.total, invoice.paid_amount || 0), balance: 0 }),
        session_id: context.sessionId
      });
    })();

    return { success: true };
  }
}

module.exports = { InvoiceService };
