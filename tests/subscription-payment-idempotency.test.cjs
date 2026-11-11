const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { WalletSubscriptionService } = require('../server/services/walletSubscription.service');

test('duplicate provider webhook credits wallet and activates subscription exactly once', () => {
  const native = new DatabaseSync(':memory:');
  const db = {
    exec: (sql) => native.exec(sql),
    run: (sql, ...args) => native.prepare(sql).run(...(args.length === 1 && Array.isArray(args[0]) ? args[0] : args)),
    get: (sql, ...args) => native.prepare(sql).get(...(args.length === 1 && Array.isArray(args[0]) ? args[0] : args)),
    all: (sql, ...args) => native.prepare(sql).all(...(args.length === 1 && Array.isArray(args[0]) ? args[0] : args)),
    transaction(fn) {
      return (...args) => {
        native.exec('BEGIN IMMEDIATE');
        try { const value = fn(...args); native.exec('COMMIT'); return value; }
        catch (error) { native.exec('ROLLBACK'); throw error; }
      };
    },
  };
  db.exec(`
    CREATE TABLE companies(id TEXT PRIMARY KEY);
    CREATE TABLE wallets(company_id TEXT PRIMARY KEY,balance_minor INTEGER NOT NULL DEFAULT 0,updated_at TEXT);
    CREATE TABLE subscriptions(id TEXT PRIMARY KEY,company_id TEXT,account_type TEXT,amount_minor INTEGER,duration_days INTEGER,duration_unit TEXT,duration_value INTEGER,status TEXT,payment_status TEXT,starts_at TEXT,expires_at TEXT,end_date TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT);
    CREATE TABLE wallet_transactions(id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE,request_hash TEXT,sender_company_id TEXT,receiver_company_id TEXT,sender_account_type TEXT,receiver_account_type TEXT,amount_minor INTEGER,transaction_type TEXT,sender_previous_minor INTEGER,sender_updated_minor INTEGER,receiver_previous_minor INTEGER,receiver_updated_minor INTEGER,description TEXT,subscription_id TEXT,created_by TEXT);
    CREATE TABLE payment_webhook_events(id TEXT PRIMARY KEY,provider_payment_id TEXT UNIQUE,company_id TEXT,subscription_id TEXT,amount_minor INTEGER,currency TEXT,subscription_end_date TEXT,processed_at TEXT DEFAULT CURRENT_TIMESTAMP,refund_processed_at TEXT);
    CREATE TABLE audit_logs(id TEXT PRIMARY KEY,company_id TEXT,user_id TEXT,action TEXT,entity_type TEXT,entity_id TEXT,new_values_json TEXT);
    INSERT INTO companies VALUES('company-a');
    INSERT INTO wallets(company_id,balance_minor) VALUES('company-a',0);
    INSERT INTO subscriptions(id,company_id,account_type,amount_minor,duration_days,duration_unit,duration_value,status,payment_status,starts_at,expires_at,end_date)
      VALUES('sub-a','company-a','customer_tenant',2500,30,'day',30,'PENDING','PENDING','2026-11-11T00:00:00.000Z','2026-12-11T23:59:59.999Z','2026-12-11T23:59:59.999Z');
  `);
  try {
    const service = new WalletSubscriptionService(db);
    const event = { providerPaymentId: 'pay-unique-1', companyId: 'company-a', subscriptionId: 'sub-a', amountMinor: 2500, currency: 'INR', status: 'succeeded' };
    const first = service.processProviderPayment(event);
    const second = service.processProviderPayment(event);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(db.get('SELECT balance_minor FROM wallets WHERE company_id=?', 'company-a').balance_minor, 2500);
    assert.equal(db.get('SELECT status FROM subscriptions WHERE id=?', 'sub-a').status, 'ACTIVE');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM audit_logs').n, 1);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM payment_webhook_events').n, 1);

    // A blocked tenant can recover by paying from its wallet; debit, activation
    // and lifecycle logging are committed together.
    db.exec(`
      INSERT INTO companies VALUES('company-b');
      INSERT INTO wallets(company_id,balance_minor) VALUES('company-b',5000);
      INSERT INTO subscriptions(id,company_id,account_type,amount_minor,duration_days,duration_unit,duration_value,status,payment_status,starts_at,expires_at,end_date)
        VALUES('sub-b','company-b','customer_tenant',2500,30,'day',30,'PENDING','PENDING','2026-11-11T00:00:00.000Z','2026-12-11T23:59:59.999Z','2026-12-11T23:59:59.999Z');
    `);
    service.caller = () => ({ localCompanyId: 'company-b', localUserId: 'user-b', role: 'customer_tenant' });
    service.payOwnSubscription('user-b');
    assert.equal(db.get('SELECT balance_minor FROM wallets WHERE company_id=?', 'company-b').balance_minor, 2500);
    assert.equal(db.get('SELECT status FROM subscriptions WHERE id=?', 'sub-b').status, 'ACTIVE');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM audit_logs').n, 2);

    db.exec(`
      INSERT INTO companies VALUES('company-c');
      INSERT INTO wallets(company_id,balance_minor) VALUES('company-c',0);
      INSERT INTO subscriptions(id,company_id,account_type,amount_minor,duration_days,duration_unit,duration_value,status,payment_status,starts_at,expires_at,end_date)
        VALUES('sub-c','company-c','customer_tenant',2500,30,'day',30,'PENDING','PENDING','2026-11-11T00:00:00.000Z','2026-12-11T23:59:59.999Z','2026-12-11T23:59:59.999Z');
      CREATE TRIGGER reject_subscription_audit BEFORE INSERT ON audit_logs
        WHEN NEW.entity_id='sub-c' BEGIN SELECT RAISE(ABORT,'audit storage failure'); END;
    `);
    assert.throws(() => service.processProviderPayment({ ...event, providerPaymentId: 'pay-rollback', companyId: 'company-c', subscriptionId: 'sub-c' }));
    assert.equal(db.get('SELECT balance_minor FROM wallets WHERE company_id=?', 'company-c').balance_minor, 0);
    assert.equal(db.get('SELECT status FROM subscriptions WHERE id=?', 'sub-c').status, 'PENDING');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM payment_webhook_events WHERE provider_payment_id=?', 'pay-rollback').n, 0);
  } finally { native.close(); }
});
