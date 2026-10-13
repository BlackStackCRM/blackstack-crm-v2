const PERMISSIONS = new Set([
  'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.delete',
  'organizations.view', 'organizations.create', 'organizations.edit', 'organizations.delete',
  'deals.view', 'deals.create', 'deals.edit', 'deals.delete',
  'invoices.view', 'invoices.create', 'invoices.edit', 'invoices.delete',
  'payments.view', 'payments.create', 'payments.refund',
  'products.view', 'products.create', 'products.edit', 'products.delete',
  'tasks.view', 'tasks.create', 'tasks.edit', 'tasks.delete',
  'activities.view', 'activities.create',
  'workflows.view', 'workflows.manage',
  'reports.view', 'reports.export',
  'users.view', 'users.manage',
  'settings.manage',
  'audit.view',
  'database.view',
  // Accounting & Finance (Steps 5-8)
  'accounting.view', 'accounting.create', 'accounting.edit', 'accounting.cancel',
  'accounting.manage', 'accounting.post', 'accounting.reverse', 'accounting.override_locked',
  'coa.manage', 'budget.manage', 'finance.manage',
  // Tax / GST (Step 17)
  'tax.view', 'tax.create', 'tax.manage', 'tax.reports',
  // Customer Bills core (Steps 9-10)
  'customer_bills.view', 'customer_bills.create', 'customer_bills.edit', 'customer_bills.delete_draft',
  'customer_bills.approve', 'customer_bills.post', 'customer_bills.send', 'customer_bills.cancel',
  'customer_bills.record_payment', 'customer_bills.allocate', 'customer_bills.write_off',
  'customer_bills.manage_advance', 'customer_bills.reconcile',
  'customer_bills.view_aging', 'customer_bills.view_outstanding', 'customer_bills.view_statement',
  'customer_bills.view_reports', 'customer_bills.export', 'customer_bills.export_reports',
  // Credit / Debit Notes (Steps 11 & 13)
  'customer_bills.view_credit_note', 'customer_bills.create_credit_note', 'customer_bills.cancel_credit_note',
  'customer_bills.view_debit_note', 'customer_bills.create_debit_note', 'customer_bills.cancel_debit_note',
  // Collections (Steps 12 & 14)
  'customer_bills.manage_collections', 'customer_bills.assign_collection_owner',
  'customer_bills.manage_promises', 'customer_bills.manage_disputes', 'customer_bills.dispute',
  'customer_bills.view_collection_dashboard',
  'customer_bills.view_collections', 'customer_bills.manage_collection_rules',
  'customer_bills.execute_collection_actions', 'customer_bills.manage_payment_plans',
  'customer_bills.calculate_interest', 'customer_bills.approve_interest',
  'customer_bills.manage_bad_debt', 'customer_bills.approve_bad_debt',
  'customer_bills.view_collection_risk', 'customer_bills.manage_escalations',
  'customer_bills.export_collections',
  // Inventory Management
  'inventory.view', 'inventory.create', 'inventory.edit', 'inventory.delete',
  'inventory.post', 'inventory.cancel', 'inventory.approve', 'inventory.reports',
]);

class Authorizer {
  static assertPermission(context, permissionCode) {
    if (!context || !context.permissions) {
      throw new Error('Missing permissions context');
    }

    if (context.permissions.includes('*')) {
      return;
    }

    if (!context.permissions.includes(permissionCode)) {
      const error = new Error(`Permission denied: ${permissionCode}`);
      error.code = 'AUTHORIZATION_ERROR';
      error.status = 403;
      throw error;
    }
  }

  static hasPermission(context, permissionCode) {
    if (!context || !context.permissions) return false;
    if (context.permissions.includes('*')) return true;
    return context.permissions.includes(permissionCode);
  }

  static getAllPermissions() {
    return Array.from(PERMISSIONS);
  }
}

module.exports = { Authorizer };
