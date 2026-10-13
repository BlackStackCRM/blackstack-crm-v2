/**
 * LEGACY COMPATIBILITY SHIM
 * 
 * The Invoicing & Billing module has been upgraded to the new Accounting & Finance
 * system. This page now delegates to the bills module for a unified experience.
 * 
 * Invoice functionality has been replaced by:
 * - Customer Bills: /accounting/bills  (Sales Invoices)
 * - Purchase Invoices: /accounting/payables  (Supplier Invoices)
 * - Payments: /accounting/payments
 * - Receivables: /accounting/receivables
 * - Payables: /accounting/payables
 * 
 * Old invoice data is preserved via migration (see 025_migrate_invoices_to_accounting.sql).
 */
window.PageModules.invoices = {
  async init() {
    // Redirect to the new Accounting & Finance bills page
    window.location.hash = '#accounting/bills';
    return () => {};
  }
};
