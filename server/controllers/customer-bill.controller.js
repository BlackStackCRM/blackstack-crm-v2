/**
 * CustomerBillController — REST API for the Customer Bills / AR module.
 *
 * Delegates all business logic to CustomerBillService. Enforces authorization
 * via the existing RBAC middleware at the route layer. All financial
 * operations run in database transactions for atomicity.
 */
const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { successResponse, paginatedResponse } = require('../utils/response');
const { NotFoundError, ValidationError, AppError, ConflictError } = require('../utils/errors');
const { CustomerBillService } = require('../services/customer-bill.service');
const CodeGenerator = require('../services/code-generator.service');
const { TaxService } = require('../services/tax-calculation-engine');
const { BillRepository, CreditRuleRepository, FinancialYearRepository } = require('../repositories/billing-cost.repository');
const { ReceivableRepository } = require('../repositories/receivable.repository');
const { getPagination } = require('../utils/helpers');

function getCompanyId(req) {
  return req.user?.companyId || 'default';
}

function audit(conn, companyId, userId, entity, entityId, action, oldValues, newValues) {
  try {
    conn.prepare(`
      INSERT INTO accounting_audit (id, company_id, user_id, entity_type, entity_id, action,
        old_values_json, new_values_json, ip_address, user_agent, session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generateId('aud'), companyId, userId || 'system', entity, entityId, action,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      null, null, null, new Date().toISOString()
    );
  } catch (e) { /* audit must not break main flow */ }
}

class CustomerBillController {
  constructor() {
    const conn = getConn();
    this.conn = conn;
    this.service = new CustomerBillService(conn);
    this.billRepo = new BillRepository(conn);
    this.receivableRepo = new ReceivableRepository(conn);
    this.creditRepo = new CreditRuleRepository(conn);
    this.taxService = new TaxService(conn);
    this.fyRepo = new FinancialYearRepository(conn);
  }

  // ═══ Number & Tax Preview ══════════════════════════════════════════════
  async previewNumber(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const number = this.service.previewInvoiceNumber(companyId);
      res.json(successResponse({ invoice_number: number, bill_number: number }));
    } catch (err) {
      next(err);
    }
  }

  async calculateTax(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.taxService.calculateTax({
        companyId,
        taxableAmount: req.body.taxable_amount,
        taxMasterId: req.body.tax_master_id,
        partyState: req.body.party_state,
        companyState: req.body.company_state,
      });
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Tax Summary ═════════════════════════════════════════════════════════
  /**
   * Tax Summary — aggregates CGST/SGST/IGST output tax from posted bills,
   * credit note reversals, and debit note additions. For GST returns (GSTR-1).
   */
  async getTaxSummary(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const from = req.query.from || '1970-01-01';
      const to = req.query.to || '9999-12-31';

      // Tax on customer bills (output tax liability) — from stored tax columns
      const billTax = this.conn.get(`
        SELECT
          COALESCE(SUM(cgst_amount), 0) as cgst_out,
          COALESCE(SUM(sgst_amount), 0) as sgst_out,
          COALESCE(SUM(igst_amount), 0) as igst_out,
          COUNT(*) as bill_count
        FROM bills
        WHERE company_id = ? AND bill_type = 'CUSTOMER'
          AND status NOT IN ('DRAFT', 'CANCELLED', 'VOID', 'WRITTEN_OFF')
          AND issue_date BETWEEN ? AND ?
      `, [companyId, from, to]);

      // Credit note tax reversals — from journal_entry_lines on output tax accounts
      // (credit note JEs debit the output tax accounts to reverse liability)
      const cnTaxRows = this.conn.all(`
        SELECT jel.account_id, SUM(jel.debit_amount) as total_debit
        FROM vouchers v
        JOIN journal_entries j ON j.id = v.journal_entry_id
        JOIN journal_entry_lines jel ON jel.journal_entry_id = j.id
        WHERE v.company_id = ? AND v.voucher_type = 'CREDIT_NOTE'
          AND v.voucher_date BETWEEN ? AND ?
          AND jel.account_id IN ('acc_output_cgst', 'acc_output_sgst', 'acc_output_igst')
        GROUP BY jel.account_id
      `, [companyId, from, to]);
      let cnCgstRev = 0, cnSgstRev = 0, cnIgstRev = 0;
      for (const r of cnTaxRows) {
        if (r.account_id === 'acc_output_cgst') cnCgstRev += parseFloat(r.total_debit || 0);
        if (r.account_id === 'acc_output_sgst') cnSgstRev += parseFloat(r.total_debit || 0);
        if (r.account_id === 'acc_output_igst') cnIgstRev += parseFloat(r.total_debit || 0);
      }
      const cnCountRow = this.conn.get(`SELECT COUNT(*) as cnt FROM vouchers v WHERE v.company_id = ? AND v.voucher_type = 'CREDIT_NOTE' AND v.voucher_date BETWEEN ? AND ?`, [companyId, from, to])?.cnt || 0;

      // Debit note tax additions — from journal_entry_lines on output tax accounts
      const dnTaxRows = this.conn.all(`
        SELECT jel.account_id, SUM(jel.credit_amount) as total_credit
        FROM vouchers v
        JOIN journal_entries j ON j.id = v.journal_entry_id
        JOIN journal_entry_lines jel ON jel.journal_entry_id = j.id
        WHERE v.company_id = ? AND v.voucher_type = 'DEBIT_NOTE'
          AND v.voucher_date BETWEEN ? AND ?
          AND jel.account_id IN ('acc_output_cgst', 'acc_output_sgst', 'acc_output_igst')
        GROUP BY jel.account_id
      `, [companyId, from, to]);
      let dnCgstAdd = 0, dnSgstAdd = 0, dnIgstAdd = 0;
      for (const r of dnTaxRows) {
        if (r.account_id === 'acc_output_cgst') dnCgstAdd += parseFloat(r.total_credit || 0);
        if (r.account_id === 'acc_output_sgst') dnSgstAdd += parseFloat(r.total_credit || 0);
        if (r.account_id === 'acc_output_igst') dnIgstAdd += parseFloat(r.total_credit || 0);
      }
      const dnCountRow = this.conn.get(`SELECT COUNT(*) as cnt FROM vouchers v WHERE v.company_id = ? AND v.voucher_type = 'DEBIT_NOTE' AND v.voucher_date BETWEEN ? AND ?`, [companyId, from, to])?.cnt || 0;

      // Tax collected per rate bracket
      const byRate = this.conn.all(`
        SELECT tax_master_id,
          COALESCE(SUM(tax), 0) as tax_amount,
          COALESCE(SUM(total), 0) as bill_amount,
          COUNT(*) as bill_count
        FROM bills
        WHERE company_id = ? AND bill_type = 'CUSTOMER'
          AND status NOT IN ('DRAFT', 'CANCELLED', 'VOID', 'WRITTEN_OFF')
          AND issue_date BETWEEN ? AND ?
        GROUP BY tax_master_id
        ORDER BY tax_master_id
      `, [companyId, from, to]);

      const cgstOut = parseFloat(billTax?.cgst_out || 0);
      const sgstOut = parseFloat(billTax?.sgst_out || 0);
      const igstOut = parseFloat(billTax?.igst_out || 0);
      const totalReversals = cnCgstRev + cnSgstRev + cnIgstRev;
      const totalAdditions = dnCgstAdd + dnSgstAdd + dnIgstAdd;
      const totalTaxCollected = cgstOut + sgstOut + igstOut;

      const netCgst = cgstOut - cnCgstRev + dnCgstAdd;
      const netSgst = sgstOut - cnSgstRev + dnSgstAdd;
      const netIgst = igstOut - cnIgstRev + dnIgstAdd;

      res.json(successResponse({
        period: { from, to },
        output_tax: {
          cgst: netCgst,
          sgst: netSgst,
          igst: netIgst,
        },
        reversals: {
          credit_notes: totalReversals,
          credit_note_count: cnCountRow,
          by_component_cn: { cgst: cnCgstRev, sgst: cnSgstRev, igst: cnIgstRev },
          debit_notes: totalAdditions,
          debit_note_count: dnCountRow,
          by_component_dn: { cgst: dnCgstAdd, sgst: dnSgstAdd, igst: dnIgstAdd },
        },
        by_tax_rate: byRate.map(r => ({
          tax_master_id: r.tax_master_id,
          tax_amount: parseFloat(r.tax_amount || 0),
          bill_amount: parseFloat(r.bill_amount || 0),
          bill_count: r.bill_count,
        })),
        totals: {
          bill_count: billTax?.bill_count || 0,
          total_tax_collected: totalTaxCollected,
          net_tax_payable: netCgst + netSgst + netIgst,
          cgst_out: cgstOut,
          sgst_out: sgstOut,
          igst_out: igstOut,
        },
      }));
    } catch (err) {
      next(err);
    }
  }

  // ═══ CRUD ══════════════════════════════════════════════════════════════
  async listBills(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const offset = (page - 1) * limit;

      const options = {
        companyId,
        billType: 'CUSTOMER',
        status: req.query.status,
        limit,
        offset,
        startDate: req.query.from,
        endDate: req.query.to,
        query: req.query.q,
        contactId: req.query.contact_id,
      };

      // Build a richer query for customer bills with customer name join
      const where = ['bill_type = \'CUSTOMER\'', 'b.company_id = ?'];
      const params = [companyId];
      if (req.query.status) { where.push('b.status = ?'); params.push(req.query.status); }
      if (req.query.contact_id) { where.push('b.contact_id = ?'); params.push(req.query.contact_id); }
      if (req.query.from) { where.push('b.issue_date >= ?'); params.push(req.query.from); }
      if (req.query.to) { where.push('b.issue_date <= ?'); params.push(req.query.to); }
      if (req.query.payment_status) {
        const ps = req.query.payment_status;
        if (ps === 'PAID') where.push("b.status = 'PAID'");
        else if (ps === 'PARTIAL') where.push("b.status = 'PARTIALLY_PAID'");
        else if (ps === 'UNPAID') where.push("b.balance > 0 AND b.status IN ('POSTED','PARTIALLY_PAID','OVERDUE')");
        else if (ps === 'OVERDUE') where.push("b.status = 'OVERDUE'");
        else if (ps === 'OVERPAID') where.push('b.paid_amount > b.total AND b.total > 0');
        else if (ps === 'NOT_DUE') where.push("((b.balance > 0 AND b.status IN ('DRAFT','PENDING_APPROVAL','APPROVED')) OR (b.balance > 0 AND b.status = 'POSTED' AND (b.due_date IS NULL OR b.due_date >= date('now'))))");
      }
      if (req.query.overdue === 'true') { where.push('b.status = \'OVERDUE\' AND b.balance > 0'); }
      if (req.query.due_from) { where.push('b.due_date >= ?'); params.push(req.query.due_from); }
      if (req.query.due_to) { where.push('b.due_date <= ?'); params.push(req.query.due_to); }
      if (req.query.min_amount) { where.push('b.total >= ?'); params.push(parseFloat(req.query.min_amount) || 0); }
      if (req.query.max_amount) { where.push('b.total <= ?'); params.push(parseFloat(req.query.max_amount) || 0); }
      if (req.query.overdue_bucket) {
        const ob = req.query.overdue_bucket;
        if (ob === 'NOT') {
          where.push("NOT (b.balance > 0 AND b.due_date < date('now') AND b.status IN ('POSTED','PARTIALLY_PAID','OVERDUE'))");
        } else {
          const start = parseInt(ob, 10);
          if (!isNaN(start)) {
            if (start >= 91) { where.push("b.balance > 0 AND b.due_date < date('now') AND CAST(julianday('now') - julianday(b.due_date) AS INTEGER) >= 91"); }
            else { where.push("b.balance > 0 AND b.due_date < date('now') AND CAST(julianday('now') - julianday(b.due_date) AS INTEGER) >= ? AND CAST(julianday('now') - julianday(b.due_date) AS INTEGER) < ?"); params.push(start, start + 30); }
          }
        }
      }
      if (req.query.q) {
        const s = `%${req.query.q}%`;
        where.push('(b.bill_number LIKE ? OR b.invoice_number LIKE ? OR b.reference_number LIKE ? OR b.customer_po_number LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR b.customer_gstin LIKE ? OR c.id LIKE ?)');
        params.push(s, s, s, s, s, s, s, s);
      }
      if (req.query.currency) { where.push('b.currency = ?'); params.push(req.query.currency); }
      if (req.query.payment_terms) { where.push('b.payment_terms = ?'); params.push(req.query.payment_terms); }
      if (req.query.overdue_days) {
        const od = parseInt(req.query.overdue_days);
        if (!isNaN(od)) { where.push(`b.balance > 0 AND CAST(julianday('now') - julianday(b.due_date) AS INTEGER) >= ?`); params.push(od); }
      }

      const whereStr = where.join(' AND ');
      const totalRow = this.conn.get(`SELECT COUNT(*) as total FROM bills b LEFT JOIN contacts c ON c.id = b.contact_id WHERE ${whereStr}`, params);
      const total = totalRow?.total || 0;

      const items = this.conn.all(`\n        SELECT b.*, c.first_name, c.last_name, b.customer_gstin as contact_gstin, c.id as contact_code, o.name as organization_name,\n               (c.first_name || ' ' || c.last_name) as contact_name\n        FROM bills b\n        LEFT JOIN contacts c ON c.id = b.contact_id\n        LEFT JOIN organizations o ON o.id = b.organization_id\n        WHERE ${whereStr}\n        ORDER BY b.created_at DESC LIMIT ? OFFSET ?\n      `, [...params, limit, offset]);

      res.json(paginatedResponse(items, total, page, limit));
    } catch (err) {
      next(err);
    }
  }

  async getBill(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const bill = this.billRepo.findById(req.params.id, companyId);
      if (!bill || bill.bill_type !== 'CUSTOMER') throw new NotFoundError('Customer bill', req.params.id);
      const items = this.conn.all('SELECT * FROM bill_items WHERE bill_id = ? ORDER BY id', [bill.id]);
      const payments = this.conn.all(`
        SELECT p.* FROM payments p
        WHERE p.bill_id = ? AND p.company_id = ?
        ORDER BY p.payment_date DESC
      `, [bill.id, companyId]);
      const allocations = this.conn.all(`
        SELECT ba.*, je.id as je_id, je.entry_number, je.entry_date
        FROM bill_allocations ba
        LEFT JOIN journal_entries je ON je.id = ba.journal_entry_id
        WHERE ba.bill_id = ? AND ba.company_id = ?
      `, [bill.id, companyId]);
      const auditTrail = this.conn.all(`
        SELECT * FROM accounting_audit
        WHERE entity_type = 'customer_bill' AND entity_id = ? AND company_id = ?
        ORDER BY created_at DESC
      `, [bill.id, companyId]);

      // Join customer and organization info
      const contact = bill.contact_id
        ? this.conn.get(`
            SELECT c.*, o.name as organization_name, o.industry
            FROM contacts c
            LEFT JOIN organizations o ON o.id = c.organization_id
            WHERE c.id = ? AND c.company_id = ?
          `, [bill.contact_id, companyId])
        : null;

      const customerName = contact ? `${contact.first_name || ''} ${contact.last_name || ''}`.trim() : '';

      // Build the response with proper field mapping
      const billWithCustomer = {
        ...bill,
        contact_name: customerName,
        contact_code: contact?.id || '',
        customer_gstin: bill.customer_gstin || '',
        organization_name: contact?.organization_name || '',
        customer: contact
          ? {
              id: contact.id,
              name: customerName,
              code: contact.id,
              gstin: bill.customer_gstin || '',
              email: contact.email || '',
              phone: contact.phone || '',
              billing_address: bill.billing_address || contact.address || '',
              shipping_address: bill.shipping_address || contact.address || '',
              organization: contact.organization_name || '',
            }
          : null,
        items,
        payments,
        allocations,
        audit_trail: auditTrail,
      };
      res.json(successResponse(billWithCustomer));
    } catch (err) {
      next(err);
    }
  }

  async createBill(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const data = { ...req.body, company_id: companyId };

      // Validate customer exists
      const contact = this.conn.get('SELECT id FROM contacts WHERE id = ? AND company_id = ?', [data.contact_id, companyId]);
      if (!contact) throw new ValidationError('Invalid or missing customer');

      // Validate financial year
      const fy = data.financial_year_id
        ? this.conn.get('SELECT id FROM financial_years WHERE id = ? AND company_id = ?', [data.financial_year_id, companyId])
        : this.fyRepo ? null : null;
      if (data.financial_year_id && !fy) throw new ValidationError('Invalid financial year');

      // Validate tax master if provided
      if (data.tax_master_id) {
        const tm = this.conn.get('SELECT id FROM tax_masters WHERE id = ? AND company_id = ?', [data.tax_master_id, companyId]);
        if (!tm) throw new ValidationError('Invalid tax master');
      }

      // Calculate totals via the service
      const calc = this.service.calculateTotals(data);
      data.subtotal = calc.subtotal;
      data.taxable_amount = calc.taxable_amount;
      data.discount_amount = calc.discount_amount;
      data.line_discount_amount = calc.line_discount_amount || 0;
      data.other_charges = calc.other_charges;
      data.other_charges_tax_amount = calc.other_charges_tax || 0;
      data.round_off = calc.round_off;
      data.total_tax = calc.total_tax;
      data.total = calc.grand_total;
      data.balance = calc.grand_total;
      data.tax = calc.total_tax;
      data.discount = calc.discount_amount;

      // Determine intra/inter-state for the bill-level flag
      const config = this.taxService.getCompanyTaxConfig(companyId);
      if (data.tax_master_id && config) {
        const partyStateCode = data.party_state || data.place_of_supply;
        data.is_interstate = (config.state_code !== partyStateCode) ? 1 : 0;
      }

      // Store tax breakdown on the bill for JE reconstruction (aggregate from all lines)
      if (!data.tax_master_id && calc.items?.[0]?.tax_master_id) {
        data.tax_master_id = calc.items[0].tax_master_id;
      }
      if (calc.items && calc.items.length > 0) {
        const totalCgst = calc.items.reduce((sum, l) => sum + parseFloat(l.cgst_amount || 0), 0);
        const totalSgst = calc.items.reduce((sum, l) => sum + parseFloat(l.sgst_amount || 0), 0);
        const totalIgst = calc.items.reduce((sum, l) => sum + parseFloat(l.igst_amount || 0), 0);
        const firstTax = calc.items.find(l => l.tax_result)?.tax_result;
        if (firstTax) {
          data.cgst_amount = totalCgst;
          data.sgst_amount = totalSgst;
          data.igst_amount = totalIgst;
          data.cgst_rate = firstTax.cgst_rate || 0;
          data.sgst_rate = firstTax.sgst_rate || 0;
          data.igst_rate = firstTax.igst_rate || 0;
        }
      }

      // Use calculated line items (backend recalculated tax/discount/totals)
      data.lines = calc.items;

      const result = this.service.createBill(data, userId);
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async updateBill(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const bill = this.billRepo.findById(req.params.id, companyId);
      if (!bill || bill.bill_type !== 'CUSTOMER') throw new NotFoundError('Customer bill', req.params.id);

      if (this.service.canTransition(bill.status, 'POSTED') || bill.status === 'DRAFT') {
        // Allow editing drafts and pre-posted bills
      } else {
        if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'].includes(bill.status)) {
          throw new AppError(`Cannot edit bill in status ${bill.status}`, 'INVALID_STATE', 400);
        }
      }

      const updates = { ...req.body };
      delete updates.id;
      delete updates.bill_number;
      delete updates.invoice_number;
      delete updates.bill_type;
      delete updates.company_id;
      delete updates.status;
      delete updates.created_by;
      delete updates.created_at;
      delete updates.lines;
      delete updates.party_state;

      audit(this.conn, companyId, userId, 'customer_bill', bill.id, 'UPDATE', bill, updates);
      this.billRepo.update(bill.id, companyId, updates);
      res.json(successResponse(this.billRepo.findById(bill.id, companyId)));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Lifecycle: Submit for Approval ═════════════════════════════════════
  async submitForApproval(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const result = this.service.submitForApproval(req.params.id, companyId, userId);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Lifecycle: Approve ════════════════════════════════════════════════
  async approveBill(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const result = this.service.approveBill(req.params.id, companyId, userId, req.body || {});
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Lifecycle: Post ═══════════════════════════════════════════════════
  async postBill(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const idempotencyKey = req.body.idempotency_key || req.headers['x-idempotency-key'] || null;
      const result = this.service.postBill(req.params.id, companyId, userId, idempotencyKey, req);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Lifecycle: Cancel / Void ══════════════════════════════════════════
  async cancelBill(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const result = this.service.cancelBill(req.params.id, companyId, userId, req.body?.reason || '');
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Draft deletion ════════════════════════════════════════════════════
  async deleteDraft(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const bill = this.billRepo.findById(req.params.id, companyId);
      if (!bill) throw new NotFoundError('Customer bill', req.params.id);
      if (bill.status !== 'DRAFT') throw new AppError('Only drafts can be deleted', 'INVALID_STATE', 400);
      this.conn.transaction(() => {
        this.conn.prepare('DELETE FROM bill_items WHERE bill_id = ?').run(req.params.id);
        this.conn.prepare("UPDATE bills SET status = ?, cancelled_by = ?, cancelled_at = ?, cancellation_reason = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?")
          .run('CANCELLED', userId, new Date().toISOString(), 'Deleted', req.params.id, companyId);
        audit(this.conn, companyId, userId, 'customer_bill', req.params.id, 'DELETE', bill, { status: 'CANCELLED' });
      })();
      res.json(successResponse({ success: true }));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Payment Recording & Allocation ════════════════════════════════════
  async recordPayment(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const data = { ...req.body, company_id: companyId, contact_id: req.body.contact_id };
      const result = this.service.recordPayment(data, userId, req);
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Credit Note ═══════════════════════════════════════════════════════
  async createCreditNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const data = { ...req.body, company_id: companyId };
      const result = this.service.createCreditNote(data, userId, req);
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getCreditNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getCreditNote(req.params.id, companyId);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async cancelCreditNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const result = this.service.cancelCreditNote(req.params.id, companyId, userId, req.body?.reason || '');
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async listCreditNotes(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.listCreditNotes(companyId, {
        contact_id: req.query.contact_id,
        bill_id: req.query.bill_id,
        from: req.query.from,
        to: req.query.to,
        status: req.query.status,
        limit: parseInt(req.query.limit) || 50,
        offset: parseInt(req.query.offset) || 0,
      });
      res.json(paginatedResponse(result.items, result.total, parseInt(req.query.page) || 1, parseInt(req.query.limit) || 50));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Debit Note ════════════════════════════════════════════════════════
  async createDebitNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const data = { ...req.body, company_id: companyId };
      const result = this.service.createDebitNote(data, userId, req);
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getDebitNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getDebitNote(req.params.id, companyId);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async cancelDebitNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const result = this.service.cancelDebitNote(req.params.id, companyId, userId, req.body?.reason || '');
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async listDebitNotes(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.listDebitNotes(companyId, {
        contact_id: req.query.contact_id,
        bill_id: req.query.bill_id,
        from: req.query.from,
        to: req.query.to,
        status: req.query.status,
        limit: parseInt(req.query.limit) || 50,
        offset: parseInt(req.query.offset) || 0,
      });
      res.json(paginatedResponse(result.items, result.total, parseInt(req.query.page) || 1, parseInt(req.query.limit) || 50));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Customer Financial Summary ════════════════════════════════════════
  async getCustomerSummary(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getCustomerFinancialSummary(req.params.contactId, companyId);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Customer Statement ════════════════════════════════════════════════
  async getCustomerStatement(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getCustomerStatement(req.params.id, companyId, {
        from: req.query.from,
        to: req.query.to,
        includeCancelled: req.query.include_cancelled === 'true',
        includeZeroBalance: req.query.include_zero_balance === 'true',
        docTypes: req.query.doc_types ? req.query.doc_types.split(',') : null,
      });
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Step 12: Customer Outstanding ══════════════════════════════════════
  async getCustomerOutstanding(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getCustomerOutstanding(companyId, {
        contactId: req.query.contact_id,
        overdueOnly: req.query.overdue_only === 'true',
        status: req.query.status,
        limit: parseInt(req.query.limit) || 50,
        offset: parseInt(req.query.page ? (parseInt(req.query.page) - 1) * (parseInt(req.query.limit) || 50) : req.query.offset || 0),
      });
      res.json(paginatedResponse(result.items, result.total, parseInt(req.query.page) || 1, parseInt(req.query.limit) || 50));
    } catch (err) {
      next(err);
    }
  }

  async getCustomerAging(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getCustomerAging(req.params.contactId, companyId);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getInvoiceAging(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getInvoiceAging(req.params.billId, companyId);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ═══ AR Aging ══════════════════════════════════════════════════════════
  async getAging(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const buckets = this.receivableRepo.getAgingSummary(companyId);
      const aging = await this._getDetailedAging(companyId, req.query);
      res.json(successResponse({ summary: buckets, detail: aging.items, total: aging.total }));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Receivables Summary ═══════════════════════════════════════════════
  async getReceivablesSummary(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const rows = this.conn.all(`
        SELECT c.id as contact_id, c.first_name, c.last_name, o.name as organization_name,
          COALESCE(SUM(r.outstanding_amount), 0) as outstanding,
          COALESCE(SUM(CASE WHEN r.days_overdue > 0 THEN r.outstanding_amount ELSE 0 END), 0) as overdue
        FROM receivables r
        JOIN contacts c ON c.id = r.contact_id
        LEFT JOIN organizations o ON o.id = r.organization_id
        WHERE r.company_id = ? AND r.status NOT IN ('PAID', 'WRITTEN_OFF')
        GROUP BY c.id ORDER BY outstanding DESC
        LIMIT 100
      `, [companyId]);
      res.json(successResponse(rows));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Status Counts ═════════════════════════════════════════════════════
  async getStatusCounts(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const where = 'company_id = ? AND bill_type = \'CUSTOMER\'';
      const params = [companyId];
      const statusRow = this.conn.get(`
        SELECT status, COUNT(*) as cnt FROM bills WHERE ${where} GROUP BY status
      `, params);
      // statusRow is a single row with first match; use all() instead
      const rows = this.conn.all(`
        SELECT status, COUNT(*) as cnt FROM bills WHERE ${where} GROUP BY status
      `, params);
      const counts = {};
      for (const r of rows) {
        counts[r.status] = r.cnt;
      }
      // Compute payment status counts
      const paidCount = this.conn.get(`SELECT COUNT(*) as cnt FROM bills WHERE company_id = ? AND bill_type = 'CUSTOMER' AND status = 'PAID'`, [companyId])?.cnt || 0;
      const partialCount = this.conn.get(`SELECT COUNT(*) as cnt FROM bills WHERE company_id = ? AND bill_type = 'CUSTOMER' AND status = 'PARTIALLY_PAID'`, [companyId])?.cnt || 0;
      const overdueCount = this.conn.get(`SELECT COUNT(*) as cnt FROM bills WHERE company_id = ? AND bill_type = 'CUSTOMER' AND status = 'OVERDUE' AND balance > 0`, [companyId])?.cnt || 0;
      counts.PAID = paidCount;
      counts.PARTIALLY_PAID = partialCount;
      counts.OVERDUE = overdueCount;
      res.json(successResponse(counts));
    } catch (err) {
      next(err);
    }
  }

  // ═══ KPI Summary ═══════════════════════════════════════════════════════
  async getKpiSummary(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getKpiSummary(companyId, { from: req.query.from, to: req.query.to });
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Helper ════════════════════════════════════════════════════════════
  async _getDetailedAging(companyId, query) {
    const where = ['r.company_id = ? AND r.status NOT IN (\'PAID\', \'WRITTEN_OFF\')'];
    const params = [companyId];
    if (query.contact_id) { where.push('r.contact_id = ?'); params.push(query.contact_id); }
    const rows = this.conn.all(`
      SELECT r.*, c.first_name, c.last_name, b.bill_number, b.invoice_number, b.issue_date
      FROM receivables r
      JOIN bills b ON b.id = r.bill_id
      LEFT JOIN contacts c ON c.id = r.contact_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.due_date ASC
      LIMIT 200
    `, params);
    return { items: rows, total: rows.length };
  }
  // ═══ Payment Allocation ══════════════════════════════════════════════
  async allocatePayment(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const data = { ...req.body, company_id: companyId };
      const result = this.service.allocatePayment(data, userId);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Reconciliation ══════════════════════════════════════════════════
  async reconcile(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const data = { ...req.body, company_id: companyId };
      const result = this.service.reconcile(data, userId);
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Write-off ════════════════════════════════════════════════════════
  async writeoff(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const data = { ...req.body, company_id: companyId, bill_id: req.params.id };
      const result = this.service.writeOff(data, userId, req);
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Dispute ══════════════════════════════════════════════════════════
  async dispute(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const result = this.service.dispute(req.params.id, { ...req.body, company_id: companyId }, userId);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Resolve Dispute ══════════════════════════════════════════════════
  async resolveDispute(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const result = this.service.resolveDispute(req.params.disputeId, { ...req.body, company_id: companyId }, userId);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Step 12: Collection Management ══════════════════════════════════════

  async assignCollectionOwner(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const result = this.service.assignCollection(
        req.params.contactId, req.body.owner_id, companyId, userId,
        { priority: req.body.priority, status: req.body.status }
      );
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getCollectionActivities(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getCollectionActivities(req.params.contactId, companyId, {
        limit: parseInt(req.query.limit) || 50,
        offset: parseInt(req.query.page ? (parseInt(req.query.page) - 1) * (parseInt(req.query.limit) || 50) : req.query.offset || 0),
        activityTypes: req.query.types ? req.query.types.split(',') : null,
      });
      res.json(paginatedResponse(result.items, result.total, parseInt(req.query.page) || 1, parseInt(req.query.limit) || 50));
    } catch (err) {
      next(err);
    }
  }

  async addCollectionActivity(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const result = this.service.addCollectionActivity(req.params.contactId, {
        ...req.body, company_id: companyId, user_id: userId,
      });
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async createPromiseToPay(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const result = this.service.createPromiseToPay(
        req.params.contactId, req.body.promise_date, req.body.amount, companyId, userId,
        { notes: req.body.notes, bill_id: req.body.invoice_id }
      );
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getPromisesToPay(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getPromisesToPay(req.params.contactId, companyId);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async recordPromisePayment(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const result = this.service.recordPromisePayment(req.params.promiseId, {
        amount: req.body.amount, payment_id: req.body.payment_id, company_id: companyId, user_id: userId,
      });
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async createDispute(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const result = this.service.createCollectionDispute(req.body, companyId, userId);
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getDisputes(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getCollectionDisputes(companyId, {
        contactId: req.query.contact_id,
        status: req.query.status,
        limit: parseInt(req.query.limit) || 50,
        offset: parseInt(req.query.page ? (parseInt(req.query.page) - 1) * (parseInt(req.query.limit) || 50) : req.query.offset || 0),
      });
      res.json(paginatedResponse(result.items, result.total, parseInt(req.query.page) || 1, parseInt(req.query.limit) || 50));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Collection Dashboard ════════════════════════════════════════════════

  async getCollectionDashboard(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getCollectionDashboard(companyId);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async resolveCollectionDispute(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const userId = req.user.userId;
      const result = this.service.resolveCollectionDispute(req.params.disputeId, { ...req.body, company_id: companyId }, userId);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Step 13: Report Controller Methods ═══════════════════════════════════─

  async getBillingDashboard(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getBillingDashboard(companyId, req.query.start_date, req.query.end_date);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getBillingTrend(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getBillingTrend(companyId, req.query);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getSalesRegister(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { limit, offset, page } = getPagination(req, { limit: 20, maxLimit: 100 });
      const result = this.service.getSalesRegister(companyId, { ...req.query, limit, offset, page });
      res.json(paginatedResponse(result.items, result.total, page, limit, result.summary));
    } catch (err) {
      next(err);
    }
  }

  async getInvoiceRegister(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { limit, offset, page } = getPagination(req, { limit: 20, maxLimit: 100 });
      const result = this.service.getInvoiceRegister(companyId, { ...req.query, limit, offset, page });
      res.json(paginatedResponse(result.items, result.total, page, limit, result.summary));
    } catch (err) {
      next(err);
    }
  }

  async getCustomerOutstandingReport(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getCustomerOutstandingReport(companyId, req.query);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getTaxReport(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getTaxReport(companyId, req.query);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getSalespersonReport(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getSalespersonReport(companyId, req.query);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getProductSalesReport(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getProductSalesReport(companyId, req.query);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getBranchWarehouseReport(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getBranchWarehouseReport(companyId, req.query);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getPaymentRegister(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { limit, offset, page } = getPagination(req, { limit: 20, maxLimit: 100 });
      const result = this.service.getPaymentRegister(companyId, { ...req.query, limit, offset, page });
      res.json(paginatedResponse(result.items, result.total, page, limit, result.summary));
    } catch (err) {
      next(err);
    }
  }

  async getCollectionReport(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getCollectionReport(companyId, req.query);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getOverdueAnalytics(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getOverdueAnalytics(companyId, req.query);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getTopCustomers(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getTopCustomers(companyId, req.query);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getCollectionPerformance(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getCollectionPerformance(companyId, req.query);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getCollectionTrend(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getCollectionTrend(companyId, req.query);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getPaymentMethodDistribution(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getPaymentMethodDistribution(companyId, req.query);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getAgingDistribution(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.service.getAgingDistribution(companyId);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getCreditNoteRegister(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { limit, offset, page } = getPagination(req, { limit: 20, maxLimit: 100 });
      const result = this.service.getCreditNoteRegister(companyId, { ...req.query, limit, offset, page });
      res.json(paginatedResponse(result.items, result.total, page, limit, result.summary));
    } catch (err) {
      next(err);
    }
  }

  async getDebitNoteRegister(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { limit, offset, page } = getPagination(req, { limit: 20, maxLimit: 100 });
      const result = this.service.getDebitNoteRegister(companyId, { ...req.query, limit, offset, page });
      res.json(paginatedResponse(result.items, result.total, page, limit));
    } catch (err) {
      next(err);
    }
  }

  // ═══ Step 14: Receivables Follow-up & Collections Automation ════════════════

  // ── Collection Rules ──
  async listCollectionRules(req, res, next) {
    try {
      const result = service.listCollectionRules(getCompanyId(req), req.query);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async getCollectionRule(req, res, next) {
    try {
      const result = service.getCollectionRule(req.params.id, getCompanyId(req));
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async createCollectionRule(req, res, next) {
    try {
      const result = service.createCollectionRule(getCompanyId(req), req.body, req.user.userId);
      res.status(201).json(successResponse(result));
    } catch (err) { next(err); }
  }

  async updateCollectionRule(req, res, next) {
    try {
      const result = service.updateCollectionRule(req.params.id, getCompanyId(req), req.body, req.user.userId);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async deleteCollectionRule(req, res, next) {
    try {
      const result = service.deleteCollectionRule(req.params.id, getCompanyId(req));
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  // ── Dunning ──
  async runDunning(req, res, next) {
    try {
      const result = service.runDunning(getCompanyId(req), req.body.as_of_date);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async getDunningActions(req, res, next) {
    try {
      const result = service.listCollectionActions(getCompanyId(req), { ...req.query, action_type: req.query.action_type || 'EMAIL' });
      res.json(paginatedResponse(result.items, result.total, 1, result.limit));
    } catch (err) { next(err); }
  }

  // ── Collection Actions ──
  async listCollectionActions(req, res, next) {
    try {
      const result = service.listCollectionActions(getCompanyId(req), req.query);
      res.json(paginatedResponse(result.items, result.total, result.page || 1, result.limit || 50));
    } catch (err) { next(err); }
  }

  async getCollectionAction(req, res, next) {
    try {
      const result = service.getCollectionAction(req.params.id, getCompanyId(req));
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async createCollectionAction(req, res, next) {
    try {
      const result = service.createCollectionAction(getCompanyId(req), req.body, req.user.userId);
      res.status(201).json(successResponse(result));
    } catch (err) { next(err); }
  }

  async executeCollectionAction(req, res, next) {
    try {
      const result = service.executeCollectionAction(req.params.id, getCompanyId(req), req.user.userId, req.body.response_status);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  // ── Templates ──
  async listTemplates(req, res, next) {
    try {
      const result = service.listTemplates(getCompanyId(req), req.query);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async getTemplate(req, res, next) {
    try {
      const result = service.getTemplate(req.params.id, getCompanyId(req));
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async createTemplate(req, res, next) {
    try {
      const result = service.createTemplate(getCompanyId(req), req.body, req.user.userId);
      res.status(201).json(successResponse(result));
    } catch (err) { next(err); }
  }

  // ── Interest ──
  async listInterestRules(req, res, next) {
    try {
      const result = service.listInterestRules(getCompanyId(req), req.query);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async getInterestRule(req, res, next) {
    try {
      const result = service.getInterestRule(req.params.id, getCompanyId(req));
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async createInterestRule(req, res, next) {
    try {
      const result = service.createInterestRule(getCompanyId(req), req.body, req.user.userId);
      res.status(201).json(successResponse(result));
    } catch (err) { next(err); }
  }

  async calculateInterest(req, res, next) {
    try {
      const result = service.calculateInterest(getCompanyId(req), req.params.billId, req.query.calculation_date);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async createInterestCharge(req, res, next) {
    try {
      const result = service.createInterestCharge(getCompanyId(req), req.params.billId, req.body.calculation_date, req.user.userId);
      res.status(201).json(successResponse(result));
    } catch (err) { next(err); }
  }

  async approveInterestCharge(req, res, next) {
    try {
      const result = service.approveInterestCharge(req.params.id, getCompanyId(req), req.body.approved_amount, req.user.userId);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async postInterestCharge(req, res, next) {
    try {
      const result = service.postInterestCharge(req.params.id, getCompanyId(req), req.user.userId);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  // ── Bad Debt ──
  async listBadDebtCases(req, res, next) {
    try {
      const result = service.listBadDebtCases(getCompanyId(req), req.query);
      res.json(paginatedResponse(result.items, result.total, result.page || 1, result.limit || 50));
    } catch (err) { next(err); }
  }

  async getBadDebtCase(req, res, next) {
    try {
      const result = service.getBadDebtCase(req.params.id, getCompanyId(req));
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async createBadDebtCase(req, res, next) {
    try {
      const result = service.createBadDebtCase(getCompanyId(req), req.body, req.user.userId);
      res.status(201).json(successResponse(result));
    } catch (err) { next(err); }
  }

  async approveBadDebtCase(req, res, next) {
    try {
      const result = service.approveBadDebtCase(req.params.id, getCompanyId(req), req.user.userId);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async writeOffBadDebt(req, res, next) {
    try {
      const result = service.writeOffBadDebt(req.params.id, getCompanyId(req), req.user.userId);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async reverseBadDebtCase(req, res, next) {
    try {
      const result = service.reverseBadDebtCase(req.params.id, getCompanyId(req), req.user.userId);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  // ── Payment Plans ──
  async listPaymentPlans(req, res, next) {
    try {
      const result = service.listPaymentPlans(getCompanyId(req), req.query);
      res.json(paginatedResponse(result.items, result.total, result.page || 1, result.limit || 50));
    } catch (err) { next(err); }
  }

  async getPaymentPlan(req, res, next) {
    try {
      const result = service.getPaymentPlan(req.params.id, getCompanyId(req));
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async createPaymentPlan(req, res, next) {
    try {
      const result = service.createPaymentPlan(getCompanyId(req), req.body, req.user.userId);
      res.status(201).json(successResponse(result));
    } catch (err) { next(err); }
  }

  async approvePaymentPlan(req, res, next) {
    try {
      const result = service.approvePaymentPlan(req.params.id, getCompanyId(req), req.user.userId);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async cancelPaymentPlan(req, res, next) {
    try {
      const result = service.cancelPaymentPlan(req.params.id, getCompanyId(req), req.user.userId);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async applyPaymentToPlan(req, res, next) {
    try {
      const result = service.applyPaymentToPlan(getCompanyId(req), req.params.id, req.body.payment_id, req.body.amount);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  // ── Risk Scoring ──
  async calculateRiskScore(req, res, next) {
    try {
      const result = service.calculateRiskScore(getCompanyId(req), req.params.contactId);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  // ── Forecast ──
  async getCollectionForecast(req, res, next) {
    try {
      const result = service.getCollectionForecast(getCompanyId(req), req.query);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  // ── Escalation ──
  async createEscalation(req, res, next) {
    try {
      const result = service.createEscalation(getCompanyId(req), req.body.customer_id, req.body.bill_id, req.body.escalation_level, req.body.reason, req.user.userId);
      res.status(201).json(successResponse(result));
    } catch (err) { next(err); }
  }

  async listEscalations(req, res, next) {
    try {
      const result = service.listEscalations(getCompanyId(req), req.query);
      res.json(paginatedResponse(result.items, result.total, result.page || 1, result.limit || 50));
    } catch (err) { next(err); }
  }

  async approveEscalation(req, res, next) {
    try {
      const result = service.approveEscalation(req.params.id, getCompanyId(req), req.user.userId);
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  // ── Dashboard ──
  async getCollectionsDashboard(req, res, next) {
    try {
      const result = service.getCollectionsDashboard(getCompanyId(req));
      res.json(successResponse(result));
    } catch (err) { next(err); }
  }
}

module.exports = { CustomerBillController };
