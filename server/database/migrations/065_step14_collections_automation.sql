-- Step 14: Receivables Follow-up & Collections Automation
-- Collections automation tables — operational metadata only, no accounting balances

-- Collection rules: configurable dunning triggers
CREATE TABLE IF NOT EXISTS collection_rules (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_active INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,
  trigger_type TEXT NOT NULL,
  aging_days_from INTEGER NOT NULL DEFAULT 0,
  aging_days_to INTEGER NOT NULL DEFAULT 0,
  customer_segment TEXT,
  minimum_outstanding REAL DEFAULT 0,
  action_type TEXT NOT NULL,
  action_config TEXT,
  escalation_level INTEGER DEFAULT 1,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collection_rules_company ON collection_rules(company_id);
CREATE INDEX IF NOT EXISTS idx_collection_rules_active ON collection_rules(company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_collection_rules_trigger ON collection_rules(company_id, trigger_type);

-- Collection actions: every automated/manual collection action
CREATE TABLE IF NOT EXISTS collection_actions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  bill_id TEXT,
  receivable_id TEXT,
  action_type TEXT NOT NULL,
  channel TEXT,
  status TEXT NOT NULL DEFAULT 'SCHEDULED',
  scheduled_at TEXT,
  executed_at TEXT,
  response_status TEXT,
  message_template_id TEXT,
  metadata TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collection_actions_company ON collection_actions(company_id);
CREATE INDEX IF NOT EXISTS idx_collection_actions_customer ON collection_actions(company_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_collection_actions_bill ON collection_actions(company_id, bill_id);
CREATE INDEX IF NOT EXISTS idx_collection_actions_status ON collection_actions(company_id, status);
CREATE INDEX IF NOT EXISTS idx_collection_actions_scheduled ON collection_actions(company_id, scheduled_at);

-- Collection action logs: immutable execution history
CREATE TABLE IF NOT EXISTS collection_action_logs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  old_status TEXT,
  new_status TEXT,
  response TEXT,
  error_message TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_collection_action_logs_action ON collection_action_logs(company_id, action_id);
CREATE INDEX IF NOT EXISTS idx_collection_action_logs_event ON collection_action_logs(company_id, event_type);

-- Communication templates
CREATE TABLE IF NOT EXISTS communication_templates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  channel TEXT NOT NULL,
  subject TEXT,
  body TEXT,
  variables TEXT,
  is_active INTEGER DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comm_templates_company ON communication_templates(company_id);
CREATE INDEX IF NOT EXISTS idx_comm_templates_channel ON communication_templates(company_id, channel);

-- Interest rules: configurable late-fee calculation
CREATE TABLE IF NOT EXISTS interest_rules (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  rule_type TEXT NOT NULL,
  rate_type TEXT NOT NULL,
  rate REAL NOT NULL,
  aging_days_from INTEGER DEFAULT 0,
  aging_days_to INTEGER DEFAULT 0,
  grace_period_days INTEGER DEFAULT 0,
  max_rate REAL,
  min_interest REAL,
  compounding INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_interest_rules_company ON interest_rules(company_id);
CREATE INDEX IF NOT EXISTS idx_interest_rules_active ON interest_rules(company_id, is_active);

-- Interest charges: calculated and posted late fees
CREATE TABLE IF NOT EXISTS interest_charges (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  bill_id TEXT NOT NULL,
  calculation_date TEXT NOT NULL,
  principal_amount REAL NOT NULL,
  overdue_days INTEGER NOT NULL,
  rate REAL NOT NULL,
  rate_type TEXT NOT NULL,
  calculated_amount REAL NOT NULL,
  approved_amount REAL,
  status TEXT NOT NULL DEFAULT 'CALCULATED',
  journal_entry_id TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_interest_charges_company ON interest_charges(company_id);
CREATE INDEX IF NOT EXISTS idx_interest_charges_customer ON interest_charges(company_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_interest_charges_bill ON interest_charges(company_id, bill_id);
CREATE INDEX IF NOT EXISTS idx_interest_charges_status ON interest_charges(company_id, status);

-- Bad debt cases: write-off workflow
CREATE TABLE IF NOT EXISTS bad_debt_cases (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  bill_id TEXT NOT NULL,
  outstanding_amount REAL NOT NULL,
  reason TEXT NOT NULL,
  aging_days INTEGER,
  provision_percentage REAL,
  provision_amount REAL,
  status TEXT NOT NULL DEFAULT 'PROPOSED',
  requested_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bad_debt_company ON bad_debt_cases(company_id);
CREATE INDEX IF NOT EXISTS idx_bad_debt_customer ON bad_debt_cases(company_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_bad_debt_bill ON bad_debt_cases(company_id, bill_id);
CREATE INDEX IF NOT EXISTS idx_bad_debt_status ON bad_debt_cases(company_id, status);

-- Payment plans
CREATE TABLE IF NOT EXISTS payment_plans (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  bill_id TEXT NOT NULL,
  plan_number TEXT NOT NULL,
  total_amount REAL NOT NULL,
  down_payment REAL DEFAULT 0,
  financed_amount REAL NOT NULL,
  instalment_count INTEGER NOT NULL,
  frequency TEXT NOT NULL,
  start_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  approved_by TEXT,
  approved_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_plans_company ON payment_plans(company_id);
CREATE INDEX IF NOT EXISTS idx_payment_plans_customer ON payment_plans(company_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_payment_plans_bill ON payment_plans(company_id, bill_id);
CREATE INDEX IF NOT EXISTS idx_payment_plans_status ON payment_plans(company_id, status);

CREATE TABLE IF NOT EXISTS payment_plan_installments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  payment_plan_id TEXT NOT NULL,
  instalment_number INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  amount REAL NOT NULL,
  paid_amount REAL DEFAULT 0,
  outstanding_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  paid_at TEXT,
  payment_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ppi_company ON payment_plan_installments(company_id);
CREATE INDEX IF NOT EXISTS idx_ppi_plan ON payment_plan_installments(payment_plan_id);
CREATE INDEX IF NOT EXISTS idx_ppi_status ON payment_plan_installments(company_id, status);

-- Collection risk scores
CREATE TABLE IF NOT EXISTS collection_risk_scores (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  score INTEGER NOT NULL,
  risk_level TEXT NOT NULL,
  outstanding_amount REAL,
  overdue_amount REAL,
  overdue_days INTEGER,
  payment_history_score REAL,
  ageing_score REAL,
  collection_response_score REAL,
  payment_plan_score REAL,
  factors_json TEXT,
  model_version TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_risk_scores_company ON collection_risk_scores(company_id);
CREATE INDEX IF NOT EXISTS idx_risk_scores_customer ON collection_risk_scores(company_id, customer_id);

-- Escalation records
CREATE TABLE IF NOT EXISTS collection_escalations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  bill_id,
  escalation_level INTEGER NOT NULL,
  previous_owner_id,
  new_owner_id,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
  approved_by,
  approved_at TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cescal_company ON collection_escalations(company_id);
CREATE INDEX IF NOT EXISTS idx_cescal_customer ON collection_escalations(company_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_cescal_status ON collection_escalations(company_id, status);
