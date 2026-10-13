const { AccountingBaseRepository } = require('./accounting-base.repository');
const { generateId } = require('../utils/generateId');

class JournalEntryRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'journal_entries');
  }

  search(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const companyId = this._company(options.companyId);
    const where = ['je.company_id = ?'];
    const params = [companyId];

    if (options.status) {
      where.push('je.status = ?');
      params.push(options.status);
    }
    if (options.voucherId) {
      where.push('je.voucher_id = ?');
      params.push(options.voucherId);
    }
    if (options.startDate) {
      where.push('je.entry_date >= ?');
      params.push(options.startDate);
    }
    if (options.endDate) {
      where.push('je.entry_date <= ?');
      params.push(options.endDate);
    }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM journal_entries je WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;
    const items = this.conn.all(
      `SELECT je.* FROM journal_entries je WHERE ${whereStr} ORDER BY je.entry_date DESC, je.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { items, total };
  }

  createWithValidation(entry, lines) {
    return this.conn.transaction(() => {
      const { generateId } = require('../utils/generateId');
      let totalDebit = 0;
      let totalCredit = 0;
      for (const line of lines) {
        totalDebit += parseFloat(line.debit_amount) || 0;
        totalCredit += parseFloat(line.credit_amount) || 0;
      }
      if (Math.abs(totalDebit - totalCredit) > 0.001) {
        throw new Error('Validation error: Total debits must equal total credits');
      }

      const entryId = entry.id || generateId('je');
      const now = new Date().toISOString();
      const entrySql = `INSERT INTO journal_entries
        (id, company_id, voucher_id, entry_number, entry_date, description, currency, exchange_rate,
         total_debit, total_credit, status, financial_year_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      this.conn.run(entrySql, [
        entryId, entry.company_id, entry.voucher_id || null, entry.entry_number || ('JE-' + Date.now()),
        entry.entry_date, entry.description, entry.currency || 'INR', entry.exchange_rate || 1.0,
        totalDebit, totalCredit, entry.status || 'POSTED', entry.financial_year_id || null, entry.created_by, now, now
      ]);

      for (const line of lines) {
        const lineSql = `INSERT INTO journal_entry_lines
          (id, company_id, journal_entry_id, account_id, cost_centre_id, cost_category_id,
           debit_amount, credit_amount, description, reference_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        this.conn.run(lineSql, [
          generateId('jl'), entry.company_id, entryId, line.account_id, line.cost_centre_id || null,
          line.cost_category_id || null, line.debit_amount || 0, line.credit_amount || 0,
          line.description, line.reference_id || null, now
        ]);
      }

      return { ...entry, id: entryId, status: entry.status || 'POSTED', total_debit: totalDebit, total_credit: totalCredit, lines };
    })();
  }

  /**
   * Append additional lines to an existing journal entry and recompute its
   * totals, keeping the entry balanced.
   *
   * Used by the billing flow to add the COGS / inventory-asset half of a bill's
   * journal entry after the revenue-and-tax half has already been created.
   * Re-validates balance afterwards, so an unbalanced append is impossible.
   */
  appendLines(journalEntryId, companyId, lines) {
    if (!lines || lines.length === 0) return this.findLines(journalEntryId);
    const { generateId } = require('../utils/generateId');
    const now = new Date().toISOString();

    return this.conn.transaction(() => {
      for (const line of lines) {
        this.conn.run(
          `INSERT INTO journal_entry_lines
            (id, company_id, journal_entry_id, account_id, cost_centre_id, cost_category_id,
             debit_amount, credit_amount, description, reference_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [generateId('jl'), companyId, journalEntryId, line.account_id,
           line.cost_centre_id || null, line.cost_category_id || null,
           line.debit_amount || 0, line.credit_amount || 0,
           line.description, line.reference_id || null, now]
        );
      }

      const totals = this.conn.get(
        `SELECT COALESCE(SUM(debit_amount),0) AS d, COALESCE(SUM(credit_amount),0) AS c
           FROM journal_entry_lines WHERE journal_entry_id = ? AND company_id = ?`,
        [journalEntryId, companyId]
      );

      if (Math.abs((totals.d || 0) - (totals.c || 0)) > 0.001) {
        throw new Error('Validation error: Journal entry is unbalanced after appending lines');
      }

      this.conn.run(
        'UPDATE journal_entries SET total_debit = ?, total_credit = ?, updated_at = ? WHERE id = ? AND company_id = ?',
        [totals.d, totals.c, now, journalEntryId, companyId]
      );

      return this.findLines(journalEntryId);
    })();
  }

  /**
   * Create a Journal Entry in DRAFT state (Step 6).
   * Lines are stored immediately; JE remains DRAFT until posted.
   * Reuses the same journal_entries and journal_entry_lines tables.
   */
  createJournalEntryDraft(entry, lines) {
    return this.conn.transaction(() => {
      const { generateId } = require('../utils/generateId');
      let totalDebit = 0;
      let totalCredit = 0;
      for (const line of lines) {
        totalDebit += parseFloat(line.debit_amount) || 0;
        totalCredit += parseFloat(line.credit_amount) || 0;
      }

      const entryId = entry.id || generateId('je');
      const now = new Date().toISOString();
      const entrySql = `INSERT INTO journal_entries
        (id, company_id, voucher_id, entry_number, entry_date, description, currency, exchange_rate,
         total_debit, total_credit, status, financial_year_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`;
      const entryNumber = entry.entry_number || ('JE-' + Date.now());
      this.conn.run(entrySql, [
        entryId, entry.company_id, entry.voucher_id || null, entryNumber, entry.entry_date,
        entry.description, entry.currency || 'INR', entry.exchange_rate || 1.0,
        totalDebit, totalCredit, entry.financial_year_id, entry.created_by, now, now
      ]);

      for (const line of lines) {
        const lineSql = `INSERT INTO journal_entry_lines
          (id, company_id, journal_entry_id, account_id, cost_centre_id, cost_category_id,
           debit_amount, credit_amount, description, reference_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        this.conn.run(lineSql, [
          generateId('jl'), entry.company_id, entryId, line.account_id,
          line.cost_centre_id || null, line.cost_category_id || null,
          parseFloat(line.debit_amount) || 0, parseFloat(line.credit_amount) || 0,
          line.description || '', line.reference_id || null, now
        ]);
      }

      return { id: entryId, ...entry, status: 'DRAFT', total_debit: totalDebit, total_credit: totalCredit, lines };
    })();
  }

  /**
   * Post a Draft Journal Entry (Step 6).
   * Re-calculates totals from current lines and marks as POSTED.
   */
  postDraft(entryId, companyId, userId) {
    return this.conn.transaction(() => {
      const lines = this.findLines(entryId);
      let totalDebit = 0;
      let totalCredit = 0;
      for (const line of lines) {
        totalDebit += parseFloat(line.debit_amount) || 0;
        totalCredit += parseFloat(line.credit_amount) || 0;
      }
      if (Math.abs(totalDebit - totalCredit) > 0.001) {
        throw new Error('Validation error: Total debits must equal total credits');
      }

      const now = new Date().toISOString();
      this.conn.prepare(
        'UPDATE journal_entries SET status = ?, total_debit = ?, total_credit = ?, updated_at = ?, posted_at = ?, posted_by = ? WHERE id = ? AND company_id = ?'
      ).run('POSTED', totalDebit, totalCredit, now, now, userId, entryId, this._company(companyId));

      this.conn.prepare('INSERT INTO accounting_audit (id, company_id, user_id, entity_type, entity_id, action, old_values_json, new_values_json, ip_address, user_agent, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(generateId('aud'), this._company(companyId), userId, 'journal_entry', entryId, 'POST', null, '{"status":"POSTED","total_debit":'+totalDebit+',"total_credit":'+totalCredit+'}', null, null, null, now);
      return this.getWithLines(entryId, companyId);
    })();
  }

  /**
   * Find lines for a journal entry (Step 6 helper).
   */
  findLines(journalEntryId) {
    return this.conn.all(
      `SELECT jel.*, a.code as account_code, a.name as account_name,
              a.type as account_type, a.debit_credit_nature, a.is_active, a.is_group, a.allow_direct_posting
       FROM journal_entry_lines jel
       LEFT JOIN accounts a ON jel.account_id = a.id
       WHERE jel.journal_entry_id = ?`,
      [journalEntryId]
    );
  }

  /**
   * Update draft journal entry header fields (Step 6).
   */
  update(id, companyId, updates) {
    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        fields.push(key + ' = ?');
        params.push(value);
      }
    }
    if (fields.length === 0) return;
    params.push(id, this._company(companyId));
    this.conn.prepare(
      `UPDATE journal_entries SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ? AND company_id = ?`
    ).run(...params);
  }

  /**
   * Delete a draft journal entry and its lines (Step 6).
   */
  delete(id, companyId) {
    return this.conn.transaction(() => {
      this.conn.prepare('DELETE FROM journal_entry_lines WHERE journal_entry_id = ?').run(id);
      this.conn.prepare('DELETE FROM journal_entries WHERE id = ? AND company_id = ?').run(id, this._company(companyId));
    })();
  }

  cancel(id, companyId, userId) {
    return this.conn.transaction(() => {
      this.conn.prepare('UPDATE journal_entries SET status = ? WHERE id = ? AND company_id = ?').run('CANCELLED', id, this._company(companyId));
      const now = new Date().toISOString();
      this.conn.prepare('INSERT INTO accounting_audit (id, company_id, user_id, entity_type, entity_id, action, old_values_json, new_values_json, ip_address, user_agent, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(generateId('aud'), this._company(companyId), userId, 'JournalEntry', id, 'CANCEL', null, '{"status":"CANCELLED"}', null, null, null, now);
    })();
  }

  reverse(id, companyId, userId) {
    return this.conn.transaction(() => {
      const { generateId } = require('../utils/generateId');
      const je = this.findById(id, companyId);
      if (!je || je.status !== 'POSTED') throw new Error('Cannot reverse a non-posted entry');

      const lines = this.conn.all('SELECT * FROM journal_entry_lines WHERE journal_entry_id = ?', [id]);

      const now = new Date().toISOString();
      const reverseId = generateId('je');
      this.conn.prepare(`
        INSERT INTO journal_entries (id, company_id, voucher_id, entry_number, entry_date, description, currency, exchange_rate, total_debit, total_credit, status, financial_year_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'POSTED', ?, ?, ?, ?)
      `).run(reverseId, companyId, je.voucher_id, je.entry_number + '_REV', je.entry_date, 'Reversing entry for ' + je.entry_number, je.currency, je.exchange_rate, je.total_credit, je.total_debit, je.financial_year_id, userId, now, now);

      lines.forEach(l => {
        this.conn.prepare(`
          INSERT INTO journal_entry_lines (id, company_id, journal_entry_id, account_id, cost_centre_id, cost_category_id, debit_amount, credit_amount, description, reference_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(generateId('jl'), companyId, reverseId, l.account_id, l.cost_centre_id, l.cost_category_id, l.credit_amount, l.debit_amount, 'Reversal: ' + (l.description || ''), l.id, now);
      });

      this.conn.prepare('UPDATE journal_entries SET status = ? WHERE id = ?').run('REVERSED', id);
      this.conn.prepare('INSERT INTO accounting_audit (id, company_id, user_id, entity_type, entity_id, action, old_values_json, new_values_json, ip_address, user_agent, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(generateId('aud'), companyId, userId, 'JournalEntry', id, 'REVERSE', '{"status":"POSTED"}', '{"status":"REVERSED"}', null, null, null, now);
      return { originalEntryId: id, reverseEntryId: reverseId };
    })();
  }

  getWithLines(id, companyId) {
    const entry = this.findById(id, companyId);
    if (!entry) return null;
    const lines = this.conn.all(
      `SELECT jel.*, a.code as account_code, a.name as account_name, ag.type as account_type,
              cc.code as cost_centre_code, cc.name as cost_centre_name,
              ccat.code as cost_category_code, ccat.name as cost_category_name
       FROM journal_entry_lines jel
       LEFT JOIN accounts a ON a.id = jel.account_id
       LEFT JOIN account_groups ag ON ag.id = a.account_group_id
       LEFT JOIN cost_centres cc ON cc.id = jel.cost_centre_id
       LEFT JOIN cost_categories ccat ON ccat.id = jel.cost_category_id
       WHERE jel.journal_entry_id = ?`,
      [id]
    );
    return { ...entry, lines: lines || [] };
  }

  createJournalEntry(entry, lines) {
    return this.conn.transaction(() => {
      const now = new Date().toISOString();
      // Compute totals
      let totalDebit = 0;
      let totalCredit = 0;
      for (const line of lines) {
        totalDebit += parseFloat(line.debit_amount) || 0;
        totalCredit += parseFloat(line.credit_amount) || 0;
      }

      const entrySql = `INSERT INTO journal_entries
        (id, company_id, voucher_id, entry_number, entry_date, description, currency, exchange_rate,
         total_debit, total_credit, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      this.conn.run(entrySql, [
        entry.id, entry.company_id, entry.voucher_id, entry.entry_number, entry.entry_date,
        entry.description, entry.currency || 'USD', entry.exchange_rate || 1.0,
        totalDebit, totalCredit, entry.status || 'POSTED', entry.created_by, now, now
      ]);

      for (const line of lines) {
        const lineSql = `INSERT INTO journal_entry_lines
          (id, company_id, journal_entry_id, account_id, cost_centre_id, cost_category_id,
           debit_amount, credit_amount, description, reference_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        this.conn.run(lineSql, [
          line.id, entry.company_id, entry.id, line.account_id, line.cost_centre_id || null,
          line.cost_category_id || null, line.debit_amount || 0, line.credit_amount || 0,
          line.description, line.reference_id || null, now
        ]);
      }

      return { ...entry, total_debit: totalDebit, total_credit: totalCredit, lines };
    })();
  }

  /**
   * Compute account balance from journal entries.
   * For DEBIT-nature accounts: balance = SUM(debits) - SUM(credits)
   * For CREDIT-nature accounts: balance = SUM(credits) - SUM(debits)
   */
  getAccountBalance(accountId, companyId, endDate = null, startDate = null) {
    const company = this._company(companyId);
    const params = [company, accountId];
    let dateClause = '';
    if (startDate) {
      dateClause += ' AND je.entry_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      dateClause += ' AND je.entry_date <= ?';
      params.push(endDate);
    }
    const result = this.conn.get(
      `SELECT
         COALESCE(SUM(jel.debit_amount), 0) AS total_debit,
         COALESCE(SUM(jel.credit_amount), 0) AS total_credit
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       WHERE je.company_id = ? AND jel.account_id = ? AND je.status = 'POSTED'${dateClause}`,
      params
    );
    const debit = parseFloat(result?.total_debit || 0);
    const credit = parseFloat(result?.total_credit || 0);
    return { debit, credit, balance: debit - credit };
  }

  // Trial balance: all accounts with their net balance
  getTrialBalance(companyId, startDate = null, endDate = null) {
    const company = this._company(companyId);
    // Param order must match SQL placeholder order: dateClause (?) is in the
    // JOIN condition BEFORE the WHERE a.company_id = ? placeholder.
    const params = [];
    let dateClause = '';
    if (startDate) {
      dateClause += ' AND je.entry_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      dateClause += ' AND je.entry_date <= ?';
      params.push(endDate);
    }
    params.push(company);
    return this.conn.all(
      `SELECT
         a.id, a.code, a.name, a.type, a.debit_credit_nature,
         COALESCE(SUM(CASE WHEN a.debit_credit_nature = 'DEBIT' THEN
           (COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0))
         ELSE
           (COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0))
         END), 0) AS net_balance
       FROM accounts a
       LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
       JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'POSTED'
       ${dateClause}
       WHERE a.company_id = ?
       GROUP BY a.id, a.code, a.name, a.type, a.debit_credit_nature
       HAVING ABS(net_balance) > 0.001
       ORDER BY a.code ASC`,
      [...params]
    );
  }

  // Trial balance with debit/credit totals
  trialBalance(companyId, from = null, to = null) {
    const company = this._company(companyId);
    // Param order must match SQL placeholder order: dateClause (?) is in the
    // JOIN condition BEFORE the WHERE a.company_id = ? placeholder.
    const params = [];
    let dateClause = '';
    if (from) { dateClause += ' AND je.entry_date >= ?'; params.push(from); }
    if (to) { dateClause += ' AND je.entry_date <= ?'; params.push(to); }
    params.push(company);

    const rows = this.conn.all(
      `SELECT
         a.code, a.name, a.type, a.debit_credit_nature,
         COALESCE(SUM(jel.debit_amount), 0) AS debit,
         COALESCE(SUM(jel.credit_amount), 0) AS credit
       FROM accounts a
       LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
       JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'POSTED'
       ${dateClause}
       WHERE a.company_id = ?
       GROUP BY a.id, a.code, a.name, a.type, a.debit_credit_nature
       ORDER BY a.code ASC`,
      [...params]
    );
    const accounts = rows.map(r => {
      const balance = parseFloat(r.debit) - parseFloat(r.credit);
      return {
        code: r.code, name: r.name, type: r.type,
        debit: parseFloat(r.debit) || 0,
        credit: parseFloat(r.credit) || 0,
        balance: balance
      };
    });
    const totalDebit = accounts.reduce((s, a) => s + a.debit, 0);
    const totalCredit = accounts.reduce((s, a) => s + a.credit, 0);
    return { accounts, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 };
  }

  // Profit & Loss: revenue and expense accounts
  profitLoss(companyId, from = null, to = null) {
    const company = this._company(companyId);
    // Param order must match SQL placeholder order: the dateClause (?) appears in
    // the JOIN condition BEFORE the WHERE a.company_id = ? placeholder. So date
    // params come first, then company_id.
    const params = [];
    let dateClause = '';
    if (from) { dateClause += ' AND je.entry_date >= ?'; params.push(from); }
    if (to) { dateClause += ' AND je.entry_date <= ?'; params.push(to); }
    params.push(company);

    const revenue = this.conn.get(
      `SELECT COALESCE(SUM(CASE WHEN a.debit_credit_nature = 'CREDIT' THEN jel.credit_amount ELSE 0 END), 0) -
              COALESCE(SUM(CASE WHEN a.debit_credit_nature = 'CREDIT' THEN jel.debit_amount ELSE 0 END), 0) AS amount
       FROM accounts a
       LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
       JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'POSTED'
       ${dateClause}
       WHERE a.company_id = ? AND a.type IN ('INCOME')`,
      params
    );

    const expense = this.conn.get(
      `SELECT COALESCE(SUM(CASE WHEN a.debit_credit_nature = 'DEBIT' THEN jel.debit_amount ELSE 0 END), 0) -
              COALESCE(SUM(CASE WHEN a.debit_credit_nature = 'DEBIT' THEN jel.credit_amount ELSE 0 END), 0) AS amount
       FROM accounts a
       LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
       JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'POSTED'
       ${dateClause}
       WHERE a.company_id = ? AND a.type IN ('EXPENSE')`,
      params
    );

    const revenueTotal = parseFloat(revenue?.amount || 0);
    const expenseTotal = parseFloat(expense?.amount || 0);
    const netProfit = revenueTotal - expenseTotal;
    const grossProfit = revenueTotal - expenseTotal;

    return {
      revenue: revenueTotal,
      expense: expenseTotal,
      grossProfit: grossProfit,
      operatingProfit: netProfit,
      netProfit: netProfit,
    };
  }

  // Balance sheet: assets = liabilities + equity
  // Uses ONLY Journal Entry data (POSTED JEs), which includes opening balance
  // JEs created by createAccount. Does NOT read account.opening_balance directly,
  // because those opening balances are already posted as JEs and would be double-counted.
  balanceSheet(companyId, asOf) {
    const company = this._company(companyId);
    const dateClause = ' AND je.entry_date <= ?';

    const assets = this.conn.get(
      `SELECT COALESCE(SUM(CASE WHEN a.debit_credit_nature = 'DEBIT' THEN jel.debit_amount ELSE 0 END), 0) -
              COALESCE(SUM(CASE WHEN a.debit_credit_nature = 'DEBIT' THEN jel.credit_amount ELSE 0 END), 0) AS amount
       FROM accounts a
       LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
       JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'POSTED'
       ${dateClause}
       WHERE a.company_id = ? AND a.type IN ('ASSET', 'CASH', 'BANK')`,
      [asOf, company]
    );

    const liabilities = this.conn.get(
      `SELECT COALESCE(SUM(CASE WHEN a.debit_credit_nature = 'CREDIT' THEN jel.credit_amount ELSE 0 END), 0) -
              COALESCE(SUM(CASE WHEN a.debit_credit_nature = 'CREDIT' THEN jel.debit_amount ELSE 0 END), 0) AS amount
       FROM accounts a
       LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
       JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'POSTED'
       ${dateClause}
       WHERE a.company_id = ? AND a.type IN ('LIABILITY')`,
      [asOf, company]
    );

    const equity = this.conn.get(
      `SELECT COALESCE(SUM(CASE WHEN a.debit_credit_nature = 'CREDIT' THEN jel.credit_amount ELSE 0 END), 0) -
              COALESCE(SUM(CASE WHEN a.debit_credit_nature = 'CREDIT' THEN jel.debit_amount ELSE 0 END), 0) AS amount
       FROM accounts a
       LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
       JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'POSTED'
       ${dateClause}
       WHERE a.company_id = ? AND a.type IN ('EQUITY')`,
      [asOf, company]
    );

    // Current period profit/loss added to equity (retained earnings)
    const pAndL = this.profitLoss(companyId, null, asOf);

    const assetTotal = parseFloat(assets?.amount || 0);
    const liabilityTotal = parseFloat(liabilities?.amount || 0);
    const equityTotal = parseFloat(equity?.amount || 0);
    const totalLiabilitiesAndEquity = liabilityTotal + equityTotal + pAndL.netProfit;

    return {
      assets: assetTotal,
      liabilities: liabilityTotal,
      equity: equityTotal,
      currentPeriodProfit: pAndL.netProfit,
      totalLiabilitiesAndEquity,
      balanced: Math.abs(assetTotal - totalLiabilitiesAndEquity) < 0.01,
    };
  }

  // Cash flow: operating, investing, financing
  cashFlow(companyId, from = null, to = null) {
    const company = this._company(companyId);
    const params = [company];
    let dateClause = '';
    if (from) { dateClause += ' AND je.entry_date >= ?'; params.push(from); }
    if (to) { dateClause += ' AND je.entry_date <= ?'; params.push(to); }

    const operating = this.conn.get(
      `SELECT COALESCE(SUM(jel.debit_amount - jel.credit_amount), 0) AS amount
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON jel.account_id = a.id
       WHERE je.company_id = ? AND je.status = 'POSTED' AND a.type IN ('INCOME', 'EXPENSE')${dateClause}`,
      params
    );

    const investing = this.conn.get(
      `SELECT COALESCE(SUM(jel.debit_amount - jel.credit_amount), 0) AS amount
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON jel.account_id = a.id
       WHERE je.company_id = ? AND je.status = 'POSTED' AND a.type IN ('ASSET') AND a.type NOT IN ('CASH', 'BANK')${dateClause}`,
      params
    );

    const financing = this.conn.get(
      `SELECT COALESCE(SUM(jel.debit_amount - jel.credit_amount), 0) AS amount
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON jel.account_id = a.id
       WHERE je.company_id = ? AND je.status = 'POSTED' AND a.type IN ('LIABILITY', 'EQUITY')${dateClause}`,
      params
    );

    const op = parseFloat(operating?.amount || 0);
    const inv = parseFloat(investing?.amount || 0);
    const fin = parseFloat(financing?.amount || 0);
    return {
      operating: op,
      investing: inv,
      financing: fin,
      netCashFlow: op + inv + fin,
    };
  }

  // Ratio analysis
  ratios(companyId, from = null, to = null) {
    const balances = this.trialBalance(companyId, from, to).accounts;

    const currentAssets = balances
      .filter(a => ['ASSET', 'CASH', 'BANK'].includes(a.type))
      .reduce((s, a) => s + Math.abs(a.balance), 0);
    const currentLiabilities = balances
      .filter(a => a.type === 'LIABILITY')
      .reduce((s, a) => s + Math.abs(a.balance), 0);
    const totalDebt = balances.filter(a => a.type === 'LIABILITY').reduce((s, a) => s + Math.abs(a.balance), 0);
    const totalEquity = balances.filter(a => a.type === 'EQUITY').reduce((s, a) => s + Math.abs(a.balance), 0);
    const totalAssets = balances.filter(a => ['ASSET', 'CASH', 'BANK'].includes(a.type)).reduce((s, a) => s + Math.abs(a.balance), 0);

    const pAndL = this.profitLoss(companyId, from, to);
    const totalRevenue = parseFloat(pAndL.revenue);
    const totalNetProfit = parseFloat(pAndL.netProfit);
    const totalExpenses = parseFloat(pAndL.expense);

    const conn = this.conn;
    const receivables = conn.get(
      'SELECT COALESCE(SUM(outstanding_amount), 0) as total FROM receivables WHERE company_id = ? AND status != ?',
      [companyId, 'PAID']
    );
    const payables = conn.get(
      'SELECT COALESCE(SUM(outstanding_amount), 0) as total FROM payables WHERE company_id = ? AND status != ?',
      [companyId, 'PAID']
    );
    const totalReceivables = parseFloat(receivables?.total || 0);
    const totalPayables = parseFloat(payables?.total || 0);

    return {
      currentRatio: currentLiabilities > 0 ? (currentAssets / currentLiabilities) : null,
      quickRatio: currentLiabilities > 0 ? ((currentAssets - 0) / currentLiabilities) : null,
      debtToEquity: totalEquity > 0 ? (totalDebt / totalEquity) : null,
      grossProfitMargin: totalRevenue > 0 ? ((totalRevenue - totalExpenses) / totalRevenue * 100) : null,
      netProfitMargin: totalRevenue > 0 ? (totalNetProfit / totalRevenue * 100) : null,
      operatingMargin: totalRevenue > 0 ? (totalNetProfit / totalRevenue * 100) : null,
      returnOnAssets: totalAssets > 0 ? (totalNetProfit / totalAssets * 100) : null,
      returnOnEquity: totalEquity > 0 ? (totalNetProfit / totalEquity * 100) : null,
      receivableTurnover: totalReceivables > 0 ? (totalRevenue / totalReceivables) : null,
      payableTurnover: totalPayables > 0 ? (totalExpenses / totalPayables) : null,
    };
  }

  // Day book: all journal entries chronologically
  dayBook(options = {}) {
    const companyId = this._company(options.companyId);
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const params = [companyId];
    const where = ['je.company_id = ?'];

    if (options.from) { where.push('je.entry_date >= ?'); params.push(options.from); }
    if (options.to) { where.push('je.entry_date <= ?'); params.push(options.to); }
    if (options.type) { where.push('je.voucher_type = ?'); params.push(options.type); }
    if (options.q) { where.push('(je.description LIKE ? OR je.entry_number LIKE ?)'); params.push(`%${options.q}%`, `%${options.q}%`); }

    const items = this.conn.all(
      `SELECT je.*, v.voucher_number, v.voucher_type,
        COALESCE(SUM(jel.debit_amount), 0) as total_debit,
        COALESCE(SUM(jel.credit_amount), 0) as total_credit
       FROM journal_entries je
       LEFT JOIN vouchers v ON je.voucher_id = v.id
       LEFT JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
       WHERE ${where.join(' AND ')}
       GROUP BY je.id
       ORDER BY je.entry_date DESC, je.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM journal_entries je WHERE ${where.join(' AND ')}`, params);
    return { items, total: countRow?.total || 0 };
  }

  /**
   * Cash Book: transactions involving the cash account
   */
  cashBook(companyId, from = null, to = null) {
    const company = this._company(companyId);
    const params = [company];
    let dateClause = '';
    if (from) { dateClause += ' AND je.entry_date >= ?'; params.push(from); }
    if (to) { dateClause += ' AND je.entry_date <= ?'; params.push(to); }

    const rows = this.conn.all(
      `SELECT je.entry_date, v.voucher_number, v.voucher_type, je.description,
              jel.debit_amount, jel.credit_amount, u.username as created_by
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON a.id = jel.account_id
       LEFT JOIN vouchers v ON v.id = je.voucher_id
       LEFT JOIN users u ON u.id = je.created_by
       WHERE je.company_id = ? AND a.type = 'CASH' AND je.status = 'POSTED'${dateClause}
       ORDER BY je.entry_date ASC, je.created_at ASC`,
      params
    );

    let balance = 0;
    const items = rows.map(r => {
      const dr = parseFloat(r.debit_amount) || 0;
      const cr = parseFloat(r.credit_amount) || 0;
      balance = balance + dr - cr;
      return { date: r.entry_date, voucher_number: r.voucher_number, voucher_type: r.voucher_type, description: r.description || '', receipt: dr, payment: cr, balance: balance, created_by: r.created_by };
    });

    const totalReceipt = items.reduce((s, i) => s + i.receipt, 0);
    const totalPayment = items.reduce((s, i) => s + i.payment, 0);
    return { items, totalReceipt, totalPayment, closingBalance: balance };
  }

  /**
   * Bank Book: transactions for a specific bank account
   */
  bankBook(companyId, bankAccountId, from = null, to = null) {
    const company = this._company(companyId);
    const params = [company, bankAccountId];
    let dateClause = '';
    if (from) { dateClause += ' AND je.entry_date >= ?'; params.push(from); }
    if (to) { dateClause += ' AND je.entry_date <= ?'; params.push(to); }

    const rows = this.conn.all(
      `SELECT je.entry_date, v.voucher_number, v.voucher_type, je.description,
              jel.debit_amount, jel.credit_amount, u.username as created_by
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       LEFT JOIN vouchers v ON v.id = je.voucher_id
       LEFT JOIN users u ON u.id = je.created_by
       WHERE je.company_id = ? AND jel.account_id = ? AND je.status = 'POSTED'${dateClause}
       ORDER BY je.entry_date ASC, je.created_at ASC`,
      params
    );

    let balance = 0;
    const items = rows.map(r => {
      const dr = parseFloat(r.debit_amount) || 0;
      const cr = parseFloat(r.credit_amount) || 0;
      balance = balance + dr - cr;
      return { date: r.entry_date, voucher_number: r.voucher_number, voucher_type: r.voucher_type, description: r.description || '', receipt: dr, payment: cr, balance: balance, created_by: r.created_by };
    });

    const totalReceipt = items.reduce((s, i) => s + i.receipt, 0);
    const totalPayment = items.reduce((s, i) => s + i.payment, 0);
    return { items, totalReceipt, totalPayment, closingBalance: balance };
  }

  /**
   * Fund Flow: sources and applications of funds based on balance sheet changes
   */
  fundFlow(companyId, from = null, to = null) {
    const company = this._company(companyId);
    const params = [company];
    let dateClause = '';
    if (from) { dateClause += ' AND je.entry_date >= ?'; params.push(from); }
    if (to) { dateClause += ' AND je.entry_date <= ?'; params.push(to); }

    // Calculate net change in working capital and major categories
    const operating = this.conn.get(
      `SELECT COALESCE(SUM(jel.debit_amount - jel.credit_amount), 0) AS amount
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON jel.account_id = a.id
       WHERE je.company_id = ? AND je.status = 'POSTED' AND a.type IN ('INCOME', 'EXPENSE')${dateClause}`,
      params
    );

    const investing = this.conn.get(
      `SELECT COALESCE(SUM(jel.debit_amount - jel.credit_amount), 0) AS amount
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON jel.account_id = a.id
       WHERE je.company_id = ? AND je.status = 'POSTED' AND a.type IN ('ASSET') AND a.type NOT IN ('CASH', 'BANK')${dateClause}`,
      params
    );

    const financing = this.conn.get(
      `SELECT COALESCE(SUM(jel.debit_amount - jel.credit_amount), 0) AS amount
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON jel.account_id = a.id
       WHERE je.company_id = ? AND je.status = 'POSTED' AND a.type IN ('LIABILITY', 'EQUITY')${dateClause}`,
      params
    );

    const op = parseFloat(operating?.amount || 0);
    const inv = parseFloat(investing?.amount || 0);
    const fin = parseFloat(financing?.amount || 0);
    return { operating: op, investing: inv, financing: fin, netFundsFlow: op + inv + fin };
  }
}

module.exports = { JournalEntryRepository };
