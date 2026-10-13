class AccountGroup {
  static tableName = 'account_groups';
  static fields = ['id', 'company_id', 'code', 'name', 'parent_id', 'type', 'debit_credit_nature', 'is_active', 'created_at', 'updated_at'];
}

class Account {
  static tableName = 'accounts';
  static fields = ['id', 'company_id', 'code', 'name', 'account_group_id', 'type', 'debit_credit_nature', 'opening_balance', 'opening_balance_type', 'description', 'is_active', 'created_at', 'updated_at'];
}

class FinancialYear {
  static tableName = 'financial_years';
  static fields = ['id', 'company_id', 'name', 'start_date', 'end_date', 'is_active', 'is_locked', 'created_at'];
}

class CostCentre {
  static tableName = 'cost_centres';
  static fields = ['id', 'company_id', 'code', 'name', 'parent_id', 'description', 'is_active', 'created_at', 'updated_at'];
}

class CostCategory {
  static tableName = 'cost_categories';
  static fields = ['id', 'company_id', 'code', 'name', 'description', 'is_active', 'created_at', 'updated_at'];
}

class BankAccount {
  static tableName = 'bank_accounts';
  static fields = ['id', 'company_id', 'account_name', 'account_number', 'bank_name', 'ifsc_code', 'account_type', 'gl_account_id', 'opening_balance', 'is_active', 'created_at', 'updated_at'];
}

class Voucher {
  static tableName = 'vouchers';
  static fields = ['id', 'company_id', 'voucher_number', 'voucher_type', 'financial_year_id', 'voucher_date', 'reference_number', 'description', 'contact_id', 'organization_id', 'deal_id', 'bill_id', 'currency', 'exchange_rate', 'status', 'created_by', 'created_at', 'updated_at', 'posted_at', 'posted_by'];
}

class JournalEntry {
  static tableName = 'journal_entries';
  static fields = ['id', 'company_id', 'voucher_id', 'entry_number', 'entry_date', 'description', 'currency', 'exchange_rate', 'total_debit', 'total_credit', 'status', 'created_by', 'created_at', 'updated_at', 'posted_at', 'posted_by'];
}

class JournalLine {
  static tableName = 'journal_entry_lines';
  static fields = ['id', 'company_id', 'journal_entry_id', 'account_id', 'cost_centre_id', 'cost_category_id', 'debit_amount', 'credit_amount', 'description', 'reference_id', 'created_at'];
}

class Bill {
  static tableName = 'bills';
  static fields = ['id', 'company_id', 'bill_number', 'bill_type', 'contact_id', 'organization_id', 'deal_id', 'currency', 'status', 'issue_date', 'due_date', 'subtotal', 'tax', 'discount', 'total', 'paid_amount', 'balance', 'reference_number', 'notes', 'terms', 'created_at', 'updated_at', 'created_by'];
}

class BillItem {
  static tableName = 'bill_items';
  static fields = ['id', 'company_id', 'bill_id', 'product_id', 'description', 'quantity', 'unit_price', 'tax_rate', 'discount', 'total', 'gl_account_id', 'created_at'];
}

class BillAllocation {
  static tableName = 'bill_allocations';
  static fields = ['id', 'company_id', 'bill_id', 'journal_entry_id', 'amount', 'allocation_date', 'created_at'];
}

class Receivable {
  static tableName = 'receivables';
  static fields = ['id', 'company_id', 'bill_id', 'contact_id', 'organization_id', 'deal_id', 'due_date', 'original_amount', 'paid_amount', 'outstanding_amount', 'currency', 'status', 'credit_limit', 'credit_period_days', 'payment_terms', 'days_overdue', 'created_at', 'updated_at'];
}

class Payable {
  static tableName = 'payables';
  static fields = ['id', 'company_id', 'bill_id', 'contact_id', 'organization_id', 'due_date', 'original_amount', 'paid_amount', 'outstanding_amount', 'currency', 'status', 'days_overdue', 'created_at', 'updated_at'];
}

class CreditRule {
  static tableName = 'credit_rules';
  static fields = ['id', 'company_id', 'contact_id', 'credit_limit', 'credit_period_days', 'payment_terms', 'is_active', 'created_at', 'updated_at'];
}

class InterestConfig {
  static tableName = 'interest_configs';
  static fields = ['id', 'company_id', 'name', 'interest_rate', 'calculation_method', 'grace_period_days', 'is_compound', 'is_active', 'created_at', 'updated_at'];
}

class InterestCalculation {
  static tableName = 'interest_calculations';
  static fields = ['id', 'company_id', 'config_id', 'receivable_id', 'payable_id', 'principal_amount', 'interest_rate', 'interest_days', 'interest_amount', 'calculated_date', 'is_posted', 'journal_entry_id', 'created_at'];
}

class Budget {
  static tableName = 'budgets';
  static fields = ['id', 'company_id', 'name', 'financial_year_id', 'budget_type', 'is_active', 'created_at', 'updated_at'];
}

class BudgetLine {
  static tableName = 'budget_lines';
  static fields = ['id', 'company_id', 'budget_id', 'account_id', 'cost_centre_id', 'period', 'period_start', 'period_end', 'budget_amount', 'actual_amount', 'variance', 'variance_percentage', 'created_at', 'updated_at'];
}

class AccountingAudit {
  static tableName = 'accounting_audit';
  static fields = ['id', 'company_id', 'user_id', 'action', 'entity_type', 'entity_id', 'old_values_json', 'new_values_json', 'ip_address', 'user_agent', 'session_id', 'created_at'];
}

module.exports = {
  AccountGroup, Account, FinancialYear, CostCentre, CostCategory, BankAccount,
  Voucher, JournalEntry, JournalLine, Bill, BillItem, BillAllocation,
  Receivable, Payable, CreditRule, InterestConfig, InterestCalculation,
  Budget, BudgetLine, AccountingAudit
};
