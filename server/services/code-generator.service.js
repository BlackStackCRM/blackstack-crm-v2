/**
 * Centralized, concurrency-safe code/number generation service (CRM-wide).
 *
 * Design:
 *  - Backed by the `number_sequences` table: one counter row per
 *    (company_id, entity_type, scope) with an atomic UPDATE inside a
 *    transaction. SQLite is single-writer, so the transaction guarantees
 *    no two callers can ever receive the same counter value.
 *  - The counter only ever moves FORWARD, so codes of deleted records are
 *    never reused.
 *  - When a sequence row does not yet exist it is seeded from the highest
 *    existing code in the target table, so legacy numbering is respected
 *    and existing codes are never regenerated.
 *  - A UNIQUE(company_id, code) style constraint on the target table plus a
 *    retry loop is the final backstop against race conditions and legacy
 *    codes that collide with the generated pattern.
 *
 * Usage:
 *   const CodeGenerator = require('./code-generator.service');
 *   CodeGenerator.generate(conn, 'ACCOUNT_GROUP', companyId);
 *   CodeGenerator.preview(conn, 'ACCOUNT_GROUP', companyId); // no consume
 */
class CodeGeneratorError extends Error {
  constructor(message = 'Unable to generate a unique code. Please try again.') {
    super(message);
    this.name = 'CodeGeneratorError';
    this.status = 500;
  }
}

/** Entity registry: entity type -> prefix + target table/column for seeding & collision checks. */
const ENTITIES = {
  ACCOUNT_GROUP: { prefix: 'AG', padding: 5, table: 'account_groups', column: 'code' },
  LEDGER_ACCOUNT: { prefix: 'AC', padding: 5, table: 'accounts', column: 'code' },
  COST_CENTRE: { prefix: 'CC', padding: 4, table: 'cost_centres', column: 'code' },
  COST_CATEGORY: { prefix: 'CCAT', padding: 4, table: 'cost_categories', column: 'code' },
  // Company-scoped financial documents (company_id present)
  VOUCHER_JOURNAL: { prefix: 'JV', padding: 4, table: 'vouchers', column: 'voucher_number', yearScoped: true },
  VOUCHER_PAYMENT: { prefix: 'PY', padding: 4, table: 'vouchers', column: 'voucher_number', yearScoped: true },
  VOUCHER_RECEIPT: { prefix: 'RC', padding: 4, table: 'vouchers', column: 'voucher_number', yearScoped: true },
  VOUCHER_CONTRA: { prefix: 'CT', padding: 4, table: 'vouchers', column: 'voucher_number', yearScoped: true },
  VOUCHER_CREDIT_NOTE: { prefix: 'CN', padding: 4, table: 'vouchers', column: 'voucher_number', yearScoped: true },
  VOUCHER_DEBIT_NOTE: { prefix: 'DN', padding: 4, table: 'vouchers', column: 'voucher_number', yearScoped: true },
  VOUCHER_SALES: { prefix: 'SV', padding: 4, table: 'vouchers', column: 'voucher_number', yearScoped: true },
  VOUCHER_PURCHASE: { prefix: 'PUR', padding: 4, table: 'vouchers', column: 'voucher_number', yearScoped: true },
  VOUCHER_EXPENSE: { prefix: 'EXP', padding: 4, table: 'vouchers', column: 'voucher_number', yearScoped: true },
  // Legacy invoices table has no company_id — global scope is intentional here.
  // Company-scoped financial documents (company_id present)
  INVOICE: { prefix: 'INV', padding: 5, table: 'invoices', column: 'invoice_number', companyScoped: false },
  CUSTOMER_BILL: { prefix: 'BILL', padding: 5, table: 'bills', column: 'bill_number', yearScoped: true },
  CREDIT_NOTE: { prefix: 'CN', padding: 5, table: 'vouchers', column: 'voucher_number', yearScoped: true },
  DEBIT_NOTE: { prefix: 'DN', padding: 5, table: 'vouchers', column: 'voucher_number', yearScoped: true },
  CUSTOMER_RECEIPT: { prefix: 'RCPT', padding: 5, table: 'vouchers', column: 'voucher_number', yearScoped: true },
  CUSTOMER_ADVANCE: { prefix: 'ADV', padding: 5, table: 'customer_advances', column: 'reference_number', yearScoped: true },
  // Inventory vouchers (company-scoped, year-scoped)
  INVENTORY_VOUCHER: { prefix: 'INV', padding: 5, table: 'inventory_voucher_headers', column: 'voucher_number', yearScoped: true, scopeSuffix: true },
};

const MAX_ATTEMPTS = 6;

function ensureTable(conn) {
  conn.run(`
    CREATE TABLE IF NOT EXISTS number_sequences (
      company_id TEXT NOT NULL DEFAULT 'default',
      entity_type TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT '',
      next_seq INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT,
      PRIMARY KEY (company_id, entity_type, scope)
    )
  `);
}

function formatCode(prefix, seq, padding, year) {
  return year ? `${prefix}-${year}-${String(seq).padStart(padding, '0')}` : `${prefix}-${String(seq).padStart(padding, '0')}`;
}

/**
 * Build a human-readable voucher type abbreviation from a long voucher type.
 * e.g. 'stock_inward' -> 'INWD', 'opening_stock' -> 'OPEN'
 */
function voucherTypeAbbrev(voucherType) {
  const map = {
    'opening_stock': 'OPEN',
    'stock_inward':  'INWD',
    'stock_outward': 'OUTW',
    'stock_transfer':'XFER',
    'stock_adjustment':'ADJ',
    'physical_stock':'PHYS',
    'stock_journal':'JRN',
  };
  return map[voucherType] || voucherType.substring(0, 4).toUpperCase();
}

/** Highest trailing number among existing codes that match the generated pattern. */
function seedFromExisting(conn, entity, companyId, scope = null) {
  const col = entity.column;
  const table = entity.table;
  const esc = entity.prefix.replace(/[%_]/g, (m) => '\\' + m);
  let sql, params;
  if (entity.companyScoped === false) {
    sql = `SELECT ${col} AS code FROM ${table} WHERE ${col} LIKE ? ESCAPE '\\' ORDER BY ${col} DESC LIMIT 500`;
    params = [`${esc}-%`];
  } else {
    sql = `SELECT ${col} AS code FROM ${table} WHERE ${col} LIKE ? ESCAPE '\\' AND company_id = ? ORDER BY ${col} DESC LIMIT 500`;
    params = [`${esc}-%`, companyId];
  }
  let max = 0;
  const prefixRe = entity.yearScoped
    ? new RegExp(`^${entity.prefix}-\\d{4}-(\\d+)(_REV)?$`)
    : new RegExp(`^${entity.prefix}-(\\d+)$`);
  for (const row of conn.all(sql, ...params)) {
    const m = String(row.code || '').match(prefixRe);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

function codeExists(conn, entity, companyId, code) {
  if (entity.companyScoped === false) {
    return !!conn.get(`SELECT 1 FROM ${entity.table} WHERE ${entity.column} = ? LIMIT 1`, [code]);
  }
  return !!conn.get(`SELECT 1 FROM ${entity.table} WHERE ${entity.column} = ? AND company_id = ? LIMIT 1`, [code, companyId]);
}

/**
 * Generate the next code. Runs in a transaction; atomic counter + collision
 * retry + unique constraint backstop. Throws CodeGeneratorError if a unique
 * code cannot be produced.
 */
function generate(conn, entityType, companyId = 'default', scopeSuffix = null) {
  const entity = ENTITIES[entityType];
  if (!entity) throw new CodeGeneratorError(`Unknown entity type: ${entityType}`);
  ensureTable(conn);
  const year = entity.yearScoped ? String(new Date().getFullYear()) : null;
  // When scopeSuffix is provided and entity supports it, use TYPE-YEAR as scope
  // e.g., scope = "INWD-2026" for stock inward vouchers
  let scope;
  if (entity.scopeSuffix && scopeSuffix && year) {
    scope = `${scopeSuffix}-${year}`;
  } else {
    scope = year || '';
  }

  return conn.transaction(() => {
    // Seed once from legacy data so existing numbering is respected.
    const existing = conn.get(
      'SELECT next_seq FROM number_sequences WHERE company_id = ? AND entity_type = ? AND scope = ?',
      [companyId, entityType, scope]
    );
    if (!existing) {
      const seed = seedFromExisting(conn, entity, companyId, scope) + 1;
      conn.run(
        `INSERT INTO number_sequences (company_id, entity_type, scope, next_seq, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(company_id, entity_type, scope) DO UPDATE SET next_seq = excluded.next_seq`,
        [companyId, entityType, scope, seed]
      );
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // Atomic increment: single writer, so no other caller can read the
      // same value between UPDATE and SELECT inside this transaction.
      conn.run(
        `UPDATE number_sequences SET next_seq = next_seq + 1, updated_at = datetime('now')
         WHERE company_id = ? AND entity_type = ? AND scope = ?`,
        [companyId, entityType, scope]
      );
      const row = conn.get(
        'SELECT next_seq FROM number_sequences WHERE company_id = ? AND entity_type = ? AND scope = ?',
        [companyId, entityType, scope]
      );
      const seq = (row ? row.next_seq : 1) - 1; // value we just consumed
      const code = entity.scopeSuffix && scopeSuffix && year
        ? `${entity.prefix}/${scopeSuffix}/${year}/${String(seq).padStart(entity.padding, '0')}`
        : formatCode(entity.prefix, seq, entity.padding, year);
      if (!codeExists(conn, entity, companyId, code)) return code;
      // Collision with a legacy/hand-created code — keep moving forward.
    }
    throw new CodeGeneratorError();
  })();
}

/** Peek at the next code without consuming it (for UI preview). */
function preview(conn, entityType, companyId = 'default', scopeSuffix = null) {
  const entity = ENTITIES[entityType];
  if (!entity) throw new CodeGeneratorError(`Unknown entity type: ${entityType}`);
  ensureTable(conn);
  const year = entity.yearScoped ? String(new Date().getFullYear()) : null;
  let scope;
  if (entity.scopeSuffix && scopeSuffix && year) {
    scope = `${scopeSuffix}-${year}`;
  } else {
    scope = year || '';
  }
  const row = conn.get(
    'SELECT next_seq FROM number_sequences WHERE company_id = ? AND entity_type = ? AND scope = ?',
    [companyId, entityType, scope]
  );
  let seq = row ? row.next_seq : 0;
  if (!row) seq = seedFromExisting(conn, entity, companyId, scope) + 1;
  const prefix = entity.prefix;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    let code;
    if (entity.scopeSuffix && scopeSuffix && year) {
      code = `${prefix}/${scopeSuffix}/${year}/${String(seq + i).padStart(entity.padding, '0')}`;
    } else {
      code = formatCode(prefix, seq + i, entity.padding, year);
    }
    if (!codeExists(conn, entity, companyId, code)) return code;
  }
  throw new CodeGeneratorError();
}

// Expose for inventory service
module.exports = { generate, preview, ENTITIES, CodeGeneratorError, voucherTypeAbbrev };
