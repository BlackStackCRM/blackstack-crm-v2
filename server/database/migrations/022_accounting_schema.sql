-- Migration 022: Accounting & Finance module
-- Replaces legacy invoice/payment system with double-entry bookkeeping
-- Preserves historical data via migration to accounting tables

-- Currency master
CREATE TABLE IF NOT EXISTS currencies (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  symbol TEXT,
  locale TEXT,
  is_base INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, code)
);

-- Account groups (hierarchical accounting categories: Assets, Liabilities, Equity, Income, Expenses)
CREATE TABLE IF NOT EXISTS account_groups (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')),
  debit_credit_nature TEXT NOT NULL CHECK (debit_credit_nature IN ('DEBIT', 'CREDIT')),
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_id) REFERENCES account_groups(id) ON DELETE SET NULL,
  UNIQUE(company_id, code)
);

-- Chart of Accounts (individual GL accounts)
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_group_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE', 'BANK', 'CASH')),
  debit_credit_nature TEXT NOT NULL CHECK (debit_credit_nature IN ('DEBIT', 'CREDIT')),
  opening_balance REAL DEFAULT 0.0,
  opening_balance_type TEXT DEFAULT 'DEBIT',
  description TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_group_id) REFERENCES account_groups(id) ON DELETE RESTRICT,
  UNIQUE(company_id, code)
);

-- Financial years
CREATE TABLE IF NOT EXISTS financial_years (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  is_active INTEGER DEFAULT 0,
  is_locked INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, name)
);

-- Cost centres
CREATE TABLE IF NOT EXISTS cost_centres (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id TEXT,
  description TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_id) REFERENCES cost_centres(id) ON DELETE SET NULL,
  UNIQUE(company_id, code)
);

-- Cost categories
CREATE TABLE IF NOT EXISTS cost_categories (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, code)
);

-- Bank accounts
CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  account_name TEXT NOT NULL,
  account_number TEXT,
  bank_name TEXT,
  ifsc_code TEXT,
  account_type TEXT CHECK (account_type IN ('CHECKING', 'SAVINGS', 'CASH')),
  gl_account_id TEXT NOT NULL,
  opening_balance REAL DEFAULT 0.0,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (gl_account_id) REFERENCES accounts(id) ON DELETE RESTRICT
);

-- Voucher types: JOURNAL, PAYMENT, RECEIPT, CONTRA, CREDIT_NOTE, DEBIT_NOTE
-- Master vouchers (one per business document)
CREATE TABLE IF NOT EXISTS vouchers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  voucher_number TEXT NOT NULL,
  voucher_type TEXT NOT NULL CHECK (voucher_type IN ('JOURNAL', 'PAYMENT', 'RECEIPT', 'CONTRA', 'CREDIT_NOTE', 'DEBIT_NOTE', 'SALES', 'PURCHASE', 'EXPENSE')),
  financial_year_id TEXT,
  voucher_date TEXT NOT NULL,
  reference_number TEXT,
  description TEXT,
  contact_id TEXT,
  organization_id TEXT,
  deal_id TEXT,
  bill_id TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  exchange_rate REAL DEFAULT 1.0,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED', 'REVERSED')),
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  posted_at DATETIME,
  posted_by TEXT,
  receipt_mode TEXT CHECK (receipt_mode IN ('CASH', 'BANK', 'UPI', 'CHEQUE', 'CARD', 'OTHER', 'CREDIT')),
  journal_entry_id TEXT,
  total_amount REAL DEFAULT 0,
  sales_invoice_number TEXT,
  receiving_ledger_id TEXT,
  sales_ledger_id TEXT,
  purchase_invoice_number TEXT,
  payable_ledger_id TEXT,
  purchase_ledger_id TEXT,
  expense_voucher_number TEXT,
  payment_ledger_id TEXT,
  expense_payee_id TEXT,
  FOREIGN KEY (financial_year_id) REFERENCES financial_years(id) ON DELETE SET NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE SET NULL,
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  FOREIGN KEY (receiving_ledger_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (sales_ledger_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (payable_ledger_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (purchase_ledger_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (payment_ledger_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (expense_payee_id) REFERENCES contacts(id) ON DELETE SET NULL,
  UNIQUE(company_id, voucher_number)
);

-- Indexes for vouchers
CREATE INDEX IF NOT EXISTS idx_vouchers_company_type ON vouchers(company_id, voucher_type);
CREATE INDEX IF NOT EXISTS idx_vouchers_company_date ON vouchers(company_id, voucher_date);
CREATE INDEX IF NOT EXISTS idx_vouchers_receipt_type ON vouchers(voucher_type, status) WHERE voucher_type = 'RECEIPT';
CREATE INDEX IF NOT EXISTS idx_vouchers_sales_type ON vouchers(voucher_type, status) WHERE voucher_type = 'SALES';
CREATE INDEX IF NOT EXISTS idx_vouchers_sales_invoice ON vouchers(sales_invoice_number) WHERE sales_invoice_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vouchers_sales_ledger ON vouchers(sales_ledger_id) WHERE sales_ledger_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vouchers_receiving_ledger ON vouchers(receiving_ledger_id) WHERE receiving_ledger_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vouchers_purchase_type ON vouchers(voucher_type, status) WHERE voucher_type = 'PURCHASE';
CREATE INDEX IF NOT EXISTS idx_vouchers_purchase_invoice ON vouchers(purchase_invoice_number) WHERE purchase_invoice_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vouchers_purchase_ledger ON vouchers(purchase_ledger_id) WHERE purchase_ledger_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vouchers_payable_ledger ON vouchers(payable_ledger_id) WHERE payable_ledger_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vouchers_expense_type ON vouchers(voucher_type, status) WHERE voucher_type = 'EXPENSE';

-- Journal entries (each voucher produces at least one journal entry)
CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  voucher_id TEXT,
  entry_number TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  description TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  exchange_rate REAL DEFAULT 1.0,
  total_debit REAL DEFAULT 0.0,
  total_credit REAL DEFAULT 0.0,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED', 'REVERSED')),
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  posted_at DATETIME,
  posted_by TEXT,
  FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE SET NULL,
  UNIQUE(company_id, entry_number)
);

-- Journal entry lines (double-entry: one row per account debit/credit)
CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  journal_entry_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  cost_centre_id TEXT,
  cost_category_id TEXT,
  debit_amount REAL DEFAULT 0.0,
  credit_amount REAL DEFAULT 0.0,
  description TEXT,
  reference_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (cost_centre_id) REFERENCES cost_centres(id) ON DELETE SET NULL,
  FOREIGN KEY (cost_category_id) REFERENCES cost_categories(id) ON DELETE SET NULL
);

-- Bills (customer bills / supplier bills — replaces legacy invoices)
CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  bill_number TEXT NOT NULL,
  bill_type TEXT NOT NULL CHECK (bill_type IN ('CUSTOMER', 'SUPPLIER')),
  contact_id TEXT NOT NULL,
  organization_id TEXT,
  deal_id TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SENT', 'PARTIAL', 'PAID', 'OVERDUE', 'CANCELLED')),
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  subtotal REAL DEFAULT 0.0,
  tax REAL DEFAULT 0.0,
  discount REAL DEFAULT 0.0,
  total REAL DEFAULT 0.0,
  paid_amount REAL DEFAULT 0.0,
  balance REAL DEFAULT 0.0,
  reference_number TEXT,
  notes TEXT,
  terms TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL,
  UNIQUE(company_id, bill_number)
);

-- Bill line items
CREATE TABLE IF NOT EXISTS bill_items (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  bill_id TEXT NOT NULL,
  product_id TEXT,
  description TEXT NOT NULL,
  quantity REAL DEFAULT 1.0,
  unit_price REAL DEFAULT 0.0,
  tax_rate REAL DEFAULT 0.0,
  discount REAL DEFAULT 0.0,
  total REAL DEFAULT 0.0,
  gl_account_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
  FOREIGN KEY (gl_account_id) REFERENCES accounts(id) ON DELETE SET NULL
);

-- Bill allocations (bill-wise payment tracking)
CREATE TABLE IF NOT EXISTS bill_allocations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  bill_id TEXT NOT NULL,
  journal_entry_id TEXT NOT NULL,
  amount REAL NOT NULL,
  allocation_date TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE RESTRICT
);

-- Receivables summary (derived view data cached for performance; always calculated from journal entries)
CREATE TABLE IF NOT EXISTS receivables (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  bill_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  organization_id TEXT,
  deal_id TEXT,
  due_date TEXT NOT NULL,
  original_amount REAL NOT NULL,
  paid_amount REAL DEFAULT 0.0,
  outstanding_amount REAL DEFAULT 0.0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'CURRENT' CHECK (status IN ('CURRENT', 'DUE_SOON', 'OVERDUE', 'PARTIALLY_PAID', 'PAID', 'WRITTEN_OFF')),
  credit_limit REAL DEFAULT 0.0,
  credit_period_days INTEGER DEFAULT 30,
  payment_terms TEXT,
  days_overdue INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL
);

-- Payables summary (supplier-side equivalent of receivables)
CREATE TABLE IF NOT EXISTS payables (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  bill_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  organization_id TEXT,
  due_date TEXT NOT NULL,
  original_amount REAL NOT NULL,
  paid_amount REAL DEFAULT 0.0,
  outstanding_amount REAL DEFAULT 0.0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'CURRENT' CHECK (status IN ('CURRENT', 'DUE_SOON', 'OVERDUE', 'PARTIALLY_PAID', 'PAID', 'CANCELLED')),
  days_overdue INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
);

-- Credit management rules per contact
CREATE TABLE IF NOT EXISTS credit_rules (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  contact_id TEXT NOT NULL,
  credit_limit REAL DEFAULT 0.0,
  credit_period_days INTEGER DEFAULT 30,
  payment_terms TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  UNIQUE(company_id, contact_id)
);

-- Interest calculation configurations and computed interest
CREATE TABLE IF NOT EXISTS interest_configs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  interest_rate REAL NOT NULL,
  calculation_method TEXT NOT NULL CHECK (calculation_method IN ('DAILY', 'MONTHLY', 'YEARLY')),
  grace_period_days INTEGER DEFAULT 0,
  is_compound INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS interest_calculations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  config_id TEXT NOT NULL,
  receivable_id TEXT,
  payable_id TEXT,
  principal_amount REAL NOT NULL,
  interest_rate REAL NOT NULL,
  interest_days INTEGER NOT NULL,
  interest_amount REAL NOT NULL,
  calculated_date TEXT NOT NULL,
  is_posted INTEGER DEFAULT 0,
  journal_entry_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (config_id) REFERENCES interest_configs(id) ON DELETE RESTRICT,
  FOREIGN KEY (receivable_id) REFERENCES receivables(id) ON DELETE CASCADE,
  FOREIGN KEY (payable_id) REFERENCES payables(id) ON DELETE CASCADE,
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL
);

-- Budgets and budget lines
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  financial_year_id TEXT NOT NULL,
  budget_type TEXT NOT NULL CHECK (budget_type IN ('REVENUE', 'EXPENSE', 'COST_CENTRE')),
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (financial_year_id) REFERENCES financial_years(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS budget_lines (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  budget_id TEXT NOT NULL,
  account_id TEXT,
  cost_centre_id TEXT,
  period TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  budget_amount REAL NOT NULL,
  actual_amount REAL DEFAULT 0.0,
  variance REAL DEFAULT 0.0,
  variance_percentage REAL DEFAULT 0.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (cost_centre_id) REFERENCES cost_centres(id) ON DELETE RESTRICT
);

-- Audit trail for all accounting operations
CREATE TABLE IF NOT EXISTS accounting_audit (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  old_values_json TEXT,
  new_values_json TEXT,
  ip_address TEXT,
  user_agent TEXT,
  session_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_journal_entries_company_date ON journal_entries(company_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_entry_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_entry_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_vouchers_company_type ON vouchers(company_id, voucher_type);
CREATE INDEX IF NOT EXISTS idx_vouchers_company_date ON vouchers(company_id, voucher_date);
CREATE INDEX IF NOT EXISTS idx_receivables_contact ON receivables(company_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_receivables_status ON receivables(company_id, status);
CREATE INDEX IF NOT EXISTS idx_receivables_due ON receivables(company_id, due_date);
CREATE INDEX IF NOT EXISTS idx_payables_contact ON payables(company_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_payables_status ON payables(company_id, status);
CREATE INDEX IF NOT EXISTS idx_payables_due ON payables(company_id, due_date);
CREATE INDEX IF NOT EXISTS idx_bills_company ON bills(company_id);
CREATE INDEX IF NOT EXISTS idx_bills_contact ON bills(company_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_items(bill_id);
CREATE INDEX IF NOT EXISTS idx_accounts_company ON accounts(company_id);
CREATE INDEX IF NOT EXISTS idx_accounts_group ON accounts(account_group_id);

CREATE INDEX IF NOT EXISTS idx_audit_company_entity ON accounting_audit(company_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_budget_lines_budget ON budget_lines(budget_id);
CREATE INDEX IF NOT EXISTS idx_financial_years_active ON financial_years(company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_cost_centres_company ON cost_centres(company_id);
CREATE INDEX IF NOT EXISTS idx_cost_categories_company ON cost_categories(company_id);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_company ON bank_accounts(company_id);
CREATE INDEX IF NOT EXISTS idx_interest_configs_company ON interest_configs(company_id);
CREATE INDEX IF NOT EXISTS idx_interest_calc_receivable ON interest_calculations(receivable_id);
CREATE INDEX IF NOT EXISTS idx_interest_calc_payable ON interest_calculations(payable_id);
