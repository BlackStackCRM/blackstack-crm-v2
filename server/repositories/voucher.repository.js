const { AccountingBaseRepository } = require('./accounting-base.repository');
const { generateId } = require('../utils/generateId');

class VoucherRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'vouchers');
  }

  search(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const companyId = this._company(options.companyId);
    const where = ['company_id = ?'];
    const params = [companyId];

    if (options.voucherType) {
      where.push('voucher_type = ?');
      params.push(options.voucherType);
    }
    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.startDate) {
      where.push('voucher_date >= ?');
      params.push(options.startDate);
    }
    if (options.endDate) {
      where.push('voucher_date <= ?');
      params.push(options.endDate);
    }
    if (options.contactId) {
      where.push('contact_id = ?');
      params.push(options.contactId);
    }
    if (options.query) {
      const s = `%${options.query}%`;
      where.push('(reference_number LIKE ? OR description LIKE ?)');
      params.push(s, s);
    }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM ${this.tableName} WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;
    const items = this.conn.all(
      `SELECT * FROM ${this.tableName} WHERE ${whereStr} ORDER BY voucher_date DESC, created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { items, total };
  }

  getByNumber(voucherNumber, companyId) {
    return this.conn.get(
      `SELECT * FROM ${this.tableName} WHERE voucher_number = ? AND company_id = ? LIMIT 1`,
      [voucherNumber, this._company(companyId)]
    );
  }

  // Voucher sequence number by type — concurrency-safe via the centralized
  // number_sequences counter (single-writer SQLite transaction). Keeps the
  // existing PREFIX-YYYY-#### accounting format and financial-year reset.
  getNextVoucherNumber(voucherType, companyId) {
    const typeMap = {
      'JOURNAL': 'VOUCHER_JOURNAL',
      'PAYMENT': 'VOUCHER_PAYMENT',
      'RECEIPT': 'VOUCHER_RECEIPT',
      'CONTRA': 'VOUCHER_CONTRA',
      'CREDIT_NOTE': 'VOUCHER_CREDIT_NOTE',
      'DEBIT_NOTE': 'VOUCHER_DEBIT_NOTE',
      'SALES': 'VOUCHER_SALES',
      'PURCHASE': 'VOUCHER_PURCHASE',
      'EXPENSE': 'VOUCHER_EXPENSE'
    };
    if (!typeMap[voucherType]) {
      // Unknown voucher type: legacy behaviour with a safe generic prefix.
      const last = this.conn.get(
        `SELECT voucher_number FROM ${this.tableName} WHERE voucher_number LIKE ? AND company_id = ? ORDER BY voucher_number DESC LIMIT 1`,
        [`VC-%`, this._company(companyId)]
      );
      return last ? `VC-${new Date().getFullYear()}-0001` : `VC-${new Date().getFullYear()}-0001`;
    }
    return this._codeGenerator().generate(this.conn, typeMap[voucherType], this._company(companyId));
  }

  _codeGenerator() {
    const CodeGenerator = require('../services/code-generator.service');
    return CodeGenerator;
  }

  cancel(id, companyId, userId) {
    return this.conn.transaction(() => {
      this.conn.prepare('UPDATE vouchers SET status = ? WHERE id = ? AND company_id = ?').run('CANCELLED', id, this._company(companyId));
      // Update associated journal entries to CANCELLED
      this.conn.prepare('UPDATE journal_entries SET status = ? WHERE voucher_id = ?').run('CANCELLED', id);
    })();
  }

  reverse(id, companyId, userId) {
    return this.conn.transaction(() => {
      const voucher = this.findById(id, companyId);
      if (!voucher || voucher.status !== 'POSTED') throw new Error('Cannot reverse a non-posted voucher');

      // Create a reversing voucher
      const reversedId = generateId('vch');
      this.conn.prepare(`
        INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, receipt_mode, voucher_date, status, total_amount, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'POSTED', ?, ?, datetime('now'), datetime('now'))
      `).run(reversedId, companyId, voucher.voucher_number + '_REV', voucher.voucher_type, voucher.receipt_mode, voucher.voucher_date, voucher.total_amount, userId);

      this.conn.prepare('UPDATE vouchers SET status = ? WHERE id = ?').run('REVERSED', id);
    })();
  }

  // ─── Step 7: Receipt Voucher Methods ──────────────────────────────────

  createReceipt(data, lines) {
    return this.conn.transaction(() => {
      const voucherId = generateId('vch');
      const now = new Date().toISOString();

      const totalDebit = lines.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0);

      this.conn.prepare(`
        INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, receipt_mode,
          voucher_date, reference_number, description, contact_id, currency, exchange_rate,
          financial_year_id, total_amount, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, 'RECEIPT', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)
      `).run(
        voucherId, this._company(data.companyId), data.voucher_number, data.receipt_mode,
        data.voucher_date, data.reference_number || null, data.description || '',
        data.contact_id || null, data.currency || 'INR', data.exchange_rate || 1.0,
        data.financial_year_id || null, totalDebit, data.created_by || 'system', now, now
      );

      return { id: voucherId, ...data, total_amount: totalDebit, status: 'DRAFT' };
    })();
  }

  postReceipt(voucherId, companyId, userId, journalEntry) {
    return this.conn.transaction(() => {
      const voucher = this.findById(voucherId, companyId);
      if (!voucher) throw new Error('Receipt voucher not found');
      if (voucher.status === 'POSTED') throw new Error('Receipt is already posted');
      if (voucher.status === 'CANCELLED') throw new Error('Cannot post a cancelled receipt');
      if (voucher.status === 'REVERSED') throw new Error('Cannot post a reversed receipt');

      // Link the generated journal entry to the voucher
      this.conn.prepare('UPDATE vouchers SET status = ?, journal_entry_id = ?, posted_by = ?, posted_at = ? WHERE id = ? AND company_id = ?').run(
        'POSTED', journalEntry.id, userId, new Date().toISOString(),
        voucherId, this._company(companyId)
      );

      return this.findById(voucherId, companyId);
    })();
  }

  getWithJournalEntry(id, companyId) {
    const voucher = this.findById(id, companyId);
    if (!voucher) return null;
    const journalEntry = voucher.journal_entry_id
      ? this.conn.get('SELECT * FROM journal_entries WHERE id = ? AND company_id = ?', [voucher.journal_entry_id, this._company(companyId)])
      : null;
    return { ...voucher, journal_entry: journalEntry };
  }

  // ─── Step 8: Payment Voucher Methods ──────────────────────────────────

  createPayment(data, lines) {
    return this.conn.transaction(() => {
      const voucherId = generateId('vch');
      const now = new Date().toISOString();

      const totalCredit = lines.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0);

      this.conn.prepare(`
        INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, receipt_mode,
          voucher_date, reference_number, description, contact_id, currency, exchange_rate,
          financial_year_id, total_amount, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, 'PAYMENT', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)
      `).run(
        voucherId, this._company(data.companyId), data.voucher_number, data.payment_mode,
        data.voucher_date, data.reference_number || null, data.description || '',
        data.contact_id || null, data.currency || 'INR', data.exchange_rate || 1.0,
        data.financial_year_id || null, totalCredit, data.created_by || 'system', now, now
      );

      return { id: voucherId, ...data, total_amount: totalCredit, status: 'DRAFT' };
    })();
  }

  postPayment(voucherId, companyId, userId, journalEntry) {
    return this.conn.transaction(() => {
      const voucher = this.findById(voucherId, companyId);
      if (!voucher) throw new Error('Payment voucher not found');
      if (voucher.status === 'POSTED') throw new Error('Payment is already posted');
      if (voucher.status === 'CANCELLED') throw new Error('Cannot post a cancelled payment');
      if (voucher.status === 'REVERSED') throw new Error('Cannot post a reversed payment');

      this.conn.prepare('UPDATE vouchers SET status = ?, journal_entry_id = ?, posted_by = ?, posted_at = ? WHERE id = ? AND company_id = ?').run(
        'POSTED', journalEntry.id, userId, new Date().toISOString(),
        voucherId, this._company(companyId)
      );

      return this.findById(voucherId, companyId);
    })();
  }

  // ─── Step 9: Contra Voucher Methods ──────────────────────────────────

  createContra(data, lines) {
    return this.conn.transaction(() => {
      const voucherId = generateId('vch');
      const now = new Date().toISOString();

      const totalDebit = lines.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0);

      this.conn.prepare(`
        INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, receipt_mode,
          voucher_date, reference_number, description, contact_id, currency, exchange_rate,
          financial_year_id, total_amount, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, 'CONTRA', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)
      `).run(
        voucherId, this._company(data.companyId), data.voucher_number, data.payment_mode,
        data.voucher_date, data.reference_number || null, data.description || '',
        data.contact_id || null, data.currency || 'INR', data.exchange_rate || 1.0,
        data.financial_year_id || null, totalDebit, data.created_by || 'system', now, now
      );

      return { id: voucherId, ...data, total_amount: totalDebit, status: 'DRAFT' };
    })();
  }

  postContra(voucherId, companyId, userId, journalEntry) {
    return this.conn.transaction(() => {
      const voucher = this.findById(voucherId, companyId);
      if (!voucher) throw new Error('Contra voucher not found');
      if (voucher.status === 'POSTED') throw new Error('Contra is already posted');
      if (voucher.status === 'CANCELLED') throw new Error('Cannot post a cancelled contra');
      if (voucher.status === 'REVERSED') throw new Error('Cannot post a reversed contra');

      this.conn.prepare('UPDATE vouchers SET status = ?, journal_entry_id = ?, posted_by = ?, posted_at = ? WHERE id = ? AND company_id = ?').run(
        'POSTED', journalEntry.id, userId, new Date().toISOString(),
        voucherId, this._company(companyId)
      );

      return this.findById(voucherId, companyId);
    })();
  }

  // ─── Step 10: Sales Voucher Methods ───────────────────────────────────

  createSales(data, lines) {
    return this.conn.transaction(() => {
      const voucherId = generateId('vch');
      const now = new Date().toISOString();

      const totalDebit = lines.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0);
      const totalCredit = lines.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0);
      const totalAmount = totalDebit;

      this.conn.prepare(`
        INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, receipt_mode,
          voucher_date, reference_number, description, contact_id, currency, exchange_rate,
          financial_year_id, total_amount, status, created_by, created_at, updated_at,
          sales_invoice_number, receiving_ledger_id, sales_ledger_id)
        VALUES (?, ?, ?, 'SALES', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)
      `).run(
        voucherId, this._company(data.companyId), data.voucher_number, data.receipt_mode,
        data.voucher_date, data.reference_number || null, data.description || '',
        data.contact_id || null, data.currency || 'INR', data.exchange_rate || 1.0,
        data.financial_year_id || null, totalAmount, data.created_by || 'system', now, now,
        data.sales_invoice_number || data.voucher_number || null,
        data.receiving_ledger_id || null,
        data.sales_ledger_id || null
      );

      return { id: voucherId, ...data, total_amount: totalAmount, status: 'DRAFT' };
    })();
  }

  postSales(voucherId, companyId, userId, journalEntry) {
    return this.conn.transaction(() => {
      const voucher = this.findById(voucherId, companyId);
      if (!voucher) throw new Error('Sales voucher not found');
      if (voucher.status === 'POSTED') throw new Error('Sales is already posted');
      if (voucher.status === 'CANCELLED') throw new Error('Cannot post a cancelled sales');
      if (voucher.status === 'REVERSED') throw new Error('Cannot post a reversed sales');

      this.conn.prepare('UPDATE vouchers SET status = ?, journal_entry_id = ?, posted_by = ?, posted_at = ? WHERE id = ? AND company_id = ?').run(
        'POSTED', journalEntry.id, userId, new Date().toISOString(),
        voucherId, this._company(companyId)
      );

      return this.findById(voucherId, companyId);
    })();
  }

  // ─── Step 11: Purchase Voucher Methods ─────────────────────────────────

  createPurchase(data, lines) {
    return this.conn.transaction(() => {
      const voucherId = generateId('vch');
      const now = new Date().toISOString();
      const totalDebit = lines.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0);
      const totalCredit = lines.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0);
      const totalAmount = totalDebit;

      this.conn.prepare(`
        INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, receipt_mode,
          voucher_date, reference_number, description, contact_id, currency, exchange_rate,
          financial_year_id, total_amount, status, created_by, created_at, updated_at,
          purchase_invoice_number, receiving_ledger_id, sales_ledger_id,
          purchase_ledger_id, payable_ledger_id)
        VALUES (?, ?, ?, 'PURCHASE', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        voucherId, this._company(data.companyId), data.voucher_number, data.payment_mode,
        data.voucher_date, data.reference_number || data.purchase_invoice_number || null, data.description || '',
        data.contact_id || null, data.currency || 'INR', data.exchange_rate || 1.0,
        data.financial_year_id || null, totalAmount, data.created_by || 'system', now, now,
        data.purchase_invoice_number || null, data.receiving_ledger_id || null,
        data.purchase_ledger_id || null, data.purchase_ledger_id || null, data.payable_ledger_id || null
      );

      return { id: voucherId, ...data, total_amount: totalAmount, status: 'DRAFT' };
    })();
  }

  postPurchase(voucherId, companyId, userId, journalEntry) {
    return this.conn.transaction(() => {
      const voucher = this.findById(voucherId, companyId);
      if (!voucher) throw new Error('Purchase voucher not found');
      if (voucher.status === 'POSTED') throw new Error('Purchase is already posted');
      if (voucher.status === 'CANCELLED') throw new Error('Cannot post a cancelled purchase');
      if (voucher.status === 'REVERSED') throw new Error('Cannot post a reversed purchase');

      this.conn.prepare('UPDATE vouchers SET status = ?, journal_entry_id = ?, posted_by = ?, posted_at = ? WHERE id = ? AND company_id = ?').run(
        'POSTED', journalEntry.id, userId, new Date().toISOString(),
        voucherId, this._company(companyId)
      );

      return this.findById(voucherId, companyId);
    })();
  }

  // ─── Step 12: Expense Voucher Methods ─────────────────────────────────

  createExpense(data, lines) {
    return this.conn.transaction(() => {
      const voucherId = generateId('vch');
      const now = new Date().toISOString();

      // Calculate totals from expense lines
      const totalExpense = lines.reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0);
      // total_amount = sum of all debit (expense) lines = sum of credits
      const totalAmount = totalExpense;

      const totalDebit = totalAmount;
      const totalCredit = totalAmount;

      this.conn.prepare(`
        INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, receipt_mode,
          voucher_date, reference_number, description, contact_id, currency, exchange_rate,
          financial_year_id, total_amount, status, created_by, created_at, updated_at,
          expense_voucher_number, payment_ledger_id, expense_payee_id)
        VALUES (?, ?, ?, 'EXPENSE', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)
      `).run(
        voucherId, this._company(data.companyId), data.voucher_number,
        data.payment_mode || 'CASH',
        data.expense_date, data.reference_number || null, data.description || '',
        data.payee_id || data.contact_id || null, data.currency || 'INR', data.exchange_rate || 1.0,
        data.financial_year_id || null, totalAmount, data.created_by || 'system', now, now,
        data.expense_voucher_number || data.voucher_number || null,
        data.payment_ledger_id || null,
        data.expense_payee_id || data.payee_id || data.contact_id || null
      );

      // Insert expense lines
      if (lines && lines.length > 0) {
        for (const line of lines) {
          this.conn.prepare(`
            INSERT INTO expense_voucher_lines
              (id, company_id, expense_voucher_id, expense_ledger_id, description, amount, tax_amount, line_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            generateId('evl'), this._company(data.companyId), voucherId,
            line.expense_ledger_id || line.ledger_id, line.description || '',
            parseFloat(line.amount) || 0, parseFloat(line.tax_amount) || 0,
            line.line_order || 0
          );
        }
      }

      return { id: voucherId, ...data, total_amount: totalAmount, total_debit: totalDebit, total_credit: totalCredit, status: 'DRAFT' };
    })();
  }

  postExpense(voucherId, companyId, userId, journalEntry) {
    return this.conn.transaction(() => {
      const voucher = this.findById(voucherId, companyId);
      if (!voucher) throw new Error('Expense voucher not found');
      if (voucher.status === 'POSTED') throw new Error('Expense is already posted');
      if (voucher.status === 'CANCELLED') throw new Error('Cannot post a cancelled expense');
      if (voucher.status === 'REVERSED') throw new Error('Cannot post a reversed expense');

      this.conn.prepare(
        'UPDATE vouchers SET status = ?, journal_entry_id = ?, posted_by = ?, posted_at = ? WHERE id = ? AND company_id = ?'
      ).run(
        'POSTED', journalEntry.id, userId, new Date().toISOString(),
        voucherId, this._company(companyId)
      );

      return this.findById(voucherId, companyId);
    })();
  }

  getExpenseWithLines(id, companyId) {
    const voucher = this.findById(id, companyId);
    if (!voucher) return null;
    const journalEntry = voucher.journal_entry_id
      ? this.conn.get('SELECT * FROM journal_entries WHERE id = ? AND company_id = ?', [voucher.journal_entry_id, this._company(companyId)])
      : null;
    const expLines = this.conn.all(
      `SELECT evl.*, a.code as expense_ledger_code, a.name as expense_ledger_name,
              a.type as expense_ledger_type, a.debit_credit_nature, a.is_active
       FROM expense_voucher_lines evl
       LEFT JOIN accounts a ON evl.expense_ledger_id = a.id
       WHERE evl.expense_voucher_id = ?`,
      [id]
    );

    // Get JE lines if JE exists
    let jeLines = [];
    if (journalEntry) {
      jeLines = this.conn.all(
        `SELECT jel.*, a.code as account_code, a.name as account_name, a.type as account_type
         FROM journal_entry_lines jel
         LEFT JOIN accounts a ON jel.account_id = a.id
         WHERE jel.journal_entry_id = ?`,
        [journalEntry.id]
      );
    }

    return { ...voucher, expense_lines: expLines || [], journal_entry: journalEntry ? { ...journalEntry, lines: jeLines } : null };
  }

  getExpenseLines(voucherId, companyId) {
    return this.conn.all(
      `SELECT evl.*, a.code as expense_ledger_code, a.name as expense_ledger_name
       FROM expense_voucher_lines evl
       LEFT JOIN accounts a ON evl.expense_ledger_id = a.id
       WHERE evl.expense_voucher_id = ?`,
      [voucherId]
    );
  }

  // ─── Step 13: Credit Note / Sales Return Methods ──────────────────────

  /**
   * Create a Credit Note voucher (DRAFT by default).
   * The Credit Note references an original Sales Invoice and produces
   * line-level detail in credit_note_lines for future line-item tracking.
   * All accounting impact goes through the Step 6 Journal Entry Engine.
   */
  createCreditNote(data, lines) {
    return this.conn.transaction(() => {
      const voucherId = generateId('vch');
      const now = new Date().toISOString();

      // Calculate total from credit note lines (server-side authoritative)
      const totalAmount = lines.reduce((sum, l) => sum + (parseFloat(l.line_total) || 0), 0);

      this.conn.prepare(`
        INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, receipt_mode,
          voucher_date, reference_number, description, contact_id, currency, exchange_rate,
          financial_year_id, total_amount, status, created_by, created_at, updated_at,
          credit_note_number, credit_note_type, reason, original_sales_invoice_id)
        VALUES (?, ?, ?, 'CREDIT_NOTE', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        voucherId, this._company(data.companyId), data.voucher_number,
        data.payment_mode || 'CREDIT',
        data.credit_note_date, data.reference_number || null,
        data.narration || data.description || '',
        data.contact_id || null, data.currency || 'INR', data.exchange_rate || 1.0,
        data.financial_year_id || null, totalAmount, data.created_by || 'system', now, now,
        data.credit_note_number || data.voucher_number || null,
        data.credit_note_type || 'SALES_RETURN',
        data.reason || null,
        data.original_sales_invoice_id || null
      );

      // Insert credit note lines
      if (lines && lines.length > 0) {
        for (const line of lines) {
          this.conn.prepare(`
            INSERT INTO credit_note_lines
              (id, company_id, credit_note_id, original_sales_invoice_id, original_sales_line_id,
               product_id, service_id, description, original_quantity, credit_quantity,
               rate, discount, tax_amount, line_total, line_order, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            generateId('cnl'), this._company(data.companyId), voucherId,
            line.original_sales_invoice_id || data.original_sales_invoice_id || null,
            line.original_sales_line_id || null,
            line.product_id || null, line.service_id || null,
            line.description || '', parseFloat(line.original_quantity) || 0,
            parseFloat(line.credit_quantity) || 0, parseFloat(line.rate) || 0,
            parseFloat(line.discount) || 0, parseFloat(line.tax_amount) || 0,
            parseFloat(line.line_total) || 0, line.line_order || 0, now, now
          );
        }
      }

      return { id: voucherId, ...data, total_amount: totalAmount, status: 'DRAFT' };
    })();
  }

  /**
   * Post a Credit Note voucher after the JE has been created and validated.
   */
  postCreditNote(voucherId, companyId, userId, journalEntry) {
    return this.conn.transaction(() => {
      const voucher = this.findById(voucherId, companyId);
      if (!voucher) throw new Error('Credit note not found');
      if (voucher.status === 'POSTED') throw new Error('Credit note is already posted');
      if (voucher.status === 'CANCELLED') throw new Error('Cannot post a cancelled credit note');
      if (voucher.status === 'REVERSED') throw new Error('Cannot post a reversed credit note');

      this.conn.prepare('UPDATE vouchers SET status = ?, journal_entry_id = ?, posted_by = ?, posted_at = ? WHERE id = ? AND company_id = ?').run(
        'POSTED', journalEntry.id, userId, new Date().toISOString(),
        voucherId, this._company(companyId)
      );

      return this.findById(voucherId, companyId);
    })();
  }

  /**
   * Get a Credit Note with its lines, JE, and original invoice reference.
   */
  getCreditNote(id, companyId) {
    const voucher = this.findById(id, companyId);
    if (!voucher || voucher.voucher_type !== 'CREDIT_NOTE') return null;

    const journalEntry = voucher.journal_entry_id
      ? this.conn.get('SELECT * FROM journal_entries WHERE id = ? AND company_id = ?', [voucher.journal_entry_id, this._company(companyId)])
      : null;

    let cnLines = [];
    const rawLines = this.conn.all(
      `SELECT cnl.*, p.name as product_name
       FROM credit_note_lines cnl
       LEFT JOIN products p ON cnl.product_id = p.id
       WHERE cnl.credit_note_id = ?`,
      [id]
    );
    cnLines = rawLines || [];

    let jeLines = [];
    if (journalEntry) {
      jeLines = this.conn.all(
        `SELECT jel.*, a.code as account_code, a.name as account_name, a.type as account_type
         FROM journal_entry_lines jel
         LEFT JOIN accounts a ON jel.account_id = a.id
         WHERE jel.journal_entry_id = ?`,
        [journalEntry.id]
      );
    }

    // Fetch original invoice reference if linked
    let originalInvoice = null;
    if (voucher.original_sales_invoice_id) {
      originalInvoice = this.conn.get(
        'SELECT id, voucher_number, voucher_date, total_amount, reference_number FROM vouchers WHERE id = ? AND company_id = ?',
        [voucher.original_sales_invoice_id, this._company(companyId)]
      );
    }

    return { ...voucher, credit_note_lines: cnLines, journal_entry: journalEntry ? { ...journalEntry, lines: jeLines } : null, original_invoice: originalInvoice };
  }

  /**
   * Get the remaining creditable amount for an original sales invoice.
   * = original invoice total - sum of all posted credit notes against it.
   */
  getCreditableAmount(originalInvoiceId, companyId) {
    const invoice = this.findById(originalInvoiceId, companyId);
    if (!invoice || invoice.voucher_type !== 'SALES') return null;

    const originalTotal = parseFloat(invoice.total_amount || 0);
    const creditRow = this.conn.get(
      `SELECT COALESCE(SUM(v.total_amount), 0) as credited
       FROM vouchers v
       WHERE v.original_sales_invoice_id = ? AND v.voucher_type = 'CREDIT_NOTE' AND v.status IN ('POSTED', 'DRAFT')`,
      [originalInvoiceId]
    );
    const credited = parseFloat(creditRow?.credited || 0);
    return { original_total: originalTotal, already_credited: credited, remaining_creditable: originalTotal - credited };
  }

  /**
   * Search credit notes with optional filters.
   */
  searchCreditNotes(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const company = this._company(options.companyId);
    const where = ['v.voucher_type = ?', 'v.company_id = ?'];
    const params = ['CREDIT_NOTE', company];

    if (options.status) {
      where.push('v.status = ?');
      params.push(options.status);
    }
    if (options.contactId) {
      where.push('v.contact_id = ?');
      params.push(options.contactId);
    }
    if (options.originalInvoiceId) {
      where.push('v.original_sales_invoice_id = ?');
      params.push(options.originalInvoiceId);
    }
    if (options.startDate) {
      where.push('v.voucher_date >= ?');
      params.push(options.startDate);
    }
    if (options.endDate) {
      where.push('v.voucher_date <= ?');
      params.push(options.endDate);
    }
    if (options.query) {
      const s = `%${options.query}%`;
      where.push('(v.voucher_number LIKE ? OR v.credit_note_number LIKE ? OR v.reference_number LIKE ?)');
      params.push(s, s, s);
    }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM vouchers v WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;

    const items = this.conn.all(`
      SELECT v.*, c.first_name, c.last_name, oi.voucher_number as original_invoice_number
      FROM vouchers v
      LEFT JOIN contacts c ON c.id = v.contact_id AND c.company_id = v.company_id
      LEFT JOIN vouchers oi ON oi.id = v.original_sales_invoice_id AND oi.company_id = v.company_id
      WHERE ${whereStr}
      ORDER BY v.voucher_date DESC, v.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return { items, total };
  }

  // ─── Step 14: Debit Note / Purchase Return Methods ──────────────────────

  createDebitNote(data, lines) {
    return this.conn.transaction(() => {
      const voucherId = generateId('vch');
      const now = new Date().toISOString();

      // Calculate total from debit note lines (server-side authoritative)
      const totalAmount = lines.reduce((sum, l) => sum + (parseFloat(l.line_total) || 0), 0);

      this.conn.prepare(`
        INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, receipt_mode,
          voucher_date, reference_number, description, contact_id, currency, exchange_rate,
          financial_year_id, total_amount, status, created_by, created_at, updated_at,
          original_purchase_invoice_id)
        VALUES (?, ?, ?, 'DEBIT_NOTE', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)
      `).run(
        voucherId, this._company(data.companyId), data.voucher_number,
        data.payment_mode || 'CREDIT',
        data.debit_note_date, data.reference_number || null,
        data.narration || data.description || '',
        data.contact_id || null, data.currency || 'INR', data.exchange_rate || 1.0,
        data.financial_year_id || null, totalAmount, data.created_by || 'system', now, now,
        data.original_purchase_invoice_id || null
      );

      // Insert debit note lines
      if (lines && lines.length > 0) {
        for (const line of lines) {
          this.conn.prepare(`
            INSERT INTO debit_note_lines
              (id, company_id, debit_note_id, original_purchase_invoice_id, original_purchase_line_id,
               product_id, service_id, description, original_quantity, return_quantity,
               rate, discount, tax_amount, line_total, line_order, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            generateId('dnl'), this._company(data.companyId), voucherId,
            line.original_purchase_invoice_id || data.original_purchase_invoice_id || null,
            line.original_purchase_line_id || null,
            line.product_id || null, line.service_id || null,
            line.description || '', parseFloat(line.original_quantity) || 0,
            parseFloat(line.return_quantity) || 0, parseFloat(line.rate) || 0,
            parseFloat(line.discount) || 0, parseFloat(line.tax_amount) || 0,
            parseFloat(line.line_total) || 0, line.line_order || 0, now, now
          );
        }
      }

      return { id: voucherId, ...data, total_amount: totalAmount, status: 'DRAFT' };
    })();
  }

  /**
   * Post a Debit Note voucher after the JE has been created and validated.
   */
  postDebitNote(voucherId, companyId, userId, journalEntry) {
    return this.conn.transaction(() => {
      const voucher = this.findById(voucherId, companyId);
      if (!voucher) throw new Error('Debit note not found');
      if (voucher.status === 'POSTED') throw new Error('Debit note is already posted');
      if (voucher.status === 'CANCELLED') throw new Error('Cannot post a cancelled debit note');
      if (voucher.status === 'REVERSED') throw new Error('Cannot post a reversed debit note');

      this.conn.prepare('UPDATE vouchers SET status = ?, journal_entry_id = ?, posted_by = ?, posted_at = ? WHERE id = ? AND company_id = ?').run(
        'POSTED', journalEntry.id, userId, new Date().toISOString(),
        voucherId, this._company(companyId)
      );

      return this.findById(voucherId, companyId);
    })();
  }

  /**
   * Get a Debit Note with its lines, JE, and original purchase invoice reference.
   */
  getDebitNote(id, companyId) {
    const voucher = this.findById(id, companyId);
    if (!voucher || voucher.voucher_type !== 'DEBIT_NOTE') return null;

    const journalEntry = voucher.journal_entry_id
      ? this.conn.get('SELECT * FROM journal_entries WHERE id = ? AND company_id = ?', [voucher.journal_entry_id, this._company(companyId)])
      : null;

    let dnLines = [];
    const rawLines = this.conn.all(
      `SELECT dnl.*, p.name as product_name
       FROM debit_note_lines dnl
       LEFT JOIN products p ON dnl.product_id = p.id
       WHERE dnl.debit_note_id = ?`,
      [id]
    );
    dnLines = rawLines || [];

    let jeLines = [];
    if (journalEntry) {
      jeLines = this.conn.all(
        `SELECT jel.*, a.code as account_code, a.name as account_name, a.type as account_type
         FROM journal_entry_lines jel
         LEFT JOIN accounts a ON jel.account_id = a.id
         WHERE jel.journal_entry_id = ?`,
        [journalEntry.id]
      );
    }

    // Fetch original purchase invoice reference if linked
    let originalInvoice = null;
    if (voucher.original_purchase_invoice_id) {
      originalInvoice = this.conn.get(
        'SELECT id, voucher_number, voucher_date, total_amount, reference_number FROM vouchers WHERE id = ? AND company_id = ?',
        [voucher.original_purchase_invoice_id, this._company(companyId)]
      );
    }

    return { ...voucher, debit_note_lines: dnLines, journal_entry: journalEntry ? { ...journalEntry, lines: jeLines } : null, original_invoice: originalInvoice };
  }

  /**
   * Get the remaining debit-note-eligible amount for an original purchase invoice.
   * = original invoice total - sum of all posted debit notes against it.
   */
  getDebitNotableAmount(originalInvoiceId, companyId) {
    const invoice = this.findById(originalInvoiceId, companyId);
    if (!invoice || invoice.voucher_type !== 'PURCHASE') return null;

    const originalTotal = parseFloat(invoice.total_amount || 0);
    const debitRow = this.conn.get(
      `SELECT COALESCE(SUM(v.total_amount), 0) as debited
       FROM vouchers v
       WHERE v.original_purchase_invoice_id = ? AND v.voucher_type = 'DEBIT_NOTE' AND v.status IN ('POSTED', 'DRAFT')`,
      [originalInvoiceId]
    );
    const debited = parseFloat(debitRow?.debited || 0);
    return { original_total: originalTotal, already_debited: debited, remaining_debitable: originalTotal - debited };
  }

  /**
   * Search debit notes with optional filters.
   */
  searchDebitNotes(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const company = this._company(options.companyId);
    const where = ['v.voucher_type = ?', 'v.company_id = ?'];
    const params = ['DEBIT_NOTE', company];

    if (options.status) {
      where.push('v.status = ?');
      params.push(options.status);
    }
    if (options.contactId) {
      where.push('v.contact_id = ?');
      params.push(options.contactId);
    }
    if (options.originalInvoiceId) {
      where.push('v.original_purchase_invoice_id = ?');
      params.push(options.originalInvoiceId);
    }
    if (options.startDate) {
      where.push('v.voucher_date >= ?');
      params.push(options.startDate);
    }
    if (options.endDate) {
      where.push('v.voucher_date <= ?');
      params.push(options.endDate);
    }
    if (options.query) {
      const s = `%${options.query}%`;
      where.push('(v.voucher_number LIKE ? OR v.reference_number LIKE ?)');
      params.push(s, s);
    }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(`SELECT COUNT(*) as total FROM vouchers v WHERE ${whereStr}`, params);
    const total = countRow?.total || 0;

    const items = this.conn.all(`
      SELECT v.*, c.first_name, c.last_name, oi.voucher_number as original_invoice_number
      FROM vouchers v
      LEFT JOIN contacts c ON c.id = v.contact_id AND c.company_id = v.company_id
      LEFT JOIN vouchers oi ON oi.id = v.original_purchase_invoice_id AND oi.company_id = v.company_id
      WHERE ${whereStr}
      ORDER BY v.voucher_date DESC, v.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return { items, total };
  }
}

module.exports = { VoucherRepository };
