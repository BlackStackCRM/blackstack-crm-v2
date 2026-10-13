CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  relationship_type TEXT NOT NULL,
  status TEXT DEFAULT 'ACTIVE',
  person_a_id TEXT NOT NULL,
  person_b_id TEXT,
  organization_id TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (person_a_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (person_b_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
