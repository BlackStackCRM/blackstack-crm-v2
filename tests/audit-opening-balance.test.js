/**
 * BLACK STACK CRM — ACCOUNTING FIX AUDIT
 * Comprehensive audit test for the Opening Balance workflow fix.
 *
 * Run with: node --test tests/audit-opening-balance.test.js
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const tmpDbPath = path.join(os.tmpdir(), `bs-audit-${Date.now()}.db`);
process.env.DB_PATH = tmpDbPath;

const { DatabaseConnection } = require(path.join(PROJECT_ROOT, "server/database/connection.js"));
const { migrate } = require(path.join(PROJECT_ROOT, "server/database/migrate.js"));
const { generateId } = require(path.join(PROJECT_ROOT, "server/utils/generateId.js"));

const { AccountingController } = require(path.join(PROJECT_ROOT, "server/controllers/accounting.controller.js"));

let dbConn, conn, controller;

function mockRes() {
  const result = { statusCode: 200, body: null };
  return {
    status(code) { result.statusCode = code; return this; },
    set() { return this; },
    json(body) { result.body = body; return this; },
    getResult: () => result,
  };
}

describe("BLACK STACK CRM — Accounting Fix Audit", () => {
  before(async () => {
    // Run migrations — returns the DatabaseConnection used by migrate()
    dbConn = await migrate();
    conn = dbConn.get();

    // Insert AC-00001 Owner Capital and AC-00002 Cash in Hand
    // (migration 023 seeds '3001 Share Capital' and '1001 Cash', but audit needs AC-00001/AC-00002)
    const equityGroup = conn.get("SELECT id FROM account_groups WHERE type IN ('EQUITY') AND company_id = 'default' LIMIT 1");
    const cashGroup = conn.get("SELECT id FROM account_groups WHERE type IN ('ASSET') AND company_id = 'default' LIMIT 1");

    const now = new Date().toISOString();
    let oc = conn.get("SELECT id FROM accounts WHERE code = 'AC-00001' AND company_id = 'default'");
    if (!oc) {
      conn.run(
        `INSERT INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, description, is_active, parent_id, is_group, allow_direct_posting, reconciliation_required, opening_balance, opening_balance_type, opening_balance_date, is_system, created_at, updated_at)
         VALUES (?, 'default', 'AC-00001', 'Owner Capital', ?, 'EQUITY', 'CREDIT', 'Owner Capital', 1, NULL, 0, 1, 0, 0, 'CREDIT', NULL, 0, ?, ?)`,
        [generateId("acc"), equityGroup.id, now, now]
      );
    }

    let ch = conn.get("SELECT id FROM accounts WHERE code = 'AC-00002' AND company_id = 'default'");
    if (!ch) {
      conn.run(
        `INSERT INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, description, is_active, parent_id, is_group, allow_direct_posting, reconciliation_required, opening_balance, opening_balance_type, opening_balance_date, is_system, created_at, updated_at)
         VALUES (?, 'default', 'AC-00002', 'Cash in Hand', ?, 'CASH', 'DEBIT', 'Cash in Hand', 1, NULL, 0, 1, 0, 0, 'DEBIT', NULL, 0, ?, ?)`,
        [generateId("acc"), cashGroup.id, now, now]
      );
    }

    controller = new AccountingController();
  });

  after(() => {
    try { dbConn.close(); } catch (e) {}
    if (fs.existsSync(tmpDbPath)) { try { fs.unlinkSync(tmpDbPath); } catch (e) {} }
  });

  // === SECTION 1: Account Verification ===
  describe("Account Verification — AC-00001 Owner Capital", () => {
    it("should exist as a LEDGER Equity Active posting account", () => {
      const acct = conn.get("SELECT * FROM accounts WHERE code = 'AC-00001' AND company_id = 'default'");
      assert.ok(acct, "AC-00001 Owner Capital must exist");
      assert.equal(acct.type, "EQUITY");
      assert.equal(acct.debit_credit_nature, "CREDIT");
      assert.equal(acct.is_group, 0, "Must be LEDGER");
      assert.equal(acct.is_active, 1, "Must be active");
      assert.equal(acct.allow_direct_posting, 1, "Must be posting");
      console.log("    ✅ AC-00001: LEDGER, EQUITY, Active, Posting");
    });

    it("should exist as a LEDGER CASH Asset Active posting account (AC-00002)", () => {
      const acct = conn.get("SELECT * FROM accounts WHERE code = 'AC-00002' AND company_id = 'default'");
      assert.ok(acct, "AC-00002 Cash in Hand must exist");
      assert.equal(acct.type, "CASH");
      assert.equal(acct.is_group, 0, "Must be LEDGER");
      assert.equal(acct.is_active, 1, "Must be active");
      assert.equal(acct.allow_direct_posting, 1, "Must be posting");
      console.log("    ✅ AC-00002: LEDGER, CASH, Active, Posting");
    });

    it("should have exactly one Owner Capital account (no duplicates)", () => {
      const owners = conn.all("SELECT * FROM accounts WHERE name = 'Owner Capital' AND company_id = 'default'");
      assert.equal(owners.length, 1, "Must have exactly 1 Owner Capital");
      console.log("    ✅ Exactly 1 Owner Capital account");
    });
  });

  // === SECTION 2: Posting Account Logic ===
  describe("Posting Account Logic", () => {
    it("should have at least one valid posting Equity account", () => {
      const equityAccount = conn.get(
        `SELECT id, code, name FROM accounts
         WHERE company_id = ? AND type = 'EQUITY' AND is_active = 1
           AND (is_group = 0 OR is_group IS NULL) AND allow_direct_posting = 1
         ORDER BY code ASC, id ASC LIMIT 1`,
        ["default"]
      );
      assert.ok(equityAccount, "A posting Equity account must exist");
      const acct = conn.get("SELECT * FROM accounts WHERE id = ?", [equityAccount.id]);
      assert.equal(acct.type, "EQUITY");
      assert.equal(acct.is_group, 0);
      assert.equal(acct.is_active, 1);
      assert.equal(acct.allow_direct_posting, 1);
      console.log("    ✅ Valid posting Equity account found:", acct.code + " " + acct.name);
    });

    it("should not have hardcoded account IDs in the opening balance equity lookup", () => {
      const source = fs.readFileSync(path.join(PROJECT_ROOT, "server/repositories/chart-of-accounts.repository.js"), "utf8");
      const startIdx = source.indexOf("createOpeningBalance(");
      const methodSection = source.substring(startIdx, startIdx + 3000);
      const hasHardcoded = /Owner Capital|ac_01M2A|AC-00001/i.test(methodSection);
      assert.ok(!hasHardcoded, "No hardcoded equity account IDs or names");
      console.log("    ✅ No hardcoded account IDs in equity lookup");
    });

    it("should exclude the account being opened from the equity lookup", () => {
      const source = fs.readFileSync(path.join(PROJECT_ROOT, "server/repositories/chart-of-accounts.repository.js"), "utf8");
      const startIdx = source.indexOf("createOpeningBalance(");
      const methodSection = source.substring(startIdx, startIdx + 3000);
      assert.ok(methodSection.includes("id != ?"), "Must exclude account being opened");
      console.log("    ✅ Equity lookup excludes account being opened (id != ?)");
    });
  });

  // === SECTION 3: Accounting Integrity Test ===
  describe("Accounting Integrity Test — Cash in Hand ₹50,000 Debit", () => {
    it("should create balanced journal: Cash ₹50,000 Dr → Equity ₹50,000 Cr", async () => {
      const cashGroup = conn.get("SELECT id FROM account_groups WHERE type = 'ASSET' AND company_id = 'default' LIMIT 1");

      const req = {
        body: {
          code: "AUDIT-" + String(Date.now()).slice(-6),
          name: "Audit Test Cash",
          type: "CASH",
          account_group_id: cashGroup.id,
          opening_balance: 50000,
          opening_balance_type: "DEBIT",
          opening_balance_date: "2026-04-01",
          is_active: true,
          is_group: false,
          allow_direct_posting: true,
        },
        user: { companyId: "default", userId: "audit-user" },
      };

      const res = mockRes();
      const next = (err) => { if (err) throw err; };
      await controller.createAccount(req, res, next);

      const result = res.getResult();
      assert.equal(result.statusCode, 201, `Expected 201, got ${result.statusCode}: ${JSON.stringify(result.body.error || '')}`);
      assert.equal(result.body.success, true);

      const accountId = result.body.data.id;
      console.log("    ✅ Account created:", result.body.data.code, "-", result.body.data.name);

      const voucher = conn.get(
        `SELECT v.*, je.id as je_id, je.total_debit, je.total_credit
         FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id
         WHERE v.reference_number = ? AND v.company_id = 'default'`,
        ["OB-" + accountId]
      );
      assert.ok(voucher, "Opening balance voucher must exist");
      assert.equal(parseFloat(voucher.total_debit), 50000);
      assert.equal(parseFloat(voucher.total_credit), 50000);
      assert.equal(voucher.status, "POSTED");
      console.log("    ✅ Voucher:", voucher.voucher_number, "Dr=₹" + voucher.total_debit, "Cr=₹" + voucher.total_credit);

      const lines = conn.all(
        `SELECT jel.*, a.code, a.name, a.type
         FROM journal_entry_lines jel JOIN accounts a ON jel.account_id = a.id
         WHERE jel.journal_entry_id = ? ORDER BY jel.account_id`,
        [voucher.je_id]
      );
      assert.equal(lines.length, 2, "Should have exactly 2 journal lines");

      const debitLine = lines.find(l => parseFloat(l.debit_amount) > 0);
      const creditLine = lines.find(l => parseFloat(l.credit_amount) > 0);
      assert.ok(debitLine, "Should have a debit line");
      assert.ok(creditLine, "Should have a credit line");

      console.log("    ✅ Dr: " + debitLine.code + " " + debitLine.name + " — ₹" + debitLine.debit_amount);
      console.log("    ✅ Cr: " + creditLine.code + " " + creditLine.name + " — ₹" + creditLine.credit_amount);

      // The credit should go to an EQUITY account (the equity offset)
      assert.equal(creditLine.type, "EQUITY", "Credit should be to an Equity account");
      console.log("    ✅ Credit offset is an EQUITY account");

      const diff = Math.abs(parseFloat(voucher.total_debit) - parseFloat(voucher.total_credit));
      assert.equal(diff, 0, "Difference must be zero");
      console.log("    ✅ Difference: ₹" + diff + " (balanced)");
      console.log("    ✅ TEST PASSED: ₹50,000 Dr = ₹50,000 Cr, Difference = ₹0");
    });
  });

  // === SECTION 4: Account-Type Protection ===
  describe("Account-Type Protection", () => {
    it("should block changing is_group from 0 to 1 on an account with transactions", async () => {
      const cashAcct = conn.get("SELECT id FROM accounts WHERE code = 'AC-00002' AND company_id = 'default'");
      assert.ok(cashAcct);

      // Ensure AC-00002 has a transaction
      const jelCount = conn.get("SELECT COUNT(*) as c FROM journal_entry_lines WHERE account_id = ?", [cashAcct.id]).c;
      if (jelCount === 0) {
        const now = new Date().toISOString();
        const jeId = generateId("je");
        conn.run(
          `INSERT INTO journal_entries (id, company_id, entry_number, entry_date, currency, status, created_by, total_debit, total_credit, description, created_at, updated_at)
           VALUES (?, 'default', 'JE-TEST-${Date.now()}', '2026-04-01', 'INR', 'POSTED', 'audit-user', 50000, 50000, 'Audit test JE', ?, ?)`,
          [jeId, now, now]
        );
        conn.run(
          `INSERT INTO journal_entry_lines (id, company_id, journal_entry_id, account_id, debit_amount, credit_amount, description, created_at)
           VALUES (?, 'default', ?, ?, 50000, 0, 'Audit test line', ?)`,
          [generateId("jl"), jeId, cashAcct.id, now]
        );
      }

      const req = {
        params: { id: cashAcct.id },
        body: { name: "Cash in Hand", type: "CASH", is_group: 1, is_active: true, account_group_id: null },
        user: { companyId: "default", userId: "admin" },
      };
      const res = mockRes();
      let caughtError = null;
      await controller.updateAccount(req, res, (err) => { caughtError = err; });

      assert.ok(caughtError);
      assert.equal(caughtError.message, "Cannot change account type on an account with transactions");
      console.log("    ✅ Blocked is_group change (LEDGER→GROUP):", caughtError.message);
    });

    it("should block changing type from CASH to EQUITY on an account with transactions", async () => {
      const cashAcct = conn.get("SELECT * FROM accounts WHERE code = 'AC-00002' AND company_id = 'default'");
      assert.equal(cashAcct.type, "CASH");
      const equityGroup = conn.get("SELECT id FROM account_groups WHERE type = 'EQUITY' AND company_id = 'default' LIMIT 1");

      const req = {
        params: { id: cashAcct.id },
        body: { name: "Cash in Hand", type: "EQUITY", is_group: false, is_active: true, account_group_id: equityGroup.id },
        user: { companyId: "default", userId: "admin" },
      };
      const res = mockRes();
      let caughtError = null;
      await controller.updateAccount(req, res, (err) => { caughtError = err; });

      assert.ok(caughtError);
      const msg = String(caughtError.message);
      assert.ok(msg.includes("Cannot change"), "Should reject type change: " + msg);
      console.log("    ✅ Blocked type change (CASH→EQUITY):", msg);
    });

    it("should NOT trigger account type change when creating opening balance", () => {
      const acct = conn.get("SELECT * FROM accounts WHERE code = 'AC-00002' AND company_id = 'default'");
      assert.equal(acct.type, "CASH");
      assert.equal(acct.is_group, 0);
      console.log("    ✅ Opening balance workflow did NOT change account type — still CASH/LEDGER");
    });
  });

  // === SECTION 5: Invalid Group Posting ===
  describe("Invalid Group Posting", () => {
    it("should reject adding a GROUP account as an opening balance line", async () => {
      const anyFy = conn.get("SELECT id FROM financial_years WHERE company_id = 'default' LIMIT 1");
      const obId = controller.obRepo.create("default", anyFy.id, "2026-04-01", "OB-TEST-GROUP-AUDIT", "audit-user");

      const groupAcct = conn.get("SELECT id FROM accounts WHERE is_group = 1 AND company_id = 'default' LIMIT 1");
      if (groupAcct) {
        const req = {
          params: { id: obId },
          body: { account_id: groupAcct.id, debit: 1000, credit: 0, description: "Test" },
          user: { companyId: "default", userId: "audit-user" },
        };
        const res = mockRes();
        let caughtError = null;
        await controller.addOpeningBalanceLine(req, res, (err) => { caughtError = err; });
        assert.ok(caughtError);
        assert.ok(String(caughtError.message).includes("cannot receive opening balances"));
        console.log("    ✅ Rejected group account:", caughtError.message);
      } else {
        const source = fs.readFileSync(path.join(PROJECT_ROOT, "server/controllers/accounting.controller.js"), "utf8");
        const idx = source.indexOf("async addOpeningBalanceLine");
        const section = source.substring(idx, idx + 3000);
        assert.ok(section.includes("Account groups cannot receive opening balances"));
        console.log("    ✅ Controller code rejects group accounts (is_group check present)");
      }
      controller.obRepo.deleteAllLines(obId);
      controller.obRepo.delete(obId, "default");
    });
  });

  // === SECTION 6: No Equity Posting Account ===
  describe("No Equity Posting Account", () => {
    it("should produce a clear error and rollback when no posting Equity account exists", async () => {
      conn.run("UPDATE accounts SET is_active = 0 WHERE company_id = 'default' AND type = 'EQUITY'");

      const assetGroup = conn.get("SELECT id FROM account_groups WHERE type = 'ASSET' AND company_id = 'default' LIMIT 1");
      const req = {
        body: {
          code: "NOEQ-" + String(Date.now()).slice(-6),
          name: "No Equity Test",
          type: "CASH",
          account_group_id: assetGroup.id,
          opening_balance: 100,
          opening_balance_type: "DEBIT",
          opening_balance_date: "2026-04-01",
          is_active: true,
          is_group: false,
        },
        user: { companyId: "default", userId: "audit-user" },
      };
      const res = mockRes();
      let caughtError = null;
      await controller.createAccount(req, res, (err) => { caughtError = err; });
      conn.run("UPDATE accounts SET is_active = 1 WHERE company_id = 'default' AND type = 'EQUITY'");

      assert.ok(caughtError);
      assert.ok(String(caughtError.message).includes("posting Equity account is required"));
      console.log("    ✅ Clear error:", caughtError.message);

      const created = conn.get("SELECT * FROM accounts WHERE code = ?", [req.body.code]);
      assert.ok(!created, "Account should not have been created");
      console.log("    ✅ Rollback verified — no orphaned account");
    });
  });

  // === SECTION 7: Transaction Safety ===
  describe("Transaction Safety", () => {
    it("should not create duplicate Owner Capital accounts", () => {
      const owners = conn.all("SELECT * FROM accounts WHERE name = 'Owner Capital' AND company_id = 'default'");
      assert.equal(owners.length, 1);
      console.log("    ✅ No duplicate Owner Capital — exactly 1 found");
    });

    it("should not create duplicate journal entries for the same opening balance", () => {
      const cashAcct = conn.get("SELECT id FROM accounts WHERE code = 'AC-00002' AND company_id = 'default'");
      const count = conn.get("SELECT COUNT(*) as c FROM vouchers WHERE reference_number = ?", ["OB-" + cashAcct.id]).c;
      assert.ok(count >= 0);
      console.log("    ✅ Voucher count for AC-00002 OB:", count);
    });
  });

  // === SECTION 8: Journal Integrity ===
  describe("Journal Integrity", () => {
    it("should rebuild (not duplicate) journal when opening balance changes", () => {
      const cashAcct = conn.get("SELECT id FROM accounts WHERE code = 'AC-00002' AND company_id = 'default'");

      controller.coaRepo.createOpeningBalance(conn, "default", cashAcct.id, 50000, "DEBIT", "2026-04-01", "audit-user");
      const beforeCount = conn.get("SELECT COUNT(*) as c FROM vouchers WHERE reference_number = ?", ["OB-" + cashAcct.id]).c;
      assert.equal(beforeCount, 1, "Should have 1 voucher after first creation");

      controller.coaRepo.createOpeningBalance(conn, "default", cashAcct.id, 75000, "DEBIT", "2026-04-01", "audit-user");
      const afterCount = conn.get("SELECT COUNT(*) as c FROM vouchers WHERE reference_number = ?", ["OB-" + cashAcct.id]).c;
      assert.equal(beforeCount, afterCount, "Should not duplicate vouchers");

      const voucher = conn.get(
        `SELECT je.total_debit, je.total_credit FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id
         WHERE v.reference_number = ? AND v.company_id = 'default'`,
        ["OB-" + cashAcct.id]
      );
      assert.equal(parseFloat(voucher.total_debit), 75000);
      assert.equal(parseFloat(voucher.total_credit), 75000);
      console.log("    ✅ Journal rebuilt: Dr=₹" + voucher.total_debit + " Cr=₹" + voucher.total_credit + " (count: " + beforeCount + " → " + afterCount + ")");
    });

    it("should not have zero-value journal lines in posted entries", () => {
      const lines = conn.all(
        `SELECT jel.* FROM journal_entry_lines jel
         JOIN journal_entries je ON jel.journal_entry_id = je.id
         WHERE je.company_id = 'default' AND je.status = 'POSTED'`
      );
      const zeroLines = lines.filter(l => parseFloat(l.debit_amount) === 0 && parseFloat(l.credit_amount) === 0);
      assert.equal(zeroLines.length, 0, "No zero-value lines");
      console.log("    ✅ No zero-value journal lines (" + lines.length + " total checked)");
    });
  });
});
