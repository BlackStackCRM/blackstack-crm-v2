const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const PROJECT_ROOT = path.resolve(__dirname, "..");
process.chdir(PROJECT_ROOT);

// Create a temporary DB file path
const tmpDbPath = path.join(os.tmpdir(), `test_ob_${Date.now()}.db`);

// Patch the DB_PATH before any controller code is loaded
process.env.DB_PATH = tmpDbPath;

// Now require the modules — they will use our temp DB path
const { getConn } = require(path.join(PROJECT_ROOT, "server/utils/db.js"));
const conn = getConn();

// Set up schema (same as the real migration)
conn.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS account_groups (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL DEFAULT 'default',
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_id TEXT,
    type TEXT NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')),
    debit_credit_nature TEXT NOT NULL CHECK (debit_credit_nature IN ('DEBIT', 'CREDIT')),
    is_active INTEGER DEFAULT 1,
    allow_child_accounts INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL DEFAULT 'default',
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    account_group_id TEXT NOT NULL,
    type TEXT NOT NULL,
    debit_credit_nature TEXT NOT NULL,
    opening_balance REAL DEFAULT 0.0,
    opening_balance_type TEXT DEFAULT 'DEBIT',
    description TEXT,
    is_active INTEGER DEFAULT 1,
    parent_id TEXT,
    allow_direct_posting INTEGER DEFAULT 1,
    reconciliation_required INTEGER DEFAULT 0,
    opening_balance_date TEXT,
    is_group INTEGER DEFAULT 0,
    is_system INTEGER DEFAULT 0 NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS journal_entry_lines (
    id TEXT PRIMARY KEY,
    journal_entry_id TEXT,
    account_id TEXT,
    debit_amount REAL DEFAULT 0,
    credit_amount REAL DEFAULT 0,
    description TEXT,
    cost_centre_id TEXT,
    cost_category_id TEXT,
    reference_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS journal_entries (
    id TEXT PRIMARY KEY,
    company_id TEXT,
    voucher_id TEXT,
    entry_number TEXT,
    entry_date TEXT,
    description TEXT,
    currency TEXT,
    exchange_rate REAL,
    total_debit REAL,
    total_credit REAL,
    status TEXT,
    created_by TEXT,
    created_at TEXT,
    updated_at TEXT,
    posted_at TEXT,
    posted_by TEXT
  );
  CREATE TABLE IF NOT EXISTS vouchers (
    id TEXT PRIMARY KEY,
    company_id TEXT,
    voucher_number TEXT,
    voucher_type TEXT,
    voucher_date TEXT,
    reference_number TEXT,
    description TEXT,
    status TEXT,
    created_by TEXT,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS system_metadata (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS accounting_audit (
    id TEXT PRIMARY KEY,
    company_id TEXT,
    user_id TEXT,
    action TEXT,
    entity_type TEXT,
    entity_id TEXT,
    old_values_json TEXT,
    new_values_json TEXT,
    ip_address TEXT,
    session_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

conn.run(`INSERT OR IGNORE INTO companies (id, name) VALUES ('default', 'Default Company')`);
conn.run(`INSERT OR REPLACE INTO system_metadata (key, value) VALUES ('default_currency', 'INR')`);

// Now require the controller — it will use getConn() which returns our temp DB conn
const { AccountingController } = require(path.join(PROJECT_ROOT, "server/controllers/accounting.controller.js"));

describe("Update Account with Transactions — is_group Re-submission Safety", () => {
  let controller;

  function mockRes() {
    const result = { statusCode: 200, body: null };
    return {
      status(code) { result.statusCode = code; return this; },
      set() { return this; },
      json(body) { result.body = body; return this; },
      getResult: () => result,
    };
  }

  before(() => {
    controller = new AccountingController();
  });

  beforeEach(() => {
    // Clean all data between tests
    for (const table of ["journal_entry_lines", "journal_entries", "vouchers", "accounts", "account_groups", "accounting_audit"]) {
      try { conn.run(`DELETE FROM ${table}`); } catch (e) { /* table may not exist yet */ }
    }
    conn.run(`INSERT OR IGNORE INTO companies (id, name) VALUES ('default', 'Default Company')`);
    conn.run(`INSERT OR REPLACE INTO system_metadata (key, value) VALUES ('default_currency', 'INR')`);
  });

  after(() => {
    try { conn.close(); } catch (e) {}
    if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
  });

  it("allows editing a ledger account with transactions when is_group is re-sent as false (same value)", () => {
    conn.run(
      `INSERT INTO account_groups (id, company_id, code, name, parent_id, type, debit_credit_nature, is_active, allow_child_accounts, created_at, updated_at)
       VALUES ('grp_asset', 'default', '1000', 'Assets', NULL, 'ASSET', 'DEBIT', 1, 1, datetime('now'), datetime('now'))`,
    );
    conn.run(
      `INSERT INTO account_groups (id, company_id, code, name, parent_id, type, debit_credit_nature, is_active, allow_child_accounts, created_at, updated_at)
       VALUES ('grp_current_asset', 'default', '1100', 'Current Assets', 'grp_asset', 'ASSET', 'DEBIT', 1, 1, datetime('now'), datetime('now'))`,
    );
    conn.run(
      `INSERT INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, description, is_active, parent_id, is_group, allow_direct_posting, reconciliation_required, opening_balance, opening_balance_type, opening_balance_date, is_system, created_at, updated_at)
       VALUES ('acc_ledger', 'default', 'AC-00002', 'Cash in Hand', 'grp_current_asset', 'ASSET', 'DEBIT', 'Cash', 1, NULL, 0, 1, 0, 50000, 'DEBIT', '2026-04-01', 0, datetime('now'), datetime('now'))`,
    );
    conn.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit_amount, credit_amount, description, created_at)
       VALUES ('jel_1', 'je_1', 'acc_ledger', 50000, 0, 'Opening balance', datetime('now'))`,
    );

    // Simulate the frontend update: sends is_group: false (boolean) — same as DB value 0
    const req = {
      params: { id: "acc_ledger" },
      body: {
        name: "Cash in Hand (Updated)",
        type: "ASSET",
        is_group: false, // <-- boolean false, same as DB
        is_active: true,
        account_group_id: "grp_current_asset",
      },
      user: { companyId: "default", userId: "admin" },
    };

    const res = mockRes();
    let caughtError = null;
    const next = (err) => { caughtError = err; };

    controller.updateAccount(req, res, next);

    assert.equal(caughtError, null);
    const result = res.getResult();
    assert.equal(result.statusCode, 200, `Expected 200, got ${result.statusCode}, body: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.success, true);
    assert.equal(result.body.data.name, "Cash in Hand (Updated)");
  });

  it("still blocks changing is_group on an account with transactions", () => {
    conn.run(
      `INSERT INTO account_groups (id, company_id, code, name, parent_id, type, debit_credit_nature, is_active, allow_child_accounts, created_at, updated_at)
       VALUES ('grp_asset', 'default', '1000', 'Assets', NULL, 'ASSET', 'DEBIT', 1, 1, datetime('now'), datetime('now'))`,
    );
    conn.run(
      `INSERT INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, description, is_active, parent_id, is_group, allow_direct_posting, reconciliation_required, opening_balance, opening_balance_type, opening_balance_date, is_system, created_at, updated_at)
       VALUES ('acc_ledger', 'default', 'AC-00002', 'Cash in Hand', 'grp_asset', 'ASSET', 'DEBIT', 'Cash', 1, NULL, 0, 1, 0, 50000, 'DEBIT', '2026-04-01', 0, datetime('now'), datetime('now'))`,
    );
    conn.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit_amount, credit_amount, description, created_at)
       VALUES ('jel_1', 'je_1', 'acc_ledger', 50000, 0, 'Opening balance', datetime('now'))`,
    );

    // Attempt to change is_group from 0 to 1
    const req = {
      params: { id: "acc_ledger" },
      body: {
        name: "Cash in Hand",
        type: "ASSET",
        is_group: 1, // Changing to GROUP
        is_active: true,
        account_group_id: "grp_asset",
      },
      user: { companyId: "default", userId: "admin" },
    };

    let caughtError = null;
    const res = mockRes();
    const next = (err) => { caughtError = err; };

    controller.updateAccount(req, res, next);

    assert.ok(caughtError, "Should have thrown an error");
    assert.equal(
      caughtError.message,
      "Cannot change account type on an account with transactions",
    );
  });

  it("still blocks changing account type on an account with transactions", () => {
    // Create an equity group so the type change passes the group compatibility check
    // and only the "Cannot change Account Type" check fires
    conn.run(
      `INSERT INTO account_groups (id, company_id, code, name, parent_id, type, debit_credit_nature, is_active, allow_child_accounts, created_at, updated_at)
       VALUES ('grp_equity', 'default', '3000', 'Equity', NULL, 'EQUITY', 'CREDIT', 1, 1, datetime('now'), datetime('now'))`,
    );
    conn.run(
      `INSERT INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, description, is_active, parent_id, is_group, allow_direct_posting, reconciliation_required, opening_balance, opening_balance_type, opening_balance_date, is_system, created_at, updated_at)
       VALUES ('acc_ledger', 'default', 'AC-00002', 'Cash in Hand', 'grp_equity', 'ASSET', 'DEBIT', 'Cash', 1, NULL, 0, 1, 0, 50000, 'DEBIT', '2026-04-01', 0, datetime('now'), datetime('now'))`,
    );
    conn.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit_amount, credit_amount, description, created_at)
       VALUES ('jel_1', 'je_1', 'acc_ledger', 50000, 0, 'Opening balance', datetime('now'))`,
    );

    // Attempt to change type from ASSET to EQUITY (group is compatible, but
    // the account has transactions so type change must be blocked)
    const req = {
      params: { id: "acc_ledger" },
      body: {
        name: "Cash in Hand",
        type: "EQUITY",
        is_group: false,
        is_active: true,
        account_group_id: "grp_equity",
      },
      user: { companyId: "default", userId: "admin" },
    };

    let caughtError = null;
    const res = mockRes();
    const next = (err) => { caughtError = err; };

    controller.updateAccount(req, res, next);

    assert.ok(caughtError, "Should have thrown an error");
    assert.ok(
      String(caughtError.message).includes("Cannot change Account Type"),
      `Wrong error: ${caughtError.message}`,
    );
  });
});
