const { AccountingBaseRepository } = require("./accounting-base.repository");
const { NotFoundError, ValidationError } = require("../utils/errors");

class ChartOfAccountsRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, "accounts");
  }

  search(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const companyId = this._company(options.companyId);
    const where = ["company_id = ?"];
    const params = [companyId];

    if (options.type) {
      where.push("type = ?");
      params.push(options.type);
    }
    if (options.groupId) {
      where.push("account_group_id = ?");
      params.push(options.groupId);
    }
    if (options.isGroup !== undefined) {
      where.push("is_group = ?");
      params.push(options.isGroup);
    }
    if (options.isActive !== undefined) {
      where.push("is_active = ?");
      params.push(options.isActive);
    }
    if (options.parentId !== undefined) {
      if (options.parentId === null) {
        where.push("(parent_id IS NULL OR parent_id = '')");
      } else {
        where.push("parent_id = ?");
        params.push(options.parentId);
      }
    }
    if (options.query) {
      const s = `%${options.query}%`;
      where.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)");
      params.push(s, s);
    }

    const whereStr = where.join(" AND ");
    const countRow = this.conn.get(
      `SELECT COUNT(*) as total FROM ${this.tableName} WHERE ${whereStr}`,
      params,
    );
    const total = countRow?.total || 0;
    const items = this.conn.all(
      `SELECT * FROM ${this.tableName} WHERE ${whereStr} ORDER BY code ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return { items, total };
  }

  getByCode(code, companyId) {
    return this.conn.get(
      `SELECT * FROM ${this.tableName} WHERE code = ? AND company_id = ? LIMIT 1`,
      [code, this._company(companyId)],
    );
  }

  // Prevent deletion of accounts that have journal lines
  canDelete(accountId, companyId) {
    const row = this.conn.get(
      `SELECT 1 FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       WHERE je.company_id = ? AND jel.account_id = ? LIMIT 1`,
      [this._company(companyId), accountId],
    );
    return !row;
  }

  getWithGroup(id, companyId) {
    return this.conn.get(
      `SELECT a.*, ag.code as group_code, ag.name as group_name, ag.type as group_type
       FROM ${this.tableName} a
       LEFT JOIN account_groups ag ON ag.id = a.account_group_id
       WHERE a.id = ? AND a.company_id = ? LIMIT 1`,
      [id, this._company(companyId)],
    );
  }

  // Get all accounts with their group info for tree building
  getTree(companyId) {
    const company = this._company(companyId);
    return this.conn.all(
      `SELECT a.*, ag.code as group_code, ag.name as group_name, ag.type as group_type
       FROM ${this.tableName} a
       LEFT JOIN account_groups ag ON ag.id = a.account_group_id
       WHERE a.company_id = ?
       ORDER BY a.code ASC`,
      [company],
    );
  }

  // Get all children of a given parent account
  getChildren(parentId, companyId) {
    const company = this._company(companyId);
    return this.conn.all(
      `SELECT a.*, ag.code as group_code, ag.name as group_name, ag.type as group_type
       FROM ${this.tableName} a
       LEFT JOIN account_groups ag ON ag.id = a.account_group_id
       WHERE a.parent_id = ? AND a.company_id = ?
       ORDER BY a.code ASC`,
      [parentId, company],
    );
  }

  // Get all descendant account IDs (recursive CTE for hierarchical queries)
  getDescendants(accountId, companyId) {
    const company = this._company(companyId);
    return this.conn.all(
      `WITH RECURSIVE descendants(id) AS (
        SELECT id FROM ${this.tableName} WHERE id = ? AND company_id = ?
        UNION ALL
        SELECT a.id FROM ${this.tableName} a
        JOIN descendants d ON a.parent_id = d.id
        WHERE a.company_id = ?
      )
      SELECT * FROM ${this.tableName}
      WHERE id IN (SELECT id FROM descendants) AND company_id = ?
      ORDER BY code ASC`,
      [accountId, company, company, company],
    );
  }

  // Check if parent change would create a circular hierarchy
  checkCircularHierarchy(accountId, parentId, companyId) {
    if (!parentId || parentId === accountId) return false;
    const descendants = this.getDescendants(accountId, companyId);
    return descendants.some((d) => d.id === parentId);
  }

  // Get a tree structure for the frontend (nested objects)
  getTreeNested(companyId, parentId = null) {
    const allAccounts = this.getTree(companyId);
    const accountMap = new Map();
    const rootAccounts = [];

    // Build map of all accounts
    allAccounts.forEach((acc) => {
      accountMap.set(acc.id, { ...acc, children: [] });
    });

    // Build hierarchy
    allAccounts.forEach((acc) => {
      const account = accountMap.get(acc.id);
      if (acc.parent_id && accountMap.has(acc.parent_id)) {
        const parent = accountMap.get(acc.parent_id);
        parent.children.push(account);
      } else {
        rootAccounts.push(account);
      }
    });

    // Recursively sort children by code
    const sortRecursive = (nodes) => {
      nodes.sort((a, b) => a.code.localeCompare(b.code));
      nodes.forEach((n) => {
        if (n.children && n.children.length) {
          sortRecursive(n.children);
        }
      });
    };
    sortRecursive(rootAccounts);

    return rootAccounts;
  }

  // Create opening balance journal entry
  createOpeningBalance(
    conn,
    companyId,
    accountId,
    amount,
    balanceType,
    entryDate,
    userId,
  ) {
    const { generateId } = require("../utils/generateId");
    const tx = conn.transaction(() => {
      const normalizedAmount = Number(amount);
      const normalizedBalanceType = String(balanceType || "").toUpperCase();
      if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
        throw new ValidationError(
          "Opening balance amount must be greater than zero",
        );
      }
      if (!["DEBIT", "CREDIT"].includes(normalizedBalanceType)) {
        throw new ValidationError(
          "Opening balance type must be DEBIT or CREDIT",
        );
      }

      // A posted opening balance must always include a valid, posting equity
      // counterpart. Fail the surrounding account transaction if none exists.
      const equityAccount = conn.get(
        `SELECT id FROM accounts
         WHERE company_id = ? AND type = 'EQUITY' AND is_active = 1
           AND (is_group = 0 OR is_group IS NULL)
           AND allow_direct_posting = 1
           AND id != ?
         ORDER BY code ASC, id ASC LIMIT 1`,
        [companyId, accountId],
      );
      if (!equityAccount) {
        throw new ValidationError(
          "A posting Equity account is required before creating an opening balance",
        );
      }

      // The application stores the company default in settings. Keep this lookup
      // here so opening-balance JEs follow the same currency as other documents.
      const currency =
        conn.get(
          `SELECT value FROM system_metadata WHERE key = 'default_currency' LIMIT 1`,
        )?.value || "INR";
      const now = new Date().toISOString();
      // Check if an opening balance voucher already exists
      const existing = conn.get(
        `SELECT v.id, je.id AS journal_entry_id FROM vouchers v
         JOIN journal_entries je ON je.voucher_id = v.id AND je.company_id = v.company_id
         WHERE v.reference_number = ? AND v.company_id = ? LIMIT 1`,
        [`OB-${accountId}`, companyId],
      );
      if (existing) {
        // Rebuild both legs. Updating just one amount leaves an old opposite
        // debit/credit behind when an opening balance changes sides.
        conn.run(
          `DELETE FROM journal_entry_lines WHERE journal_entry_id = ? AND company_id = ?`,
          [existing.journal_entry_id, companyId],
        );
        conn.run(
          `UPDATE vouchers SET voucher_date = ?, currency = ?, updated_at = ? WHERE id = ? AND company_id = ?`,
          [entryDate, currency, now, existing.id, companyId],
        );
        conn.run(
          `UPDATE journal_entries
           SET entry_date = ?, currency = ?, total_debit = ?, total_credit = ?, updated_at = ?
           WHERE id = ? AND company_id = ?`,
          [
            entryDate,
            currency,
            normalizedAmount,
            normalizedAmount,
            now,
            existing.journal_entry_id,
            companyId,
          ],
        );
        this._insertOpeningBalanceLines(
          conn,
          companyId,
          existing.journal_entry_id,
          accountId,
          equityAccount.id,
          normalizedAmount,
          normalizedBalanceType,
          now,
          generateId,
        );
      } else {
        const voucherId = generateId("vch");
        const jeId = generateId("je");
        conn.run(
          `INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, voucher_date,
            reference_number, description, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'JOURNAL', ?, ?, 'Opening balance for account', 'POSTED', ?, ?, ?)`,
          [
            voucherId,
            companyId,
            `OB-${generateId("num")}`,
            entryDate,
            "OB-" + accountId,
            userId,
            now,
            now,
          ],
        );
        conn.run(
          `INSERT INTO journal_entries (id, company_id, voucher_id, entry_number, entry_date,
            description, currency, exchange_rate, total_debit, total_credit, status, created_by, created_at, updated_at, posted_at, posted_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, ?, ?, 'POSTED', ?, ?, ?, ?, ?)`,
          [
            jeId,
            companyId,
            voucherId,
            `JE-OB-${generateId("num")}`,
            entryDate,
            "Opening balance for account",
            currency,
            normalizedAmount,
            normalizedAmount,
            userId,
            now,
            now,
            now,
            userId,
          ],
        );
        this._insertOpeningBalanceLines(
          conn,
          companyId,
          jeId,
          accountId,
          equityAccount.id,
          normalizedAmount,
          normalizedBalanceType,
          now,
          generateId,
        );
      }
    });
    return tx();
  }

  _insertOpeningBalanceLines(
    conn,
    companyId,
    journalEntryId,
    accountId,
    equityAccountId,
    amount,
    balanceType,
    now,
    generateId,
  ) {
    const accountDebit = balanceType === "DEBIT" ? amount : 0;
    const accountCredit = balanceType === "CREDIT" ? amount : 0;
    conn.run(
      `INSERT INTO journal_entry_lines (id, company_id, journal_entry_id, account_id,
        debit_amount, credit_amount, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Opening balance', ?)`,
      [
        generateId("jl"),
        companyId,
        journalEntryId,
        accountId,
        accountDebit,
        accountCredit,
        now,
      ],
    );
    conn.run(
      `INSERT INTO journal_entry_lines (id, company_id, journal_entry_id, account_id,
        debit_amount, credit_amount, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Opening balance offset', ?)`,
      [
        generateId("jl"),
        companyId,
        journalEntryId,
        equityAccountId,
        accountCredit,
        accountDebit,
        now,
      ],
    );
  }

  // Create default chart of accounts for a new company
  createDefaultChartOfAccounts(conn, companyId, userId) {
    const { generateId } = require("../utils/generateId");
    const now = new Date().toISOString();
    const tx = conn.transaction(() => {
      // Top-level account groups
      const groups = [
        {
          id: "ag_asset",
          code: "1000",
          name: "Assets",
          type: "ASSET",
          nature: "DEBIT",
          parent: null,
        },
        {
          id: "ag_liability",
          code: "2000",
          name: "Liabilities",
          type: "LIABILITY",
          nature: "CREDIT",
          parent: null,
        },
        {
          id: "ag_equity",
          code: "3000",
          name: "Equity",
          type: "EQUITY",
          nature: "CREDIT",
          parent: null,
        },
        {
          id: "ag_income",
          code: "4000",
          name: "Income",
          type: "INCOME",
          nature: "CREDIT",
          parent: null,
        },
        {
          id: "ag_expense",
          code: "5000",
          name: "Expenses",
          type: "EXPENSE",
          nature: "DEBIT",
          parent: null,
        },
      ];
      for (const g of groups) {
        conn.run(
          `INSERT OR IGNORE INTO account_groups (id, company_id, code, name, parent_id, type, debit_credit_nature, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            g.id,
            companyId,
            g.code,
            g.name,
            g.parent || null,
            g.type,
            g.nature,
            now,
            now,
          ],
        );
      }

      // Sub-groups
      const subGroups = [
        {
          id: "ag_current_asset",
          code: "1100",
          name: "Current Assets",
          type: "ASSET",
          nature: "DEBIT",
          parent: "ag_asset",
        },
        {
          id: "ag_non_current_asset",
          code: "1200",
          name: "Non-Current Assets",
          type: "ASSET",
          nature: "DEBIT",
          parent: "ag_asset",
        },
        {
          id: "ag_cash",
          code: "1110",
          name: "Cash",
          type: "ASSET",
          nature: "DEBIT",
          parent: "ag_current_asset",
        },
        {
          id: "ag_bank",
          code: "1120",
          name: "Bank Accounts",
          type: "ASSET",
          nature: "DEBIT",
          parent: "ag_current_asset",
        },
        {
          id: "ag_receivable",
          code: "1300",
          name: "Accounts Receivable",
          type: "ASSET",
          nature: "DEBIT",
          parent: "ag_current_asset",
        },
        {
          id: "ag_current_liability",
          code: "2100",
          name: "Current Liabilities",
          type: "LIABILITY",
          nature: "CREDIT",
          parent: "ag_liability",
        },
        {
          id: "ag_payable",
          code: "2110",
          name: "Accounts Payable",
          type: "LIABILITY",
          nature: "CREDIT",
          parent: "ag_current_liability",
        },
        {
          id: "ag_capital",
          code: "3100",
          name: "Owner's Capital",
          type: "EQUITY",
          nature: "CREDIT",
          parent: "ag_equity",
        },
        {
          id: "ag_retained",
          code: "3200",
          name: "Retained Earnings",
          type: "EQUITY",
          nature: "CREDIT",
          parent: "ag_equity",
        },
        {
          id: "ag_sales",
          code: "4100",
          name: "Sales",
          type: "INCOME",
          nature: "CREDIT",
          parent: "ag_income",
        },
        {
          id: "ag_service",
          code: "4200",
          name: "Service Income",
          type: "INCOME",
          nature: "CREDIT",
          parent: "ag_income",
        },
        {
          id: "ag_cogs",
          code: "5100",
          name: "Cost of Goods Sold",
          type: "EXPENSE",
          nature: "DEBIT",
          parent: "ag_expense",
        },
        {
          id: "ag_salaries",
          code: "5200",
          name: "Salaries",
          type: "EXPENSE",
          nature: "DEBIT",
          parent: "ag_expense",
        },
        {
          id: "ag_rent",
          code: "5300",
          name: "Rent",
          type: "EXPENSE",
          nature: "DEBIT",
          parent: "ag_expense",
        },
        {
          id: "ag_utilities",
          code: "5400",
          name: "Utilities",
          type: "EXPENSE",
          nature: "DEBIT",
          parent: "ag_expense",
        },
        {
          id: "ag_marketing",
          code: "5500",
          name: "Marketing",
          type: "EXPENSE",
          nature: "DEBIT",
          parent: "ag_expense",
        },
        {
          id: "ag_bank_charges",
          code: "5600",
          name: "Bank Charges",
          type: "EXPENSE",
          nature: "DEBIT",
          parent: "ag_expense",
        },
        {
          id: "ag_office",
          code: "5700",
          name: "Office Expenses",
          type: "EXPENSE",
          nature: "DEBIT",
          parent: "ag_expense",
        },
      ];
      for (const g of subGroups) {
        conn.run(
          `INSERT OR IGNORE INTO account_groups (id, company_id, code, name, parent_id, type, debit_credit_nature, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            g.id,
            companyId,
            g.code,
            g.name,
            g.parent,
            g.type,
            g.nature,
            now,
            now,
          ],
        );
      }

      // Default accounts (leaf accounts)
      const accounts = [
        {
          id: "acc_cash",
          code: "1110",
          name: "Cash in Hand",
          group: "ag_cash",
          type: "CASH",
          nature: "DEBIT",
          group_account: true,
        },
        {
          id: "acc_bank",
          code: "1120",
          name: "Bank Account",
          group: "ag_bank",
          type: "BANK",
          nature: "DEBIT",
          group_account: true,
        },
        {
          id: "acc_receivable",
          code: "1300",
          name: "Accounts Receivable",
          group: "ag_receivable",
          type: "ASSET",
          nature: "DEBIT",
          group_account: true,
        },
        {
          id: "acc_payable",
          code: "2110",
          name: "Accounts Payable",
          group: "ag_payable",
          type: "LIABILITY",
          nature: "CREDIT",
          group_account: true,
        },
        {
          id: "acc_capital",
          code: "3100",
          name: "Owner's Capital",
          group: "ag_capital",
          type: "EQUITY",
          nature: "CREDIT",
          group_account: true,
        },
        {
          id: "acc_retained",
          code: "3200",
          name: "Retained Earnings",
          group: "ag_retained",
          type: "EQUITY",
          nature: "CREDIT",
          group_account: true,
        },
        {
          id: "acc_sales",
          code: "4100",
          name: "Sales Revenue",
          group: "ag_sales",
          type: "INCOME",
          nature: "CREDIT",
          group_account: true,
        },
        {
          id: "acc_service",
          code: "4200",
          name: "Service Income",
          group: "ag_service",
          type: "INCOME",
          nature: "CREDIT",
          group_account: true,
        },
        {
          id: "acc_cogs",
          code: "5100",
          name: "Cost of Goods Sold",
          group: "ag_cogs",
          type: "EXPENSE",
          nature: "DEBIT",
          group_account: true,
        },
        {
          id: "acc_salaries",
          code: "5200",
          name: "Salaries Expense",
          group: "ag_salaries",
          type: "EXPENSE",
          nature: "DEBIT",
          group_account: true,
        },
        {
          id: "acc_rent",
          code: "5300",
          name: "Rent Expense",
          group: "ag_rent",
          type: "EXPENSE",
          nature: "DEBIT",
          group_account: true,
        },
        {
          id: "acc_utilities",
          code: "5400",
          name: "Utilities Expense",
          group: "ag_utilities",
          type: "EXPENSE",
          nature: "DEBIT",
          group_account: true,
        },
        {
          id: "acc_marketing",
          code: "5500",
          name: "Marketing Expense",
          group: "ag_marketing",
          type: "EXPENSE",
          nature: "DEBIT",
          group_account: true,
        },
        {
          id: "acc_bank_charges",
          code: "5600",
          name: "Bank Charges",
          group: "ag_bank_charges",
          type: "EXPENSE",
          nature: "DEBIT",
          group_account: true,
        },
        {
          id: "acc_office",
          code: "5700",
          name: "Office Expenses",
          group: "ag_office",
          type: "EXPENSE",
          nature: "DEBIT",
          group_account: true,
        },
      ];
      for (const a of accounts) {
        conn.run(
          `INSERT OR IGNORE INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, is_active, is_group, allow_direct_posting, reconciliation_required, opening_balance, opening_balance_type, opening_balance_date, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 1, 0, 0, 'DEBIT', ?, ?, datetime('now'), datetime('now'))`,
          [
            a.id,
            companyId,
            a.code,
            a.name,
            a.group,
            a.type,
            a.nature,
            null,
            "",
          ],
        );
      }
    });
    return tx();
  }

  // Get account summary for dashboard cards
  getAccountSummary(companyId) {
    const company = this._company(companyId);
    // Count ledger accounts by type
    const rows = this.conn.all(
      `SELECT type, COUNT(*) as count FROM ${this.tableName} WHERE company_id = ? AND (is_group = 0 OR is_group IS NULL) GROUP BY type`,
      [company],
    );
    // Count account groups by type
    const groupRows = this.conn.all(
      `SELECT type, COUNT(*) as count FROM account_groups WHERE company_id = ? GROUP BY type`,
      [company],
    );
    const summary = {
      total: 0,
      total_accounts: 0,
      total_groups: 0,
      ASSET: 0,
      LIABILITY: 0,
      EQUITY: 0,
      INCOME: 0,
      EXPENSE: 0,
      BANK: 0,
      CASH: 0,
      groups: 0,
    };
    rows.forEach((r) => {
      const type = r.type.toUpperCase();
      if (summary.hasOwnProperty(type)) summary[type] = r.count;
      summary.total_accounts += r.count;
    });
    groupRows.forEach((r) => {
      const type = r.type.toUpperCase();
      if (summary.hasOwnProperty(type)) summary[type] += r.count;
      summary.total_groups += r.count;
    });
    summary.total = summary.total_accounts + summary.total_groups;
    summary.groups = summary.total_groups;
    return summary;
  }

  // Get account balance from journal entries
  getBalance(accountId, companyId, asOfDate = null) {
    const company = this._company(companyId);
    const params = [accountId, company];
    let dateClause = "";
    if (asOfDate) {
      dateClause = " AND je.entry_date <= ?";
      params.push(asOfDate);
    }
    const result = this.conn.get(
      `SELECT
         COALESCE(SUM(CASE WHEN jel.credit_amount > 0 THEN -jel.credit_amount ELSE 0 END), 0) +
         COALESCE(SUM(CASE WHEN jel.debit_amount > 0 THEN jel.debit_amount ELSE 0 END), 0) AS net_change
       FROM journal_entry_lines jel
       JOIN journal_entries je ON jel.journal_entry_id = je.id
       WHERE jel.account_id = ? AND je.company_id = ? AND je.status = 'POSTED'${dateClause}`,
      params,
    );
    // Add opening balance
    const account = this.conn.get(
      `SELECT opening_balance FROM ${this.tableName} WHERE id = ? AND company_id = ?`,
      [accountId, company],
    );
    const openingBalance = parseFloat(account?.opening_balance || 0);
    return openingBalance + parseFloat(result?.net_change || 0);
  }
}

// Account group repository
class AccountGroupRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, "account_groups");
  }

  search(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const companyId = this._company(options.companyId);
    const where = ["company_id = ?"];
    const params = [companyId];

    if (options.type) {
      where.push("type = ?");
      params.push(options.type);
    }
    if (options.isActive !== undefined) {
      where.push("is_active = ?");
      params.push(options.isActive);
    }
    if (options.parentId !== undefined) {
      if (options.parentId === null) {
        where.push("(parent_id IS NULL OR parent_id = '')");
      } else {
        where.push("parent_id = ?");
        params.push(options.parentId);
      }
    }
    if (options.query) {
      const s = `%${options.query}%`;
      where.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)");
      params.push(s, s);
    }

    const whereStr = where.join(" AND ");
    const countRow = this.conn.get(
      `SELECT COUNT(*) as total FROM ${this.tableName} WHERE ${whereStr}`,
      params,
    );
    const total = countRow?.total || 0;
    const items = this.conn.all(
      `SELECT * FROM ${this.tableName} WHERE ${whereStr} ORDER BY type, code ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return { items, total };
  }

  getHierarchy(companyId) {
    return this.conn.all(
      `SELECT * FROM ${this.tableName} WHERE company_id = ? ORDER BY type, code ASC`,
      [this._company(companyId)],
    );
  }

  // Build nested tree of account groups
  getTreeNested(companyId) {
    const all = this.getHierarchy(companyId);
    const groupMap = new Map();
    const rootGroups = [];

    all.forEach((g) => {
      groupMap.set(g.id, { ...g, children: [] });
    });

    all.forEach((g) => {
      const group = groupMap.get(g.id);
      if (g.parent_id && groupMap.has(g.parent_id)) {
        groupMap.get(g.parent_id).children.push(group);
      } else {
        rootGroups.push(group);
      }
    });

    const sortRecursive = (nodes) => {
      nodes.sort((a, b) => a.code.localeCompare(b.code));
      nodes.forEach((n) => {
        if (n.children && n.children.length) sortRecursive(n.children);
      });
    };
    sortRecursive(rootGroups);

    return rootGroups;
  }
}

module.exports = { ChartOfAccountsRepository, AccountGroupRepository };
