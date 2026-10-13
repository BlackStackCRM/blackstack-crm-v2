-- Migration 025: Migrate existing invoices and payments to the new accounting system
-- Preserves historical financial data by converting invoices → bills + journal entries
-- Original invoice/payment tables are preserved for historical reference

-- Migrate invoices to bills (customer bills)
INSERT OR IGNORE INTO bills (
  id, company_id, bill_number, bill_type, contact_id, organization_id, deal_id,
  currency, status, issue_date, due_date, subtotal, tax, discount, total,
  paid_amount, balance, reference_number, notes, terms, created_by, created_at, updated_at
)
SELECT
  'mig_' || id, company_id, invoice_number, 'CUSTOMER', contact_id, organization_id, deal_id,
  COALESCE(currency, 'USD'),
  CASE status
    WHEN 'DRAFT' THEN 'DRAFT'
    WHEN 'SENT' THEN 'SENT'
    WHEN 'PAID' THEN 'PAID'
    WHEN 'PARTIAL' THEN 'PARTIAL'
    WHEN 'OVERDUE' THEN 'OVERDUE'
    ELSE 'SENT'
  END,
  issue_date, due_date, subtotal, tax, discount, total,
  paid_amount, balance, NULL, notes, terms, 'system', created_at, updated_at
FROM invoices;

-- Migrate payments as voucher + journal entries (receipt vouchers for customer payments)
INSERT OR IGNORE INTO vouchers (
  id, company_id, voucher_number, voucher_type, financial_year_id, voucher_date,
  reference_number, description, contact_id, organization_id, deal_id, bill_id,
  currency, exchange_rate, status, created_by, created_at, updated_at, posted_at, posted_by
)
SELECT
  'mig_v_' || id, company_id, 'RC-MIG-' || CAST(ROW_NUMBER() OVER (ORDER BY payment_date) AS TEXT), 'RECEIPT',
  (SELECT id FROM financial_years WHERE company_id = p.company_id AND is_active = 1 LIMIT 1),
  payment_date, reference_number, 'Migrated payment: ' || COALESCE(notes, ''), contact_id, NULL,
  (SELECT deal_id FROM invoices i WHERE i.id = p.invoice_id LIMIT 1),
  (SELECT id FROM bills WHERE id = 'mig_' || (SELECT id FROM invoices i WHERE i.id = p.invoice_id LIMIT 1) LIMIT 1),
  COALESCE(currency, 'USD'), 1.0, 'POSTED', 'system', created_at, updated_at, created_at, 'system'
FROM payments p;

-- Create journal entries for migrated payments
INSERT OR IGNORE INTO journal_entries (
  id, company_id, voucher_id, entry_number, entry_date, description, currency,
  exchange_rate, total_debit, total_credit, status, created_by, created_at, updated_at, posted_at, posted_by
)
SELECT
  'mig_j_' || id, company_id, 'mig_v_' || id, 'JV-MIG-' || id, payment_date,
  'Migrated payment', COALESCE(currency, 'USD'), 1.0, amount, amount,
  'POSTED', 'system', created_at, updated_at, created_at, 'system'
FROM payments;

-- Create journal lines: Debit Bank (1002), Credit Accounts Receivable (1003)
INSERT OR IGNORE INTO journal_entry_lines (
  id, company_id, journal_entry_id, account_id, cost_centre_id, cost_category_id,
  debit_amount, credit_amount, description, reference_id, created_at
)
SELECT
  'mig_l_d_' || p.id, p.company_id, 'mig_j_' || p.id,
  (SELECT id FROM accounts WHERE company_id = p.company_id AND code = '1002' LIMIT 1),
  NULL, NULL, p.amount, 0, 'Bank', p.invoice_id, p.created_at
FROM payments p WHERE p.status = 'COMPLETED';

INSERT OR IGNORE INTO journal_entry_lines (
  id, company_id, journal_entry_id, account_id, cost_centre_id, cost_category_id,
  debit_amount, credit_amount, description, reference_id, created_at
)
SELECT
  'mig_l_c_' || p.id, p.company_id, 'mig_j_' || p.id,
  (SELECT id FROM accounts WHERE company_id = p.company_id AND code = '1003' LIMIT 1),
  NULL, NULL, 0, p.amount, 'Accounts Receivable', p.invoice_id, p.created_at
FROM payments p WHERE p.status = 'COMPLETED';

-- Create receivables from migrated customer bills
INSERT OR IGNORE INTO receivables (
  id, company_id, bill_id, contact_id, organization_id, deal_id, due_date,
  original_amount, paid_amount, outstanding_amount, currency, status,
  credit_limit, credit_period_days, payment_terms, days_overdue, created_at, updated_at
)
SELECT
  'mig_r_' || b.id, b.company_id, b.id, b.contact_id, b.organization_id, b.deal_id, b.due_date,
  b.total, b.paid_amount, b.balance, b.currency,
  CASE
    WHEN b.balance <= 0 THEN 'PAID'
    WHEN b.due_date < date('now') THEN 'OVERDUE'
    ELSE 'CURRENT'
  END,
  0, 30, b.terms,
  CASE WHEN b.due_date < date('now') THEN CAST(julianday('now') - julianday(b.due_date) AS INTEGER) ELSE 0 END,
  b.created_at, b.updated_at
FROM bills b WHERE b.bill_type = 'CUSTOMER' AND b.bill_number LIKE 'INV-%';

-- Audit the migration
INSERT OR IGNORE INTO accounting_audit (id, company_id, user_id, action, entity_type, entity_id, old_values_json, new_values_json, created_at)
SELECT
  'mig_audit_' || id, company_id, 'system', 'INVOICE_MIGRATED', 'BILL', 'mig_' || id,
  JSON_OBJECT('invoice_id', id, 'invoice_number', invoice_number, 'original_status', status, 'total', total, 'balance', balance),
  JSON_OBJECT('bill_id', 'mig_' || id, 'bill_number', invoice_number, 'migrated', 1, 'total', total, 'balance', balance),
  datetime('now')
FROM invoices;
