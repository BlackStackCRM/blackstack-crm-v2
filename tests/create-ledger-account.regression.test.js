const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  AccountingController,
} = require("../server/controllers/accounting.controller");
const {
  ChartOfAccountsRepository,
} = require("../server/repositories/chart-of-accounts.repository");
const {
  AccountGroupRepository,
} = require("../server/repositories/account-group.repository");

function expect(actual) {
  return {
    toBe: (expected) => assert.strictEqual(actual, expected),
    toBeUndefined: () => assert.strictEqual(actual, undefined),
    toMatch: (pattern) => assert.match(actual, pattern),
    toMatchObject: (expected) => {
      for (const [key, value] of Object.entries(expected))
        assert.deepStrictEqual(actual[key], value);
    },
    toEqual: (expected) =>
      assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected),
    not: { toMatch: (pattern) => assert.doesNotMatch(actual, pattern) },
  };
}

function connection() {
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  const values = (args) =>
    args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run: (...args) => statement.run(...values(args)),
        get: (...args) => statement.get(...values(args)),
        all: (...args) => statement.all(...values(args)),
      };
    },
    run(sql, ...args) {
      return db.prepare(sql).run(...values(args));
    },
    get(sql, ...args) {
      return db.prepare(sql).get(...values(args));
    },
    all(sql, ...args) {
      return db.prepare(sql).all(...values(args));
    },
    transaction(fn) {
      return (...args) => {
        const savepoint = `sp_${depth}`;
        db.exec(depth++ ? `SAVEPOINT ${savepoint}` : "BEGIN");
        try {
          const result = fn(...args);
          db.exec(--depth ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
          return result;
        } catch (error) {
          db.exec(--depth ? `ROLLBACK TO SAVEPOINT ${savepoint}` : "ROLLBACK");
          throw error;
        }
      };
    },
    exec: (sql) => db.exec(sql),
  };
}

function schema(conn) {
  conn.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, company_id TEXT, code TEXT, name TEXT, account_group_id TEXT,
      type TEXT, debit_credit_nature TEXT, description TEXT, is_active INTEGER, parent_id TEXT, is_group INTEGER,
      allow_direct_posting INTEGER, reconciliation_required INTEGER, opening_balance REAL, opening_balance_type TEXT,
      opening_balance_date TEXT, is_system INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE account_groups (id TEXT PRIMARY KEY, company_id TEXT, code TEXT, name TEXT, type TEXT,
      debit_credit_nature TEXT, is_active INTEGER, parent_id TEXT);
    CREATE TABLE account_types (id TEXT PRIMARY KEY, company_id TEXT, name TEXT, debit_credit_nature TEXT, is_active INTEGER);
    CREATE TABLE vouchers (id TEXT PRIMARY KEY, company_id TEXT, voucher_number TEXT, voucher_type TEXT, voucher_date TEXT,
      reference_number TEXT, description TEXT, currency TEXT, status TEXT, created_by TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE journal_entries (id TEXT PRIMARY KEY, company_id TEXT, voucher_id TEXT, entry_number TEXT, entry_date TEXT,
      description TEXT, currency TEXT, exchange_rate REAL, total_debit REAL, total_credit REAL, status TEXT, created_by TEXT,
      created_at TEXT, updated_at TEXT, posted_at TEXT, posted_by TEXT);
    CREATE TABLE journal_entry_lines (id TEXT PRIMARY KEY, company_id TEXT, journal_entry_id TEXT, account_id TEXT,
      debit_amount REAL, credit_amount REAL, description TEXT, created_at TEXT);
    CREATE TABLE accounting_audit (id TEXT PRIMARY KEY, company_id TEXT, user_id TEXT, action TEXT, entity_type TEXT,
      entity_id TEXT, old_values_json TEXT, new_values_json TEXT, ip_address TEXT, session_id TEXT, created_at TEXT);
    CREATE TABLE system_metadata (key TEXT PRIMARY KEY, value TEXT, created_at TEXT, updated_at TEXT);
  `);
}

function controller(conn) {
  const subject = Object.create(AccountingController.prototype);
  subject.coaRepo = new ChartOfAccountsRepository(conn);
  subject.groupRepo = new AccountGroupRepository(conn);
  return subject;
}

async function create(subject, body, companyId = "c1") {
  let result;
  let error;
  await subject.createAccount(
    { body, user: { companyId, userId: "user_1" } },
    {
      status: (code) => ({
        json: (value) => {
          result = { code, value };
        },
      }),
    },
    (value) => {
      error = value;
    },
  );
  return { result, error };
}

describe("Create Ledger Account audit regressions", () => {
  let conn;
  let subject;

  beforeEach(() => {
    conn = connection();
    schema(conn);
    subject = controller(conn);
    conn.run(
      `INSERT INTO account_groups VALUES ('liability_group', 'c1', '2000', 'Liabilities', 'LIABILITY', 'CREDIT', 1, NULL)`,
    );
    conn.run(
      `INSERT INTO account_groups VALUES ('asset_group', 'c1', '1000', 'Assets', 'ASSET', 'DEBIT', 1, NULL)`,
    );
    conn.run(
      `INSERT INTO system_metadata VALUES ('default_currency', 'INR', NULL, NULL)`,
    );
  });

  it("tenant-scopes custom types, derives their nature, trims code, and persists reconciliation", async () => {
    // Insert the other tenant first: an unscoped lookup would read DEBIT and reject this ledger.
    conn.run(
      `INSERT INTO account_types VALUES ('foreign_type', 'c2', 'DEFERRED', 'DEBIT', 1)`,
    );
    conn.run(
      `INSERT INTO account_types VALUES ('local_type', 'c1', 'DEFERRED', 'CREDIT', 1)`,
    );
    const { result, error } = await create(subject, {
      code: "  2101  ",
      name: " Deferred revenue ",
      type: "DEFERRED",
      account_group_id: "liability_group",
      opening_balance: 0,
      opening_balance_type: "CREDIT",
      reconciliation_required: "on",
      is_system: true,
      is_group: true,
    });
    expect(error).toBeUndefined();
    expect(result.code).toBe(201);
    const account = conn.get(`SELECT * FROM accounts WHERE code = '2101'`);
    expect(account).toMatchObject({
      name: "Deferred revenue",
      debit_credit_nature: "CREDIT",
      reconciliation_required: 1,
      is_system: 0,
      is_group: 0,
      allow_direct_posting: 1,
    });
  });

  it("requires a compatible group and rejects invalid opening balances before writing", async () => {
    const base = {
      code: "1001",
      name: "Cash test",
      type: "ASSET",
      opening_balance: 0,
      opening_balance_type: "DEBIT",
    };
    expect((await create(subject, base)).error.message).toMatch(
      /account_group_id is required/,
    );
    expect(
      (
        await create(subject, {
          ...base,
          code: "1002",
          account_group_id: "liability_group",
        })
      ).error.message,
    ).toMatch(/incompatible/);
    expect(
      (
        await create(subject, {
          ...base,
          code: "1003",
          account_group_id: "asset_group",
          opening_balance: -1,
        })
      ).error.message,
    ).toMatch(/non-negative/);
    expect(
      (
        await create(subject, {
          ...base,
          code: "1004",
          account_group_id: "asset_group",
          opening_balance: 5,
          opening_balance_type: "CREDIT",
        })
      ).error.message,
    ).toMatch(/must be DEBIT/);
    conn.run(
      `INSERT INTO accounts VALUES ('asset_parent', 'c1', '1010', 'Asset parent', 'asset_group', 'ASSET', 'DEBIT', '', 1, NULL, 0, 1, 0, 0, 'DEBIT', NULL, 0, NULL, NULL)`,
    );
    expect(
      (
        await create(subject, {
          code: "1007",
          name: "Liability child",
          type: "LIABILITY",
          account_group_id: "liability_group",
          parent_id: "asset_parent",
          opening_balance: 0,
          opening_balance_type: "CREDIT",
        })
      ).error.message,
    ).toMatch(/same account type/);
  });

  it("rolls back a non-zero opening balance when no posting equity account exists", async () => {
    const { error } = await create(subject, {
      code: "1005",
      name: "Opening cash",
      type: "ASSET",
      account_group_id: "asset_group",
      opening_balance: 10,
      opening_balance_type: "DEBIT",
    });
    expect(error.message).toMatch(/posting Equity account is required/);
    expect(
      conn.get(`SELECT id FROM accounts WHERE code = '1005'`),
    ).toBeUndefined();
    expect(conn.get(`SELECT id FROM journal_entries`)).toBeUndefined();
  });

  it("creates and safely rebuilds a balanced, INR opening entry using a deterministic posting equity account", async () => {
    conn.run(
      `INSERT INTO accounts VALUES ('equity_z', 'c1', '3999', 'Z', 'liability_group', 'EQUITY', 'CREDIT', '', 1, NULL, 0, 1, 0, 0, 'CREDIT', NULL, 0, NULL, NULL)`,
    );
    conn.run(
      `INSERT INTO accounts VALUES ('equity_a', 'c1', '3000', 'A', 'liability_group', 'EQUITY', 'CREDIT', '', 1, NULL, 0, 1, 0, 0, 'CREDIT', NULL, 0, NULL, NULL)`,
    );
    const { result, error } = await create(subject, {
      code: "1006",
      name: "Opening cash",
      type: "ASSET",
      account_group_id: "asset_group",
      opening_balance: 25,
      opening_balance_type: "DEBIT",
    });
    expect(error).toBeUndefined();
    const account = result.value.data;
    const entry = conn.get(`SELECT * FROM journal_entries`);
    expect(entry).toMatchObject({
      currency: "INR",
      total_debit: 25,
      total_credit: 25,
    });
    expect(entry.entry_number).not.toMatch(/^JE-OB-\d+$/);
    expect(
      conn.all(
        `SELECT account_id, debit_amount, credit_amount FROM journal_entry_lines ORDER BY account_id`,
      ),
    ).toEqual([
      { account_id: account.id, debit_amount: 25, credit_amount: 0 },
      { account_id: "equity_a", debit_amount: 0, credit_amount: 25 },
    ]);

    subject.coaRepo.createOpeningBalance(
      conn,
      "c1",
      account.id,
      25,
      "CREDIT",
      "2026-01-01",
      "user_1",
    );
    expect(
      conn.get(`SELECT total_debit, total_credit FROM journal_entries`)
        .total_debit,
    ).toBe(25);
    expect(
      conn.all(
        `SELECT account_id, debit_amount, credit_amount FROM journal_entry_lines ORDER BY account_id`,
      ),
    ).toEqual([
      { account_id: account.id, debit_amount: 0, credit_amount: 25 },
      { account_id: "equity_a", debit_amount: 25, credit_amount: 0 },
    ]);
  });

  it("keeps the frontend form safe and preserves custom-type group selection", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../public/js/pages/chart-of-accounts.js"),
      "utf8",
    );
    expect(source).toMatch(
      /reconciliation_required: !!fd\.get\(["']reconciliation_required["']\)/,
    );
    expect(source).toMatch(
      /account_group_id: fd\.get\(["']account_group_id["']\) \|\| null/,
    );
    expect(source).toMatch(/let filtered = allGroups;/);
    expect(source).toMatch(/escapeHtml\(i\.code.*\)/);
    expect(source).toMatch(/escapeHtml\(i\.name.*\)/);
    expect(source).toMatch(/escapeHtml\(i\.description.*\)/);
  });
});
