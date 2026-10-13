const { CollectionsRepository } = require('../repositories/collections.repository');
const { AccountingEngine } = require('./accounting-engine.service');
const { NotFoundError, ValidationError } = require('../utils/errors');

/**
 * CollectionsService — Step 14: Business logic for receivables follow-up.
 * Delegates to CollectionsRepository and AccountingEngine for persistence and accounting.
 */
class CollectionsService {
  constructor(conn) {
    this.conn = conn;
    this.repo = new CollectionsRepository(conn);
    this.engine = new AccountingEngine(conn);
  }

  // ─── Collection Rules ───

  listCollectionRules(companyId, options) {
    return this.repo.listCollectionRules(companyId, options);
  }

  getCollectionRule(ruleId, companyId) {
    return this.repo.getCollectionRule(ruleId, companyId);
  }

  createCollectionRule(companyId, data, userId) {
    this._validateRule(data);
    return this.repo.createCollectionRule(companyId, data, userId);
  }

  updateCollectionRule(ruleId, companyId, data, userId) {
    return this.repo.updateCollectionRule(ruleId, companyId, data, userId);
  }

  deleteCollectionRule(ruleId, companyId) {
    return this.repo.deleteCollectionRule(ruleId, companyId);
  }

  _validateRule(data) {
    if (!data.trigger_type) throw new ValidationError('trigger_type is required');
    if (!data.action_type) throw new ValidationError('action_type is required');
    if (data.aging_days_from === undefined || data.aging_days_to === undefined) {
      throw new ValidationError('aging_days_from and aging_days_to are required');
    }
    const validTriggers = ['OVERDUE', 'DAYS_AFTER_DUE', 'INVOICE_STATUS'];
    if (!validTriggers.includes(data.trigger_type)) {
      throw new ValidationError(`Invalid trigger_type: ${data.trigger_type}`);
    }
    const validActions = ['EMAIL', 'SMS', 'WHATSAPP', 'PHONE_CALL', 'REMINDER',
      'PAYMENT_LINK', 'INTERNAL_TASK', 'ESCALATION', 'AGENCY_REFERRAL'];
    if (!validActions.includes(data.action_type)) {
      throw new ValidationError(`Invalid action_type: ${data.action_type}`);
    }
  }

  // ─── Dunning ───

  runDunning(companyId, asOfDate) {
    return this.repo.runDunning(companyId, asOfDate);
  }

  getDunningActions(companyId, options) {
    const opts = { ...options, action_type: options.action_type || 'EMAIL' };
    return this.repo.listCollectionActions(companyId, opts);
  }

  // ─── Collection Actions ───

  listCollectionActions(companyId, options) {
    return this.repo.listCollectionActions(companyId, options);
  }

  getCollectionAction(actionId, companyId) {
    return this.repo.getCollectionAction(actionId, companyId);
  }

  createCollectionAction(companyId, data, userId) {
    if (!data.customer_id) throw new ValidationError('customer_id is required');
    if (!data.action_type) throw new ValidationError('action_type is required');
    return this.repo.createCollectionAction(companyId, data, userId);
  }

  executeCollectionAction(actionId, companyId, userId, responseStatus) {
    return this.repo.executeCollectionAction(actionId, companyId, userId, responseStatus);
  }

  // ─── Templates ───

  listTemplates(companyId, options) {
    return this.repo.listTemplates(companyId, options);
  }

  getTemplate(templateId, companyId) {
    const company = this._company(companyId);
    const row = this.conn.get('SELECT * FROM communication_templates WHERE id = ? AND company_id = ?', [templateId, company]);
    if (!row) throw new NotFoundError(`Template ${templateId} not found`);
    return row;
  }

  createTemplate(companyId, data, userId) {
    if (!data.name) throw new ValidationError('name is required');
    if (!data.channel) throw new ValidationError('channel is required');
    return this.repo.createTemplate(companyId, data, userId);
  }

  renderTemplate(templateBody, variables) {
    return this.repo.renderTemplate(templateBody, variables);
  }

  // ─── Interest ───

  listInterestRules(companyId, options) {
    return this.repo.listInterestRules(companyId, options);
  }

  getInterestRule(ruleId, companyId) {
    return this.repo.getInterestRule(ruleId, companyId);
  }

  createInterestRule(companyId, data, userId) {
    if (!data.rate_type) throw new ValidationError('rate_type is required');
    if (data.rate === undefined) throw new ValidationError('rate is required');
    return this.repo.createInterestRule(companyId, data, userId);
  }

  calculateInterest(companyId, billId, calculationDate) {
    return this.repo.calculateInterest(companyId, billId, calculationDate);
  }

  createInterestCharge(companyId, billId, calculationDate, userId) {
    return this.repo.createInterestCharge(companyId, billId, calculationDate, userId);
  }

  approveInterestCharge(chargeId, companyId, approvedAmount, userId) {
    return this.repo.approveInterestCharge(chargeId, companyId, approvedAmount, userId);
  }

  postInterestCharge(chargeId, companyId, userId) {
    return this.repo.postInterestCharge(chargeId, companyId, userId, this.engine);
  }

  // ─── Bad Debt ───

  listBadDebtCases(companyId, options) {
    return this.repo.listBadDebtCases(companyId, options);
  }

  getBadDebtCase(caseId, companyId) {
    return this.repo.getBadDebtCase(caseId, companyId);
  }

  createBadDebtCase(companyId, data, userId) {
    if (!data.bill_id) throw new ValidationError('bill_id is required');
    if (!data.reason) throw new ValidationError('reason is required');
    return this.repo.createBadDebtCase(companyId, data, userId);
  }

  approveBadDebtCase(caseId, companyId, userId) {
    return this.repo.approveBadDebtCase(caseId, companyId, userId);
  }

  writeOffBadDebt(caseId, companyId, userId) {
    return this.repo.writeOffBadDebt(caseId, companyId, userId, this.engine);
  }

  reverseBadDebtCase(caseId, companyId, userId) {
    return this.repo.reverseBadDebtCase(caseId, companyId, userId);
  }

  // ─── Payment Plans ───

  listPaymentPlans(companyId, options) {
    return this.repo.listPaymentPlans(companyId, options);
  }

  getPaymentPlan(planId, companyId) {
    return this.repo.getPaymentPlan(planId, companyId);
  }

  createPaymentPlan(companyId, data, userId) {
    if (!data.bill_id) throw new ValidationError('bill_id is required');
    if (!data.total_amount) throw new ValidationError('total_amount is required');
    if (!data.instalment_count) throw new ValidationError('instalment_count is required');

    // Normalize caller-supplied instalments to a genuine local Array.
    // Accepts both spellings ('instalments' / 'installments'), normal arrays,
    // cross-realm arrays, iterables and array-like objects. Does not mutate input.
    const raw = data.installments !== undefined ? data.installments : data.instalments;
    let installments = Array.from(raw || []);

    if (installments.length === 0) {
      const totalAmount = parseFloat(data.total_amount);
      const downPayment = parseFloat(data.down_payment) || 0;
      const financedAmount = totalAmount - downPayment;
      const count = parseInt(data.instalment_count);
      const startDate = data.start_date || new Date().toISOString().split('T')[0];
      installments = this.engine.generateInstallments(financedAmount, count, startDate, data.frequency);
    }

    return this.repo.createPaymentPlan(companyId, { ...data, installments }, userId);
  }

  approvePaymentPlan(planId, companyId, userId) {
    return this.repo.approvePaymentPlan(planId, companyId, userId);
  }

  cancelPaymentPlan(planId, companyId, userId) {
    return this.repo.cancelPaymentPlan(planId, companyId, userId);
  }

  applyPaymentToPlan(companyId, planId, paymentId, amount) {
    return this.repo.applyPaymentToPlan(companyId, planId, paymentId, amount);
  }

  // ─── Risk Scoring ───

  calculateRiskScore(companyId, contactId) {
    return this.repo.calculateRiskScore(companyId, contactId);
  }

  // ─── Forecast ───

  getCollectionForecast(companyId, options) {
    return this.repo.getCollectionForecast(companyId, options);
  }

  // ─── Escalation ───

  createEscalation(companyId, contactId, billId, level, reason, userId) {
    if (!contactId) throw new ValidationError('customer_id is required');
    if (!level) throw new ValidationError('escalation_level is required');
    return this.repo.createEscalation(companyId, contactId, billId, level, reason, userId);
  }

  listEscalations(companyId, options) {
    return this.repo.listEscalations(companyId, options);
  }

  approveEscalation(escalationId, companyId, userId) {
    return this.repo.approveEscalation(escalationId, companyId, userId);
  }

  // ─── Dashboard ───

  getCollectionsDashboard(companyId) {
    return this.repo.getCollectionsDashboard(companyId);
  }

  _company(companyId) {
    return companyId || 'default';
  }
}

module.exports = { CollectionsService };
