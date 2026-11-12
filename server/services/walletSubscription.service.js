const crypto = require('crypto');
const { resolveCaller } = require('./rbac.service');
const { AuthorizationError, NotFoundError, ValidationError, AppError } = require('../utils/errors');

const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const durationUnits = ['day', 'month', 'year'];
const durationDaysFor = (value, unit) => Number(value) * ({ day: 1, month: 30, year: 365 }[unit] || 0);
const addDuration = (date, value, unit) => {
  const result = new Date(date);
  if (unit === 'month' || unit === 'year') {
    const day = result.getUTCDate();
    result.setUTCDate(1);
    if (unit === 'month') result.setUTCMonth(result.getUTCMonth() + Number(value));
    else result.setUTCFullYear(result.getUTCFullYear() + Number(value));
    const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
    result.setUTCDate(Math.min(day, lastDay));
  } else result.setUTCDate(result.getUTCDate() + Number(value));
  return result;
};
const endOfUtcDay = (date) => {
  const result = new Date(date);
  result.setUTCHours(23, 59, 59, 999);
  return result;
};
const moneyMinor = (value, allowZero = false) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0) || Math.round(n * 100) !== n * 100) throw new ValidationError('Amount must be non-negative with at most two decimal places.');
  return Math.round(n * 100);
};

class WalletSubscriptionService {
  constructor(db) { this.db = db; }

  caller(userId) {
    const caller = resolveCaller(this.db, { userId });
    if (!caller) throw new AuthorizationError('An active account is required.');
    return caller;
  }

  agencyScope(agencyId) {
    if (!agencyId) return [];
    const ids = new Set([agencyId]);
    const queue = [agencyId];
    while (queue.length) {
      const children = this.db.all('SELECT child_agency_id AS id FROM agency_parent_relationships WHERE parent_agency_id=?', [queue.shift()]);
      for (const row of children) if (row.id && !ids.has(row.id)) { ids.add(row.id); queue.push(row.id); }
    }
    return [...ids];
  }

  accountInfo(companyId) {
    const company = this.db.get('SELECT id, name, status FROM companies WHERE id=?', [companyId]);
    if (!company) throw new NotFoundError('Account', companyId);
    const agency = this.db.get('SELECT id, name FROM agencies WHERE company_id=? LIMIT 1', [companyId]);
    if (agency) {
      const parent = this.db.get('SELECT parent_agency_id FROM agency_parent_relationships WHERE child_agency_id=?', [agency.id]);
      return { ...company, type: parent ? 'sub_agency' : 'agency', agencyId: agency.id };
    }
    const customer = this.db.get('SELECT agency_id FROM customer_tenant_agencies WHERE company_id=?', [companyId]);
    return { ...company, type: 'customer_tenant', agencyId: customer && customer.agency_id };
  }

  accessibleCompanyIds(caller) {
    if (caller.role === 'platform') return this.db.all('SELECT id FROM companies').map((r) => r.id);
    const own = caller.localCompanyId ? [caller.localCompanyId] : [];
    if (!['agency', 'sub_agency'].includes(caller.role)) return own;
    const agencyIds = this.agencyScope(caller.localAgencyId);
    if (!agencyIds.length) return own;
    const placeholders = agencyIds.map(() => '?').join(',');
    const childCompanies = this.db.all(`SELECT company_id AS id FROM agencies WHERE id IN (${placeholders})`, agencyIds).map((r) => r.id);
    const customerCompanies = this.db.all(`SELECT company_id AS id FROM customer_tenant_agencies WHERE agency_id IN (${placeholders})`, agencyIds).map((r) => r.id);
    return [...new Set([...own, ...childCompanies, ...customerCompanies])];
  }

  assertCanSee(caller, companyId) {
    if (!this.accessibleCompanyIds(caller).includes(companyId)) throw new AuthorizationError('You do not have access to this account wallet.');
  }

  ensureWallet(companyId) {
    this.db.run('INSERT OR IGNORE INTO wallets(company_id) VALUES (?)', companyId);
    return this.db.get('SELECT * FROM wallets WHERE company_id=?', [companyId]);
  }

  audit(actorId, action, entityType, entityId, values, companyId = 'default') {
    this.db.run('INSERT INTO audit_logs(id,company_id,user_id,action,entity_type,entity_id,new_values_json) VALUES(?,?,?,?,?,?,?)', id('audit'), companyId || 'default', actorId, action, entityType, entityId, JSON.stringify(values || {}));
  }

  listWallets(userId) {
    const caller = this.caller(userId);
    const ids = this.accessibleCompanyIds(caller);
    if (!ids.length) return { wallets: [], transactions: [] };
    ids.forEach((companyId) => this.ensureWallet(companyId));
    const marks = ids.map(() => '?').join(',');
    const wallets = this.db.all(`SELECT w.company_id, c.name AS account_name, w.balance_minor, w.currency, w.updated_at FROM wallets w JOIN companies c ON c.id=w.company_id WHERE w.company_id IN (${marks}) ORDER BY c.name`, ids)
      .map((w) => ({ ...w, ...this.accountInfo(w.company_id), balance: w.balance_minor / 100 }));
    const transactions = this.db.all(`SELECT * FROM wallet_transactions WHERE receiver_company_id IN (${marks}) OR sender_company_id IN (${marks}) ORDER BY created_at DESC`, [...ids, ...ids]);
    return { wallets, transactions: transactions.map((t) => ({ ...t, amount: t.amount_minor / 100, senderPreviousBalance: t.sender_previous_minor == null ? null : t.sender_previous_minor / 100, senderUpdatedBalance: t.sender_updated_minor == null ? null : t.sender_updated_minor / 100, receiverPreviousBalance: t.receiver_previous_minor / 100, receiverUpdatedBalance: t.receiver_updated_minor / 100 })) };
  }

  walletDetails(userId, companyId) {
    const caller = this.caller(userId);
    this.assertCanSee(caller, companyId);
    const wallet = this.ensureWallet(companyId);
    const transactions = this.db.all('SELECT * FROM wallet_transactions WHERE receiver_company_id=? OR sender_company_id=? ORDER BY created_at DESC', [companyId, companyId]);
    return { wallet: { ...wallet, ...this.accountInfo(companyId), balance: wallet.balance_minor / 100 }, transactions: transactions.map((t) => ({ ...t, amount: t.amount_minor / 100 })) };
  }

  credit(userId, targetCompanyId, amount, idempotencyKey, description) {
    const caller = this.caller(userId);
    if (!idempotencyKey || String(idempotencyKey).length > 160) throw new ValidationError('A valid Idempotency-Key header is required.');
    const amountMinor = moneyMinor(amount);
    const target = this.accountInfo(targetCompanyId);
    const key = String(idempotencyKey);
    const requestHash = hash({ actor: caller.localUserId, targetCompanyId, amountMinor, description: description || '' });
    const existing = this.db.get('SELECT * FROM wallet_transactions WHERE idempotency_key=?', [key]);
    if (existing) {
      if (existing.request_hash !== requestHash) throw new AppError('Idempotency key was already used for a different wallet operation.', 'IDEMPOTENCY_CONFLICT', 409);
      return existing;
    }
    if (caller.role === 'customer_tenant') throw new AuthorizationError('Customer accounts cannot credit wallets.');
    let senderCompanyId = caller.localCompanyId;
    let senderType = caller.role;
    if (caller.role === 'platform') {
      // Platform-issued credits are funded by the central treasury, not by the
      // platform user's tenant wallet. Keep its account id and unchanged balance
      // snapshot in the ledger so every credit records a sender account.
      senderCompanyId = caller.localCompanyId;
      senderType = 'platform_treasury';
    } else {
      this.assertCanSee(caller, targetCompanyId);
      if (targetCompanyId === caller.localCompanyId) throw new AuthorizationError('You cannot credit your own wallet.');
      if (caller.role === 'agency' && !['sub_agency', 'customer_tenant'].includes(target.type)) throw new AuthorizationError('Agencies may credit only subordinate sub-agency and customer wallets.');
      if (caller.role === 'sub_agency' && (target.type !== 'customer_tenant' || target.agencyId !== caller.localAgencyId)) throw new AuthorizationError('Sub-agencies may credit only their own customer wallets.');
    }
    const txId = id('wtx');
    const apply = this.db.transaction(() => {
      const current = this.db.get('SELECT * FROM wallet_transactions WHERE idempotency_key=?', [key]);
      if (current) {
        if (current.request_hash !== requestHash) throw new AppError('Idempotency key was already used for a different wallet operation.', 'IDEMPOTENCY_CONFLICT', 409);
        return current;
      }
      const recipient = this.ensureWallet(targetCompanyId);
      let senderBefore = null; let senderAfter = null;
      if (senderCompanyId && caller.role !== 'platform') {
        const sender = this.ensureWallet(senderCompanyId);
        if (sender.balance_minor < amountMinor) throw new AppError('Insufficient wallet balance.', 'INSUFFICIENT_WALLET_BALANCE', 409);
        senderBefore = sender.balance_minor; senderAfter = senderBefore - amountMinor;
        this.db.run('UPDATE wallets SET balance_minor=?, updated_at=CURRENT_TIMESTAMP WHERE company_id=? AND balance_minor=?', senderAfter, senderCompanyId, senderBefore);
      } else if (senderCompanyId) {
        const treasury = this.ensureWallet(senderCompanyId);
        senderBefore = treasury.balance_minor;
        senderAfter = treasury.balance_minor;
      }
      const recipientAfter = recipient.balance_minor + amountMinor;
      this.db.run('UPDATE wallets SET balance_minor=?, updated_at=CURRENT_TIMESTAMP WHERE company_id=? AND balance_minor=?', recipientAfter, targetCompanyId, recipient.balance_minor);
      this.db.run(`INSERT INTO wallet_transactions(id,idempotency_key,request_hash,sender_company_id,receiver_company_id,sender_account_type,receiver_account_type,amount_minor,transaction_type,sender_previous_minor,sender_updated_minor,receiver_previous_minor,receiver_updated_minor,description,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, txId,key,requestHash,senderCompanyId,targetCompanyId,senderType,target.type,amountMinor,'CREDIT',senderBefore,senderAfter,recipient.balance_minor,recipientAfter,description || null,caller.localUserId);
      this.audit(caller.localUserId, 'WALLET_CREDIT', 'wallet', targetCompanyId, { transactionId: txId, amountMinor, senderCompanyId, receiverCompanyId: targetCompanyId }, caller.localCompanyId);
      return this.db.get('SELECT * FROM wallet_transactions WHERE id=?', [txId]);
    });
    return apply();
  }

  plans() { return this.db.all('SELECT * FROM subscription_plans ORDER BY account_type, name'); }
  subscriptions() {
    return this.db.all(`SELECT s.*, c.name AS account_name FROM subscriptions s JOIN companies c ON c.id=s.company_id ORDER BY s.expires_at ASC`);
  }

  subscriptionDetails(userId, subscriptionId) {
    const caller = this.caller(userId);
    if (caller.role !== 'platform') throw new AuthorizationError('Mother Company access required.');
    const subscription = this.db.get(`
      SELECT s.*, c.name AS account_name, c.status AS account_status,
        p.name AS current_plan_name,
        (SELECT e.provider_payment_id FROM payment_webhook_events e
          WHERE e.subscription_id=s.id ORDER BY e.processed_at DESC LIMIT 1) AS provider_payment_id
      FROM subscriptions s
      JOIN companies c ON c.id=s.company_id
      LEFT JOIN subscription_plans p ON p.id=s.plan_id
      WHERE s.id=?`, [subscriptionId]);
    if (!subscription) throw new NotFoundError('Subscription', subscriptionId);
    return subscription;
  }

  manuallyExtendSubscription(userId, subscriptionId, body = {}) {
    const caller = this.caller(userId);
    if (caller.role !== 'platform') throw new AuthorizationError('Mother Company access required.');
    const amount = Number(body.amount ?? body.durationValue);
    const unit = String(body.unit || body.durationUnit || 'day').toLowerCase();
    if (!Number.isInteger(amount) || amount < 1 || !['day', 'month'].includes(unit)) {
      throw new ValidationError('Enter a positive whole number of days or months.');
    }
    const current = this.db.get('SELECT * FROM subscriptions WHERE id=?', [subscriptionId]);
    if (!current) throw new NotFoundError('Subscription', subscriptionId);
    const previousEnd = current.end_date || current.expires_at;
    const newEnd = endOfUtcDay(addDuration(previousEnd, amount, unit)).toISOString();
    return this.db.transaction(() => {
      this.db.run('UPDATE subscriptions SET end_date=?, expires_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', newEnd, newEnd, subscriptionId);
      this.audit(caller.localUserId, 'SUBSCRIPTION_MANUAL_RENEW', 'subscription', subscriptionId, {
        performedBy: 'platform_admin', manualOverride: true, previousEndDate: previousEnd, endDate: newEnd, amount, unit,
      }, current.company_id);
      return this.db.get('SELECT * FROM subscriptions WHERE id=?', [subscriptionId]);
    })();
  }

  manuallyChangeSubscriptionStatus(userId, subscriptionId, status) {
    const caller = this.caller(userId);
    if (caller.role !== 'platform') throw new AuthorizationError('Mother Company access required.');
    const nextStatus = String(status || '').toUpperCase();
    if (!['PENDING', 'ACTIVE', 'SUSPENDED', 'CANCELLED', 'EXPIRED'].includes(nextStatus)) {
      throw new ValidationError('Invalid subscription status.');
    }
    const current = this.db.get('SELECT * FROM subscriptions WHERE id=?', [subscriptionId]);
    if (!current) throw new NotFoundError('Subscription', subscriptionId);
    return this.db.transaction(() => {
      this.db.run('UPDATE subscriptions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', nextStatus, subscriptionId);
      this.audit(caller.localUserId, 'MANUAL_OVERRIDE', 'subscription', subscriptionId, {
        performedBy: 'platform_admin', previousStatus: current.status, status: nextStatus,
        manualOverride: true,
      }, current.company_id);
      return this.db.get('SELECT * FROM subscriptions WHERE id=?', [subscriptionId]);
    })();
  }

  deleteSubscription(userId, subscriptionId) {
    const caller = this.caller(userId);
    if (caller.role !== 'platform') throw new AuthorizationError('Mother Company access required.');
    const current = this.db.get('SELECT * FROM subscriptions WHERE id=?', [subscriptionId]);
    if (!current) throw new NotFoundError('Subscription', subscriptionId);
    return this.db.transaction(() => {
      const payment = this.db.get('SELECT provider_payment_id FROM payment_webhook_events WHERE subscription_id=? LIMIT 1', [subscriptionId]);
      const walletTransaction = this.db.get('SELECT id FROM wallet_transactions WHERE subscription_id=? LIMIT 1', [subscriptionId]);
      if (payment || walletTransaction) {
        throw new AppError('This subscription has payment history and cannot be deleted without removing financial records.', 'SUBSCRIPTION_HAS_PAYMENT_HISTORY', 409);
      }
      this.audit(caller.localUserId, 'SUBSCRIPTION_MANUAL_DELETE', 'subscription', subscriptionId, {
        performedBy: 'platform_admin', manualOverride: true, companyId: current.company_id, status: current.status,
      }, current.company_id);
      this.db.run('DELETE FROM subscriptions WHERE id=?', [subscriptionId]);
      return { id: subscriptionId, deleted: true };
    })();
  }

  ownSubscription(userId) {
    const caller = this.caller(userId);
    const subscription = this.db.get('SELECT * FROM subscriptions WHERE company_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', [caller.localCompanyId]);
    if (!subscription) return { subscription: null, renewals: [] };
    const renewals = this.db.all('SELECT * FROM subscription_renewal_attempts WHERE subscription_id=? ORDER BY attempted_at DESC LIMIT 100', [subscription.id]);
    return { subscription, renewals };
  }

  ownPlans(userId) {
    const caller = this.caller(userId);
    if (caller.role === 'platform') return this.db.all('SELECT * FROM subscription_plans WHERE active=1 ORDER BY account_type,price_minor,name');
    const account = this.accountInfo(caller.localCompanyId);
    return this.db.all('SELECT * FROM subscription_plans WHERE active=1 AND account_type=? ORDER BY price_minor,name', [account.type]);
  }

  createOwnPendingSubscription(userId, planId) {
    const caller = this.caller(userId);
    const companyId = caller.localCompanyId;
    const account = this.accountInfo(companyId);
    const plan = this.db.get('SELECT * FROM subscription_plans WHERE id=? AND active=1', [planId]);
    if (!plan || plan.account_type !== account.type) throw new NotFoundError('Available subscription plan', planId);
    const existing = this.db.get("SELECT * FROM subscriptions WHERE company_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", [companyId]);
    if (existing && existing.status === 'PENDING') return existing;
    if (existing && existing.status === 'ACTIVE' && new Date(existing.end_date || existing.expires_at).getTime() >= Date.now()) {
      throw new ValidationError('An active subscription already exists for this account.');
    }
    const starts = new Date();
    const end = endOfUtcDay(addDuration(starts, plan.duration_value || plan.duration_days, plan.duration_unit || 'day')).toISOString();
    const subscriptionId = id('sub');
    return this.db.transaction(() => {
      this.db.run(`INSERT INTO subscriptions(id,company_id,account_type,plan_id,plan_name,amount_minor,duration_days,starts_at,expires_at,status,payment_status,auto_renew,assigned_by,duration_unit,duration_value,end_date)
        VALUES(?,?,?,?,?,?,?,?,?,'PENDING','PENDING',?,NULL,?,?,?)`, subscriptionId, companyId, account.type, plan.id, plan.name, plan.price_minor, plan.duration_days, starts.toISOString(), end, plan.auto_renew, plan.duration_unit || 'day', plan.duration_value || plan.duration_days, end);
      this.ensureWallet(companyId);
      this.audit(caller.localUserId, 'SUBSCRIPTION_PENDING', 'subscription', subscriptionId, { planId: plan.id, amountMinor: plan.price_minor, endDate: end }, companyId);
      return this.db.get('SELECT * FROM subscriptions WHERE id=?', [subscriptionId]);
    })();
  }

  createPlan(userId, body) {
    const caller = this.caller(userId);
    if (caller.role !== 'platform') throw new AuthorizationError('Mother Company access required.');
    const { name, accountType, durationDays, description } = body;
    const durationUnit = body.durationUnit || 'day';
    const durationValue = Number(body.durationValue || durationDays);
    if (!String(name || '').trim() || !['agency','sub_agency','customer_tenant'].includes(accountType) || !durationUnits.includes(durationUnit) || !Number.isInteger(durationValue) || durationValue < 1) throw new ValidationError('Plan name, account type and positive duration are required.');
    const planId = id('plan');
    this.db.run('INSERT INTO subscription_plans(id,name,account_type,price_minor,duration_days,active,auto_renew,description,created_by,duration_unit,duration_value) VALUES(?,?,?,?,?,?,?,?,?,?,?)', planId,String(name).trim(),accountType,moneyMinor(body.price),durationDaysFor(durationValue,durationUnit),body.active === false ? 0 : 1,body.autoRenew === false ? 0 : 1,description || null,caller.localUserId,durationUnit,durationValue);
    this.audit(caller.localUserId, 'SUBSCRIPTION_PLAN_CREATED', 'subscription_plan', planId, { name: String(name).trim(), accountType, durationValue, durationUnit });
    return this.db.get('SELECT * FROM subscription_plans WHERE id=?', [planId]);
  }

  assignSubscription(userId, companyId, body) {
    const caller = this.caller(userId);
    if (caller.role !== 'platform') throw new AuthorizationError('Mother Company access required.');
    const account = this.accountInfo(companyId);
    const current = this.db.get("SELECT id,end_date,expires_at,status FROM subscriptions WHERE company_id=? AND status='ACTIVE' ORDER BY created_at DESC,rowid DESC LIMIT 1", [companyId]);
    if (current && new Date(current.end_date || current.expires_at).getTime() >= Date.now()) {
      throw new ValidationError('An active subscription already exists for this account.');
    }
    const plan = body.planId ? this.db.get('SELECT * FROM subscription_plans WHERE id=? AND active=1', [body.planId]) : null;
    if (body.planId && !plan) throw new NotFoundError('Active subscription plan', body.planId);
    if (plan && plan.account_type !== account.type) throw new ValidationError('The selected plan is not available for this account type.');
    const durationUnit = body.durationUnit || (plan && plan.duration_unit) || 'day';
    const durationValue = Number(body.durationValue || (plan && plan.duration_value) || body.durationDays || (plan && plan.duration_days));
    if (!durationUnits.includes(durationUnit) || !Number.isInteger(durationValue) || durationValue < 1) throw new ValidationError('A positive subscription duration is required.');
    const durationDays = durationDaysFor(durationValue,durationUnit);
    const amountMinor = plan ? plan.price_minor : moneyMinor(body.price);
    const starts = body.startsAt ? new Date(body.startsAt) : new Date();
    const expires = endOfUtcDay(body.expiresAt ? new Date(body.expiresAt) : addDuration(starts,durationValue,durationUnit));
    if (!Number.isFinite(starts.getTime()) || !Number.isFinite(expires.getTime()) || expires <= starts) throw new ValidationError('Subscription expiry must be after its start date.');
    const subId = id('sub');
    return this.db.transaction(() => {
      this.db.run(`INSERT INTO subscriptions(id,company_id,account_type,plan_id,plan_name,amount_minor,duration_days,starts_at,expires_at,status,payment_status,auto_renew,assigned_by,duration_unit,duration_value,end_date)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,subId,companyId,account.type,plan && plan.id,plan ? plan.name : String(body.planName || 'Custom'),amountMinor,durationDays,starts.toISOString(),expires.toISOString(),'PENDING','PENDING',body.autoRenew == null ? (plan ? plan.auto_renew : 1) : (body.autoRenew ? 1 : 0),caller.localUserId,durationUnit,durationValue,expires.toISOString());
      this.ensureWallet(companyId);
      this.audit(caller.localUserId, 'SUBSCRIPTION_PENDING', 'subscription', subId, { companyId, planId: plan && plan.id, endDate: expires.toISOString(), amountMinor });
      return this.db.get('SELECT * FROM subscriptions WHERE id=?', [subId]);
    })();
  }

  updateSubscription(userId, subscriptionId, body) {
    const caller = this.caller(userId);
    if (caller.role !== 'platform') throw new AuthorizationError('Mother Company access required.');
    const sub = this.db.get('SELECT * FROM subscriptions WHERE id=?', [subscriptionId]);
    if (!sub) throw new NotFoundError('Subscription', subscriptionId);
    const status = body.status || sub.status;
    if (!['PENDING','ACTIVE','SUSPENDED','CANCELLED','EXPIRED'].includes(status)) throw new ValidationError('Invalid subscription status.');
    if (status === 'ACTIVE' && sub.status !== 'ACTIVE') throw new AuthorizationError('A subscription can only be activated after a verified payment.');
    if (body.expiresAt) {
      const requestedEnd = new Date(body.expiresAt);
      if (!Number.isFinite(requestedEnd.getTime())) throw new ValidationError('Invalid expiry date.');
      if (requestedEnd.toISOString() !== new Date(sub.end_date || sub.expires_at).toISOString()) {
        throw new AuthorizationError('Subscription end dates can only change after a verified payment.');
      }
    }
    this.db.run('UPDATE subscriptions SET status=?, auto_renew=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',status,body.autoRenew == null ? sub.auto_renew : (body.autoRenew ? 1 : 0),subscriptionId);
    this.audit(caller.localUserId, 'SUBSCRIPTION_UPDATED', 'subscription', subscriptionId, { oldStatus: sub.status, status, endDate: sub.end_date || sub.expires_at }, sub.company_id);
    return this.db.get('SELECT * FROM subscriptions WHERE id=?', [subscriptionId]);
  }

  updatePlan(userId, planId, body) {
    const caller = this.caller(userId);
    if (caller.role !== 'platform') throw new AuthorizationError('Mother Company access required.');
    const plan = this.db.get('SELECT * FROM subscription_plans WHERE id=?', [planId]);
    if (!plan) throw new NotFoundError('Subscription plan', planId);
    const name = body.name == null ? plan.name : String(body.name).trim();
    const accountType = body.accountType || plan.account_type;
    const durationUnit = body.durationUnit || plan.duration_unit || 'day';
    const durationValue = body.durationValue == null ? (plan.duration_value || plan.duration_days) : Number(body.durationValue);
    const price = body.price == null ? plan.price_minor : moneyMinor(body.price);
    if (!name || !['agency','sub_agency','customer_tenant'].includes(accountType) || !durationUnits.includes(durationUnit) || !Number.isInteger(durationValue) || durationValue < 1) throw new ValidationError('Plan name, account type and positive duration are required.');
    const duration = durationDaysFor(durationValue,durationUnit);
    this.db.run('UPDATE subscription_plans SET name=?,account_type=?,price_minor=?,duration_days=?,active=?,auto_renew=?,description=?,duration_unit=?,duration_value=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',name,accountType,price,duration,body.active == null?plan.active:(body.active?1:0),body.autoRenew == null?plan.auto_renew:(body.autoRenew?1:0),body.description == null?plan.description:body.description,durationUnit,durationValue,planId);
    this.audit(caller.localUserId, 'SUBSCRIPTION_PLAN_UPDATED', 'subscription_plan', planId, { name, accountType, durationValue, durationUnit, priceMinor: price, active: body.active == null ? plan.active : !!body.active });
    return this.db.get('SELECT * FROM subscription_plans WHERE id=?', [planId]);
  }

  payOwnSubscription(userId) {
    const caller = this.caller(userId);
    const companyId = caller.localCompanyId;
    const sub = this.db.get("SELECT * FROM subscriptions WHERE company_id=? ORDER BY created_at DESC LIMIT 1", [companyId]);
    if (!sub) throw new NotFoundError('Pending subscription', companyId);
    const end = new Date(sub.end_date || sub.expires_at);
    if (sub.status === 'ACTIVE' && end.getTime() >= Date.now()) throw new ValidationError('The subscription is not due for payment yet.');
    const key = `wallet-subscription:${sub.id}:${sub.end_date || sub.expires_at}`;
    return this.db.transaction(() => {
      const previous = this.db.get('SELECT * FROM wallet_transactions WHERE idempotency_key=?', [key]);
      if (previous) return previous;
      const wallet = this.ensureWallet(companyId);
      if (wallet.balance_minor < sub.amount_minor) throw new AppError('Insufficient wallet balance.', 'INSUFFICIENT_WALLET_BALANCE', 409);
      const after = wallet.balance_minor - sub.amount_minor;
      this.db.run('UPDATE wallets SET balance_minor=?,updated_at=CURRENT_TIMESTAMP WHERE company_id=? AND balance_minor=?', after, companyId, wallet.balance_minor);
      const now = new Date();
      const base = end.getTime() >= now.getTime() ? end : now;
      const nextExpiry = endOfUtcDay(addDuration(base, sub.duration_value || sub.duration_days, sub.duration_unit || 'day')).toISOString();
      this.db.run("UPDATE subscriptions SET starts_at=CASE WHEN status='PENDING' THEN ? ELSE starts_at END, expires_at=?, end_date=?, payment_status='PAID', status='ACTIVE', updated_at=CURRENT_TIMESTAMP WHERE id=?", now.toISOString(), nextExpiry, nextExpiry, sub.id);
      const txId = id('wtx');
      this.db.run(`INSERT INTO wallet_transactions(id,idempotency_key,request_hash,sender_company_id,receiver_company_id,sender_account_type,receiver_account_type,amount_minor,transaction_type,sender_previous_minor,sender_updated_minor,receiver_previous_minor,receiver_updated_minor,description,subscription_id,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, txId, key, hash({ subscriptionId: sub.id, amountMinor: sub.amount_minor }), companyId, companyId, sub.account_type, sub.account_type, sub.amount_minor, 'SUBSCRIPTION_DEDUCTION', wallet.balance_minor, after, wallet.balance_minor, after, 'Subscription payment from wallet', sub.id, caller.localUserId);
      this.audit(caller.localUserId, sub.status === 'PENDING' ? 'SUBSCRIPTION_START' : 'SUBSCRIPTION_RENEW', 'subscription', sub.id, { transactionId: txId, amountMinor: sub.amount_minor, endDate: nextExpiry }, companyId);
      return this.db.get('SELECT * FROM wallet_transactions WHERE id=?', [txId]);
    })();
  }

  processProviderPayment(event) {
    const providerPaymentId = String(event.providerPaymentId || event.paymentId || '').trim();
    const companyId = String(event.companyId || '').trim();
    const subscriptionId = String(event.subscriptionId || '').trim();
    const paymentStatus = String(event.status || '').toLowerCase();
    if (!providerPaymentId || providerPaymentId.length > 200 || !companyId || !subscriptionId || !['paid','succeeded','success'].includes(paymentStatus)) {
      throw new ValidationError('A successful payment ID, company ID, and subscription ID are required.');
    }
    const amountMinor = event.amountMinor == null ? moneyMinor(event.amount) : Number(event.amountMinor);
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new ValidationError('A valid payment amount is required.');
    const currency = String(event.currency || 'INR').toUpperCase();
    if (currency !== 'INR') throw new ValidationError('Unsupported payment currency.');

    return this.db.transaction(() => {
      const duplicate = this.db.get('SELECT * FROM payment_webhook_events WHERE provider_payment_id=?', [providerPaymentId]);
      if (duplicate) return { duplicate: true, providerPaymentId, companyId: duplicate.company_id, subscriptionId: duplicate.subscription_id };
      const sub = this.db.get('SELECT * FROM subscriptions WHERE id=? AND company_id=?', [subscriptionId, companyId]);
      if (!sub) throw new NotFoundError('Matching subscription', subscriptionId);
      if (sub.amount_minor !== amountMinor) throw new ValidationError('Payment amount does not match the subscription amount.');
      if (sub.status === 'CANCELLED') throw new ValidationError('Cancelled subscriptions cannot be activated by payment.');

      const now = new Date();
      const priorEnd = new Date(sub.end_date || sub.expires_at);
      const base = sub.status === 'ACTIVE' && priorEnd.getTime() > now.getTime() ? priorEnd : now;
      const nextEnd = endOfUtcDay(addDuration(base, sub.duration_value || sub.duration_days, sub.duration_unit || 'day')).toISOString();
      const wallet = this.ensureWallet(companyId);
      const walletAfter = wallet.balance_minor + amountMinor;
      this.db.run('UPDATE wallets SET balance_minor=?,updated_at=CURRENT_TIMESTAMP WHERE company_id=? AND balance_minor=?', walletAfter, companyId, wallet.balance_minor);

      const transactionId = id('wtx');
      const idempotencyKey = `provider-payment:${providerPaymentId}`;
      this.db.run(`INSERT INTO wallet_transactions(id,idempotency_key,request_hash,sender_company_id,receiver_company_id,sender_account_type,receiver_account_type,amount_minor,transaction_type,sender_previous_minor,sender_updated_minor,receiver_previous_minor,receiver_updated_minor,description,subscription_id,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, transactionId, idempotencyKey, hash({ providerPaymentId, companyId, subscriptionId, amountMinor }), null, companyId, 'payment_provider', sub.account_type, amountMinor, 'CREDIT', null, null, wallet.balance_minor, walletAfter, `Verified payment ${providerPaymentId}`, sub.id, null);

      this.db.run("UPDATE subscriptions SET starts_at=CASE WHEN status='PENDING' THEN ? ELSE starts_at END, expires_at=?, end_date=?, payment_status='PAID', status='ACTIVE', updated_at=CURRENT_TIMESTAMP WHERE id=?", now.toISOString(), nextEnd, nextEnd, sub.id);
      this.db.run('INSERT INTO payment_webhook_events(id,provider_payment_id,company_id,subscription_id,amount_minor,currency,subscription_end_date) VALUES(?,?,?,?,?,?,?)', id('payment'), providerPaymentId, companyId, sub.id, amountMinor, currency, nextEnd);
      const action = sub.status === 'PENDING' ? 'SUBSCRIPTION_START' : 'SUBSCRIPTION_RENEW';
      this.audit(null, action, 'subscription', sub.id, { providerPaymentId, transactionId, amountMinor, endDate: nextEnd }, companyId);
      return { duplicate: false, providerPaymentId, transactionId, subscriptionId: sub.id, status: 'ACTIVE', endDate: nextEnd, walletBalanceMinor: walletAfter };
    })();
  }

  processProviderRefund(event) {
    const providerPaymentId = String(event.providerPaymentId || event.paymentId || '').trim();
    if (!providerPaymentId) throw new ValidationError('A provider payment ID is required for a refund.');
    return this.db.transaction(() => {
      const payment = this.db.get('SELECT * FROM payment_webhook_events WHERE provider_payment_id=?', [providerPaymentId]);
      if (!payment) throw new NotFoundError('Verified provider payment', providerPaymentId);
      if (payment.refund_processed_at) return { duplicate: true, providerPaymentId, status: 'REFUNDED' };
      const wallet = this.ensureWallet(payment.company_id);
      if (wallet.balance_minor < payment.amount_minor) throw new AppError('Wallet balance is insufficient to apply the refund.', 'REFUND_BALANCE_INSUFFICIENT', 409);
      const after = wallet.balance_minor - payment.amount_minor;
      this.db.run('UPDATE wallets SET balance_minor=?,updated_at=CURRENT_TIMESTAMP WHERE company_id=? AND balance_minor=?', after, payment.company_id, wallet.balance_minor);
      const refundKey = `provider-refund:${providerPaymentId}`;
      const refundId = id('wtx');
      this.db.run(`INSERT INTO wallet_transactions(id,idempotency_key,request_hash,sender_company_id,receiver_company_id,sender_account_type,receiver_account_type,amount_minor,transaction_type,sender_previous_minor,sender_updated_minor,receiver_previous_minor,receiver_updated_minor,description,subscription_id,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, refundId, refundKey, hash({ providerPaymentId, refund: true }), payment.company_id, payment.company_id, 'payment_provider', 'payment_provider', payment.amount_minor, 'REFUND', wallet.balance_minor, after, wallet.balance_minor, after, `Refund for payment ${providerPaymentId}`, payment.subscription_id, null);
      this.db.run('UPDATE payment_webhook_events SET refund_processed_at=CURRENT_TIMESTAMP WHERE provider_payment_id=?', providerPaymentId);
      this.db.run("UPDATE subscriptions SET status='CANCELLED',payment_status='PENDING',updated_at=CURRENT_TIMESTAMP WHERE id=? AND end_date=?", payment.subscription_id, payment.subscription_end_date);
      this.audit(null, 'SUBSCRIPTION_REFUND', 'subscription', payment.subscription_id, { providerPaymentId, transactionId: refundId, amountMinor: payment.amount_minor }, payment.company_id);
      return { duplicate: false, providerPaymentId, status: 'REFUNDED', walletBalanceMinor: after };
    })();
  }

  renewOne(sub, source = 'automatic') {
    const period = String(sub.expires_at);
    const key = `subrenew:${sub.id}:${period}`;
    const apply = this.db.transaction(() => {
      const attempt = this.db.get('SELECT * FROM subscription_renewal_attempts WHERE idempotency_key=?', [key]);
      if (attempt && attempt.status === 'PAID') return attempt;
      const wallet = this.ensureWallet(sub.company_id);
      const enough = wallet.balance_minor >= sub.amount_minor;
      if (enough) {
        const after = wallet.balance_minor - sub.amount_minor;
        this.db.run('UPDATE wallets SET balance_minor=?,updated_at=CURRENT_TIMESTAMP WHERE company_id=? AND balance_minor=?',after,sub.company_id,wallet.balance_minor);
        const nextExpiry = addDuration(new Date(Math.max(Date.now(), new Date(sub.expires_at).getTime())), sub.duration_value || sub.duration_days, sub.duration_unit || 'day').toISOString();
        this.db.run("UPDATE subscriptions SET expires_at=?,end_date=?,payment_status='PAID',status='ACTIVE',updated_at=CURRENT_TIMESTAMP WHERE id=?",nextExpiry,nextExpiry,sub.id);
        const txId=id('wtx');
        this.db.run(`INSERT INTO wallet_transactions(id,idempotency_key,request_hash,sender_company_id,receiver_company_id,sender_account_type,receiver_account_type,amount_minor,transaction_type,sender_previous_minor,sender_updated_minor,receiver_previous_minor,receiver_updated_minor,description,status,subscription_id,created_by)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,txId,key,hash({subscriptionId:sub.id,period,source}),sub.company_id,sub.company_id,sub.account_type,sub.account_type,sub.amount_minor,'SUBSCRIPTION_DEDUCTION',wallet.balance_minor,after,wallet.balance_minor,after,`Subscription renewal (${source})`,'COMPLETED',sub.id,null);
        this.audit(null, 'SUBSCRIPTION_RENEW', 'subscription', sub.id, { transactionId: txId, amountMinor: sub.amount_minor, endDate: nextExpiry }, sub.company_id);
      } else {
        this.db.run("UPDATE subscriptions SET payment_status='PENDING',updated_at=CURRENT_TIMESTAMP WHERE id=?",sub.id);
        this.audit(null, 'SUBSCRIPTION_RENEWAL_PENDING', 'subscription', sub.id, { amountMinor: sub.amount_minor, expiresAt: sub.expires_at }, sub.company_id);
      }
      if (attempt) {
        this.db.run('UPDATE subscription_renewal_attempts SET status=?,message=?,attempted_at=CURRENT_TIMESTAMP WHERE idempotency_key=?',enough?'PAID':'PENDING',enough?null:'Insufficient wallet balance.',key);
      } else {
        this.db.run('INSERT INTO subscription_renewal_attempts(id,idempotency_key,subscription_id,company_id,amount_minor,status,message) VALUES(?,?,?,?,?,?,?)',id('renewal'),key,sub.id,sub.company_id,sub.amount_minor,enough?'PAID':'PENDING',enough?null:'Insufficient wallet balance.');
        if (!enough) this.notifyPending(sub);
      }
      return this.db.get('SELECT * FROM subscription_renewal_attempts WHERE idempotency_key=?', [key]);
    });
    return apply();
  }

  notifyPending(sub) {
    try {
      const users = this.db.all(`SELECT id,company_id FROM users WHERE company_id=? AND lower(status)='active'
        UNION SELECT u.id,u.company_id FROM users u WHERE lower(u.status)='active'
          AND (u.hierarchy_role='platform' OR EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_id='role_mother_company'))`, [sub.company_id]);
      for (const user of users) this.db.run(`INSERT INTO notifications(id,company_id,user_id,type,title,message,entity_type,entity_id) VALUES(?,?,?,?,?,?,?,?)`,id('notification'),user.company_id,user.id,'SUBSCRIPTION_PAYMENT_PENDING','Subscription payment pending','Wallet balance is insufficient for the subscription renewal.','subscription',sub.id);
    } catch (err) { console.warn('[subscriptions] Unable to create renewal notification:', err.message); }
  }

  async renewDue() {
    const due = this.db.all("SELECT * FROM subscriptions WHERE status='ACTIVE' AND auto_renew=1 AND datetime(COALESCE(end_date,expires_at))<datetime('now')");
    for (const sub of due) {
      try { this.renewOne(sub, 'automatic'); }
      catch (err) { console.error(`[subscriptions] Renewal failed for ${sub.id}:`, err.message); }
    }
    return due.length;
  }

  expireDue() {
    return this.db.transaction(() => {
      const expired = this.db.all("SELECT id,company_id,end_date,expires_at FROM subscriptions WHERE status='ACTIVE' AND datetime(COALESCE(end_date,expires_at))<datetime('now')");
      for (const sub of expired) {
        this.db.run("UPDATE subscriptions SET status='EXPIRED',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='ACTIVE'", sub.id);
        this.audit(null, 'SUBSCRIPTION_EXPIRE', 'subscription', sub.id, { endDate: sub.end_date || sub.expires_at }, sub.company_id);
      }
      return expired.length;
    })();
  }
}

module.exports = { WalletSubscriptionService };
