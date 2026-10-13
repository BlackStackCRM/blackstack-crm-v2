/**
 * PHASE 4 — Full-software E2E coverage manifest.
 *
 * THE SINGLE SOURCE OF TRUTH for what the default full-software suite covers.
 *
 * Every route here was READ OUT OF THE APPLICATION, not guessed from a menu
 * label:
 *
 *   public/js/app.js            -> the hash route table (`routes`)
 *   public/js/components/Sidebar.js -> the navigation entries
 *   public/js/pages/inventory.js     -> inventory dashboard card groups
 *   public/js/pages/inventory-sub.js -> which key renders which page class
 *
 * The runner consumes this to generate one test per module, so the coverage
 * matrix in the audit report cannot drift from what actually executes.
 *
 * NOTES ON RELATIONSHIPS FOUND DURING INSPECTION
 *
 *  - `accounting/reports` is a sidebar entry and resolves through
 *    `accountingSub`, while the top-level `#reports` resolves to the
 *    `accounting-reports` module. Both are tested; they are related but are NOT
 *    the same route, so neither is omitted.
 *  - `#invoices`, `#payments` and `#accounting/bills` all render the `accounting`
 *    or `bills` module. They are separate hash routes to the same page family and
 *    are all exercised.
 *  - Inventory has TWO distinct batch pages, not one:
 *      `batch_wise_stock`     -> ReportPage (Batch-wise Stock)
 *      `batch_wise_stock_mgmt`-> ReportPage (Batch Management Analytics)
 *    They are separate sidebar cards with separate labels and both are tested.
 *  - `products` appears as a sidebar parent AND as its own child entry; both
 *    point at `#products`.
 */

/** @typedef {{group:string,name:string,route:string,kind:string}} Module */

/** Top-level CRM + shell modules. */
const CRM_MODULES = [
  { group: 'A. Main CRM', name: 'Dashboard', route: 'dashboard', kind: 'crud' },
  { group: 'A. Main CRM', name: 'Leads', route: 'leads', kind: 'crud' },
  { group: 'A. Main CRM', name: 'Contacts', route: 'contacts', kind: 'crud' },
  { group: 'A. Main CRM', name: 'Organizations', route: 'organizations', kind: 'crud' },
  { group: 'A. Main CRM', name: 'Deals', route: 'deals', kind: 'crud' },
  { group: 'A. Main CRM', name: 'Tasks', route: 'tasks', kind: 'crud' },
  { group: 'A. Main CRM', name: 'Appointments', route: 'appointments', kind: 'crud' },
  { group: 'A. Main CRM', name: 'Action Center', route: 'action-center', kind: 'read' },
  { group: 'A. Main CRM', name: 'Customer Bills', route: 'customer-bills', kind: 'crud' },
  { group: 'A. Main CRM', name: 'Activities', route: 'activities', kind: 'read' },
  { group: 'A. Main CRM', name: 'Notes', route: 'notes', kind: 'crud' },
  { group: 'A. Main CRM', name: 'Search', route: 'search', kind: 'read' },
];

/** Accounting & Finance. */
const ACCOUNTING_MODULES = [
  { group: 'B. Accounting', name: 'Accounting & Finance', route: 'accounting', kind: 'crud' },
  { group: 'B. Accounting', name: 'Chart of Accounts', route: 'accounting/chart-of-accounts', kind: 'crud' },
  { group: 'B. Accounting', name: 'Journal', route: 'accounting/journal', kind: 'crud' },
  { group: 'B. Accounting', name: 'Bills', route: 'accounting/bills', kind: 'crud' },
  { group: 'B. Accounting', name: 'Accounts Receivable', route: 'accounting/receivables', kind: 'read' },
  { group: 'B. Accounting', name: 'Accounts Payable', route: 'accounting/payables', kind: 'read' },
  { group: 'B. Accounting', name: 'Outstanding Dashboard', route: 'accounting/outstanding', kind: 'read' },
  { group: 'B. Accounting', name: 'Ledger', route: 'accounting/ledger', kind: 'read' },
  { group: 'B. Accounting', name: 'Financial Reports', route: 'accounting/reports', kind: 'read' },
  { group: 'B. Accounting', name: 'Reports (top-level)', route: 'reports', kind: 'read' },
  { group: 'B. Accounting', name: 'Cost Centres', route: 'accounting/cost-centres', kind: 'crud' },
  { group: 'B. Accounting', name: 'Cost Categories', route: 'accounting/cost-categories', kind: 'crud' },
  { group: 'B. Accounting', name: 'Budgets', route: 'accounting/budgets', kind: 'crud' },
  { group: 'B. Accounting', name: 'Bank Accounts', route: 'accounting/bank-accounts', kind: 'crud' },
  { group: 'B. Accounting', name: 'Invoices', route: 'invoices', kind: 'read' },
  { group: 'B. Accounting', name: 'Payments', route: 'payments', kind: 'read' },
];

/**
 * Products + Inventory. Keys are the ones inventory-sub.js dispatches on; the
 * names are the sidebar/dashboard labels a user actually sees.
 */
const INVENTORY_MASTERS = [
  ['Stock Groups', 'stock_groups'],
  ['Stock Categories', 'stock_categories'],
  ['Brand', 'brands'],
  ['Model', 'models'],
  ['Stock Items', 'stock_items'],
  ['Alternate Units', 'alternate_units'],
  ['Units of Measure', 'units_of_measure'],
  ['Rate', 'rate'],
  ['Price Levels', 'price_levels'],
];
const INVENTORY_STORAGE = [
  ['Godowns', 'godowns'],
  ['Locations', 'locations'],
];
const INVENTORY_BATCH = [
  ['Batches', 'batches'],
  ['Batch-wise Stock', 'batch_wise_stock'],
  ['Batch Management Analytics', 'batch_wise_stock_mgmt'],
  ['Expiry Management Analytics', 'expiry_management'],
  ['Manufacturing Date Analytics', 'manufacturing_date'],
  ['Expiry Date Analytics', 'expiry_date'],
  ['Serial Number Tracking Analytics', 'serial_number_tracking'],
  ['Godown-wise Stock Analytics', 'godown_wise_stock'],
  ['Location-wise Stock Analytics', 'location_wise_stock'],
];
const INVENTORY_TX = [
  ['Opening Stock', 'opening_stock'],
  ['Stock Inward', 'stock_inward'],
  ['Stock Outward', 'stock_outward'],
  ['Stock Transfer', 'stock_transfer'],
  ['Stock Adjustment', 'stock_adjustment'],
  ['Physical Stock', 'physical_stock'],
  ['Stock Journal', 'stock_journal'],
];
const INVENTORY_REPORTS = [
  ['Stock Valuation Analytics', 'stock_valuation'],
];

const INVENTORY_MODULES = [
  ...INVENTORY_MASTERS.map(([name, key]) => ({ group: 'C. Inventory/Masters', name, route: `inventory/${key}`, kind: 'crud' })),
  ...INVENTORY_STORAGE.map(([name, key]) => ({ group: 'C. Inventory/Storage', name, route: `inventory/${key}`, kind: 'crud' })),
  ...INVENTORY_BATCH.map(([name, key]) => ({ group: 'C. Inventory/Batch', name, route: `inventory/${key}`, kind: 'read' })),
  ...INVENTORY_TX.map(([name, key]) => ({ group: 'C. Inventory/Transactions', name, route: `inventory/${key}`, kind: 'crud' })),
  ...INVENTORY_REPORTS.map(([name, key]) => ({ group: 'C. Inventory/Reports', name, route: `inventory/${key}`, kind: 'read' })),
  { group: 'C. Inventory', name: 'Products', route: 'products', kind: 'crud' },
  { group: 'C. Inventory', name: 'Inventory Dashboard', route: 'inventory', kind: 'read' },
];

/** Remaining application modules. */
const OTHER_MODULES = [
  { group: 'D. Other', name: 'Workflows', route: 'workflows', kind: 'crud' },
  { group: 'D. Other', name: 'Settings', route: 'settings', kind: 'crud' },
  { group: 'D. Other', name: 'Users', route: 'users', kind: 'crud' },
  { group: 'D. Other', name: 'Profile', route: 'profile', kind: 'read' },
];

const MODULES = [
  ...CRM_MODULES,
  ...ACCOUNTING_MODULES,
  ...INVENTORY_MODULES,
  ...OTHER_MODULES,
];

/**
 * Cross-module integration flows.
 *
 * Each names the business relationship it proves and the pages it touches. The
 * assertion is on PERSISTED state (via the API / database), not on a success
 * toast, because a toast proves nothing about whether the row was written.
 */
const INTEGRATION_FLOWS = [
  {
    name: 'CRM: Lead -> Contact -> Deal chain',
    touches: ['leads', 'contacts', 'deals'],
    proves: 'a contact and a deal can be linked to the same party with tenant scope intact',
  },
  {
    name: 'CRM: Task and Appointment attached to a Deal',
    touches: ['deals', 'tasks', 'appointments'],
    proves: 'child CRM records persist against a parent deal and are refused when the parent has dependents (CRM-04)',
  },
  {
    name: 'Inventory: Stock Group -> Category -> Brand -> Model -> Stock Item',
    touches: ['inventory/stock_groups', 'inventory/stock_categories', 'inventory/brands', 'inventory/models', 'inventory/stock_items'],
    proves: 'the product master hierarchy is enforced by the server, not just the UI',
  },
  {
    name: 'Inventory: Godown -> Location -> Stock transaction',
    touches: ['inventory/godowns', 'inventory/locations', 'inventory/stock_inward'],
    proves: 'a stock movement requires a valid godown/location and writes a ledger row',
  },
  {
    name: 'Inventory: Opening Stock -> Inward -> Stock reports',
    touches: ['inventory/opening_stock', 'inventory/stock_inward', 'inventory/stock_valuation'],
    proves: 'posted stock movements are visible to valuation, and stock_ledger reconciles',
  },
  {
    name: 'Accounting: Chart of Accounts -> Journal -> Ledger',
    touches: ['accounting/chart-of-accounts', 'accounting/journal', 'accounting/ledger'],
    proves: 'a balanced journal entry posts and appears in the general ledger',
  },
  {
    name: 'Accounting: Chart of Accounts -> Bills -> Receivables',
    touches: ['accounting/chart-of-accounts', 'customer-bills', 'accounting/receivables'],
    proves: 'a posted customer bill creates a receivable and its accounting entry',
  },
  {
    name: 'Permissions: server-side enforcement, not just hidden UI',
    touches: ['users', 'settings'],
    proves: 'a request without permission is rejected by the SERVER with 403',
  },
];

module.exports = {
  MODULES,
  INTEGRATION_FLOWS,
  CRM_MODULES,
  ACCOUNTING_MODULES,
  INVENTORY_MODULES,
  OTHER_MODULES,
};