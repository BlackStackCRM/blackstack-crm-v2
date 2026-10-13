const { AccountingBaseRepository } = require('./accounting-base.repository');
const { generateId } = require('../utils/generateId');
const { getPagination } = require('../utils/helpers');

/**
 * ReportingRepository — Step 13: Reports, Analytics & Financi...
 */
class ReportingRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'bills');
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _parseDate(d) {
    if (!d) return null;
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? null : dt.toISOString().split('T')[0];
  }

  _buildFilters(where, params, options = {}) {
    if (options.start_date) { where.push('b.issue_date >= ?'); params.push(this._parseDate(options.start_date)); }
    if (options.end_date) { where.push('b.issue_date <= ?'); params.push(this._parseDate(options.end_date)); }
    if (options.status) { where.push('b.status = ?'); params.push(options.status); }
    if (options.contactId) { where.push('b.contact_id = ?'); params.push(options.contactId); }
    if (options.customer_id) { where.push('b.contact_id = ?'); params.push(options.customer_id); }
    if (options.customerId) { where.push('b.contact_id = ?'); params.push(options.customerId); }
    if (options.salespersonId) { where.push('b.salesperson_id = ?'); params.push(options.salespersonId); }
    if (options.branchId) { where.push('b.branch_id = ?'); params.push(options.branchId); }
    if (options.warehouseId) { where.push('b.warehouse_id = ?'); params.push(options.warehouseId); }
    if (options.projectId) { where.push('b.project_id = ?'); params.push(options.projectId); }
    if (options.costCentreId) { where.push('b.cost_centre_id = ?'); params.push(options.costCentreId); }
    if (options.currency) { where.push('b.currency = ?'); params.push(options.currency); }
    if (options.overdue) { where.push('b.due_date < ? AND b.balance > 0'); params.push(new Date().toISOString().split('T')[0]); }
    if (options.minAmount) { where.push('b.total >= ?'); params.push(parseFloat(options.minAmount)); }
    if (options.maxAmount) { where.push('b.total <= ?'); params.push(parseFloat(options.maxAmount)); }
    return { where, params };
  }

  _safeSortColumn(col) {
    const allowed = ['issue_date', 'due_date', 'total', 'balance', 'bill_number', 'created_at'];
    return allowed.includes(col) ? `b.${col}` : 'b.issue_date';
  }

  // ─── Billing Dashboard KPIs (Phase 2) ─────────────────────────────────────
  getBillingDashboard(companyId, startDate, endDate) {
    const company = this._company(companyId);
    const from = this._parseDate(startDate) || '1900-01-01';
    const to = this._parseDate(endDate) || new Date().toISOString().split('T')[0];

    const row = this.conn.get(`
      SELECT
        COUNT(*) FILTER (WHERE issue_date BETWEEN ? AND ? AND bill_type = 'CUSTOMER') AS total_invoices,
        COALESCE(SUM(total) FILTER (WHERE status = 'POSTED' AND bill_type = 'CUSTOMER' AND issue_date BETWEEN ? AND ?), 0) AS total_billing,
        COALESCE(SUM(paid_amount) FILTER (WHERE status = 'POSTED' AND bill_type = 'CUSTOMER' AND issue_date BETWEEN ? AND ?), 0) AS total_collected,
        COALESCE(SUM(balance) FILTER (WHERE status != 'CANCELLED' AND bill_type = 'CUSTOMER' AND issue_date BETWEEN ? AND ?), 0) AS outstanding,
        COALESCE(SUM(balance) FILTER (WHERE status != 'CANCELLED' AND bill_type = 'CUSTOMER' AND due_date < ? AND balance > 0), 0) AS overdue,
        COALESCE(SUM(CASE WHEN due_date = date('now') AND balance > 0 THEN balance ELSE 0 END) FILTER (WHERE bill_type = 'CUSTOMER' AND status != 'CANCELLED'), 0) AS due_today,
        COUNT(*) FILTER (WHERE status = 'DRAFT' AND bill_type = 'CUSTOMER') AS draft,
        COUNT(*) FILTER (WHERE status = 'PENDING_APPROVAL' AND bill_type = 'CUSTOMER') AS pending_approval,
        COUNT(*) FILTER (WHERE status = 'POSTED' AND bill_type = 'CUSTOMER') AS posted,
        COUNT(*) FILTER (WHERE status = 'PARTIALLY_PAID' AND bill_type = 'CUSTOMER') AS partially_paid,
        COUNT(*) FILTER (WHERE status = 'PAID' AND bill_type = 'CUSTOMER') AS paid,
        COALESCE(SUM(cgst_amount) FILTER (WHERE bill_type = 'CUSTOMER' AND status = 'POSTED'), 0) AS cgst,
        COALESCE(SUM(sgst_amount) FILTER (WHERE bill_type = 'CUSTOMER' AND status = 'POSTED'), 0) AS sgst,
        COALESCE(SUM(igst_amount) FILTER (WHERE bill_type = 'CUSTOMER' AND status = 'POSTED'), 0) AS igst
      FROM bills b
      WHERE b.company_id = ?
    `, [from, to, from, to, from, to, from, to, to, company]);

    // Credit notes and debit notes from vouchers
    const vouchers = this.conn.get(`
      SELECT
        COALESCE(SUM(total_amount) FILTER (WHERE voucher_type = 'CREDIT_NOTE' AND status = 'POSTED'), 0) AS total_credit_notes,
        COALESCE(SUM(total_amount) FILTER (WHERE voucher_type = 'DEBIT_NOTE' AND status = 'POSTED'), 0) AS total_debit_notes
      FROM vouchers
      WHERE company_id = ?
    `, [company]);

    // Average invoice value
    const avgData = this.conn.get(`
      SELECT
        COALESCE(AVG(total) FILTER (WHERE status = 'POSTED' AND bill_type = 'CUSTOMER'), 0) AS avg_invoice_value
      FROM bills
      WHERE company_id = ?
    `, [company]);

    // Average collection days (days between invoice date and payment date)
    const collDays = this.conn.get(`
      SELECT COALESCE(AVG(julianday(p.payment_date) - julianday(b.issue_date)), 0) AS avg_days
      FROM bills b
      JOIN payments p ON p.bill_id = b.id AND p.company_id = b.company_id
      WHERE b.company_id = ? AND b.bill_type = 'CUSTOMER' AND b.status IN ('PAID', 'PARTIALLY_PAID')
    `, [company]);

    const totalCreditNotes = (parseFloat(vouchers.total_credit_notes) || 0);
    const totalDebitNotes = (parseFloat(vouchers.total_debit_notes) || 0);

    return {
      total_billing: parseFloat(row.total_billing) || 0,
      total_collected: parseFloat(row.total_collected) || 0,
      outstanding: parseFloat(row.outstanding) || 0,
      overdue: parseFloat(row.overdue) || 0,
      due_today: parseFloat(row.due_today) || 0,
      draft: parseInt(row.draft) || 0,
      draft_count: parseInt(row.draft) || 0,
      pending_approval: parseInt(row.pending_approval) || 0,
      pending_approval_count: parseInt(row.pending_approval) || 0,
      posted: parseInt(row.posted) || 0,
      posted_count: parseInt(row.posted) || 0,
      partially_paid: parseInt(row.partially_paid) || 0,
      partially_paid_count: parseInt(row.partially_paid) || 0,
      paid: parseInt(row.paid) || 0,
      paid_count: parseInt(row.paid) || 0,
      credit_notes: totalCreditNotes,
      credit_notes_count: totalCreditNotes,
      debit_notes: totalDebitNotes,
      debit_notes_count: totalDebitNotes,
      total_credit_notes: totalCreditNotes,
      total_debit_notes: totalDebitNotes,
      average_invoice_value: parseFloat(avgData.avg_invoice_value) || 0,
      average_collection_days: parseFloat(collDays.avg_days) || 0,
      invoice_count: parseInt(row.total_invoices) || 0,
      total_invoices: parseInt(row.total_invoices) || 0,
      cgst: parseFloat(row.cgst) || 0,
      sgst: parseFloat(row.sgst) || 0,
      igst: parseFloat(row.igst) || 0,
    };
  }

  // ─── Billing Trend (Phase 3) ──────────────────────────────────────────────
  getBillingTrend(companyId, options = {}) {
    const result = this._getBillingTrend(companyId, options);
    return { trend: result };
  }

  _getBillingTrend(companyId, options = {}) {
    const opts = { ...options };
    if (!opts.start_date && !opts.end_date && opts.months) {
      const today = new Date();
      opts.end_date = today.toISOString().split('T')[0];
      const past = new Date(today.getTime() - opts.months * 30 * 24 * 60 * 60 * 1000);
      opts.start_date = past.toISOString().split('T')[0];
    }
    const company = this._company(companyId);
    const from = this._parseDate(opts.start_date) || '1900-01-01';
    const to = this._parseDate(opts.end_date) || new Date().toISOString().split('T')[0];
    const period = options.period || 'monthly';

    let groupBy;
    switch (period) {
      case 'daily': groupBy = "STRFTIME('%Y-%m-%d', b.issue_date)"; break;
      case 'weekly': groupBy = "STRFTIME('%Y-W%W', b.issue_date)"; break;
      case 'monthly': groupBy = "STRFTIME('%Y-%m', b.issue_date)"; break;
      case 'quarterly': groupBy = "STRFTIME('%Y-Q%q', b.issue_date)"; break;
      case 'yearly': groupBy = "STRFTIME('%Y', b.issue_date)"; break;
      default: groupBy = "STRFTIME('%Y-%m', b.issue_date)";
    }

    const rows = this.conn.all(`
      SELECT
        ${groupBy} AS period,
        COUNT(*) AS invoice_count,
        COALESCE(SUM(total) FILTER (WHERE status = 'POSTED'), 0) AS gross_billing,
        COALESCE(SUM(discount_amount) FILTER (WHERE status = 'POSTED'), 0) AS discounts,
        COALESCE(SUM(cgst_amount) FILTER (WHERE status = 'POSTED'), 0) AS cgst,
        COALESCE(SUM(sgst_amount) FILTER (WHERE status = 'POSTED'), 0) AS sgst,
        COALESCE(SUM(igst_amount) FILTER (WHERE status = 'POSTED'), 0) AS igst,
        COALESCE(SUM(total) FILTER (WHERE status = 'POSTED'), 0) AS net_billing,
        COALESCE(SUM(paid_amount) FILTER (WHERE bill_type = 'CUSTOMER'), 0) AS collections
      FROM bills b
      WHERE b.company_id = ? AND b.bill_type = 'CUSTOMER'
        AND b.issue_date BETWEEN ? AND ?
      GROUP BY ${groupBy}
      ORDER BY ${groupBy}
    `, [company, from, to]);

    let periodFormat = "%Y-%m";
    if (period === 'daily') periodFormat = "%Y-%m-%d";
    else if (period === 'weekly') periodFormat = "%Y-W%W";
    else if (period === 'yearly') periodFormat = "%Y";
    else if (period === 'quarterly') periodFormat = "%Y-Q%q";

    const voucherRows = this.conn.all(`
      SELECT
        STRFTIME('${periodFormat}', v.voucher_date) AS period,
        v.voucher_type,
        SUM(v.total_amount) AS amount
      FROM vouchers v
      WHERE v.company_id = ? AND v.contact_id IS NOT NULL
        AND v.voucher_date BETWEEN ? AND ?
      GROUP BY 1, v.voucher_type
    `, [company, from, to]);

    const cnByPeriod = {};
    const dnByPeriod = {};
    for (const vr of voucherRows) {
      if (vr.voucher_type === 'CREDIT_NOTE') {
        cnByPeriod[vr.period] = (cnByPeriod[vr.period] || 0) + parseFloat(vr.amount || 0);
      } else if (vr.voucher_type === 'DEBIT_NOTE') {
        dnByPeriod[vr.period] = (dnByPeriod[vr.period] || 0) + parseFloat(vr.amount || 0);
      }
    }

    return rows.map(r => ({
      period: r.period,
      invoice_count: parseInt(r.invoice_count) || 0,
      gross_billing: parseFloat(r.gross_billing) || 0,
      discounts: parseFloat(r.discounts) || 0,
      taxable_sales: parseFloat(r.gross_billing) || 0,
      cgst: parseFloat(r.cgst) || 0,
      sgst: parseFloat(r.sgst) || 0,
      igst: parseFloat(r.igst) || 0,
      net_billing: parseFloat(r.net_billing) || 0,
      collections: parseFloat(r.collections) || 0,
      credit_notes: cnByPeriod[r.period] || 0,
      debit_notes: dnByPeriod[r.period] || 0,
    }));
  }

  // ─── Sales Register (Phase 4) ────────────────────────────────────────────
  getSalesRegister(companyId, options = {}) {
    const company = this._company(companyId);
    const page = Math.max(parseInt(options.page) || 1, 1);
    const limit = Math.min(parseInt(options.limit) || 20, 1000);
    const offset = (page - 1) * limit;

    const where = ['b.company_id = ?', 'b.bill_type = ?'];
    const params = [company, 'CUSTOMER'];

    // Apply filters using _buildFilters pattern
    const filtered = this._buildFilters(where, params, options);

    if (options.billNumber) {
      where.push('b.bill_number LIKE ?');
      params.push(`%${options.billNumber}%`);
    }

    const whereStr = where.join(' AND ');
    const sortCol = this._safeSortColumn(options.sortBy || 'issue_date');
    const sortDir = options.sortDir || 'DESC';

    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM bills b WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;

    const items = this.conn.all(`
      SELECT
        b.id AS bill_id, b.bill_number, b.bill_number AS invoice_number, b.issue_date AS invoice_date, b.due_date,
        b.total AS grand_total, b.total, b.subtotal, b.tax,
        b.discount_amount, b.cgst_amount, b.sgst_amount, b.igst_amount,
        b.other_charges, b.balance AS outstanding, b.paid_amount AS paid,
        b.status AS invoice_status,
        b.currency, b.company_id,
        c.id AS customer_id, c.first_name, c.last_name, c.gstin, c.customer_code,
        o.name AS organization_name,
        u.full_name AS salesperson
      FROM bills b
      JOIN contacts c ON c.id = b.contact_id AND c.company_id = b.company_id
      LEFT JOIN organizations o ON o.id = c.organization_id AND o.company_id = b.company_id
      LEFT JOIN users u ON u.id = b.salesperson_id AND u.company_id = b.company_id
      WHERE ${whereStr}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const summaryRow = this.conn.get(`
      SELECT
        COALESCE(SUM(b.total), 0) AS total_amount,
        COALESCE(SUM(b.subtotal), 0) AS total_taxable,
        COALESCE(SUM(b.tax), 0) AS total_tax,
        COALESCE(SUM(b.cgst_amount), 0) AS total_cgst,
        COALESCE(SUM(b.sgst_amount), 0) AS total_sgst,
        COALESCE(SUM(b.igst_amount), 0) AS total_igst,
        COALESCE(SUM(b.other_charges), 0) AS total_other_charges,
        COALESCE(SUM(b.discount_amount), 0) AS total_discount,
        COALESCE(SUM(b.paid_amount), 0) AS total_paid,
        COUNT(*) AS invoice_count
      FROM bills b
      WHERE ${whereStr}
    `, params);

    return {
      items: items.map(item => ({
        ...item,
        customer: `${item.first_name || ''} ${item.last_name || ''}`.trim(),
      })),
      total,
      summary: {
        total_amount: parseFloat(summaryRow.total_amount) || 0,
        total_taxable: parseFloat(summaryRow.total_taxable) || 0,
        total_tax: parseFloat(summaryRow.total_tax) || 0,
        total_cgst: parseFloat(summaryRow.total_cgst) || 0,
        total_sgst: parseFloat(summaryRow.total_sgst) || 0,
        total_igst: parseFloat(summaryRow.total_igst) || 0,
        total_other_charges: parseFloat(summaryRow.total_other_charges) || 0,
        total_discount: parseFloat(summaryRow.total_discount) || 0,
        total_paid: parseFloat(summaryRow.total_paid) || 0,
        invoice_count: parseInt(summaryRow.invoice_count) || 0,
      },
      page,
      limit,
      total_pages: Math.ceil(total / limit),
    };
  }

  getInvoiceRegister(companyId, options = {}) {
    return this.getSalesRegister(companyId, options);
  }

  // ─── Customer Outstanding Report (Phase 6) ──────────────────────────────
  getCustomerOutstandingReport(companyId, options = {}) {
    const company = this._company(companyId);
    const page = Math.max(parseInt(options.page) || 1, 1);
    const limit = Math.min(parseInt(options.limit) || 20, 1000);
    const offset = (page - 1) * limit;

    const where = ['b.company_id = ?', 'b.bill_type = ?'];
    const params = [company, 'CUSTOMER'];

    if (options.contactId) { where.push('b.contact_id = ?'); params.push(options.contactId); }
    if (options.customerId) { where.push('b.contact_id = ?'); params.push(options.customerId); }
    if (options.salespersonId) { where.push('b.salesperson_id = ?'); params.push(options.salespersonId); }
    if (options.branchId) { where.push('b.branch_id = ?'); params.push(options.branchId); }
    if (options.overdue) { where.push('b.due_date < ? AND b.balance > 0'); params.push(new Date().toISOString().split('T')[0]); }
    if (options.minAmount) { where.push('b.total >= ?'); params.push(parseFloat(options.minAmount)); }
    if (options.maxAmount) { where.push('b.total <= ?'); params.push(parseFloat(options.maxAmount)); }
    if (options.start_date) { where.push('b.issue_date >= ?'); params.push(this._parseDate(options.start_date)); }
    if (options.end_date) { where.push('b.issue_date <= ?'); params.push(this._parseDate(options.end_date)); }

    const whereStr = where.join(' AND ');

    const items = this.conn.all(`
      SELECT
        c.id AS contact_id, c.first_name, c.last_name, c.customer_code, c.gstin,
        c.phone, c.email,
        COALESCE(cr.credit_limit, 0) AS credit_limit,
        COALESCE(cr.credit_period_days, 30) AS credit_days,
        COALESCE(SUM(CASE WHEN b.status NOT IN ('CANCELLED', 'VOID', 'DRAFT', 'PENDING_APPROVAL', 'APPROVED')
          THEN b.total ELSE 0 END), 0) AS total_invoiced,
        COALESCE(SUM(CASE WHEN ba.amount IS NOT NULL THEN ba.amount ELSE 0 END), 0) AS total_paid,
        COALESCE(SUM(CASE WHEN b.status NOT IN ('CANCELLED', 'VOID') THEN b.balance ELSE 0 END), 0) AS outstanding,
        COALESCE(MIN(CASE WHEN b.due_date IS NOT NULL THEN b.due_date END), NULL) AS oldest_due_date,
        COALESCE(MAX(CASE WHEN b.due_date < date('now') AND b.balance > 0
          THEN CAST(julianday('now') - julianday(b.due_date) AS INTEGER) END), 0) AS oldest_overdue_days
      FROM bills b
      JOIN contacts c ON c.id = b.contact_id AND c.company_id = b.company_id
      LEFT JOIN credit_rules cr ON cr.contact_id = c.id AND cr.company_id = b.company_id
      LEFT JOIN collection_assignments ca ON ca.contact_id = c.id AND ca.company_id = c.company_id AND ca.status = 'ACTIVE'
      LEFT JOIN bill_allocations ba ON ba.bill_id = b.id
        AND ba.journal_entry_id IN (SELECT id FROM journal_entries WHERE company_id = ? AND status = 'POSTED')
      WHERE ${whereStr}
      GROUP BY c.id
      ORDER BY outstanding DESC
      LIMIT ? OFFSET ?
    `, [...params, company, limit, offset]);

    const summaryRow = this.conn.get(`
      SELECT
        COALESCE(SUM(b.balance), 0) AS total_outstanding,
        COUNT(DISTINCT c.id) AS customer_count
      FROM bills b
      JOIN contacts c ON c.id = b.contact_id AND c.company_id = b.company_id
      WHERE b.company_id = ? AND b.bill_type = 'CUSTOMER' AND b.status NOT IN ('CANCELLED', 'VOID')
    `, [company]);

    return {
      items: items.map(item => ({
        ...item,
        customer: `${item.first_name || ''} ${item.last_name || ''}`.trim(),
        outstanding: parseFloat(item.outstanding) || 0,
        available_credit: (parseFloat(item.credit_limit) || 0) - (parseFloat(item.outstanding) || 0),
      })),
      total: items.length,
      totals: {
        outstanding: parseFloat(summaryRow.total_outstanding) || 0,
        overdue: 0,
        current: 0,
        due_today: 0,
        customer_count: parseInt(summaryRow.customer_count) || 0,
      },
      page,
      limit,
      total_pages: Math.ceil(items.length / limit),
    };
  }

  // ─── Aging Distribution (Phase 31 charts) ─────────────────────────────────
  getAgingDistribution(companyId, options = {}) {
    const company = this._company(companyId);
    const row = this.conn.get(`
      SELECT
        COALESCE(SUM(CASE WHEN b.due_date >= date('now') THEN b.balance ELSE 0 END), 0) AS current,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(b.due_date) AS INTEGER) BETWEEN 1 AND 30 THEN b.balance ELSE 0 END), 0) AS bucket_1_30,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(b.due_date) AS INTEGER) BETWEEN 31 AND 60 THEN b.balance ELSE 0 END), 0) AS bucket_31_60,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(b.due_date) AS INTEGER) BETWEEN 61 AND 90 THEN b.balance ELSE 0 END), 0) AS bucket_61_90,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(b.due_date) AS INTEGER) BETWEEN 91 AND 120 THEN b.balance ELSE 0 END), 0) AS bucket_91_120,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(b.due_date) AS INTEGER) > 120 THEN b.balance ELSE 0 END), 0) AS bucket_120_plus
      FROM bills b
      WHERE b.company_id = ? AND b.bill_type = 'CUSTOMER'
        AND b.status NOT IN ('CANCELLED', 'VOID')
        AND b.balance > 0
    `, [company]);

    return {
      current: parseFloat(row.current) || 0,
      '1-30': parseFloat(row.bucket_1_30) || 0,
      '31-60': parseFloat(row.bucket_31_60) || 0,
      '61-90': parseFloat(row.bucket_61_90) || 0,
      '91-120': parseFloat(row.bucket_91_120) || 0,
      '120+': parseFloat(row.bucket_120_plus) || 0,
    };
  }

  // ─── Payment Register (Phase 9) ───────────────────────────────────────────
  getPaymentRegister(companyId, options = {}) {
    const company = this._company(companyId);
    const page = Math.max(parseInt(options.page) || 1, 1);
    const limit = Math.min(parseInt(options.limit) || 20, 1000);
    const offset = (page - 1) * limit;

    const where = ['p.company_id = ?'];
    const params = [company];

    if (options.start_date) { where.push('p.payment_date >= ?'); params.push(this._parseDate(options.start_date)); }
    if (options.end_date) { where.push('p.payment_date <= ?'); params.push(this._parseDate(options.end_date)); }
    if (options.contactId) { where.push('p.contact_id = ?'); params.push(options.contactId); }
    if (options.customerId) { where.push('p.contact_id = ?'); params.push(options.customerId); }
    if (options.paymentMethod) { where.push('p.payment_method = ?'); params.push(options.paymentMethod); }
    if (options.billId) { where.push('p.bill_id = ?'); params.push(options.billId); }
    if (options.status) { where.push('p.status = ?'); params.push(options.status); }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM payments p WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;

    const items = this.conn.all(`
      SELECT
        p.id, p.payment_number AS receipt_number, p.payment_date, p.amount,
        p.payment_method, p.reference_number, p.status, p.created_at,
        c.id AS customer_id, c.first_name, c.last_name,
        c.customer_code, b.bill_number AS invoice_number, b.id AS bill_id,
        p.company_id
      FROM payments p
      LEFT JOIN contacts c ON c.id = p.contact_id AND c.company_id = p.company_id
      LEFT JOIN bills b ON b.id = p.bill_id AND b.company_id = p.company_id
      WHERE ${whereStr}
      ORDER BY p.payment_date DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    // Get allocation info separately (since bill_allocations is per-bill)
    const itemsWithAllocation = items.map(item => {
      const allocationRow = this.conn.get(`
        SELECT
          COALESCE(SUM(ba.amount), 0) AS allocated_amount,
          COUNT(DISTINCT ba.bill_id) AS invoice_count
        FROM bill_allocations ba
        JOIN journal_entries je ON je.id = ba.journal_entry_id
        WHERE je.company_id = ? AND ba.bill_id = ?
      `, [company, item.bill_id]);

      const allocated = parseFloat(allocationRow?.allocated_amount) || 0;
      const unallocated = (parseFloat(item.amount) || 0) - allocated;

      return {
        ...item,
        amount: parseFloat(item.amount) || 0,
        allocated_amount: allocated,
        unallocated_amount: unallocated,
        allocation_status: allocated >= item.amount ? 'FULLY_ALLOCATED'
          : allocated > 0 ? 'PARTIALLY_ALLOCATED'
          : 'UNALLOCATED',
        invoice_count: parseInt(allocationRow?.invoice_count) || 0,
        customer: `${item.first_name || ''} ${item.last_name || ''}`.trim(),
      };
    });

    const summaryRow = this.conn.get(`
      SELECT
        COALESCE(SUM(p.amount), 0) AS total_amount,
        COUNT(*) AS payment_count
      FROM payments p
      WHERE ${whereStr}
    `, params);

    return {
      items: itemsWithAllocation,
      total,
      summary: {
        total_amount: parseFloat(summaryRow.total_amount) || 0,
        payment_count: parseInt(summaryRow.payment_count) || 0,
      },
      page,
      limit,
      total_pages: Math.ceil(total / limit),
    };
  }

  // ─── Collection Report (Phase 10) ─────────────────────────────────────────
  getCollectionReport(companyId, options = {}) {
    const company = this._company(companyId);
    const page = Math.max(parseInt(options.page) || 1, 1);
    const limit = Math.min(parseInt(options.limit) || 20, 1000);
    const offset = (page - 1) * limit;

    const where = ['b.company_id = ?'];
    const params = [company];

    if (options.contactId) { where.push('b.contact_id = ?'); params.push(options.contactId); }
    if (options.overdue) { where.push('b.due_date < ? AND b.balance > 0'); params.push(new Date().toISOString().split('T')[0]); }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM bills b WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;

    const items = this.conn.all(`
      SELECT
        b.id AS bill_id, b.bill_number, b.issue_date, b.due_date, b.total, b.balance,
        c.id AS contact_id, c.first_name, c.last_name, c.customer_code,
        COALESCE(julianday('now') - julianday(b.due_date), 0) AS days_overdue,
        COALESCE(u.full_name, 'Unassigned') AS collection_owner,
        pp.promise_date, pp.promise_amount, pp.status AS promise_status,
        cd.status AS dispute_status,
        CASE
          WHEN b.status = 'PAID' THEN 'COLLECTED'
          WHEN b.due_date < date('now') AND b.balance > 0 THEN 'OVERDUE'
          WHEN pp.status = 'PROMISED' THEN 'PROMISED'
          WHEN cd.status IS NOT NULL THEN 'DISPUTED'
          ELSE 'OPEN'
        END AS collection_status
      FROM bills b
      JOIN contacts c ON c.id = b.contact_id AND c.company_id = b.company_id
      LEFT JOIN collection_assignments ca ON ca.contact_id = c.id AND ca.company_id = c.company_id AND ca.status = 'ACTIVE'
      LEFT JOIN users u ON u.id = ca.owner_id AND u.company_id = c.company_id
      LEFT JOIN promises_to_pay pp ON pp.contact_id = c.id AND pp.company_id = c.company_id AND pp.status = 'PROMISED'
      LEFT JOIN customer_disputes cd ON cd.contact_id = c.id AND cd.company_id = c.company_id AND cd.status IN ('OPEN', 'IN_REVIEW')
      WHERE ${whereStr}
      ORDER BY b.due_date ASC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return {
      items: items.map(item => ({
        ...item,
        total: parseFloat(item.total) || 0,
        paid: (parseFloat(item.total) || 0) - (parseFloat(item.balance) || 0),
        outstanding: parseFloat(item.balance) || 0,
        days_overdue: parseInt(item.days_overdue) || 0,
        promise_amount: parseFloat(item.promise_amount) || 0,
      })),
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit),
    };
  }

  // ─── Collection Performance (Phase 11) ────────────────────────────────────
  getCollectionPerformance(companyId, options = {}) {
    const company = this._company(companyId);

    const summary = this.conn.get(`
      SELECT
        COUNT(DISTINCT c.id) AS total_assigned,
        COALESCE(SUM(b.balance), 0) AS total_outstanding,
        COALESCE(SUM(b.paid_amount), 0) AS total_collected,
        COALESCE(SUM(CASE WHEN b.due_date < date('now') AND b.balance > 0 THEN b.balance ELSE 0 END), 0) AS overdue_amount,
        COUNT(CASE WHEN pp.status = 'BROKEN' THEN 1 END) AS broken_promises,
        COUNT(CASE WHEN cd.status IN ('OPEN', 'IN_REVIEW') THEN 1 END) AS active_disputes
      FROM bills b
      JOIN contacts c ON c.id = b.contact_id AND c.company_id = b.company_id
      LEFT JOIN collection_assignments ca ON ca.contact_id = c.id AND ca.company_id = c.company_id AND ca.status = 'ACTIVE'
      LEFT JOIN promises_to_pay pp ON pp.contact_id = c.id AND pp.company_id = c.company_id
      LEFT JOIN customer_disputes cd ON cd.contact_id = c.id AND cd.company_id = c.company_id
      WHERE b.company_id = ? AND b.bill_type = 'CUSTOMER' AND b.status NOT IN ('CANCELLED', 'VOID')
    `, [company]);

    const collected = parseFloat(summary.total_collected) || 0;
    const outstanding = parseFloat(summary.total_outstanding) || 0;

    return {
      total_assigned: parseInt(summary.total_assigned) || 0,
      total_outstanding: outstanding,
      total_collected: collected,
      collection_rate: outstanding + collected > 0
        ? parseFloat((collected / (outstanding + collected) * 100).toFixed(2))
        : 0,
      overdue_amount: parseFloat(summary.overdue_amount) || 0,
      broken_promises: parseInt(summary.broken_promises) || 0,
      active_disputes: parseInt(summary.active_disputes) || 0,
      average_days_to_collect: 0,
    };
  }

  // ─── Overdue Analytics (Phase 19) ─────────────────────────────────────────
  getOverdueAnalytics(companyId, options = {}) {
    const company = this._company(companyId);

    const bucketRow = this.conn.get(`
      SELECT
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(due_date) AS INTEGER) > 0
          AND CAST(julianday('now') - julianday(due_date) AS INTEGER) <= 30 THEN balance ELSE 0 END), 0) AS bucket_1_30,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(due_date) AS INTEGER) > 30
          AND CAST(julianday('now') - julianday(due_date) AS INTEGER) <= 60 THEN balance ELSE 0 END), 0) AS bucket_31_60,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(due_date) AS INTEGER) > 60
          AND CAST(julianday('now') - julianday(due_date) AS INTEGER) <= 90 THEN balance ELSE 0 END), 0) AS bucket_61_90,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(due_date) AS INTEGER) > 90
          AND CAST(julianday('now') - julianday(due_date) AS INTEGER) <= 120 THEN balance ELSE 0 END), 0) AS bucket_91_120,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(due_date) AS INTEGER) > 120 THEN balance ELSE 0 END), 0) AS bucket_120_plus
      FROM bills
      WHERE company_id = ? AND bill_type = 'CUSTOMER'
        AND status NOT IN ('CANCELLED', 'VOID')
        AND due_date < date('now') AND balance > 0
    `, [company]);

    const summaryRow = this.conn.get(`
      SELECT
        COALESCE(SUM(balance), 0) AS total_overdue,
        COUNT(*) AS num_overdue_invoices,
        COALESCE(AVG(CAST(julianday('now') - julianday(due_date) AS INTEGER)), 0) AS avg_overdue_days,
        COALESCE(MAX(CAST(julianday('now') - julianday(due_date) AS INTEGER)), 0) AS max_overdue_days,
        COUNT(DISTINCT contact_id) AS customers_overdue
      FROM bills
      WHERE company_id = ? AND bill_type = 'CUSTOMER'
        AND status NOT IN ('CANCELLED', 'VOID')
        AND due_date < date('now') AND balance > 0
    `, [company]);

    return {
      total_overdue: parseFloat(summaryRow.total_overdue) || 0,
      num_overdue_invoices: parseInt(summaryRow.num_overdue_invoices) || 0,
      average_overdue_days: parseFloat(summaryRow.avg_overdue_days) || 0,
      max_overdue_days: parseInt(summaryRow.max_overdue_days) || 0,
      customers_overdue: parseInt(summaryRow.customers_overdue) || 0,
      bucket_1_30: parseFloat(bucketRow.bucket_1_30) || 0,
      bucket_31_60: parseFloat(bucketRow.bucket_31_60) || 0,
      bucket_61_90: parseFloat(bucketRow.bucket_61_90) || 0,
      bucket_91_120: parseFloat(bucketRow.bucket_91_120) || 0,
      bucket_120_plus: parseFloat(bucketRow.bucket_120_plus) || 0,
    };
  }

  // ─── Top Customers (Phase 20) ─────────────────────────────────────────────
  getTopCustomers(companyId, options = {}) {
    const company = this._company(companyId);
    const limit = Math.min(parseInt(options.limit) || 10, 100);
    const metric = options.metric || 'billing';

    let orderBy;
    switch (metric) {
      case 'billing': orderBy = 'total_invoiced DESC'; break;
      case 'collections': orderBy = 'total_collected DESC'; break;
      case 'outstanding': orderBy = 'outstanding DESC'; break;
      case 'overdue': orderBy = 'overdue DESC'; break;
      default: orderBy = 'total_invoiced DESC';
    }

    const rows = this.conn.all(`
      SELECT
        c.id AS contact_id, c.first_name, c.last_name, c.customer_code, c.gstin,
        COALESCE(SUM(CASE WHEN ba.amount IS NOT NULL THEN ba.amount ELSE 0 END), 0) AS total_collected,
        COALESCE(SUM(CASE WHEN b.status NOT IN ('CANCELLED', 'VOID', 'DRAFT', 'PENDING_APPROVAL', 'APPROVED')
          THEN b.total ELSE 0 END), 0) AS total_invoiced,
        COALESCE(SUM(b.balance), 0) AS outstanding,
        COALESCE(SUM(CASE WHEN b.due_date < date('now') AND b.balance > 0 THEN b.balance ELSE 0 END), 0) AS overdue
      FROM bills b
      JOIN contacts c ON c.id = b.contact_id AND c.company_id = b.company_id
      LEFT JOIN bill_allocations ba ON ba.bill_id = b.id
        AND ba.journal_entry_id IN (SELECT id FROM journal_entries WHERE company_id = ? AND status = 'POSTED')
      WHERE b.company_id = ? AND b.bill_type = 'CUSTOMER' AND b.status NOT IN ('CANCELLED', 'VOID')
      GROUP BY c.id
      ORDER BY ${orderBy}
      LIMIT ?
    `, [company, company, limit]);

    return {
      customers: rows.map(r => ({
        ...r,
        total_invoiced: parseFloat(r.total_invoiced) || 0,
        total_collected: parseFloat(r.total_collected) || 0,
        outstanding: parseFloat(r.outstanding) || 0,
        overdue: parseFloat(r.overdue) || 0,
      })),
      metric,
    };
  }

  // ─── Credit Note Register (Phase 12) ──────────────────────────────────────
  getCreditNoteRegister(companyId, options = {}) {
    const company = this._company(companyId);
    const page = Math.max(parseInt(options.page) || 1, 1);
    const limit = Math.min(parseInt(options.limit) || 20, 1000);
    const offset = (page - 1) * limit;

    const where = ["v.company_id = ?", "v.voucher_type = 'CREDIT_NOTE'"];
    const params = [company];

    if (options.start_date) { where.push('v.voucher_date >= ?'); params.push(this._parseDate(options.start_date)); }
    if (options.end_date) { where.push('v.voucher_date <= ?'); params.push(this._parseDate(options.end_date)); }
    if (options.contactId) { where.push('v.contact_id = ?'); params.push(options.contactId); }
    if (options.billId) { where.push('v.bill_id = ?'); params.push(options.billId); }
    if (options.status) { where.push('v.status = ?'); params.push(options.status); }
    if (options.reason) { where.push('v.description LIKE ?'); params.push(`%${options.reason}%`); }
    if (options.minAmount) { where.push('v.total_amount >= ?'); params.push(parseFloat(options.minAmount)); }
    if (options.maxAmount) { where.push('v.total_amount <= ?'); params.push(parseFloat(options.maxAmount)); }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM vouchers v WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;

    const items = this.conn.all(`
      SELECT
        v.id, v.voucher_number AS credit_note_number, v.voucher_date AS date,
        v.total_amount AS total, v.total_amount AS taxable_amount,
        v.description AS reason, v.status, v.created_by, v.created_at, v.updated_at,
        v.bill_id, b.bill_number AS original_invoice,
        c.id AS customer_id, c.first_name, c.last_name, c.gstin, c.customer_code,
        u.full_name AS created_by_name,
        COALESCE(va.applied_amount, 0) AS applied_amount
      FROM vouchers v
      LEFT JOIN bills b ON b.id = v.bill_id AND b.company_id = v.company_id
      LEFT JOIN contacts c ON c.id = v.contact_id AND c.company_id = v.company_id
      LEFT JOIN users u ON u.id = v.created_by AND u.company_id = v.company_id
      LEFT JOIN (
        SELECT bill_id, SUM(amount) AS applied_amount
        FROM bill_allocations
        WHERE company_id = ? AND bill_id IS NOT NULL
        GROUP BY bill_id
      ) va ON va.bill_id = v.bill_id
      WHERE ${whereStr}
      ORDER BY v.voucher_date DESC
      LIMIT ? OFFSET ?
    `, [company, ...params, limit, offset]);

    return {
      items: items.map(item => ({
        ...item,
        total: parseFloat(item.total) || 0,
        taxable_amount: parseFloat(item.taxable_amount) || 0,
        customer: item.first_name && item.last_name
          ? `${item.first_name} ${item.last_name}`
          : item.first_name || item.last_name || '',
      })),
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit),
    };
  }

  // ─── Debit Note Register (Phase 13) ──────────────────────────────────────
  getDebitNoteRegister(companyId, options = {}) {
    const company = this._company(companyId);
    const page = Math.max(parseInt(options.page) || 1, 1);
    const limit = Math.min(parseInt(options.limit) || 20, 1000);
    const offset = (page - 1) * limit;

    const where = ["v.company_id = ?", "v.voucher_type = 'DEBIT_NOTE'"];
    const params = [company];

    if (options.start_date) { where.push('v.voucher_date >= ?'); params.push(this._parseDate(options.start_date)); }
    if (options.end_date) { where.push('v.voucher_date <= ?'); params.push(this._parseDate(options.end_date)); }
    if (options.contactId) { where.push('v.contact_id = ?'); params.push(options.contactId); }
    if (options.billId) { where.push('v.bill_id = ?'); params.push(options.billId); }
    if (options.status) { where.push('v.status = ?'); params.push(options.status); }
    if (options.reason) { where.push('v.description LIKE ?'); params.push(`%${options.reason}%`); }
    if (options.minAmount) { where.push('v.total_amount >= ?'); params.push(parseFloat(options.minAmount)); }
    if (options.maxAmount) { where.push('v.total_amount <= ?'); params.push(parseFloat(options.maxAmount)); }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM vouchers v WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;

    const items = this.conn.all(`
      SELECT
        v.id, v.voucher_number AS debit_note_number, v.voucher_date AS date,
        v.total_amount AS total, v.total_amount AS taxable_amount,
        v.description AS reason, v.status, v.created_by, v.created_at, v.updated_at,
        v.bill_id, b.bill_number AS original_invoice,
        c.id AS customer_id, c.first_name, c.last_name, c.gstin, c.customer_code,
        u.full_name AS created_by_name
      FROM vouchers v
      LEFT JOIN bills b ON b.id = v.bill_id AND b.company_id = v.company_id
      LEFT JOIN contacts c ON c.id = v.contact_id AND c.company_id = v.company_id
      LEFT JOIN users u ON u.id = v.created_by AND u.company_id = v.company_id
      WHERE ${whereStr}
      ORDER BY v.voucher_date DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return {
      items: items.map(item => ({
        ...item,
        total: parseFloat(item.total) || 0,
        taxable_amount: parseFloat(item.taxable_amount) || 0,
        customer: item.first_name && item.last_name
          ? `${item.first_name} ${item.last_name}`
          : item.first_name || item.last_name || '',
      })),
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit),
    };
  }

  // ─── Tax / GST Report (Phase 14) ──────────────────────────────────────────
  getTaxReport(companyId, options = {}) {
    const company = this._company(companyId);
    const from = this._parseDate(options.start_date) || '1900-01-01';
    const to = this._parseDate(options.end_date) || new Date().toISOString().split('T')[0];

    const billsTax = this.conn.get(`
      SELECT
        COALESCE(SUM(subtotal), 0) AS taxable_sales,
        COALESCE(SUM(cgst_amount), 0) AS cgst,
        COALESCE(SUM(sgst_amount), 0) AS sgst,
        COALESCE(SUM(igst_amount), 0) AS igst,
        COALESCE(SUM(discount_amount), 0) AS discounts,
        COALESCE(SUM(total), 0) AS total_sales,
        COUNT(*) AS invoice_count
      FROM bills b
      WHERE b.company_id = ? AND b.bill_type = 'CUSTOMER'
        AND b.status = 'POSTED'
        AND b.issue_date BETWEEN ? AND ?
    `, [company, from, to]);

    const cnTax = this.conn.get(`
      SELECT COALESCE(SUM(total_amount), 0) AS total_amount FROM vouchers v
      WHERE v.company_id = ? AND v.voucher_type = 'CREDIT_NOTE'
        AND v.status = 'POSTED' AND v.voucher_date BETWEEN ? AND ?
    `, [company, from, to]);

    const dnTax = this.conn.get(`
      SELECT COALESCE(SUM(total_amount), 0) AS total_amount FROM vouchers v
      WHERE v.company_id = ? AND v.voucher_type = 'DEBIT_NOTE'
        AND v.status = 'POSTED' AND v.voucher_date BETWEEN ? AND ?
    `, [company, from, to]);

    const byRate = this.conn.all(`
      SELECT
        bi.tax_rate,
        COUNT(DISTINCT bi.bill_id) AS invoice_count,
        COALESCE(SUM(bi.total), 0) AS total
      FROM bill_items bi
      JOIN bills b ON b.id = bi.bill_id AND b.company_id = bi.company_id
      WHERE b.company_id = ? AND b.bill_type = 'CUSTOMER'
        AND b.status = 'POSTED'
        AND b.issue_date BETWEEN ? AND ?
      GROUP BY bi.tax_rate
      ORDER BY bi.tax_rate
    `, [company, from, to]);

    const cgst = parseFloat(billsTax.cgst) || 0;
    const sgst = parseFloat(billsTax.sgst) || 0;
    const igst = parseFloat(billsTax.igst) || 0;
    const totalTax = cgst + sgst + igst;
    const cnTotal = parseFloat(cnTax.total_amount) || 0;
    const dnTotal = parseFloat(dnTax.total_amount) || 0;

    const netTaxableSales = (parseFloat(billsTax.taxable_sales) || 0) -
      (parseFloat(billsTax.discounts) || 0) + dnTotal - cnTotal;

    return {
      taxable_sales: parseFloat(billsTax.taxable_sales) || 0,
      cgst: cgst,
      sgst: sgst,
      igst: igst,
      cess: 0,
      other_tax: 0,
      total_tax: parseFloat(totalTax.toFixed(2)) || 0,
      credit_note_tax: cnTotal,
      debit_note_tax: dnTotal,
      net_taxable_sales: parseFloat(netTaxableSales.toFixed(2)) || 0,
      net_output_tax: parseFloat(totalTax.toFixed(2)) || 0,
      discounts: parseFloat(billsTax.discounts) || 0,
      total_sales: parseFloat(billsTax.total_sales) || 0,
      invoice_count: parseInt(billsTax.invoice_count) || 0,
      by_rate: byRate.map(r => ({
        tax_rate: parseFloat(r.tax_rate) || 0,
        invoice_count: parseInt(r.invoice_count) || 0,
        taxable_amount: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        total: parseFloat(r.total) || 0,
      })),
    };
  }

  // ─── Salesperson Report (Phase 15) ────────────────────────────────────────
  getSalespersonReport(companyId, options = {}) {
    const company = this._company(companyId);
    const page = Math.max(parseInt(options.page) || 1, 1);
    const limit = Math.min(parseInt(options.limit) || 20, 1000);
    const offset = (page - 1) * limit;

    const from = this._parseDate(options.start_date) || '1900-01-01';
    const to = this._parseDate(options.end_date) || new Date().toISOString().split('T')[0];

    const items = this.conn.all(`
      SELECT
        u.id AS salesperson_id, u.full_name AS salesperson,
        COUNT(*) AS invoice_count,
        COALESCE(SUM(b.total), 0) AS gross_billing,
        COALESCE(SUM(b.discount_amount), 0) AS discounts,
        COALESCE(SUM(b.subtotal), 0) AS taxable_sales,
        COALESCE(SUM(b.tax), 0) AS tax,
        COALESCE(SUM(b.paid_amount), 0) AS collections,
        COALESCE(SUM(b.balance), 0) AS outstanding,
        COALESCE(SUM(CASE WHEN b.due_date < date('now') AND b.balance > 0 THEN b.balance ELSE 0 END), 0) AS overdue
      FROM bills b
      LEFT JOIN users u ON u.id = b.salesperson_id AND u.company_id = b.company_id
      WHERE b.company_id = ? AND b.bill_type = 'CUSTOMER'
        AND b.issue_date BETWEEN ? AND ?
      GROUP BY u.id, u.full_name
      ORDER BY gross_billing DESC
      LIMIT ? OFFSET ?
    `, [company, from, to, limit, offset]);

    const countRow = this.conn.get(`
      SELECT COUNT(DISTINCT u.id) as total
      FROM bills b
      LEFT JOIN users u ON u.id = b.salesperson_id AND u.company_id = b.company_id
      WHERE b.company_id = ? AND b.bill_type = 'CUSTOMER'
        AND b.issue_date BETWEEN ? AND ?
    `, [company, from, to]);
    const total = countRow?.total || 0;

    return {
      items: items.map(item => ({
        ...item,
        gross_billing: parseFloat(item.gross_billing) || 0,
        discounts: parseFloat(item.discounts) || 0,
        taxable_sales: parseFloat(item.taxable_sales) || 0,
        tax: parseFloat(item.tax) || 0,
        collections: parseFloat(item.collections) || 0,
        outstanding: parseFloat(item.outstanding) || 0,
        overdue: parseFloat(item.overdue) || 0,
        invoice_count: parseInt(item.invoice_count) || 0,
        avg_invoice_value: item.invoice_count > 0
          ? parseFloat((item.gross_billing / item.invoice_count).toFixed(2))
          : 0,
        collection_rate: (item.outstanding + item.collections) > 0
          ? parseFloat((item.collections / (item.outstanding + item.collections) * 100).toFixed(2))
          : 0,
      })),
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit),
    };
  }

  // ─── Product / Service Sales (Phase 16) ───────────────────────────────────
  getProductSalesReport(companyId, options = {}) {
    const company = this._company(companyId);
    const page = Math.max(parseInt(options.page) || 1, 1);
    const limit = Math.min(parseInt(options.limit) || 20, 1000);
    const offset = (page - 1) * limit;

    const from = this._parseDate(options.start_date) || '1900-01-01';
    const to = this._parseDate(options.end_date) || new Date().toISOString().split('T')[0];

    const items = this.conn.all(`
      SELECT
        bi.id AS item_id, bi.description AS product_name, bi.sku, bi.hsn_sac,
        bi.unit AS uom, bi.unit_price,
        COUNT(DISTINCT b.id) AS invoice_count,
        COUNT(DISTINCT c.id) AS customer_count,
        COALESCE(SUM(bi.quantity), 0) AS quantity,
        COALESCE(SUM(bi.total), 0) AS gross_sales,
        COALESCE(SUM(bi.discount), 0) AS discount,
        COALESCE(SUM(bi.taxable_amount), 0) AS taxable_sales,
        COALESCE(SUM(bi.total), 0) AS net_sales
      FROM bill_items bi
      JOIN bills b ON b.id = bi.bill_id AND b.company_id = bi.company_id
      LEFT JOIN contacts c ON c.id = b.contact_id AND c.company_id = b.company_id
      WHERE b.company_id = ?
        AND b.bill_type = 'CUSTOMER' AND b.status = 'POSTED'
        AND b.issue_date BETWEEN ? AND ?
      GROUP BY bi.id, bi.description, bi.sku, bi.hsn_sac, bi.unit
      ORDER BY gross_sales DESC
      LIMIT ? OFFSET ?
    `, [company, from, to, limit, offset]);

    const countRow = this.conn.get(`
      SELECT COUNT(DISTINCT bi.id) as total
      FROM bill_items bi
      JOIN bills b ON b.id = bi.bill_id AND b.company_id = bi.company_id
      WHERE b.company_id = ?
        AND b.bill_type = 'CUSTOMER' AND b.status = 'POSTED'
        AND b.issue_date BETWEEN ? AND ?
    `, [company, from, to]);
    const total = countRow?.total || 0;

    return {
      items: items.map(item => ({
        ...item,
        gross_sales: parseFloat(item.gross_sales) || 0,
        discount: parseFloat(item.discount) || 0,
        taxable_sales: parseFloat(item.taxable_sales) || 0,
        net_sales: parseFloat(item.net_sales) || 0,
        quantity: parseFloat(item.quantity) || 0,
        invoice_count: parseInt(item.invoice_count) || 0,
        customer_count: parseInt(item.customer_count) || 0,
      })),
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit),
    };
  }

  // ─── Branch / Warehouse Report (Phase 17) ─────────────────────────────────
  getBranchWarehouseReport(companyId, options = {}) {
    const company = this._company(companyId);
    const groupBy = options.group_by || 'branch';
    const from = this._parseDate(options.start_date) || '1900-01-01';
    const to = this._parseDate(options.end_date) || new Date().toISOString().split('T')[0];

    let branchJoin, branchCol;
    if (groupBy === 'warehouse') {
      // bills.warehouse_id is a free-text column with NO foreign key and is
      // currently never populated, so its intended target is not provable from
      // the schema. The previous join compared it to inventory_items.id (a
      // stock-item surrogate key), which is a different entity entirely and could
      // never match.
      //
      // Rather than guess, resolve it against both candidate masters and prefer a
      // godown (a warehouse is physically a godown in this schema; locations are
      // sites that CONTAIN godowns). If it turns out to be a location id instead,
      // the location branch picks it up and the label is still correct.
      branchJoin = `LEFT JOIN godowns w ON w.id = b.warehouse_id AND w.company_id = b.company_id
        LEFT JOIN locations wl ON wl.id = b.warehouse_id AND wl.company_id = b.company_id`;
      branchCol = "COALESCE(w.name, wl.name)";
    } else {
      branchJoin = 'LEFT JOIN organizations o ON o.id = b.branch_id AND o.company_id = b.company_id';
      branchCol = 'o.name';
    }

    const items = this.conn.all(`
      SELECT
        ${branchCol} AS branch_name,
        COUNT(*) AS invoice_count,
        COALESCE(SUM(b.total), 0) AS billing,
        COALESCE(SUM(b.paid_amount), 0) AS collections,
        COALESCE(SUM(b.balance), 0) AS outstanding,
        COALESCE(SUM(CASE WHEN b.due_date < date('now') AND b.balance > 0 THEN b.balance ELSE 0 END), 0) AS overdue
      FROM bills b
      ${branchJoin}
      WHERE b.company_id = ? AND b.bill_type = 'CUSTOMER' AND b.status = 'POSTED'
        AND b.issue_date BETWEEN ? AND ?
      GROUP BY ${branchCol}
      ORDER BY billing DESC
    `, [company, from, to]);

    return {
      items: items.map(item => ({
        ...item,
        billing: parseFloat(item.billing) || 0,
        collections: parseFloat(item.collections) || 0,
        outstanding: parseFloat(item.outstanding) || 0,
        overdue: parseFloat(item.overdue) || 0,
        invoice_count: parseInt(item.invoice_count) || 0,
        avg_invoice_value: item.invoice_count > 0
          ? parseFloat((item.billing / item.invoice_count).toFixed(2))
          : 0,
      })),
      total: items.length,
      group_by: groupBy,
    };
  }

  // ─── Collection Trend (Phase 18) ──────────────────────────────────────────
  getCollectionTrend(companyId, options = {}) {
    const company = this._company(companyId);
    const from = this._parseDate(options.start_date) || '1900-01-01';
    const to = this._parseDate(options.end_date) || new Date().toISOString().split('T')[0];
    const period = options.period || 'monthly';

    let groupBy;
    switch (period) {
      case 'daily': groupBy = "STRFTIME('%Y-%m-%d', p.payment_date)"; break;
      case 'weekly': groupBy = "STRFTIME('%Y-W%W', p.payment_date)"; break;
      case 'monthly': groupBy = "STRFTIME('%Y-%m', p.payment_date)"; break;
      case 'quarterly': groupBy = "STRFTIME('%Y-Q%q', p.payment_date)"; break;
      case 'yearly': groupBy = "STRFTIME('%Y', p.payment_date)"; break;
      default: groupBy = "STRFTIME('%Y-%m', p.payment_date)";
    }

    const rows = this.conn.all(`
      SELECT
        ${groupBy} AS period,
        COUNT(*) AS payment_count,
        COALESCE(SUM(p.amount), 0) AS collections,
        COALESCE(AVG(p.amount), 0) AS avg_payment
      FROM payments p
      WHERE p.company_id = ?
        AND p.payment_date BETWEEN ? AND ?
      GROUP BY ${groupBy}
      ORDER BY ${groupBy}
    `, [company, from, to]);

    return { trend: rows.map(r => ({
      period: r.period,
      payment_count: parseInt(r.payment_count) || 0,
      collections: parseFloat(r.collections) || 0,
      avg_payment: parseFloat(r.avg_payment) || 0,
    })) };
  }

  // ─── Payment Method Distribution (Phase 31 charts) ────────────────────────
  getPaymentMethodDistribution(companyId, options = {}) {
    const company = this._company(companyId);
    const from = this._parseDate(options.start_date) || '1900-01-01';
    const to = this._parseDate(options.end_date) || new Date().toISOString().split('T')[0];

    const methods = this.conn.all(`
      SELECT
        p.payment_method,
        COUNT(*) AS payment_count,
        COALESCE(SUM(p.amount), 0) AS total_amount,
        COALESCE(AVG(p.amount), 0) AS avg_amount
      FROM payments p
      WHERE p.company_id = ?
        AND p.payment_date BETWEEN ? AND ?
      GROUP BY p.payment_method
      ORDER BY total_amount DESC
    `, [company, from, to]);

    return {
      methods: methods.map(m => ({
        payment_method: m.payment_method,
        payment_count: parseInt(m.payment_count) || 0,
        total_amount: parseFloat(m.total_amount) || 0,
        avg_amount: parseFloat(m.avg_amount) || 0,
      })),
    };
  }
}

module.exports = { ReportingRepository };
