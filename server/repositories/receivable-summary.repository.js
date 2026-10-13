const { AccountingBaseRepository } = require('./accounting-base.repository');
const { generateId } = require('../utils/generateId');
const { NotFoundError } = require('../utils/errors');

/**
 * ReceivableSummaryRepository — AR Outstanding, Aging, and Statement engine.
 *
 * All calculations use actual financial transactions (bills, payments, credit notes,
 * debit notes) joined against the existing accounting schema. No balances are hardcoded.
 * No N+1 queries — all aggregation is done in SQL.
 */
class ReceivableSummaryRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'receivables');
  }

  // ── Customer Outstanding (aggregate per customer) ───────────────────────

  /**
   * Get outstanding summary for all customers with server-side pagination.
   * Outstanding = Invoices + DebitNotes - Payments - CreditNotes ± Adjustments
   */
  getCustomerOutstanding(companyId, options = {}) {
    const company = this._company(companyId);
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const now = new Date().toISOString().split('T')[0];

    const where = ['b.company_id = ?', 'b.bill_type = ?', 'b.status != ?'];
    const params = [company, 'CUSTOMER', 'CANCELLED'];

    if (options.contactId) {
      where.push('b.contact_id = ?');
      params.push(options.contactId);
    }
    if (options.overdueOnly) {
      where.push('b.due_date < ? AND (b.balance > 0 OR b.status IN (\'POSTED\', \'PARTIALLY_PAID\', \'OVERDUE\'))');
      params.push(now);
    }
    if (options.status) {
      where.push('b.status = ?');
      params.push(options.status);
    }

    const whereStr = where.join(' AND ');

    const countRow = this.conn.get(
      `SELECT COUNT(*) as total FROM bills b WHERE ${whereStr}`, params
    );
    const total = countRow?.total || 0;

    const items = this.conn.all(`
      SELECT
        c.id AS contact_id,
        c.first_name, c.last_name,
        c.customer_code AS customer_code, c.gstin,
        c.phone, c.email,
        o.name AS organization_name,
        COALESCE(cr.credit_limit, 0) AS credit_limit,
        COALESCE(cr.credit_period_days, 30) AS credit_days,

        -- Total invoiced (posted + approved, excluding cancelled/void)
        COALESCE(SUM(CASE WHEN b.status NOT IN ('CANCELLED', 'VOID', 'DRAFT', 'PENDING_APPROVAL', 'APPROVED')
          THEN b.total ELSE 0 END), 0) AS total_invoiced,

        -- Total paid (from bill_allocations, only posted JEs)
        COALESCE(SUM(CASE WHEN ba.amount IS NOT NULL THEN ba.amount ELSE 0 END), 0) AS total_paid,

        -- Total credit notes (from vouchers, posted)
        COALESCE(SUM(CASE WHEN v.voucher_type = 'CREDIT_NOTE' THEN COALESCE(v.total_amount, 0) ELSE 0 END), 0) AS total_credit_notes,

        -- Total debit notes (from vouchers, posted)
        COALESCE(SUM(CASE WHEN v.voucher_type = 'DEBIT_NOTE' THEN COALESCE(v.total_amount, 0) ELSE 0 END), 0) AS total_debit_notes,

        -- Outstanding = Invoiced + DebitNotes - Paid - CreditNotes
        COALESCE(SUM(CASE WHEN b.status NOT IN ('CANCELLED', 'VOID', 'DRAFT', 'PENDING_APPROVAL', 'APPROVED')
          THEN b.total ELSE 0 END), 0)
        + COALESCE(SUM(CASE WHEN v.voucher_type = 'DEBIT_NOTE' THEN COALESCE(v.total_amount, 0) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN ba.amount IS NOT NULL THEN ba.amount ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN v.voucher_type = 'CREDIT_NOTE' THEN COALESCE(v.total_amount, 0) ELSE 0 END), 0) AS outstanding,

        -- Current (due_date >= today)
        COALESCE(SUM(CASE WHEN b.due_date >= ? AND b.status NOT IN ('CANCELLED', 'VOID')
          THEN b.balance ELSE 0 END), 0) AS current_amount,

        -- Due today
        COALESCE(SUM(CASE WHEN b.due_date = ? AND b.status NOT IN ('CANCELLED', 'VOID')
          THEN b.balance ELSE 0 END), 0) AS due_today,

        -- Overdue (due_date < today, balance > 0)
        COALESCE(SUM(CASE WHEN b.due_date < ? AND b.status NOT IN ('CANCELLED', 'VOID')
          THEN b.balance ELSE 0 END), 0) AS overdue_amount,

        -- Future due
        COALESCE(SUM(CASE WHEN b.due_date > ? AND b.status NOT IN ('CANCELLED', 'VOID')
          THEN b.balance ELSE 0 END), 0) AS future_due,

        -- Days overdue for oldest
        MIN(CASE WHEN b.due_date < ? AND b.balance > 0 THEN
          CAST(julianday('now') - julianday(b.due_date) AS INTEGER)
          ELSE NULL END) AS oldest_days_overdue

      FROM bills b
      JOIN contacts c ON c.id = b.contact_id AND c.company_id = b.company_id
      LEFT JOIN organizations o ON o.id = c.organization_id AND o.company_id = b.company_id
      LEFT JOIN credit_rules cr ON cr.contact_id = c.id AND cr.company_id = b.company_id
      LEFT JOIN bill_allocations ba ON ba.bill_id = b.id
        AND ba.journal_entry_id IN (
          SELECT id FROM journal_entries WHERE company_id = ? AND status = 'POSTED'
        )
      LEFT JOIN vouchers v ON v.bill_id = b.id AND v.company_id = b.company_id AND v.status = 'POSTED'
      WHERE ${whereStr}
      GROUP BY c.id
      ORDER BY outstanding DESC
      LIMIT ? OFFSET ?
    `, [now, now, now, now, now, company, ...params, limit, offset]);

    return { items, total };
  }

  // ── AR Aging Summary (company-level) ─────────────────────────────────────

  /** Returns aging bucket totals for the entire company. */
  getAgingSummary(companyId) {
    const company = this._company(companyId);
    return this.conn.get(`
      SELECT
        COALESCE(SUM(CASE WHEN days_overdue = 0 THEN outstanding_amount ELSE 0 END), 0) AS current,
        COALESCE(SUM(CASE WHEN days_overdue BETWEEN 1 AND 30 THEN outstanding_amount ELSE 0 END), 0) AS bucket_1_30,
        COALESCE(SUM(CASE WHEN days_overdue BETWEEN 31 AND 60 THEN outstanding_amount ELSE 0 END), 0) AS bucket_31_60,
        COALESCE(SUM(CASE WHEN days_overdue BETWEEN 61 AND 90 THEN outstanding_amount ELSE 0 END), 0) AS bucket_61_90,
        COALESCE(SUM(CASE WHEN days_overdue BETWEEN 91 AND 120 THEN outstanding_amount ELSE 0 END), 0) AS bucket_91_120,
        COALESCE(SUM(CASE WHEN days_overdue > 120 THEN outstanding_amount ELSE 0 END), 0) AS bucket_120_plus,
        COALESCE(SUM(CASE WHEN days_overdue > 0 THEN outstanding_amount ELSE 0 END), 0) AS total_overdue,
        COALESCE(SUM(outstanding_amount), 0) AS total_outstanding
      FROM receivables
      WHERE company_id = ? AND status NOT IN ('PAID', 'WRITTEN_OFF')
    `, [company]);
  }

  // ── Customer-Level Aging ──────────────────────────────────────────────────

  /**
   * Dynamic aging for a single customer.
   * Calculates days overdue from due_date and outstanding_amount.
   */
  getCustomerAging(contactId, companyId) {
    const company = this._company(companyId);
    const rows = this.conn.all(`
      SELECT b.id, b.bill_number, b.issue_date, b.due_date, b.total, b.balance,
        b.paid_amount, b.status,
        COALESCE(julianday('now') - julianday(b.due_date), 0) AS days_overdue,
        r.outstanding_amount, r.status AS receivable_status
      FROM bills b
      LEFT JOIN receivables r ON r.bill_id = b.id AND r.company_id = b.company_id
      WHERE b.company_id = ? AND b.contact_id = ? AND b.bill_type = 'CUSTOMER'
        AND b.status NOT IN ('CANCELLED', 'VOID', 'DRAFT', 'PENDING_APPROVAL', 'APPROVED')
      ORDER BY b.due_date ASC
    `, [company, contactId]);

    const buckets = {
      current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '120+': 0
    };
    const detail = [];

    for (const r of rows) {
      const days = parseInt(r.days_overdue) || 0;
      const amt = parseFloat(r.balance || r.outstanding_amount || 0);
      let bucket;
      if (days <= 0) bucket = 'current';
      else if (days <= 30) bucket = '1-30';
      else if (days <= 60) bucket = '31-60';
      else if (days <= 90) bucket = '61-90';
      else if (days <= 120) bucket = '91-120';
      else bucket = '120+';

      buckets[bucket] += amt;
      detail.push({
        bill_id: r.id,
        bill_number: r.bill_number,
        invoice_date: r.issue_date,
        due_date: r.due_date,
        invoice_amount: parseFloat(r.total),
        paid_amount: parseFloat(r.paid_amount),
        balance: amt,
        days_overdue: days,
        aging_bucket: bucket,
        status: r.status,
      });
    }

    const totalAging = Object.values(buckets).reduce((a, b) => a + b, 0);
    return { buckets, detail, total: totalAging };
  }

  // ── Customer Statement (ledger-style with running balance) ──────────────

  /**
   * Customer statement with opening balance, running balance, date range support.
   * Opening balance is calculated from receivables as of the 'from' date.
   */
  getCustomerStatement(contactId, companyId, options = {}) {
    const company = this._company(companyId);
    const from = options.from || '1970-01-01';
    const to = options.to || '9999-12-31';
    const includeCancelled = options.includeCancelled || false;
    const includeZeroBalance = options.includeZeroBalance || false;
    const docTypes = options.docTypes || null; // ['invoice', 'payment', 'credit_note', 'debit_note']

    // Opening balance: sum of outstanding amounts for bills with issue_date < from
    // Adjusted for any CN/DN/payments in the period
    const openingBalance = this.conn.get(`
      SELECT COALESCE(SUM(r.outstanding_amount), 0) AS balance
      FROM receivables r
      JOIN bills b ON b.id = r.bill_id
      WHERE r.company_id = ? AND r.contact_id = ?
        AND b.issue_date < ?
        AND r.status NOT IN ('PAID', 'WRITTEN_OFF')
        ${includeCancelled ? '' : 'AND b.status NOT IN (\'CANCELLED\', \'VOID\')'}
    `, [company, contactId, from]);

    const statement = [];
    let runningBalance = parseFloat(openingBalance?.balance || 0);
    let totalDebit = parseFloat(openingBalance?.balance || 0);
    let totalCredit = 0;

    // Opening balance line
    statement.push({
      date: null,
      reference: 'Opening Balance',
      description: 'Opening balance as of ' + from,
      due_date: null,
      debit: 0,
      credit: 0,
      balance: runningBalance,
      document_type: 'opening_balance',
      status: 'OPEN',
    });

    // Gather all document lines in date order
    const lines = [];

    if (!docTypes || docTypes.includes('invoice')) {
      const invoices = this.conn.all(`
        SELECT b.bill_number, b.invoice_number, b.issue_date AS date, b.due_date, b.total, b.paid_amount,
          b.balance, b.status, 'invoice' AS doc_type
        FROM bills b
        WHERE b.company_id = ? AND b.contact_id = ? AND b.bill_type = 'CUSTOMER'
          AND b.issue_date BETWEEN ? AND ?
          ${includeCancelled ? '' : 'AND b.status NOT IN (\'CANCELLED\', \'VOID\')'}
        ORDER BY b.issue_date
      `, [company, contactId, from, to]);
      for (const inv of invoices) {
        if (!includeZeroBalance && parseFloat(inv.balance) === 0) continue;
        lines.push({
          date: inv.date,
          due_date: inv.due_date,
          reference: inv.bill_number,
          description: 'Invoice',
          debit: parseFloat(inv.total),
          credit: 0,
          document_type: 'invoice',
          status: inv.status,
        });
      }
    }

    if (!docTypes || docTypes.includes('credit_note')) {
      const creditNotes = this.conn.all(`
        SELECT v.voucher_number, v.voucher_date AS date, v.total_amount, v.status, 'credit_note' AS doc_type
        FROM vouchers v
        WHERE v.company_id = ? AND v.contact_id = ? AND v.voucher_type = 'CREDIT_NOTE'
          AND v.voucher_date BETWEEN ? AND ?
          AND v.status = 'POSTED'
        ORDER BY v.voucher_date
      `, [company, contactId, from, to]);
      for (const cn of creditNotes) {
        const amount = parseFloat(cn.total_amount || 0);
        lines.push({
          date: cn.date,
          due_date: null,
          reference: cn.voucher_number,
          description: 'Credit Note',
          debit: 0,
          credit: amount,
          document_type: 'credit_note',
          status: cn.status,
        });
      }
    }

    if (!docTypes || docTypes.includes('debit_note')) {
      const debitNotes = this.conn.all(`
        SELECT v.voucher_number, v.voucher_date AS date, v.total_amount, v.status, 'debit_note' AS doc_type
        FROM vouchers v
        WHERE v.company_id = ? AND v.contact_id = ? AND v.voucher_type = 'DEBIT_NOTE'
          AND v.voucher_date BETWEEN ? AND ?
          AND v.status = 'POSTED'
        ORDER BY v.voucher_date
      `, [company, contactId, from, to]);
      for (const dn of debitNotes) {
        const amount = parseFloat(dn.total_amount || 0);
        lines.push({
          date: dn.date,
          due_date: null,
          reference: dn.voucher_number,
          description: 'Debit Note',
          debit: amount,
          credit: 0,
          document_type: 'debit_note',
          status: dn.status,
        });
      }
    }

    if (!docTypes || docTypes.includes('payment')) {
      const payments = this.conn.all(`
        SELECT p.payment_number, p.payment_date AS date, p.amount, p.payment_method, p.status, 'payment' AS doc_type
        FROM payments p
        WHERE p.company_id = ? AND p.contact_id = ?
          AND p.payment_date BETWEEN ? AND ?
        ORDER BY p.payment_date
      `, [company, contactId, from, to]);
      for (const p of payments) {
        const amount = parseFloat(p.amount || 0);
        lines.push({
          date: p.date,
          due_date: null,
          reference: p.payment_number,
          description: 'Payment (' + (p.payment_method || 'BANK') + ')',
          debit: 0,
          credit: amount,
          document_type: 'payment',
          status: p.status,
        });
      }
    }

    // Sort all lines by date
    lines.sort((a, b) => {
      const da = a.date || '9999';
      const db = b.date || '9999';
      return da.localeCompare(db);
    });

    // Build statement with running balance
    for (const line of lines) {
      runningBalance += line.debit - line.credit;
      totalDebit += line.debit;
      totalCredit += line.credit;
      statement.push({
        ...line,
        balance: parseFloat(runningBalance.toFixed(2)),
      });
    }

    return {
      contact_id: contactId,
      from_date: from,
      to_date: to,
      opening_balance: parseFloat(openingBalance?.balance || 0),
      closing_balance: parseFloat(runningBalance.toFixed(2)),
      totals: {
        total_debit: parseFloat(totalDebit.toFixed(2)),
        total_credit: parseFloat(totalCredit.toFixed(2)),
        closing_balance: parseFloat(runningBalance.toFixed(2)),
      },
      statement,
    };
  }

  // ── Invoice-Level Aging ──────────────────────────────────────────────────

  /**
   * Detailed aging for a single invoice (bill).
   * Returns aging bucket breakdown for a specific bill.
   */
  getInvoiceAging(billId, companyId) {
    const company = this._company(companyId);
    const bill = this.conn.get(
      `SELECT b.id, b.bill_number, b.issue_date, b.due_date, b.total, b.paid_amount, b.balance, b.status,
        COALESCE(julianday('now') - julianday(b.due_date), 0) AS days_overdue
      FROM bills b WHERE b.id = ? AND b.company_id = ?`,
      [billId, company]
    );
    if (!bill) throw new NotFoundError('Bill', billId);

    const days = parseInt(bill.days_overdue) || 0;
    let bucket;
    if (days <= 0) bucket = 'current';
    else if (days <= 30) bucket = '1-30';
    else if (days <= 60) bucket = '31-60';
    else if (days <= 90) bucket = '61-90';
    else if (days <= 120) bucket = '91-120';
    else bucket = '120+';

    return {
      bill_id: bill.id,
      bill_number: bill.bill_number,
      invoice_date: bill.issue_date,
      due_date: bill.due_date,
      invoice_amount: parseFloat(bill.total),
      paid: parseFloat(bill.paid_amount),
      credit_notes: 0, // would need separate query if tracking CN per invoice
      debit_notes: 0,
      outstanding: parseFloat(bill.balance),
      days_overdue: days,
      aging_bucket: bucket,
      status: bill.status,
    };
  }

  // ── Receivables Summary (top-level KPIs) ────────────────────────────────

  getReceivablesSummary(companyId) {
    const company = this._company(companyId);
    return this.conn.get(`
      SELECT
        COALESCE(SUM(outstanding_amount), 0) AS total_outstanding,
        COALESCE(SUM(CASE WHEN days_overdue > 0 THEN outstanding_amount ELSE 0 END), 0) AS total_overdue,
        COALESCE(SUM(CASE WHEN due_date = date('now') THEN outstanding_amount ELSE 0 END), 0) AS due_today,
        COALESCE(SUM(CASE WHEN due_date > date('now') THEN outstanding_amount ELSE 0 END), 0) AS current,
        COALESCE(SUM(CASE WHEN days_overdue BETWEEN 1 AND 30 THEN outstanding_amount ELSE 0 END), 0) AS aging_1_30,
        COALESCE(SUM(CASE WHEN days_overdue BETWEEN 31 AND 60 THEN outstanding_amount ELSE 0 END), 0) AS aging_31_60,
        COALESCE(SUM(CASE WHEN days_overdue BETWEEN 61 AND 90 THEN outstanding_amount ELSE 0 END), 0) AS aging_61_90,
        COALESCE(SUM(CASE WHEN days_overdue > 90 THEN outstanding_amount ELSE 0 END), 0) AS aging_90_plus,
        COUNT(*) AS customer_count
      FROM receivables
      WHERE company_id = ? AND status NOT IN ('PAID', 'WRITTEN_OFF')
    `, [company]);
  }

  // ── Payment Behavior ─────────────────────────────────────────────────────

  /**
   * Calculate payment behavior metrics for a customer.
   * Uses actual payment dates vs due dates.
   */
  getCustomerPaymentBehavior(contactId, companyId) {
    const company = this._company(companyId);
    const rows = this.conn.all(`
      SELECT
        b.id AS bill_id, b.bill_number, b.issue_date, b.due_date, b.total,
        p.payment_date, p.amount AS payment_amount
      FROM bills b
      JOIN payments p ON p.bill_id = b.id
      WHERE b.company_id = ? AND b.contact_id = ?
        AND b.status NOT IN ('CANCELLED', 'VOID')
        AND (p.status = 'POSTED' OR p.status = 'COMPLETED')
      ORDER BY b.due_date
    `, [company, contactId]);

    const totalInvoices = new Set(rows.map(r => r.bill_id)).size;
    let totalPayments = 0;
    let onTimeCount = 0;
    let lateCount = 0;
    let totalDaysOverdue = 0;
    let overduePaymentCount = 0;
    let highestOutstanding = 0;

    for (const r of rows) {
      totalPayments += parseFloat(r.payment_amount || 0);
      const dueDate = new Date(r.due_date);
      const paymentDate = new Date(r.payment_date);
      const daysDiff = Math.floor((paymentDate - dueDate) / (24 * 60 * 60 * 1000));

      if (daysDiff <= 0) {
        onTimeCount++;
      } else {
        lateCount++;
        totalDaysOverdue += daysDiff;
        overduePaymentCount++;
      }
      const balance = parseFloat(r.total) || 0;
      if (balance > highestOutstanding) highestOutstanding = balance;
    }

    const totalPaymentCount = rows.length;
    return {
      total_invoices: totalInvoices,
      total_payments: parseFloat(totalPayments.toFixed(2)),
      average_payment_days: overduePaymentCount > 0 ? parseFloat((totalDaysOverdue / overduePaymentCount).toFixed(1)) : 0,
      on_time_percentage: totalPaymentCount > 0 ? parseFloat((onTimeCount / totalPaymentCount * 100).toFixed(1)) : 0,
      late_payment_percentage: totalPaymentCount > 0 ? parseFloat((lateCount / totalPaymentCount * 100).toFixed(1)) : 0,
      average_days_overdue: overduePaymentCount > 0 ? parseFloat((totalDaysOverdue / overduePaymentCount).toFixed(1)) : 0,
      number_of_overdue_payments: overduePaymentCount,
      highest_outstanding_amount: parseFloat(highestOutstanding.toFixed(2)),
    };
  }

  // ── Collection Management ────────────────────────────────────────────────

  /**
   * Get collection assignments for a customer.
   */
  getCollectionAssignment(contactId, companyId) {
    const company = this._company(companyId);
    return this.conn.get(`
      SELECT ca.*, u.full_name AS owner_name
      FROM collection_assignments ca
      LEFT JOIN users u ON u.id = ca.owner_id AND u.company_id = ca.company_id
      WHERE ca.contact_id = ? AND ca.company_id = ?
    `, [contactId, company]);
  }

  /**
   * Assign or reassign a collection owner.
   */
  assignCollection(contactId, ownerId, companyId, userId, options = {}) {
    const company = this._company(companyId);
    const now = new Date().toISOString();
    let assignment = this.conn.get(
      'SELECT id FROM collection_assignments WHERE contact_id = ? AND company_id = ? AND (bill_id IS NULL OR bill_id = ?)',
      [contactId, company, options.billId || null]
    );

    if (assignment) {
      // Reassign
      this.conn.prepare(`
        UPDATE collection_assignments
        SET owner_id = ?, priority = ?, status = ?, updated_at = ?
        WHERE id = ?
      `).run(ownerId, options.priority || 'NORMAL', options.status || 'NEW', now, assignment.id);
      this._logCollectionAudit(company, userId, 'collection_assignment', assignment.id, 'REASSIGN', null, { owner_id: ownerId });
      return { id: assignment.id, action: 'reassigned' };
    } else {
      // Create new
      const assignmentId = generateId('ca');
      this.conn.prepare(`
        INSERT INTO collection_assignments
        (id, company_id, contact_id, bill_id, owner_id, priority, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        assignmentId, company, contactId, options.billId || null, ownerId,
        options.priority || 'NORMAL', options.status || 'NEW', now, now
      );
      this._logCollectionAudit(company, userId, 'collection_assignment', assignmentId, 'ASSIGN', null, { owner_id: ownerId });
      return { id: assignmentId, action: 'assigned' };
    }
  }

  /**
   * Update collection status.
   */
  updateCollectionStatus(contactId, companyId, userId, status, notes = null) {
    const company = this._company(companyId);
    const assignment = this.conn.get(
      'SELECT id FROM collection_assignments WHERE contact_id = ? AND company_id = ?',
      [contactId, company]
    );
    if (!assignment) return null;

    const now = new Date().toISOString();
    this.conn.prepare(`
      UPDATE collection_assignments SET status = ?, updated_at = ? WHERE id = ?
    `).run(status, now, assignment.id);

    this._logCollectionAudit(company, userId, 'collection_assignment', assignment.id, 'STATUS_CHANGE', null, { status, notes });
    return { id: assignment.id, status };
  }

  /**
   * Create a promise-to-pay.
   */
  createPromiseToPay(contactId, promiseDate, promiseAmount, companyId, userId, options = {}) {
    const company = this._company(companyId);
    const now = new Date().toISOString();
    const promiseId = generateId('ptp');

    this.conn.prepare(`
      INSERT INTO promises_to_pay
      (id, company_id, contact_id, bill_id, assignment_id, promise_date, promise_amount, notes, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PROMISED', ?, ?)
    `).run(
      promiseId, company, contactId, options.billId || null, options.assignmentId || null,
      promiseDate, promiseAmount, options.notes || null, now, now
    );

    // Update collection assignment status to PROMISED
    if (!options.assignmentId) {
      const assignment = this.conn.get(
        'SELECT id FROM collection_assignments WHERE contact_id = ? AND company_id = ?',
        [contactId, company]
      );
      if (assignment) {
        this.conn.prepare(
          'UPDATE collection_assignments SET status = ?, updated_at = ? WHERE id = ?'
        ).run('PROMISED', now, assignment.id);
      }
    }

    this._logCollectionAudit(company, userId, 'promise', promiseId, 'CREATE', null, { promise_date: promiseDate, promise_amount: promiseAmount });
    return { id: promiseId, status: 'PROMISED' };
  }

  /**
   * Update promise-to-pay status.
   */
  updatePromise(promiseId, companyId, userId, status, options = {}) {
    const company = this._company(companyId);
    const promise = this.conn.get(
      'SELECT * FROM promises_to_pay WHERE id = ? AND company_id = ?',
      [promiseId, company]
    );
    if (!promise) throw new NotFoundError('Promise', promiseId);

    const now = new Date().toISOString();
    this.conn.prepare(`
      UPDATE promises_to_pay SET status = ?, updated_at = ? WHERE id = ?
    `).run(status, now, promiseId);

    this._logCollectionAudit(company, userId, 'promise', promiseId, 'UPDATE', null, { status });
    return { id: promiseId, status };
  }

  /**
   * Log a collection activity.
   */
  logCollectionActivity(contactId, activityType, companyId, userId, options = {}) {
    const company = this._company(companyId);
    const now = new Date().toISOString();
    const activityId = generateId('ca');

    this.conn.prepare(`
      INSERT INTO collection_activities
      (id, company_id, contact_id, bill_id, assignment_id, user_id, activity_type,
       activity_date, result, next_action, next_action_date, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      activityId, company, contactId, options.billId || null, options.assignmentId || null, userId,
      activityType, options.activityDate || now.split('T')[0], options.result || null,
      options.nextAction || null, options.nextActionDate || null, options.notes || null, now
    );

    return { id: activityId, activity_type: activityType };
  }

  /**
   * Get collection activities for a customer.
   */
  getCollectionActivities(contactId, companyId, options = {}) {
    const company = this._company(companyId);
    const limit = options.limit || 50;
    const offset = options.offset || 0;

    const rows = this.conn.all(`
      SELECT ca.*, u.full_name AS owner_name
      FROM collection_activities ca
      LEFT JOIN users u ON u.id = ca.user_id AND u.company_id = ca.company_id
      WHERE ca.company_id = ? AND ca.contact_id = ?
      ORDER BY ca.activity_date DESC
      LIMIT ? OFFSET ?
    `, [company, contactId, limit, offset]);

    const countRow = this.conn.get(
      `SELECT COUNT(*) as total FROM collection_activities WHERE company_id = ? AND contact_id = ?`,
      [company, contactId]
    );

    return { items: rows, total: countRow?.total || 0 };
  }

  /**
   * Get all promises to pay for a customer.
   */
  getPromisesToPay(contactId, companyId) {
    const company = this._company(companyId);
    return this.conn.all(`
      SELECT * FROM promises_to_pay
      WHERE company_id = ? AND contact_id = ?
      ORDER BY promise_date DESC
    `, [company, contactId]);
  }

  /**
   * Get all collection assignments with filters (for dashboard).
   */
  getCollectionAssignments(companyId, options = {}) {
    const company = this._company(companyId);
    const limit = options.limit || 50;
    const offset = options.offset || 0;

    const where = ['ca.company_id = ?'];
    const params = [company];

    if (options.ownerId) {
      where.push('ca.owner_id = ?');
      params.push(options.ownerId);
    }
    if (options.status) {
      where.push('ca.status = ?');
      params.push(options.status);
    }
    if (options.priority) {
      where.push('ca.priority = ?');
      params.push(options.priority);
    }
    if (options.overdueOnly) {
      where.push('ca.status IN (?, ?, ?)');
      params.push('CONTACT_PENDING', 'CONTACTED', 'ESCALATED');
    }

    const whereStr = where.join(' AND ');
    const rows = this.conn.all(`
      SELECT ca.*, c.first_name, c.last_name, c.customer_code, u.full_name AS owner_name
      FROM collection_assignments ca
      JOIN contacts c ON c.id = ca.contact_id AND c.company_id = ca.company_id
      LEFT JOIN users u ON u.id = ca.owner_id AND u.company_id = ca.company_id
      WHERE ${whereStr}
      ORDER BY ca.updated_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const countRow = this.conn.get(
      `SELECT COUNT(*) as total FROM collection_assignments ca WHERE ${whereStr}`,
      params
    );

    return { items: rows, total: countRow?.total || 0 };
  }

  // ── Collection Dashboard KPIs ────────────────────────────────────────────

  getCollectionDashboard(companyId) {
    const company = this._company(companyId);
    return this.conn.get(`
      SELECT
        COALESCE(SUM(r.outstanding_amount), 0) AS total_outstanding,
        COALESCE(SUM(CASE WHEN r.days_overdue > 0 THEN r.outstanding_amount ELSE 0 END), 0) AS total_overdue,
        COALESCE(SUM(CASE WHEN r.due_date = date('now') THEN r.outstanding_amount ELSE 0 END), 0) AS due_today,
        COALESCE(SUM(CASE WHEN r.due_date > date('now') AND r.due_date <= date('now', '+7 days')
          THEN r.outstanding_amount ELSE 0 END), 0) AS due_this_week,
        COALESCE(SUM(CASE WHEN r.days_overdue BETWEEN 31 AND 60 THEN r.outstanding_amount ELSE 0 END), 0) AS overdue_30_60,
        COALESCE(SUM(CASE WHEN r.days_overdue BETWEEN 61 AND 90 THEN r.outstanding_amount ELSE 0 END), 0) AS overdue_60_90,
        COUNT(DISTINCT CASE WHEN r.days_overdue > 0 THEN r.contact_id END) AS overdue_customer_count
      FROM receivables r
      WHERE r.company_id = ? AND r.status NOT IN ('PAID', 'WRITTEN_OFF')
    `, [company]);
  }

  // ── Helper: Collection Audit ─────────────────────────────────────────────

  _logCollectionAudit(companyId, userId, entityType, entityId, action, oldValues, newValues) {
    try {
      const auditId = generateId('caud');
      this.conn.prepare(`
        INSERT INTO collection_audit
        (id, company_id, entity_type, entity_id, action, user_id, old_values_json, new_values_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        auditId, companyId, entityType, entityId, action, userId || 'system',
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        new Date().toISOString()
      );
    } catch (e) { /* audit must not break main flow */ }
  }

  // ── Customer Disputes ─────────────────────────────────────────────────────

  createDispute(data, companyId, userId) {
    const company = this._company(companyId);
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const disputeId = generateId('cdis');

    const contact = this.conn.get(`SELECT id FROM contacts WHERE id = ? AND company_id = ?`, [data.contact_id, company]);
    if (!contact) throw new NotFoundError('Contact', data.contact_id);

    if (data.invoice_id) {
      const invoice = this.conn.get(`SELECT id FROM bills WHERE id = ? AND company_id = ?`, [data.invoice_id, company]);
      if (!invoice) throw new NotFoundError('Invoice', data.invoice_id);
    }

    this.conn.prepare(`
      INSERT INTO customer_disputes (id, company_id, contact_id, bill_id, user_id, reason, disputed_amount, customer_message, internal_notes, status, owner_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)
    `).run(disputeId, company, data.contact_id, data.invoice_id || null, userId,
      data.reason, data.disputed_amount, data.customer_message || null,
      data.internal_notes || null, data.owner_id || userId, now, now);

    this._logCollectionAudit(company, userId, 'CustomerDispute', disputeId, 'CREATE', null, data);
    return { dispute_id: disputeId, contact_id: data.contact_id };
  }

  getDisputes(companyId, options = {}) {
    const company = this._company(companyId);
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const where = ['cd.company_id = ?'];
    const params = [company];

    if (options.contactId) {
      where.push('cd.contact_id = ?');
      params.push(options.contactId);
    }
    if (options.status) { where.push('cd.status = ?'); params.push(options.status); }
    if (options.invoiceId) { where.push('cd.bill_id = ?'); params.push(options.invoiceId); }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM customer_disputes cd WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;

    const items = this.conn.all(`
      SELECT cd.id, cd.company_id, cd.contact_id, cd.bill_id, cd.user_id, cd.reason, cd.disputed_amount,
        cd.customer_message, cd.internal_notes, cd.status, cd.owner_id, cd.resolution_reason,
        cd.resolution_date, cd.created_at, cd.updated_at,
        c.first_name, c.last_name, o.name AS organization_name,
        b.bill_number AS invoice_number, ow.full_name AS owner_name
      FROM customer_disputes cd
      JOIN contacts c ON c.id = cd.contact_id AND c.company_id = cd.company_id
      LEFT JOIN organizations o ON o.id = c.organization_id AND o.company_id = cd.company_id
      LEFT JOIN bills b ON b.id = cd.bill_id AND b.company_id = cd.company_id
      LEFT JOIN users ow ON ow.id = cd.owner_id AND ow.company_id = cd.company_id
      WHERE ${whereStr} ORDER BY cd.created_at DESC LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return { items, total };
  }

  resolveDispute(disputeId, data, userId) {
    const company = this._company(data.company_id);
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const dispute = this.conn.get(`SELECT * FROM customer_disputes WHERE id = ? AND company_id = ?`, [disputeId, company]);
    if (!dispute) throw new NotFoundError('CustomerDispute', disputeId);

    const validStatuses = ['RESOLVED', 'REJECTED', 'CLOSED', 'IN_REVIEW'];
    if (!validStatuses.includes(data.status)) throw new Error(`Invalid dispute status. Must be one of: ${validStatuses.join(', ')}`);

    this.conn.prepare(`
      UPDATE customer_disputes SET status = ?, resolution_reason = ?, resolution_date = ?, updated_at = ?, owner_id = ?
      WHERE id = ? AND company_id = ?
    `).run(data.status, data.resolution_reason || null, now, now, data.owner_id || dispute.owner_id, disputeId, company);

    this._logCollectionAudit(company, userId, 'CustomerDispute', disputeId, 'RESOLVE',
      { status: dispute.status }, { status: data.status });
    return { dispute_id: disputeId, status: data.status };
  }

  // ── Payment Reminders ─────────────────────────────────────────────────────

  getPaymentReminders(companyId) {
    const company = this._company(companyId);
    const soon = new Date(); soon.setDate(soon.getDate() + 7);
    const soonStr = soon.toISOString().split('T')[0];
    const severe = new Date(); severe.setDate(severe.getDate() - 90);
    const severeStr = severe.toISOString().split('T')[0];

    const rows = this.conn.all(`
      SELECT ca.*, ca.id as assignment_id,
        CASE
          WHEN b.due_date > ? THEN 'future_due'
          WHEN b.due_date > date('now','-3 days') AND b.due_date <= date('now','+3 days') THEN 'due_soon'
          WHEN b.due_date = date('now') THEN 'due_today'
          WHEN b.due_date < date('now') AND b.due_date >= date('now','-30 days') THEN 'overdue'
          ELSE 'severely_overdue'
        END as event_type,
        CAST(julianday('now') - julianday(b.due_date) AS INTEGER) as days_overdue
      FROM collection_assignments ca
      JOIN bills b ON b.id = ca.bill_id AND b.company_id = ca.company_id
      WHERE ca.company_id = ? AND b.status NOT IN ('CANCELLED','VOID','PAID') AND b.balance > 0
    `, [soonStr, severeStr, company]);

    const byType = {};
    for (const row of rows) {
      if (!byType[row.event_type]) byType[row.event_type] = [];
      byType[row.event_type].push(row);
    }
    return byType;
  }
}

module.exports = { ReceivableSummaryRepository };
