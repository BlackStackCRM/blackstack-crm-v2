-- Migration 023: Seed default Chart of Accounts for the Accounting & Finance module
-- Seeds system-defined account groups and GL accounts used by all tenants

INSERT OR IGNORE INTO account_groups (id, company_id, code, name, parent_id, type, debit_credit_nature, is_active, created_at, updated_at) VALUES
  ('ag_asset',      'default', '1000', 'Assets',             NULL,    'ASSET',     'DEBIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_liability',  'default', '2000', 'Liabilities',        NULL,    'LIABILITY', 'CREDIT',1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_equity',     'default', '3000', 'Equity',             NULL,    'EQUITY',    'CREDIT',1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_income',     'default', '4000', 'Income',             NULL,    'INCOME',    'CREDIT',1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_expense',    'default', '5000', 'Expenses',           NULL,    'EXPENSE',   'DEBIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),

  ('ag_cash',       'default', '1100', 'Cash',               'ag_asset', 'ASSET', 'DEBIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_bank',       'default', '1200', 'Banks',              'ag_asset', 'ASSET', 'DEBIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_receivable', 'default', '1300', 'Accounts Receivable','ag_asset', 'ASSET', 'DEBIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_payable',    'default', '2100', 'Accounts Payable',   'ag_liability', 'LIABILITY', 'CREDIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_loan',       'default', '2200', 'Loans',              'ag_liability', 'LIABILITY', 'CREDIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_capital',    'default', '3100', 'Capital',            'ag_equity', 'EQUITY', 'CREDIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_retained',   'default', '3200', 'Retained Earnings',  'ag_equity', 'EQUITY', 'CREDIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_sales',      'default', '4100', 'Sales',              'ag_income', 'INCOME', 'CREDIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_service',    'default', '4200', 'Service Income',     'ag_income', 'INCOME', 'CREDIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_rent',       'default', '5100', 'Rent',               'ag_expense', 'EXPENSE', 'DEBIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_salaries',   'default', '5200', 'Salaries',           'ag_expense', 'EXPENSE', 'DEBIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_marketing',  'default', '5300', 'Marketing',          'ag_expense', 'EXPENSE', 'DEBIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_utilities',  'default', '5400', 'Utilities',          'ag_expense', 'EXPENSE', 'DEBIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_purchases',  'default', '5500', 'Purchases',          'ag_expense', 'EXPENSE', 'DEBIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('ag_cost_goods', 'default', '5600', 'Cost of Goods Sold','ag_expense', 'EXPENSE', 'DEBIT', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');

INSERT OR IGNORE INTO currencies (id, company_id, code, name, symbol, locale, is_base, is_active, created_at) VALUES
  ('cur_usd', 'default', 'USD', 'US Dollar',    '$',  'en-US', 1, 1, '2024-01-01T00:00:00Z'),
  ('cur_eur', 'default', 'EUR', 'Euro',         'EUR', 'en-EU', 0, 1, '2024-01-01T00:00:00Z'),
  ('cur_gbp', 'default', 'GBP', 'Pound Sterling', 'GBP', 'en-GB', 0, 1, '2024-01-01T00:00:00Z'),
  ('cur_inr', 'default', 'INR', 'Indian Rupee', 'INR', 'en-IN', 0, 1, '2024-01-01T00:00:00Z');

-- Seed GL accounts linked to the account groups above
INSERT OR IGNORE INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, opening_balance, opening_balance_type, description, is_active, created_at, updated_at) VALUES
  ('acc_cash',      'default', '1001', 'Cash in Hand',        'ag_cash',       'CASH',  'DEBIT',  0.0, 'DEBIT', 'Cash on hand', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('acc_bank',      'default', '1002', 'Bank Account',        'ag_bank',       'BANK',  'DEBIT',  0.0, 'DEBIT', 'Primary checking account', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('acc_receivable','default', '1003', 'Accounts Receivable',  'ag_receivable', 'ASSET', 'DEBIT',  0.0, 'DEBIT', 'Trade receivables', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('acc_payable',   'default', '2001', 'Accounts Payable',     'ag_payable',    'LIABILITY','CREDIT',0.0, 'CREDIT','Trade payables', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('acc_capital',   'default', '3001', 'Share Capital',        'ag_capital',    'EQUITY', 'CREDIT',0.0, 'CREDIT','Owner''s capital', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('acc_retained',  'default', '3002', 'Retained Earnings',    'ag_retained',   'EQUITY', 'CREDIT',0.0, 'CREDIT','Retained earnings', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('acc_sales',     'default', '4001', 'Sales Revenue',        'ag_sales',      'INCOME', 'CREDIT',0.0, 'CREDIT','Revenue from sales', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('acc_service',   'default', '4002', 'Service Revenue',      'ag_service',    'INCOME', 'CREDIT',0.0, 'CREDIT','Revenue from services', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('acc_rent',      'default', '5001', 'Rent Expense',         'ag_rent',       'EXPENSE', 'DEBIT', 0.0, 'DEBIT', 'Office rent', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('acc_salaries',  'default', '5002', 'Salaries Expense',     'ag_salaries',   'EXPENSE', 'DEBIT', 0.0, 'DEBIT', 'Employee salaries', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('acc_marketing', 'default', '5003', 'Marketing Expense',    'ag_marketing',  'EXPENSE', 'DEBIT', 0.0, 'DEBIT', 'Advertising and marketing', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('acc_utilities', 'default', '5004', 'Utilities Expense',    'ag_utilities',  'EXPENSE', 'DEBIT', 0.0, 'DEBIT', 'Utility bills', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('acc_purchases', 'default', '5005', 'Purchases',            'ag_purchases',  'EXPENSE', 'DEBIT', 0.0, 'DEBIT', 'Raw materials / goods purchased', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('acc_cogs',      'default', '5006', 'Cost of Goods Sold',   'ag_cost_goods', 'EXPENSE', 'DEBIT', 0.0, 'DEBIT', 'Direct cost of goods sold', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');

-- Seed default financial year (2024-01-01 to 2024-12-31)
INSERT OR IGNORE INTO financial_years (id, company_id, name, start_date, end_date, is_active, is_locked, created_at) VALUES
  ('fy_2024', 'default', 'FY 2024', '2024-01-01', '2024-12-31', 1, 0, '2024-01-01T00:00:00Z');
