// Runs under vitest (globals enabled in vitest.config.js)
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");

const CodeGenerator = require("../server/services/code-generator.service");
const {
  AccountGroupService,
} = require("../server/services/account-group.service");
const {
  ChartOfAccountsService,
} = require("../server/services/accounting-coa.service");

// ── In-memory SQLite with a better-sqlite3-style adapter (mirrors the app's
//    DatabaseConnection so transactions behave the same). ──
function connection() {
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  const toBindable = (v) => {
    if (v === undefined) return null;
    if (typeof v === "function") return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v !== null && typeof v === "object") return JSON.stringify(v);
    return v;
  };
  const values = (args) => {
    const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    return list.map(toBindable);
  };
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run: (...a) => stmt.run(...values(a)),
        get: (...a) => stmt.get(...values(a)),
        all: (...a) => stmt.all(...values(a)),
      };
    },
    run(sql, ...a) {
      return db.prepare(sql).run(...values(a));
    },
    get(sql, ...a) {
      return db.prepare(sql).get(...values(a));
    },
    all(sql, ...a) {
      return db.prepare(sql).all(...values(a));
    },
    transaction(fn) {
      return (...args) => {
        const sp = `sp_${depth}`;
        db.exec(depth++ ? `SAVEPOINT ${sp}` : "BEGIN");
        try {
          const result = fn(...args);
          db.exec(--depth ? `RELEASE SAVEPOINT ${sp}` : "COMMIT");
          return result;
        } catch (e) {
          db.exec(--depth ? `ROLLBACK TO SAVEPOINT ${sp}` : "ROLLBACK");
          throw e;
        }
      };
    },
    exec: (sql) => db.exec(sql),
  };
}

function schema(conn) {
  conn.exec(`
    CREATE TABLE account_groups (id TEXT PRIMARY KEY, company_id TEXT, code TEXT, name TEXT, type TEXT,
      debit_credit_nature TEXT, is_active INTEGER, parent_id TEXT, allow_child_accounts INTEGER,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, company_id TEXT, code TEXT, name TEXT, account_group_id TEXT,
      type TEXT, debit_credit_nature TEXT, description TEXT, is_active INTEGER, parent_id TEXT, is_group INTEGER,
      allow_direct_posting INTEGER, reconciliation_required INTEGER, opening_balance REAL, opening_balance_type TEXT,
      opening_balance_date TEXT, is_system INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE accounting_audit (id TEXT PRIMARY KEY, company_id TEXT, user_id TEXT, action TEXT, entity_type TEXT,
      entity_id TEXT, old_values_json TEXT, new_values_json TEXT, ip_address TEXT, user_agent TEXT, session_id TEXT, created_at TEXT);
    CREATE UNIQUE INDEX uq_groups ON account_groups(company_id, code);
    CREATE UNIQUE INDEX uq_accounts ON accounts(company_id, code);
    CREATE TABLE vouchers (id TEXT PRIMARY KEY, company_id TEXT, voucher_number TEXT, voucher_type TEXT,
      voucher_date TEXT, reference_number TEXT, description TEXT, currency TEXT, status TEXT,
      created_by TEXT, created_at TEXT, updated_at TEXT);
  `);
  // number_sequences primary key is created by the generator's ensureTable.
}

const ctx = (companyId, perms = ["*"]) => ({
  companyId,
  userId: "u1",
  permissions: perms,
});

describe("CodeGenerator (centralized automatic numbering)", () => {
  let conn;
  beforeEach(() => {
    conn = connection();
    schema(conn);
  });

  it("generates sequential codes", () => {
    const a = CodeGenerator.generate(conn, "ACCOUNT_GROUP", "default");
    const b = CodeGenerator.generate(conn, "ACCOUNT_GROUP", "default");
    const c = CodeGenerator.generate(conn, "ACCOUNT_GROUP", "default");
    assert.equal(a, "AG-00001");
    assert.equal(b, "AG-00002");
    assert.equal(c, "AG-00003");
  });

  it("does not reuse codes of deleted records", () => {
    const id = "ag_t1";
    conn.run(
      "INSERT INTO account_groups (id, company_id, code, name, type) VALUES (?, 'default', ?, 'G', 'ASSET')",
      [id, CodeGenerator.generate(conn, "ACCOUNT_GROUP", "default")],
    );
    CodeGenerator.generate(conn, "ACCOUNT_GROUP", "default"); // AG-00002
    conn.run("DELETE FROM account_groups WHERE id = ?", [id]); // delete AG-00001
    const next = CodeGenerator.generate(conn, "ACCOUNT_GROUP", "default");
    assert.equal(next, "AG-00003"); // never re-issues AG-00001 / AG-00002
  });

  it("seeds from existing legacy codes and never collides with them", () => {
    conn.run(
      "INSERT INTO account_groups (id, company_id, code, name, type) VALUES ('x1','default','AG-00042','Legacy','ASSET')",
    );
    const next = CodeGenerator.generate(conn, "ACCOUNT_GROUP", "default");
    assert.equal(next, "AG-00043");
  });

  it("keeps tenants isolated", () => {
    assert.equal(CodeGenerator.generate(conn, "ACCOUNT_GROUP", "coA"), "AG-00001");
    assert.equal(CodeGenerator.generate(conn, "ACCOUNT_GROUP", "coB"), "AG-00001");
    assert.equal(CodeGenerator.generate(conn, "ACCOUNT_GROUP", "coA"), "AG-00002");
    const rows = conn.all("SELECT * FROM number_sequences WHERE entity_type = 'ACCOUNT_GROUP'");
    assert.equal(rows.length, 2);
  });

  it("supports year-scoped financial document numbering", () => {
    const y = String(new Date().getFullYear());
    assert.equal(CodeGenerator.generate(conn, "VOUCHER_JOURNAL", "default"), `JV-${y}-0001`);
    assert.equal(CodeGenerator.generate(conn, "VOUCHER_JOURNAL", "default"), `JV-${y}-0002`);
  });

  it("preview does not consume the counter", () => {
    assert.equal(CodeGenerator.preview(conn, "LEDGER_ACCOUNT", "default"), "AC-00001");
    assert.equal(CodeGenerator.preview(conn, "LEDGER_ACCOUNT", "default"), "AC-00001");
    assert.equal(CodeGenerator.generate(conn, "LEDGER_ACCOUNT", "default"), "AC-00001");
  });

  it("rejects unknown entity types", () => {
    assert.throws(() => CodeGenerator.generate(conn, "NOT_A_THING", "default"), CodeGenerator.CodeGeneratorError);
  });

  it("handles rapid concurrent-style generation without duplicates", () => {
    const codes = new Set();
    for (let i = 0; i < 50; i++) codes.add(CodeGenerator.generate(conn, "LEDGER_ACCOUNT", "default"));
    assert.equal(codes.size, 50);
  });
});

describe("Backend auto-generation via services", () => {
  let conn;
  beforeEach(() => {
    conn = connection();
    schema(conn);
  });

  it("creates an account group without a client-supplied code", () => {
    const svc = new AccountGroupService(conn);
    const g = svc.create({ name: "Current Assets", type: "ASSET" }, ctx("default"));
    assert.match(g.code, /^AG-00001$/);
    assert.equal(g.name, "Current Assets");
  });

  it("validates a duplicate client-supplied code", () => {
    const svc = new AccountGroupService(conn);
    svc.create({ code: "MINE", name: "G1", type: "ASSET" }, ctx("default"));
    assert.throws(
      () => svc.create({ code: "MINE", name: "G2", type: "ASSET" }, ctx("default")),
      /already exists/,
    );
  });

  it("creates a ledger account without a code and links it to a group", () => {
    const groups = new AccountGroupService(conn);
    const g = groups.create({ name: "Cash Group", type: "ASSET" }, ctx("default"));
    const coa = new ChartOfAccountsService(conn);
    const acc = coa.create({ name: "Cash in Hand", account_group_id: g.id, type: "ASSET" }, ctx("default"));
    assert.match(acc.code, /^AC-00001$/);
  });

  it("honours a client-supplied account code when valid", () => {
    const groups = new AccountGroupService(conn);
    const g = groups.create({ name: "Cash Group", type: "ASSET" }, ctx("default"));
    const coa = new ChartOfAccountsService(conn);
    const acc = coa.create({ code: "1001", name: "Cash", account_group_id: g.id }, ctx("default"));
    assert.equal(acc.code, "1001");
  });

  it("keeps existing records untouched when generating new codes", () => {
    conn.run(
      "INSERT INTO account_groups (id, company_id, code, name, type) VALUES ('legacy','default','5007','Old Group','EXPENSE')",
    );
    const svc = new AccountGroupService(conn);
    const before = conn.get("SELECT code FROM account_groups WHERE id = 'legacy'");
    const created = svc.create({ name: "New Group", type: "EXPENSE" }, ctx("default"));
    const after = conn.get("SELECT code FROM account_groups WHERE id = 'legacy'");
    assert.equal(before.code, after.code); // legacy record unchanged
    assert.notEqual(created.code, "5007"); // new code never equals a legacy code
  });
});
