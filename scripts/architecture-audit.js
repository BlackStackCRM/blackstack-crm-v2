/**
 * READ-ONLY architecture audit of the live BlackStack CRM database.
 *
 * Opens the database read-only and reports the real structure. Never writes,
 * never migrates, never deletes. Safe to run at any time.
 *
 *   node scripts/architecture-audit.js
 *   node scripts/architecture-audit.js --json > audit.json
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(ROOT, 'data', 'blackstack-crm.db');

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found: ${DB_PATH}`);
  process.exit(1);
}

// Open read-only: the OS enforces that nothing here can modify the file.
const db = new DatabaseSync(DB_PATH, { readOnly: true });

const q = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch (e) { return [{ __err: e.message }]; } };
const one = (sql, ...p) => { try { return db.prepare(sql).get(...p); } catch (e) { return { __err: e.message }; } };

const out = {
  meta: {},
  integrity: {},
  counts: {},
  migrations: [],
  domains: {},
  foreignKeys: [],
  fkViolations: [],
  stockLedger: {},
  stockBalance: {},
  duplicates: {},
  integrityFindings: [],
};

const stat = fs.statSync(DB_PATH);
out.meta = {
  databasePath: DB_PATH,
  sizeBytes: stat.size,
  sizeMB: +(stat.size / 1024 / 1024).toFixed(2),
  sqliteVersion: one('SELECT sqlite_version() AS v').v,
  journalMode: one('PRAGMA journal_mode').journal_mode,
  foreignKeysEnabled: one('PRAGMA foreign_keys').foreign_keys,
  modified: stat.mtime.toISOString(),
};

// ── 1. STRUCTURE ────────────────────────────────────────────────────────
const tables = q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
const indexes = q("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name");
const triggers = q("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name");
const views = q("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name");

out.meta.tableCount = tables.length;
out.meta.indexCount = indexes.length;
out.meta.triggerCount = triggers.length;
out.meta.viewCount = views.length;
out.meta.tables = tables;
out.meta.views = views.map((v) => v.name);
out.meta.triggers = triggers.map((t) => t.name);

// Row counts for every table.
for (const t of tables) {
  const r = one(`SELECT COUNT(*) AS n FROM "${t}"`);
  out.counts[t] = r.__err ? `ERR(${r.__err})` : Number(r.n);
}

// ── 2. INTEGRITY ────────────────────────────────────────────────────────
out.integrity.integrityCheck = one('PRAGMA integrity_check');
out.integrity.quickCheck = one('PRAGMA quick_check');
out.integrity.foreignKeyCheck = q('PRAGMA foreign_key_check');
out.integrity.fkViolationCount = out.integrity.foreignKeyCheck.length;

// ── 3. MIGRATIONS ───────────────────────────────────────────────────────
out.migrations = q('SELECT version, name, sha256, applied_at FROM schema_migrations ORDER BY version');
out.meta.maxMigrationVersion = one('SELECT MAX(version) AS v FROM schema_migrations').v;

// ── 4. FOREIGN KEYS (full inventory) ────────────────────────────────────
const fkRows = [];
for (const t of tables) {
  for (const f of q(`PRAGMA foreign_key_list("${t}")`)) {
    fkRows.push({
      fromTable: t, fromColumn: f.from,
      targetTable: f.table, targetColumn: f.to,
      onUpdate: f.on_update, onDelete: f.on_delete,
    });
  }
}
out.foreignKeys = fkRows;
out.meta.foreignKeyCount = fkRows.length;

// FKs grouped by target, to spot competing references.
const byTarget = {};
for (const f of fkRows) {
  (byTarget[f.targetTable] = byTarget[f.targetTable] || []).push(`${f.fromTable}.${f.fromColumn}`);
}

// ── 5. DOMAIN GROUPING ──────────────────────────────────────────────────
const DOMAINS = {
  'CRM / Contacts': ['contacts', 'contact_tags', 'lead_sources', 'customers', 'organizations', 'organization_contacts'],
  'CRM / Pipeline': ['leads', 'deals', 'pipelines', 'pipeline_stages', 'activities', 'appointments'],
  'CRM / Tasks & Notes': ['tasks', 'notes', 'relationships', 'workflow_definitions', 'workflow_nodes',
    'workflow_instances', 'workflow_executions'],
  'Inventory / Product Master': ['products', 'stock_items', 'models', 'brands', 'stock_categories',
    'stock_groups', 'product_specifications', 'specification_templates', 'specification_attributes',
    'colours', 'sizes', 'styles', 'select_options'],
  'Inventory / Units & Pricing': ['units_of_measure', 'uoms', 'alternate_units', 'compound_units',
    'item_prices', 'price_levels', 'rate'],
  'Inventory / Locations': ['locations', 'inv_locations', 'godowns'],
  'Inventory / Tracking': ['batches', 'item_serials', 'batch_wise_stock'],
  'Inventory / Transactions': ['inventory_voucher_headers', 'inventory_voucher_lines', 'stock_ledger',
    'physical_stock_documents', 'physical_stock_lines', 'adjustment_reasons', 'stock_adjustment_reasons'],
  'Inventory / Balances & Valuation': ['stock_balances', 'inventory_items', 'inventory_movements',
    'valuation_movements'],
  'Billing / Bills': ['bills', 'bill_items', 'bill_allocations', 'bill_approvals', 'bill_events',
    'bill_templates', 'recurring_bills', 'recurring_generation_log'],
  'Billing / Payments': ['payments', 'payment_plans', 'payment_plan_installments', 'payment_reconciliations',
    'payment_reminders'],
  'Billing / Collections': ['collection_assignments', 'collection_activities', 'collection_actions',
    'collection_action_logs', 'collection_escalations', 'collection_risk_scores', 'collection_rules',
    'credit_rules', 'promises_to_pay', 'customer_disputes', 'customer_bill_disputes',
    'customer_bill_audit_log', 'customer_bill_writeoffs', 'promises_to_pay'],
  'Billing / Legacy': ['invoices', 'invoice_line_items'],
  'Accounting / Core': ['journal_entries', 'journal_entry_lines', 'accounts', 'account_groups',
    'account_types', 'opening_balances', 'opening_balance_lines'],
  'Accounting / Receivables': ['receivables', 'receivable_allocations', 'receivable_summary',
    'ar_reconciliation_log', 'customer_advances'],
  'Accounting / Payables': ['payables', 'payable_allocations', 'ap_reconciliation_log'],
  'Accounting / Vouchers': ['vouchers', 'receipt_voucher_lines', 'payment_voucher_lines',
    'contra_voucher_lines', 'sales_voucher_lines', 'purchase_voucher_lines', 'expense_voucher_lines',
    'credit_note_lines', 'debit_note_lines'],
  'Accounting / Tax': ['tax_masters', 'tax_components', 'tax_types', 'tax_account_mappings',
    'company_tax_configs', 'transaction_tax_details', 'tax_audit_log'],
  'Accounting / Banking & Budget': ['bank_accounts', 'bank_reconciliations', 'bank_reconciliation_items',
    'budgets', 'budget_lines', 'cost_centres', 'cost_categories', 'interest_configs', 'interest_rules',
    'interest_charges', 'interest_calculations', 'year_end_closings'],
  'Accounting / Collections & Bad Debt': ['bad_debt_cases', 'customer_advances'],
  'System': ['companies', 'users', 'roles', 'permissions', 'role_permissions', 'user_roles',
    'audit_logs', 'currencies', 'financial_years', 'number_sequences', 'system_metadata',
    'schema_migrations', 'database_health_logs', 'legacy_tables', 'security_events',
    'login_attempts', 'sessions', 'migrations_applied', '_payments_backup'],
};

for (const [domain, members] of Object.entries(DOMAINS)) {
  out.domains[domain] = members.filter((m) => tables.includes(m));
}
const claimed = new Set(Object.values(out.domains).flat());
out.meta.ungroupedTables = tables.filter((t) => !claimed.has(t));

// ── 6. DUPLICATE / LEGACY SYSTEMS ────────────────────────────────────────
function tableInfo(t) {
  const cols = q(`PRAGMA table_info("${t}")`).map((c) => c.name);
  const n = out.counts[t];
  return { exists: tables.includes(t), rows: n, columns: cols };
}
const DUP_PAIRS = [
  ['locations', 'inv_locations', 'Location master'],
  ['units_of_measure', 'uoms', 'Unit of measure master'],
  ['stock_ledger', 'inventory_movements', 'Inventory movement history'],
  ['stock_balances', 'inventory_items', 'Inventory balance'],
  ['stock_balances', 'batch_wise_stock', 'Batch-level balance'],
  ['adjustment_reasons', 'stock_adjustment_reasons', 'Adjustment reason master'],
  ['bills', 'invoices', 'Sales document'],
];
out.duplicates = DUP_PAIRS.map(([a, b, role]) => ({
  role,
  a: tableInfo(a),
  b: tableInfo(b),
  fksToA: byTarget[a] || [],
  fksToB: byTarget[b] || [],
}));

// ── 7. STOCK LEDGER ─────────────────────────────────────────────────────
out.stockLedger = {
  totalRows: out.counts.stock_ledger || 0,
  byVoucherType: q('SELECT voucher_type, COUNT(*) AS rows, COALESCE(SUM(quantity),0) AS qty FROM stock_ledger GROUP BY voucher_type ORDER BY voucher_type'),
  bySourceDocument: q(`SELECT COALESCE(source_document_type,'(none)') AS src, COUNT(*) AS rows
                        FROM stock_ledger GROUP BY src ORDER BY src`),
  columns: q('PRAGMA table_info(stock_ledger)').map((c) => c.name),
  headerVoucherTypes: q('SELECT DISTINCT voucher_type FROM inventory_voucher_headers ORDER BY voucher_type').map((r) => r.voucher_type),
  headerStatuses: q('SELECT DISTINCT status FROM inventory_voucher_headers ORDER BY status').map((r) => r.status),
};

// ── 8. STOCK BALANCE vs LEDGER (independent recomputation) ──────────────
out.stockBalance = {
  totalRows: out.counts.stock_balances || 0,
  // Rows where the stored balance disagrees with an independent ledger sum.
  mismatches: q(`
    SELECT sb.id, sb.company_id, sb.item_id, sb.batch_id, sb.godown_id, sb.location_id,
           sb.quantity AS balance_qty,
           COALESCE(lg.ledger_qty, 0) AS ledger_qty,
           COALESCE(sb.quantity,0) - COALESCE(lg.ledger_qty,0) AS diff
      FROM stock_balances sb
      LEFT JOIN (
            SELECT company_id, item_id, batch_id, godown_id, location_id,
                   SUM(quantity) AS ledger_qty
              FROM stock_ledger
             GROUP BY company_id, item_id, batch_id, godown_id, location_id
      ) lg
        ON  lg.company_id  = sb.company_id
        AND lg.item_id     = sb.item_id
        AND lg.batch_id   IS sb.batch_id
        AND lg.godown_id   = sb.godown_id
        AND lg.location_id IS sb.location_id
     WHERE ABS(COALESCE(sb.quantity,0) - COALESCE(lg.ledger_qty,0)) > 0.000001
     ORDER BY sb.item_id`),
  // Balance rows with no ledger backing at all.
  orphanBalances: q(`
    SELECT sb.id, sb.item_id, sb.godown_id, sb.location_id, sb.quantity
      FROM stock_balances sb
      LEFT JOIN (
            SELECT company_id, item_id, batch_id, godown_id, location_id,
                   SUM(quantity) AS ledger_qty
              FROM stock_ledger
             GROUP BY company_id, item_id, batch_id, godown_id, location_id
      ) lg
        ON  lg.company_id  = sb.company_id
        AND lg.item_id     = sb.item_id
        AND lg.batch_id   IS sb.batch_id
        AND lg.godown_id   = sb.godown_id
        AND lg.location_id IS sb.location_id
     WHERE COALESCE(lg.ledger_qty, 0) = 0
       AND COALESCE(sb.quantity, 0) != 0`),
  totals: {
    ledgerQty: one('SELECT COALESCE(SUM(quantity),0) AS q FROM stock_ledger').q,
    balanceQty: one('SELECT COALESCE(SUM(quantity),0) AS q FROM stock_balances').q,
  },
};

// ── 9. INTEGRITY FINDINGS ───────────────────────────────────────────────
const findings = [];
const add = (severity, area, detail, extra = {}) =>
  findings.push({ severity, area, detail, ...extra });

if (out.integrity.integrityCheck.integrity_check !== 'ok') {
  add('CRITICAL', 'Integrity', `PRAGMA integrity_check returned: ${JSON.stringify(out.integrity.integrityCheck)}`);
}
if (out.integrity.fkViolationCount > 0) {
  add('CRITICAL', 'Integrity', `${out.integrity.fkViolationCount} foreign key violation(s)`,
    { violations: out.integrity.foreignKeyCheck.slice(0, 20) });
}
if (out.stockBalance.mismatches.length > 0) {
  add('HIGH', 'Stock balance', `${out.stockBalance.mismatches.length} balance row(s) disagree with the ledger`,
    { rows: out.stockBalance.mismatches.slice(0, 20) });
}
if (out.stockBalance.orphanBalances.length > 0) {
  add('HIGH', 'Stock balance', `${out.stockBalance.orphanBalances.length} balance row(s) with no ledger backing`,
    { rows: out.stockBalance.orphanBalances.slice(0, 20) });
}

// Negative stock where it should be impossible.
const negBal = q('SELECT item_id, godown_id, location_id, quantity FROM stock_balances WHERE quantity < 0');
if (negBal.length) add('HIGH', 'Stock balance', `${negBal.length} negative balance row(s)`, { rows: negBal });

// Serials in an impossible state.
const badSerials = q(`SELECT id, serial_number, status FROM item_serials
                       WHERE status NOT IN ('in_transit','available','sold','returned','damaged','scrapped','expired')`);
if (badSerials.length) add('MEDIUM', 'Serial', `${badSerials.length} serial(s) with an invalid status`, { rows: badSerials });

// Godown/location disagreement on a balance row.
const gdMismatch = q(`
  SELECT sb.id, sb.item_id, sb.godown_id, sb.location_id, g.location_id AS godown_location
    FROM stock_balances sb
    JOIN godowns g ON g.id = sb.godown_id
   WHERE sb.location_id IS NOT NULL AND g.location_id IS NOT NULL
     AND sb.location_id <> g.location_id`);
if (gdMismatch.length) {
  add('HIGH', 'Location/Godown', `${gdMismatch.length} balance row(s) pair a godown with a location that godown does not belong to`,
    { rows: gdMismatch });
}

// Products with an inventory flag but no stock item, and vice versa.
const flagNoItem = q(`
  SELECT p.id, p.name FROM products p
   WHERE p.is_inventory_managed = 1
     AND NOT EXISTS (SELECT 1 FROM stock_items si WHERE si.product_id = p.id AND si.company_id = p.company_id)`);
if (flagNoItem.length) {
  add('HIGH', 'Inventory linkage', `${flagNoItem.length} product(s) flagged is_inventory_managed with no stock_items row`,
    { rows: flagNoItem });
}
const itemNoFlag = q(`
  SELECT si.id, si.sku FROM stock_items si
    JOIN products p ON p.id = si.product_id
   WHERE COALESCE(p.is_inventory_managed, 0) = 0`);
if (itemNoFlag.length) {
  add('MEDIUM', 'Inventory linkage', `${itemNoFlag.length} stock item(s) belong to a product not flagged is_inventory_managed`,
    { rows: itemNoFlag });
}

// Duplicate business keys that should be unique.
const dupSku = q(`SELECT sku, COUNT(*) n FROM stock_items WHERE sku IS NOT NULL GROUP BY sku HAVING n > 1`);
if (dupSku.length) add('HIGH', 'Data quality', `${dupSku.length} duplicate stock_items.sku value(s)`, { rows: dupSku });

const dupBatch = q(`SELECT item_id, batch_number, COUNT(*) n FROM batches GROUP BY item_id, batch_number HAVING n > 1`);
if (dupBatch.length) add('HIGH', 'Batch', `${dupBatch.length} duplicate batch number(s) per item`, { rows: dupBatch });

const dupSerial = q(`SELECT serial_number, COUNT(*) n FROM item_serials GROUP BY serial_number HAVING n > 1`);
if (dupSerial.length) add('HIGH', 'Serial', `${dupSerial.length} duplicate serial number(s)`, { rows: dupSerial });

// Bills posted with no inventory voucher despite carrying stock items.
const postedNoStock = q(`
  SELECT b.id, b.bill_number, b.status,
         (SELECT COUNT(*) FROM bill_items bi WHERE bi.bill_id = b.id) AS lines
    FROM bills b
   WHERE b.status IN ('POSTED','PARTIALLY_PAID','PAID','OVERDUE')
     AND b.inventory_voucher_header_id IS NULL
     AND EXISTS (SELECT 1 FROM bill_items bi
                  JOIN stock_items si ON si.product_id = bi.product_id
                 WHERE bi.bill_id = b.id AND si.is_active = 1)`);
if (postedNoStock.length) {
  add('CRITICAL', 'Bill → Inventory',
    `${postedNoStock.length} posted bill(s) with inventory-managed lines but no inventory voucher`,
    { rows: postedNoStock });
}

// Bill items whose stock_item_id does not resolve.
const badItemLink = q(`
  SELECT bi.id, bi.bill_id, bi.stock_item_id FROM bill_items bi
   WHERE bi.stock_item_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM stock_items si WHERE si.id = bi.stock_item_id)`);
if (badItemLink.length) {
  add('HIGH', 'Bill → Inventory', `${badItemLink.length} bill_items row(s) reference a missing stock_item`, { rows: badItemLink });
}

out.integrityFindings = findings;

// ── OUTPUT ───────────────────────────────────────────────────────────────
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('='.repeat(72));
  console.log('BLACKSTACK CRM V2 — READ-ONLY DATABASE ARCHITECTURE AUDIT');
  console.log('='.repeat(72));
  console.log(`database : ${out.meta.databasePath}`);
  console.log(`size     : ${out.meta.sizeMB} MB (${out.meta.sizeBytes} bytes)`);
  console.log(`sqlite   : ${out.meta.sqliteVersion}   journal_mode=${out.meta.journalMode}  foreign_keys=${out.meta.foreignKeysEnabled}`);
  console.log(`modified : ${out.meta.modified}`);
  console.log(`tables=${out.meta.tableCount}  indexes=${out.meta.indexCount}  triggers=${out.meta.triggerCount}  views=${out.meta.viewCount}  FKs=${out.meta.foreignKeyCount}`);
  console.log(`migrations: ${out.migrations.length} recorded, max version ${out.meta.maxMigrationVersion}`);
  console.log();
  console.log('--- INTEGRITY ---');
  console.log('  integrity_check :', JSON.stringify(out.integrity.integrityCheck));
  console.log('  foreign_key_check violations:', out.integrity.fkViolationCount);
  console.log();
  console.log('--- STOCK LEDGER ---');
  console.log('  rows:', out.stockLedger.totalRows);
  out.stockLedger.byVoucherType.forEach((r) => console.log(`    ${r.voucher_type}: ${r.rows} row(s), qty ${r.qty}`));
  console.log('  by source document:');
  out.stockLedger.bySourceDocument.forEach((r) => console.log(`    ${r.src}: ${r.rows} row(s)`));
  console.log();
  console.log('--- STOCK BALANCE vs LEDGER ---');
  console.log('  balance rows:', out.stockBalance.totalRows);
  console.log('  mismatches  :', out.stockBalance.mismatches.length);
  console.log('  orphans     :', out.stockBalance.orphanBalances.length);
  console.log('  totals: ledger qty =', out.stockBalance.totals.ledgerQty, '| balance qty =', out.stockBalance.totals.balanceQty);
  console.log();
  console.log('--- FINDINGS ---');
  if (!out.integrityFindings.length) console.log('  none');
  out.integrityFindings.forEach((f) => console.log(`  [${f.severity}] ${f.area}: ${f.detail}`));
  console.log();
  console.log('--- TABLES BY DOMAIN ---');
  for (const [d, members] of Object.entries(out.domains)) {
    if (members.length) console.log(`  ${d} (${members.length}): ${members.join(', ')}`);
  }
  if (out.meta.ungroupedTables.length) {
    console.log(`  UNGROUPED (${out.meta.ungroupedTables.length}): ${out.meta.ungroupedTables.join(', ')}`);
  }
}

db.close();