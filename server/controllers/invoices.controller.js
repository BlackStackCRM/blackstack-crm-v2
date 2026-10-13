const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');
const { assertTenantRefs } = require('../utils/tenantScope');
const CodeGenerator = require('../services/code-generator.service');

class InvoicesController {
  constructor() {
    this.conn = getConn();
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req);
      const { search, status, contact_id, organization_id, deal_id, date_from, date_to } = req.query;

      const where = ['company_id = ?'];
      const params = [req.user.companyId];
      if (search) { where.push('invoice_number LIKE ?'); params.push(`%${search}%`); }
      if (status) { where.push('status = ?'); params.push(status); }
      if (contact_id) { where.push('contact_id = ?'); params.push(contact_id); }
      if (organization_id) { where.push('organization_id = ?'); params.push(organization_id); }
      if (deal_id) { where.push('deal_id = ?'); params.push(deal_id); }
      if (date_from) { where.push('issue_date >= ?'); params.push(date_from); }
      if (date_to) { where.push('issue_date <= ?'); params.push(date_to); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const items = this.conn.all(
        `SELECT * FROM invoices ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      const total = this.conn.get(`SELECT COUNT(*) as total FROM invoices ${whereSql}`, params).total;
      res.json(paginatedResponse(items, total, page, limit));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      const item = this.conn.get('SELECT * FROM invoices WHERE id = ? AND company_id = ? LIMIT 1', [req.params.id, req.user.companyId]);
      if (!item) throw new NotFoundError('Invoice', req.params.id);
      item.line_items = this.conn.all('SELECT * FROM invoice_line_items WHERE invoice_id = ?', [req.params.id]);
      res.json(successResponse(item));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const { invoice_number, contact_id, organization_id, deal_id, issue_date, due_date, subtotal, tax, discount, total, notes, terms, line_items } = req.body;
      // Invoice number is system-generated when not supplied (global scope:
      // the legacy invoices table has no company_id, and invoice_number is
      // UNIQUE globally). A client-supplied number is honoured but must be
      // unique; duplicates are rejected by the unique index.
      let resolvedInvoiceNumber = typeof invoice_number === 'string' ? invoice_number.trim() : '';
      if (!resolvedInvoiceNumber) {
        resolvedInvoiceNumber = CodeGenerator.generate(this.conn, 'INVOICE');
      }
      if (!contact_id) throw new ValidationError('contact_id is required');
      if (!issue_date || !due_date) throw new ValidationError('issue_date and due_date are required');
      assertTenantRefs(this.conn, req.user.companyId, { contact_id, organization_id });

      const id = req.body.id || generateId('inv');
      const now = new Date().toISOString();
      const balance = (total || 0) - (req.body.paid_amount || 0);

      this.conn.transaction(() => {
        this.conn.run(`
          INSERT INTO invoices (id, invoice_number, contact_id, organization_id, deal_id, status, issue_date, due_date, subtotal, tax, discount, total, paid_amount, balance, notes, terms, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, resolvedInvoiceNumber, contact_id, organization_id, deal_id, 'DRAFT', issue_date, due_date, subtotal || 0, tax || 0, discount || 0, total || 0, 0, balance, notes || null, terms || null, now, now]);

        if (Array.isArray(line_items)) {
          for (const li of line_items) {
            const liId = generateId('li');
            this.conn.run(`
              INSERT INTO invoice_line_items (id, invoice_id, product_id, description, quantity, unit_price, tax_rate, discount, total, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [liId, id, li.product_id, li.description, li.quantity || 1, li.unit_price || 0, li.tax_rate || 0, li.discount || 0, li.total || 0, now]);
          }
        }
      })();

      res.status(201).json(successResponse(this.conn.get('SELECT * FROM invoices WHERE id = ?', [id]), 201));
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      const existing = this.conn.get('SELECT id FROM invoices WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Invoice', req.params.id);

      const allowed = ['contact_id', 'organization_id', 'deal_id', 'status', 'issue_date', 'due_date', 'subtotal', 'tax', 'discount', 'total', 'paid_amount', 'balance', 'notes', 'terms'];
      const sets = [];
      const params = [];
      for (const f of allowed) {
        if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); }
      }
      if (!sets.length) throw new ValidationError('No fields to update');

      const now = new Date().toISOString();
      this.conn.run(`UPDATE invoices SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND company_id = ?`, [...params, now, req.params.id, req.user.companyId]);
      res.json(successResponse(this.conn.get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId])));
    } catch (err) { next(err); }
  }

  async remove(req, res, next) {
    try {
      const result = this.conn.run('DELETE FROM invoices WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (result.changes === 0) throw new NotFoundError('Invoice', req.params.id);
      res.json(successResponse({ id: req.params.id, deleted: true }));
    } catch (err) { next(err); }
  }

  async send(req, res, next) {
    try {
      const existing = this.conn.get('SELECT id, status FROM invoices WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Invoice', req.params.id);

      const now = new Date().toISOString();
      const newStatus = existing.status === 'DRAFT' ? 'SENT' : existing.status;
      this.conn.run('UPDATE invoices SET status = ?, updated_at = ? WHERE id = ? AND company_id = ?', [newStatus, now, req.params.id, req.user.companyId]);
      res.json(successResponse(this.conn.get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId])));
    } catch (err) { next(err); }
  }

  async markPaid(req, res, next) {
    try {
      const existing = this.conn.get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Invoice', req.params.id);

      const paidAmount = req.body.amount !== undefined ? req.body.amount : existing.total;
      const now = new Date().toISOString();
      this.conn.run('UPDATE invoices SET status = ?, paid_amount = ?, balance = ?, updated_at = ? WHERE id = ? AND company_id = ?',
        ['PAID', paidAmount, 0, now, req.params.id, req.user.companyId]);
      res.json(successResponse(this.conn.get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId])));
    } catch (err) { next(err); }
  }
}

module.exports = { InvoicesController };