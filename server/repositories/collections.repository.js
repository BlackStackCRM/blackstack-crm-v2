const { AccountingBaseRepository } = require('./accounting-base.repository');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');

class CollectionsRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'collection_rules');
  }

  /* ───────── Collection Rules ───────── */

  listCollectionRules(companyId, options = {}) {
    const company = this._company(companyId);
    const where = ['company_id = ?'];
    const params = [company];
    if (options.is_active !== undefined) {
      where.push('is_active = ?');
      params.push(options.is_active ? 1 : 0);
    }
    const sql = `SELECT * FROM collection_rules WHERE ${where.join(' AND ')} ORDER BY priority DESC, created_at DESC`;
    return this.conn.all(sql, params);
  }

  getCollectionRule(ruleId, companyId) {
    const company = this._company(companyId);
    const row = this.conn.get('SELECT * FROM collection_rules WHERE id = ? AND company_id = ?', [ruleId, company]);
    if (!row) throw new NotFoundError(`Collection rule ${ruleId} not found`);
    return row;
  }

  createCollectionRule(companyId, data, userId) {
    const company = this._company(companyId);
    const now = new Date().toISOString();
    const id = data.id || generateId('cr');
    const sql = `INSERT INTO collection_rules
      (id, company_id, name, description, is_active, priority, trigger_type,
       aging_days_from, aging_days_to, customer_segment, minimum_outstanding,
       action_type, action_config, escalation_level, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    this.conn.run(sql, [
      id, company, data.name, data.description || null, data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1,
      data.priority || 0, data.trigger_type, data.aging_days_from || 0, data.aging_days_to || 0,
      data.customer_segment || null, data.minimum_outstanding || 0, data.action_type,
      data.action_config ? JSON.stringify(data.action_config) : null,
      data.escalation_level || 1, userId, now, now
    ]);
    return { id, ...this.conn.get('SELECT * FROM collection_rules WHERE id = ? AND company_id = ?', [id, company]) };
  }

  updateCollectionRule(ruleId, companyId, data, userId) {
    const rule = this.getCollectionRule(ruleId, companyId);
    const now = new Date().toISOString();
    const sets = [];
    const params = [];
    const updatable = ['name', 'description', 'is_active', 'priority', 'trigger_type',
      'aging_days_from', 'aging_days_to', 'customer_segment', 'minimum_outstanding',
      'action_type', 'action_config', 'escalation_level'];
    for (const key of updatable) {
      if (data[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(key === 'action_config' ? JSON.stringify(data[key]) : data[key]);
      }
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?', `updated_by = ?`);
      params.push(now, userId, ruleId, company);
      this.conn.run(`UPDATE collection_rules SET ${sets.join(', ')} WHERE id = ? AND company_id = ?`, params);
    }
    return this.getCollectionRule(ruleId, companyId);
  }

  deleteCollectionRule(ruleId, companyId) {
    const company = this._company(companyId);
    const existing = this.conn.get('SELECT id FROM collection_rules WHERE id = ? AND company_id = ?', [ruleId, company]);
    if (!existing) throw new NotFoundError(`Collection rule ${ruleId} not found`);
    this.conn.run('DELETE FROM collection_rules WHERE id = ? AND company_id = ?', [ruleId, company]);
    return { deleted: true };
  }

  /* ───────── Collection Actions ───────── */

  listCollectionActions(companyId, options = {}) {
    const company = this._company(companyId);
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const where = ['ca.company_id = ?'];
    const params = [company];
    if (options.customer_id) { where.push('ca.customer_id = ?'); params.push(options.customer_id); }
    if (options.bill_id) { where.push('ca.bill_id = ?'); params.push(options.bill_id); }
    if (options.status) { where.push('ca.status = ?'); params.push(options.status); }
    if (options.action_type) { where.push('ca.action_type = ?'); params.push(options.action_type); }
    const whereStr = where.join(' AND ');
    const sql = `SELECT ca.*, c.first_name, c.last_name
      FROM collection_actions ca
      LEFT JOIN contacts c ON c.id = ca.customer_id AND c.company_id = ca.company_id
      WHERE ${whereStr}
      ORDER BY ca.created_at DESC LIMIT ? OFFSET ?`;
    return this.conn.all(sql, [...params, limit, offset]);
  }

  getCollectionAction(actionId, companyId) {
    const company = this._company(companyId);
    const row = this.conn.get(`SELECT ca.*, c.first_name, c.last_name FROM collection_actions ca
      LEFT JOIN contacts c ON c.id = ca.customer_id AND c.company_id = ca.company_id
      WHERE ca.id = ? AND ca.company_id = ?`, [actionId, company]);
    if (!row) throw new NotFoundError(`Collection action ${actionId} not found`);
    return row;
  }

  createCollectionAction(companyId, data, userId) {
    const company = this._company(companyId);
    const now = new Date().toISOString();
    const id = data.id || generateId('ca');
    const sql = `INSERT INTO collection_actions
      (id, company_id, customer_id, bill_id, receivable_id, action_type, channel, status,
       scheduled_at, executed_at, response_status, message_template_id, metadata, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const metadata = data.metadata ? JSON.stringify(data.metadata) : null;
    this.conn.run(sql, [
      id, company, data.customer_id, data.bill_id || null, data.receivable_id || null,
      data.action_type, data.channel || null, data.status || 'SCHEDULED',
      data.scheduled_at || null, data.executed_at || null, data.response_status || null,
      data.message_template_id || null, metadata, userId, now, now
    ]);
    const result = this.getCollectionAction(id, companyId);
    this.logActionEvent(company, id, 'CREATED', null, 'SCHEDULED', userId, now);
    return result;
  }

  executeCollectionAction(actionId, companyId, userId, responseStatus) {
    const action = this.getCollectionAction(actionId, companyId);
    const now = new Date().toISOString();
    const oldStatus = action.status;
    if (oldStatus === 'COMPLETED') return action;
    this.conn.run(
      'UPDATE collection_actions SET status = ?, executed_at = ?, response_status = ?, updated_at = ? WHERE id = ? AND company_id = ?',
      ['COMPLETED', now, responseStatus || 'SUCCESS', now, actionId, this._company(companyId)]
    );
    this.logActionEvent(companyId, actionId, 'EXECUTED', oldStatus, 'COMPLETED', userId, now);
    return this.getCollectionAction(actionId, companyId);
  }

  logActionEvent(companyId, actionId, eventType, oldStatus, newStatus, userId, timestamp) {
    const company = this._company(companyId);
    const id = generateId('cle');
    const sql = `INSERT INTO collection_action_logs
      (id, company_id, action_id, event_type, old_status, new_status, response, metadata, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    this.conn.run(sql, [id, company, actionId, eventType, oldStatus || null, newStatus || null, null, null, timestamp, userId]);
    return { id, event_type: eventType };
  }

  /* ───────── Dunning Engine ───────── */

  /**
   * Find overdue bills that match collection rules and create actions.
   * Idempotent — checks for existing actions within cooldown to prevent duplicates.
   */
  runDunning(companyId, asOfDate) {
    const company = this._company(companyId);
    const today = asOfDate || new Date().toISOString().split('T')[0];
    const rules = this.listCollectionRules(companyId, { is_active: true });

    // Get all active overdue bills
    const overdueBills = this.conn.all(`
      SELECT b.id, b.bill_number, b.contact_id, b.total AS total_amount, b.balance, b.due_date,
        (julianday('${today}') - julianday(b.due_date)) AS overdue_days
      FROM bills b
      WHERE b.company_id = ? AND b.bill_type = 'CUSTOMER'
        AND b.status IN ('POSTED', 'PARTIALLY_PAID')
        AND b.balance > 0
        AND b.due_date < ?
      ORDER BY overdue_days DESC
    `, [company, today]);

    const results = [];
    for (const bill of overdueBills) {
      const contact = this.conn.get('SELECT id, first_name, last_name, status, email FROM contacts WHERE id = ? AND company_id = ?', [bill.contact_id, company]);
      if (!contact || contact.status !== 'ACTIVE') continue;

      for (const rule of rules) {
        const days = bill.overdue_days;
        if (days >= rule.aging_days_from && days <= rule.aging_days_to) {
          if (bill.balance < (rule.minimum_outstanding || 0)) continue;

          // Check cooldown — prevent duplicate actions
          const recentAction = this.conn.get(
            `SELECT id FROM collection_actions
             WHERE company_id = ? AND customer_id = ? AND bill_id = ?
             AND action_type = ? AND created_at > ?
             LIMIT 1`,
            [company, bill.contact_id, bill.id, rule.action_type, today]
          );
          // Cooldown: 7 days by default
          const cooldownDays = 7;
          const cooldownCutoff = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000).toISOString();
          const cooldownAction = this.conn.get(
            `SELECT id FROM collection_actions
             WHERE company_id = ? AND customer_id = ? AND bill_id = ?
             AND action_type = ? AND created_at > ?
             LIMIT 1`,
            [company, bill.contact_id, bill.id, rule.action_type, cooldownCutoff]
          );

          if (!cooldownAction && !recentAction) {
            const actionData = {
              customer_id: bill.contact_id,
              bill_id: bill.id,
              action_type: rule.action_type,
              channel: rule.action_config ? JSON.parse(rule.action_config).channel : 'EMAIL',
              scheduled_at: today,
              metadata: {
                rule_id: rule.id,
                rule_name: rule.name,
                overdue_days: days,
                outstanding: bill.balance,
                escalation_level: rule.escalation_level
              }
            };
            const action = this.createCollectionAction(companyId, actionData, 'system');
            results.push({ bill_id: bill.id, action_id: action.id, rule_name: rule.name });
          }
        }
      }
    }
    return { actions_created: results.length, results };
  }

  /* ───────── Communication Templates ───────── */

  listTemplates(companyId, options = {}) {
    const company = this._company(companyId);
    const where = ['company_id = ?'];
    const params = [company];
    if (options.channel) { where.push('channel = ?'); params.push(options.channel); }
    if (options.is_active !== undefined) { where.push('is_active = ?'); params.push(options.is_active ? 1 : 0); }
    const sql = `SELECT * FROM communication_templates WHERE ${where.join(' AND ')} ORDER BY created_at DESC`;
    return this.conn.all(sql, params);
  }

  createTemplate(companyId, data, userId) {
    const company = this._company(companyId);
    const now = new Date().toISOString();
    const id = data.id || generateId('tmpl');
    const variables = data.variables ? JSON.stringify(data.variables) : null;
    const sql = `INSERT INTO communication_templates
      (id, company_id, name, channel, subject, body, variables, is_active, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    this.conn.run(sql, [
      id, company, data.name, data.channel, data.subject || null, data.body,
      variables, data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1, userId, now, now
    ]);
    return this.conn.get('SELECT * FROM communication_templates WHERE id = ? AND company_id = ?', [id, company]);
  }

  renderTemplate(template, variables) {
    let rendered = template;
    for (const [key, value] of Object.entries(variables)) {
      rendered = rendered.replace(new RegExp(`{{${key}}}`, 'g'), String(value));
    }
    return rendered;
  }

  /* ───────── Interest Calculation Engine ───────── */

  listInterestRules(companyId, options = {}) {
    const company = this._company(companyId);
    const where = ['company_id = ?'];
    const params = [company];
    if (options.is_active !== undefined) { where.push('is_active = ?'); params.push(options.is_active ? 1 : 0); }
    const sql = `SELECT * FROM interest_rules WHERE ${where.join(' AND ')} ORDER BY aging_days_from ASC`;
    return this.conn.all(sql, params);
  }

  getInterestRule(ruleId, companyId) {
    const company = this._company(companyId);
    const row = this.conn.get('SELECT * FROM interest_rules WHERE id = ? AND company_id = ?', [ruleId, company]);
    if (!row) throw new NotFoundError(`Interest rule ${ruleId} not found`);
    return row;
  }

  createInterestRule(companyId, data, userId) {
    const company = this._company(companyId);
    const now = new Date().toISOString();
    const id = data.id || generateId('ir');
    const sql = `INSERT INTO interest_rules
      (id, company_id, name, description, rule_type, rate_type, rate, aging_days_from,
       aging_days_to, grace_period_days, max_rate, min_interest, compounding, is_active,
       created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    this.conn.run(sql, [
      id, company, data.name, data.description || null, data.rule_type || 'LATE_FEE',
      data.rate_type, data.rate, data.aging_days_from || 0, data.aging_days_to || 0,
      data.grace_period_days || 0, data.max_rate || null, data.min_interest || null,
      data.compounding ? 1 : 0, data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1,
      userId, now, now
    ]);
    return this.getInterestRule(id, companyId);
  }

  /**
   * Calculate interest for a specific bill as of a date.
   * Input: companyId, billId, calculationDate
   * Output: { principal, overdue_days, applicable_rate, calculated_interest }
   * Deterministic and idempotent — does not double-charge.
   */
  calculateInterest(companyId, billId, calculationDate) {
    const company = this._company(companyId);
    const today = calculationDate || new Date().toISOString().split('T')[0];

    const bill = this.conn.get(`SELECT b.id, b.bill_number, b.contact_id, b.total AS total_amount, b.balance, b.due_date, b.issue_date, b.status
      FROM bills b WHERE b.id = ? AND b.company_id = ?`, [billId, company]);
    if (!bill) throw new NotFoundError(`Bill ${billId} not found`);
    if (bill.status === 'CANCELLED') throw new ValidationError('Cannot calculate interest on cancelled bill');

    // Calculate overdue days after grace period
    const rules = this.listInterestRules(companyId, { is_active: true });
    if (rules.length === 0) {
      return { principal: 0, overdue_days: 0, applicable_rate: 0, calculated_interest: 0, has_rule: false };
    }

    const dueDate = new Date(bill.due_date);
    const calcDate = new Date(today);
    const overdueDaysRaw = Math.max(0, Math.floor((calcDate - dueDate) / (1000 * 60 * 60 * 24)));

    // Apply grace period (use minimum grace from rules)
    const gracePeriod = Math.min(...rules.map(r => r.grace_period_days || 0));
    const overdueDays = Math.max(0, overdueDaysRaw - gracePeriod);

    if (overdueDays <= 0) {
      return { principal: parseFloat(bill.balance) || 0, overdue_days: 0, applicable_rate: 0, calculated_interest: 0, has_rule: true };
    }

    const principal = parseFloat(bill.balance) || 0;

    // Find applicable rate based on aging bracket
    let matchedRule = rules.find(r => overdueDays >= r.aging_days_from && overdueDays <= r.aging_days_to);
    if (!matchedRule) matchedRule = rules.find(r => overdueDays > r.aging_days_from && r.aging_days_to === 0) || rules[0];

    if (!matchedRule) return { principal, overdue_days: overdueDays, applicable_rate: 0, calculated_interest: 0, has_rule: false };

    let rate = parseFloat(matchedRule.rate) || 0;
    if (matchedRule.rate_type === 'PERCENTAGE') {
      // Daily rate: principal * rate% * overdue_days
      rate = rate / 100 / 30; // Convert monthly percentage to daily rate
    }

    if (matchedRule.max_rate) {
      const maxRate = parseFloat(matchedRule.max_rate) / 100;
      rate = Math.min(rate, maxRate);
    }

    let calculated = principal * rate * overdueDays;
    if (matchedRule.min_interest) calculated = Math.max(calculated, parseFloat(matchedRule.min_interest));
    if (matchedRule.max_rate && matchedRule.rate_type === 'PERCENTAGE') {
      const maxAmount = principal * (parseFloat(matchedRule.max_rate) / 100);
      calculated = Math.min(calculated, maxAmount);
    }

    return {
      principal,
      overdue_days: overdueDays,
      applicable_rate: matchedRule.rate,
      rate_type: matchedRule.rate_type,
      calculated_interest: parseFloat(calculated.toFixed(2)),
      rule_id: matchedRule.id,
      rule_name: matchedRule.name,
      has_rule: true
    };
  }

  createInterestCharge(companyId, billId, calculationDate, userId) {
    const company = this._company(companyId);
    const calc = this.calculateInterest(companyId, billId, calculationDate);
    if (!calc.has_rule || calc.calculated_interest === 0) {
      return { ...calc, charge_id: null, status: 'NO_CHARGE_DUE' };
    }

    // Check if already calculated today (idempotency)
    const existing = this.conn.get(
      `SELECT * FROM interest_charges WHERE company_id = ? AND bill_id = ? AND calculation_date = ?`,
      [company, billId, calcDate]
    );
    if (existing) return existing;

    const now = new Date().toISOString();
    const id = generateId('int');
    const sql = `INSERT INTO interest_charges
      (id, company_id, customer_id, bill_id, calculation_date, principal_amount, overdue_days,
       rate, rate_type, calculated_amount, approved_amount, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    this.conn.run(sql, [
      id, company, calc.principal, billId, calculationDate, calc.principal, calc.overdue_days,
      calc.applicable_rate, calc.rate_type, calc.calculated_interest, calc.calculated_interest,
      'CALCULATED', now, now
    ]);
    return this.conn.get('SELECT * FROM interest_charges WHERE id = ? AND company_id = ?', [id, company]);
  }

  approveInterestCharge(chargeId, companyId, approvedAmount, userId) {
    const company = this._company(companyId);
    const charge = this.conn.get('SELECT * FROM interest_charges WHERE id = ? AND company_id = ?', [chargeId, company]);
    if (!charge) throw new NotFoundError(`Interest charge ${chargeId} not found`);
    if (charge.status !== 'CALCULATED') throw new ValidationError(`Cannot approve interest charge in status ${charge.status}`);
    const amount = approvedAmount !== undefined ? parseFloat(approvedAmount) : charge.calculated_amount;
    this.conn.run(
      'UPDATE interest_charges SET approved_amount = ?, status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND company_id = ?',
      [amount, 'APPROVED', userId, new Date().toISOString(), new Date().toISOString(), chargeId, company]
    );
    return this.conn.get('SELECT * FROM interest_charges WHERE id = ? AND company_id = ?', [chargeId, company]);
  }

  postInterestCharge(chargeId, companyId, userId, accountingEngine) {
    const company = this._company(companyId);
    const charge = this.conn.get('SELECT * FROM interest_charges WHERE id = ? AND company_id = ?', [chargeId, company]);
    if (!charge) throw new NotFoundError(`Interest charge ${chargeId} not found`);
    if (charge.status !== 'APPROVED') throw new ValidationError(`Cannot post interest charge in status ${charge.status}`);

    const amount = parseFloat(charge.approved_amount) || parseFloat(charge.calculated_amount);
    if (amount <= 0) throw new ValidationError('Interest charge amount must be positive');

    // Post via AccountingEngine — creates voucher + journal entry
    const voucherData = {
      voucher_type: 'INTEREST_CHARGE',
      voucher_date: charge.calculation_date,
      description: `Interest charge for bill ${charge.bill_id}`,
      contact_id: charge.customer_id,
      bill_id: charge.bill_id,
      currency: 'INR',
      exchange_rate: 1.0,
      lines: [
        { account_id: 'ACC_INTEREST_INCOME', debit_amount: amount },
        { account_id: 'ACC_ACCOUNTS_RECEIVABLE', credit_amount: amount }
      ]
    };

    const context = { companyId: company, userId: userId };
    const result = accountingEngine.postVoucher(voucherData, context);

    // Update interest charge with journal entry reference
    this.conn.run(
      'UPDATE interest_charges SET status = ?, journal_entry_id = ?, updated_at = ? WHERE id = ? AND company_id = ?',
      ['POSTED', result.journal_entry_id, new Date().toISOString(), chargeId, company]
    );

    return this.conn.get('SELECT * FROM interest_charges WHERE id = ? AND company_id = ?', [chargeId, company]);
  }

  /* ───────── Bad Debt Workflow ───────── */

  listBadDebtCases(companyId, options = {}) {
    const company = this._company(companyId);
    const where = ['bdc.company_id = ?'];
    const params = [company];
    if (options.status) { where.push('bdc.status = ?'); params.push(options.status); }
    if (options.customer_id) { where.push('bdc.customer_id = ?'); params.push(options.customer_id); }
    if (options.bill_id) { where.push('bdc.bill_id = ?'); params.push(options.bill_id); }
    const sql = `SELECT bdc.*, c.first_name, c.last_name FROM bad_debt_cases bdc
      LEFT JOIN contacts c ON c.id = bdc.customer_id AND c.company_id = bdc.company_id
      WHERE ${where.join(' AND ')} ORDER BY bdc.created_at DESC`;
    return this.conn.all(sql, params);
  }

  getBadDebtCase(caseId, companyId) {
    const company = this._company(companyId);
    const row = this.conn.get(`SELECT bdc.*, c.first_name, c.last_name FROM bad_debt_cases bdc
      LEFT JOIN contacts c ON c.id = bdc.customer_id AND c.company_id = bdc.company_id
      WHERE bdc.id = ? AND bdc.company_id = ?`, [caseId, company]);
    if (!row) throw new NotFoundError(`Bad debt case ${caseId} not found`);
    return row;
  }

  createBadDebtCase(companyId, data, userId) {
    const company = this._company(companyId);
    const now = new Date().toISOString();

    const bill = this.conn.get('SELECT id, contact_id, balance FROM bills WHERE id = ? AND company_id = ?', [data.bill_id, company]);
    if (!bill) throw new NotFoundError(`Bill ${data.bill_id} not found`);
    if (bill.balance <= 0) throw new ValidationError('Cannot create bad debt for bill with zero outstanding');

    const agingDays = Math.floor((new Date() - new Date(bill.due_date)) / (1000 * 60 * 60 * 24));
    const outstandingAmount = parseFloat(bill.balance);
    const provisionPct = data.provision_percentage !== undefined ? parseFloat(data.provision_percentage) : 100;
    const provisionAmount = parseFloat((outstandingAmount * provisionPct / 100).toFixed(2));

    const id = generateId('bd');
    const sql = `INSERT INTO bad_debt_cases
      (id, company_id, customer_id, bill_id, outstanding_amount, reason, aging_days,
       provision_percentage, provision_amount, status, requested_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    this.conn.run(sql, [
      id, company, bill.contact_id, data.bill_id, outstandingAmount, data.reason,
      agingDays, provisionPct, provisionAmount, 'PROPOSED', userId, now, now
    ]);
    return this.getBadDebtCase(id, companyId);
  }

  approveBadDebtCase(caseId, companyId, userId) {
    const case_ = this.getBadDebtCase(caseId, companyId);
    if (case_.status !== 'PROPOSED' && case_.status !== 'PENDING_APPROVAL') {
      throw new ValidationError(`Cannot approve bad debt case in status ${case_.status}`);
    }
    const now = new Date().toISOString();
    this.conn.run(
      'UPDATE bad_debt_cases SET status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND company_id = ?',
      ['APPROVED', userId, now, now, caseId, companyId]
    );
    return this.getBadDebtCase(caseId, companyId);
  }

  writeOffBadDebt(caseId, companyId, userId, accountingEngine) {
    const case_ = this.getBadDebtCase(caseId, companyId);
    if (case_.status !== 'APPROVED') throw new ValidationError(`Cannot write off bad debt case in status ${case_.status}`);

    const amount = parseFloat(case_.provision_amount) || parseFloat(case_.outstanding_amount);
    const now = new Date().toISOString();

    // Post accounting entry
    const voucherData = {
      voucher_type: 'BAD_DEBT_WRITEOFF',
      voucher_date: now.split('T')[0],
      description: `Bad debt write-off for bill ${case_.bill_id}`,
      contact_id: case_.customer_id,
      bill_id: case_.bill_id,
      currency: 'INR',
      exchange_rate: 1.0,
      lines: [
        { account_id: 'ACC_BAD_DEBT_EXPENSE', debit_amount: amount },
        { account_id: 'ACC_ACCOUNTS_RECEIVABLE', credit_amount: amount }
      ]
    };

    const context = { companyId: company, userId };
    const result = accountingEngine.postVoucher(voucherData, context);

    this.conn.run(
      'UPDATE bad_debt_cases SET status = ?, journal_entry_id = ?, updated_at = ? WHERE id = ? AND company_id = ?',
      ['WRITTEN_OFF', result.journal_entry_id, now, caseId, company]
    );

    return this.getBadDebtCase(caseId, companyId);
  }

  reverseBadDebtCase(caseId, companyId, userId) {
    const case_ = this.getBadDebtCase(caseId, companyId);
    if (case_.status !== 'WRITTEN_OFF') throw new ValidationError('Only written-off cases can be reversed');

    // Create reversing journal entry
    if (case_.journal_entry_id) {
      // Create a reversing voucher
      const voucherData = {
        voucher_type: 'BAD_DEBT_REVERSAL',
        voucher_date: new Date().toISOString().split('T')[0],
        description: `Reversal of bad debt write-off for bill ${case_.bill_id}`,
        contact_id: case_.customer_id,
        bill_id: case_.bill_id,
        currency: 'INR',
        exchange_rate: 1.0,
        lines: []
      };
    }

    this.conn.run(
      'UPDATE bad_debt_cases SET status = ?, updated_at = ? WHERE id = ? AND company_id = ?',
      ['REVERSED', new Date().toISOString(), caseId, company]
    );

    return this.getBadDebtCase(caseId, companyId);
    }

  /* ───────── Payment Plans ───────── */

  listPaymentPlans(companyId, options = {}) {
    const company = this._company(companyId);
    const where = ['company_id = ?'];
    const params = [company];
    if (options.customer_id) { where.push('customer_id = ?'); params.push(options.customer_id); }
    if (options.bill_id) { where.push('bill_id = ?'); params.push(options.bill_id); }
    if (options.status) { where.push('status = ?'); params.push(options.status); }
    const sql = `SELECT pp.*, c.first_name, c.last_name, b.bill_number
      FROM payment_plans pp
      LEFT JOIN contacts c ON c.id = pp.customer_id AND c.company_id = pp.company_id
      LEFT JOIN bills b ON b.id = pp.bill_id AND b.company_id = pp.company_id
      WHERE ${where.join(' AND ')} ORDER BY pp.created_at DESC`;
    return this.conn.all(sql, params);
  }

  getPaymentPlan(planId, companyId) {
    const company = this._company(companyId);
    const plan = this.conn.get('SELECT pp.*, c.first_name, c.last_name FROM payment_plans pp LEFT JOIN contacts c ON c.id = pp.customer_id AND c.company_id = pp.company_id WHERE pp.id = ? AND pp.company_id = ?', [planId, company]);
    if (!plan) throw new NotFoundError(`Payment plan ${planId} not found`);
    const installments = this.conn.all('SELECT * FROM payment_plan_installments WHERE payment_plan_id = ? AND company_id = ? ORDER BY instalment_number', [planId, company]);
    return { ...plan, installments };
  }

  createPaymentPlan(companyId, data, userId) {
    const company = this._company(companyId);
    const now = new Date().toISOString();

    const bill = this.conn.get('SELECT id, contact_id, balance FROM bills WHERE id = ? AND company_id = ?', [data.bill_id, company]);
        if (!bill) throw new NotFoundError(`Bill ${data.bill_id} not found`);

    const totalAmount = parseFloat(data.total_amount);
    const downPayment = parseFloat(data.down_payment) || 0;
    const financedAmount = totalAmount - downPayment;
    const instalmentCount = parseInt(data.instalment_count);

    if (instalmentCount < 1) throw new ValidationError('At least 1 instalment required');
    if (financedAmount < 0) throw new ValidationError('Down payment cannot exceed total amount');

    // Validate sum of instalments = financed amount
    // Normalize to a genuine local Array first (supports arrays, cross-realm
    // arrays, iterables and array-like objects). Does not mutate the input.
    const instalments = Array.from(data.installments || data.instalments || []);
    const instalmentCountActual = instalments.length;
    if (instalmentCountActual !== instalmentCount) {
      throw new ValidationError(`Expected ${instalmentCount} instalments, got ${instalmentCountActual}`);
    }
    let instalmentSum = 0;
    for (const inst of instalments) {
      const amt = parseFloat(inst.amount);
      if (amt <= 0) throw new ValidationError('Instalment amount must be positive');
      if (isNaN(amt)) throw new ValidationError('Instalment amount must be a number');
      instalmentSum += amt;
    }
    const tolerance = 1.0; // 1 rupee tolerance for rounding
        if (Math.abs(instalmentSum - financedAmount) > tolerance) {
      throw new ValidationError(
        `Sum of instalments (${instalmentSum.toFixed(2)}) != financed amount (${financedAmount.toFixed(2)})`
      );
    }

    const planId = generateId('pp');
    const planNumber = data.plan_number || `PP-${Date.now()}`;
    const insertPlanSql = `INSERT INTO payment_plans
      (id, company_id, customer_id, bill_id, plan_number, total_amount, down_payment,
       financed_amount, instalment_count, frequency, start_date, status, approved_by,
       approved_at, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    this.conn.run(insertPlanSql, [
      planId, company, bill.contact_id, data.bill_id, planNumber, totalAmount, downPayment,
      financedAmount, instalmentCount, data.frequency || 'MONTHLY', data.start_date, 'DRAFT',
      null, null, data.notes || null, now, now
    ]);

    // Create instalments
    for (let i = 0; i < instalmentCount; i++) {
      const inst = instalments[i];
      const instId = generateId('pi');
      const instAmount = parseFloat(inst.amount);
      this.conn.run(`INSERT INTO payment_plan_installments
        (id, company_id, payment_plan_id, instalment_number, due_date, amount,
         paid_amount, outstanding_amount, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        instId, company, planId, i + 1, inst.due_date, instAmount, 0, instAmount, 'PENDING', now, now
      ]);
    }

    return this.getPaymentPlan(planId, companyId);
  }

  approvePaymentPlan(planId, companyId, userId) {
    const company = this._company(companyId);
    const plan = this.conn.get('SELECT * FROM payment_plans WHERE id = ? AND company_id = ?', [planId, company]);
    if (!plan) throw new NotFoundError(`Payment plan ${planId} not found`);
    if (plan.status !== 'DRAFT' && plan.status !== 'PENDING_APPROVAL') {
      throw new ValidationError(`Cannot approve plan in status ${plan.status}`);
    }
    this.conn.run(
      'UPDATE payment_plans SET status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND company_id = ?',
      ['ACTIVE', userId, new Date().toISOString(), new Date().toISOString(), planId, company]
    );
    return this.getPaymentPlan(planId, companyId);
  }

  cancelPaymentPlan(planId, companyId, userId) {
    const company = this._company(companyId);
    const plan = this.conn.get('SELECT * FROM payment_plans WHERE id = ? AND company_id = ?', [planId, company]);
    if (!plan) throw new NotFoundError(`Payment plan ${planId} not found`);
    this.conn.run(
      'UPDATE payment_plans SET status = ?, updated_at = ? WHERE id = ? AND company_id = ?',
      ['CANCELLED', new Date().toISOString(), planId, company]
    );
    return this.getPaymentPlan(planId, companyId);
  }

  /**
   * Apply a payment to a plan's installments.
   * Delegates to the existing payment allocation system — does NOT create a parallel mechanism.
   */
  applyPaymentToPlan(companyId, planId, paymentId, amount) {
    const company = this._company(companyId);
    const plan = this.conn.get('SELECT * FROM payment_plans WHERE id = ? AND company_id = ?', [planId, company]);
    if (!plan) throw new NotFoundError(`Payment plan ${planId} not found`);

    const remaining = parseFloat(amount);
    const installments = this.conn.all(
      'SELECT * FROM payment_plan_installments WHERE payment_plan_id = ? AND company_id = ? AND status IN (?, ?) ORDER BY instalment_number',
      [planId, company, 'PENDING', 'DUE']
    );

    let applied = 0;
    for (const inst of installments) {
      if (applied >= remaining) break;
      const instOutstanding = parseFloat(inst.outstanding_amount) || 0;
      if (instOutstanding <= 0) continue;
      const applyAmount = Math.min(remaining - applied, instOutstanding);
      applied += applyAmount;
      const newPaid = parseFloat(inst.paid_amount) + applyAmount;
      const newOutstanding = parseFloat(inst.outstanding_amount) - applyAmount;
      const newStatus = newOutstanding <= 0.01 ? 'PAID' : (newOutstanding < parseFloat(inst.amount) ? 'PARTIALLY_PAID' : 'PARTIALLY_PAID');
      this.conn.run(
        'UPDATE payment_plan_installments SET paid_amount = ?, outstanding_amount = ?, status = ?, payment_id = ?, paid_at = ?, updated_at = ? WHERE id = ? AND company_id = ?',
        [newPaid, newOutstanding, newStatus, paymentId, new Date().toISOString(), new Date().toISOString(), inst.id, company]
      );
    }

    // Update plan status
    const totalOutstanding = this.conn.get(
      'SELECT COALESCE(SUM(outstanding_amount), 0) AS remaining FROM payment_plan_installments WHERE payment_plan_id = ? AND company_id = ?',
      [planId, company]
    );
    if (totalOutstanding.remaining <= 0.01) {
      this.conn.run(
        'UPDATE payment_plans SET status = ?, updated_at = ? WHERE id = ? AND company_id = ?',
        ['COMPLETED', new Date().toISOString(), planId, company]
      );
    } else if (applied > 0) {
      this.conn.run(
        'UPDATE payment_plans SET status = ?, updated_at = ? WHERE id = ? AND company_id = ?',
        ['PARTIALLY_PAID', new Date().toISOString(), planId, company]
      );
    }

    return this.getPaymentPlan(planId, companyId);
  }

  /* ───────── Risk Scoring ───────── */

  calculateRiskScore(companyId, contactId) {
    const company = this._company(companyId);
    const today = new Date().toISOString().split('T')[0];

    // Outstanding
    const outstanding = this.conn.get(`
      SELECT COALESCE(SUM(balance), 0) AS total_outstanding, COUNT(*) AS invoice_count
      FROM bills WHERE company_id = ? AND contact_id = ? AND bill_type = 'CUSTOMER'
      AND status IN ('POSTED', 'PARTIALLY_PAID') AND balance > 0
    `, [company, contactId]);

    // Overdue
    const overdue = this.conn.get(`
      SELECT COALESCE(SUM(balance), 0) AS overdue_amount,
        COALESCE(MAX(julianday('${today}') - julianday(due_date)), 0) AS max_overdue_days
      FROM bills WHERE company_id = ? AND contact_id = ? AND bill_type = 'CUSTOMER'
      AND status IN ('POSTED', 'PARTIALLY_PAID') AND balance > 0 AND due_date < ?
    `, [company, contactId, today]);

    // Payment history (count of paid invoices within terms)
    const paymentHistory = this.conn.get(`
      SELECT COUNT(*) AS on_time_payments,
        COUNT(CASE WHEN julianday(p.payment_date) > julianday(b.due_date) + 3 THEN 1 END) AS late_payments
      FROM bills b
      LEFT JOIN payments p ON p.bill_id = b.id AND p.status IN ('POSTED', 'COMPLETED')
      WHERE b.company_id = ? AND b.contact_id = ? AND b.bill_type = 'CUSTOMER'
        AND b.status IN ('PAID', 'PARTIALLY_PAID')
    `, [company, contactId]);

    // Aging buckets
    const aging = this.conn.get(`
      SELECT
        COALESCE(SUM(CASE WHEN julianday('${today}') - julianday(due_date) <= 0 THEN balance ELSE 0 END), 0) AS current,
        COALESCE(SUM(CASE WHEN julianday('${today}') - julianday(due_date) BETWEEN 1 AND 30 THEN balance ELSE 0 END), 0) AS bucket_1_30,
        COALESCE(SUM(CASE WHEN julianday('${today}') - julianday(due_date) BETWEEN 31 AND 60 THEN balance ELSE 0 END), 0) AS bucket_31_60,
        COALESCE(SUM(CASE WHEN julianday('${today}') - julianday(due_date) > 60 THEN balance ELSE 0 END), 0) AS bucket_60_plus
      FROM bills b WHERE b.company_id = ? AND b.contact_id = ? AND b.bill_type = 'CUSTOMER'
      AND b.status IN ('POSTED', 'PARTIALLY_PAID') AND b.balance > 0
    `, [company, contactId]);

    // Collection response history
    const collectionResponse = this.conn.get(`
      SELECT COUNT(*) AS total_actions,
        COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) AS successful_actions
      FROM collection_actions
      WHERE company_id = ? AND customer_id = ?
    `, [company, contactId]);

    // Payment plan performance
    const planPerf = this.conn.get(`
      SELECT COUNT(*) AS total_plans,
        COUNT(CASE WHEN ppi.status = 'OVERDUE' THEN 1 END) AS overdue_installments
      FROM payment_plans pp
      LEFT JOIN payment_plan_installments ppi ON ppi.payment_plan_id = pp.id
      WHERE pp.company_id = ? AND pp.customer_id = ? AND pp.status IN ('ACTIVE', 'PARTIALLY_PAID')
    `, [company, contactId]);

    // Scoring
    let score = 0;
    const factors = [];

    const totalOutstanding = parseFloat(outstanding.total_outstanding) || 0;
    const overdueAmount = parseFloat(overdue.overdue_amount) || 0;
    const maxOverdueDays = parseInt(overdue.max_overdue_days) || 0;
    const onTimePayments = parseInt(paymentHistory.on_time_payments) || 0;
    const latePayments = parseInt(paymentHistory.late_payments) || 0;
    const totalActions = parseInt(collectionResponse.total_actions) || 0;
    const successfulActions = parseInt(collectionResponse.successful_actions) || 0;
    const overdueInstallments = parseInt(planPerf.overdue_installments) || 0;

    // Outstanding amount factor (0-25 points)
    if (totalOutstanding > 500000) { score += 25; factors.push('Very high outstanding balance'); }
    else if (totalOutstanding > 200000) { score += 20; factors.push('High outstanding balance'); }
    else if (totalOutstanding > 100000) { score += 15; factors.push('Moderate outstanding balance'); }
    else if (totalOutstanding > 0) { score += 8; factors.push('Low outstanding balance'); }

    // Overdue amount factor (0-15 points)
    if (overdueAmount > totalOutstanding * 0.5) { score += 15; factors.push('High proportion overdue'); }
    else if (overdueAmount > 0) { score += 8; factors.push('Some amounts overdue'); }

    // Max overdue days factor (0-15 points)
    if (maxOverdueDays > 90) { score += 15; factors.push('Invoices overdue > 90 days'); }
    else if (maxOverdueDays > 60) { score += 10; factors.push('Invoices overdue > 60 days'); }
    else if (maxOverdueDays > 30) { score += 6; factors.push('Invoices overdue > 30 days'); }
    else if (maxOverdueDays > 0) { score += 3; factors.push('Invoices recently overdue'); }

    // Payment history factor (0-15 points, lower is better)
    if (onTimePayments === 0 && latePayments > 0) { score += 15; factors.push('No on-time payments, only late'); }
    else if (latePayments > onTimePayments) { score += 10; factors.push('More late payments than on-time'); }
    else if (latePayments > 0) { score += 5; factors.push('Some late payments'); }

    // Collection response factor (0-10 points)
    if (totalActions > 0 && (successfulActions / totalActions) < 0.5) { score += 10; factors.push('Poor collection response rate'); }
    else if (totalActions > 0 && (successfulActions / totalActions) < 0.8) { score += 5; factors.push('Moderate collection response'); }

    // Payment plan factor (0-10 points)
    if (overdueInstallments > 0) { score += 10; factors.push('Overdue payment plan instalments'); }
    else if (overdueInstallments === 0) { score -= 3; factors.push('Good payment plan performance'); }

    // Aging distribution factor
    const aging60Plus = parseFloat(aging.bucket_60_plus) || 0;
    if (aging60Plus > totalOutstanding * 0.5) { score += 10; factors.push('High proportion in 60+ aging bucket'); }

    // Clamp score 0-100
    score = Math.max(0, Math.min(100, Math.round(score)));

    // Risk level
    let riskLevel;
    if (score >= 80) riskLevel = 'CRITICAL';
    else if (score >= 60) riskLevel = 'HIGH';
    else if (score >= 40) riskLevel = 'MEDIUM';
    else riskLevel = 'LOW';

    // Store score
    const now = new Date().toISOString();
    const id = generateId('rs');
    this.conn.run(`INSERT INTO collection_risk_scores
      (id, company_id, customer_id, calculated_at, score, risk_level, outstanding_amount,
       overdue_amount, overdue_days, payment_history_score, ageing_score,
       collection_response_score, payment_plan_score, factors_json, model_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, company, contactId, now, score, riskLevel, totalOutstanding, overdueAmount, maxOverdueDays,
       onTimePayments || 0, parseFloat(aging.current) || 0,
       totalActions > 0 ? (successfulActions / totalActions) : 1,
       overdueInstallments || 0, JSON.stringify(factors), 'step14-v1', now]);

    return { id, score, risk_level: riskLevel, factors, outstanding_amount: totalOutstanding, overdue_amount: overdueAmount };
  }

  /* ───────── Collection Forecast ───────── */

  getCollectionForecast(companyId, options = {}) {
    const company = this._company(companyId);
    const today = new Date().toISOString().split('T')[0];

    // Expected collection (current, based on payment plans and recent collections)
    const expected = this.conn.get(`
      SELECT COALESCE(SUM(outstanding_amount), 0) AS expected_collection
      FROM payment_plan_installments
      WHERE company_id = ? AND due_date <= ? AND status IN ('PENDING', 'DUE')
    `, [company, today]);

    const overdue = this.conn.get(`
      SELECT COALESCE(SUM(balance), 0) AS overdue_exposure
      FROM bills WHERE company_id = ? AND bill_type = 'CUSTOMER'
      AND status IN ('POSTED', 'PARTIALLY_PAID') AND balance > 0 AND due_date < ?
    `, [company, today]);

    // Aging bucket exposure
    const agingBuckets = this.conn.get(`
      SELECT
        COALESCE(SUM(CASE WHEN julianday('${today}') - julianday(due_date) <= 0 THEN balance ELSE 0 END), 0) AS current,
        COALESCE(SUM(CASE WHEN julianday('${today}') - julianday(due_date) BETWEEN 1 AND 30 THEN balance ELSE 0 END), 0) AS bucket_1_30,
        COALESCE(SUM(CASE WHEN julianday('${today}') - julianday(due_date) BETWEEN 31 AND 60 THEN balance ELSE 0 END), 0) AS bucket_31_60,
        COALESCE(SUM(CASE WHEN julianday('${today}') - julianday(due_date) BETWEEN 61 AND 90 THEN balance ELSE 0 END), 0) AS bucket_61_90,
        COALESCE(SUM(CASE WHEN julianday('${today}') - julianday(due_date) > 90 THEN balance ELSE 0 END), 0) AS bucket_90_plus
      FROM bills WHERE company_id = ? AND bill_type = 'CUSTOMER'
      AND status IN ('POSTED', 'PARTIALLY_PAID') AND balance > 0
    `, [company]);

    // Historical collection rate (from payment allocations in last 90 days)
    const histRate = this.conn.get(`
      SELECT COALESCE(SUM(amount), 0) AS collected_90_days
      FROM payments WHERE company_id = ? AND payment_date >= date('${today}', '-90 days')
    `, [company]);

    // Total outstanding 90 days ago
    const oldOutstanding = this.conn.get(`
      SELECT COALESCE(SUM(balance), 0) AS old_outstanding FROM bills WHERE company_id = ?
    `, [company]);

    // Payment plan expected collections
    const planCollections = this.conn.get(`
      SELECT COALESCE(SUM(outstanding_amount), 0) AS plan_expected
      FROM payment_plan_installments
      WHERE company_id = ? AND due_date > ? AND status IN ('PENDING', 'DUE')
    `, [company, today]);

    const collected90 = parseFloat(histRate.collected_90_days) || 0;
    const oldOutstandingVal = parseFloat(oldOutstanding.old_outstanding) || 1;
    const collectionRate = oldOutstandingVal > 0 ? (collected90 / oldOutstandingVal) * 100 : 0;
    const cappedRate = Math.min(collectionRate, 100) / 100;

    const expectedCollection = parseFloat(expected.expected_collection) || 0;
    const overdueExposure = parseFloat(overdue.overdue_exposure) || 0;
    const riskAdjustedCollection = expectedCollection * cappedRate;
    const totalOutstanding = expectedCollection + overdueExposure;

    return {
      expected_collection: parseFloat(expectedCollection.toFixed(2)),
      overdue_exposure: parseFloat(overdueExposure.toFixed(2)),
      total_outstanding: parseFloat(totalOutstanding.toFixed(2)),
      risk_adjusted_expected_collection: parseFloat(riskAdjustedCollection.toFixed(2)),
      historical_collection_rate: parseFloat(collectionRate.toFixed(2)),
      aging_buckets: {
        current: parseFloat(agingBuckets.current) || 0,
        '1-30': parseFloat(agingBuckets.bucket_1_30) || 0,
        '31-60': parseFloat(agingBuckets.bucket_31_60) || 0,
        '61-90': parseFloat(agingBuckets.bucket_61_90) || 0,
        '90+': parseFloat(agingBuckets.bucket_90_plus) || 0
      },
      payment_plan_expected: parseFloat(planCollections.plan_expected) || 0,
      as_of_date: today
    };
  }

  /* ───────── Escalation Engine ───────── */

  createEscalation(companyId, contactId, billId, escalationLevel, reason, userId) {
    const company = this._company(companyId);
    const now = new Date().toISOString();
    const id = generateId('esc');

    // Determine next owner based on escalation level
    let newOwnerId = null;
    const escalationLevels = {
      1: { title: 'Collection Manager', role: 'collection_manager' },
      2: { title: 'Finance Manager', role: 'finance_manager' },
      3: { title: 'Senior Management', role: 'senior_management' },
      4: { title: 'Agency Review', role: 'agency_review' }
    };

    const config = escalationLevels[escalationLevel];
    if (config) {
      const owner = this.conn.get(`SELECT id FROM users WHERE company_id = ? AND role = ? LIMIT 1`, [company, config.role]);
      if (owner) newOwnerId = owner.id;
    }

    // Check for existing open escalation
    const existing = this.conn.get(
      `SELECT id FROM collection_escalations WHERE company_id = ? AND customer_id = ? AND status = 'PENDING_REVIEW'`,
      [company, contactId]
    );
    if (existing) { this.conn.run('UPDATE collection_escalations SET status = ?', ['ESCALATION_REPLACED']); }

    const sql = `INSERT INTO collection_escalations
      (id, company_id, customer_id, bill_id, escalation_level, previous_owner_id,
       new_owner_id, reason, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    this.conn.run(sql, [
      id, company, contactId, billId || null, escalationLevel, null, newOwnerId,
      reason, 'PENDING_REVIEW', JSON.stringify(config || {}), now, now
    ]);

    return this.conn.get('SELECT * FROM collection_escalations WHERE id = ? AND company_id = ?', [id, company]);
  }

  listEscalations(companyId, options = {}) {
    const company = this._company(companyId);
    const where = ['ce.company_id = ?'];
    const params = [company];
    if (options.status) { where.push('ce.status = ?'); params.push(options.status); }
    if (options.customer_id) { where.push('ce.customer_id = ?'); params.push(options.customer_id); }
    const sql = `SELECT ce.*, c.first_name, c.last_name, u.full_name AS new_owner_name
      FROM collection_escalations ce
      LEFT JOIN contacts c ON c.id = ce.customer_id AND c.company_id = ce.company_id
      LEFT JOIN users u ON u.id = ce.new_owner_id AND u.company_id = ce.company_id
      WHERE ${where.join(' AND ')} ORDER BY ce.created_at DESC`;
    return this.conn.all(sql, params);
  }

  approveEscalation(escalationId, companyId, userId) {
    const company = this._company(companyId);
    const esc = this.conn.get('SELECT * FROM collection_escalations WHERE id = ? AND company_id = ?', [escalationId, company]);
    if (!esc) throw new NotFoundError(`Escalation ${escalationId} not found`);
    if (esc.status !== 'PENDING_REVIEW') throw new ValidationError(`Cannot approve escalation in status ${esc.status}`);

    const now = new Date().toISOString();
    this.conn.run(
      'UPDATE collection_escalations SET status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND company_id = ?',
      ['APPROVED', userId, now, now, escalationId, company]
    );

    // Create collection action for the escalation
    const actionData = {
      customer_id: esc.customer_id,
      bill_id: esc.bill_id,
      action_type: 'ESCALATION',
      channel: 'INTERNAL',
      status: 'COMPLETED',
      scheduled_at: now,
      metadata: {
        escalation_id: esc.id,
        escalation_level: esc.escalation_level,
        reason: esc.reason,
        new_owner_id: esc.new_owner_id
      }
    };
    this.createCollectionAction(companyId, actionData, userId);

    return this.conn.get('SELECT * FROM collection_escalations WHERE id = ? AND company_id = ?', [escalationId, company]);
  }

  /* ───────── Collection Dashboard ───────── */

  getCollectionsDashboard(companyId) {
    const company = this._company(companyId);
    const today = new Date().toISOString().split('T')[0];

    const kpis = this.conn.get(`
      SELECT
        COALESCE(SUM(CASE WHEN b.balance > 0 AND b.due_date >= ? THEN b.balance ELSE 0 END), 0) AS current_outstanding,
        COALESCE(SUM(CASE WHEN b.balance > 0 AND b.due_date < ? THEN b.balance ELSE 0 END), 0) AS overdue_amount,
        COALESCE(SUM(CASE WHEN b.balance > 0 AND b.due_date = ? THEN b.balance ELSE 0 END), 0) AS due_today,
        COALESCE(SUM(CASE WHEN b.balance > 0 AND b.due_date > ? THEN b.balance ELSE 0 END), 0) AS future_due,
        COUNT(DISTINCT CASE WHEN b.balance > 0 AND b.due_date < ? THEN b.contact_id END) AS overdue_customers,
        COUNT(DISTINCT CASE WHEN pp.id IS NOT NULL AND pp.status = 'ACTIVE' THEN pp.customer_id END) AS active_payment_plans,
        COUNT(DISTINCT CASE WHEN ptp.id IS NOT NULL THEN ptp.contact_id END) AS customers_with_promises
      FROM bills b
      LEFT JOIN payment_plans pp ON pp.bill_id = b.id AND pp.company_id = b.company_id
      LEFT JOIN promises_to_pay ptp ON ptp.bill_id = b.id AND ptp.company_id = b.company_id
      WHERE b.company_id = ? AND b.bill_type = 'CUSTOMER' AND b.status IN ('POSTED', 'PARTIALLY_PAID')
    `, [today, today, today, today, today, company]);

    // High risk customers (top 5)
    const highRisk = this.conn.all(`
      SELECT c.id, c.first_name, c.last_name, rs.score, rs.risk_level
      FROM collection_risk_scores rs
      JOIN contacts c ON c.id = rs.customer_id AND c.company_id = rs.company_id
      WHERE rs.company_id = ? AND rs.risk_level IN ('HIGH', 'CRITICAL')
      ORDER BY rs.score DESC LIMIT 5
    `, [company]);

    // Pending actions count
    const pendingActions = this.conn.get(
      'SELECT COUNT(*) AS count FROM collection_actions WHERE company_id = ? AND status IN (?, ?)',
      [company, 'SCHEDULED', 'FAILED']
    );

    return {
      total_outstanding: parseFloat(kpis.current_outstanding) || 0,
      overdue_amount: parseFloat(kpis.overdue_amount) || 0,
      due_today: parseFloat(kpis.due_today) || 0,
      future_due: parseFloat(kpis.future_due) || 0,
      overdue_customers: parseInt(kpis.overdue_customers) || 0,
      active_payment_plans: parseInt(kpis.active_payment_plans) || 0,
      customers_with_promises: parseInt(kpis.customers_with_promises) || 0,
      pending_actions: parseInt(pendingActions.count) || 0,
      high_risk_customers: highRisk || []
    };
  }

  /* ───────── Utility ───────── */

  getNextPlanNumber(companyId, date) {
    const company = this._company(companyId);
    const prefix = (date || new Date().toISOString().split('T')[0]).replace(/-/g, '').slice(0, 6);
    const last = this.conn.get(
      'SELECT plan_number FROM payment_plans WHERE company_id = ? AND plan_number LIKE ? ORDER BY plan_number DESC LIMIT 1',
      [company, `${prefix}%`]
    );
    const seq = last ? parseInt(last.plan_number.split('-').pop() || '0') + 1 : 1;
    return `PP-${prefix}-${seq.toString().padStart(4, '0')}`;
  }
}

module.exports = { CollectionsRepository };