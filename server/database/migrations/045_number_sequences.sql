-- Global automatic code generation (CRM-wide).
-- 1) Central sequence table used by code-generator.service.js. One atomic
--    counter row per (company, entity type, scope e.g. fiscal year).
-- 2) Enforce database-level uniqueness of internal codes so concurrent
--    requests / API clients / double-clicks can never create duplicates.

CREATE TABLE IF NOT EXISTS number_sequences (
  company_id  TEXT    NOT NULL DEFAULT 'default',
  entity_type TEXT    NOT NULL,
  scope       TEXT    NOT NULL DEFAULT '',
  next_seq    INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT,
  PRIMARY KEY (company_id, entity_type, scope)
);

-- Unique constraints (ignore-if-exists so legacy databases with legacy
-- duplicates are not broken; run the duplicate-check before applying on
-- production data).
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_company_code ON accounts(company_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_groups_company_code ON account_groups(company_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_centres_company_code ON cost_centres(company_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_categories_company_code ON cost_categories(company_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_invoice_number ON invoices(invoice_number);
