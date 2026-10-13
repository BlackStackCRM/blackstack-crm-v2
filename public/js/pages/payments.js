/**
 * LEGACY COMPATIBILITY SHIM
 *
 * The Payments module has been upgraded to the new Accounting & Finance system.
 * Payments are now recorded through the Accounting & Finance → Bills module.
 *
 * Old /payments endpoints have been replaced by:
 * - /accounting/payments (record payment against a bill)
 * - /accounting/receivables (view customer outstanding)
 * - /accounting/payables (view supplier outstanding)
 *
 * This shim redirects legacy payment links to the accounting bills page.
 */
window.PageModules.payments = {
  async init() {
    window.location.hash = '#accounting/receivables';
    return () => {};
  }
};
