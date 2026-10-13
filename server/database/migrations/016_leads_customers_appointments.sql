CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  contact_id TEXT NOT NULL,
  source TEXT DEFAULT 'manual',
  lead_status TEXT DEFAULT 'NEW',
  lead_score INTEGER DEFAULT 0,
  budget REAL,
  timeline TEXT,
  decision_maker TEXT,
  interest_level TEXT,
  qualification_notes TEXT,
  converted_at DATETIME,
  lost_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  contact_id TEXT NOT NULL,
  onboarding_status TEXT DEFAULT 'PENDING',
  retention_status TEXT DEFAULT 'ACTIVE',
  customer_since DATETIME DEFAULT CURRENT_TIMESTAMP,
  lifetime_value REAL DEFAULT 0,
  churn_risk TEXT DEFAULT 'LOW',
  account_manager_id TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (account_manager_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  contact_id TEXT,
  deal_id TEXT,
  lead_id TEXT,
  customer_id TEXT,
  assigned_to TEXT,
  title TEXT NOT NULL,
  description TEXT,
  start_time DATETIME NOT NULL,
  end_time DATETIME,
  location TEXT,
  outcome TEXT,
  outcome_notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  entity_type TEXT,
  entity_id TEXT,
  is_read INTEGER DEFAULT 0,
  read_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
