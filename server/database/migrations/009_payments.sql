CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  invoice_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  amount REAL NOT NULL,
  payment_method TEXT DEFAULT 'OTHER',
  status TEXT DEFAULT 'COMPLETED',
  reference_number TEXT,
  notes TEXT,
  payment_date TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);
