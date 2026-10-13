const { JournalEntryRepository } = require('../repositories/journal-entry.repository');
const { VoucherRepository } = require('../repositories/voucher.repository');
const { ChartOfAccountsRepository } = require('../repositories/chart-of-accounts.repository');
const { FinancialYearRepository } = require('../repositories/billing-cost.repository');
const { AccountingAuditRepository } = require('../repositories/accounting-audit.repository');
const { Authorizer } = require('../auth/authorizer');
const { NotFoundError, ValidationError, AppError } = require('../utils/errors');
const { assertTenantRef } = require('../utils/tenantScope');
const { generateId } = require('../utils/generateId');

/**
 * Core double-entry accounting engine.
 * Guarantees: SUM(debits) = SUM(credits) for every posted transaction.
 * Uses database transactions so a failed line rolls back everything.
 */
class AccountingEngine {
  constructor(conn) {
    this.conn = conn;
    this.journalRepo = new JournalEntryRepository(conn);
    this.voucherRepo = new VoucherRepository(conn);
    this.accountRepo = new ChartOfAccountsRepository(conn);
    this.fyRepo = new FinancialYearRepository(conn);
    this.audit = new AccountingAuditRepository(conn);
  }

  /**
   * Validate a single journal line: account exists, is owned by tenant, is active.
   */
  _validateLine(line, companyId, accountCache) {
    const { account_id, debit_amount = 0, credit_amount = 0 } = line;
    if (!account_id) throw new ValidationError('Journal line missing account_id');

    if (!accountCache[account_id]) {
      const acc = this.accountRepo.findById(account_id, companyId);
      if (!acc) throw new ValidationError(`Account ${account_id} does not exist or is not owned by your company`);
      if (!acc.is_active) throw new ValidationError(`Account ${account_id} is not active`);
      accountCache[account_id] = acc;
    }

    const dr = parseFloat(debit_amount) || 0;
    const cr = parseFloat(credit_amount) || 0;
    if (dr < 0) throw new ValidationError('Debit amount cannot be negative');
    if (cr < 0) throw new ValidationError('Credit amount cannot be negative');
    if (dr > 0 && cr > 0) throw new ValidationError('A journal line cannot have both debit and credit amounts');
  }

  /**
   * Post a complete voucher + journal entry atomically.
   * Throws if debits != credits (before any writes happen).
   */
  postVoucher(data, context) {
    const companyId = context.companyId;
    Authorizer.assertPermission(context, 'accounting.create');

    // Validate financial year
    const fy = data.financial_year_id
      ? this.fyRepo.findById(data.financial_year_id, companyId)
      : this.fyRepo.getActive(companyId);
    if (!fy) throw new ValidationError('No active financial year found');
    if (fy.is_locked && !Authorizer.assertPermission(context, 'accounting.override_locked')) {
      throw new ValidationError('Financial year is locked');
    }

    // Validate contact/org/deal references (tenant-safe)
    if (data.contact_id) assertTenantRef(this.conn, companyId, 'contacts', data.contact_id);
    if (data.organization_id) assertTenantRef(this.conn, companyId, 'organizations', data.organization_id);
    if (data.deal_id) {
      const deal = this.conn.get('SELECT id FROM deals WHERE id = ? AND company_id = ?', [data.deal_id, companyId]);
      if (!deal) throw new ValidationError(`Deal ${data.deal_id} does not exist in your company`);
    }

    // Validate lines
    const lines = data.lines || [];
    if (lines.length === 0) throw new ValidationError('At least one journal line is required');
    const accountCache = {};
    let totalDebit = 0;
    let totalCredit = 0;
    for (const line of lines) {
      this._validateLine(line, companyId, accountCache);
      totalDebit += parseFloat(line.debit_amount) || 0;
      totalCredit += parseFloat(line.credit_amount) || 0;
    }

    // Double-entry validation: debits must equal credits
    const tolerance = 0.001;
    if (Math.abs(totalDebit - totalCredit) > tolerance) {
      throw new ValidationError(
        `Unbalanced journal entry: debits (${totalDebit.toFixed(2)}) != credits (${totalCredit.toFixed(2)})`
      );
    }

    if (totalDebit === 0 && totalCredit === 0) {
      throw new ValidationError('Journal entry has zero amounts');
    }

    const voucherNumber = data.voucher_number || this.voucherRepo.getNextVoucherNumber(data.voucher_type, companyId);
    const entryNumber = this._generateEntryNumber(companyId, data.voucher_type);
    const now = new Date().toISOString();

    const result = this.conn.transaction(() => {
      // Insert the voucher
      const voucherId = data.voucher_id || generateId('vch');
      const voucherSql = `INSERT INTO vouchers
        (id, company_id, voucher_number, voucher_type, financial_year_id, voucher_date,
         reference_number, description, contact_id, organization_id, deal_id, bill_id,
         currency, exchange_rate, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      this.conn.run(voucherSql, [
        voucherId, companyId, voucherNumber, data.voucher_type, fy.id, data.voucher_date,
        data.reference_number || null, data.description, data.contact_id || null, data.organization_id || null,
        data.deal_id || null, data.bill_id || null, data.currency || 'USD', data.exchange_rate || 1.0,
        'POSTED', context.userId, now, now
      ]);

      // Insert the journal entry
      const entryId = generateId('jnl');
      const entrySql = `INSERT INTO journal_entries
        (id, company_id, voucher_id, entry_number, entry_date, description, currency, exchange_rate,
         total_debit, total_credit, status, created_by, created_at, updated_at, posted_at, posted_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      this.conn.run(entrySql, [
        entryId, companyId, voucherId, entryNumber, data.voucher_date, data.description,
        data.currency || 'USD', data.exchange_rate || 1.0, totalDebit, totalCredit, 'POSTED',
        context.userId, now, now, now, context.userId
      ]);

      // Insert journal lines
      for (const line of lines) {
        const lineId = generateId('jln');
        const lineSql = `INSERT INTO journal_entry_lines
          (id, company_id, journal_entry_id, account_id, cost_centre_id, cost_category_id,
           debit_amount, credit_amount, description, reference_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        this.conn.run(lineSql, [
          lineId, companyId, entryId, line.account_id, line.cost_centre_id || null,
          line.cost_category_id || null,
          parseFloat(line.debit_amount) || 0,
          parseFloat(line.credit_amount) || 0,
          line.description, line.reference_id || null, now
        ]);
      }

      // Audit
      try {
        this.audit.log({
          id: generateId('aud'),
          company_id: companyId,
          user_id: context.userId || 'system',
          action: 'JOURNAL_POSTED',
          entity_type: 'JOURNAL_ENTRY',
          entity_id: entryId,
          new_values_json: JSON.stringify({ voucher_id: voucherId, entry_number: entryNumber, total_debit, total_credit, line_count: lines.length }),
          session_id: context.sessionId
        });
      } catch (e) { /* Audit logging must not break transactions */ }

      return {
        voucherId, entryId, voucherNumber, entryNumber,
        total_debit: totalDebit, total_credit: totalCredit
      };
    })();

    return result;
  }

  _generateEntryNumber(companyId, voucherType) {
    const typePrefix = {
      'JOURNAL': 'JV', 'PAYMENT': 'PY', 'RECEIPT': 'RC',
      'CONTRA': 'CT', 'CREDIT_NOTE': 'CN', 'DEBIT_NOTE': 'DN'
    }[voucherType] || 'JV';
    const year = new Date().getFullYear();
    const last = this.conn.get(
      `SELECT entry_number FROM journal_entries WHERE entry_number LIKE ? AND company_id = ? ORDER BY entry_number DESC LIMIT 1`,
      [`${typePrefix}-${year}-%`, companyId]
    );
    if (!last) return `${typePrefix}-${year}-000001`;
    const match = last.entry_number.match(/^(\w+)-(\d+)-(\d+)$/);
    if (!match) return `${typePrefix}-${year}-000001`;
    const seq = parseInt(match[3], 10) + 1;
    return `${typePrefix}-${year}-${String(seq).padStart(6, '0')}`;
  }

  /**
   * Cancel a voucher/journal entry. Does NOT delete — marks as CANCELLED.
   */
  cancelVoucher(voucherId, companyId, context) {
    Authorizer.assertPermission(context, 'accounting.cancel');
    const voucher = this.voucherRepo.findById(voucherId, companyId);
    if (!voucher) throw new NotFoundError('Voucher', voucherId);
    if (voucher.status !== 'POSTED') throw new ValidationError('Only posted vouchers can be cancelled');

    this.conn.transaction(() => {
      this.conn.run(
        'UPDATE vouchers SET status = ?, updated_at = ? WHERE id = ? AND company_id = ?',
        ['CANCELLED', new Date().toISOString(), voucherId, companyId]
      );
      this.conn.run(
        'UPDATE journal_entries SET status = ?, updated_at = ? WHERE voucher_id = ? AND company_id = ?',
        ['CANCELLED', new Date().toISOString(), voucherId, companyId]
      );

      try {
        this.audit.log({
          id: generateId('aud'),
          company_id: companyId,
          user_id: context.userId || 'system',
          action: 'VOUCHER_CANCELLED',
          entity_type: 'VOUCHER',
          entity_id: voucherId,
          old_values_json: JSON.stringify({ status: 'POSTED' }),
          new_values_json: JSON.stringify({ status: 'CANCELLED' }),
          session_id: context.sessionId
        });
      } catch (e) { /* Audit logging must not break transactions */ }
    })();

    return { success: true };
  }

  /**
   * Reverse a posted voucher by creating a reversing journal entry.
   * Creates a new voucher with opposite entries.
   */
  reverseVoucher(voucherId, companyId, context) {
    Authorizer.assertPermission(context, 'accounting.reverse');
    const voucher = this.voucherRepo.findById(voucherId, companyId);
    if (!voucher) throw new NotFoundError('Voucher', voucherId);
    if (voucher.status !== 'POSTED') throw new ValidationError('Only posted vouchers can be reversed');

    const originalEntry = this.conn.get(
      'SELECT * FROM journal_entries WHERE voucher_id = ? AND company_id = ? LIMIT 1',
      [voucherId, companyId]
    );
    if (!originalEntry) throw new NotFoundError('JournalEntry', voucherId);

    const originalLines = this.conn.all(
      'SELECT * FROM journal_entry_lines WHERE journal_entry_id = ?',
      [originalEntry.id]
    );

    // Create reversing lines (swap debit/credit)
    const reversingLines = originalLines.map(l => ({
      account_id: l.account_id,
      cost_centre_id: l.cost_centre_id,
      cost_category_id: l.cost_category_id,
      debit_amount: l.credit_amount,
      credit_amount: l.debit_amount,
      description: `Reversal of ${l.description || ''}`,
      reference_id: l.journal_entry_id
    }));

    // Mark original as REVERSED
    this.conn.run(
      'UPDATE vouchers SET status = ? WHERE id = ? AND company_id = ?',
      ['REVERSED', voucherId, companyId]
    );
    this.conn.run(
      'UPDATE journal_entries SET status = ? WHERE id = ? AND company_id = ?',
      ['REVERSED', originalEntry.id, companyId]
    );

    // Post the reversing entry
    const reversalData = {
      voucher_type: 'JOURNAL',
      voucher_date: new Date().toISOString().split('T')[0],
      reference_number: `REV-${voucher.voucher_number}`,
      description: `Reversal of voucher ${voucher.voucher_number}`,
      contact_id: voucher.contact_id,
      organization_id: voucher.organization_id,
      deal_id: voucher.deal_id,
      currency: voucher.currency,
      exchange_rate: voucher.exchange_rate,
      financial_year_id: voucher.financial_year_id,
      lines: reversingLines
    };

    const result = this.postVoucher(reversalData, context);

    try {
      this.audit.log({
        id: generateId('aud'),
        company_id: companyId,
        user_id: context.userId || 'system',
        action: 'VOUCHER_REVERSED',
        entity_type: 'VOUCHER',
        entity_id: voucherId,
        old_values_json: JSON.stringify({ status: 'POSTED' }),
        new_values_json: JSON.stringify({ status: 'REVERSED', reversal_entry_id: result.entryId, reversal_voucher_id: result.voucherId }),
        session_id: context.sessionId
      });
    } catch (e) { /* Audit logging must not break operations */ }

    return result;
  }

  /**
   * Get ledger for a specific account within a date range.
   */
  getLedger(accountId, companyId, startDate, endDate, voucherType = null) {
    const account = this.accountRepo.findById(accountId, companyId);
    if (!account) throw new NotFoundError('Account', accountId);

    const params = [companyId, accountId];
    let dateClause = '';
    if (startDate) { dateClause += ' AND je.entry_date >= ?'; params.push(startDate); }
    if (endDate) { dateClause += ' AND je.entry_date <= ?'; params.push(endDate); }
    if (voucherType) { dateClause += ' AND v.voucher_type = ?'; params.push(voucherType); }

    const rows = this.conn.all(
      `SELECT
         je.entry_date, v.voucher_number, v.voucher_type, je.entry_number,
         jel.debit_amount, jel.credit_amount, jel.description,
         je.entry_date as txn_date, je.status as entry_status
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       LEFT JOIN vouchers v ON v.id = je.voucher_id
       WHERE jel.account_id = ? AND je.company_id = ? AND je.status = 'POSTED'${dateClause}
       ORDER BY je.entry_date ASC, je.created_at ASC, jel.created_at ASC`,
      params
    );

    let runningBalance = 0;
    const entries = rows.map(r => {
      const dr = parseFloat(r.debit_amount) || 0;
      const cr = parseFloat(r.credit_amount) || 0;
      // For DEBIT-nature accounts, debit increases balance; for CREDIT-nature, credit increases
      const isDebitAccount = account.debit_credit_nature === 'DEBIT';
      const net = dr - cr;
      runningBalance += isDebitAccount ? net : -net;

      return {
        date: r.entry_date,
        voucher_number: r.voucher_number,
        voucher_type: r.voucher_type,
        description: r.description || r.voucher_number,
        debit: dr,
        credit: cr,
        balance: runningBalance
      };
    });

    return { account, entries, closing_balance: runningBalance };
  }

  /**
   * Day book: all journal entries chronologically
   */
  getDayBook(companyId, startDate, endDate, voucherType = null, accountId = null) {
    const params = [companyId];
    let dateClause = '';
    if (startDate) { dateClause += ' AND je.entry_date >= ?'; params.push(startDate); }
    if (endDate) { dateClause += ' AND je.entry_date <= ?'; params.push(endDate); }
    if (voucherType) { dateClause += ' AND v.voucher_type = ?'; params.push(voucherType); }
    if (accountId) { dateClause += ' AND jel.account_id = ?'; params.push(accountId); }

    return this.conn.all(
      `SELECT
         je.entry_date, je.entry_number, v.voucher_number, v.voucher_type,
         je.description, a.code as account_code, a.name as account_name,
         jel.debit_amount, jel.credit_amount, u.full_name as user_name, je.status
       FROM journal_entries je
       JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
       LEFT JOIN vouchers v ON v.id = je.voucher_id
       LEFT JOIN accounts a ON a.id = jel.account_id
       LEFT JOIN users u ON u.id = je.created_by
       WHERE je.company_id = ? AND je.status = 'POSTED'${dateClause}
       ORDER BY je.entry_date ASC, je.entry_number ASC`,
      params
    );
  }

  /**
   * Trial balance: all accounts with debit/credit totals
   */
  getTrialBalance(companyId, startDate = null, endDate = null) {
    const company = this.voucherRepo._company(companyId);
    const params = [company];
    let dateClause = '';
    if (startDate) { dateClause += ' AND je.entry_date >= ?'; params.push(startDate); }
    if (endDate) { dateClause += ' AND je.entry_date <= ?'; params.push(endDate); }

    const rows = this.conn.all(
      `SELECT
         a.id, a.code, a.name, a.type, a.debit_credit_nature,
         COALESCE(SUM(jel.debit_amount), 0) AS total_debit,
         COALESCE(SUM(jel.credit_amount), 0) AS total_credit
       FROM accounts a
       LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
       LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'POSTED'${dateClause}
       WHERE a.company_id = ? AND a.is_active = 1
       GROUP BY a.id, a.code, a.name, a.type, a.debit_credit_nature
       ORDER BY a.code ASC`,
      [...params, company]
    );

    let totalDebit = 0;
    let totalCredit = 0;
    const formatted = rows.map(r => {
      const dr = parseFloat(r.total_debit) || 0;
      const cr = parseFloat(r.total_credit) || 0;
      const balance = r.debit_credit_nature === 'DEBIT' ? dr - cr : cr - dr;
      totalDebit += Math.max(balance, 0);
      totalCredit += Math.max(-balance, 0);
      return {
        account_id: r.id,
        code: r.code,
        name: r.name,
        type: r.type,
        debit_credit_nature: r.debit_credit_nature,
        debit: dr,
        credit: cr,
        balance: balance
      };
    });

    return {
      accounts: formatted,
      total_debit: totalDebit,
      total_credit: totalCredit,
      balanced: Math.abs(totalDebit - totalCredit) < 0.01
    };
  }

  /**
   * Generate instalment schedules from a financed amount.
   * Used by CollectionsService for payment plan auto-generation.
   * @param {number} financedAmount - Total amount to be paid in instalments
   * @param {number} count - Number of instalments
   * @param {string} startDate - ISO date string (YYYY-MM-DD)
   * @param {string} frequency - 'weekly', 'biweekly', 'monthly', 'custom'
   * @returns {Array<{due_date: string, amount: number}>}
   */
  generateInstallments(financedAmount, count, startDate, frequency = 'monthly') {
    if (count < 1) throw new ValidationError('At least 1 instalment required');
    if (financedAmount <= 0) return Array.from({ length: count }, (_, i) => ({ due_date: startDate, amount: 0 }));

    const rounded = Math.round(financedAmount * 100) / 100;
    const baseAmount = Math.round((financedAmount / count) * 100) / 100;
    const remainder = Math.round((rounded - baseAmount * (count - 1)) * 100) / 100;
    const start = new Date(startDate);
    const result = [];

    for (let i = 0; i < count; i++) {
      const amount = i === count - 1 ? remainder : baseAmount;
      let dueDate;

      if (frequency === 'weekly') {
        dueDate = new Date(start);
        dueDate.setDate(start.getDate() + i * 7);
      } else if (frequency === 'biweekly') {
        dueDate = new Date(start);
        dueDate.setDate(start.getDate() + i * 14);
      } else if (frequency === 'custom') {
        dueDate = new Date(start);
      } else {
        // default: monthly
        dueDate = new Date(start);
        dueDate.setMonth(start.getMonth() + i + 1);
      }

      result.push({
        due_date: dueDate.toISOString().split('T')[0],
        amount: i === count - 1 ? remainder : amount
      });
    }

    return result;
  }
}

module.exports = { AccountingEngine };
