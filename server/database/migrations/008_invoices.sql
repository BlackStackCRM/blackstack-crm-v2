CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  invoice_number TEXT UNIQUE NOT NULL,
  contact_id TEXT NOT NULL,
  organization_id TEXT,
  deal_id TEXT,
  status TEXT DEFAULT 'DRAFT',
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  subtotal REAL DEFAULT 0.0,
  tax REAL DEFAULT 0.0,
  discount REAL DEFAULT 0.0,
  total REAL DEFAULT 0.0,
  paid_amount REAL DEFAULT 0.0,
  balance REAL DEFAULT 0.0,
  notes TEXT,
  terms TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS invoice_line_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  product_id TEXT,
  description TEXT NOT NULL,
  quantity REAL DEFAULT 1.0,
  unit_price REAL DEFAULT 0.0,
  tax_rate REAL DEFAULT 0.0,
  discount REAL DEFAULT 0.0,
  total REAL DEFAULT 0.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
);
