-- Migration 040: Tax / GST Master & Accounting Integration (Step 17)
-- Creates centralized tax configuration tables that integrate with the
-- existing Journal Entry engine (Step 6). All tax accounting impact flows
-- through posted JEs — no second accounting engine is introduced.

-- ═══ Tax Types (stable internal codes) ═══
-- CGST, SGST, IGST, CESS, ZERO_RATED, EXEMPT, NIL_RATED, NON_TAXABLE
CREATE TABLE IF NOT EXISTS tax_types (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,              -- e.g. 'CGST', 'SGST', 'IGST', 'CESS'
  name TEXT NOT NULL,              -- e.g. 'Central GST', 'State GST'
  tax_scope TEXT NOT NULL CHECK (tax_scope IN ('OUTPUT', 'INPUT')),
  is_active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(code, tax_scope)
);

-- ═══ Tax Masters (rate definitions) ═══
-- One tax master per rate/type combination, e.g. "GST 18% Interstate"
CREATE TABLE IF NOT EXISTS tax_masters (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  code TEXT NOT NULL,              -- e.g. 'GST_18_INTRASTATE', 'GST_5_INTERSTATE'
  name TEXT NOT NULL,              -- e.g. 'GST 18% (Intra-state: 9% CGST + 9% SGST)'
  is_igst INTEGER DEFAULT 0,       -- 1 = IGST only, 0 = CGST+SGST split
  rate REAL NOT NULL,              -- e.g. 18.0 for 18%
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  is_active INTEGER DEFAULT 1,
  is_system INTEGER DEFAULT 0,     -- system-seeded rates cannot be deleted
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, code)
);

-- ═══ Tax Components (individual components of a tax master) ═══
-- A tax master like "GST 18% Intrastate" has 2 components: CGST 9%, SGST 9%
-- A tax master like "GST 18% Interstate" has 1 component: IGST 18%
CREATE TABLE IF NOT EXISTS tax_components (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  tax_master_id TEXT NOT NULL,
  tax_type_code TEXT NOT NULL,     -- 'CGST', 'SGST', 'IGST', 'CESS', etc.
  rate REAL NOT NULL,              -- e.g. 9.0 for 9%
  is_compound INTEGER DEFAULT 0,   -- compound tax on top of other taxes
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tax_master_id) REFERENCES tax_masters(id) ON DELETE CASCADE,
  UNIQUE(company_id, tax_master_id, tax_type_code)
);

-- ═══ Company Tax Configuration ═══
-- Per-company GST settings: enabled/disabled, GSTIN, state, state code
CREATE TABLE IF NOT EXISTS company_tax_configs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  gst_enabled INTEGER DEFAULT 0,
  gstin TEXT,
  state_name TEXT,
  state_code TEXT,
  registration_type TEXT CHECK (registration_type IN ('REGULAR', 'COMPOSITION', 'RENDERED', 'UNREGISTERED')),
  round_off_tax INTEGER DEFAULT 0,  -- round tax amounts to nearest rupee
  tax_decimal_places INTEGER DEFAULT 2,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id)
);

-- ═══ Tax Account Mappings ═══
-- Maps each tax type to a real ledger account for accounting posting.
-- These are actual GL accounts (OUTPUT CGST, INPUT CGST, OUTPUT IGST, etc.)
CREATE TABLE IF NOT EXISTS tax_account_mappings (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  tax_type_code TEXT NOT NULL,     -- 'CGST', 'SGST', 'IGST', 'CESS', etc.
  tax_scope TEXT NOT NULL CHECK (tax_scope IN ('OUTPUT', 'INPUT')),
  ledger_account_id TEXT NOT NULL, -- FK to accounts(id)
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ledger_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  UNIQUE(company_id, tax_type_code, tax_scope)
);

-- ═══ Transaction Tax Details ═══
-- Records the tax calculation result for each taxed transaction,
-- linked to the voucher and its journal entry. This preserves an
-- auditable trail: Invoice → Tax Calculation → JE → Ledger.
CREATE TABLE IF NOT EXISTS transaction_tax_details (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  voucher_id TEXT NOT NULL,        -- FK to vouchers(id)
  journal_entry_id TEXT,           -- FK to journal_entries(id) (nullable for drafts)
  tax_master_id TEXT,              -- FK to tax_masters(id)
  taxable_amount REAL NOT NULL,     -- the base amount taxed
  tax_type TEXT NOT NULL,          -- 'CGST+SGST' or 'IGST' or 'CESS' etc.
  tax_rate REAL NOT NULL,          -- total tax rate applied
  cgst_rate REAL DEFAULT 0,
  sgst_rate REAL DEFAULT 0,
  igst_rate REAL DEFAULT 0,
  cess_rate REAL DEFAULT 0,
  cgst_amount REAL DEFAULT 0,
  sgst_amount REAL DEFAULT 0,
  igst_amount REAL DEFAULT 0,
  cess_amount REAL DEFAULT 0,
  total_tax REAL NOT NULL,         -- sum of all tax amounts
  grand_total REAL NOT NULL,       -- taxable + tax
  place_of_supply TEXT,            -- state where supply occurs
  is_interstate INTEGER DEFAULT 0, -- 1 = IGST, 0 = CGST+SGST
  calculation_json TEXT,           -- full structured tax breakdown (JSON)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL,
  FOREIGN KEY (tax_master_id) REFERENCES tax_masters(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ttd_voucher ON transaction_tax_details(voucher_id);
CREATE INDEX IF NOT EXISTS idx_ttd_je ON transaction_tax_details(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_ttd_company ON transaction_tax_details(company_id);

-- ═══ Tax Audit Log ═══
-- Tracks changes to tax configuration (master, components, mappings, company config)
CREATE TABLE IF NOT EXISTS tax_audit_log (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  old_values_json TEXT,
  new_values_json TEXT,
  ip_address TEXT,
  session_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tax_audit_company ON tax_audit_log(company_id);
CREATE INDEX IF NOT EXISTS idx_tax_audit_entity ON tax_audit_log(entity_type, entity_id);

-- ═══ Seed: Tax Types ═══
INSERT OR IGNORE INTO tax_types (code, name, tax_scope, is_active, sort_order) VALUES
  ('CGST', 'Central GST', 'OUTPUT', 1, 1),
  ('SGST', 'State GST', 'OUTPUT', 1, 2),
  ('IGST', 'Integrated GST', 'OUTPUT', 1, 3),
  ('CESS', 'CESS', 'OUTPUT', 1, 4),
  ('CGST', 'Central GST', 'INPUT', 1, 1),
  ('SGST', 'State GST', 'INPUT', 1, 2),
  ('IGST', 'Integrated GST', 'INPUT', 1, 3),
  ('CESS', 'CESS', 'INPUT', 1, 4),
  ('ZERO_RATED', 'Zero Rated', 'OUTPUT', 1, 5),
  ('EXEMPT', 'Exempt', 'OUTPUT', 1, 6),
  ('NIL_RATED', 'Nil Rated', 'OUTPUT', 1, 7),
  ('NON_TAXABLE', 'Non Taxable', 'OUTPUT', 1, 8);

-- ═══ Seed: Tax Ledger Accounts ═══
-- Output tax accounts (credit side on sales): CREDIT-nature (income-like)
-- Input tax accounts (debit side on purchases): DEBIT-nature (asset-like)
-- We use account_group_id 'ag_tax_output' / 'ag_tax_input' for organization,
-- falling back to 'ag_income' / 'ag_expense' groups if the tax groups don't exist.

-- Create tax account groups if they don't exist (for COA organization)
INSERT OR IGNORE INTO account_groups (id, company_id, code, name, parent_id, type, debit_credit_nature, is_active, created_at, updated_at)
VALUES
  ('ag_tax_output', 'default', '1400', 'Tax Output', 'ag_income', 'INCOME', 'CREDIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_tax_input', 'default', '1500', 'Tax Input', 'ag_expense', 'EXPENSE', 'DEBIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');

-- Output CGST — CREDIT-nature (output tax is a liability: you collect it for the govt)
INSERT OR IGNORE INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, opening_balance, opening_balance_type, description, is_active, is_system, allow_direct_posting, created_at, updated_at)
VALUES ('acc_output_cgst', 'default', '2401', 'Output CGST', 'ag_tax_output', 'INCOME', 'CREDIT', 0.0, 'CREDIT', 'Central GST collected on sales', 1, 1, 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');

-- Output SGST — CREDIT-nature
INSERT OR IGNORE INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, opening_balance, opening_balance_type, description, is_active, is_system, allow_direct_posting, created_at, updated_at)
VALUES ('acc_output_sgst', 'default', '2402', 'Output SGST', 'ag_tax_output', 'INCOME', 'CREDIT', 0.0, 'CREDIT', 'State GST collected on sales', 1, 1, 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');

-- Output IGST — CREDIT-nature
INSERT OR IGNORE INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, opening_balance, opening_balance_type, description, is_active, is_system, allow_direct_posting, created_at, updated_at)
VALUES ('acc_output_igst', 'default', '2403', 'Output IGST', 'ag_tax_output', 'INCOME', 'CREDIT', 0.0, 'CREDIT', 'Integrated GST collected on sales', 1, 1, 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');

-- Output CESS — CREDIT-nature
INSERT OR IGNORE INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, opening_balance, opening_balance_type, description, is_active, is_system, allow_direct_posting, created_at, updated_at)
VALUES ('acc_output_cess', 'default', '2404', 'Output CESS', 'ag_tax_output', 'INCOME', 'CREDIT', 0.0, 'CREDIT', 'CESS collected on sales', 1, 1, 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');

-- Input CGST — DEBIT-nature (input tax is an asset: you can claim it back)
INSERT OR IGNORE INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, opening_balance, opening_balance_type, description, is_active, is_system, allow_direct_posting, created_at, updated_at)
VALUES ('acc_input_cgst', 'default', '1501', 'Input CGST', 'ag_tax_input', 'ASSET', 'DEBIT', 0.0, 'DEBIT', 'Central GST paid on purchases (recoverable)', 1, 1, 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');

-- Input SGST — DEBIT-nature
INSERT OR IGNORE INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, opening_balance, opening_balance_type, description, is_active, is_system, allow_direct_posting, created_at, updated_at)
VALUES ('acc_input_sgst', 'default', '1502', 'Input SGST', 'ag_tax_input', 'ASSET', 'DEBIT', 0.0, 'DEBIT', 'State GST paid on purchases (recoverable)', 1, 1, 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');

-- Input IGST — DEBIT-nature
INSERT OR IGNORE INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, opening_balance, opening_balance_type, description, is_active, is_system, allow_direct_posting, created_at, updated_at)
VALUES ('acc_input_igst', 'default', '1503', 'Input IGST', 'ag_tax_input', 'ASSET', 'DEBIT', 0.0, 'DEBIT', 'Integrated GST paid on purchases (recoverable)', 1, 1, 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');

-- Input CESS — DEBIT-nature
INSERT OR IGNORE INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, opening_balance, opening_balance_type, description, is_active, is_system, allow_direct_posting, created_at, updated_at)
VALUES ('acc_input_cess', 'default', '1504', 'Input CESS', 'ag_tax_input', 'ASSET', 'DEBIT', 0.0, 'DEBIT', 'CESS paid on purchases (recoverable)', 1, 1, 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');

-- ═══ Seed: Default GST Tax Masters (India) ═══
-- Standard rate: 18% (9% CGST + 9% SGST for intra-state, 18% IGST for inter-state)
INSERT OR IGNORE INTO tax_masters (id, company_id, code, name, is_igst, rate, effective_from, is_active, is_system, description, created_at, updated_at)
VALUES
  ('tax_gst_18_intra', 'default', 'GST_18_INTRASTATE', 'GST 18% (Intra-state: 9% CGST + 9% SGST)', 0, 18.0, '2017-07-01', 1, 1, 'Standard rate GST for intra-state supplies (B2B/B2C)', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('tax_gst_18_inter', 'default', 'GST_18_INTERSTATE', 'GST 18% (Inter-state: 18% IGST)', 1, 18.0, '2017-07-01', 1, 1, 'Standard rate GST for inter-state supplies (B2B)', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('tax_gst_5_intra', 'default', 'GST_5_INTRASTATE', 'GST 5% (Intra-state: 2.5% CGST + 2.5% SGST)', 0, 5.0, '2017-07-01', 1, 1, 'Reduced rate GST for intra-state supplies', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('tax_gst_5_inter', 'default', 'GST_5_INTERSTATE', 'GST 5% (Inter-state: 5% IGST)', 1, 5.0, '2017-07-01', 1, 1, 'Reduced rate GST for inter-state supplies', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('tax_gst_12_intra', 'default', 'GST_12_INTRASTATE', 'GST 12% (Intra-state: 6% CGST + 6% SGST)', 0, 12.0, '2017-07-01', 1, 1, 'Special rate GST for intra-state supplies', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('tax_gst_12_inter', 'default', 'GST_12_INTERSTATE', 'GST 12% (Inter-state: 12% IGST)', 1, 12.0, '2017-07-01', 1, 1, 'Special rate GST for inter-state supplies', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('tax_gst_3_intra', 'default', 'GST_3_INTRASTATE', 'GST 3% (Intra-state: 1.5% CGST + 1.5% SGST)', 0, 3.0, '2017-07-01', 1, 1, 'Minor rate GST for intra-state supplies', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('tax_gst_3_inter', 'default', 'GST_3_INTERSTATE', 'GST 3% (Inter-state: 3% IGST)', 1, 3.0, '2017-07-01', 1, 1, 'Minor rate GST for inter-state supplies', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('tax_gst_0', 'default', 'GST_0', 'GST 0% / Nil-rated', 0, 0.0, '2017-07-01', 1, 1, 'Zero-rated / nil-rated supplies (no tax, but eligible for input credit)', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('tax_exempt', 'default', 'TAX_EXEMPT', 'Exempt', 0, 0.0, '2017-07-01', 1, 1, 'Supplies on which no tax is levied and input credit is not available', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('tax_non_taxable', 'default', 'TAX_NON_TAXABLE', 'Non-Taxable', 0, 0.0, '2017-07-01', 1, 1, 'Supplies outside the scope of GST', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');

-- ═══ Seed: Tax Components for default GST masters ═══
-- GST 18% intrastate: CGST 9%, SGST 9%
INSERT OR IGNORE INTO tax_components (id, company_id, tax_master_id, tax_type_code, rate, is_compound, created_at)
VALUES
  ('tcx_cgst_18', 'default', 'tax_gst_18_intra', 'CGST', 9.0, 0, '2024-01-01T00:00:00Z'),
  ('tcx_sgst_18', 'default', 'tax_gst_18_intra', 'SGST', 9.0, 0, '2024-01-01T00:00:00Z'),
  ('tcx_igst_18', 'default', 'tax_gst_18_inter', 'IGST', 18.0, 0, '2024-01-01T00:00:00Z'),

  ('tcx_cgst_5', 'default', 'tax_gst_5_intra', 'CGST', 2.5, 0, '2024-01-01T00:00:00Z'),
  ('tcx_sgst_5', 'default', 'tax_gst_5_intra', 'SGST', 2.5, 0, '2024-01-01T00:00:00Z'),
  ('tcx_igst_5', 'default', 'tax_gst_5_inter', 'IGST', 5.0, 0, '2024-01-01T00:00:00Z'),

  ('tcx_cgst_12', 'default', 'tax_gst_12_intra', 'CGST', 6.0, 0, '2024-01-01T00:00:00Z'),
  ('tcx_sgst_12', 'default', 'tax_gst_12_intra', 'SGST', 6.0, 0, '2024-01-01T00:00:00Z'),
  ('tcx_igst_12', 'default', 'tax_gst_12_inter', 'IGST', 12.0, 0, '2024-01-01T00:00:00Z'),

  ('tcx_cgst_3', 'default', 'tax_gst_3_intra', 'CGST', 1.5, 0, '2024-01-01T00:00:00Z'),
  ('tcx_sgst_3', 'default', 'tax_gst_3_intra', 'SGST', 1.5, 0, '2024-01-01T00:00:00Z'),
  ('tcx_igst_3', 'default', 'tax_gst_3_inter', 'IGST', 3.0, 0, '2024-01-01T00:00:00Z');

-- ═══ Seed: Tax Account Mappings ═══
INSERT OR IGNORE INTO tax_account_mappings (id, company_id, tax_type_code, tax_scope, ledger_account_id, is_active, created_at, updated_at)
VALUES
  ('tam_out_cgst', 'default', 'CGST', 'OUTPUT', 'acc_output_cgst', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('tam_out_sgst', 'default', 'SGST', 'OUTPUT', 'acc_output_sgst', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('tam_out_igst', 'default', 'IGST', 'OUTPUT', 'acc_output_igst', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('tam_out_cess', 'default', 'CESS', 'OUTPUT', 'acc_output_cess', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('tam_in_cgst', 'default', 'CGST', 'INPUT', 'acc_input_cgst', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('tam_in_sgst', 'default', 'SGST', 'INPUT', 'acc_input_sgst', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('tam_in_igst', 'default', 'IGST', 'INPUT', 'acc_input_igst', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('tam_in_cess', 'default', 'CESS', 'INPUT', 'acc_input_cess', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');

-- ═══ Seed: Default Company Tax Configuration ═══
-- Default: GST enabled, Karnataka (state code 29)
INSERT OR IGNORE INTO company_tax_configs (id, company_id, gst_enabled, gstin, state_name, state_code, registration_type, round_off_tax, tax_decimal_places, is_active, created_at, updated_at)
VALUES ('ctc_default', 'default', 1, NULL, 'KARNATAKA', '29', 'REGULAR', 0, 2, 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');
