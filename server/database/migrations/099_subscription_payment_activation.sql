-- Pending activation and provider callback idempotency.
-- Preserve the existing SQLite relationships while widening the subscription
-- status constraint to include PENDING.
CREATE TABLE subscriptions_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  account_type TEXT NOT NULL CHECK (account_type IN ('agency','sub_agency','customer_tenant')),
  plan_id TEXT REFERENCES subscription_plans(id) ON DELETE SET NULL,
  plan_name TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  starts_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','CANCELLED','EXPIRED')),
  payment_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN ('PAID','PENDING')),
  auto_renew INTEGER NOT NULL DEFAULT 1 CHECK (auto_renew IN (0,1)),
  assigned_by TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  duration_unit TEXT NOT NULL DEFAULT 'day' CHECK (duration_unit IN ('day','month','year')),
  duration_value INTEGER NOT NULL DEFAULT 1 CHECK (duration_value > 0),
  end_date DATETIME
);

INSERT INTO subscriptions_new (
  id,company_id,account_type,plan_id,plan_name,amount_minor,duration_days,
  starts_at,expires_at,status,payment_status,auto_renew,assigned_by,created_at,
  updated_at,duration_unit,duration_value,end_date
)
SELECT id,company_id,account_type,plan_id,plan_name,amount_minor,duration_days,
  starts_at,expires_at,status,payment_status,auto_renew,assigned_by,created_at,
  updated_at,duration_unit,duration_value,
  substr(expires_at,1,10) || 'T23:59:59.999Z'
FROM subscriptions;

DROP TABLE subscriptions;
ALTER TABLE subscriptions_new RENAME TO subscriptions;
CREATE INDEX IF NOT EXISTS idx_subscriptions_company ON subscriptions(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_due ON subscriptions(status, auto_renew, end_date);

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id TEXT PRIMARY KEY,
  provider_payment_id TEXT NOT NULL UNIQUE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  subscription_end_date DATETIME NOT NULL,
  processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  refund_processed_at DATETIME
);
