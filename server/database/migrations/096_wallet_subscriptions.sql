-- Hierarchical wallets and centrally administered subscriptions.
-- Money is stored in integer minor units (paise); transaction rows are immutable.
CREATE TABLE IF NOT EXISTS wallets (
  company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE RESTRICT,
  balance_minor INTEGER NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('agency','sub_agency','customer_tenant')),
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  auto_renew INTEGER NOT NULL DEFAULT 1 CHECK (auto_renew IN (0,1)),
  description TEXT,
  created_by TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  account_type TEXT NOT NULL CHECK (account_type IN ('agency','sub_agency','customer_tenant')),
  plan_id TEXT REFERENCES subscription_plans(id) ON DELETE SET NULL,
  plan_name TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  starts_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CANCELLED','EXPIRED')),
  payment_status TEXT NOT NULL DEFAULT 'PAID' CHECK (payment_status IN ('PAID','PENDING')),
  auto_renew INTEGER NOT NULL DEFAULT 1 CHECK (auto_renew IN (0,1)),
  assigned_by TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_company ON subscriptions(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_due ON subscriptions(status, auto_renew, expires_at);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  sender_company_id TEXT,
  receiver_company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  sender_account_type TEXT NOT NULL,
  receiver_account_type TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('CREDIT','SUBSCRIPTION_DEDUCTION','REFUND')),
  sender_previous_minor INTEGER,
  sender_updated_minor INTEGER,
  receiver_previous_minor INTEGER NOT NULL,
  receiver_updated_minor INTEGER NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','PENDING','FAILED')),
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  created_by TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_receiver ON wallet_transactions(receiver_company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_sender ON wallet_transactions(sender_company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS subscription_renewal_attempts (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PAID','PENDING')),
  message TEXT,
  attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_renewal_attempts_company ON subscription_renewal_attempts(company_id, attempted_at DESC);

CREATE TRIGGER IF NOT EXISTS wallet_transactions_no_update
BEFORE UPDATE ON wallet_transactions BEGIN SELECT RAISE(ABORT, 'wallet transaction ledger is immutable'); END;
CREATE TRIGGER IF NOT EXISTS wallet_transactions_no_delete
BEFORE DELETE ON wallet_transactions BEGIN SELECT RAISE(ABORT, 'wallet transaction ledger is immutable'); END;

-- Create a zero-balance wallet for tenants already present at upgrade time.
INSERT OR IGNORE INTO wallets(company_id)
SELECT id FROM companies;

-- Explicit control-plane grants. Wildcard tenant admin grants do not satisfy these.
INSERT OR IGNORE INTO permissions(id, company_id, code, module, name, description) VALUES
 ('perm_mc_wallets_view','default','mother_company.wallets.view','mother_company','View all wallets','View all wallet balances and transaction history'),
 ('perm_mc_wallets_credit','default','mother_company.wallets.credit','mother_company','Credit wallets','Credit any account wallet'),
 ('perm_mc_subscriptions_manage','default','mother_company.subscriptions.manage','mother_company','Manage subscriptions','Manage plans, assignments, subscription state and renewals');
INSERT OR IGNORE INTO role_permissions(role_id, permission_id)
SELECT 'role_mother_company', id FROM permissions WHERE code IN ('mother_company.wallets.view','mother_company.wallets.credit','mother_company.subscriptions.manage');
INSERT OR IGNORE INTO user_roles(user_id, role_id)
SELECT id, 'role_mother_company' FROM users WHERE lower(email)='admin@blackstack.local' AND upper(role) IN ('ADMIN','PLATFORM');
