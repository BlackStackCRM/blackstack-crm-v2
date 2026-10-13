const { getConn } = require("../utils/db");
const { evaluateFinancialYearLock } = require('../services/financial-year-policy.service');
const { generateId } = require("../utils/generateId");
const { successResponse, paginatedResponse } = require("../utils/response");
const { getPagination } = require("../utils/helpers");
const { assertTenantRefs } = require("../utils/tenantScope");
const { NotFoundError, ValidationError, AppError } = require("../utils/errors");
const {
  ChartOfAccountsRepository,
} = require("../repositories/chart-of-accounts.repository");
const {
  AccountGroupRepository,
} = require("../repositories/account-group.repository");
const {
  JournalEntryRepository,
} = require("../repositories/journal-entry.repository");
const { VoucherRepository } = require("../repositories/voucher.repository");
const { BillRepository } = require("../repositories/billing-cost.repository");
const {
  ReceivableRepository,
  PayableRepository,
} = require("../repositories/receivable.repository");
const { BudgetRepository } = require("../repositories/budget.repository");
const {
  CostCentreRepository,
} = require("../repositories/cost-centre.repository");
const { AccountGroupService } = require("../services/account-group.service");
const {
  OpeningBalanceRepository,
} = require("../repositories/opening-balance.repository");
const { TaxService } = require("../services/tax-calculation-engine");
const CodeGenerator = require("../services/code-generator.service");

const COST_CENTRE_FIELDS = ["code", "name", "description", "is_active"];
const VALID_ACCOUNT_TYPES = [
  "CASH",
  "BANK",
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "INCOME",
  "EXPENSE",
];
const VALID_CREDIT_RULES = ["ALLOWED", "BLOCKED", "WARN"];

function getCompanyId(req) {
  return req.user?.companyId || "default";
}

function logAudit(
  conn,
  companyId,
  userId,
  entity,
  entityId,
  action,
  oldValues = null,
  newValues = null,
) {
  try {
    const { generateId } = require("../utils/generateId");
    conn
      .prepare(
        `
      INSERT INTO accounting_audit (id, company_id, user_id, action, entity_type, entity_id, old_values_json, new_values_json, ip_address, session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `,
      )
      .run(
        generateId("aud"),
        companyId,
        userId || "system",
        action,
        entity,
        entityId,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        null,
        null,
      );
  } catch (e) {
    /* Audit logging should not break main operations */
  }
}

class AccountingController {
  constructor() {
    const conn = getConn();
    this.coaRepo = new ChartOfAccountsRepository(conn);
    this.groupRepo = new AccountGroupRepository(conn);
    this.journalRepo = new JournalEntryRepository(conn);
    this.voucherRepo = new VoucherRepository(conn);
    this.billRepo = new BillRepository(conn);
    this.receivableRepo = new ReceivableRepository(conn);
    this.payableRepo = new PayableRepository(conn);
    this.budgetRepo = new BudgetRepository(conn);
    this.costCentreRepo = new CostCentreRepository(conn);
    this.obRepo = new OpeningBalanceRepository(conn);
    this.taxService = new TaxService(conn);
  }

  // ─── Chart of Accounts ─────────────────────────────────────────────
  async listAccounts(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {};
      if (req.query.type) options.type = req.query.type;
      if (req.query.groupId) options.groupId = req.query.groupId;
      if (req.query.isGroup !== undefined)
        options.isGroup = req.query.isGroup === "true";
      if (req.query.active !== undefined)
        options.isActive = req.query.active === "true";
      if (req.query.parentId !== undefined) {
        options.parentId =
          req.query.parentId === "null" ? null : req.query.parentId;
      }
      if (req.query.q) options.query = req.query.q;
      options.limit = parseInt(req.query.limit) || 1000;
      options.offset =
        (parseInt(req.query.page || 1) - 1) *
        (parseInt(req.query.limit) || 1000);

      const result = this.coaRepo.search(options);
      const accounts = result.items.map((acc) => ({
        ...acc,
        account_group: this.coaRepo.conn.get(
          "SELECT * FROM account_groups WHERE id = ?",
          [acc.account_group_id],
        ),
        balance: this.coaRepo.getBalance(acc.id, companyId),
      }));
      res.json(
        successResponse({ items: accounts, total: result.total, accounts }),
      );
    } catch (err) {
      next(err);
    }
  }

  async listGLAccounts(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      // Return only valid POSTING accounts (not groups, allow_direct_posting = true, active)
      const accounts = this.coaRepo.conn.all(
        `SELECT id, code, name, type, is_active, allow_direct_posting FROM accounts
         WHERE company_id = ? AND (is_group = 0 OR is_group IS NULL)
           AND (allow_direct_posting = 1 OR allow_direct_posting IS NULL)
           AND is_active = 1
         ORDER BY code`,
        [companyId],
      );
      res.json(successResponse({ items: accounts, accounts }));
    } catch (err) {
      next(err);
    }
  }

  async getAccountTree(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const tree = this.groupRepo.getFullTree(companyId);
      const summary = this.coaRepo.getAccountSummary(companyId);
      res.json(successResponse({ tree, summary }));
    } catch (err) {
      next(err);
    }
  }

  async getAccountSummary(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const summary = this.coaRepo.getAccountSummary(companyId);
      res.json(successResponse(summary));
    } catch (err) {
      next(err);
    }
  }

  async getAccount(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const account = this.coaRepo.getWithGroup(req.params.id, companyId);
      if (!account) throw new NotFoundError("Account not found");
      const balance = this.coaRepo.getBalance(req.params.id, companyId);
      const txnCount = this.coaRepo.conn.get(
        "SELECT COUNT(*) as c FROM journal_entry_lines WHERE account_id = ?",
        [req.params.id],
      ).c;
      res.json(
        successResponse({
          ...account,
          current_balance: balance,
          transaction_count: txnCount,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async createDefaultCOA(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      this.coaRepo.createDefaultChartOfAccounts(
        this.coaRepo.conn,
        companyId,
        req.user?.userId || "system",
      );
      const summary = this.coaRepo.getAccountSummary(companyId);
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "account",
        "default",
        "CREATE_DEFAULT_COA",
        null,
        { summary },
      );
      res.status(201).json(
        successResponse({
          message: "Default Chart of Accounts created",
          summary,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async importAccounts(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { accounts } = req.body;
      if (!accounts || !Array.isArray(accounts))
        throw new ValidationError("accounts array is required");
      const results = { created: 0, updated: 0, errors: [] };
      for (const row of accounts) {
        try {
          if (!row.code || !row.name || !row.type) {
            results.errors.push({
              row: row.code || "unknown",
              error: "code, name, and type are required",
            });
            continue;
          }
          const existing = this.coaRepo.getByCode(row.code, companyId);
          if (existing) {
            const upd = {};
            for (const k of [
              "name",
              "type",
              "account_group_id",
              "parent_id",
              "is_group",
              "allow_direct_posting",
              "reconciliation_required",
              "opening_balance",
              "opening_balance_type",
              "opening_balance_date",
              "description",
              "is_active",
            ]) {
              if (row[k] !== undefined) upd[k] = row[k];
            }
            if (Object.keys(upd).length > 0) {
              const setClause = Object.keys(upd)
                .map((k) => `${k} = ?`)
                .join(", ");
              this.coaRepo.conn
                .prepare(
                  `UPDATE accounts SET ${setClause}, updated_at = datetime('now') WHERE id = ?`,
                )
                .run(...Object.values(upd), existing.id);
            }
            results.updated++;
          } else {
            const id = generateId("acc");
            const debitCreditNature =
              row.debit_credit_nature ||
              (row.type === "LIABILITY" ||
              row.type === "EQUITY" ||
              row.type === "INCOME"
                ? "CREDIT"
                : "DEBIT");
            this.coaRepo.conn
              .prepare(
                `
              INSERT INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature,
                description, is_active, parent_id, is_group, allow_direct_posting,
                reconciliation_required, opening_balance, opening_balance_type, opening_balance_date,
                created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            `,
              )
              .run(
                id,
                companyId,
                row.code,
                row.name,
                row.account_group_id || null,
                row.type,
                debitCreditNature,
                row.description || "",
                row.is_active !== undefined ? row.is_active : 1,
                row.parent_id || null,
                row.is_group || false,
                row.allow_direct_posting !== undefined
                  ? row.allow_direct_posting
                  : 1,
                row.reconciliation_required || false,
                row.opening_balance || 0,
                row.opening_balance_type || "DEBIT",
                row.opening_balance_date || null,
              );
            results.created++;
          }
        } catch (e) {
          results.errors.push({ row: row.code, error: e.message });
        }
      }
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "account",
        "import",
        "ACCOUNT_IMPORTED",
        null,
        results,
      );
      res.json(successResponse({ message: "Import complete", results }));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Preview the next auto-generated code for an entity type.
   * GET /api/accounting/codes/preview?entity=ACCOUNT_GROUP
   * Non-consuming: the final code is re-generated (and re-validated) by the
   * backend at create time — the preview is display-only.
   */
  async getNextCode(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const entity = String(req.query.entity || "").toUpperCase();
      if (!CodeGenerator.ENTITIES[entity])
        throw new ValidationError("Unknown entity type for code preview");
      const code = CodeGenerator.preview(
        this.coaRepo.conn,
        entity,
        companyId,
      );
      res.json(successResponse({ entity, code }));
    } catch (err) {
      next(err);
    }
  }

  async createAccount(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const {
        code,
        name,
        type,
        description,
        is_active = true,
        account_group_id,
        parent_id,
        reconciliation_required = false,
        opening_balance = 0,
        opening_balance_type = "DEBIT",
        opening_balance_date = null,
      } = req.body;
      const normalizedCode = typeof code === "string" ? code.trim() : "";
      const normalizedName = typeof name === "string" ? name.trim() : "";
      const normalizedType = typeof type === "string" ? type.trim() : "";
      const normalizedGroupId =
        typeof account_group_id === "string"
          ? account_group_id.trim()
          : account_group_id;
      const normalizedParentId =
        typeof parent_id === "string" ? parent_id.trim() : parent_id;
      const normalizedBalanceType =
        typeof opening_balance_type === "string"
          ? opening_balance_type.trim().toUpperCase()
          : "";
      const normalizedOpeningBalance = Number(opening_balance);
      // Account Code is system-generated. A blank/absent code is generated
      // server-side; a client-supplied code is honoured but must be unique.
      let resolvedCode = normalizedCode;
      if (!resolvedCode) {
        resolvedCode = CodeGenerator.generate(
          this.coaRepo.conn,
          "LEDGER_ACCOUNT",
          companyId,
        );
      }
      if (!resolvedCode || !normalizedName || !normalizedType)
        throw new ValidationError("name, and type are required");
      if (
        !Number.isFinite(normalizedOpeningBalance) ||
        normalizedOpeningBalance < 0
      ) {
        throw new ValidationError(
          "opening_balance must be a non-negative number",
        );
      }
      if (!["DEBIT", "CREDIT"].includes(normalizedBalanceType)) {
        throw new ValidationError(
          "opening_balance_type must be DEBIT or CREDIT",
        );
      }
      if (!VALID_ACCOUNT_TYPES.includes(normalizedType)) {
        // Allow custom account types from the account_types table
        const customType = this.coaRepo.conn.get(
          "SELECT name FROM account_types WHERE company_id = ? AND UPPER(name) = UPPER(?) AND is_active = 1",
          [companyId, normalizedType],
        );
        if (!customType) throw new ValidationError("Invalid account type");
      }

      // This endpoint creates posting ledgers only. Groups and system accounts are seeded
      // or created through their dedicated flow, never from client-controlled fields.
      const isGroup = false;
      const canPost = true;
      if (!normalizedGroupId)
        throw new ValidationError(
          "account_group_id is required for ledger accounts",
        );

      // Check for duplicate code
      const existing = this.coaRepo.getByCode(resolvedCode, companyId);
      if (existing)
        throw new ValidationError(
          `Account code ${resolvedCode} already exists`,
        );

      // A parent account must be a compatible account in this company.
      // BANK/CASH are subtypes of ASSET, so those may sit under an ASSET parent.
      if (normalizedParentId) {
        const parent = this.coaRepo.findById(normalizedParentId, companyId);
        if (!parent) throw new ValidationError("Parent account not found");
        const parentTypeMap = { BANK: "ASSET", CASH: "ASSET" };
        const parentBase = parentTypeMap[parent.type] || parent.type;
        const childBase = parentTypeMap[normalizedType] || normalizedType;
        if (parentBase !== childBase)
          throw new ValidationError(
            "Parent account must have the same account type",
          );
      }

      const id = generateId("acc");
      // Prevent circular hierarchy - account cannot be its own parent
      if (normalizedParentId && normalizedParentId === id)
        throw new ValidationError("Account cannot be its own parent");

      // ── Account Type → Account Group dependency validation ──
      // Ledger accounts must belong to a group whose type matches (or is a subtype of) the account type.
      // This enforces: a LIABILITY ledger cannot be placed under an ASSET group.
      if (isGroup === false) {
        const group = this.groupRepo.findById(normalizedGroupId, companyId);
        if (!group) {
          throw new ValidationError(
            "Account Group not found or does not belong to this company",
          );
        }
        // Type compatibility: the group's type must match the account type,
        // or the account is a subtype (BANK/CASH are subtypes of ASSET).
        const typeMap = { BANK: "ASSET", CASH: "ASSET" };
        const accountTypeBase = typeMap[normalizedType] || normalizedType;
        const groupTypeBase = typeMap[group.type] || group.type;
        if (groupTypeBase !== accountTypeBase) {
          // For custom (non-built-in) account types, validate via nature (DEBIT/CREDIT)
          const isCustomType = !VALID_ACCOUNT_TYPES.includes(normalizedType);
          if (isCustomType) {
            const customTypeInfo = this.coaRepo.conn.get(
              "SELECT debit_credit_nature FROM account_types WHERE company_id = ? AND UPPER(name) = UPPER(?) AND is_active = 1",
              [companyId, normalizedType],
            );
            if (!customTypeInfo)
              throw new ValidationError("Account type not found");
            const groupNature = this._getTypeNature(groupTypeBase);
            if (customTypeInfo.debit_credit_nature !== groupNature) {
              throw new ValidationError(
                `Account Type "${normalizedType}" is incompatible with Account Group "${group.name}" (type: ${group.type}). ` +
                  `The group's type must match or be a parent type of the ledger account.`,
              );
            }
          } else {
            throw new ValidationError(
              `Account Type "${normalizedType}" is incompatible with Account Group "${group.name}" (type: ${group.type}). ` +
                `The group's type must match or be a parent type of the ledger account.`,
            );
          }
        }
      }

      // ── Nature auto-derivation from Account Type ──
      // Unless the client explicitly overrides, derive the debit_credit_nature from the type.
      const derivedNature = this._getAccountTypeNature(
        normalizedType,
        companyId,
      );
      // The nature is an invariant of the selected type, so for opening balances
      // the client-specified side must match the derived nature — but only when
      // the client explicitly sent a non-default value. When opening_balance is 0
      // the opening_balance_type is irrelevant and must not block creation.
      const clientSentBalanceType = req.body.opening_balance_type !== undefined;
      if (
        normalizedOpeningBalance > 0 &&
        clientSentBalanceType &&
        normalizedBalanceType !== derivedNature
      ) {
        throw new ValidationError(
          `opening_balance_type must be ${derivedNature} for ${normalizedType} accounts`,
        );
      }
      // Nature is an invariant of the selected type; do not let client input
      // create a ledger whose normal balance contradicts its account type.
      const debitCreditNature = derivedNature;
      try {
        // ── Wrap account creation + opening balance in a transaction for atomicity ──
        const tx = this.coaRepo.conn.transaction(() => {
          this.coaRepo.conn
            .prepare(
              `
          INSERT INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature,
            description, is_active, parent_id, is_group, allow_direct_posting,
            reconciliation_required, opening_balance, opening_balance_type, opening_balance_date,
            is_system, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `,
            )
            .run(
              id,
              companyId,
              resolvedCode,
              normalizedName,
              normalizedGroupId,
              normalizedType,
              debitCreditNature,
              description || "",
              is_active ? 1 : 0,
              normalizedParentId || null,
              0,
              1,
              reconciliation_required === true ||
                reconciliation_required === "true" ||
                reconciliation_required === "on" ||
                reconciliation_required === 1
                ? 1
                : 0,
              normalizedOpeningBalance,
              normalizedBalanceType,
              opening_balance_date || null,
              0,
            );
          // Create opening balance journal entry if opening_balance > 0
          if (normalizedOpeningBalance > 0) {
            this.coaRepo.createOpeningBalance(
              this.coaRepo.conn,
              companyId,
              id,
              normalizedOpeningBalance,
              normalizedBalanceType,
              opening_balance_date || new Date().toISOString().slice(0, 10),
              req.user?.userId || "system",
            );
          }
        });
        tx();
      } catch (e) {
        if (e.code === "SQLITE_CONSTRAINT_UNIQUE")
          throw new ValidationError(
            `Account code ${resolvedCode} already exists`,
          );
        throw e;
      }

      const account = this.coaRepo.conn.get(
        "SELECT * FROM accounts WHERE id = ?",
        [id],
      );
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "account",
        id,
        "CREATE",
        null,
        account,
      );
      const obEntry =
        normalizedOpeningBalance > 0
          ? { amount: normalizedOpeningBalance, type: normalizedBalanceType }
          : null;
      res
        .status(201)
        .json(successResponse({ ...account, opening_balance_entry: obEntry }));
    } catch (err) {
      next(err);
    }
  }

  async updateAccount(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const account = this.coaRepo.conn.get(
        "SELECT * FROM accounts WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!account) throw new NotFoundError("Account not found");

      // Prevent modification of critical fields on protected/system accounts
      if (account.is_system === 1) {
        const protectedFields = [
          "code",
          "type",
          "account_group_id",
          "debit_credit_nature",
          "parent_id",
          "is_group",
          "allow_direct_posting",
          "is_system",
        ];
        for (const field of protectedFields) {
          if (
            req.body[field] !== undefined &&
            req.body[field] !== account[field]
          ) {
            throw new ValidationError(
              `Cannot modify critical field "${field}" on a protected/system account.`,
            );
          }
        }
      }

      const updates = {};
      for (const field of [
        "code",
        "name",
        "type",
        "description",
        "is_active",
        "account_group_id",
        "parent_id",
        "is_group",
        "allow_direct_posting",
        "reconciliation_required",
        "opening_balance",
        "opening_balance_type",
        "opening_balance_date",
        "debit_credit_nature",
      ]) {
        if (req.body[field] !== undefined) updates[field] = req.body[field];
      }

      if (updates.code !== undefined) {
        updates.code = String(updates.code).trim();
        if (!updates.code)
          throw new ValidationError("Account code cannot be empty");
      }
      if (updates.name !== undefined) {
        updates.name = String(updates.name).trim();
        if (!updates.name)
          throw new ValidationError("Account name cannot be empty");
      }

      if (updates.code && updates.code !== account.code) {
        const existing = this.coaRepo.conn.get(
          "SELECT id FROM accounts WHERE code = ? AND company_id = ? AND id != ?",
          [updates.code, companyId, account.id],
        );
        if (existing)
          throw new ValidationError(
            `Account code ${updates.code} already exists`,
          );
      }

      // ── Protected/system accounts: only non-critical fields may change ──
      if (account.is_system === 1) {
        const critical = ["type", "account_group_id", "code", "is_group", "debit_credit_nature"];
        const attempted = critical.filter((k) =>
          updates.hasOwnProperty(k) && updates[k] !== account[k],
        );
        if (attempted.length > 0)
          throw new ValidationError(
            `Cannot modify critical field(s) of a protected/system account: ${attempted.join(", ")}`,
          );
      }

      // Enforce: Account Groups (is_group=true) must have allow_direct_posting=false
      if (
        updates.is_group === true ||
        updates.is_group === "true" ||
        updates.is_group === 1
      ) {
        updates.allow_direct_posting = false;
      }
      // Normalize boolean fields to integers for SQLite binding
      // (frontend sends JS booleans, DB expects 0/1)
      if (updates.hasOwnProperty("is_group")) {
        updates.is_group =
          updates.is_group === true ||
          updates.is_group === "true" ||
          updates.is_group === 1
            ? 1
            : 0;
      }
      if (updates.hasOwnProperty("is_active")) {
        updates.is_active =
          updates.is_active === 1 ||
          updates.is_active === "1" ||
          updates.is_active === true
            ? 1
            : 0;
      }
      if (updates.hasOwnProperty("allow_direct_posting")) {
        updates.allow_direct_posting =
          updates.allow_direct_posting === 1 ||
          updates.allow_direct_posting === "1" ||
          updates.allow_direct_posting === true
            ? 1
            : 0;
      }
      if (updates.hasOwnProperty("reconciliation_required")) {
        updates.reconciliation_required =
          updates.reconciliation_required === 1 ||
          updates.reconciliation_required === "1" ||
          updates.reconciliation_required === "on" ||
          updates.reconciliation_required === true
            ? 1
            : 0;
      }
      // Prevent changing is_group on an account that has transactions
      const usageCount = this.coaRepo.conn.get(
        "SELECT COUNT(*) as c FROM journal_entry_lines WHERE account_id = ?",
        [account.id],
      ).c;
      // Only block if the is_group value is actually being changed —
      // the frontend always sends is_group: false for ledgers, which is
      // the same as the DB value 0. Normalize to boolean for comparison.
      const newIsGroup = !!(
        updates.is_group === true ||
        updates.is_group === "true" ||
        updates.is_group === 1
      );
      const existingIsGroup = !!account.is_group;
      if (
        usageCount > 0 &&
        updates.hasOwnProperty("is_group") &&
        newIsGroup !== existingIsGroup
      ) {
        throw new ValidationError(
          "Cannot change account type on an account with transactions",
        );
      }
      if (updates.parent_id) {
        if (updates.parent_id === account.id)
          throw new ValidationError("Account cannot be its own parent");
        if (
          this.coaRepo.checkCircularHierarchy(
            account.id,
            updates.parent_id,
            companyId,
          )
        ) {
          throw new ValidationError(
            "Parent cannot be a descendant of this account (circular reference)",
          );
        }
      }

      // ── Account Type → Account Group dependency validation on update ──
      // If the account is a ledger (is_group=false) and either type or account_group_id is changing,
      // validate type compatibility between the account type and the group it belongs to.
      const accountIsGroup = updates.hasOwnProperty("is_group")
        ? updates.is_group === true ||
          updates.is_group === "true" ||
          updates.is_group === 1
        : account.is_group === 1;
      if (!accountIsGroup) {
        const newType = updates.type || account.type;
        const newGroupId =
          updates.account_group_id !== undefined
            ? updates.account_group_id
            : account.account_group_id;
        if (newGroupId && newType) {
          const group = this.groupRepo.findById(newGroupId, companyId);
          if (!group) {
            throw new ValidationError(
              "Account Group not found or does not belong to this company",
            );
          }
          // Type compatibility: BANK/CASH are subtypes of ASSET
          const typeMap = { BANK: "ASSET", CASH: "ASSET" };
          const accountTypeBase = typeMap[newType] || newType;
          const groupTypeBase = typeMap[group.type] || group.type;
          if (groupTypeBase !== accountTypeBase) {
            // For custom (non-built-in) account types, validate via nature (DEBIT/CREDIT)
            const isCustomType = !VALID_ACCOUNT_TYPES.includes(newType);
            if (isCustomType) {
              const customTypeInfo = this.coaRepo.conn.get(
                "SELECT debit_credit_nature FROM account_types WHERE company_id = ? AND UPPER(name) = UPPER(?) AND is_active = 1",
                [companyId, newType],
              );
              if (!customTypeInfo)
                throw new ValidationError("Account type not found");
              const groupNature = this._getTypeNature(groupTypeBase);
              if (customTypeInfo.debit_credit_nature !== groupNature) {
                throw new ValidationError(
                  `Account Type "${newType}" is incompatible with Account Group "${group.name}" (type: ${group.type}).`,
                );
              }
              // Nature matches — compatible, allow it
            } else {
              throw new ValidationError(
                `Account Type "${newType}" is incompatible with Account Group "${group.name}" (type: ${group.type}).`,
              );
            }
          }
        }
      }

      // ── Prevent changing account type/group on accounts with existing transactions ──
      if (usageCount > 0) {
        if (updates.hasOwnProperty("type") && updates.type !== account.type) {
          throw new ValidationError(
            "Cannot change Account Type of a ledger that has posted transactions. Reclassification workflow required.",
          );
        }
        if (
          updates.hasOwnProperty("account_group_id") &&
          updates.account_group_id !== account.account_group_id
        ) {
          throw new ValidationError(
            "Cannot change Account Group of a ledger that has posted transactions. Reclassification workflow required.",
          );
        }
        if (
          updates.hasOwnProperty("debit_credit_nature") &&
          updates.debit_credit_nature !== account.debit_credit_nature
        ) {
          throw new ValidationError(
            "Cannot change Debit/Credit Nature of a ledger that has posted transactions.",
          );
        }
      }

      // ── Nature auto-derivation from Account Type ──
      if (updates.type && !updates.debit_credit_nature) {
        updates.debit_credit_nature = this._getAccountTypeNature(
          updates.type,
          companyId,
        );
      }

      if (Object.keys(updates).length > 0) {
        const setClause = Object.keys(updates)
          .map((k) => `${k} = ?`)
          .join(", ");
        const values = Object.values(updates);
        this.coaRepo.conn
          .prepare(
            `UPDATE accounts SET ${setClause}, updated_at = datetime('now') WHERE id = ?`,
          )
          .run(...values, account.id);
      }

      const updated = this.coaRepo.conn.get(
        "SELECT * FROM accounts WHERE id = ?",
        [account.id],
      );
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "account",
        account.id,
        "UPDATE",
        account,
        updated,
      );
      res.json(successResponse(updated));
    } catch (err) {
      next(err);
    }
  }

  async deleteAccount(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const account = this.coaRepo.conn.get(
        "SELECT * FROM accounts WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!account) throw new NotFoundError("Account not found");

      // Prevent deletion of protected/system ledger accounts
      if (account.is_system === 1) {
        throw new AppError(
          "Cannot delete a protected/system account. Deactivate it instead.",
          "ACCOUNT_PROTECTED",
          400,
        );
      }

      const usageCount = this.coaRepo.conn.get(
        "SELECT COUNT(*) as count FROM journal_entry_lines WHERE account_id = ?",
        [account.id],
      );
      if (usageCount.count > 0)
        throw new AppError(
          "Cannot delete an account that has accounting transactions. Deactivate it instead.",
          "ACCOUNT_IN_USE",
          400,
        );

      this.coaRepo.conn
        .prepare("DELETE FROM accounts WHERE id = ?")
        .run(account.id);
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "account",
        account.id,
        "DELETE",
        account,
        null,
      );
      res.json(successResponse({ message: "Account deleted" }));
    } catch (err) {
      next(err);
    }
  }

  async exportAccounts(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.coaRepo.search({
        companyId,
        limit: 10000,
        isActive: req.query.active !== "false",
      });
      const accounts = result.items.map((acc) => ({
        code: acc.code,
        name: acc.name,
        type: acc.type,
        account_group_id: acc.account_group_id,
        parent_id: acc.parent_id,
        is_group: !!acc.is_group,
        allow_direct_posting: !!acc.allow_direct_posting,
        reconciliation_required: !!acc.reconciliation_required,
        opening_balance: acc.opening_balance,
        opening_balance_type: acc.opening_balance_type,
        opening_balance_date: acc.opening_balance_date,
        description: acc.description,
        is_active: !!acc.is_active,
      }));
      if (req.query.format === "csv" || req.query.download === "true") {
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          "attachment; filename=chart-of-accounts.csv",
        );
        const header =
          "Code,Name,Type,Account Group ID,Parent ID,Is Group,Allow Direct Posting,Reconciliation Required,Opening Balance,Opening Balance Type,Opening Balance Date,Description,Status\n";
        const csv =
          header +
          accounts
            .map((a) =>
              [
                a.code,
                a.name,
                a.type,
                a.account_group_id || "",
                a.parent_id || "",
                a.is_group ? "Yes" : "No",
                a.allow_direct_posting ? "Yes" : "No",
                a.reconciliation_required ? "Yes" : "No",
                a.opening_balance,
                a.opening_balance_type,
                a.opening_balance_date || "",
                `"${(a.description || "").replace(/"/g, '""')}"`,
                a.is_active ? "Active" : "Inactive",
              ].join(","),
            )
            .join("\n");
        res.send(csv);
      } else {
        res.json(successResponse({ accounts, total: accounts.length }));
      }
    } catch (err) {
      next(err);
    }
  }

  // ─── Account Types ─────────────────────────────────────────────────
  async listAccountTypes(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      // Built-in account types are always available
      const builtInTypes = [
        {
          name: "ASSET",
          label: "Asset",
          debit_credit_nature: "DEBIT",
          is_builtin: true,
        },
        {
          name: "LIABILITY",
          label: "Liability",
          debit_credit_nature: "CREDIT",
          is_builtin: true,
        },
        {
          name: "EQUITY",
          label: "Equity",
          debit_credit_nature: "CREDIT",
          is_builtin: true,
        },
        {
          name: "INCOME",
          label: "Income",
          debit_credit_nature: "CREDIT",
          is_builtin: true,
        },
        {
          name: "EXPENSE",
          label: "Expense",
          debit_credit_nature: "DEBIT",
          is_builtin: true,
        },
        {
          name: "BANK",
          label: "Bank",
          debit_credit_nature: "DEBIT",
          is_builtin: true,
        },
        {
          name: "CASH",
          label: "Cash",
          debit_credit_nature: "DEBIT",
          is_builtin: true,
        },
      ];
      // Fetch custom account types from the database
      const customTypes = this.coaRepo.conn.all(
        "SELECT name, description, debit_credit_nature, is_active FROM account_types WHERE company_id = ? AND is_active = 1 ORDER BY name",
        [companyId],
      );
      const allTypes = builtInTypes
        .map((t) => ({
          ...t,
          name: t.name,
          label: t.label,
          debit_credit_nature: t.debit_credit_nature,
        }))
        .concat(
          customTypes.map((t) => ({
            name: t.name,
            label: t.name,
            description: t.description,
            debit_credit_nature: t.debit_credit_nature,
            is_builtin: false,
          })),
        );
      res.json(successResponse({ types: allTypes }));
    } catch (err) {
      next(err);
    }
  }

  async createAccountType(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { name, description, debit_credit_nature } = req.body;
      if (!name || typeof name !== "string" || name.trim() === "") {
        throw new ValidationError("Account Type Name is required");
      }
      const trimmedName = name.trim().toUpperCase();
      // Check against built-in types
      const builtInTypes = [
        "ASSET",
        "LIABILITY",
        "EQUITY",
        "INCOME",
        "EXPENSE",
        "BANK",
        "CASH",
      ];
      if (builtInTypes.includes(trimmedName)) {
        throw new ValidationError(
          `"${trimmedName}" is a built-in account type and cannot be duplicated`,
        );
      }
      // Check for existing custom type with the same name
      const existing = this.coaRepo.conn.get(
        "SELECT id FROM account_types WHERE company_id = ? AND UPPER(name) = UPPER(?)",
        [companyId, trimmedName],
      );
      if (existing) {
        throw new ValidationError(
          `An account type named "${trimmedName}" already exists`,
        );
      }
      const id = generateId("atype");
      const nature = (debit_credit_nature || "DEBIT").toUpperCase();
      this.coaRepo.conn
        .prepare(
          `
        INSERT INTO account_types (id, company_id, name, description, debit_credit_nature, is_active, is_builtin, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, 0, datetime('now'), datetime('now'))
      `,
        )
        .run(id, companyId, trimmedName, description || "", nature);
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "account_type",
        id,
        "CREATE",
        null,
        { name: trimmedName, debit_credit_nature: nature },
      );
      const created = this.coaRepo.conn.get(
        "SELECT * FROM account_types WHERE id = ?",
        [id],
      );
      res.status(201).json(
        successResponse({
          type: {
            name: created.name,
            label: created.name,
            debit_credit_nature: created.debit_credit_nature,
            is_builtin: false,
          },
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  // ─── Helper: Map account type to DEBIT/CREDIT nature ──────────────
  _getTypeNature(type) {
    const CREDIT_TYPES = ["LIABILITY", "EQUITY", "INCOME"];
    return CREDIT_TYPES.includes(type) ? "CREDIT" : "DEBIT";
  }

  _getAccountTypeNature(type, companyId) {
    if (VALID_ACCOUNT_TYPES.includes(type)) return this._getTypeNature(type);
    const customType = this.coaRepo.conn.get(
      "SELECT debit_credit_nature FROM account_types WHERE company_id = ? AND UPPER(name) = UPPER(?) AND is_active = 1",
      [companyId, type],
    );
    if (!customType) throw new ValidationError("Account type not found");
    return customType.debit_credit_nature;
  }

  // ─── Journal Entries ─────────────
  async listJournalEntries(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {
        companyId,
        page: parseInt(req.query.page) || 1,
        limit: parseInt(req.query.limit) || 50,
        status: req.query.status,
        from: req.query.from,
        to: req.query.to,
      };
      const result = this.journalRepo.search({
        companyId,
        limit: parseInt(req.query.limit) || 50,
        status: req.query.status,
        startDate: req.query.from,
        endDate: req.query.to,
      });
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getJournalEntry(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const je = this.journalRepo.getWithLines(req.params.id, companyId);
      if (!je || !je.id) throw new NotFoundError("Journal entry not found");
      res.json(successResponse(je));
    } catch (err) {
      next(err);
    }
  }

  // ─── Vouchers ──────────────────────────────────────────────────────
  async listVouchers(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {
        companyId,
        voucherType: req.query.type,
        status: req.query.status,
        limit: parseInt(req.query.limit) || 50,
        startDate: req.query.from,
        endDate: req.query.to,
        query: req.query.q,
      };
      const result = this.voucherRepo.search(options);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getVoucher(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = await this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher) throw new NotFoundError("Voucher not found");
      res.json(successResponse(voucher));
    } catch (err) {
      next(err);
    }
  }

  // ─── Bills ─────────────────────────────────────────────────────────
  async listBills(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {
        companyId,
        type: req.query.type,
        status: req.query.status,
        page: parseInt(req.query.page) || 1,
        limit: parseInt(req.query.limit) || 50,
        from: req.query.from,
        to: req.query.to,
        q: req.query.q,
      };
      const result = await this.billRepo.search(options);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getBill(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const bill = await this.billRepo.findById(req.params.id, companyId);
      if (!bill) throw new NotFoundError("Bill not found");
      const items = this.billRepo.conn.all(
        "SELECT * FROM bill_items WHERE bill_id = ?",
        [bill.id],
      );
      res.json(successResponse({ ...bill, items }));
    } catch (err) {
      next(err);
    }
  }

  // ─── Receivables ───────────────────────────────────────────────────
  async listReceivables(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {
        companyId,
        contactId: req.query.contact_id,
        status: req.query.status,
        page: parseInt(req.query.page) || 1,
        limit: parseInt(req.query.limit) || 50,
        from: req.query.from,
        to: req.query.to,
      };
      const result = this.receivableRepo.search(options);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getAging(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const receivableAging = this.receivableRepo.getAgingSummary(companyId);
      const payableAging = this.payableRepo.getAgingSummary(companyId);
      res.json(
        successResponse({
          receivables: receivableAging,
          payables: payableAging,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async listPayables(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {
        companyId,
        organizationId: req.query.organization_id,
        status: req.query.status,
        limit: parseInt(req.query.limit) || 50,
        startDate: req.query.from,
        endDate: req.query.to,
      };
      const result = this.payableRepo.search(options);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ─── Budgets ───────────────────────────────────────────────────────
  async listBudgets(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = await this.budgetRepo.findWithLines({
        companyId,
        page: parseInt(req.query.page) || 1,
        limit: parseInt(req.query.limit) || 50,
      });
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async createBudget(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { name, financial_year_id, budget_type, is_active, lines } =
        req.body;
      if (!name || !financial_year_id)
        throw new ValidationError("name and financial_year_id are required");

      const id = generateId("bud");
      const insertBudget = this.budgetRepo.conn.prepare(`
        INSERT INTO budgets (id, company_id, name, financial_year_id, budget_type, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
      `);
      insertBudget.run(
        id,
        companyId,
        name,
        financial_year_id,
        budget_type || "EXPENSE",
      );

      const insertLine = this.budgetRepo.conn.prepare(`
        INSERT INTO budget_lines (id, budget_id, company_id, account_id, cost_centre_id, period, period_start, period_end, budget_amount, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      const insertLineTx = this.budgetRepo.conn.transaction((linesArr) => {
        linesArr.forEach((l) => {
          const params = [
            generateId("bln"),
            id,
            companyId,
            l.account_id || null,
            l.cost_centre_id || null,
            l.period || "FY",
            l.period || "FY",
            l.period || "FY",
            l.budget_amount || 0,
          ];
          insertLine.run(...params);
        });
      });
      insertLineTx(lines || []);

      const budget = this.budgetRepo.conn.get(
        "SELECT * FROM budgets WHERE id = ?",
        [id],
      );
      res.status(201).json(successResponse(budget));
    } catch (err) {
      next(err);
    }
  }

  // ─── Cost Centres ──────────────────────────────────────────────────
  async listCostCentres(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.costCentreRepo.list(companyId, {
        limit: parseInt(req.query.limit) || 50,
        orderBy: "code",
        orderDir: "ASC",
      });
      // Apply active filter
      const activeOnly = req.query.active !== "false";
      const items = activeOnly
        ? result.filter((a) => a.is_active !== 0)
        : result;
      res.json(
        successResponse({ items, total: items.length, costCentres: items }),
      );
    } catch (err) {
      next(err);
    }
  }

  async createCostCentre(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { code, name, description, parent_id } = req.body;
      // Cost centre code is system-generated when not supplied.
      let resolvedCode = typeof code === "string" ? code.trim() : "";
      if (!resolvedCode) {
        resolvedCode = CodeGenerator.generate(
          this.costCentreRepo.conn,
          "COST_CENTRE",
          companyId,
        );
      }
      if (!name) throw new ValidationError("name is required");

      const id = generateId("cc");
      try {
        this.costCentreRepo.conn
          .prepare(
            `
          INSERT INTO cost_centres (id, company_id, code, name, description, parent_id, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
        `,
          )
          .run(id, companyId, resolvedCode, name, description || "", parent_id || null);
      } catch (e) {
        if (e.code === "SQLITE_CONSTRAINT_UNIQUE")
          throw new ValidationError("Cost centre code already exists");
        throw e;
      }

      const cc = this.costCentreRepo.conn.get(
        "SELECT * FROM cost_centres WHERE id = ?",
        [id],
      );
      logAudit(
        this.costCentreRepo.conn,
        companyId,
        req.user?.userId,
        "cost_centre",
        id,
        "CREATE",
        null,
        cc,
      );
      res.status(201).json(successResponse(cc));
    } catch (err) {
      next(err);
    }
  }

  async updateCostCentre(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const cc = this.costCentreRepo.conn.get(
        "SELECT * FROM cost_centres WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!cc) throw new NotFoundError("Cost centre not found");

      const updates = {};
      for (const field of COST_CENTRE_FIELDS) {
        if (req.body[field] !== undefined) updates[field] = req.body[field];
      }
      if (Object.keys(updates).length > 0) {
        const setClause = Object.keys(updates)
          .map((k) => `${k} = ?`)
          .join(", ");
        const values = Object.values(updates);
        this.costCentreRepo.conn
          .prepare(
            `UPDATE cost_centres SET ${setClause}, updated_at = datetime('now') WHERE id = ?`,
          )
          .run(...values, cc.id);
      }
      res.json(
        successResponse(
          this.costCentreRepo.conn.get(
            "SELECT * FROM cost_centres WHERE id = ?",
            [cc.id],
          ),
        ),
      );
    } catch (err) {
      next(err);
    }
  }

  async deleteCostCentre(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const cc = this.costCentreRepo.conn.get(
        "SELECT * FROM cost_centres WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!cc) throw new NotFoundError("Cost centre not found");

      const usage = this.costCentreRepo.conn.get(
        "SELECT COUNT(*) as c FROM journal_entry_lines WHERE cost_centre_id = ?",
        [cc.id],
      );
      if (usage.c > 0)
        throw new AppError(
          "Cannot delete a cost centre that has accounting transactions",
          "COST_CENTRE_IN_USE",
          400,
        );
      this.costCentreRepo.conn
        .prepare("DELETE FROM cost_centres WHERE id = ?")
        .run(cc.id);
      res.json(successResponse({ message: "Deleted" }));
    } catch (err) {
      next(err);
    }
  }

  // ─── Financial Years ───────────────────────────────────────────────
  async listFinancialYears(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const fys = this.costCentreRepo.conn.all(
        "SELECT * FROM financial_years WHERE company_id = ? ORDER BY start_date DESC",
        [companyId],
      );
      res.json(
        successResponse({ items: fys, total: fys.length, financialYears: fys }),
      );
    } catch (err) {
      next(err);
    }
  }

  // ─── Bank Accounts ─────────────────────────────────────────────────
  async listBankAccounts(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const accounts = this.costCentreRepo.conn.all(
        "SELECT * FROM bank_accounts WHERE company_id = ? ORDER BY account_name",
        [companyId],
      );
      res.json(
        successResponse({
          items: accounts,
          total: accounts.length,
          bankAccounts: accounts,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async createBankAccount(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const {
        account_name,
        account_number,
        bank_name,
        ifsc_code,
        account_type,
        gl_account_id,
        opening_balance,
      } = req.body;
      if (!account_name || !gl_account_id)
        throw new ValidationError(
          "account_name and gl_account_id are required",
        );

      const id = generateId("ba");
      try {
        this.costCentreRepo.conn
          .prepare(
            `
          INSERT INTO bank_accounts (id, company_id, account_name, account_number, bank_name, ifsc_code, account_type, gl_account_id, opening_balance, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
        `,
          )
          .run(
            id,
            companyId,
            account_name,
            account_number || "",
            bank_name || "",
            ifsc_code || "",
            account_type || "CHECKING",
            gl_account_id,
            parseFloat(opening_balance) || 0,
          );
      } catch (e) {
        if (e.code === "SQLITE_CONSTRAINT_UNIQUE")
          throw new ValidationError("Account number already exists");
        throw e;
      }

      res
        .status(201)
        .json(
          successResponse(
            this.costCentreRepo.conn.get(
              "SELECT * FROM bank_accounts WHERE id = ?",
              [id],
            ),
          ),
        );
      logAudit(
        this.costCentreRepo.conn,
        companyId,
        req.user?.userId,
        "bank_account",
        id,
        "CREATE",
        null,
        this.costCentreRepo.conn.get(
          "SELECT * FROM bank_accounts WHERE id = ?",
          [id],
        ),
      );
    } catch (err) {
      next(err);
    }
  }

  // ─── Dashboard ─────────────────────────────────────────────────────
  async dashboard(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const conn = getConn();

      const receivables = conn.get(
        "SELECT COALESCE(SUM(outstanding_amount), 0) as total FROM receivables WHERE company_id = ?",
        [companyId],
      );
      const payables = conn.get(
        "SELECT COALESCE(SUM(outstanding_amount), 0) as total FROM payables WHERE company_id = ?",
        [companyId],
      );
      const overdueReceivables = conn.get(
        "SELECT COALESCE(SUM(outstanding_amount), 0) as total FROM receivables WHERE company_id = ? AND status IN ('OVERDUE', 'DUE_SOON')",
        [companyId],
      );
      const overduePayables = conn.get(
        "SELECT COALESCE(SUM(outstanding_amount), 0) as total FROM payables WHERE company_id = ? AND status IN ('OVERDUE', 'DUE_SOON')",
        [companyId],
      );

      // Income and expense from journal entries (current month)
      const monthlyIncome = conn.get(
        `
        SELECT COALESCE(SUM(je.total_debit), 0) as total FROM journal_entries je
        JOIN journal_entry_lines jel ON je.id = jel.journal_entry_id
        JOIN accounts a ON jel.account_id = a.id
        WHERE je.company_id = ? AND je.status = 'POSTED'
        AND a.debit_credit_nature = 'CREDIT' AND a.type IN ('INCOME')
        AND je.entry_date >= date('now', 'start of month')
      `,
        [companyId],
      );

      const monthlyExpense = conn.get(
        `
        SELECT COALESCE(SUM(je.total_debit), 0) as total FROM journal_entries je
        JOIN journal_entry_lines jel ON je.id = jel.journal_entry_id
        JOIN accounts a ON jel.account_id = a.id
        WHERE je.company_id = ? AND je.status = 'POSTED'
        AND a.debit_credit_nature = 'DEBIT' AND a.type IN ('EXPENSE')
        AND je.entry_date >= date('now', 'start of month')
      `,
        [companyId],
      );

      const bankBalance = conn.get(
        "SELECT COALESCE(SUM(opening_balance), 0) as total FROM bank_accounts WHERE company_id = ?",
        [companyId],
      );
      const cashBalance = conn.get(
        `
        SELECT COALESCE(SUM(jel.debit_amount - jel.credit_amount), 0) as total
        FROM journal_entry_lines jel JOIN accounts a ON jel.account_id = a.id
        WHERE a.type = 'CASH' AND jel.company_id = ?
      `,
        [companyId],
      );

      res.json(
        successResponse({
          receivables: receivables.total,
          payables: payables.total,
          overdueReceivables: overdueReceivables.total,
          overduePayables: overduePayables.total,
          monthlyIncome: monthlyIncome.total,
          monthlyExpense: monthlyExpense.total,
          netProfit: monthlyIncome.total - monthlyExpense.total,
          bankBalance: bankBalance.total,
          cashBalance: cashBalance.total,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  // ─── Trial Balance ─────────────────────────────────────────────────
  async trialBalance(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const from = req.query.from || "1900-01-01";
      const to = req.query.to || "9999-12-31";
      const result = await this.journalRepo.trialBalance(companyId, from, to);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ─── Profit & Loss ─────────────────────────────────────────────────
  async profitLoss(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const from = req.query.from || "1900-01-01";
      const to = req.query.to || "9999-12-31";
      const result = await this.journalRepo.profitLoss(companyId, from, to);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ─── Balance Sheet ─────────────────────────────────────────────────
  async balanceSheet(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const asOf = req.query.as_of || new Date().toISOString().slice(0, 10);
      const result = await this.journalRepo.balanceSheet(companyId, asOf);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ─── Cash Flow ─────────────────────────────────────────────────────
  async cashFlow(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const from = req.query.from || "1900-01-01";
      const to = req.query.to || "9999-12-31";
      const result = await this.journalRepo.cashFlow(companyId, from, to);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ─── Ratios ────────────────────────────────────────────────────────
  async ratios(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const from = req.query.from || "1900-01-01";
      const to = req.query.to || "9999-12-31";
      const result = await this.journalRepo.ratios(companyId, from, to);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ─── Day Book ──────────────────────────────────────────────────────
  async dayBook(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {
        companyId,
        page: parseInt(req.query.page) || 1,
        limit: parseInt(req.query.limit) || 50,
        from: req.query.from,
        to: req.query.to,
        q: req.query.q,
        type: req.query.type,
      };
      const result = await this.journalRepo.dayBook(options);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async cashBook(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.journalRepo.cashBook(
        companyId,
        req.query.from || null,
        req.query.to || null,
      );
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async bankBook(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const bankAccountId = req.params.bankAccountId;
      const result = this.journalRepo.bankBook(
        companyId,
        bankAccountId,
        req.query.from || null,
        req.query.to || null,
      );
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ─── Journal Entry Creation ────────────────────────────────────────
  async createJournalEntry(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      let {
        voucher_id,
        entry_date,
        reference_number,
        description,
        currency,
        exchange_rate,
        lines,
        financial_year_id,
      } = req.body;
      if (!lines || !Array.isArray(lines) || lines.length < 2) {
        throw new ValidationError("At least two journal lines are required");
      }
      if (!entry_date)
        throw new ValidationError("Transaction date is required");
      if (!financial_year_id) {
        // Fall back to resolving the financial year from the entry date.
        const fy = this.journalRepo.conn.get(
          "SELECT id FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date ORDER BY is_active DESC LIMIT 1",
          [companyId, entry_date, entry_date],
        );
        if (!fy)
          throw new ValidationError("Financial year is required");
        financial_year_id = fy.id;
      }

      const errors = this._validateJournalLines(
        companyId,
        financial_year_id,
        entry_date,
        lines,
        req,
      );
      if (errors.length > 0) {
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });
      }

      const result = this.journalRepo.createWithValidation(
        {
          company_id: companyId,
          voucher_id: voucher_id || null,
          entry_date,
          description,
          currency: currency || "INR",
          exchange_rate: exchange_rate || 1.0,
          created_by: req.user?.userId || 1,
          entry_number: reference_number,
          financial_year_id,
        },
        lines.map((l) => ({
          account_id: l.account_id,
          debit_amount: l.debit_amount || 0,
          credit_amount: l.credit_amount || 0,
          description: l.description,
          cost_centre_id: l.cost_centre_id,
          cost_category_id: l.cost_category_id,
          reference_id: l.reference_id,
        })),
      );
      logAudit(
        this.journalRepo.conn,
        companyId,
        req.user?.userId,
        "journal_entry",
        result.id,
        "POST",
        null,
        result,
      );
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ─── Step 6: Journal Entry Management (Draft → Validate → Post → Cancel/Reverse) ──
  // All methods reuse the existing JournalEntryRepository, accounting tables,
  // accounting_audit, and RBAC middleware. No new accounting engines created.

  /**
   * Validate journal entry lines before posting.
   * Checks: account validity, nature, debit/credit rules, balance.
   * Does NOT create or modify any records — read-only validation.
   */
  async validateJournalEntry(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { entry_date, lines, financial_year_id } = req.body;
      const errors = this._validateJournalLines(
        companyId,
        financial_year_id,
        entry_date,
        lines,
        req,
      );
      if (errors.length > 0) {
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });
      }
      res.json({ success: true, data: { valid: true, errors: [] } });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Create a Journal Entry in DRAFT state with full validation.
   * Lines are stored but JE is NOT posted until /post is called.
   */
  async createJournalEntryDraft(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      let {
        entry_date,
        reference_number,
        description,
        currency,
        exchange_rate,
        lines,
        financial_year_id,
      } = req.body;
      if (!lines || !Array.isArray(lines) || lines.length < 2) {
        throw new ValidationError("At least two journal lines are required");
      }
      if (!entry_date)
        throw new ValidationError("Transaction date is required");
      if (!financial_year_id) {
        // Fall back to resolving the financial year from the entry date.
        const fy = this.journalRepo.conn.get(
          "SELECT id FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date ORDER BY is_active DESC LIMIT 1",
          [companyId, entry_date, entry_date],
        );
        if (!fy)
          throw new ValidationError("Financial year is required");
        financial_year_id = fy.id;
      }

      const errors = this._validateJournalLines(
        companyId,
        financial_year_id,
        entry_date,
        lines,
        req,
      );
      if (errors.length > 0) {
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });
      }

      const result = this.journalRepo.createJournalEntryDraft(
        {
          company_id: companyId,
          financial_year_id,
          entry_date,
          reference_number,
          description,
          currency: currency || "INR",
          exchange_rate: exchange_rate || 1.0,
          created_by: req.user?.userId || "system",
        },
        lines.map((l) => ({
          account_id: l.account_id,
          debit_amount: parseFloat(l.debit_amount) || 0,
          credit_amount: parseFloat(l.credit_amount) || 0,
          description: l.description || "",
          cost_centre_id: l.cost_centre_id || null,
          cost_category_id: l.cost_category_id || null,
          reference_id: l.reference_id || null,
        })),
      );

      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Post a Draft Journal Entry (transition to POSTED).
   * Re-validates balance and account status at posting time.
   */
  async postJournalEntry(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const je = this.journalRepo.findById(req.params.id, companyId);
      if (!je) throw new NotFoundError("Journal entry not found");
      if (je.status === "POSTED")
        throw new AppError(
          "Journal entry is already posted",
          "ALREADY_POSTED",
          400,
        );
      if (je.status === "CANCELLED")
        throw new AppError(
          "Cannot post a cancelled journal entry",
          "INVALID_STATE",
          400,
        );
      if (je.status === "REVERSED")
        throw new AppError(
          "Cannot post a reversed journal entry",
          "INVALID_STATE",
          400,
        );

      const lines = this.journalRepo.findLines(req.params.id);
      const errors = this._validateJournalLines(
        companyId,
        je.financial_year_id,
        je.entry_date,
        lines,
        req,
      );
      if (errors.length > 0) {
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });
      }

      const result = this.journalRepo.postDraft(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Cancel a POSTED Journal Entry.
   * Creates an audit trail; original JE remains for traceability.
   */
  async cancelJournalEntry(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const je = this.journalRepo.findById(req.params.id, companyId);
      if (!je) throw new NotFoundError("Journal entry not found");
      if (je.status !== "POSTED")
        throw new AppError(
          "Only posted journal entries can be cancelled",
          "INVALID_STATE",
          400,
        );

      this.journalRepo.cancel(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.journalRepo.conn,
        companyId,
        req.user?.userId,
        "journal_entry",
        req.params.id,
        "CANCEL",
      );
      res.json(
        successResponse({
          id: req.params.id,
          status: "CANCELLED",
          message: "Journal entry cancelled",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * Reverse a POSTED Journal Entry.
   * Creates a new offsetting journal entry; original remains auditable.
   */
  async reverseJournalEntry(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const je = this.journalRepo.findById(req.params.id, companyId);
      if (!je) throw new NotFoundError("Journal entry not found");
      if (je.status !== "POSTED")
        throw new AppError(
          "Only posted journal entries can be reversed",
          "INVALID_STATE",
          400,
        );

      const result = this.journalRepo.reverse(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.journalRepo.conn,
        companyId,
        req.user?.userId,
        "journal_entry",
        req.params.id,
        "REVERSE",
        null,
        { reversed_journal_entry_id: result.reverseEntryId },
      );
      res.json(
        successResponse({ ...result, message: "Journal entry reversed" }),
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * Update a Draft Journal Entry.
   */
  async updateJournalEntry(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { description, reference_number, entry_date, financial_year_id } =
        req.body;
      const je = this.journalRepo.findById(req.params.id, companyId);
      if (!je) throw new NotFoundError("Journal entry not found");
      if (je.status !== "DRAFT")
        throw new AppError(
          "Cannot edit a " + je.status.toLowerCase() + " journal entry",
          "INVALID_STATE",
          400,
        );

      this.journalRepo.update(req.params.id, companyId, {
        description,
        reference_number,
        entry_date,
        financial_year_id,
      });
      const updated = this.journalRepo.findById(req.params.id, companyId);
      logAudit(
        this.journalRepo.conn,
        companyId,
        req.user?.userId,
        "journal_entry",
        req.params.id,
        "UPDATE",
        je,
        updated,
      );
      res.json(successResponse(updated));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Delete a Draft Journal Entry.
   */
  async deleteJournalEntry(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const je = this.journalRepo.findById(req.params.id, companyId);
      if (!je) throw new NotFoundError("Journal entry not found");
      if (je.status !== "DRAFT")
        throw new AppError(
          "Cannot delete a " + je.status.toLowerCase() + " journal entry",
          "INVALID_STATE",
          400,
        );

      this.journalRepo.delete(req.params.id, companyId);
      logAudit(
        this.journalRepo.conn,
        companyId,
        req.user?.userId,
        "journal_entry",
        req.params.id,
        "DELETE",
      );
      res.json(successResponse({ message: "Journal entry deleted" }));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Validate journal entry lines.
   * Reused by createJournalEntryDraft, postJournalEntry, and validateJournalEntry.
   * Pure validation — no side effects.
   */
  _validateJournalLines(companyId, financialYearId, entryDate, lines, ctx) {
    const errors = [];
    if (!lines || !Array.isArray(lines) || lines.length < 2) {
      errors.push("At least two journal lines are required");
      return errors;
    }

    // Validate financial year
    if (financialYearId) {
      const fy = this.coaRepo.conn.get(
        "SELECT * FROM financial_years WHERE id = ? AND company_id = ?",
        [financialYearId, companyId],
      );
      if (!fy)
        errors.push(
          "Financial year not found or does not belong to this company",
        );
    }

    // Validate transaction date within FY
    if (entryDate && financialYearId) {
      const fy = this.coaRepo.conn.get(
        "SELECT start_date, end_date, is_locked FROM financial_years WHERE id = ? AND company_id = ?",
        [financialYearId, companyId],
      );
      if (fy) {
        const fyLock = evaluateFinancialYearLock({ fy, context: ctx });
        if (fyLock.blocked) errors.push(fyLock.reason);
        if (entryDate < fy.start_date || entryDate > fy.end_date) {
          errors.push(
            "Transaction date must fall within the selected Financial Year",
          );
        }
      }
    }

    // Validate each line
    let hasDebit = false,
      hasCredit = false;
    const seenAccounts = new Set();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const debit = parseFloat(line.debit_amount) || 0;
      const credit = parseFloat(line.credit_amount) || 0;

      if (!line.account_id) errors.push(`Line ${i + 1}: Account is required`);
      if (debit < 0)
        errors.push(`Line ${i + 1}: Debit amount must be non-negative`);
      if (credit < 0)
        errors.push(`Line ${i + 1}: Credit amount must be non-negative`);
      if (debit > 0 && credit > 0)
        errors.push(
          `Line ${i + 1}: Cannot have both Debit and Credit on the same line`,
        );
      if (debit === 0 && credit === 0)
        errors.push(
          `Line ${i + 1}: At least one of Debit or Credit must be greater than zero`,
        );

      if (line.account_id) {
        if (seenAccounts.has(line.account_id)) {
          errors.push(`Line ${i + 1}: Duplicate account entry`);
        }
        seenAccounts.add(line.account_id);

        const account = this.obRepo.getAccountDetails(
          line.account_id,
          companyId,
        );
        if (!account) {
          errors.push(`Line ${i + 1}: Account not found or not accessible`);
        } else {
          if (account.is_group === 1 || account.is_group === true)
            errors.push(
              `Line ${i + 1}: "${account.name}" is an Account Group and cannot receive postings`,
            );
          if (account.is_active === 0 || account.is_active === false)
            errors.push(
              `Line ${i + 1}: "${account.name}" is inactive and cannot receive postings`,
            );
          if (
            account.allow_direct_posting === 0 ||
            account.allow_direct_posting === false
          )
            errors.push(
              `Line ${i + 1}: "${account.name}" does not allow direct posting`,
            );
          if (debit > 0) hasDebit = true;
          if (credit > 0) hasCredit = true;
        }
      }
    }

    if (!hasDebit)
      errors.push("Journal Entry must contain at least one Debit line");
    if (!hasCredit)
      errors.push("Journal Entry must contain at least one Credit line");

    // Validate balance
    let totalDebit = 0,
      totalCredit = 0;
    for (const line of lines) {
      totalDebit += parseFloat(line.debit_amount) || 0;
      totalCredit += parseFloat(line.credit_amount) || 0;
    }
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      errors.push(
        `Journal Entry is not balanced. Total Debit: ${totalDebit}, Total Credit: ${totalCredit}, Difference: ${totalDebit - totalCredit}`,
      );
    }

    return errors;
  }

  // ─── Voucher Management ────────────────────────────────────────────
  async getVoucher(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = await this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher) throw new NotFoundError("Voucher not found");
      res.json(successResponse(voucher));
    } catch (err) {
      next(err);
    }
  }

  async createVoucher(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const {
        voucher_type,
        reference_number,
        entry_date,
        description,
        currency,
        exchange_rate,
        lines,
        contact_id,
      } = req.body;
      if (
        !voucher_type ||
        ![
          "JOURNAL",
          "PAYMENT",
          "RECEIPT",
          "CONTRA",
          "SALES",
          "PURCHASE",
          "EXPENSE",
        ].includes(voucher_type)
      ) {
        throw new ValidationError(
          "Valid voucher_type is required (JOURNAL, PAYMENT, RECEIPT, CONTRA, SALES)",
        );
      }
      if (!lines || !Array.isArray(lines) || lines.length === 0) {
        throw new ValidationError("At least one line is required");
      }
      if (contact_id) {
        await assertTenantRefs(this.conn, companyId, { contact_id });
      }
      const voucherId = await this.voucherRepo.getNextVoucherNumber(
        voucher_type,
        companyId,
      );
      let totalDebit = 0,
        totalCredit = 0;
      const jeLines = lines.map((l) => {
        totalDebit += parseFloat(l.debit_amount) || 0;
        totalCredit += parseFloat(l.credit_amount) || 0;
        return {
          account_id: l.account_id,
          debit_amount: parseFloat(l.debit_amount) || 0,
          credit_amount: parseFloat(l.credit_amount) || 0,
          description: l.description || "",
          ...(l.cost_centre_id ? { cost_centre_id: l.cost_centre_id } : {}),
          ...(l.reference_id ? { reference_id: l.reference_id } : {}),
        };
      });
      if (Math.abs(totalDebit - totalCredit) > 0.001) {
        throw new ValidationError(
          `Unbalanced voucher: debits=${totalDebit}, credits=${totalCredit}`,
        );
      }

      const voucher = await this.voucherRepo.create({
        id: generateId("vch"),
        company_id: companyId,
        voucher_type,
        reference_number,
        voucher_number: voucherId,
        voucher_date: entry_date,
        description,
        currency: currency || "USD",
        exchange_rate: exchange_rate || 1,
        status: "DRAFT",
        created_by: req.user.userId || 1,
      });
      if (voucher_type !== "JOURNAL") {
        await this.journalRepo.createWithValidation(
          {
            id: generateId("je"),
            company_id: companyId,
            voucher_id: voucher.id,
            entry_date,
            description: description || voucher_type + " voucher " + voucherId,
            currency: currency || "USD",
            exchange_rate: exchange_rate || 1,
            total_debit: totalDebit,
            total_credit: totalCredit,
            status: "POSTED",
            created_by: req.user.userId || 1,
          },
          jeLines,
        );
      }
      await this.voucherRepo.update(voucher.id, companyId, {
        status: "POSTED",
      });
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "voucher",
        voucher.id,
        "CREATE",
        null,
        { ...voucher, total_debit: totalDebit, total_credit: totalCredit },
      );

      res.status(201).json(
        successResponse({
          ...voucher,
          total_debit: totalDebit,
          total_credit: totalCredit,
          lines: jeLines,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async cancelVoucher(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = await this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher) throw new NotFoundError("Voucher not found");
      await this.voucherRepo.cancel(req.params.id, companyId, req.user.userId);
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "voucher",
        req.params.id,
        "CANCEL",
      );
      res.json(successResponse({ message: "Voucher cancelled" }));
    } catch (err) {
      next(err);
    }
  }

  async reverseVoucher(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = await this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher) throw new NotFoundError("Voucher not found");
      await this.voucherRepo.reverse(req.params.id, companyId, req.user.userId);
      res.json(successResponse({ message: "Voucher reversed" }));
    } catch (err) {
      next(err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 7: Receipt Voucher / Money Received Transaction
  // Reuses the Step 6 Journal Entry engine, vouchers table, and audit trail.
  // ─────────────────────────────────────────────────────────────────────

  _getNextReceiptNumber(companyId) {
    return this.voucherRepo.getNextVoucherNumber("RECEIPT", companyId);
  }

  _validateReceipt(companyId, data, lines, ctx) {
    const errors = [];
    const {
      receipt_mode,
      voucher_date,
      receiving_ledger_id,
      source_ledger_id,
      amount,
      contact_id,
      financial_year_id,
    } = data;

    const validModes = ["CASH", "BANK", "UPI", "CHEQUE", "CARD", "OTHER"];
    if (!receipt_mode || !validModes.includes(receipt_mode))
      errors.push(
        "Valid receipt_mode is required (CASH, BANK, UPI, CHEQUE, CARD, OTHER)",
      );

    if (!voucher_date) errors.push("Receipt date is required");

    let fy = null;
    if (financial_year_id) {
      fy = this.voucherRepo.conn.get(
        "SELECT * FROM financial_years WHERE id = ? AND company_id = ?",
        [financial_year_id, companyId],
      );
      if (!fy)
        errors.push(
          "Financial year not found or does not belong to this company",
        );
    } else if (voucher_date) {
      fy = this.voucherRepo.conn.get(
        "SELECT * FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date",
        [companyId, voucher_date, voucher_date],
      );
      if (!fy)
        errors.push("No active financial year found for the receipt date");
    }

    if (fy) {
      const fyLock = evaluateFinancialYearLock({ fy, context: ctx });
      if (fyLock.blocked) errors.push(fyLock.reason);
      if (
        voucher_date &&
        (voucher_date < fy.start_date || voucher_date > fy.end_date)
      ) {
        errors.push(
          "Receipt date must fall within the selected Financial Year",
        );
      }
    }

    if (!receiving_ledger_id)
      errors.push("Receiving ledger account is required");
    else {
      const acc = this.obRepo.getAccountDetails(receiving_ledger_id, companyId);
      if (!acc)
        errors.push("Receiving ledger account not found or not accessible");
      else {
        if (acc.is_group === 1 || acc.is_group === true)
          errors.push(
            `Receiving account "${acc.name}" is an Account Group, not a Ledger Account`,
          );
        if (acc.is_active === 0 || acc.is_active === false)
          errors.push(`Receiving account "${acc.name}" is inactive`);
        if (
          acc.allow_direct_posting === 0 ||
          acc.allow_direct_posting === false
        )
          errors.push(
            `Receiving account "${acc.name}" does not allow direct posting`,
          );
        if (acc.debit_credit_nature !== "DEBIT")
          errors.push(
            `Receiving account "${acc.name}" is a ${acc.debit_credit_nature}-nature account; receiving accounts must be DEBIT-nature`,
          );
      }
    }

    if (!source_ledger_id) errors.push("Source ledger account is required");
    else {
      const acc = this.obRepo.getAccountDetails(source_ledger_id, companyId);
      if (!acc)
        errors.push("Source ledger account not found or not accessible");
      else {
        if (acc.is_group === 1 || acc.is_group === true)
          errors.push(
            `Source account "${acc.name}" is an Account Group, not a Ledger Account`,
          );
        if (acc.is_active === 0 || acc.is_active === false)
          errors.push(`Source account "${acc.name}" is inactive`);
        if (
          acc.allow_direct_posting === 0 ||
          acc.allow_direct_posting === false
        )
          errors.push(
            `Source account "${acc.name}" does not allow direct posting`,
          );
        if (acc.debit_credit_nature !== "CREDIT")
          errors.push(
            `Source account "${acc.name}" is a ${acc.debit_credit_nature}-nature account; source accounts must be CREDIT-nature`,
          );
      }
    }

    if (amount === undefined || amount === null || isNaN(parseFloat(amount)))
      errors.push("Valid amount is required");
    else if (parseFloat(amount) <= 0)
      errors.push("Amount must be greater than zero");

    if (contact_id) {
      try {
        assertTenantRefs(this.conn, companyId, { contact_id });
      } catch (e) {
        errors.push(`Party validation failed: ${e.message}`);
      }
    }

    return errors;
  }

  _buildReceiptLines(
    receivingLedgerId,
    sourceLedgerId,
    amount,
    narration,
    referenceNumber,
  ) {
    return [
      {
        account_id: receivingLedgerId,
        debit_amount: parseFloat(amount),
        credit_amount: 0,
        description: narration,
        reference_id: referenceNumber || null,
      },
      {
        account_id: sourceLedgerId,
        debit_amount: 0,
        credit_amount: parseFloat(amount),
        description: narration,
        reference_id: referenceNumber || null,
      },
    ];
  }

  async getReceipt(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "RECEIPT")
        throw new NotFoundError("Receipt not found");
      const detail = this.voucherRepo.getWithJournalEntry(
        req.params.id,
        companyId,
      );
      res.json(successResponse(detail));
    } catch (err) {
      next(err);
    }
  }

  async listReceipts(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {
        companyId,
        voucherType: "RECEIPT",
        status: req.query.status,
        limit: parseInt(req.query.limit) || 50,
        startDate: req.query.from,
        endDate: req.query.to,
        contactId: req.query.contact_id,
        query: req.query.q,
      };
      const result = this.voucherRepo.search(options);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async createReceiptDraft(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateReceipt(companyId, req.body, null, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const {
        receipt_mode,
        voucher_date,
        reference_number,
        narration,
        description,
        contact_id,
        currency,
        exchange_rate,
        financial_year_id,
      } = req.body;
      const voucherNumber = this._getNextReceiptNumber(companyId);
      const voucher = this.voucherRepo.createReceipt(
        {
          companyId,
          voucher_number: voucherNumber,
          receipt_mode,
          voucher_date,
          reference_number,
          contact_id,
          currency,
          exchange_rate,
          financial_year_id,
          description: narration || description || "",
          created_by: req.user?.userId || "system",
        },
        [],
      );

      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "receipt",
        voucher.id,
        "DRAFT",
        null,
        { ...voucher, voucher_number: voucherNumber },
      );
      res
        .status(201)
        .json(successResponse({ ...voucher, voucher_number: voucherNumber }));
    } catch (err) {
      next(err);
    }
  }

  async validateReceipt(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateReceipt(companyId, req.body, null, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const lines = this._buildReceiptLines(
        req.body.receiving_ledger_id,
        req.body.source_ledger_id,
        req.body.amount,
        req.body.narration || "",
        req.body.reference_number,
      );
      const lineErrors = this._validateJournalLines(
        companyId,
        req.body.financial_year_id,
        req.body.voucher_date,
        lines,
        req,
      );
      if (lineErrors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors: lineErrors } });

      res.json({
        success: true,
        data: {
          valid: true,
          errors: [],
          accounting_entry: {
            debit: {
              account_id: req.body.receiving_ledger_id,
              amount: req.body.amount,
            },
            credit: {
              account_id: req.body.source_ledger_id,
              amount: req.body.amount,
            },
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }

  async postReceipt(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateReceipt(companyId, req.body, null, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const {
        receipt_mode,
        voucher_date,
        receiving_ledger_id,
        source_ledger_id,
        amount,
        reference_number,
        narration,
        description,
        contact_id,
        currency,
        exchange_rate,
        financial_year_id,
      } = req.body;

      const lines = this._buildReceiptLines(
        receiving_ledger_id,
        source_ledger_id,
        amount,
        narration || description || "",
        reference_number,
      );

      let fyId = financial_year_id;
      if (!fyId) {
        const fy = this.voucherRepo.conn.get(
          "SELECT * FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date",
          [companyId, voucher_date, voucher_date],
        );
        fyId = fy?.id;
      }

      const jeLines = lines.map((l) => ({
        account_id: l.account_id,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        description: l.description || "",
        cost_centre_id: l.cost_centre_id || null,
        cost_category_id: l.cost_category_id || null,
        reference_id: l.reference_id || null,
      }));

      const voucherNumber = this._getNextReceiptNumber(companyId);

      const voucher = this.voucherRepo.createReceipt(
        {
          companyId,
          voucher_number: voucherNumber,
          receipt_mode,
          voucher_date,
          reference_number,
          contact_id,
          currency,
          exchange_rate,
          financial_year_id: fyId,
          description: narration || description || "",
          created_by: req.user?.userId || "system",
        },
        jeLines,
      );

      const totalDebit = jeLines.reduce(
        (sum, l) => sum + (parseFloat(l.debit_amount) || 0),
        0,
      );

      const journalEntry = this.journalRepo.createWithValidation(
        {
          id: generateId("je"),
          company_id: companyId,
          voucher_id: voucher.id,
          entry_date: voucher_date,
          entry_number: "RV-" + voucherNumber,
          description:
            narration || description || "Receipt voucher " + voucherNumber,
          currency: currency || "INR",
          exchange_rate: exchange_rate || 1.0,
          total_debit: totalDebit,
          total_credit: totalDebit,
          status: "POSTED",
          created_by: req.user?.userId || "system",
          financial_year_id: fyId,
        },
        jeLines,
      );

      const postedVoucher = this.voucherRepo.postReceipt(
        voucher.id,
        companyId,
        req.user?.userId || "system",
        journalEntry,
      );

      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "receipt",
        voucher.id,
        "POST",
        null,
        { ...postedVoucher, journal_entry_id: journalEntry.id },
      );

      res
        .status(201)
        .json(
          successResponse({ ...postedVoucher, journal_entry: journalEntry }),
        );
    } catch (err) {
      next(err);
    }
  }

  async cancelReceipt(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "RECEIPT")
        throw new NotFoundError("Receipt not found");
      if (voucher.status !== "POSTED")
        throw new AppError(
          "Only posted receipts can be cancelled",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.cancel(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "receipt",
        req.params.id,
        "CANCEL",
      );
      res.json(
        successResponse({
          id: req.params.id,
          status: "CANCELLED",
          message: "Receipt cancelled",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async reverseReceipt(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "RECEIPT")
        throw new NotFoundError("Receipt not found");
      if (voucher.status !== "POSTED")
        throw new AppError(
          "Only posted receipts can be reversed",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.reverse(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "receipt",
        req.params.id,
        "REVERSE",
      );
      res.json(
        successResponse({
          id: req.params.id,
          status: "REVERSED",
          message: "Receipt reversed",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async deleteReceipt(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "RECEIPT")
        throw new NotFoundError("Receipt not found");
      if (voucher.status !== "DRAFT")
        throw new AppError(
          "Cannot delete a " + voucher.status.toLowerCase() + " receipt",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.delete(req.params.id, companyId);
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "receipt",
        req.params.id,
        "DELETE",
      );
      res.json(successResponse({ message: "Receipt deleted" }));
    } catch (err) {
      next(err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 8: Payment Voucher / Money Paid Transaction
  // Reuses the Step 6 Journal Entry engine, vouchers table, and audit trail.
  // Payment = Debit destination account (DEBIT-nature), Credit payment account (DEBIT-nature, e.g. Cash/Bank)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Validate payment input data.
   * Payment Voucher: money going OUT.
   *   Debit side = expense/liability/receivable account (DEBIT-nature)
   *   Credit side = payment account (Cash/Bank — DEBIT-nature, credited because money goes out)
   */
  _validatePayment(companyId, data, ctx) {
    const errors = [];
    const {
      payment_mode,
      payment_date,
      payment_account_id,
      destination_ledger_id,
      amount,
      contact_id,
      financial_year_id,
    } = data;

    // Payment mode
    const validModes = ["CASH", "BANK", "UPI", "CHEQUE", "CARD", "OTHER"];
    if (!payment_mode || !validModes.includes(payment_mode))
      errors.push(
        "Valid payment_mode is required (CASH, BANK, UPI, CHEQUE, CARD, OTHER)",
      );

    // Date
    if (!payment_date) errors.push("Payment date is required");

    // Financial Year
    let fy = null;
    if (financial_year_id) {
      fy = this.voucherRepo.conn.get(
        "SELECT * FROM financial_years WHERE id = ? AND company_id = ?",
        [financial_year_id, companyId],
      );
      if (!fy)
        errors.push(
          "Financial year not found or does not belong to this company",
        );
    } else if (payment_date) {
      fy = this.voucherRepo.conn.get(
        "SELECT * FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date ORDER BY is_active DESC LIMIT 1",
        [companyId, payment_date, payment_date],
      );
      if (!fy) errors.push("No financial year found for the payment date");
    }

    if (fy) {
      const fyLock = evaluateFinancialYearLock({ fy, context: ctx });
      if (fyLock.blocked) errors.push(fyLock.reason);
      if (
        payment_date &&
        (payment_date < fy.start_date || payment_date > fy.end_date)
      ) {
        errors.push(
          "Payment date must fall within the selected Financial Year",
        );
      }
    }

    // Payment account (Credit side) — must be DEBIT-nature (Cash/Bank/Asset), active, allows posting
    if (!payment_account_id) {
      errors.push("Payment account is required");
    } else {
      const acc = this.obRepo.getAccountDetails(payment_account_id, companyId);
      if (!acc) errors.push("Payment account not found or not accessible");
      else {
        if (acc.is_group === 1 || acc.is_group === true)
          errors.push(
            `Payment account "${acc.name}" is an Account Group, not a Ledger Account`,
          );
        if (acc.is_active === 0 || acc.is_active === false)
          errors.push(`Payment account "${acc.name}" is inactive`);
        if (
          acc.allow_direct_posting === 0 ||
          acc.allow_direct_posting === false
        )
          errors.push(
            `Payment account "${acc.name}" does not allow direct posting`,
          );
        // Payment accounts (Cash/Bank) are DEBIT-nature — money going out is a credit to these accounts
        if (acc.debit_credit_nature !== "DEBIT")
          errors.push(
            `Payment account "${acc.name}" is a ${acc.debit_credit_nature}-nature account; payment accounts must be DEBIT-nature (Cash/Bank/Asset)`,
          );
      }
    }

    // Destination account (Debit side) — must be a Ledger Account, active, allows posting
    if (!destination_ledger_id) {
      errors.push("Destination ledger account is required");
    } else {
      const acc = this.obRepo.getAccountDetails(
        destination_ledger_id,
        companyId,
      );
      if (!acc)
        errors.push("Destination ledger account not found or not accessible");
      else {
        if (acc.is_group === 1 || acc.is_group === true)
          errors.push(
            `Destination account "${acc.name}" is an Account Group, not a Ledger Account`,
          );
        if (acc.is_active === 0 || acc.is_active === false)
          errors.push(`Destination account "${acc.name}" is inactive`);
        if (
          acc.allow_direct_posting === 0 ||
          acc.allow_direct_posting === false
        )
          errors.push(
            `Destination account "${acc.name}" does not allow direct posting`,
          );
      }
    }

    // Amount
    if (amount === undefined || amount === null || isNaN(parseFloat(amount)))
      errors.push("Valid amount is required");
    else if (parseFloat(amount) <= 0)
      errors.push("Amount must be greater than zero");

    // Contact (party)
    if (contact_id) {
      try {
        assertTenantRefs(this.voucherRepo.conn, companyId, { contact_id });
      } catch (e) {
        errors.push(`Party validation failed: ${e.message}`);
      }
    }

    return errors;
  }

  /**
   * Build JE lines for a payment: Debit destination, Credit payment account.
   */
  _buildPaymentLines(
    destinationLedgerId,
    paymentAccountId,
    amount,
    narration,
    referenceNumber,
  ) {
    return [
      {
        account_id: destinationLedgerId,
        debit_amount: parseFloat(amount),
        credit_amount: 0,
        description: narration,
        reference_id: referenceNumber || null,
      },
      {
        account_id: paymentAccountId,
        debit_amount: 0,
        credit_amount: parseFloat(amount),
        description: narration,
        reference_id: referenceNumber || null,
      },
    ];
  }

  async getPayment(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "PAYMENT")
        throw new NotFoundError("Payment not found");
      const detail = this.voucherRepo.getWithJournalEntry(
        req.params.id,
        companyId,
      );
      res.json(successResponse(detail));
    } catch (err) {
      next(err);
    }
  }

  async listPayments(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {
        companyId,
        voucherType: "PAYMENT",
        status: req.query.status,
        limit: parseInt(req.query.limit) || 50,
        startDate: req.query.from,
        endDate: req.query.to,
        contactId: req.query.contact_id,
        query: req.query.q,
      };
      const result = this.voucherRepo.search(options);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async createPaymentDraft(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validatePayment(companyId, req.body, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const {
        payment_mode,
        payment_date,
        reference_number,
        narration,
        description,
        contact_id,
        currency,
        exchange_rate,
        financial_year_id,
      } = req.body;
      const voucherNumber = this.voucherRepo.getNextVoucherNumber(
        "PAYMENT",
        companyId,
      );
      const voucher = this.voucherRepo.createPayment(
        {
          companyId,
          voucher_number: voucherNumber,
          payment_mode,
          voucher_date: payment_date,
          reference_number,
          contact_id,
          currency,
          exchange_rate,
          financial_year_id,
          description: narration || description || "",
          created_by: req.user?.userId || "system",
        },
        [],
      );

      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "payment",
        voucher.id,
        "DRAFT",
        null,
        { ...voucher, voucher_number: voucherNumber },
      );
      res
        .status(201)
        .json(successResponse({ ...voucher, voucher_number: voucherNumber }));
    } catch (err) {
      next(err);
    }
  }

  async validatePayment(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validatePayment(companyId, req.body, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const lines = this._buildPaymentLines(
        req.body.destination_ledger_id,
        req.body.payment_account_id,
        req.body.amount,
        req.body.narration || "",
        req.body.reference_number,
      );
      // For payment vouchers, skip strict nature validation (Cash/Bank are DEBIT-nature but credited when paid out)
      // Only check balance
      const totalDebit = lines.reduce(
        (s, l) => s + (parseFloat(l.debit_amount) || 0),
        0,
      );
      const totalCredit = lines.reduce(
        (s, l) => s + (parseFloat(l.credit_amount) || 0),
        0,
      );
      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        return res.status(400).json({
          success: false,
          data: {
            valid: false,
            errors: [
              `Journal Entry is not balanced. Total Debit: ${totalDebit}, Total Credit: ${totalCredit}`,
            ],
          },
        });
      }

      res.json({
        success: true,
        data: {
          valid: true,
          errors: [],
          accounting_entry: {
            debit: {
              account_id: req.body.destination_ledger_id,
              amount: req.body.amount,
            },
            credit: {
              account_id: req.body.payment_account_id,
              amount: req.body.amount,
            },
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }

  async postPayment(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validatePayment(companyId, req.body, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const {
        payment_mode,
        payment_date,
        payment_account_id,
        destination_ledger_id,
        amount,
        reference_number,
        narration,
        description,
        contact_id,
        currency,
        exchange_rate,
        financial_year_id,
      } = req.body;

      const lines = this._buildPaymentLines(
        destination_ledger_id,
        payment_account_id,
        amount,
        narration || description || "",
        reference_number,
      );

      let fyId = financial_year_id;
      if (!fyId) {
        const fy = this.voucherRepo.conn.get(
          "SELECT * FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date ORDER BY is_active DESC LIMIT 1",
          [companyId, payment_date, payment_date],
        );
        fyId = fy?.id;
      }

      const jeLines = lines.map((l) => ({
        account_id: l.account_id,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        description: l.description || "",
        cost_centre_id: l.cost_centre_id || null,
        cost_category_id: l.cost_category_id || null,
        reference_id: l.reference_id || null,
      }));

      const voucherNumber = this.voucherRepo.getNextVoucherNumber(
        "PAYMENT",
        companyId,
      );

      const voucher = this.voucherRepo.createPayment(
        {
          companyId,
          voucher_number: voucherNumber,
          payment_mode,
          voucher_date: payment_date,
          reference_number,
          contact_id,
          currency,
          exchange_rate,
          financial_year_id: fyId,
          description: narration || description || "",
          created_by: req.user?.userId || "system",
        },
        jeLines,
      );

      const totalDebit = jeLines.reduce(
        (sum, l) => sum + (parseFloat(l.debit_amount) || 0),
        0,
      );

      const journalEntry = this.journalRepo.createWithValidation(
        {
          id: generateId("je"),
          company_id: companyId,
          voucher_id: voucher.id,
          entry_date: payment_date,
          entry_number: "PY-" + voucherNumber,
          description:
            narration || description || "Payment voucher " + voucherNumber,
          currency: currency || "INR",
          exchange_rate: exchange_rate || 1.0,
          total_debit: totalDebit,
          total_credit: totalDebit,
          status: "POSTED",
          created_by: req.user?.userId || "system",
          financial_year_id: fyId,
        },
        jeLines,
      );

      const postedVoucher = this.voucherRepo.postPayment(
        voucher.id,
        companyId,
        req.user?.userId || "system",
        journalEntry,
      );

      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "payment",
        voucher.id,
        "POST",
        null,
        { ...postedVoucher, journal_entry_id: journalEntry.id },
      );

      res
        .status(201)
        .json(
          successResponse({ ...postedVoucher, journal_entry: journalEntry }),
        );
    } catch (err) {
      next(err);
    }
  }

  async cancelPayment(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "PAYMENT")
        throw new NotFoundError("Payment not found");
      if (voucher.status !== "POSTED")
        throw new AppError(
          "Only posted payments can be cancelled",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.cancel(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "payment",
        req.params.id,
        "CANCEL",
      );
      res.json(
        successResponse({
          id: req.params.id,
          status: "CANCELLED",
          message: "Payment cancelled",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async reversePayment(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "PAYMENT")
        throw new NotFoundError("Payment not found");
      if (voucher.status !== "POSTED")
        throw new AppError(
          "Only posted payments can be reversed",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.reverse(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "payment",
        req.params.id,
        "REVERSE",
      );
      res.json(
        successResponse({
          id: req.params.id,
          status: "REVERSED",
          message: "Payment reversed",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async deletePayment(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "PAYMENT")
        throw new NotFoundError("Payment not found");
      if (voucher.status !== "DRAFT")
        throw new AppError(
          "Cannot delete a " + voucher.status.toLowerCase() + " payment",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.delete(req.params.id, companyId);
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "payment",
        req.params.id,
        "DELETE",
      );
      res.json(successResponse({ message: "Payment deleted" }));
    } catch (err) {
      next(err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 9: Contra Voucher / Internal Fund Transfer
  // Reuses the Step 6 Journal Entry engine, vouchers table, and audit trail.
  // Contra = Debit destination account, Credit source account (internal transfer)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Validate contra input data.
   */
  _validateContra(data, ctx) {
    const errors = [];
    const {
      contra_date,
      source_ledger_id,
      destination_ledger_id,
      amount,
      payment_mode,
      financial_year_id,
      reference_number,
      contact_id,
    } = data;

    if (!contra_date) errors.push("Contra date is required");

    // Financial Year
    let fy = null;
    if (financial_year_id) {
      fy = this.voucherRepo.conn.get(
        "SELECT * FROM financial_years WHERE id = ? AND company_id = ?",
        [financial_year_id, data.companyId],
      );
      if (!fy)
        errors.push(
          "Financial year not found or does not belong to this company",
        );
    } else if (contra_date) {
      fy = this.voucherRepo.conn.get(
        "SELECT * FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date ORDER BY is_active DESC LIMIT 1",
        [data.companyId, contra_date, contra_date],
      );
      if (!fy) errors.push("No financial year found for the contra date");
    }

    if (fy) {
      const fyLock = evaluateFinancialYearLock({ fy, context: ctx });
      if (fyLock.blocked) errors.push(fyLock.reason);
      if (
        contra_date &&
        (contra_date < fy.start_date || contra_date > fy.end_date)
      ) {
        errors.push("Contra date must fall within the selected Financial Year");
      }
    }

    // Source account (Credit side) — must be DEBIT-nature (Cash/Bank/Asset), active, allows posting, Contra-eligible
    if (!source_ledger_id) {
      errors.push("Source ledger account is required");
    } else {
      const acc = this.obRepo.getAccountDetails(
        source_ledger_id,
        data.companyId,
      );
      if (!acc)
        errors.push("Source ledger account not found or not accessible");
      else {
        if (acc.is_group === 1 || acc.is_group === true)
          errors.push(
            `Source account "${acc.name}" is an Account Group, not a Ledger Account`,
          );
        if (acc.is_active === 0 || acc.is_active === false)
          errors.push(`Source account "${acc.name}" is inactive`);
        if (
          acc.allow_direct_posting === 0 ||
          acc.allow_direct_posting === false
        )
          errors.push(
            `Source account "${acc.name}" does not allow direct posting`,
          );
        if (acc.debit_credit_nature !== "DEBIT")
          errors.push(
            `Source account "${acc.name}" is a ${acc.debit_credit_nature}-nature account; source accounts for contra must be DEBIT-nature (Cash/Bank/Asset)`,
          );
      }
    }

    // Destination account (Debit side) — same rules as source
    if (!destination_ledger_id) {
      errors.push("Destination ledger account is required");
    } else {
      const acc = this.obRepo.getAccountDetails(
        destination_ledger_id,
        data.companyId,
      );
      if (!acc)
        errors.push("Destination ledger account not found or not accessible");
      else {
        if (acc.is_group === 1 || acc.is_group === true)
          errors.push(
            `Destination account "${acc.name}" is an Account Group, not a Ledger Account`,
          );
        if (acc.is_active === 0 || acc.is_active === false)
          errors.push(`Destination account "${acc.name}" is inactive`);
        if (
          acc.allow_direct_posting === 0 ||
          acc.allow_direct_posting === false
        )
          errors.push(
            `Destination account "${acc.name}" does not allow direct posting`,
          );
        if (acc.debit_credit_nature !== "DEBIT")
          errors.push(
            `Destination account "${acc.name}" is a ${acc.debit_credit_nature}-nature account; destination accounts for contra must be DEBIT-nature (Cash/Bank/Asset)`,
          );
      }
    }

    // Same account prevention
    if (
      source_ledger_id &&
      destination_ledger_id &&
      source_ledger_id === destination_ledger_id
    ) {
      errors.push("Source and destination accounts must be different");
    }

    // Amount
    if (amount === undefined || amount === null || isNaN(parseFloat(amount)))
      errors.push("Valid amount is required");
    else if (parseFloat(amount) <= 0)
      errors.push("Amount must be greater than zero");

    // Payment mode
    if (
      payment_mode &&
      !["CASH", "BANK", "UPI", "CHEQUE", "CARD", "OTHER"].includes(payment_mode)
    ) {
      errors.push("Invalid payment_mode");
    }

    // Contact (party)
    if (contact_id) {
      try {
        assertTenantRefs(this.conn, data.companyId, { contact_id });
      } catch (e) {
        errors.push(`Party validation failed: ${e.message}`);
      }
    }

    return errors;
  }

  /**
   * Build JE lines for a contra: Debit destination, Credit source.
   */
  _buildContraLines(
    sourceLedgerId,
    destinationLedgerId,
    amount,
    narration,
    referenceNumber,
  ) {
    return [
      {
        account_id: destinationLedgerId,
        debit_amount: parseFloat(amount),
        credit_amount: 0,
        description: narration,
        reference_id: referenceNumber || null,
      },
      {
        account_id: sourceLedgerId,
        debit_amount: 0,
        credit_amount: parseFloat(amount),
        description: narration,
        reference_id: referenceNumber || null,
      },
    ];
  }

  async getContra(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "CONTRA")
        throw new NotFoundError("Contra not found");
      const detail = this.voucherRepo.getWithJournalEntry(
        req.params.id,
        companyId,
      );
      res.json(successResponse(detail));
    } catch (err) {
      next(err);
    }
  }

  async listContras(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {
        companyId,
        voucherType: "CONTRA",
        status: req.query.status,
        limit: parseInt(req.query.limit) || 50,
        startDate: req.query.from,
        endDate: req.query.to,
        contactId: req.query.contact_id,
        query: req.query.q,
      };
      const result = this.voucherRepo.search(options);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async createContraDraft(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateContra({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const {
        payment_mode,
        contra_date,
        reference_number,
        narration,
        description,
        contact_id,
        currency,
        exchange_rate,
        financial_year_id,
        source_ledger_id,
        destination_ledger_id,
      } = req.body;
      const voucherNumber = this.voucherRepo.getNextVoucherNumber(
        "CONTRA",
        companyId,
      );
      const voucher = this.voucherRepo.createContra(
        {
          companyId,
          voucher_number: voucherNumber,
          payment_mode,
          voucher_date: contra_date,
          reference_number,
          contact_id,
          currency,
          exchange_rate,
          financial_year_id,
          description: narration || description || "",
          created_by: req.user?.userId || "system",
        },
        [],
      );

      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "contra",
        voucher.id,
        "DRAFT",
        null,
        { ...voucher, voucher_number: voucherNumber },
      );
      res
        .status(201)
        .json(successResponse({ ...voucher, voucher_number: voucherNumber }));
    } catch (err) {
      next(err);
    }
  }

  async validateContra(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateContra({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const lines = this._buildContraLines(
        req.body.source_ledger_id,
        req.body.destination_ledger_id,
        req.body.amount,
        req.body.narration || "",
        req.body.reference_number,
      );
      // For contra vouchers, skip strict nature validation (both accounts are DEBIT-nature, one debited one credited)
      const totalDebit = lines.reduce(
        (s, l) => s + (parseFloat(l.debit_amount) || 0),
        0,
      );
      const totalCredit = lines.reduce(
        (s, l) => s + (parseFloat(l.credit_amount) || 0),
        0,
      );
      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        return res.status(400).json({
          success: false,
          data: {
            valid: false,
            errors: [
              `Journal Entry is not balanced. Total Debit: ${totalDebit}, Total Credit: ${totalCredit}`,
            ],
          },
        });
      }

      res.json({
        success: true,
        data: {
          valid: true,
          errors: [],
          accounting_entry: {
            debit: {
              account_id: req.body.destination_ledger_id,
              amount: req.body.amount,
            },
            credit: {
              account_id: req.body.source_ledger_id,
              amount: req.body.amount,
            },
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }

  async postContra(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateContra({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const {
        payment_mode,
        contra_date,
        source_ledger_id,
        destination_ledger_id,
        amount,
        reference_number,
        narration,
        description,
        contact_id,
        currency,
        exchange_rate,
        financial_year_id,
      } = req.body;

      const lines = this._buildContraLines(
        source_ledger_id,
        destination_ledger_id,
        amount,
        narration || description || "",
        reference_number,
      );

      let fyId = financial_year_id;
      if (!fyId) {
        const fy = this.voucherRepo.conn.get(
          "SELECT * FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date ORDER BY is_active DESC LIMIT 1",
          [companyId, contra_date, contra_date],
        );
        fyId = fy?.id;
      }

      const jeLines = lines.map((l) => ({
        account_id: l.account_id,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        description: l.description || "",
        cost_centre_id: l.cost_centre_id || null,
        cost_category_id: l.cost_category_id || null,
        reference_id: l.reference_id || null,
      }));

      const voucherNumber = this.voucherRepo.getNextVoucherNumber(
        "CONTRA",
        companyId,
      );

      const voucher = this.voucherRepo.createContra(
        {
          companyId,
          voucher_number: voucherNumber,
          payment_mode,
          voucher_date: contra_date,
          reference_number,
          contact_id,
          currency,
          exchange_rate,
          financial_year_id: fyId,
          description: narration || description || "",
          created_by: req.user?.userId || "system",
        },
        jeLines,
      );

      const totalDebit = jeLines.reduce(
        (sum, l) => sum + (parseFloat(l.debit_amount) || 0),
        0,
      );

      const journalEntry = this.journalRepo.createWithValidation(
        {
          id: generateId("je"),
          company_id: companyId,
          voucher_id: voucher.id,
          entry_date: contra_date,
          entry_number: "CT-" + voucherNumber,
          description:
            narration || description || "Contra voucher " + voucherNumber,
          currency: currency || "INR",
          exchange_rate: exchange_rate || 1.0,
          total_debit: totalDebit,
          total_credit: totalDebit,
          status: "POSTED",
          created_by: req.user?.userId || "system",
          financial_year_id: fyId,
        },
        jeLines,
      );

      const postedVoucher = this.voucherRepo.postContra(
        voucher.id,
        companyId,
        req.user?.userId || "system",
        journalEntry,
      );

      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "contra",
        voucher.id,
        "POST",
        null,
        { ...postedVoucher, journal_entry_id: journalEntry.id },
      );
      res
        .status(201)
        .json(
          successResponse({ ...postedVoucher, journal_entry: journalEntry }),
        );
    } catch (err) {
      next(err);
    }
  }

  async cancelContra(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "CONTRA")
        throw new NotFoundError("Contra not found");
      if (voucher.status !== "POSTED")
        throw new AppError(
          "Only posted contras can be cancelled",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.cancel(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "contra",
        req.params.id,
        "CANCEL",
      );
      res.json(
        successResponse({
          id: req.params.id,
          status: "CANCELLED",
          message: "Contra cancelled",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async reverseContra(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "CONTRA")
        throw new NotFoundError("Contra not found");
      if (voucher.status !== "POSTED")
        throw new AppError(
          "Only posted contras can be reversed",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.reverse(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "contra",
        req.params.id,
        "REVERSE",
      );
      res.json(
        successResponse({
          id: req.params.id,
          status: "REVERSED",
          message: "Contra reversed",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async deleteContra(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "CONTRA")
        throw new NotFoundError("Contra not found");
      if (voucher.status !== "DRAFT")
        throw new AppError(
          "Cannot delete a " + voucher.status.toLowerCase() + " contra",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.delete(req.params.id, companyId);
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "contra",
        req.params.id,
        "DELETE",
      );
      res.json(successResponse({ message: "Contra deleted" }));
    } catch (err) {
      next(err);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Step 10: Sales Voucher / Sales Invoice
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Validate a Sales Voucher.
   * Sales accounting: Debit receiving/asset account, Credit sales revenue.
   */
  _validateSales(data, ctx) {
    const errors = [];
    const {
      sales_date,
      receiving_ledger_id,
      sales_ledger_id,
      amount,
      payment_mode,
      narration,
      reference_number,
      financial_year_id,
      contact_id,
    } = data;
    const companyId = data.companyId;

    // Contact / Customer
    if (contact_id) {
      try {
        assertTenantRefs(this.voucherRepo.conn, companyId, { contact_id });
      } catch (e) {
        errors.push(`Customer validation failed: ${e.message}`);
      }
    }

    // Financial Year
    let fy = null;
    if (financial_year_id) {
      fy = this.voucherRepo.conn.get(
        "SELECT * FROM financial_years WHERE id = ? AND company_id = ?",
        [financial_year_id, companyId],
      );
      if (!fy)
        errors.push(
          "Financial year not found or does not belong to this company",
        );
    } else if (sales_date) {
      fy = this.voucherRepo.conn.get(
        "SELECT * FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date ORDER BY is_active DESC LIMIT 1",
        [companyId, sales_date, sales_date],
      );
      if (!fy) errors.push("No financial year found for the sales date");
    }
    if (fy) {
      const fyLock = evaluateFinancialYearLock({ fy, context: ctx });
      if (fyLock.blocked) errors.push(fyLock.reason);
      if (
        sales_date &&
        (sales_date < fy.start_date || sales_date > fy.end_date)
      ) {
        errors.push("Sales date must fall within the selected Financial Year");
      }
    }

    // Sales Revenue ledger (Credit side) — must be INCOME/CREDIT nature
    if (!sales_ledger_id) {
      errors.push("Sales ledger account is required");
    } else {
      const acc = this.obRepo.getAccountDetails(sales_ledger_id, companyId);
      if (!acc) errors.push("Sales ledger account not found or not accessible");
      else {
        if (acc.is_group === 1 || acc.is_group === true)
          errors.push(
            `Sales ledger "${acc.name}" is an Account Group, not a Ledger Account`,
          );
        if (acc.is_active === 0 || acc.is_active === false)
          errors.push(`Sales ledger "${acc.name}" is inactive`);
        if (
          acc.allow_direct_posting === 0 ||
          acc.allow_direct_posting === false
        )
          errors.push(
            `Sales ledger "${acc.name}" does not allow direct posting`,
          );
        if (acc.debit_credit_nature !== "CREDIT")
          errors.push(
            `Sales ledger "${acc.name}" is a ${acc.debit_credit_nature}-nature account; sales revenue must be a CREDIT-nature account`,
          );
      }
    }

    // Receiving ledger (Debit side) — Cash/Bank/Receivable (DEBIT-nature)
    if (!receiving_ledger_id) {
      errors.push("Receiving ledger account is required");
    } else {
      const acc = this.obRepo.getAccountDetails(receiving_ledger_id, companyId);
      if (!acc)
        errors.push("Receiving ledger account not found or not accessible");
      else {
        if (acc.is_group === 1 || acc.is_group === true)
          errors.push(
            `Receiving ledger "${acc.name}" is an Account Group, not a Ledger Account`,
          );
        if (acc.is_active === 0 || acc.is_active === false)
          errors.push(`Receiving ledger "${acc.name}" is inactive`);
        if (
          acc.allow_direct_posting === 0 ||
          acc.allow_direct_posting === false
        )
          errors.push(
            `Receiving ledger "${acc.name}" does not allow direct posting`,
          );
        if (acc.debit_credit_nature !== "DEBIT")
          errors.push(
            `Receiving ledger "${acc.name}" is a ${acc.debit_credit_nature}-nature account; receiving accounts must be DEBIT-nature (Cash/Bank/Receivable)`,
          );
      }
    }

    // Amount
    if (amount === undefined || amount === null || isNaN(parseFloat(amount)))
      errors.push("Valid amount is required");
    else if (parseFloat(amount) <= 0)
      errors.push("Amount must be greater than zero");

    // Tax Master (optional)
    const { tax_master_id } = data;
    if (tax_master_id) {
      const tm = this.voucherRepo.conn.get(
        "SELECT id, is_active, rate FROM tax_masters WHERE id = ? AND company_id = ?",
        [tax_master_id, companyId],
      );
      if (!tm)
        errors.push("Tax master not found or does not belong to this company");
      else if (tm.is_active === 0 || tm.is_active === false)
        errors.push("Tax master is inactive");
    }

    // Payment mode
    const validModes = [
      "CASH",
      "BANK",
      "CREDIT",
      "UPI",
      "CHEQUE",
      "CARD",
      "OTHER",
    ];
    if (payment_mode && !validModes.includes(payment_mode))
      errors.push("Invalid payment_mode");

    // Same account prevention
    if (
      receiving_ledger_id &&
      sales_ledger_id &&
      receiving_ledger_id === sales_ledger_id
    ) {
      errors.push("Receiving and sales accounts must be different");
    }

    return errors;
  }

  /**
   * Build JE lines for a sales voucher: Debit receiving account, Credit sales revenue.
   * When tax is applicable (taxResult provided), adds Output CGST/SGST/IGST credit lines
   * and increases the receiving account debit to include tax.
   *
   * @param {string} receivingLedgerId - Dr side (Cash/Bank/Receivable)
   * @param {string} salesLedgerId - Cr side (Sales Revenue)
   * @param {number} amount - the taxable amount (or grand total if no tax)
   * @param {string} narration
   * @param {string} referenceNumber
   * @param {Object|null} taxResult - result from TaxService.calculateTax()
   * @param {string} companyId - for tax ledger lookups
   */
  _buildSalesLines(
    receivingLedgerId,
    salesLedgerId,
    amount,
    narration,
    referenceNumber,
    taxResult = null,
    companyId = "default",
  ) {
    const amt = parseFloat(amount);
    const lines = [];

    if (
      taxResult &&
      (taxResult.total_tax > 0 ||
        taxResult.cgst_amount > 0 ||
        taxResult.sgst_amount > 0 ||
        taxResult.igst_amount > 0)
    ) {
      // With tax: amt = taxable amount
      // Dr Receiving (taxable + tax), Cr Sales Revenue (taxable), Cr Output Tax (tax)
      const grandTotal = parseFloat(taxResult.grand_total);
      lines.push({
        account_id: receivingLedgerId,
        debit_amount: grandTotal,
        credit_amount: 0,
        description: narration,
        reference_id: referenceNumber || null,
      });
      lines.push({
        account_id: salesLedgerId,
        debit_amount: 0,
        credit_amount: amt,
        description: narration,
        reference_id: referenceNumber || null,
      });

      // Add output tax credit lines (CGST, SGST, IGST, CESS)
      if (taxResult.cgst_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "CGST",
          "OUTPUT",
        );
        if (mapping && mapping.is_active === 1) {
          lines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: 0,
            credit_amount: taxResult.cgst_amount,
            description: `Output CGST @ ${taxResult.cgst_rate}%`,
            reference_id: referenceNumber || null,
          });
        }
      }
      if (taxResult.sgst_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "SGST",
          "OUTPUT",
        );
        if (mapping && mapping.is_active === 1) {
          lines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: 0,
            credit_amount: taxResult.sgst_amount,
            description: `Output SGST @ ${taxResult.sgst_rate}%`,
            reference_id: referenceNumber || null,
          });
        }
      }
      if (taxResult.igst_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "IGST",
          "OUTPUT",
        );
        if (mapping && mapping.is_active === 1) {
          lines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: 0,
            credit_amount: taxResult.igst_amount,
            description: `Output IGST @ ${taxResult.igst_rate}%`,
            reference_id: referenceNumber || null,
          });
        }
      }
      if (taxResult.cess_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "CESS",
          "OUTPUT",
        );
        if (mapping && mapping.is_active === 1) {
          lines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: 0,
            credit_amount: taxResult.cess_amount,
            description: `Output CESS @ ${taxResult.cess_rate}%`,
            reference_id: referenceNumber || null,
          });
        }
      }
    } else {
      // No tax: original behavior
      lines.push({
        account_id: receivingLedgerId,
        debit_amount: amt,
        credit_amount: 0,
        description: narration,
        reference_id: referenceNumber || null,
      });
      lines.push({
        account_id: salesLedgerId,
        debit_amount: 0,
        credit_amount: amt,
        description: narration,
        reference_id: referenceNumber || null,
      });
    }

    return lines;
  }

  async getSales(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "SALES")
        throw new NotFoundError("Sales invoice not found");
      const detail = this.voucherRepo.getWithJournalEntry(
        req.params.id,
        companyId,
      );
      res.json(successResponse(detail));
    } catch (err) {
      next(err);
    }
  }

  async listSales(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {
        companyId,
        voucherType: "SALES",
        status: req.query.status,
        limit: parseInt(req.query.limit) || 50,
        startDate: req.query.from,
        endDate: req.query.to,
        contactId: req.query.contact_id,
        query: req.query.q,
      };
      const result = this.voucherRepo.search(options);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async createSalesDraft(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateSales({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const {
        payment_mode,
        sales_date,
        reference_number,
        narration,
        description,
        contact_id,
        currency,
        exchange_rate,
        financial_year_id,
        sales_ledger_id,
        receiving_ledger_id,
        amount,
      } = req.body;
      const voucherNumber = this.voucherRepo.getNextVoucherNumber(
        "SALES",
        companyId,
      );
      const voucher = this.voucherRepo.createSales(
        {
          companyId,
          voucher_number: voucherNumber,
          payment_mode,
          voucher_date: sales_date,
          reference_number,
          contact_id,
          currency,
          exchange_rate,
          financial_year_id,
          sales_ledger_id,
          receiving_ledger_id,
          description: narration || description || "",
          created_by: req.user?.userId || "system",
          sales_invoice_number: reference_number || voucherNumber,
        },
        [],
      );

      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "sales",
        voucher.id,
        "DRAFT",
        null,
        { ...voucher, voucher_number: voucherNumber },
      );
      res
        .status(201)
        .json(successResponse({ ...voucher, voucher_number: voucherNumber }));
    } catch (err) {
      next(err);
    }
  }

  async validateSales(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateSales({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      // Calculate tax if tax_master_id is provided
      const taxResult = req.body.tax_master_id
        ? this.taxService.calculateTax({
            companyId,
            taxableAmount: req.body.amount,
            taxMasterId: req.body.tax_master_id,
            partyState: req.body.party_state || req.body.customer_state,
            companyState: req.body.company_state,
          })
        : null;

      const lines = this._buildSalesLines(
        req.body.receiving_ledger_id,
        req.body.sales_ledger_id,
        req.body.amount,
        req.body.narration || "",
        req.body.reference_number,
        taxResult,
        companyId,
      );
      const totalDebit = lines.reduce(
        (s, l) => s + (parseFloat(l.debit_amount) || 0),
        0,
      );
      const totalCredit = lines.reduce(
        (s, l) => s + (parseFloat(l.credit_amount) || 0),
        0,
      );

      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        errors.push(
          `Journal Entry is not balanced. Debit: ${totalDebit}, Credit: ${totalCredit}`,
        );
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });
      }

      res.json({
        success: true,
        data: {
          valid: true,
          errors: [],
          accounting_entry: {
            debit: {
              account_id: req.body.receiving_ledger_id,
              amount: taxResult ? taxResult.grand_total : req.body.amount,
            },
            credit: {
              account_id: req.body.sales_ledger_id,
              amount: req.body.amount,
            },
          },
          tax: taxResult,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  async postSales(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateSales({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const {
        payment_mode,
        sales_date,
        reference_number,
        narration,
        description,
        contact_id,
        currency,
        exchange_rate,
        financial_year_id,
        sales_ledger_id,
        receiving_ledger_id,
        amount,
        tax_master_id,
      } = req.body;

      // Calculate tax if tax_master_id is provided (server-side authoritative)
      const taxResult = tax_master_id
        ? this.taxService.calculateTax({
            companyId,
            taxableAmount: amount,
            taxMasterId: tax_master_id,
            partyState: req.body.party_state || req.body.customer_state,
            companyState: req.body.company_state,
          })
        : null;

      const lines = this._buildSalesLines(
        receiving_ledger_id,
        sales_ledger_id,
        amount,
        narration || description || "",
        reference_number,
        taxResult,
        companyId,
      );

      let fyId = financial_year_id;
      if (!fyId) {
        const fy = this.voucherRepo.conn.get(
          "SELECT * FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date ORDER BY is_active DESC LIMIT 1",
          [companyId, sales_date, sales_date],
        );
        fyId = fy?.id;
      }

      const jeLines = lines.map((l) => ({
        account_id: l.account_id,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        description: l.description || "",
        cost_centre_id: l.cost_centre_id || null,
        cost_category_id: l.cost_category_id || null,
        reference_id: l.reference_id || null,
      }));

      const voucherNumber = this.voucherRepo.getNextVoucherNumber(
        "SALES",
        companyId,
      );

      const voucher = this.voucherRepo.createSales(
        {
          companyId,
          voucher_number: voucherNumber,
          payment_mode,
          voucher_date: sales_date,
          reference_number,
          contact_id,
          currency,
          exchange_rate,
          financial_year_id: fyId,
          sales_ledger_id,
          receiving_ledger_id,
          description: narration || description || "",
          created_by: req.user?.userId || "system",
          sales_invoice_number: reference_number || voucherNumber,
        },
        jeLines,
      );

      const totalDebit = jeLines.reduce(
        (sum, l) => sum + (parseFloat(l.debit_amount) || 0),
        0,
      );

      const journalEntry = this.journalRepo.createWithValidation(
        {
          id: generateId("je"),
          company_id: companyId,
          voucher_id: voucher.id,
          entry_date: sales_date,
          entry_number: voucherNumber,
          description:
            narration || description || "Sales invoice " + voucherNumber,
          currency: currency || "INR",
          exchange_rate: exchange_rate || 1.0,
          total_debit: totalDebit,
          total_credit: totalDebit,
          status: "POSTED",
          created_by: req.user?.userId || "system",
          financial_year_id: fyId,
        },
        jeLines,
      );

      const postedVoucher = this.voucherRepo.postSales(
        voucher.id,
        companyId,
        req.user?.userId || "system",
        journalEntry,
      );

      // Save tax transaction details if tax was calculated
      if (taxResult) {
        this.taxService.saveTransactionTaxDetails({
          companyId,
          voucherId: voucher.id,
          journalEntryId: journalEntry.id,
          taxMasterId: tax_master_id,
          taxableAmount: amount,
          taxType: taxResult.tax_type,
          taxRate: taxResult.tax_rate,
          cgstRate: taxResult.cgst_rate,
          sgstRate: taxResult.sgst_rate,
          igstRate: taxResult.igst_rate,
          cessRate: taxResult.cess_rate,
          cgstAmount: taxResult.cgst_amount,
          sgstAmount: taxResult.sgst_amount,
          igstAmount: taxResult.igst_amount,
          cessAmount: taxResult.cess_amount,
          totalTax: taxResult.total_tax,
          grandTotal: taxResult.grand_total,
          placeOfSupply: taxResult.place_of_supply,
          isInterstate: taxResult.is_interstate,
          breakdown: taxResult.breakdown,
          userId: req.user?.userId || "system",
        });
      }

      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "sales",
        voucher.id,
        "POST",
        null,
        {
          ...postedVoucher,
          journal_entry_id: journalEntry.id,
          tax: taxResult
            ? {
                taxable_amount: amount,
                total_tax: taxResult.total_tax,
                grand_total: taxResult.grand_total,
              }
            : null,
        },
      );
      res.status(201).json(
        successResponse({
          ...postedVoucher,
          journal_entry: journalEntry,
          tax_details: taxResult,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async cancelSales(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "SALES")
        throw new NotFoundError("Sales invoice not found");
      if (voucher.status !== "POSTED")
        throw new AppError(
          "Only posted sales invoices can be cancelled",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.cancel(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "sales",
        req.params.id,
        "CANCEL",
      );
      res.json(
        successResponse({
          id: req.params.id,
          status: "CANCELLED",
          message: "Sales invoice cancelled",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async reverseSales(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "SALES")
        throw new NotFoundError("Sales invoice not found");
      if (voucher.status !== "POSTED")
        throw new AppError(
          "Only posted sales invoices can be reversed",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.reverse(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "sales",
        req.params.id,
        "REVERSE",
      );
      res.json(
        successResponse({
          id: req.params.id,
          status: "REVERSED",
          message: "Sales invoice reversed",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async deleteSales(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "SALES")
        throw new NotFoundError("Sales invoice not found");
      if (voucher.status !== "DRAFT")
        throw new AppError(
          "Cannot delete a " + voucher.status.toLowerCase() + " sales invoice",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.delete(req.params.id, companyId);
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "sales",
        req.params.id,
        "DELETE",
      );
      res.json(successResponse({ message: "Sales invoice deleted" }));
    } catch (err) {
      next(err);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Step 11: Purchase Voucher / Purchase Invoice
  // ════════════════════════════════════════════════════════════════════════

  _validatePurchase(data, ctx) {
    const errors = [];
    const companyId = data.companyId;
    const {
      purchase_date,
      supplier_id,
      contact_id,
      purchase_ledger_id,
      payable_ledger_id,
      payment_mode,
      amount,
      currency,
      financial_year_id,
      purchase_invoice_number,
      tax_master_id,
    } = data;

    // Party: supplier / contact
    const partyId = supplier_id || contact_id;
    if (!partyId) {
      errors.push("Supplier is required");
    } else {
      const party = this.voucherRepo.conn.get(
        "SELECT id FROM contacts WHERE id = ? AND company_id = ?",
        [partyId, companyId],
      );
      if (!party)
        errors.push("Supplier not found or does not belong to this company");
    }

    // Financial Year
    let fy = null;
    if (financial_year_id) {
      fy = this.voucherRepo.conn.get(
        "SELECT * FROM financial_years WHERE id = ? AND company_id = ?",
        [financial_year_id, companyId],
      );
      if (!fy)
        errors.push(
          "Financial year not found or does not belong to this company",
        );
    } else if (purchase_date) {
      fy = this.voucherRepo.conn.get(
        "SELECT * FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date ORDER BY is_active DESC LIMIT 1",
        [companyId, purchase_date, purchase_date],
      );
      if (!fy) errors.push("No financial year found for the purchase date");
    }
    if (fy) {
      const fyLock = evaluateFinancialYearLock({ fy, context: ctx });
      if (fyLock.blocked) errors.push(fyLock.reason);
      if (
        purchase_date &&
        (purchase_date < fy.start_date || purchase_date > fy.end_date)
      ) {
        errors.push(
          "Purchase date must fall within the selected Financial Year",
        );
      }
    }

    // Purchase Ledger (Debit side — Expense/Asset/Inventory)
    if (!purchase_ledger_id) {
      errors.push("Purchase ledger is required");
    } else {
      const acc = this.obRepo.getAccountDetails(purchase_ledger_id, companyId);
      if (!acc) errors.push("Purchase ledger not found or not accessible");
      else {
        if (acc.is_group === 1 || acc.is_group === true)
          errors.push(
            `Purchase ledger "${acc.name}" is an Account Group, not a Ledger Account`,
          );
        if (acc.is_active === 0 || acc.is_active === false)
          errors.push(`Purchase ledger "${acc.name}" is inactive`);
        // Purchase accounts (Expense/Asset) are DEBIT-nature — the debit side increases them
        if (acc.debit_credit_nature !== "DEBIT")
          errors.push(
            `Purchase ledger "${acc.name}" is a ${acc.debit_credit_nature}-nature account; purchase ledgers must be DEBIT-nature`,
          );
      }
    }

    // Payable / Payment Ledger (Credit side)
    const payableId = payable_ledger_id;
    if (!payableId) {
      // For cash/bank purchases, receiving_ledger_id serves as the credit side
      if (!payment_mode || payment_mode === "CREDIT") {
        errors.push("Payable/Supplier ledger is required for credit purchases");
      }
    } else {
      const acc = this.obRepo.getAccountDetails(payableId, companyId);
      if (!acc) errors.push("Payable ledger not found or not accessible");
      else {
        if (acc.is_group === 1 || acc.is_group === true)
          errors.push(
            `Payable ledger "${acc.name}" is an Account Group, not a Ledger Account`,
          );
        if (acc.is_active === 0 || acc.is_active === false)
          errors.push(`Payable ledger "${acc.name}" is inactive`);
        // Payable (Accounts Payable / Cash / Bank) are CREDIT-nature (Liability) or DEBIT-nature (Cash/Bank for cash purchases)
        // For credit purchases, payable should be CREDIT-nature (Liability)
        if (payment_mode === "CREDIT" && acc.debit_credit_nature !== "CREDIT") {
          errors.push(
            `Payable ledger "${acc.name}" is a ${acc.debit_credit_nature}-nature account; credit purchases require a CREDIT-nature payable account`,
          );
        }
        // For cash/bank purchases, the credit side should be DEBIT-nature (Cash/Bank)
        if (
          (payment_mode === "CASH" ||
            payment_mode === "BANK" ||
            payment_mode === "UPI" ||
            payment_mode === "CHEQUE") &&
          acc.debit_credit_nature !== "DEBIT"
        ) {
          errors.push(
            `Payment ledger "${acc.name}" is a ${acc.debit_credit_nature}-nature account; cash/bank payment ledgers must be DEBIT-nature (Cash/Bank)`,
          );
        }
      }
    }

    // Receiving ledger (for cash/bank purchase payments)
    if (
      payment_mode === "CASH" ||
      payment_mode === "BANK" ||
      payment_mode === "UPI" ||
      payment_mode === "CHEQUE"
    ) {
      const receivingId = data.receiving_ledger_id || payable_ledger_id;
      if (!receivingId) {
        errors.push(
          "Receiving/Payment ledger is required for " +
            (payment_mode || "cash/bank") +
            " purchases",
        );
      }
    }

    // Amount
    if (amount === undefined || amount === null || isNaN(parseFloat(amount)))
      errors.push("Valid amount is required");
    else if (parseFloat(amount) <= 0)
      errors.push("Amount must be greater than zero");

    // Invoice number
    if (!purchase_invoice_number && !data.reference_number) {
      errors.push("Invoice number or reference number is required");
    }

    // Tax Master (optional)
    if (tax_master_id) {
      const tm = this.voucherRepo.conn.get(
        "SELECT id, is_active, rate FROM tax_masters WHERE id = ? AND company_id = ?",
        [tax_master_id, companyId],
      );
      if (!tm)
        errors.push("Tax master not found or does not belong to this company");
      else if (tm.is_active === 0 || tm.is_active === false)
        errors.push("Tax master is inactive");
    }

    return errors;
  }

  /**
   * Build JE lines for a purchase voucher: Dr Purchase/Expense, Cr Payable/Cash/Bank.
   * When tax is applicable (taxResult provided), adds Input CGST/SGST/IGST DEBIT lines
   * and increases the credit side to include tax (grand total).
   *
   * @param {string} purchaseLedgerId - Dr side (Purchase/Inventory)
   * @param {string} payableLedgerId - Cr side (Payable/Cash/Bank)
   * @param {number} amount - the taxable amount (or grand total if no tax)
   * @param {string} paymentMode
   * @param {Object|null} taxResult - result from TaxService.calculateTax()
   * @param {string} companyId - for tax ledger lookups
   */
  _buildPurchaseLines(
    purchaseLedgerId,
    payableLedgerId,
    amount,
    paymentMode,
    taxResult = null,
    companyId = "default",
  ) {
    const amt = parseFloat(amount);
    const lines = [];
    const narration = "Purchase invoice";

    if (
      taxResult &&
      (taxResult.total_tax > 0 ||
        taxResult.cgst_amount > 0 ||
        taxResult.sgst_amount > 0 ||
        taxResult.igst_amount > 0)
    ) {
      // With tax: amt = taxable amount
      // Dr Purchase (taxable), Dr Input CGST/SGST/IGST (tax), Cr Payable (grand total)
      lines.push({
        account_id: purchaseLedgerId,
        debit_amount: amt,
        credit_amount: 0,
        description: narration,
        reference_id: null,
      });

      // Add input tax DEBIT lines (purchases get input tax credit)
      if (taxResult.cgst_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "CGST",
          "INPUT",
        );
        if (mapping && mapping.is_active === 1) {
          lines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: taxResult.cgst_amount,
            credit_amount: 0,
            description: `Input CGST @ ${taxResult.cgst_rate}%`,
            reference_id: null,
          });
        }
      }
      if (taxResult.sgst_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "SGST",
          "INPUT",
        );
        if (mapping && mapping.is_active === 1) {
          lines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: taxResult.sgst_amount,
            credit_amount: 0,
            description: `Input SGST @ ${taxResult.sgst_rate}%`,
            reference_id: null,
          });
        }
      }
      if (taxResult.igst_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "IGST",
          "INPUT",
        );
        if (mapping && mapping.is_active === 1) {
          lines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: taxResult.igst_amount,
            credit_amount: 0,
            description: `Input IGST @ ${taxResult.igst_rate}%`,
            reference_id: null,
          });
        }
      }
      if (taxResult.cess_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "CESS",
          "INPUT",
        );
        if (mapping && mapping.is_active === 1) {
          lines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: taxResult.cess_amount,
            credit_amount: 0,
            description: `Input CESS @ ${taxResult.cess_rate}%`,
            reference_id: null,
          });
        }
      }

      // Credit side = grand total (taxable + tax)
      const creditLedger = payableLedgerId || purchaseLedgerId;
      const grandTotal = parseFloat(taxResult.grand_total);
      lines.push({
        account_id: creditLedger,
        debit_amount: 0,
        credit_amount: grandTotal,
        description: narration,
        reference_id: null,
      });
    } else {
      // No tax: existing simple Dr/Cr
      const creditLedger = payableLedgerId || purchaseLedgerId;
      lines.push({
        account_id: purchaseLedgerId,
        debit_amount: amt,
        credit_amount: 0,
        description: narration,
        reference_id: null,
      });
      lines.push({
        account_id: creditLedger,
        debit_amount: 0,
        credit_amount: amt,
        description: narration,
        reference_id: null,
      });
    }

    return lines;
  }

  async getPurchase(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "PURCHASE")
        throw new NotFoundError("Purchase invoice not found");
      const detail = this.voucherRepo.getWithJournalEntry(
        req.params.id,
        companyId,
      );
      res.json(successResponse(detail));
    } catch (err) {
      next(err);
    }
  }

  async listPurchases(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {
        companyId,
        voucherType: "PURCHASE",
        status: req.query.status,
        limit: parseInt(req.query.limit) || 50,
        startDate: req.query.from,
        endDate: req.query.to,
        contactId: req.query.supplier_id || req.query.contact_id,
        query: req.query.q,
      };
      const result = this.voucherRepo.search(options);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async createPurchaseDraft(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validatePurchase({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const voucherNumber = this.voucherRepo.getNextVoucherNumber(
        "PURCHASE",
        companyId,
      );
      const voucher = this.voucherRepo.createPurchase(
        {
          companyId,
          voucher_number: voucherNumber,
          payment_mode: req.body.payment_mode || req.body.receipt_mode,
          voucher_date: req.body.purchase_date,
          reference_number: req.body.reference_number,
          contact_id: req.body.supplier_id || req.body.contact_id,
          currency: req.body.currency,
          exchange_rate: req.body.exchange_rate,
          financial_year_id: req.body.financial_year_id,
          purchase_ledger_id: req.body.purchase_ledger_id,
          payable_ledger_id: req.body.payable_ledger_id,
          receiving_ledger_id: req.body.receiving_ledger_id,
          purchase_invoice_number:
            req.body.purchase_invoice_number || req.body.invoice_number,
          description: req.body.narration || req.body.description || "",
          created_by: req.user?.userId || "system",
        },
        [],
      );
      res.status(201).json(successResponse(voucher));
    } catch (err) {
      next(err);
    }
  }

  async validatePurchase(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validatePurchase({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      // Calculate tax if tax_master_id is provided (server-side authoritative)
      const taxResult = req.body.tax_master_id
        ? this.taxService.calculateTax({
            companyId,
            taxableAmount: req.body.amount,
            taxMasterId: req.body.tax_master_id,
            partyState: req.body.party_state || req.body.supplier_state,
            companyState: req.body.company_state,
          })
        : null;

      const lines = this._buildPurchaseLines(
        req.body.purchase_ledger_id,
        req.body.payable_ledger_id || req.body.receiving_ledger_id,
        req.body.amount,
        req.body.payment_mode,
        taxResult,
        companyId,
      );
      const totalDebit = lines.reduce(
        (s, l) => s + (parseFloat(l.debit_amount) || 0),
        0,
      );
      const totalCredit = lines.reduce(
        (s, l) => s + (parseFloat(l.credit_amount) || 0),
        0,
      );

      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        return res.status(400).json({
          success: false,
          data: {
            valid: false,
            errors: [
              `Journal Entry is not balanced. Debit: ${totalDebit}, Credit: ${totalCredit}`,
            ],
          },
        });
      }

      res.json({
        success: true,
        data: {
          valid: true,
          errors: [],
          accountingEntry: {
            debit: {
              accountId: req.body.purchase_ledger_id,
              amount: taxResult ? taxResult.grand_total : req.body.amount,
            },
            credit: {
              accountId:
                req.body.payable_ledger_id ||
                req.body.receiving_ledger_id ||
                req.body.purchase_ledger_id,
              amount: taxResult ? taxResult.grand_total : req.body.amount,
            },
          },
          tax: taxResult,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  async postPurchase(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validatePurchase({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const {
        purchase_date,
        supplier_id,
        contact_id,
        reference_number,
        narration,
        description,
        currency,
        exchange_rate,
        financial_year_id,
        purchase_ledger_id,
        payable_ledger_id,
        receiving_ledger_id,
        payment_mode,
        amount,
        purchase_invoice_number,
        tax_master_id,
      } = req.body;

      // Calculate tax if tax_master_id is provided (server-side authoritative)
      const taxResult = tax_master_id
        ? this.taxService.calculateTax({
            companyId,
            taxableAmount: amount,
            taxMasterId: tax_master_id,
            partyState: req.body.party_state || req.body.supplier_state,
            companyState: req.body.company_state,
          })
        : null;

      const lines = this._buildPurchaseLines(
        purchase_ledger_id,
        payable_ledger_id || receiving_ledger_id,
        amount,
        payment_mode,
        taxResult,
        companyId,
      );

      let fyId = financial_year_id;
      if (!fyId) {
        const fy = this.voucherRepo.conn.get(
          "SELECT * FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date ORDER BY is_active DESC LIMIT 1",
          [companyId, purchase_date, purchase_date],
        );
        fyId = fy?.id;
      }

      const jeLines = lines.map((l) => ({
        account_id: l.account_id,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        description: l.description || "",
        cost_centre_id: l.cost_centre_id || null,
        cost_category_id: l.cost_category_id || null,
        reference_id: l.reference_id || null,
      }));

      const voucherNumber = this.voucherRepo.getNextVoucherNumber(
        "PURCHASE",
        companyId,
      );
      let totalDebit = jeLines.reduce(
        (sum, l) => sum + (parseFloat(l.debit_amount) || 0),
        0,
      );

      const voucher = this.voucherRepo.createPurchase(
        {
          companyId,
          voucher_number: voucherNumber,
          payment_mode: payment_mode || "CREDIT",
          voucher_date: purchase_date,
          reference_number,
          contact_id: supplier_id || contact_id,
          currency,
          exchange_rate,
          financial_year_id: fyId,
          purchase_ledger_id,
          payable_ledger_id,
          receiving_ledger_id,
          purchase_invoice_number:
            purchase_invoice_number || reference_number || voucherNumber,
          description: narration || description || "",
          created_by: req.user?.userId || "system",
        },
        jeLines,
      );

      const journalEntry = this.journalRepo.createWithValidation(
        {
          id: generateId("je"),
          company_id: companyId,
          voucher_id: voucher.id,
          entry_date: purchase_date,
          entry_number: voucherNumber,
          description:
            narration || description || "Purchase invoice " + voucherNumber,
          currency: currency || "INR",
          exchange_rate: exchange_rate || 1.0,
          total_debit: totalDebit,
          total_credit: totalDebit,
          status: "POSTED",
          created_by: req.user?.userId || "system",
          financial_year_id: fyId,
        },
        jeLines,
      );

      const postedVoucher = this.voucherRepo.postPurchase(
        voucher.id,
        companyId,
        req.user?.userId || "system",
        journalEntry,
      );

      // Save tax transaction details if tax was calculated
      if (taxResult) {
        this.taxService.saveTransactionTaxDetails({
          companyId,
          voucherId: voucher.id,
          journalEntryId: journalEntry.id,
          taxMasterId: tax_master_id,
          taxableAmount: amount,
          taxType: taxResult.tax_type,
          taxRate: taxResult.tax_rate,
          cgstRate: taxResult.cgst_rate,
          sgstRate: taxResult.sgst_rate,
          igstRate: taxResult.igst_rate,
          cessRate: taxResult.cess_rate,
          cgstAmount: taxResult.cgst_amount,
          sgstAmount: taxResult.sgst_amount,
          igstAmount: taxResult.igst_amount,
          cessAmount: taxResult.cess_amount,
          totalTax: taxResult.total_tax,
          grandTotal: taxResult.grand_total,
          placeOfSupply: taxResult.place_of_supply,
          isInterstate: taxResult.is_interstate,
          breakdown: taxResult.breakdown,
          userId: req.user?.userId || "system",
        });
      }

      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "purchase",
        voucher.id,
        "POST",
        null,
        {
          ...postedVoucher,
          journal_entry_id: journalEntry.id,
          tax: taxResult
            ? {
                taxable_amount: amount,
                total_tax: taxResult.total_tax,
                grand_total: taxResult.grand_total,
              }
            : null,
        },
      );
      res.status(201).json(
        successResponse({
          ...postedVoucher,
          journal_entry: journalEntry,
          tax_details: taxResult,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async cancelPurchase(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "PURCHASE")
        throw new NotFoundError("Purchase invoice not found");
      if (voucher.status !== "POSTED")
        throw new AppError(
          "Only posted purchase invoices can be cancelled",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.cancel(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "purchase",
        req.params.id,
        "CANCEL",
      );
      res.json(
        successResponse({
          id: req.params.id,
          status: "CANCELLED",
          message: "Purchase invoice cancelled",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async reversePurchase(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "PURCHASE")
        throw new NotFoundError("Purchase invoice not found");
      if (voucher.status !== "POSTED")
        throw new AppError(
          "Only posted purchase invoices can be reversed",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.reverse(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "purchase",
        req.params.id,
        "REVERSE",
      );
      res.json(
        successResponse({
          id: req.params.id,
          status: "REVERSED",
          message: "Purchase invoice reversed",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async deletePurchase(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "PURCHASE")
        throw new NotFoundError("Purchase invoice not found");
      if (voucher.status !== "DRAFT")
        throw new AppError(
          "Cannot delete a " +
            voucher.status.toLowerCase() +
            " purchase invoice",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.delete(req.params.id, companyId);
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "purchase",
        req.params.id,
        "DELETE",
      );
      res.json(successResponse({ message: "Purchase invoice deleted" }));
    } catch (err) {
      next(err);
    }
  }

  // ─── Step 12: Expense Voucher / Expense Transaction ──────────────────

  /**
   * Validate an expense voucher request body.
   * Returns an array of error strings (empty = valid).
   */
  _validateExpense(data, ctx) {
    const errors = [];
    const companyId = data.companyId;
    const {
      expense_date,
      payee_id,
      contact_id,
      payment_ledger_id,
      payment_mode,
      currency,
      financial_year_id,
      lines,
      expense_voucher_number,
      tax_master_id,
    } = data;
    const payee = payee_id || contact_id;

    // Payee / Supplier / Party (optional but recommended)
    if (!payee) {
      errors.push("Payee / Supplier is required");
    } else {
      const party = this.voucherRepo.conn.get(
        "SELECT id FROM contacts WHERE id = ? AND company_id = ?",
        [payee, companyId],
      );
      if (!party)
        errors.push("Payee not found or does not belong to this company");
    }

    // Financial Year
    let fy = null;
    if (financial_year_id) {
      fy = this.voucherRepo.conn.get(
        "SELECT * FROM financial_years WHERE id = ? AND company_id = ?",
        [financial_year_id, companyId],
      );
      if (!fy)
        errors.push(
          "Financial year not found or does not belong to this company",
        );
    } else if (expense_date) {
      fy = this.voucherRepo.conn.get(
        "SELECT * FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date ORDER BY is_active DESC LIMIT 1",
        [companyId, expense_date, expense_date],
      );
      if (!fy) errors.push("No financial year found for the expense date");
    }
    if (fy) {
      const fyLock = evaluateFinancialYearLock({ fy, context: ctx });
      if (fyLock.blocked) errors.push(fyLock.reason);
      if (
        expense_date &&
        (expense_date < fy.start_date || expense_date > fy.end_date)
      ) {
        errors.push(
          "Expense date must fall within the selected Financial Year",
        );
      }
    }

    // Expense lines
    if (!lines || !Array.isArray(lines) || lines.length === 0) {
      errors.push("At least one expense line is required");
    } else {
      let lineTotal = 0;
      lines.forEach((line, idx) => {
        const expenseLedgerId = line.expense_ledger_id || line.ledger_id;
        if (!expenseLedgerId) {
          errors.push(`Line ${idx + 1}: Expense ledger is required`);
        } else {
          const acc = this.obRepo.getAccountDetails(expenseLedgerId, companyId);
          if (!acc) {
            errors.push(
              `Line ${idx + 1}: Expense ledger not found or not accessible`,
            );
          } else {
            if (acc.is_group === 1 || acc.is_group === true)
              errors.push(
                `Line ${idx + 1}: "${acc.name}" is an Account Group, not a Ledger Account`,
              );
            if (acc.is_active === 0 || acc.is_active === false)
              errors.push(`Line ${idx + 1}: "${acc.name}" is inactive`);
            // Expense ledgers must be DEBIT-nature
            if (acc.debit_credit_nature !== "DEBIT") {
              errors.push(
                `Line ${idx + 1}: "${acc.name}" is a ${acc.debit_credit_nature}-nature account; expense ledgers must be DEBIT-nature`,
              );
            }
            // Optionally enforce Expense type (but allow ASSET for pre-payments)
            lineTotal += parseFloat(line.amount) || 0;
          }
        }
        const amt = parseFloat(line.amount);
        if (isNaN(amt) || amt <= 0) {
          errors.push(`Line ${idx + 1}: Amount must be greater than zero`);
        }
      });

      // Payment / Credit Ledger (credit side)
      if (payment_mode === "CREDIT") {
        // Credit expense -> Dr Expense, Cr Accounts Payable
        if (!payment_ledger_id) {
          errors.push(
            "Payable / Accounts Payable ledger is required for credit expenses",
          );
        } else {
          const acc = this.obRepo.getAccountDetails(
            payment_ledger_id,
            companyId,
          );
          if (!acc) {
            errors.push("Payable ledger not found or not accessible");
          } else {
            if (acc.is_group === 1 || acc.is_group === true)
              errors.push(
                `"${acc.name}" is an Account Group, not a Ledger Account`,
              );
            if (acc.is_active === 0 || acc.is_active === false)
              errors.push(`"${acc.name}" is inactive`);
            if (acc.debit_credit_nature !== "CREDIT") {
              errors.push(
                `"${acc.name}" is a ${acc.debit_credit_nature}-nature account; credit expenses require a CREDIT-nature payable account`,
              );
            }
          }
        }
      } else {
        // Cash / Bank expense -> Dr Expense, Cr Cash/Bank
        if (!payment_ledger_id) {
          errors.push(
            "Payment ledger is required for " +
              (payment_mode || "cash/bank") +
              " expenses",
          );
        } else {
          const acc = this.obRepo.getAccountDetails(
            payment_ledger_id,
            companyId,
          );
          if (!acc) {
            errors.push("Payment ledger not found or not accessible");
          } else {
            if (acc.is_group === 1 || acc.is_group === true)
              errors.push(
                `"${acc.name}" is an Account Group, not a Ledger Account`,
              );
            if (acc.is_active === 0 || acc.is_active === false)
              errors.push(`"${acc.name}" is inactive`);
            // Cash/Bank are DEBIT-nature assets
            if (acc.debit_credit_nature !== "DEBIT") {
              errors.push(
                `"${acc.name}" is a ${acc.debit_credit_nature}-nature account; cash/bank payment ledgers must be DEBIT-nature`,
              );
            }
          }
        }
      }
    }

    // voucher number required or reference
    if (!expense_voucher_number && !data.reference_number) {
      errors.push("Voucher number or reference number is required");
    }

    // Tax Master (optional)
    if (tax_master_id) {
      const tm = this.voucherRepo.conn.get(
        "SELECT id, is_active, rate FROM tax_masters WHERE id = ? AND company_id = ?",
        [tax_master_id, companyId],
      );
      if (!tm)
        errors.push("Tax master not found or does not belong to this company");
      else if (tm.is_active === 0 || tm.is_active === false)
        errors.push("Tax master is inactive");
    }

    return errors;
  }

  /**
   * Build Journal Entry lines from expense lines + payment ledger.
   * Supports multi-line expenses.
   * Debit side: each expense ledger.
   * Credit side: payment ledger (cash/bank) or payable ledger (credit).
   */
  _buildExpenseLines(
    lines,
    paymentLedgerId,
    paymentMode,
    totalAmount,
    currency = "INR",
    taxResult = null,
    companyId = "default",
  ) {
    const amt = parseFloat(totalAmount);
    const jeLines = [];

    // Debit lines: one per expense line
    lines.forEach((line) => {
      jeLines.push({
        account_id: line.expense_ledger_id || line.ledger_id,
        debit_amount: parseFloat(line.amount) || 0,
        credit_amount: 0,
        description: line.description || "Expense",
        reference_id: line.reference_id || null,
        cost_centre_id: line.cost_centre_id || null,
        cost_category_id: line.cost_category_id || null,
      });
    });

    // Add input tax debit lines when tax is applicable
    if (taxResult && taxResult.total_tax > 0) {
      if (taxResult.cgst_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "CGST",
          "INPUT",
        );
        if (mapping && mapping.is_active === 1) {
          jeLines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: taxResult.cgst_amount,
            credit_amount: 0,
            description: `Input CGST @ ${taxResult.cgst_rate}%`,
            reference_id: null,
            cost_centre_id: null,
            cost_category_id: null,
          });
        }
      }
      if (taxResult.sgst_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "SGST",
          "INPUT",
        );
        if (mapping && mapping.is_active === 1) {
          jeLines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: taxResult.sgst_amount,
            credit_amount: 0,
            description: `Input SGST @ ${taxResult.sgst_rate}%`,
            reference_id: null,
            cost_centre_id: null,
            cost_category_id: null,
          });
        }
      }
      if (taxResult.igst_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "IGST",
          "INPUT",
        );
        if (mapping && mapping.is_active === 1) {
          jeLines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: taxResult.igst_amount,
            credit_amount: 0,
            description: `Input IGST @ ${taxResult.igst_rate}%`,
            reference_id: null,
            cost_centre_id: null,
            cost_category_id: null,
          });
        }
      }
      if (taxResult.cess_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "CESS",
          "INPUT",
        );
        if (mapping && mapping.is_active === 1) {
          jeLines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: taxResult.cess_amount,
            credit_amount: 0,
            description: `Input CESS @ ${taxResult.cess_rate}%`,
            reference_id: null,
            cost_centre_id: null,
            cost_category_id: null,
          });
        }
      }
    }

    // Credit line: payment ledger (cash/bank) or payable — use grand total when tax applies
    const creditLedger = paymentLedgerId;
    const creditAmount = taxResult ? parseFloat(taxResult.grand_total) : amt;
    jeLines.push({
      account_id: creditLedger,
      debit_amount: 0,
      credit_amount: creditAmount,
      description:
        paymentMode === "CREDIT"
          ? "Expense on credit - to be paid"
          : "Expense payment",
      reference_id: null,
    });

    return jeLines;
  }

  /**
   * Calculate totals from expense lines (server-side authoritative).
   */
  _calculateExpenseTotals(lines) {
    const subtotal = lines.reduce(
      (sum, l) => sum + (parseFloat(l.amount) || 0),
      0,
    );
    const taxTotal = lines.reduce(
      (sum, l) => sum + (parseFloat(l.tax_amount) || 0),
      0,
    );
    const grandTotal = subtotal + taxTotal;
    return { subtotal, tax_total: taxTotal, grand_total: grandTotal };
  }

  async getExpense(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "EXPENSE")
        throw new NotFoundError("Expense voucher not found");
      const detail = this.voucherRepo.getExpenseWithLines(
        req.params.id,
        companyId,
      );
      res.json(successResponse(detail));
    } catch (err) {
      next(err);
    }
  }

  async listExpenses(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {
        companyId,
        voucherType: "EXPENSE",
        status: req.query.status,
        limit: parseInt(req.query.limit) || 50,
        startDate: req.query.from,
        endDate: req.query.to,
        contactId: req.query.payee_id || req.query.contact_id,
        query: req.query.q,
      };
      const result = this.voucherRepo.search(options);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async createExpenseDraft(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateExpense({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const totals = this._calculateExpenseTotals(req.body.lines || []);
      const voucherNumber = this.voucherRepo.getNextVoucherNumber(
        "EXPENSE",
        companyId,
      );

      const payload = {
        companyId,
        voucher_number: voucherNumber,
        expense_date: req.body.expense_date,
        reference_number: req.body.reference_number,
        contact_id: req.body.payee_id || req.body.contact_id,
        currency: req.body.currency,
        exchange_rate: req.body.exchange_rate,
        financial_year_id: req.body.financial_year_id,
        payment_ledger_id: req.body.payment_ledger_id,
        payment_mode: req.body.payment_mode,
        payee_id: req.body.payee_id,
        expense_voucher_number:
          req.body.expense_voucher_number || voucherNumber,
        description: req.body.narration || req.body.description || "",
        created_by: req.user?.userId || "system",
      };

      const voucher = this.voucherRepo.createExpense(
        payload,
        req.body.lines || [],
      );
      res.status(201).json(successResponse(voucher));
    } catch (err) {
      next(err);
    }
  }

  async validateExpense(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateExpense({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const totals = this._calculateExpenseTotals(req.body.lines || []);

      // Calculate tax if tax_master_id is provided (server-side authoritative)
      const taxResult = req.body.tax_master_id
        ? this.taxService.calculateTax({
            companyId,
            taxableAmount: totals.subtotal,
            taxMasterId: req.body.tax_master_id,
            partyState:
              req.body.party_state || req.body.supplier_state || req.body.state,
            companyState: req.body.company_state,
          })
        : null;

      const lines = this._buildExpenseLines(
        req.body.lines,
        req.body.payment_ledger_id,
        req.body.payment_mode,
        totals.subtotal,
        req.body.currency || "INR",
        taxResult,
        companyId,
      );

      const totalDebit = lines.reduce(
        (s, l) => s + (parseFloat(l.debit_amount) || 0),
        0,
      );
      const totalCredit = lines.reduce(
        (s, l) => s + (parseFloat(l.credit_amount) || 0),
        0,
      );

      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        return res.status(400).json({
          success: false,
          data: {
            valid: false,
            errors: [
              `Journal Entry is not balanced. Debit: ${totalDebit}, Credit: ${totalCredit}`,
            ],
          },
        });
      }

      const debitLine = lines.find((l) => parseFloat(l.debit_amount) > 0);
      const creditLine = lines.find((l) => parseFloat(l.credit_amount) > 0);

      res.json({
        success: true,
        data: {
          valid: true,
          errors: [],
          totals,
          accountingEntry: {
            debit: {
              accountId: debitLine ? debitLine.account_id : null,
              amount: parseFloat(debitLine?.debit_amount || 0),
            },
            credit: {
              accountId: creditLine ? creditLine.account_id : null,
              amount: parseFloat(creditLine?.credit_amount || 0),
            },
          },
          tax: taxResult,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  async postExpense(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateExpense({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const {
        expense_date,
        payee_id,
        contact_id,
        reference_number,
        narration,
        description,
        currency,
        exchange_rate,
        financial_year_id,
        payment_ledger_id,
        payment_mode,
        expense_voucher_number,
        lines,
        tax_master_id,
      } = req.body;

      const totals = this._calculateExpenseTotals(lines || []);

      // Calculate tax if tax_master_id is provided (server-side authoritative)
      const taxResult = tax_master_id
        ? this.taxService.calculateTax({
            companyId,
            taxableAmount: totals.subtotal,
            taxMasterId: tax_master_id,
            partyState:
              req.body.party_state || req.body.supplier_state || req.body.state,
            companyState: req.body.company_state,
          })
        : null;

      const jeLines = this._buildExpenseLines(
        lines,
        payment_ledger_id,
        payment_mode,
        totals.subtotal,
        currency || "INR",
        taxResult,
        companyId,
      );

      let fyId = financial_year_id;
      if (!fyId) {
        const fy = this.voucherRepo.conn.get(
          "SELECT * FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date ORDER BY is_active DESC LIMIT 1",
          [companyId, expense_date, expense_date],
        );
        fyId = fy?.id;
      }

      const voucherNumber = this.voucherRepo.getNextVoucherNumber(
        "EXPENSE",
        companyId,
      );
      let totalDebit = taxResult
        ? parseFloat(taxResult.grand_total)
        : totals.grand_total;

      const voucher = this.voucherRepo.createExpense(
        {
          companyId,
          voucher_number: voucherNumber,
          expense_date,
          reference_number,
          contact_id: payee_id || contact_id,
          currency,
          exchange_rate,
          financial_year_id: fyId,
          payment_ledger_id,
          payment_mode,
          payee_id: payee_id || contact_id,
          expense_voucher_number:
            expense_voucher_number || reference_number || voucherNumber,
          description: narration || description || "",
          created_by: req.user?.userId || "system",
        },
        lines || [],
      );

      const journalEntry = this.journalRepo.createWithValidation(
        {
          id: generateId("je"),
          company_id: companyId,
          voucher_id: voucher.id,
          entry_number: voucherNumber,
          entry_date: expense_date,
          description:
            narration || description || "Expense voucher " + voucherNumber,
          currency: currency || "INR",
          exchange_rate: exchange_rate || 1.0,
          total_debit: totalDebit,
          total_credit: totalDebit,
          status: "POSTED",
          created_by: req.user?.userId || "system",
          financial_year_id: fyId,
        },
        jeLines,
      );

      const postedVoucher = this.voucherRepo.postExpense(
        voucher.id,
        companyId,
        req.user?.userId || "system",
        journalEntry,
      );

      // Save tax transaction details if tax was calculated
      if (taxResult) {
        this.taxService.saveTransactionTaxDetails({
          companyId,
          voucherId: voucher.id,
          journalEntryId: journalEntry.id,
          taxMasterId: tax_master_id,
          taxableAmount: totals.subtotal,
          taxType: taxResult.tax_type,
          taxRate: taxResult.tax_rate,
          cgstRate: taxResult.cgst_rate,
          sgstRate: taxResult.sgst_rate,
          igstRate: taxResult.igst_rate,
          cessRate: taxResult.cess_rate,
          cgstAmount: taxResult.cgst_amount,
          sgstAmount: taxResult.sgst_amount,
          igstAmount: taxResult.igst_amount,
          cessAmount: taxResult.cess_amount,
          totalTax: taxResult.total_tax,
          grandTotal: taxResult.grand_total,
          placeOfSupply: taxResult.place_of_supply,
          isInterstate: taxResult.is_interstate,
          breakdown: taxResult.breakdown,
          userId: req.user?.userId || "system",
        });
      }

      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "expense",
        voucher.id,
        "POST",
        null,
        {
          ...postedVoucher,
          journal_entry_id: journalEntry.id,
          totals,
          tax: taxResult
            ? {
                taxable_amount: totals.subtotal,
                total_tax: taxResult.total_tax,
                grand_total: taxResult.grand_total,
              }
            : null,
        },
      );

      res.status(201).json(
        successResponse({
          ...postedVoucher,
          journal_entry: journalEntry,
          totals,
          tax_details: taxResult,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async cancelExpense(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "EXPENSE")
        throw new NotFoundError("Expense voucher not found");
      if (voucher.status !== "POSTED")
        throw new AppError(
          "Only posted expense vouchers can be cancelled",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.cancel(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "expense",
        req.params.id,
        "CANCEL",
      );
      res.json(
        successResponse({
          id: req.params.id,
          status: "CANCELLED",
          message: "Expense voucher cancelled",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async reverseExpense(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "EXPENSE")
        throw new NotFoundError("Expense voucher not found");
      if (voucher.status !== "POSTED")
        throw new AppError(
          "Only posted expense vouchers can be reversed",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.reverse(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "expense",
        req.params.id,
        "REVERSE",
      );
      res.json(
        successResponse({
          id: req.params.id,
          status: "REVERSED",
          message: "Expense voucher reversed",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async deleteExpense(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "EXPENSE")
        throw new NotFoundError("Expense voucher not found");
      if (voucher.status !== "DRAFT")
        throw new AppError(
          "Cannot delete a " +
            voucher.status.toLowerCase() +
            " expense voucher",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.delete(req.params.id, companyId);
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "expense",
        req.params.id,
        "DELETE",
      );
      res.json(successResponse({ message: "Expense voucher deleted" }));
    } catch (err) {
      next(err);
    }
  }

  // ─── Step 13: Credit Note / Sales Return ──────────────────────────────

  /**
   * Validate a Credit Note request body.
   * Returns an array of error strings (empty = valid).
   *
   * Credit Note accounting: Dr Sales Return (CREDIT-nature contra-revenue), Cr Receivable (DEBIT-nature asset).
   * For cash/bank sales returns: Dr Sales Return, Cr Cash/Bank.
   *
   * Validates:
   * - original Sales Invoice exists, belongs to company, is posted, eligible for credit
   * - credit amount ≤ remaining creditable amount
   * - customer matches original invoice
   * - ledgers are valid (active, direct-posting, correct nature)
   * - server-side total calculation
   */
  _validateCreditNote(data, ctx) {
    const errors = [];
    const companyId = data.companyId;
    const {
      credit_note_date,
      original_sales_invoice_id,
      contact_id,
      sales_return_ledger_id,
      receivable_ledger_id,
      amount,
      credit_note_type,
      lines,
      reference_number,
      tax_master_id,
    } = data;

    // ── Customer (receiving/credit side counterparty) ──
    if (!contact_id) {
      errors.push("Customer is required");
    } else {
      const party = this.voucherRepo.conn.get(
        "SELECT id FROM contacts WHERE id = ? AND company_id = ?",
        [contact_id, companyId],
      );
      if (!party)
        errors.push("Customer not found or does not belong to this company");
    }

    // ── Original Sales Invoice ──
    let originalInvoice = null;
    if (!original_sales_invoice_id) {
      errors.push("Original Sales Invoice is required");
    } else {
      originalInvoice = this.voucherRepo.findById(
        original_sales_invoice_id,
        companyId,
      );
      if (!originalInvoice) {
        errors.push(
          "Original Sales Invoice not found or does not belong to this company",
        );
      } else {
        if (originalInvoice.voucher_type !== "SALES") {
          errors.push("Original document is not a Sales Invoice");
        }
        if (originalInvoice.status !== "POSTED") {
          errors.push("Original Sales Invoice must be posted");
        }
        // Verify customer matches
        if (
          contact_id &&
          originalInvoice.contact_id &&
          originalInvoice.contact_id !== contact_id
        ) {
          errors.push("Customer does not match the original Sales Invoice");
        }
        // Verify financial year
        if (
          credit_note_date &&
          originalInvoice.financial_year_id &&
          credit_note_date !== originalInvoice.voucher_date
        ) {
          // Allow same FY but not cross-FY; just verify FY is the same
          if (originalInvoice.financial_year_id !== data.financial_year_id) {
            errors.push(
              "Credit Note financial year must match the original Sales Invoice",
            );
          }
        }
      }
    }

    // ── Financial Year ──
    let fy = null;
    if (data.financial_year_id) {
      fy = this.voucherRepo.conn.get(
        "SELECT * FROM financial_years WHERE id = ? AND company_id = ?",
        [data.financial_year_id, companyId],
      );
      if (!fy)
        errors.push(
          "Financial year not found or does not belong to this company",
        );
    } else if (credit_note_date) {
      fy = this.voucherRepo.conn.get(
        "SELECT * FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date ORDER BY is_active DESC LIMIT 1",
        [companyId, credit_note_date, credit_note_date],
      );
      if (!fy) errors.push("No financial year found for the credit note date");
    }
    if (fy) {
      const fyLock = evaluateFinancialYearLock({ fy, context: ctx });
      if (fyLock.blocked) errors.push(fyLock.reason);
      if (
        credit_note_date &&
        (credit_note_date < fy.start_date || credit_note_date > fy.end_date)
      ) {
        errors.push(
          "Credit note date must fall within the selected Financial Year",
        );
      }
    }

    // ── Credit Note Lines ──
    if (!lines || !Array.isArray(lines) || lines.length === 0) {
      errors.push("Credit Note must contain at least one line");
    } else {
      let lineTotal = 0;
      lines.forEach((line, idx) => {
        const amt = parseFloat(line.line_total) || parseFloat(line.amount) || 0;
        if (amt <= 0) {
          errors.push(
            `Line ${idx + 1}: Credit note amount must be greater than zero`,
          );
        }
        lineTotal += amt;
      });

      // Verify against remaining creditable amount
      if (
        originalInvoice &&
        original_sales_invoice_id &&
        amount !== undefined
      ) {
        const creditable = this.voucherRepo.getCreditableAmount(
          original_sales_invoice_id,
          companyId,
        );
        if (creditable) {
          const requested = parseFloat(amount);
          if (requested > creditable.remaining_creditable) {
            errors.push(
              `Credit note amount ₹${requested} exceeds remaining creditable amount ₹${creditable.remaining_creditable} for original invoice`,
            );
          }
          if (lineTotal > 0 && lineTotal > creditable.remaining_creditable) {
            errors.push(
              `Total of credit note lines ₹${lineTotal} exceeds remaining creditable amount ₹${creditable.remaining_creditable} for original invoice`,
            );
          }
        }
      }
    }

    // ── Sales Return / Revenue Ledger (Debit side) ──
    // Sales Returns is a CREDIT-nature contra-revenue account that is debited to reduce revenue.
    // But the Credit Note debit side should be the Sales Return ledger — which is CREDIT-nature.
    // Since we DEBIT a CREDIT-nature account, that reduces the revenue.
    // Wait — the spec says: Dr Sales Return / Revenue, Cr Receivable
    // Sales Returns account is CREDIT-nature (contra-revenue), so debiting it reduces revenue. ✓
    // However, we also need to support the case where the user wants to debit the Sales Revenue account directly.
    // We accept sales_return_ledger_id from the user (or look it up).
    if (!sales_return_ledger_id) {
      errors.push("Sales return ledger is required");
    } else {
      const acc = this.obRepo.getAccountDetails(
        sales_return_ledger_id,
        companyId,
      );
      if (!acc) {
        // Check if it's an account group (not a ledger account)
        const grp = getConn().get(
          "SELECT id, name FROM account_groups WHERE id = ? AND company_id = ?",
          [sales_return_ledger_id, companyId],
        );
        if (grp) {
          errors.push(
            `Sales return ledger "${grp.name}" is an Account Group, not a Ledger Account`,
          );
        } else {
          errors.push("Sales return ledger not found or not accessible");
        }
      } else {
        if (acc.is_group === 1 || acc.is_group === true)
          errors.push(
            `Sales return ledger "${acc.name}" is an Account Group, not a Ledger Account`,
          );
        if (acc.is_active === 0 || acc.is_active === false)
          errors.push(`Sales return ledger "${acc.name}" is inactive`);
        if (
          acc.allow_direct_posting === 0 ||
          acc.allow_direct_posting === false
        )
          errors.push(
            `Sales return ledger "${acc.name}" does not allow direct posting`,
          );
        // Sales return / revenue accounts must be CREDIT-nature (contra-revenue or income)
        if (acc.debit_credit_nature !== "CREDIT") {
          errors.push(
            `Sales return ledger "${acc.name}" is a ${acc.debit_credit_nature}-nature account; credit note debit must be a CREDIT-nature (revenue/contra-revenue) account`,
          );
        }
      }
    }

    // ── Receivable / Cash / Bank Ledger (Credit side) ──
    // For credit notes against credit sales: Cr Receivable (DEBIT-nature asset)
    // For cash/bank returns: Cr Cash/Bank (DEBIT-nature asset)
    if (!receivable_ledger_id) {
      errors.push("Receivable / Cash / Bank ledger is required (credit side)");
    } else {
      const acc = this.obRepo.getAccountDetails(
        receivable_ledger_id,
        companyId,
      );
      if (!acc) {
        errors.push("Receivable ledger not found or not accessible");
      } else {
        if (acc.is_group === 1 || acc.is_group === true)
          errors.push(
            `Receivable ledger "${acc.name}" is an Account Group, not a Ledger Account`,
          );
        if (acc.is_active === 0 || acc.is_active === false)
          errors.push(`Receivable ledger "${acc.name}" is inactive`);
        if (
          acc.allow_direct_posting === 0 ||
          acc.allow_direct_posting === false
        )
          errors.push(
            `Receivable ledger "${acc.name}" does not allow direct posting`,
          );
        // Credit side must be DEBIT-nature (Cash/Bank/Receivable are assets)
        if (acc.debit_credit_nature !== "DEBIT") {
          errors.push(
            `Receivable ledger "${acc.name}" is a ${acc.debit_credit_nature}-nature account; credit note credit side must be a DEBIT-nature (Cash/Bank/Receivable) account`,
          );
        }
      }
    }

    // ── Amount ──
    if (amount === undefined || amount === null || isNaN(parseFloat(amount))) {
      errors.push("Valid credit note amount is required");
    } else if (parseFloat(amount) <= 0) {
      errors.push("Credit note amount must be greater than zero");
    }

    // ── Reference number ──
    if (!reference_number && !data.credit_note_number) {
      errors.push("Credit note number or reference number is required");
    }

    // ── Same account prevention ──
    if (
      sales_return_ledger_id &&
      receivable_ledger_id &&
      sales_return_ledger_id === receivable_ledger_id
    ) {
      errors.push(
        "Sales return ledger and receivable ledger must be different",
      );
    }

    // Tax Master (optional) — for credit notes that reverse tax on the original sale
    if (tax_master_id) {
      const tm = this.voucherRepo.conn.get(
        "SELECT id, is_active, rate FROM tax_masters WHERE id = ? AND company_id = ?",
        [tax_master_id, companyId],
      );
      if (!tm)
        errors.push("Tax master not found or does not belong to this company");
      else if (tm.is_active === 0 || tm.is_active === false)
        errors.push("Tax master is inactive");
    }

    return errors;
  }

  /**
   * Build JE lines for a Credit Note.
   * Typical: Dr Sales Return (CREDIT-nature) → Cr Receivable (DEBIT-nature)
   * For cash/bank returns: Dr Sales Return → Cr Cash/Bank
   *
   * When tax is applicable (taxResult provided), adds Output tax DEBIT lines
   * to reverse the tax that was collected on the original sale, and uses
   * grand_total for the credit side.
   *
   * @param {string} salesReturnLedgerId - Dr side (Sales Return / Revenue)
   * @param {string} receivableLedgerId - Cr side (Receivable/Cash/Bank)
   * @param {number} amount - the taxable amount (or grand total if no tax)
   * @param {string} narration
   * @param {string} referenceNumber
   * @param {Object|null} taxResult - result from TaxService.calculateTax()
   * @param {string} companyId - for tax ledger lookups
   */
  _buildCreditNoteLines(
    salesReturnLedgerId,
    receivableLedgerId,
    amount,
    narration,
    referenceNumber,
    taxResult = null,
    companyId = "default",
  ) {
    const amt = parseFloat(amount);
    const lines = [];

    if (
      taxResult &&
      (taxResult.total_tax > 0 ||
        taxResult.cgst_amount > 0 ||
        taxResult.sgst_amount > 0 ||
        taxResult.igst_amount > 0)
    ) {
      // With tax: amt = taxable amount
      // Dr Sales Return (taxable), Dr Output CGST/SGST/IGST (reverse tax), Cr Receivable (grand total)
      lines.push({
        account_id: salesReturnLedgerId,
        debit_amount: amt,
        credit_amount: 0,
        description: narration,
        reference_id: referenceNumber || null,
      });

      // Reverse output tax — DEBIT the Output tax accounts (originally credited on sale)
      if (taxResult.cgst_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "CGST",
          "OUTPUT",
        );
        if (mapping && mapping.is_active === 1) {
          lines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: taxResult.cgst_amount,
            credit_amount: 0,
            description: `Output CGST reversal @ ${taxResult.cgst_rate}%`,
            reference_id: null,
          });
        }
      }
      if (taxResult.sgst_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "SGST",
          "OUTPUT",
        );
        if (mapping && mapping.is_active === 1) {
          lines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: taxResult.sgst_amount,
            credit_amount: 0,
            description: `Output SGST reversal @ ${taxResult.sgst_rate}%`,
            reference_id: null,
          });
        }
      }
      if (taxResult.igst_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "IGST",
          "OUTPUT",
        );
        if (mapping && mapping.is_active === 1) {
          lines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: taxResult.igst_amount,
            credit_amount: 0,
            description: `Output IGST reversal @ ${taxResult.igst_rate}%`,
            reference_id: null,
          });
        }
      }
      if (taxResult.cess_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "CESS",
          "OUTPUT",
        );
        if (mapping && mapping.is_active === 1) {
          lines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: taxResult.cess_amount,
            credit_amount: 0,
            description: `Output CESS reversal @ ${taxResult.cess_rate}%`,
            reference_id: null,
          });
        }
      }

      // Credit side = grand total (taxable + tax)
      const grandTotal = parseFloat(taxResult.grand_total);
      lines.push({
        account_id: receivableLedgerId,
        debit_amount: 0,
        credit_amount: grandTotal,
        description: narration,
        reference_id: referenceNumber || null,
      });
    } else {
      // No tax: existing simple Dr/Cr
      lines.push({
        account_id: salesReturnLedgerId,
        debit_amount: amt,
        credit_amount: 0,
        description: narration,
        reference_id: referenceNumber || null,
      });
      lines.push({
        account_id: receivableLedgerId,
        debit_amount: 0,
        credit_amount: amt,
        description: narration,
        reference_id: referenceNumber || null,
      });
    }

    return lines;
  }

  /**
   * Calculate totals from credit note lines (server-side authoritative).
   */
  _calculateCreditNoteTotals(lines) {
    const subtotal = lines.reduce(
      (sum, l) => sum + (parseFloat(l.line_total) || parseFloat(l.amount) || 0),
      0,
    );
    const taxTotal = lines.reduce(
      (sum, l) => sum + (parseFloat(l.tax_amount) || 0),
      0,
    );
    const grandTotal = subtotal + taxTotal;
    return { subtotal, tax_total: taxTotal, grand_total: grandTotal };
  }

  async getCreditNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const detail = this.voucherRepo.getCreditNote(req.params.id, companyId);
      if (!detail) throw new NotFoundError("Credit note not found");
      res.json(successResponse(detail));
    } catch (err) {
      next(err);
    }
  }

  async listCreditNotes(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.voucherRepo.searchCreditNotes({
        companyId,
        status: req.query.status,
        limit: parseInt(req.query.limit) || 50,
        startDate: req.query.from,
        endDate: req.query.to,
        contactId: req.query.contact_id,
        originalInvoiceId: req.query.original_invoice_id,
        query: req.query.q,
      });
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async createCreditNoteDraft(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateCreditNote({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const totals = this._calculateCreditNoteTotals(req.body.lines || []);
      const voucherNumber = this.voucherRepo.getNextVoucherNumber(
        "CREDIT_NOTE",
        companyId,
      );

      const payload = {
        companyId,
        voucher_number: voucherNumber,
        credit_note_date: req.body.credit_note_date,
        reference_number: req.body.reference_number,
        contact_id: req.body.contact_id,
        currency: req.body.currency,
        exchange_rate: req.body.exchange_rate,
        financial_year_id: req.body.financial_year_id,
        original_sales_invoice_id: req.body.original_sales_invoice_id,
        sales_return_ledger_id: req.body.sales_return_ledger_id,
        receivable_ledger_id: req.body.receivable_ledger_id,
        credit_note_type: req.body.credit_note_type || "SALES_RETURN",
        reason: req.body.reason || null,
        description: req.body.narration || req.body.description || "",
        created_by: req.user?.userId || "system",
      };

      const voucher = this.voucherRepo.createCreditNote(
        payload,
        req.body.lines || [],
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "credit_note",
        voucher.id,
        "DRAFT",
        null,
        { ...voucher, voucher_number: voucherNumber },
      );
      res
        .status(201)
        .json(successResponse({ ...voucher, voucher_number: voucherNumber }));
    } catch (err) {
      next(err);
    }
  }

  async validateCreditNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateCreditNote({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const totals = this._calculateCreditNoteTotals(req.body.lines || []);

      // Calculate tax if tax_master_id is provided (server-side authoritative)
      const taxResult = req.body.tax_master_id
        ? this.taxService.calculateTax({
            companyId,
            taxableAmount: req.body.amount || totals.subtotal,
            taxMasterId: req.body.tax_master_id,
            partyState: req.body.party_state || req.body.customer_state,
            companyState: req.body.company_state,
          })
        : null;

      const lines = this._buildCreditNoteLines(
        req.body.sales_return_ledger_id || "acc_sales_returns",
        req.body.receivable_ledger_id,
        req.body.amount || totals.subtotal,
        req.body.narration || "Credit note",
        req.body.reference_number,
        taxResult,
        companyId,
      );

      const totalDebit = lines.reduce(
        (s, l) => s + (parseFloat(l.debit_amount) || 0),
        0,
      );
      const totalCredit = lines.reduce(
        (s, l) => s + (parseFloat(l.credit_amount) || 0),
        0,
      );

      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        return res.status(400).json({
          success: false,
          data: {
            valid: false,
            errors: [
              `Journal Entry is not balanced. Debit: ${totalDebit}, Credit: ${totalCredit}`,
            ],
          },
        });
      }

      const debitLine = lines.find((l) => parseFloat(l.debit_amount) > 0);
      const creditLine = lines.find((l) => parseFloat(l.credit_amount) > 0);

      res.json({
        success: true,
        data: {
          valid: true,
          errors: [],
          totals,
          accountingEntry: {
            debit: {
              accountId: debitLine ? debitLine.account_id : null,
              amount: parseFloat(debitLine?.debit_amount || 0),
            },
            credit: {
              accountId: creditLine ? creditLine.account_id : null,
              amount: parseFloat(creditLine?.credit_amount || 0),
            },
          },
          tax: taxResult,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  async postCreditNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateCreditNote({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const totals = this._calculateCreditNoteTotals(req.body.lines || []);

      // Calculate tax if tax_master_id is provided (server-side authoritative)
      const taxResult = req.body.tax_master_id
        ? this.taxService.calculateTax({
            companyId,
            taxableAmount: req.body.amount || totals.subtotal,
            taxMasterId: req.body.tax_master_id,
            partyState: req.body.party_state || req.body.customer_state,
            companyState: req.body.company_state,
          })
        : null;

      const jeLines = this._buildCreditNoteLines(
        req.body.sales_return_ledger_id || "acc_sales_returns",
        req.body.receivable_ledger_id,
        req.body.amount || totals.subtotal,
        req.body.narration || req.body.description || "",
        req.body.reference_number,
        taxResult,
        companyId,
      );

      let fyId = req.body.financial_year_id;
      if (!fyId) {
        const fy = this.voucherRepo.conn.get(
          "SELECT * FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date ORDER BY is_active DESC LIMIT 1",
          [companyId, req.body.credit_note_date, req.body.credit_note_date],
        );
        fyId = fy?.id;
      }

      const voucherNumber = this.voucherRepo.getNextVoucherNumber(
        "CREDIT_NOTE",
        companyId,
      );
      let totalDebit = taxResult
        ? parseFloat(taxResult.grand_total)
        : totals.grand_total;

      const voucher = this.voucherRepo.createCreditNote(
        {
          companyId,
          voucher_number: voucherNumber,
          credit_note_date: req.body.credit_note_date,
          reference_number: req.body.reference_number,
          contact_id: req.body.contact_id,
          currency: req.body.currency,
          exchange_rate: req.body.exchange_rate,
          financial_year_id: fyId,
          original_sales_invoice_id: req.body.original_sales_invoice_id,
          sales_return_ledger_id: req.body.sales_return_ledger_id,
          receivable_ledger_id: req.body.receivable_ledger_id,
          credit_note_type: req.body.credit_note_type || "SALES_RETURN",
          reason: req.body.reason || null,
          description: req.body.narration || req.body.description || "",
          created_by: req.user?.userId || "system",
        },
        req.body.lines || [],
      );

      const journalEntry = this.journalRepo.createWithValidation(
        {
          id: generateId("je"),
          company_id: companyId,
          voucher_id: voucher.id,
          entry_number: voucherNumber,
          entry_date: req.body.credit_note_date,
          description:
            req.body.narration ||
            req.body.description ||
            "Credit note " + voucherNumber,
          currency: req.body.currency || "INR",
          exchange_rate: req.body.exchange_rate || 1.0,
          total_debit: totalDebit,
          total_credit: totalDebit,
          status: "POSTED",
          created_by: req.user?.userId || "system",
          financial_year_id: fyId,
        },
        jeLines,
      );

      const postedVoucher = this.voucherRepo.postCreditNote(
        voucher.id,
        companyId,
        req.user?.userId || "system",
        journalEntry,
      );

      // Save tax transaction details if tax was calculated
      if (taxResult) {
        this.taxService.saveTransactionTaxDetails({
          companyId,
          voucherId: voucher.id,
          journalEntryId: journalEntry.id,
          taxMasterId: req.body.tax_master_id,
          taxableAmount: req.body.amount || totals.subtotal,
          taxType: taxResult.tax_type,
          taxRate: taxResult.tax_rate,
          cgstRate: taxResult.cgst_rate,
          sgstRate: taxResult.sgst_rate,
          igstRate: taxResult.igst_rate,
          cessRate: taxResult.cess_rate,
          cgstAmount: taxResult.cgst_amount,
          sgstAmount: taxResult.sgst_amount,
          igstAmount: taxResult.igst_amount,
          cessAmount: taxResult.cess_amount,
          totalTax: taxResult.total_tax,
          grandTotal: taxResult.grand_total,
          placeOfSupply: taxResult.place_of_supply,
          isInterstate: taxResult.is_interstate,
          breakdown: taxResult.breakdown,
          userId: req.user?.userId || "system",
        });
      }

      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "credit_note",
        voucher.id,
        "POST",
        null,
        {
          ...postedVoucher,
          journal_entry_id: journalEntry.id,
          totals,
          tax: taxResult
            ? {
                taxable_amount: req.body.amount || totals.subtotal,
                total_tax: taxResult.total_tax,
                grand_total: taxResult.grand_total,
              }
            : null,
        },
      );
      res.status(201).json(
        successResponse({
          ...postedVoucher,
          journal_entry: journalEntry,
          totals,
          tax_details: taxResult,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async cancelCreditNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "CREDIT_NOTE")
        throw new NotFoundError("Credit note not found");
      if (voucher.status !== "POSTED")
        throw new AppError(
          "Only posted credit notes can be cancelled",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.cancel(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "credit_note",
        req.params.id,
        "CANCEL",
      );
      res.json(
        successResponse({
          id: req.params.id,
          status: "CANCELLED",
          message: "Credit note cancelled",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async reverseCreditNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "CREDIT_NOTE")
        throw new NotFoundError("Credit note not found");
      if (voucher.status !== "POSTED")
        throw new AppError(
          "Only posted credit notes can be reversed",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.reverse(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "credit_note",
        req.params.id,
        "REVERSE",
      );
      res.json(
        successResponse({
          id: req.params.id,
          status: "REVERSED",
          message: "Credit note reversed",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async deleteCreditNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "CREDIT_NOTE")
        throw new NotFoundError("Credit note not found");
      if (voucher.status !== "DRAFT")
        throw new AppError(
          "Cannot delete a " + voucher.status.toLowerCase() + " credit note",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.delete(req.params.id, companyId);
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "credit_note",
        req.params.id,
        "DELETE",
      );
      res.json(successResponse({ message: "Credit note deleted" }));
    } catch (err) {
      next(err);
    }
  }

  // ─── Step 14: Debit Note / Purchase Return ──────────────────────────────

  /**
   * Validate a Debit Note payload.
   * Debit Note accounting: Dr Supplier/Payable → Cr Purchase Return
   */
  _validateDebitNote(data, ctx) {
    const errors = [];
    const companyId = data.companyId;
    const {
      debit_note_date,
      original_purchase_invoice_id,
      supplier_id,
      contact_id,
      purchase_return_ledger_id,
      payable_ledger_id,
      amount,
      lines,
      reference_number,
      debit_note_number,
      tax_master_id,
    } = data;

    const partyId = supplier_id || contact_id;

    // ── Financial Year ──
    let fy = null;
    if (data.financial_year_id) {
      fy = this.voucherRepo.conn.get(
        "SELECT * FROM financial_years WHERE id = ? AND company_id = ?",
        [data.financial_year_id, companyId],
      );
      if (!fy)
        errors.push(
          "Financial year not found or does not belong to this company",
        );
    } else if (debit_note_date) {
      fy = this.voucherRepo.conn.get(
        "SELECT * FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date ORDER BY is_active DESC LIMIT 1",
        [companyId, debit_note_date, debit_note_date],
      );
      if (!fy) errors.push("No financial year found for the debit note date");
    }
    if (fy) {
      const fyLock = evaluateFinancialYearLock({ fy, context: ctx });
      if (fyLock.blocked) errors.push(fyLock.reason);
      if (
        debit_note_date &&
        (debit_note_date < fy.start_date || debit_note_date > fy.end_date)
      ) {
        errors.push(
          "Debit note date must fall within the selected Financial Year",
        );
      }
    }

    // ── Original Purchase Invoice ──
    if (!original_purchase_invoice_id) {
      errors.push("Original purchase invoice is required");
    } else {
      const invoice = this.voucherRepo.findById(
        original_purchase_invoice_id,
        companyId,
      );
      if (!invoice) {
        errors.push(
          "Original purchase invoice not found or does not belong to this company",
        );
      } else {
        if (invoice.voucher_type !== "PURCHASE")
          errors.push("Original transaction is not a Purchase Invoice");
        if (invoice.status !== "POSTED")
          errors.push(
            "Original purchase invoice must be posted to create a debit note",
          );
        // Supplier must match
        if (partyId && invoice.contact_id && partyId !== invoice.contact_id) {
          errors.push(
            "Supplier does not match the original purchase invoice supplier",
          );
        }
        // Check remaining eligible amount
        if (amount !== undefined && !isNaN(parseFloat(amount))) {
          const eligible = this.voucherRepo.getDebitNotableAmount(
            original_purchase_invoice_id,
            companyId,
          );
          if (eligible) {
            const requested = parseFloat(amount);
            if (requested > eligible.remaining_debitable) {
              errors.push(
                `Debit note amount ₹${requested} exceeds remaining eligible amount ₹${eligible.remaining_debitable} for original invoice`,
              );
            }
          }
        }
      }
    }

    // ── Supplier / Party ──
    if (!partyId) {
      errors.push("Supplier is required");
    } else {
      const party = this.voucherRepo.conn.get(
        "SELECT id FROM contacts WHERE id = ? AND company_id = ?",
        [partyId, companyId],
      );
      if (!party)
        errors.push("Supplier not found or does not belong to this company");
    }

    // ── Purchase Return Ledger (Credit side — CREDIT-nature contra-expense) ──
    // Purchase Returns is a DEBIT-nature contra-expense account that is CREDITed to reduce expense.
    if (!purchase_return_ledger_id) {
      errors.push("Purchase return ledger is required");
    } else {
      const acc = this.obRepo.getAccountDetails(
        purchase_return_ledger_id,
        companyId,
      );
      if (!acc) {
        const grp = getConn().get(
          "SELECT id, name FROM account_groups WHERE id = ? AND company_id = ?",
          [purchase_return_ledger_id, companyId],
        );
        if (grp) {
          errors.push(
            `Purchase return ledger "${grp.name}" is an Account Group, not a Ledger Account`,
          );
        } else {
          errors.push("Purchase return ledger not found or not accessible");
        }
      } else {
        if (acc.is_group === 1 || acc.is_group === true)
          errors.push(
            `Purchase return ledger "${acc.name}" is an Account Group, not a Ledger Account`,
          );
        if (acc.is_active === 0 || acc.is_active === false)
          errors.push(`Purchase return ledger "${acc.name}" is inactive`);
        if (
          acc.allow_direct_posting === 0 ||
          acc.allow_direct_posting === false
        )
          errors.push(
            `Purchase return ledger "${acc.name}" does not allow direct posting`,
          );
        // Purchase return ledger must be DEBIT-nature (contra-expense, debited to increase, credited to reduce)
        if (acc.debit_credit_nature !== "DEBIT") {
          errors.push(
            `Purchase return ledger "${acc.name}" is a ${acc.debit_credit_nature}-nature account; debit note credit side must be a DEBIT-nature (expense/contra-expense) account`,
          );
        }
      }
    }

    // ── Payable / Supplier Ledger (Debit side — CREDIT-nature liability) ──
    // For debit notes against credit purchases: Dr Payable (CREDIT-nature liability)
    if (!payable_ledger_id) {
      errors.push("Payable / supplier ledger is required");
    } else {
      const acc = this.obRepo.getAccountDetails(payable_ledger_id, companyId);
      if (!acc) {
        errors.push("Payable ledger not found or not accessible");
      } else {
        if (acc.is_group === 1 || acc.is_group === true)
          errors.push(
            `Payable ledger "${acc.name}" is an Account Group, not a Ledger Account`,
          );
        if (acc.is_active === 0 || acc.is_active === false)
          errors.push(`Payable ledger "${acc.name}" is inactive`);
        if (
          acc.allow_direct_posting === 0 ||
          acc.allow_direct_posting === false
        )
          errors.push(
            `Payable ledger "${acc.name}" does not allow direct posting`,
          );
        // Payable (Accounts Payable / Liability) must be CREDIT-nature
        if (acc.debit_credit_nature !== "CREDIT") {
          errors.push(
            `Payable ledger "${acc.name}" is a ${acc.debit_credit_nature}-nature account; debit note debit side must be a CREDIT-nature (liability/payable) account`,
          );
        }
      }
    }

    // ── Lines ──
    if (!lines || !Array.isArray(lines) || lines.length === 0) {
      errors.push("At least one line is required");
    } else {
      let lineTotal = 0;
      lines.forEach((l, idx) => {
        const amt = parseFloat(l.line_total) || parseFloat(l.amount) || 0;
        if (amt <= 0)
          errors.push(`Line ${idx + 1}: Amount must be greater than zero`);
        lineTotal += amt;
      });
    }

    // ── Amount ──
    if (amount === undefined || amount === null || isNaN(parseFloat(amount))) {
      errors.push("Valid debit note amount is required");
    } else if (parseFloat(amount) <= 0) {
      errors.push("Debit note amount must be greater than zero");
    }

    // ── Reference number ──
    if (!reference_number && !debit_note_number) {
      errors.push("Debit note number or reference number is required");
    }

    // ── Same account prevention ──
    if (
      purchase_return_ledger_id &&
      payable_ledger_id &&
      purchase_return_ledger_id === payable_ledger_id
    ) {
      errors.push(
        "Purchase return ledger and payable ledger must be different",
      );
    }

    // Tax Master (optional) — for debit notes that reverse tax on the original purchase
    if (tax_master_id) {
      const tm = this.voucherRepo.conn.get(
        "SELECT id, is_active, rate FROM tax_masters WHERE id = ? AND company_id = ?",
        [tax_master_id, companyId],
      );
      if (!tm)
        errors.push("Tax master not found or does not belong to this company");
      else if (tm.is_active === 0 || tm.is_active === false)
        errors.push("Tax master is inactive");
    }

    return errors;
  }

  /**
   * Build JE lines for a Debit Note.
   * Typical: Dr Payable (CREDIT-nature) → Cr Purchase Return (DEBIT-nature contra-expense)
   *
   * When tax is applicable (taxResult provided), adds Input tax CREDIT lines
   * to reverse the input tax that was claimed on the original purchase, and
   * uses grand_total for the debit side.
   *
   * @param {string} payableLedgerId - Dr side (Payable/Supplier Liability)
   * @param {string} purchaseReturnLedgerId - Cr side (Purchase Return contra-expense)
   * @param {number} amount - the taxable amount (or grand total if no tax)
   * @param {string} narration
   * @param {string} referenceNumber
   * @param {Object|null} taxResult - result from TaxService.calculateTax()
   * @param {string} companyId - for tax ledger lookups
   */
  _buildDebitNoteLines(
    payableLedgerId,
    purchaseReturnLedgerId,
    amount,
    narration,
    referenceNumber,
    taxResult = null,
    companyId = "default",
  ) {
    const amt = parseFloat(amount);

    if (
      taxResult &&
      (taxResult.total_tax > 0 ||
        taxResult.cgst_amount > 0 ||
        taxResult.sgst_amount > 0 ||
        taxResult.igst_amount > 0)
    ) {
      // With tax: amt = taxable amount
      // Dr Payable (grand total), Cr Purchase Return (taxable), Cr Input CGST/SGST/IGST (reverse input tax)
      const grandTotal = parseFloat(taxResult.grand_total);
      const lines = [
        {
          account_id: payableLedgerId,
          debit_amount: grandTotal,
          credit_amount: 0,
          description: narration,
          reference_id: referenceNumber || null,
        },
        {
          account_id: purchaseReturnLedgerId,
          debit_amount: 0,
          credit_amount: amt,
          description: narration,
          reference_id: referenceNumber || null,
        },
      ];

      // Reverse input tax — CREDIT the Input tax accounts (originally debited on purchase)
      if (taxResult.cgst_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "CGST",
          "INPUT",
        );
        if (mapping && mapping.is_active === 1) {
          lines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: 0,
            credit_amount: taxResult.cgst_amount,
            description: `Input CGST reversal @ ${taxResult.cgst_rate}%`,
            reference_id: null,
          });
        }
      }
      if (taxResult.sgst_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "SGST",
          "INPUT",
        );
        if (mapping && mapping.is_active === 1) {
          lines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: 0,
            credit_amount: taxResult.sgst_amount,
            description: `Input SGST reversal @ ${taxResult.sgst_rate}%`,
            reference_id: null,
          });
        }
      }
      if (taxResult.igst_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "IGST",
          "INPUT",
        );
        if (mapping && mapping.is_active === 1) {
          lines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: 0,
            credit_amount: taxResult.igst_amount,
            description: `Input IGST reversal @ ${taxResult.igst_rate}%`,
            reference_id: null,
          });
        }
      }
      if (taxResult.cess_amount > 0) {
        const mapping = this.taxService.getTaxLedgerAccount(
          companyId,
          "CESS",
          "INPUT",
        );
        if (mapping && mapping.is_active === 1) {
          lines.push({
            account_id: mapping.ledger_account_id,
            debit_amount: 0,
            credit_amount: taxResult.cess_amount,
            description: `Input CESS reversal @ ${taxResult.cess_rate}%`,
            reference_id: null,
          });
        }
      }

      return lines;
    } else {
      // No tax: existing simple Dr/Cr
      return [
        {
          account_id: payableLedgerId,
          debit_amount: amt,
          credit_amount: 0,
          description: narration,
          reference_id: referenceNumber || null,
        },
        {
          account_id: purchaseReturnLedgerId,
          debit_amount: 0,
          credit_amount: amt,
          description: narration,
          reference_id: referenceNumber || null,
        },
      ];
    }
  }

  /**
   * Calculate totals from debit note lines (server-side authoritative).
   */
  _calculateDebitNoteTotals(lines) {
    const subtotal = lines.reduce(
      (sum, l) => sum + (parseFloat(l.line_total) || parseFloat(l.amount) || 0),
      0,
    );
    const taxTotal = lines.reduce(
      (sum, l) => sum + (parseFloat(l.tax_amount) || 0),
      0,
    );
    const grandTotal = subtotal + taxTotal;
    return { subtotal, tax_total: taxTotal, grand_total: grandTotal };
  }

  async getDebitNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const detail = this.voucherRepo.getDebitNote(req.params.id, companyId);
      if (!detail) throw new NotFoundError("Debit note not found");
      res.json(successResponse(detail));
    } catch (err) {
      next(err);
    }
  }

  async listDebitNotes(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.voucherRepo.searchDebitNotes({
        companyId,
        status: req.query.status,
        limit: parseInt(req.query.limit) || 50,
        startDate: req.query.from,
        endDate: req.query.to,
        contactId: req.query.supplier_id || req.query.contact_id,
        originalInvoiceId: req.query.original_invoice_id,
        query: req.query.q,
      });
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async createDebitNoteDraft(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateDebitNote({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const totals = this._calculateDebitNoteTotals(req.body.lines || []);
      const voucherNumber = this.voucherRepo.getNextVoucherNumber(
        "DEBIT_NOTE",
        companyId,
      );

      const payload = {
        companyId,
        voucher_number: voucherNumber,
        debit_note_date: req.body.debit_note_date,
        reference_number: req.body.reference_number,
        contact_id: req.body.supplier_id || req.body.contact_id,
        currency: req.body.currency,
        exchange_rate: req.body.exchange_rate,
        financial_year_id: req.body.financial_year_id,
        original_purchase_invoice_id: req.body.original_purchase_invoice_id,
        purchase_return_ledger_id: req.body.purchase_return_ledger_id,
        payable_ledger_id: req.body.payable_ledger_id,
        debit_note_type: req.body.debit_note_type || "PURCHASE_RETURN",
        reason: req.body.reason || null,
        description: req.body.narration || req.body.description || "",
        created_by: req.user?.userId || "system",
      };

      const voucher = this.voucherRepo.createDebitNote(
        payload,
        req.body.lines || [],
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "debit_note",
        voucher.id,
        "DRAFT",
        null,
        { ...voucher, voucher_number: voucherNumber },
      );
      res
        .status(201)
        .json(successResponse({ ...voucher, voucher_number: voucherNumber }));
    } catch (err) {
      next(err);
    }
  }

  async validateDebitNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateDebitNote({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const totals = this._calculateDebitNoteTotals(req.body.lines || []);

      // Calculate tax if tax_master_id is provided (server-side authoritative)
      const taxResult = req.body.tax_master_id
        ? this.taxService.calculateTax({
            companyId,
            taxableAmount: req.body.amount || totals.subtotal,
            taxMasterId: req.body.tax_master_id,
            partyState: req.body.party_state || req.body.supplier_state,
            companyState: req.body.company_state,
          })
        : null;

      const lines = this._buildDebitNoteLines(
        req.body.payable_ledger_id,
        req.body.purchase_return_ledger_id || "acc_purchase_returns",
        req.body.amount || totals.subtotal,
        req.body.narration || "Debit note",
        req.body.reference_number,
        taxResult,
        companyId,
      );

      const totalDebit = lines.reduce(
        (s, l) => s + (parseFloat(l.debit_amount) || 0),
        0,
      );
      const totalCredit = lines.reduce(
        (s, l) => s + (parseFloat(l.credit_amount) || 0),
        0,
      );

      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        return res.status(400).json({
          success: false,
          data: {
            valid: false,
            errors: [
              `Journal Entry is not balanced. Debit: ${totalDebit}, Credit: ${totalCredit}`,
            ],
          },
        });
      }

      const debitLine = lines.find((l) => parseFloat(l.debit_amount) > 0);
      const creditLine = lines.find((l) => parseFloat(l.credit_amount) > 0);

      res.json({
        success: true,
        data: {
          valid: true,
          errors: [],
          totals,
          accountingEntry: {
            debit: {
              accountId: debitLine ? debitLine.account_id : null,
              amount: parseFloat(debitLine?.debit_amount || 0),
            },
            credit: {
              accountId: creditLine ? creditLine.account_id : null,
              amount: parseFloat(creditLine?.credit_amount || 0),
            },
          },
          tax: taxResult,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  async postDebitNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const errors = this._validateDebitNote({ ...req.body, companyId }, req);
      if (errors.length > 0)
        return res
          .status(400)
          .json({ success: false, data: { valid: false, errors } });

      const {
        debit_note_date,
        supplier_id,
        contact_id,
        reference_number,
        narration,
        description,
        currency,
        exchange_rate,
        financial_year_id,
        purchase_return_ledger_id,
        payable_ledger_id,
        amount,
        lines,
        tax_master_id,
      } = req.body;

      const totals = this._calculateDebitNoteTotals(lines || []);

      // Calculate tax if tax_master_id is provided (server-side authoritative)
      const taxResult = tax_master_id
        ? this.taxService.calculateTax({
            companyId,
            taxableAmount: amount || totals.subtotal,
            taxMasterId: tax_master_id,
            partyState: req.body.party_state || req.body.supplier_state,
            companyState: req.body.company_state,
          })
        : null;

      const jeLines = this._buildDebitNoteLines(
        payable_ledger_id,
        purchase_return_ledger_id || "acc_purchase_returns",
        amount || totals.subtotal,
        narration || description || "",
        reference_number,
        taxResult,
        companyId,
      );

      let fyId = financial_year_id;
      if (!fyId) {
        const fy = this.voucherRepo.conn.get(
          "SELECT * FROM financial_years WHERE company_id = ? AND ? >= start_date AND ? <= end_date ORDER BY is_active DESC LIMIT 1",
          [companyId, debit_note_date, debit_note_date],
        );
        fyId = fy?.id;
      }

      const voucherNumber = this.voucherRepo.getNextVoucherNumber(
        "DEBIT_NOTE",
        companyId,
      );
      let totalDebit = taxResult
        ? parseFloat(taxResult.grand_total)
        : totals.grand_total;

      const voucher = this.voucherRepo.createDebitNote(
        {
          companyId,
          voucher_number: voucherNumber,
          debit_note_date,
          reference_number,
          contact_id: supplier_id || contact_id,
          currency,
          exchange_rate,
          financial_year_id: fyId,
          original_purchase_invoice_id: req.body.original_purchase_invoice_id,
          purchase_return_ledger_id,
          payable_ledger_id,
          debit_note_type: req.body.debit_note_type || "PURCHASE_RETURN",
          reason: req.body.reason || null,
          description: narration || description || "",
          created_by: req.user?.userId || "system",
        },
        lines || [],
      );

      const journalEntry = this.journalRepo.createWithValidation(
        {
          id: generateId("je"),
          company_id: companyId,
          voucher_id: voucher.id,
          entry_number: voucherNumber,
          entry_date: debit_note_date,
          description:
            narration || description || "Debit note " + voucherNumber,
          currency: currency || "INR",
          exchange_rate: exchange_rate || 1.0,
          total_debit: totalDebit,
          total_credit: totalDebit,
          status: "POSTED",
          created_by: req.user?.userId || "system",
          financial_year_id: fyId,
        },
        jeLines,
      );

      const postedVoucher = this.voucherRepo.postDebitNote(
        voucher.id,
        companyId,
        req.user?.userId || "system",
        journalEntry,
      );

      // Save tax transaction details if tax was calculated
      if (taxResult) {
        this.taxService.saveTransactionTaxDetails({
          companyId,
          voucherId: voucher.id,
          journalEntryId: journalEntry.id,
          taxMasterId: tax_master_id,
          taxableAmount: amount || totals.subtotal,
          taxType: taxResult.tax_type,
          taxRate: taxResult.tax_rate,
          cgstRate: taxResult.cgst_rate,
          sgstRate: taxResult.sgst_rate,
          igstRate: taxResult.igst_rate,
          cessRate: taxResult.cess_rate,
          cgstAmount: taxResult.cgst_amount,
          sgstAmount: taxResult.sgst_amount,
          igstAmount: taxResult.igst_amount,
          cessAmount: taxResult.cess_amount,
          totalTax: taxResult.total_tax,
          grandTotal: taxResult.grand_total,
          placeOfSupply: taxResult.place_of_supply,
          isInterstate: taxResult.is_interstate,
          breakdown: taxResult.breakdown,
          userId: req.user?.userId || "system",
        });
      }

      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "debit_note",
        voucher.id,
        "POST",
        null,
        {
          ...postedVoucher,
          journal_entry_id: journalEntry.id,
          totals,
          tax: taxResult
            ? {
                taxable_amount: amount || totals.subtotal,
                total_tax: taxResult.total_tax,
                grand_total: taxResult.grand_total,
              }
            : null,
        },
      );
      res.status(201).json(
        successResponse({
          ...postedVoucher,
          journal_entry: journalEntry,
          totals,
          tax_details: taxResult,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async cancelDebitNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "DEBIT_NOTE")
        throw new NotFoundError("Debit note not found");
      if (voucher.status !== "POSTED")
        throw new AppError(
          "Only posted debit notes can be cancelled",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.cancel(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "debit_note",
        req.params.id,
        "CANCEL",
      );
      res.json(
        successResponse({
          id: req.params.id,
          status: "CANCELLED",
          message: "Debit note cancelled",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async reverseDebitNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "DEBIT_NOTE")
        throw new NotFoundError("Debit note not found");
      if (voucher.status !== "POSTED")
        throw new AppError(
          "Only posted debit notes can be reversed",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.reverse(
        req.params.id,
        companyId,
        req.user?.userId || "system",
      );
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "debit_note",
        req.params.id,
        "REVERSE",
      );
      res.json(
        successResponse({
          id: req.params.id,
          status: "REVERSED",
          message: "Debit note reversed",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async deleteDebitNote(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const voucher = this.voucherRepo.findById(req.params.id, companyId);
      if (!voucher || voucher.voucher_type !== "DEBIT_NOTE")
        throw new NotFoundError("Debit note not found");
      if (voucher.status !== "DRAFT")
        throw new AppError(
          "Cannot delete a " + voucher.status.toLowerCase() + " debit note",
          "INVALID_STATE",
          400,
        );
      this.voucherRepo.delete(req.params.id, companyId);
      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId,
        "debit_note",
        req.params.id,
        "DELETE",
      );
      res.json(successResponse({ message: "Debit note deleted" }));
    } catch (err) {
      next(err);
    }
  }

  // ─── Step 17: Tax / GST Master & Accounting Integration ──────────────

  /**
   * Tax / GST Master CRUD and tax calculation endpoints.
   * All accounting impact flows through the existing JE engine; this layer
   * only manages configuration and calculation — it does NOT post to ledgers directly.
   */

  /** GET /taxes — List tax masters with optional filters */
  async listTaxes(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const taxes = this.taxService.listTaxMasters(companyId, {
        isActive:
          req.query.is_active !== undefined
            ? req.query.is_active === "true" || req.query.is_active === "1"
            : undefined,
        query: req.query.q,
      });
      res.json(successResponse(taxes));
    } catch (err) {
      next(err);
    }
  }

  /** GET /taxes/:id — Get a single tax master with components */
  async getTax(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const tax = this.taxService.getTaxMaster(req.params.id, companyId);
      tax.components = tax.components || [];
      res.json(successResponse(tax));
    } catch (err) {
      next(err);
    }
  }

  /** POST /taxes — Create a new tax master */
  async createTax(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const tax = this.taxService.createTaxMaster(
        { ...req.body, companyId },
        req.user?.userId || "system",
      );
      this.taxService.logAudit(
        companyId,
        req.user?.userId,
        "CREATE",
        "TAX_MASTER",
        tax.id,
        null,
        tax,
      );
      res.status(201).json(successResponse(tax));
    } catch (err) {
      next(err);
    }
  }

  /** PUT /taxes/:id — Update a tax master */
  async updateTax(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const oldValues = this.taxService.getTaxMaster(req.params.id, companyId);
      const tax = this.taxService.updateTaxMaster(
        req.params.id,
        { ...req.body, companyId },
        companyId,
      );
      this.taxService.logAudit(
        companyId,
        req.user?.userId,
        "UPDATE",
        "TAX_MASTER",
        req.params.id,
        oldValues,
        tax,
      );
      res.json(successResponse(tax));
    } catch (err) {
      next(err);
    }
  }

  /** PATCH /taxes/:id/status — Activate/deactivate a tax master */
  async toggleTaxStatus(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const isActive =
        req.body.is_active !== undefined ? req.body.is_active : req.body.active;
      const tax = this.taxService.toggleTaxStatus(
        req.params.id,
        isActive,
        companyId,
      );
      this.taxService.logAudit(
        companyId,
        req.user?.userId,
        isActive ? "ACTIVATE" : "DEACTIVATE",
        "TAX_MASTER",
        req.params.id,
        null,
        tax,
      );
      res.json(successResponse(tax));
    } catch (err) {
      next(err);
    }
  }

  /** GET /taxes/company-config — Get company tax configuration */
  async getCompanyTaxConfig(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const config = this.taxService.getCompanyTaxConfig(companyId);
      res.json(successResponse(config || null));
    } catch (err) {
      next(err);
    }
  }

  /** PUT /taxes/company-config — Set company tax configuration */
  async setCompanyTaxConfig(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const oldValues = this.taxService.getCompanyTaxConfig(companyId);
      const config = this.taxService.setCompanyTaxConfig(
        { ...req.body, companyId },
        companyId,
        req.user?.userId || "system",
      );
      this.taxService.logAudit(
        companyId,
        req.user?.userId,
        "UPDATE",
        "COMPANY_TAX_CONFIG",
        companyId,
        oldValues,
        config,
      );
      res.json(successResponse(config));
    } catch (err) {
      next(err);
    }
  }

  /** GET /taxes/account-mappings — List all tax account mappings */
  async listTaxAccountMappings(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const mappings = this.taxService.listTaxAccountMappings(companyId);
      res.json(successResponse(mappings));
    } catch (err) {
      next(err);
    }
  }

  /** POST /taxes/account-mappings — Create/update a tax account mapping */
  async upsertTaxAccountMapping(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const mappings = this.taxService.upsertTaxAccountMapping(
        { ...req.body, companyId },
        companyId,
      );
      this.taxService.logAudit(
        companyId,
        req.user?.userId,
        req.body.id ? "UPDATE" : "CREATE",
        "TAX_ACCOUNT_MAPPING",
        req.body.tax_type_code,
        null,
        mappings,
      );
      res.json(successResponse(mappings));
    } catch (err) {
      next(err);
    }
  }

  /** POST /taxes/calculate — Preview tax calculation */
  async calculateTaxPreview(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.taxService.calculateTax({
        companyId,
        taxableAmount: req.body.taxable_amount || req.body.taxableAmount,
        taxMasterId: req.body.tax_master_id || req.body.taxMasterId,
        partyState: req.body.party_state || req.body.partyState,
        companyState: req.body.company_state || req.body.companyState,
      });
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ─── Bills ─────────────────────────────────────────────────────────
  async createBill(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const {
        bill_type,
        contact_id,
        organization_id,
        bill_number,
        bill_date,
        due_date,
        items,
      } = req.body;
      if (!bill_type || !bill_number || !bill_date || !due_date) {
        throw new ValidationError(
          "bill_type, bill_number, bill_date, due_date are required",
        );
      }
      const total = parseFloat(req.body.total) || 0;
      // Calculate subtotal from line items if provided
      let subtotal = 0;
      const billItems = items || [];
      billItems.forEach((line) => {
        const qty = parseFloat(line.quantity) || 1;
        const price = parseFloat(line.unit_price) || 0;
        subtotal += qty * price;
      });
      const billData = {
        id: generateId("bill"),
        company_id: companyId,
        bill_type,
        contact_id,
        organization_id,
        bill_number,
        bill_date,
        due_date,
        issue_date: bill_date,
        subtotal,
        tax: 0,
        discount: 0,
        total,
        paid_amount: 0,
        balance: total,
        currency: req.body.currency || "USD",
        description: req.body.description || "",
        reference_number: req.body.reference_number || null,
        notes: req.body.notes || "",
        terms: req.body.terms || "",
        status: "DRAFT",
        created_by: req.user.userId,
      };
      const result = await this.billRepo.createWithItems(billData, billItems);
      logAudit(
        this.billRepo.conn,
        companyId,
        req.user?.userId,
        "bill",
        result.id || billData.id,
        "CREATE",
        null,
        result,
      );
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async updateBill(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const bill = await this.billRepo.findById(req.params.id, companyId);
      if (!bill) throw new NotFoundError("Bill not found");
      const updates = {};
      for (const k of ["bill_date", "due_date", "description", "status"]) {
        if (req.body[k] !== undefined) updates[k] = req.body[k];
      }
      if (Object.keys(updates).length > 0) {
        this.billRepo.conn
          .prepare(
            `UPDATE bills SET ${Object.keys(updates)
              .map((k) => `${k} = ?`)
              .join(", ")}, updated_at = datetime('now') WHERE id = ?`,
          )
          .run(...Object.values(updates), bill.id);
      }
      res.json(
        successResponse(
          this.billRepo.conn.get("SELECT * FROM bills WHERE id = ?", [bill.id]),
        ),
      );
    } catch (err) {
      next(err);
    }
  }

  async getBill(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const bill = await this.billRepo.findById(req.params.id, companyId);
      if (!bill) throw new NotFoundError("Bill not found");
      const items = this.billRepo.conn.all(
        "SELECT * FROM bill_items WHERE bill_id = ?",
        [bill.id],
      );
      res.json(successResponse({ ...bill, items }));
    } catch (err) {
      next(err);
    }
  }

  async listBills(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {
        companyId,
        type: req.query.type,
        status: req.query.status,
        page: parseInt(req.query.page) || 1,
        limit: parseInt(req.query.limit) || 50,
        from: req.query.from,
        to: req.query.to,
        q: req.query.q,
      };
      const result = await this.billRepo.search(options);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ─── Payments ──────────────────────────────────────────────────────
  async recordPayment(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const {
        bill_id,
        contact_id,
        amount,
        payment_date,
        payment_method,
        notes,
        allocations,
      } = req.body;
      if (!amount || !payment_date)
        throw new ValidationError("amount and payment_date are required");

      const userId = req.user?.userId || req.user?.id || "system";
      const now = new Date().toISOString();
      let paymentId;
      const tx = this.billRepo.conn.transaction(() => {
        paymentId = generateId("pym");
        this.billRepo.conn
          .prepare(
            `
          INSERT INTO payments (id, company_id, bill_id, contact_id, amount, payment_date, payment_method, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `,
          )
          .run(
            paymentId,
            companyId,
            bill_id || null,
            contact_id || null,
            parseFloat(amount),
            payment_date,
            payment_method || "BANK",
            notes || "",
          );

        // Create journal entry: Debit Bank/Cash, Credit Receivable/Payable
        const bankAccount = this.coaRepo.conn.get(
          `SELECT * FROM accounts WHERE company_id = ? AND type IN ('BANK','CASH') LIMIT 1`,
          [companyId],
        );
        const arAccount = this.coaRepo.conn.get(
          `SELECT * FROM accounts WHERE company_id = ? AND type = 'ASSET' AND (code LIKE '1300%' OR code LIKE '1003%' OR name LIKE '%Receivable%') LIMIT 1`,
          [companyId],
        );
        const apAccount = this.coaRepo.conn.get(
          `SELECT * FROM accounts WHERE company_id = ? AND type = 'LIABILITY' AND (code LIKE '2110%' OR code LIKE '2001%' OR name LIKE '%Payable%') LIMIT 1`,
          [companyId],
        );

        const voucherId = generateId("vch");
        this.voucherRepo.conn
          .prepare(
            `
          INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, voucher_date, status, created_by, created_at, updated_at)
          VALUES (?, ?, ?, 'RECEIPT', ?, 'POSTED', ?, datetime('now'), datetime('now'))
         `,
          )
          .run(voucherId, companyId, "RCP-" + Date.now(), payment_date, userId);

        const jeId = generateId("je");
        const now = new Date().toISOString();

        // Debit Bank
        this.journalRepo.conn
          .prepare(
            `
          INSERT INTO journal_entries (id, company_id, voucher_id, entry_number, entry_date, description, currency, exchange_rate, total_debit, total_credit, status, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'USD', 1.0, ?, ?, 'POSTED', ?, ?, ?)
        `,
          )
          .run(
            jeId,
            companyId,
            voucherId,
            "JE-" + Date.now(),
            payment_date,
            "Payment received",
            parseFloat(amount),
            parseFloat(amount),
            req.user.userId,
            now,
            now,
          );

        this.journalRepo.conn
          .prepare(
            `
          INSERT INTO journal_entry_lines (id, company_id, journal_entry_id, account_id, debit_amount, credit_amount, description, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            generateId("jl"),
            companyId,
            jeId,
            bankAccount.id,
            parseFloat(amount),
            0,
            "Payment received",
            now,
          );

        // Credit Receivable (if contact_id present)
        if (contact_id && arAccount) {
          this.journalRepo.conn
            .prepare(
              `
            INSERT INTO journal_entry_lines (id, company_id, journal_entry_id, account_id, debit_amount, credit_amount, description, created_at)
            VALUES (?, ?, ?, ?, 0, ?, ?, ?)
          `,
            )
            .run(
              generateId("jl"),
              companyId,
              jeId,
              arAccount.id,
              parseFloat(amount),
              "Payment from customer",
              now,
            );
        } else if (contact_id && !arAccount) {
          // Fallback: credit the bank account's offset (use acc_receivable or any receivable-type account)
          // This ensures the journal entry is always balanced
          const fallbackAccount = this.coaRepo.conn.get(
            `SELECT * FROM accounts WHERE company_id = ? AND type = 'ASSET' AND is_group = 0 AND account_group_id IN (SELECT id FROM account_groups WHERE type = 'ASSET') LIMIT 1`,
            [companyId],
          );
          if (fallbackAccount) {
            this.journalRepo.conn
              .prepare(
                `
              INSERT INTO journal_entry_lines (id, company_id, journal_entry_id, account_id, debit_amount, credit_amount, description, created_at)
              VALUES (?, ?, ?, ?, 0, ?, ?, ?)
            `,
              )
              .run(
                generateId("jl"),
                companyId,
                jeId,
                fallbackAccount.id,
                parseFloat(amount),
                "Payment from customer (fallback)",
                now,
              );
          }
        }

        // Update receivable/payable outstanding
        if (bill_id) {
          const receivable = this.billRepo.conn.get(
            "SELECT * FROM receivables WHERE bill_id = ?",
            [bill_id],
          );
          if (receivable) {
            const newOutstanding =
              (parseFloat(receivable.outstanding_amount) || 0) -
              parseFloat(amount);
            this.billRepo.conn
              .prepare(
                "UPDATE receivables SET paid_amount = paid_amount + ?, outstanding_amount = ?, status = CASE WHEN outstanding_amount <= 0.01 THEN 'PAID' ELSE status END WHERE id = ?",
              )
              .run(
                parseFloat(amount),
                Math.max(0, newOutstanding),
                receivable.id,
              );
          }
          const payable = this.billRepo.conn.get(
            "SELECT * FROM payables WHERE bill_id = ?",
            [bill_id],
          );
          if (payable) {
            const newOutstanding =
              (parseFloat(payable.outstanding_amount) || 0) -
              parseFloat(amount);
            this.billRepo.conn
              .prepare(
                "UPDATE payables SET paid_amount = paid_amount + ?, outstanding_amount = ?, status = CASE WHEN outstanding_amount <= 0.01 THEN 'PAID' ELSE status END WHERE id = ?",
              )
              .run(parseFloat(amount), Math.max(0, newOutstanding), payable.id);
          }
        }

        // Update budget actuals
        this.updateBudgetActualsInternal(companyId, payment_date);
      });
      tx();
      logAudit(
        this.billRepo.conn,
        companyId,
        req.user?.userId,
        "payment",
        paymentId,
        "CREATE",
        null,
        { bill_id, amount },
      );
      res.status(201).json(
        successResponse({
          message: "Payment recorded",
          id: paymentId,
          bill_id,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  // ─── Receivables ───────────────────────────────────────────────────
  async listReceivables(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {
        companyId,
        contactId: req.query.contact_id,
        status: req.query.status,
        page: parseInt(req.query.page) || 1,
        limit: parseInt(req.query.limit) || 50,
        startDate: req.query.from,
        endDate: req.query.to,
      };
      const result = this.receivableRepo.search(options);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async listPayables(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {
        companyId,
        organizationId: req.query.organization_id,
        status: req.query.status,
        limit: parseInt(req.query.limit) || 50,
        startDate: req.query.from,
        endDate: req.query.to,
      };
      const result = this.payableRepo.search(options);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getReceivable(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const rec = this.receivableRepo.conn.get(
        "SELECT * FROM receivables WHERE (id = ? OR bill_id = ?) AND company_id = ?",
        [req.params.id, req.params.id, companyId],
      );
      if (!rec) throw new NotFoundError("Receivable not found");
      res.json(successResponse(rec));
    } catch (err) {
      next(err);
    }
  }

  async getReceivablesSummary(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const aging = this.receivableRepo.getAgingSummary(companyId);
      res.json(successResponse(aging));
    } catch (err) {
      next(err);
    }
  }

  async listPayables(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {
        companyId,
        organizationId: req.query.organization_id,
        status: req.query.status,
        limit: parseInt(req.query.limit) || 50,
        startDate: req.query.from,
        endDate: req.query.to,
      };
      const result = this.payableRepo.search(options);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async getPayablesSummary(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const aging = await this.payableRepo.getAgingSummary(companyId);
      res.json(successResponse(aging));
    } catch (err) {
      next(err);
    }
  }

  // ─── Credit Rules ──────────────────────────────────────────────────
  async getCreditRule(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const rule = this.costCentreRepo.conn.get(
        "SELECT * FROM credit_rules WHERE contact_id = ? AND company_id = ?",
        [req.params.contactId, companyId],
      );
      res.json(successResponse(rule || null));
    } catch (err) {
      next(err);
    }
  }

  async setCreditRule(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const {
        contact_id,
        credit_limit,
        credit_period_days,
        payment_terms,
        is_active,
      } = req.body;
      const existing = this.costCentreRepo.conn.get(
        "SELECT id FROM credit_rules WHERE contact_id = ? AND company_id = ?",
        [contact_id, companyId],
      );
      if (existing) {
        this.costCentreRepo.conn
          .prepare(
            `
        UPDATE credit_rules SET credit_limit = ?, credit_period_days = ?, payment_terms = ?, is_active = ?, updated_at = datetime('now')
        WHERE id = ?
      `,
          )
          .run(
            parseFloat(credit_limit) || 0,
            credit_period_days || 30,
            payment_terms || "",
            is_active !== false ? 1 : 0,
            existing.id,
          );
      } else {
        const id = generateId("cr");
        this.costCentreRepo.conn
          .prepare(
            `
        INSERT INTO credit_rules (id, company_id, contact_id, credit_limit, credit_period_days, payment_terms, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
      `,
          )
          .run(
            id,
            companyId,
            contact_id,
            parseFloat(credit_limit) || 0,
            credit_period_days || 30,
            payment_terms || "",
          );
      }
      res
        .status(201)
        .json(
          successResponse(
            this.costCentreRepo.conn.get(
              "SELECT * FROM credit_rules WHERE contact_id = ? AND company_id = ?",
              [contact_id, companyId],
            ),
          ),
        );
    } catch (err) {
      next(err);
    }
  }

  // ─── Step 15: Accounts Receivable / Customer Outstanding ═══════════
  // Customer outstanding is derived from the posted Journal Entry engine (source of truth).
  // Only POSTED vouchers with POSTED JEs affect the final AR balance.

  /**
   * Get customer-level outstanding derived from JE engine.
   * Considers: SALES (Dr AR), RECEIPT (Cr AR), CREDIT_NOTE (Cr AR)
   * Only POSTED vouchers with POSTED JEs. Reversals/Cancellations excluded.
   */
  _getCustomerOutstanding(companyId, contactId, opts = {}) {
    const asOfDate = opts.asOfDate;
    const fyClause = opts.financialYearId ? "AND v.financial_year_id = ?" : "";
    const fyParam = opts.financialYearId;

    const dateClause = asOfDate ? "AND v.voucher_date <= ?" : "";

    const params = [companyId, contactId];
    if (fyParam) params.push(fyParam);
    if (asOfDate) params.push(asOfDate);

    const rows = this.voucherRepo.conn.all(
      `
      SELECT
        v.id AS voucher_id,
        v.voucher_number,
        v.voucher_type,
        v.voucher_date,
        v.contact_id,
        v.total_amount,
        v.receipt_mode,
        v.status AS voucher_status,
        v.journal_entry_id,
        v.original_sales_invoice_id,
        COALESCE(SUM(jel.debit_amount), 0) AS dr,
        COALESCE(SUM(jel.credit_amount), 0) AS cr,
        v.created_at
      FROM vouchers v
      JOIN journal_entries je ON je.voucher_id = v.id AND je.status = 'POSTED'
      JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN accounts a ON a.id = jel.account_id
      WHERE v.company_id = ?
        AND v.contact_id = ?
        AND a.id = 'acc_receivable'
        AND v.status IN ('POSTED')
        AND v.voucher_type IN ('SALES', 'RECEIPT', 'CREDIT_NOTE')
        ${fyClause}
        ${dateClause}
      GROUP BY v.id
      ORDER BY v.voucher_date
    `,
      params,
    );

    // Build receivable transactions
    let runningBalance = 0;
    const transactions = rows.map((r) => {
      // For SALES: debit increases AR (positive)
      // For RECEIPT/CREDIT_NOTE: credit decreases AR (negative on debit-nature account)
      let effect = 0;
      let type = r.voucher_type;
      let dr = parseFloat(r.dr || 0);
      let cr = parseFloat(r.cr || 0);

      if (type === "SALES") {
        effect = dr; // Dr AR increases receivable
        runningBalance += effect;
      } else if (type === "RECEIPT") {
        effect = -cr; // Cr AR decreases receivable
        runningBalance += effect;
      } else if (type === "CREDIT_NOTE") {
        effect = -cr; // Cr AR decreases receivable
        runningBalance += effect;
      }

      return {
        voucherId: r.voucher_id,
        voucherNumber: r.voucher_number,
        type,
        date: r.voucher_date,
        debit: dr,
        credit: cr,
        effect: effect,
        runningBalance: runningBalance,
        referenceNumber: r.reference_number || "",
        amount: parseFloat(r.total_amount || 0),
        status: r.voucher_status,
        isCreditNote: type === "CREDIT_NOTE",
        originalSalesInvoiceId: r.original_sales_invoice_id,
      };
    });

    return {
      customerId: contactId,
      totalDebit: rows.reduce(
        (s, r) => s + (parseFloat(r.voucher_type === "SALES" ? r.dr : 0) || 0),
        0,
      ),
      totalCredit: rows.reduce(
        (s, r) => s + (parseFloat(r.voucher_type !== "SALES" ? r.cr : 0) || 0),
        0,
      ),
      outstanding: runningBalance,
      transactions,
      transactionCount: rows.length,
    };
  }

  /**
   * GET /api/accounting/accounts-receivable/customers
   * Customer outstanding list derived from JE engine.
   */
  async getCustomerOutstanding(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const limit = parseInt(req.query.limit) || 50;
      const offset = (parseInt(req.query.page || 1) - 1) * limit;
      const asOfDate = req.query.as_of_date;
      const fyId = req.query.financial_year_id;
      const statusFilter = req.query.status; // OUTSTANDING, PAID, CREDIT_BALANCE, OVERDUE
      const overdueOnly = req.query.overdue === "true";

      // Get all customers with receivable activity
      const customerRows = this.voucherRepo.conn.all(
        `
        SELECT DISTINCT v.contact_id
        FROM vouchers v
        JOIN journal_entries je ON je.voucher_id = v.id AND je.status = 'POSTED'
        JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN accounts a ON a.id = jel.account_id
        WHERE v.company_id = ?
          AND v.contact_id IS NOT NULL
          AND a.id = 'acc_receivable'
          AND v.status = 'POSTED'
          AND v.voucher_type IN ('SALES', 'RECEIPT', 'CREDIT_NOTE')
          ${asOfDate ? "AND v.voucher_date <= ?" : ""}
          ${fyId ? "AND v.financial_year_id = ?" : ""}
      `,
        asOfDate && fyId
          ? [companyId, asOfDate, fyId]
          : asOfDate
            ? [companyId, asOfDate]
            : fyId
              ? [companyId, fyId]
              : [companyId],
      );

      const customers = [];
      const today = new Date().toISOString().slice(0, 10);

      for (const { contact_id } of customerRows) {
        const result = this._getCustomerOutstanding(companyId, contact_id, {
          asOfDate,
          financialYearId: fyId,
        });
        if (result.transactionCount === 0) continue;

        // Get customer details
        const contact = this.voucherRepo.conn.get(
          "SELECT id, first_name, last_name, email, phone FROM contacts WHERE id = ? AND company_id = ?",
          [contact_id, companyId],
        );

        // Get credit rule
        const creditRule = this.costCentreRepo.conn.get(
          "SELECT * FROM credit_rules WHERE contact_id = ? AND company_id = ?",
          [contact_id, companyId],
        );

        // Get due dates from sales invoices
        const dueDates = this.voucherRepo.conn.all(
          `
          SELECT MIN(v.voucher_date) as first_invoice_date,
                 MAX(v.voucher_date) as last_invoice_date
          FROM vouchers v
          JOIN journal_entries je ON je.voucher_id = v.id AND je.status = 'POSTED'
          WHERE v.contact_id = ? AND v.company_id = ? AND v.voucher_type = 'SALES' AND v.status = 'POSTED'
        `,
          [contact_id, companyId],
        );

        // Calculate aging based on invoice dates
        const invoiceDates = this.voucherRepo.conn.all(
          `
          SELECT v.voucher_date, v.total_amount as amount
          FROM vouchers v
          JOIN journal_entries je ON je.voucher_id = v.id AND je.status = 'POSTED'
          JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
          JOIN accounts a ON a.id = jel.account_id
          WHERE v.contact_id = ? AND v.company_id = ? AND v.voucher_type = 'SALES' AND v.status = 'POSTED' AND a.id = 'acc_receivable'
          ORDER BY v.voucher_date
        `,
          [contact_id, companyId],
        );

        let unpaidAmount = result.outstanding;
        let aging = {
          current: 0,
          "1_30": 0,
          "31_60": 0,
          "61_90": 0,
          "91_180": 0,
          "180_plus": 0,
        };
        if (unpaidAmount > 0) {
          // Distribute outstanding across aging buckets based on invoice dates
          // Simplified: use oldest invoices first
          let remaining = unpaidAmount;
          for (const inv of invoiceDates) {
            if (remaining <= 0) break;
            const amt = parseFloat(inv.amount || 0);
            const days = Math.floor(
              (Date.now() - new Date(inv.voucher_date).getTime()) /
                (24 * 60 * 60 * 1000),
            );
            const bucket =
              days <= 0
                ? "current"
                : days <= 30
                  ? "1_30"
                  : days <= 60
                    ? "31_60"
                    : days <= 90
                      ? "61_90"
                      : days <= 180
                        ? "91_180"
                        : "180_plus";
            const allocated = Math.min(amt, remaining);
            aging[bucket] += allocated;
            remaining -= allocated;
          }
          if (remaining > 0) {
            // Use the oldest bucket for remaining
            const oldestBucket =
              invoiceDates.length > 0
                ? this._getAgingBucket(invoiceDates[0].voucher_date)
                : "current";
            aging[oldestBucket] += remaining;
          }
        }

        const totalInvoiced = result.totalDebit;
        const totalReceived = result.totalCredit;
        const creditLimit = parseFloat(creditRule?.credit_limit || 0);
        const creditPeriodDays = parseInt(creditRule?.credit_period_days || 30);
        const lastTxnDate =
          dueDates.length > 0 ? dueDates[0].last_invoice_date || "" : "";
        const overdueAmount =
          aging["1_30"] +
          aging["31_60"] +
          aging["61_90"] +
          aging["91_180"] +
          aging["180_plus"];

        let status = "CURRENT";
        if (unpaidAmount <= 0) {
          status = unpaidAmount < 0 ? "CREDIT_BALANCE" : "PAID";
        } else if (unpaidAmount >= totalInvoiced) {
          status = "OUTSTANDING";
        } else {
          status = "PARTIALLY_PAID";
        }
        if (overdueAmount > 0 && unpaidAmount > 0) status = "OVERDUE";
        if (creditLimit > 0 && unpaidAmount > creditLimit && creditLimit > 0) {
          status = "OVER_CREDIT_LIMIT";
        }

        if (statusFilter) {
          const statusMap = {
            OUTSTANDING: ["OUTSTANDING", "PARTIALLY_PAID", "OVERDUE"],
            PAID: ["PAID"],
            CREDIT_BALANCE: ["CREDIT_BALANCE"],
            OVERDUE: ["OVERDUE"],
          };
          const validStatuses = statusMap[statusFilter] || [statusFilter];
          if (!validStatuses.includes(status)) continue;
        }
        if (overdueOnly && overdueAmount <= 0) continue;

        customers.push({
          customerId: contact_id,
          customerName: contact
            ? `${contact.first_name || ""} ${contact.last_name || ""}`.trim()
            : contact_id,
          customerCode: contact ? contact.email : null,
          openingBalance: 0,
          invoicedAmount: totalInvoiced,
          receivedAmount: totalReceived,
          creditNotes: result.transactions
            .filter((t) => t.isCreditNote)
            .reduce((s, t) => s + Math.abs(t.effect), 0),
          outstanding: unpaidAmount,
          overdueAmount,
          currentAmount: aging.current,
          aging,
          lastTransactionDate: lastTxnDate,
          status,
          creditLimit,
          creditPeriodDays: creditPeriodDays,
          paymentTerms: creditRule ? creditRule.payment_terms : null,
          transactionCount: result.transactionCount,
        });
      }

      const total = customers.length;
      const paged = customers.slice(offset, offset + limit);
      const totalOutstanding = customers.reduce(
        (s, c) => s + (c.outstanding > 0 ? c.outstanding : 0),
        0,
      );
      const totalOverdue = customers.reduce((s, c) => s + c.overdueAmount, 0);

      res.json(
        successResponse({
          items: paged,
          total,
          totalOutstanding,
          totalOverdue,
          count: paged.length,
          summary: {
            totalCustomers: total,
            totalOutstanding,
            totalOverdue,
            totalCreditBalance: customers
              .filter((c) => c.status === "CREDIT_BALANCE")
              .reduce((s, c) => s + Math.abs(c.outstanding), 0),
          },
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  _getAgingBucket(dateStr) {
    if (!dateStr) return "current";
    const days = Math.floor(
      (Date.now() - new Date(dateStr).getTime()) / (24 * 60 * 60 * 1000),
    );
    return days <= 0
      ? "current"
      : days <= 30
        ? "1_30"
        : days <= 60
          ? "31_60"
          : days <= 90
            ? "61_90"
            : days <= 180
              ? "91_180"
              : "180_plus";
  }

  /**
   * GET /api/accounting/accounts-receivable/customers/:id
   * Customer receivable statement derived from JE engine.
   */
  async getCustomerStatement(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const contactId = req.params.id;
      const asOfDate = req.query.as_of_date;
      const fyId = req.query.financial_year_id;

      // Verify customer exists
      const contact = this.voucherRepo.conn.get(
        "SELECT id, first_name, last_name, email, phone FROM contacts WHERE id = ? AND company_id = ?",
        [contactId, companyId],
      );
      if (!contact) throw new NotFoundError("Customer not found");

      const result = this._getCustomerOutstanding(companyId, contactId, {
        asOfDate,
        financialYearId: fyId,
      });

      // Get opening balance from opening_balance table or first transaction before period
      let openingBalance = 0;
      if (asOfDate) {
        const obResult = this._getCustomerOutstanding(companyId, contactId, {
          asOfDate: null,
          financialYearId: null,
        });
        // Opening balance is everything before asOfDate
        const preResult = this._getCustomerOutstanding(companyId, contactId, {
          asOfDate: null,
          financialYearId: null,
        });
        // Recalculate opening as of the day before
        const obRows = this.voucherRepo.conn.all(
          `
          SELECT v.voucher_date,
            COALESCE(SUM(jel.debit_amount), 0) AS dr,
            COALESCE(SUM(jel.credit_amount), 0) AS cr,
            v.voucher_type, v.total_amount, v.voucher_number, v.status as voucher_status,
            v.journal_entry_id, v.original_sales_invoice_id
          FROM vouchers v
          JOIN journal_entries je ON je.voucher_id = v.id AND je.status = 'POSTED'
          JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
          JOIN accounts a ON a.id = jel.account_id
          WHERE v.company_id = ? AND v.contact_id = ?
            AND a.id = 'acc_receivable'
            AND v.status = 'POSTED'
            AND v.voucher_type IN ('SALES', 'RECEIPT', 'CREDIT_NOTE')
            AND v.voucher_date < ?
          GROUP BY v.id
          ORDER BY v.voucher_date
        `,
          [companyId, contactId, asOfDate],
        );
        openingBalance = obRows.reduce((sum, r) => {
          if (r.voucher_type === "SALES") return sum + (parseFloat(r.dr) || 0);
          return sum - (parseFloat(r.cr) || 0);
        }, 0);
      }

      // Get credit rule
      const creditRule = this.costCentreRepo.conn.get(
        "SELECT * FROM credit_rules WHERE contact_id = ? AND company_id = ?",
        [contactId, companyId],
      );

      // Build statement with opening balance
      const statementTransactions = result.transactions;
      const closingBalance = openingBalance + result.outstanding;

      res.json(
        successResponse({
          customer: {
            id: contactId,
            name: `${contact.first_name || ""} ${contact.last_name || ""}`.trim(),
            email: contact.email,
            phone: contact.phone,
            code: contact.email,
          },
          creditLimit: creditRule
            ? parseFloat(creditRule.credit_limit || 0)
            : 0,
          creditPeriodDays: creditRule
            ? parseInt(creditRule.credit_period_days || 30)
            : 30,
          paymentTerms: creditRule ? creditRule.payment_terms : null,
          openingBalance,
          totalDebit: result.totalDebit,
          totalCredit: result.totalCredit,
          closingBalance,
          transactions: statementTransactions,
          transactionCount: result.transactionCount,
          asOfDate: asOfDate || null,
          financialYearId: fyId || null,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/accounting/accounts-receivable/aging
   * Customer receivables aging report.
   */
  async getArAging(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const asOfDate =
        req.query.as_of_date || new Date().toISOString().slice(0, 10);
      const fyId = req.query.financial_year_id;

      // Get all customers with outstanding balances
      const customerRows = this.voucherRepo.conn.all(
        `
        SELECT DISTINCT v.contact_id, c.first_name, c.last_name, c.email
        FROM vouchers v
        JOIN journal_entries je ON je.voucher_id = v.id AND je.status = 'POSTED'
        JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN accounts a ON a.id = jel.account_id
        LEFT JOIN contacts c ON c.id = v.contact_id AND c.company_id = v.company_id
        WHERE v.company_id = ?
          AND v.contact_id IS NOT NULL
          AND a.id = 'acc_receivable'
          AND v.status = 'POSTED'
          AND v.voucher_type IN ('SALES', 'RECEIPT', 'CREDIT_NOTE')
          AND v.voucher_date <= ?
          ${fyId ? "AND v.financial_year_id = ?" : ""}
      `,
        fyId ? [companyId, asOfDate, fyId] : [companyId, asOfDate],
      );

      const agingData = [];
      let totals = {
        current: 0,
        "1_30": 0,
        "31_60": 0,
        "61_90": 0,
        "91_180": 0,
        "180_plus": 0,
        total: 0,
      };

      for (const row of customerRows) {
        const result = this._getCustomerOutstanding(companyId, row.contact_id, {
          asOfDate,
        });
        if (result.outstanding <= 0) continue; // Only outstanding invoices

        // Calculate aging for this customer
        const invoiceDates = this.voucherRepo.conn.all(
          `
          SELECT v.voucher_date,
            COALESCE(SUM(jel.debit_amount), 0) AS dr,
            COALESCE(SUM(jel.credit_amount), 0) AS cr
          FROM vouchers v
          JOIN journal_entries je ON je.voucher_id = v.id AND je.status = 'POSTED'
          JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
          JOIN accounts a ON a.id = jel.account_id
          WHERE v.contact_id = ? AND v.company_id = ? AND v.voucher_type = 'SALES' AND v.status = 'POSTED' AND a.id = 'acc_receivable' AND v.voucher_date <= ?
          GROUP BY v.id
          ORDER BY v.voucher_date
        `,
          [row.contact_id, companyId, asOfDate],
        );

        let remaining = result.outstanding;
        let customerAging = {
          current: 0,
          "1_30": 0,
          "31_60": 0,
          "61_90": 0,
          "91_180": 0,
          "180_plus": 0,
        };
        for (const inv of invoiceDates) {
          if (remaining <= 0) break;
          const days = Math.floor(
            (new Date(asOfDate).getTime() -
              new Date(inv.voucher_date).getTime()) /
              (24 * 60 * 60 * 1000),
          );
          const bucket =
            days <= 0
              ? "current"
              : days <= 30
                ? "1_30"
                : days <= 60
                  ? "31_60"
                  : days <= 90
                    ? "61_90"
                    : days <= 180
                      ? "91_180"
                      : "180_plus";
          const allocated = Math.min(parseFloat(inv.dr || 0), remaining);
          customerAging[bucket] += allocated;
          totals[bucket] += allocated;
          remaining -= allocated;
        }

        const total =
          customerAging.current +
          customerAging["1_30"] +
          customerAging["31_60"] +
          customerAging["61_90"] +
          customerAging["91_180"] +
          customerAging["180_plus"];
        totals.total += total;

        agingData.push({
          customerId: row.contact_id,
          customerName: `${row.first_name || ""} ${row.last_name || ""}`.trim(),
          current: customerAging.current,
          "1_30": customerAging["1_30"],
          "31_60": customerAging["31_60"],
          "61_90": customerAging["61_90"],
          "91_180": customerAging["91_180"],
          "180_plus": customerAging["180_plus"],
          total,
        });
      }

      res.json(
        successResponse({
          asOfDate,
          customers: agingData,
          totals,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/accounting/accounts-receivable/allocations
   * Create a receivable allocation (receipt → invoice).
   */
  async createAllocation(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { invoice_voucher_id, payment_voucher_id, amount } = req.body;
      const amountVal = parseFloat(amount);

      if (!invoice_voucher_id)
        throw new ValidationError("Invoice voucher ID is required");
      if (!payment_voucher_id)
        throw new ValidationError("Payment/Receipt voucher ID is required");
      if (isNaN(amountVal) || amountVal <= 0)
        throw new ValidationError("Valid allocation amount is required");

      const tx = this.voucherRepo.conn.transaction(() => {
        // Verify invoice is a POSTED SALES voucher
        const invoice = this.voucherRepo.conn.get(
          "SELECT * FROM vouchers WHERE id = ? AND company_id = ? AND voucher_type = 'SALES' AND status = 'POSTED'",
          [invoice_voucher_id, companyId],
        );
        if (!invoice)
          throw new ValidationError(
            "Invoice not found, not posted, or not a Sales Invoice",
          );

        // Verify payment is a POSTED RECEIPT voucher
        const payment = this.voucherRepo.conn.get(
          "SELECT * FROM vouchers WHERE id = ? AND company_id = ? AND voucher_type = 'RECEIPT' AND status = 'POSTED'",
          [payment_voucher_id, companyId],
        );
        if (!payment)
          throw new ValidationError(
            "Receipt not found, not posted, or not a Receipt Voucher",
          );

        // Verify customer matches
        if (invoice.contact_id !== payment.contact_id) {
          throw new ValidationError(
            "Invoice and Receipt must be for the same customer",
          );
        }

        // Check invoice has remaining balance
        const invoiceResult = this._getCustomerOutstanding(
          companyId,
          invoice.contact_id,
        );
        // Calculate invoice-specific outstanding
        const invoiceOutstanding = this._getInvoiceOutstanding(
          invoice.id,
          companyId,
        );

        if (amountVal > invoiceOutstanding) {
          throw new ValidationError(
            `Allocation amount ₹${amountVal} exceeds invoice balance ₹${invoiceOutstanding}`,
          );
        }

        // Check receipt has unallocated amount
        const receiptOutstanding = this._getReceiptUnallocated(
          payment.id,
          companyId,
        );
        if (amountVal > receiptOutstanding) {
          throw new ValidationError(
            `Allocation amount ₹${amountVal} exceeds receipt unallocated amount ₹${receiptOutstanding}`,
          );
        }

        // Check for duplicate allocation
        const existing = this.voucherRepo.conn.get(
          "SELECT * FROM receivable_allocations WHERE invoice_voucher_id = ? AND payment_voucher_id = ? AND company_id = ?",
          [invoice_voucher_id, payment_voucher_id, companyId],
        );
        if (existing) {
          throw new ValidationError(
            "Allocation already exists for this invoice and receipt combination",
          );
        }

        const allocId = generateId("ra");
        this.voucherRepo.conn
          .prepare(
            `
          INSERT INTO receivable_allocations (id, company_id, invoice_voucher_id, payment_voucher_id, amount, allocation_date, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `,
          )
          .run(
            allocId,
            companyId,
            invoice_voucher_id,
            payment_voucher_id,
            amountVal,
            payment.voucher_date,
            req.user?.userId || "system",
          );

        logAudit(
          this.voucherRepo.conn,
          companyId,
          req.user?.userId,
          "receivable_allocation",
          allocId,
          "CREATE",
          null,
          {
            invoice_voucher_id,
            payment_voucher_id,
            amount: amountVal,
          },
        );

        return {
          id: allocId,
          invoice_voucher_id,
          payment_voucher_id,
          amount: amountVal,
        };
      });

      const result = tx();
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Calculate the outstanding balance for a specific invoice
   */
  _getInvoiceOutstanding(invoiceId, companyId) {
    const rows = this.voucherRepo.conn.all(
      `
      SELECT v.voucher_type,
        COALESCE(SUM(jel.debit_amount), 0) AS dr,
        COALESCE(SUM(jel.credit_amount), 0) AS cr,
        v.status as voucher_status,
        je.status as je_status
      FROM vouchers v
      JOIN journal_entries je ON je.voucher_id = v.id
      JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN accounts a ON a.id = jel.account_id
      WHERE v.company_id = ? AND a.id = 'acc_receivable'
        AND (v.id = ? OR v.original_sales_invoice_id = ? OR v.original_purchase_invoice_id = ?)
      GROUP BY v.id
    `,
      [companyId, invoiceId, invoiceId, invoiceId],
    );

    let invoiceAmount = 0;
    let reductions = 0;

    rows.forEach((r) => {
      if (r.voucher_status !== "POSTED" || r.je_status !== "POSTED") return;
      if (r.voucher_type === "SALES") {
        invoiceAmount += parseFloat(r.dr || 0);
      } else if (r.voucher_type === "CREDIT_NOTE") {
        reductions += parseFloat(r.cr || 0);
      }
    });

    // Subtract allocations
    const allocations = this.voucherRepo.conn.all(
      "SELECT amount FROM receivable_allocations WHERE invoice_voucher_id = ? AND company_id = ?",
      [invoiceId, companyId],
    );
    const allocatedTotal = allocations.reduce(
      (s, a) => s + (parseFloat(a.amount) || 0),
      0,
    );

    return Math.max(invoiceAmount - reductions - allocatedTotal, 0);
  }

  /**
   * Calculate unallocated amount on a receipt
   */
  _getReceiptUnallocated(receiptId, companyId) {
    const receipt = this.voucherRepo.conn.get(
      "SELECT total_amount FROM vouchers WHERE id = ? AND company_id = ? AND voucher_type = 'RECEIPT'",
      [receiptId, companyId],
    );
    if (!receipt) return 0;
    const total = parseFloat(receipt.total_amount || 0);

    const allocations = this.voucherRepo.conn.all(
      "SELECT amount FROM receivable_allocations WHERE payment_voucher_id = ? AND company_id = ?",
      [receiptId, companyId],
    );
    const allocatedTotal = allocations.reduce(
      (s, a) => s + (parseFloat(a.amount) || 0),
      0,
    );

    return Math.max(total - allocatedTotal, 0);
  }

  /**
   * GET /api/accounting/accounts-receivable/reconciliation
   * Reconcile customer-level AR with the AR control ledger.
   */
  async getArReconciliation(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const asOfDate = req.query.as_of_date;

      // Customer-level total from JE engine
      const customerRows = this.voucherRepo.conn.all(
        `
        SELECT v.contact_id
        FROM vouchers v
        JOIN journal_entries je ON je.voucher_id = v.id AND je.status = 'POSTED'
        JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN accounts a ON a.id = jel.account_id
        WHERE v.company_id = ?
          AND v.contact_id IS NOT NULL
          AND a.id = 'acc_receivable'
          AND v.status = 'POSTED'
          AND v.voucher_type IN ('SALES', 'RECEIPT', 'CREDIT_NOTE')
          ${asOfDate ? `AND v.voucher_date <= '${asOfDate}'` : ""}
      `,
        [companyId],
      );

      let customerTotal = 0;
      const seen = new Set();
      for (const { contact_id } of customerRows) {
        if (seen.has(contact_id)) continue;
        seen.add(contact_id);
        const result = this._getCustomerOutstanding(companyId, contact_id, {
          asOfDate,
        });
        customerTotal += result.outstanding;
      }

      // AR control ledger balance (must match same filters as customer-level)
      const controlBalance = this.voucherRepo.conn.get(
        `
        SELECT COALESCE(SUM(jel.debit_amount) - SUM(jel.credit_amount), 0) as balance
        FROM journal_entries je
        JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN vouchers v ON v.id = je.voucher_id
        JOIN accounts a ON a.id = jel.account_id
        WHERE v.company_id = ?
          AND v.contact_id IS NOT NULL
          AND a.id = 'acc_receivable'
          AND v.status = 'POSTED'
          AND je.status = 'POSTED'
          AND v.voucher_type IN ('SALES', 'RECEIPT', 'CREDIT_NOTE')
          ${asOfDate ? "AND v.voucher_date <= ?" : ""}
      `,
        asOfDate ? [companyId, asOfDate] : [companyId],
      );

      const ledgerTotal = parseFloat(controlBalance?.balance || 0);
      const difference = customerTotal - ledgerTotal;

      // Log reconciliation
      const reconId = generateId("rcn");
      this.voucherRepo.conn
        .prepare(
          `
        INSERT INTO ar_reconciliation_log (id, company_id, as_of_date, customer_level_total, control_ledger_total, difference, status, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `,
        )
        .run(
          reconId,
          companyId,
          asOfDate || new Date().toISOString().slice(0, 10),
          customerTotal,
          ledgerTotal,
          difference,
          Math.abs(difference) < 0.01 ? "RECONCILED" : "REQUIRES_ATTENTION",
          "system",
        );

      logAudit(
        this.voucherRepo.conn,
        companyId,
        "system",
        "ar_reconciliation",
        reconId,
        "RECONCILE",
        null,
        {
          customer_level_total: customerTotal,
          control_ledger_total: ledgerTotal,
          difference,
        },
      );

      res.json(
        successResponse({
          asOfDate: asOfDate || null,
          customerLevelTotal: customerTotal,
          controlLedgerTotal: ledgerTotal,
          difference,
          status:
            Math.abs(difference) < 0.01 ? "RECONCILED" : "REQUIRES_ATTENTION",
          reconciliationId: reconId,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/accounting/accounts-receivable/customers/:id/invoices
   * List all invoices for a customer with outstanding status.
   */
  async getCustomerInvoices(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const contactId = req.params.id;

      const contact = this.voucherRepo.conn.get(
        "SELECT id FROM contacts WHERE id = ? AND company_id = ?",
        [contactId, companyId],
      );
      if (!contact) throw new NotFoundError("Customer not found");

      const invoices = this.voucherRepo.conn.all(
        `
        SELECT v.id, v.voucher_number, v.voucher_date, v.total_amount, v.status,
               v.receiving_ledger_id, v.sales_ledger_id,
               COALESCE(SUM(jel.debit_amount), 0) - COALESCE(SUM(jel.credit_amount), 0) as net_effect
        FROM vouchers v
        JOIN journal_entries je ON je.voucher_id = v.id AND je.status = 'POSTED'
        JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN accounts a ON a.id = jel.account_id
        WHERE v.company_id = ? AND v.contact_id = ? AND v.voucher_type = 'SALES' AND a.id = 'acc_receivable'
        GROUP BY v.id
        ORDER BY v.voucher_date DESC
      `,
        [companyId, contactId],
      );

      const invoiceList = invoices.map((inv) => {
        const outstanding = this._getInvoiceOutstanding(inv.id, companyId);
        const allocated = parseFloat(inv.total_amount || 0) - outstanding;
        return {
          id: inv.id,
          voucherNumber: inv.voucher_number,
          date: inv.voucher_date,
          amount: parseFloat(inv.total_amount || 0),
          outstanding,
          allocated,
          status:
            outstanding === 0
              ? "PAID"
              : allocated > 0
                ? "PARTIALLY_PAID"
                : "OUTSTANDING",
        };
      });

      const totalOutstanding = invoiceList
        .filter((i) => i.status !== "PAID")
        .reduce((s, i) => s + i.outstanding, 0);
      const totalInvoiced = invoiceList.reduce((s, i) => s + i.amount, 0);

      res.json(
        successResponse({
          customerId: contactId,
          invoices: invoiceList,
          total: invoiceList.length,
          totalInvoiced,
          totalOutstanding,
          paidCount: invoiceList.filter((i) => i.status === "PAID").length,
          outstandingCount: invoiceList.filter((i) => i.status !== "PAID")
            .length,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  // ─── Step 16: Accounts Payable / Supplier Outstanding ═══════════════
  // Supplier payable is derived from the posted Journal Entry engine (source of truth).
  // Only POSTED vouchers with POSTED JEs affecting acc_payable are considered.
  // Increase: Cr acc_payable (PURCHASE) | Decrease: Dr acc_payable (PAYMENT, DEBIT_NOTE)

  _getSupplierOutstanding(companyId, contactId, opts = {}) {
    const asOfDate = opts.asOfDate;
    const fyParam = opts.financialYearId;

    const fyClause = fyParam ? "AND v.financial_year_id = ?" : "";
    const dateClause = asOfDate ? "AND v.voucher_date <= ?" : "";

    const params = [companyId, contactId];
    if (fyParam) params.push(fyParam);
    if (asOfDate) params.push(asOfDate);

    const rows = this.voucherRepo.conn.all(
      `
      SELECT
        v.id AS voucher_id,
        v.voucher_number,
        v.voucher_type,
        v.voucher_date,
        v.contact_id,
        v.total_amount,
        v.status AS voucher_status,
        v.journal_entry_id,
        v.original_purchase_invoice_id,
        COALESCE(SUM(jel.debit_amount), 0) AS dr,
        COALESCE(SUM(jel.credit_amount), 0) AS cr,
        v.created_at
      FROM vouchers v
      JOIN journal_entries je ON je.voucher_id = v.id AND je.status = 'POSTED'
      JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN accounts a ON a.id = jel.account_id
      WHERE v.company_id = ?
        AND v.contact_id = ?
        AND a.id = 'acc_payable'
        AND v.status IN ('POSTED')
        AND v.voucher_type IN ('PURCHASE', 'PAYMENT', 'DEBIT_NOTE')
        ${fyClause}
        ${dateClause}
      GROUP BY v.id
      ORDER BY v.voucher_date
    `,
      params,
    );

    // Build payable transactions
    // For PURCHASE: credit increases payable (positive on CREDIT-nature account)
    // For PAYMENT/DEBIT_NOTE: debit decreases payable (negative effect)
    let runningBalance = 0;
    const transactions = rows.map((r) => {
      let effect = 0;
      let type = r.voucher_type;
      let dr = parseFloat(r.dr || 0);
      let cr = parseFloat(r.cr || 0);

      if (type === "PURCHASE") {
        effect = cr; // Cr Payable increases payable
        runningBalance += effect;
      } else if (type === "PAYMENT") {
        effect = -dr; // Dr Payable decreases payable
        runningBalance += effect;
      } else if (type === "DEBIT_NOTE") {
        effect = -dr; // Dr Payable decreases payable (return)
        runningBalance += effect;
      }

      return {
        voucherId: r.voucher_id,
        voucherNumber: r.voucher_number,
        type,
        date: r.voucher_date,
        amount: parseFloat(r.total_amount || 0),
        debit: dr,
        credit: cr,
        effect,
        runningBalance,
        referenceNumber: r.voucher_number,
        status: r.voucher_status,
        journalEntryId: r.journal_entry_id,
        originalPurchaseInvoiceId: r.original_purchase_invoice_id,
        dueDate: r.voucher_date,
        daysOutstanding: Math.floor(
          (new Date().getTime() - new Date(r.voucher_date).getTime()) /
            (24 * 60 * 60 * 1000),
        ),
      };
    });

    const totalInvoiced = parseFloat(
      rows
        .filter((r) => r.voucher_type === "PURCHASE")
        .reduce((s, r) => s + (parseFloat(r.cr) || 0), 0),
    );
    const totalPayments = parseFloat(
      rows
        .filter((r) => r.voucher_type === "PAYMENT")
        .reduce((s, r) => s + (parseFloat(r.dr) || 0), 0),
    );
    const totalDebitNotes = parseFloat(
      rows
        .filter((r) => r.voucher_type === "DEBIT_NOTE")
        .reduce((s, r) => s + (parseFloat(r.dr) || 0), 0),
    );
    const totalDebit = parseFloat(
      rows
        .filter((r) => r.voucher_type === "PURCHASE")
        .reduce((s, r) => s + (parseFloat(r.dr) || 0), 0),
    );
    const totalCredit = totalInvoiced; // Cr Payable = Purchase amounts
    const outstanding = totalInvoiced - totalDebitNotes - totalPayments; // Cr increases payable, Dr decreases
    const transactionCount = rows.length;
    const unpaidAmount = Math.max(0, outstanding);

    // Calculate overdue/current buckets
    const aging = {
      current: 0,
      "1_30": 0,
      "31_60": 0,
      "61_90": 0,
      "91_180": 0,
      "180_plus": 0,
    };
    let remaining = unpaidAmount;
    for (const r of rows.filter((r) => r.voucher_type === "PURCHASE")) {
      if (remaining <= 0) break;
      const days = Math.floor(
        (new Date().getTime() - new Date(r.voucher_date).getTime()) /
          (24 * 60 * 60 * 1000),
      );
      const bucket =
        days <= 0
          ? "current"
          : days <= 30
            ? "1_30"
            : days <= 60
              ? "31_60"
              : days <= 90
                ? "61_90"
                : days <= 180
                  ? "91_180"
                  : "180_plus";
      const allocated = Math.min(parseFloat(r.cr || 0), remaining);
      aging[bucket] += allocated;
      remaining -= allocated;
    }

    const today = new Date().toISOString().slice(0, 10);
    const overdueAmount =
      aging["1_30"] +
      aging["31_60"] +
      aging["61_90"] +
      aging["91_180"] +
      aging["180_plus"];
    let status = "OUTSTANDING";
    if (outstanding <= 0) status = "PAID";
    else if (outstanding < 0) status = "CREDIT_BALANCE";
    else if (overdueAmount > 0) status = "OVERDUE";
    else if (
      totalDebitNotes > 0 &&
      totalPayments > 0 &&
      outstanding < totalInvoiced
    )
      status = "PARTIALLY_PAID";

    return {
      transactions,
      totalInvoiced,
      totalPayments,
      totalDebitNotes,
      totalDebit,
      totalCredit,
      outstanding,
      transactionCount,
      unpaidAmount,
      aging,
      overdueAmount,
      status,
    };
  }

  async getSupplierOutstanding(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const fyId = req.query.financial_year_id;
      const asOfDate = req.query.as_of_date;
      const supplierFilter = req.query.supplier_id;
      const statusFilter = req.query.status;
      const overdueOnly = req.query.overdue === "true";

      const supplierRows = this.voucherRepo.conn.all(
        `
        SELECT DISTINCT v.contact_id, c.first_name, c.last_name, c.email
        FROM vouchers v
        JOIN journal_entries je ON je.voucher_id = v.id AND je.status = 'POSTED'
        JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN accounts a ON a.id = jel.account_id
        LEFT JOIN contacts c ON c.id = v.contact_id AND c.company_id = v.company_id
        WHERE v.company_id = ?
          AND v.contact_id IS NOT NULL
          AND a.id = 'acc_payable'
          AND v.status = 'POSTED'
          AND v.voucher_type IN ('PURCHASE', 'PAYMENT', 'DEBIT_NOTE')
          ${asOfDate ? "AND v.voucher_date <= ?" : ""}
          ${fyId ? "AND v.financial_year_id = ?" : ""}
          ${supplierFilter ? "AND v.contact_id = ?" : ""}
      `,
        asOfDate && fyId && supplierFilter
          ? [companyId, asOfDate, fyId, supplierFilter]
          : asOfDate && fyId
            ? [companyId, asOfDate, fyId]
            : asOfDate && supplierFilter
              ? [companyId, asOfDate, supplierFilter]
              : fyId && supplierFilter
                ? [companyId, fyId, supplierFilter]
                : asOfDate
                  ? [companyId, asOfDate]
                  : fyId
                    ? [companyId, fyId]
                    : supplierFilter
                      ? [companyId, supplierFilter]
                      : [companyId],
      );

      const suppliers = [];
      for (const row of supplierRows) {
        const result = this._getSupplierOutstanding(companyId, row.contact_id, {
          asOfDate,
          financialYearId: fyId,
        });
        if (result.transactionCount === 0) continue;
        const contact = this.voucherRepo.conn.get(
          "SELECT id, first_name, last_name, email FROM contacts WHERE id = ? AND company_id = ?",
          [row.contact_id, companyId],
        );
        const overdueAmount =
          result.outstanding > 0
            ? result.aging["1_30"] +
              result.aging["31_60"] +
              result.aging["61_90"] +
              result.aging["91_180"] +
              result.aging["180_plus"]
            : 0;
        const creditBalance =
          result.outstanding < 0 ? Math.abs(result.outstanding) : 0;
        let status = result.status;

        if (statusFilter) {
          const valid = {
            OUTSTANDING: ["OUTSTANDING", "PARTIALLY_PAID", "OVERDUE"],
            PAID: ["PAID"],
            CREDIT_BALANCE: ["CREDIT_BALANCE"],
            OVERDUE: ["OVERDUE"],
          };
          const validStatuses = valid[statusFilter] || [statusFilter];
          if (!validStatuses.includes(status)) continue;
        }
        if (overdueOnly && overdueAmount <= 0) continue;

        suppliers.push({
          supplierId: row.contact_id,
          supplierName: contact
            ? `${contact.first_name || ""} ${contact.last_name || ""}`.trim()
            : row.contact_id,
          supplierCode: contact ? contact.email : null,
          openingBalance: 0,
          purchaseAmount: result.totalInvoiced,
          debitNotes: result.totalDebitNotes,
          paymentsMade: result.totalPayments,
          outstanding: result.outstanding,
          overdueAmount,
          currentAmount: result.aging.current,
          aging: result.aging,
          lastTransactionDate:
            result.transactions.length > 0
              ? result.transactions[result.transactions.length - 1].date
              : null,
          status,
          creditLimit: 0,
          creditPeriodDays: 30,
          transactionCount: result.transactionCount,
          creditBalance,
        });
      }

      const limit = parseInt(req.query.limit) || 50;
      const offset = (parseInt(req.query.page || 1) - 1) * limit;
      const paged = suppliers.slice(offset, offset + limit);
      const summary = {
        totalSuppliers: suppliers.length,
        totalOutstanding: suppliers.reduce(
          (s, x) => s + parseFloat(x.outstanding || 0),
          0,
        ),
        totalOverdue: suppliers.reduce(
          (s, x) => s + parseFloat(x.overdueAmount || 0),
          0,
        ),
        totalCreditBalance: suppliers.reduce(
          (s, x) => s + parseFloat(x.creditBalance || 0),
          0,
        ),
        totalPurchase: suppliers.reduce(
          (s, x) => s + parseFloat(x.purchaseAmount || 0),
          0,
        ),
        totalPayments: suppliers.reduce(
          (s, x) => s + parseFloat(x.paymentsMade || 0),
          0,
        ),
        totalDebitNotes: suppliers.reduce(
          (s, x) => s + parseFloat(x.debitNotes || 0),
          0,
        ),
      };

      res.json(
        successResponse({ items: paged, total: suppliers.length, summary }),
      );
    } catch (err) {
      next(err);
    }
  }

  async getSupplierStatement(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const contactId = req.params.id;
      const asOfDate = req.query.as_of_date;
      const fyId = req.query.financial_year_id;

      const contact = this.voucherRepo.conn.get(
        "SELECT id, first_name, last_name, email, phone FROM contacts WHERE id = ? AND company_id = ?",
        [contactId, companyId],
      );
      if (!contact) throw new NotFoundError("Supplier not found");

      const result = this._getSupplierOutstanding(companyId, contactId, {
        asOfDate,
        financialYearId: fyId,
      });

      let openingBalance = 0;
      if (asOfDate) {
        const obRows = this.voucherRepo.conn.all(
          `
          SELECT v.voucher_date,
            COALESCE(SUM(jel.debit_amount), 0) AS dr,
            COALESCE(SUM(jel.credit_amount), 0) AS cr,
            v.voucher_type, v.total_amount, v.voucher_number
          FROM vouchers v
          JOIN journal_entries je ON je.voucher_id = v.id AND je.status = 'POSTED'
          JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
          JOIN accounts a ON a.id = jel.account_id
          WHERE v.company_id = ? AND v.contact_id = ?
            AND a.id = 'acc_payable'
            AND v.status = 'POSTED'
            AND v.voucher_type IN ('PURCHASE', 'PAYMENT', 'DEBIT_NOTE')
            AND v.voucher_date < ?
          GROUP BY v.id
          ORDER BY v.voucher_date
        `,
          [companyId, contactId, asOfDate],
        );
        openingBalance = obRows.reduce((sum, r) => {
          if (r.voucher_type === "PURCHASE")
            return sum + (parseFloat(r.cr) || 0);
          return sum - (parseFloat(r.dr) || 0);
        }, 0);
      }

      const closingBalance = openingBalance + result.outstanding;

      res.json(
        successResponse({
          customer: {
            id: contactId,
            name: `${contact.first_name || ""} ${contact.last_name || ""}`.trim(),
            email: contact.email,
            phone: contact.phone,
            code: contact.email,
          },
          creditLimit: 0,
          creditPeriodDays: 30,
          paymentTerms: null,
          openingBalance,
          totalDebit: result.totalDebit,
          totalCredit: result.totalCredit,
          purchaseAmount: result.totalInvoiced,
          debitNotes: result.totalDebitNotes,
          paymentsMade: result.totalPayments,
          closingBalance,
          transactions: result.transactions,
          transactionCount: result.transactionCount,
          asOfDate: asOfDate || null,
          financialYearId: fyId || null,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async getApAging(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const asOfDate =
        req.query.as_of_date || new Date().toISOString().slice(0, 10);
      const fyId = req.query.financial_year_id;

      const supplierRows = this.voucherRepo.conn.all(
        `
        SELECT DISTINCT v.contact_id, c.first_name, c.last_name, c.email
        FROM vouchers v
        JOIN journal_entries je ON je.voucher_id = v.id AND je.status = 'POSTED'
        JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN accounts a ON a.id = jel.account_id
        LEFT JOIN contacts c ON c.id = v.contact_id AND c.company_id = v.company_id
        WHERE v.company_id = ?
          AND v.contact_id IS NOT NULL
          AND a.id = 'acc_payable'
          AND v.status = 'POSTED'
          AND v.voucher_type IN ('PURCHASE', 'PAYMENT', 'DEBIT_NOTE')
          AND v.voucher_date <= ?
          ${fyId ? "AND v.financial_year_id = ?" : ""}
      `,
        fyId ? [companyId, asOfDate, fyId] : [companyId, asOfDate],
      );

      const agingData = [];
      let totals = {
        current: 0,
        "1_30": 0,
        "31_60": 0,
        "61_90": 0,
        "91_180": 0,
        "180_plus": 0,
        total: 0,
      };

      for (const row of supplierRows) {
        const result = this._getSupplierOutstanding(companyId, row.contact_id, {
          asOfDate,
        });
        if (result.outstanding <= 0) continue;

        const invoiceDates = this.voucherRepo.conn.all(
          `
          SELECT v.voucher_date,
            COALESCE(SUM(jel.debit_amount), 0) AS dr,
            COALESCE(SUM(jel.credit_amount), 0) AS cr
          FROM vouchers v
          JOIN journal_entries je ON je.voucher_id = v.id AND je.status = 'POSTED'
          JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
          JOIN accounts a ON a.id = jel.account_id
          WHERE v.company_id = ? AND v.contact_id = ? AND v.voucher_type = 'PURCHASE' AND a.id = 'acc_payable' AND v.status = 'POSTED' AND je.status = 'POSTED' AND v.voucher_date <= ?
          GROUP BY v.id
          ORDER BY v.voucher_date
        `,
          [companyId, row.contact_id, asOfDate],
        );

        let remaining = result.outstanding;
        let customerAging = {
          current: 0,
          "1_30": 0,
          "31_60": 0,
          "61_90": 0,
          "91_180": 0,
          "180_plus": 0,
        };
        for (const inv of invoiceDates) {
          if (remaining <= 0) break;
          const days = Math.floor(
            (new Date(asOfDate).getTime() -
              new Date(inv.voucher_date).getTime()) /
              (24 * 60 * 60 * 1000),
          );
          const bucket =
            days <= 0
              ? "current"
              : days <= 30
                ? "1_30"
                : days <= 60
                  ? "31_60"
                  : days <= 90
                    ? "61_90"
                    : days <= 180
                      ? "91_180"
                      : "180_plus";
          const allocated = Math.min(parseFloat(inv.cr || 0), remaining);
          customerAging[bucket] += allocated;
          totals[bucket] += allocated;
          remaining -= allocated;
        }

        const total =
          customerAging.current +
          customerAging["1_30"] +
          customerAging["31_60"] +
          customerAging["61_90"] +
          customerAging["91_180"] +
          customerAging["180_plus"];
        totals.total += total;

        agingData.push({
          supplierId: row.contact_id,
          supplierName: `${row.first_name || ""} ${row.last_name || ""}`.trim(),
          current: customerAging.current,
          "1_30": customerAging["1_30"],
          "31_60": customerAging["31_60"],
          "61_90": customerAging["61_90"],
          "91_180": customerAging["91_180"],
          "180_plus": customerAging["180_plus"],
          total,
        });
      }

      res.json(
        successResponse({
          asOfDate,
          suppliers: agingData,
          totals,
          total: agingData.length,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async getApReconciliation(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const asOfDate = req.query.as_of_date;

      const supplierRows = this.voucherRepo.conn.all(
        `
        SELECT DISTINCT v.contact_id
        FROM vouchers v
        JOIN journal_entries je ON je.voucher_id = v.id AND je.status = 'POSTED'
        JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN accounts a ON a.id = jel.account_id
        WHERE v.company_id = ?
          AND v.contact_id IS NOT NULL
          AND a.id = 'acc_payable'
          AND v.status = 'POSTED'
          AND v.voucher_type IN ('PURCHASE', 'PAYMENT', 'DEBIT_NOTE')
          ${asOfDate ? "AND v.voucher_date <= ?" : ""}
      `,
        asOfDate ? [companyId, asOfDate] : [companyId],
      );

      let supplierTotal = 0;
      const seen = new Set();
      for (const { contact_id } of supplierRows) {
        if (seen.has(contact_id)) continue;
        seen.add(contact_id);
        const result = this._getSupplierOutstanding(companyId, contact_id, {
          asOfDate,
        });
        supplierTotal += result.outstanding;
      }

      const controlBalance = this.voucherRepo.conn.get(
        `
        SELECT COALESCE(SUM(jel.credit_amount) - SUM(jel.debit_amount), 0) as balance
        FROM journal_entries je
        JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN vouchers v ON v.id = je.voucher_id
        JOIN accounts a ON a.id = jel.account_id
        WHERE v.company_id = ?
          AND v.contact_id IS NOT NULL
          AND a.id = 'acc_payable'
          AND v.status = 'POSTED'
          AND je.status = 'POSTED'
          AND v.voucher_type IN ('PURCHASE', 'PAYMENT', 'DEBIT_NOTE')
          ${asOfDate ? "AND v.voucher_date <= ?" : ""}
      `,
        asOfDate ? [companyId, asOfDate] : [companyId],
      );

      const ledgerTotal = parseFloat(controlBalance?.balance || 0);
      const difference = supplierTotal - ledgerTotal;

      const reconId = generateId("aprcn");
      this.voucherRepo.conn
        .prepare(
          `
        INSERT INTO ar_reconciliation_log (id, company_id, as_of_date, customer_level_total, control_ledger_total, difference, status, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `,
        )
        .run(
          reconId,
          companyId,
          asOfDate || new Date().toISOString().slice(0, 10),
          supplierTotal,
          ledgerTotal,
          difference,
          Math.abs(difference) < 0.01 ? "RECONCILED" : "REQUIRES_ATTENTION",
          "system",
        );

      logAudit(
        this.voucherRepo.conn,
        companyId,
        "system",
        "ap_reconciliation",
        reconId,
        "RECONCILE",
        null,
        {
          supplier_level_total: supplierTotal,
          control_ledger_total: ledgerTotal,
          difference,
        },
      );

      res.json(
        successResponse({
          asOfDate: asOfDate || null,
          supplierLevelTotal: supplierTotal,
          controlLedgerTotal: ledgerTotal,
          difference,
          status:
            Math.abs(difference) < 0.01 ? "RECONCILED" : "REQUIRES_ATTENTION",
          reconciliationId: reconId,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  _getPayableInvoiceOutstanding(invoiceId, companyId) {
    const rows = this.voucherRepo.conn.all(
      `
      SELECT v.voucher_type,
        COALESCE(SUM(jel.debit_amount), 0) AS dr,
        COALESCE(SUM(jel.credit_amount), 0) AS cr,
        v.status as voucher_status,
        je.status as je_status
      FROM vouchers v
      JOIN journal_entries je ON je.voucher_id = v.id
      JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN accounts a ON a.id = jel.account_id
      WHERE v.company_id = ? AND a.id = 'acc_payable'
        AND (v.id = ? OR v.original_purchase_invoice_id = ? OR v.original_sales_invoice_id = ?)
      GROUP BY v.id
    `,
      [companyId, invoiceId, invoiceId, invoiceId],
    );

    let invoiceAmount = 0;
    let reductions = 0;

    rows.forEach((r) => {
      if (r.voucher_status !== "POSTED" || r.je_status !== "POSTED") return;
      if (r.voucher_type === "PURCHASE") {
        invoiceAmount += parseFloat(r.cr || 0);
      } else if (r.voucher_type === "DEBIT_NOTE") {
        reductions += parseFloat(r.dr || 0);
      }
    });

    return invoiceAmount - reductions;
  }

  async getSupplierInvoices(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const contactId = req.params.id;

      const contact = this.voucherRepo.conn.get(
        "SELECT id FROM contacts WHERE id = ? AND company_id = ?",
        [contactId, companyId],
      );
      if (!contact) throw new NotFoundError("Supplier not found");

      const invoices = this.voucherRepo.conn.all(
        `
        SELECT v.id, v.voucher_number, v.voucher_date, v.total_amount, v.status,
               v.payable_ledger_id, v.purchase_ledger_id,
               COALESCE(SUM(jel.debit_amount), 0) AS dr,
               COALESCE(SUM(jel.credit_amount), 0) AS cr
        FROM vouchers v
        JOIN journal_entries je ON je.voucher_id = v.id AND je.status = 'POSTED'
        JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN accounts a ON a.id = jel.account_id
        WHERE v.company_id = ? AND v.contact_id = ? AND v.voucher_type = 'PURCHASE' AND a.id = 'acc_payable'
        GROUP BY v.id
        ORDER BY v.voucher_date DESC
      `,
        [companyId, contactId],
      );

      const invoiceList = invoices.map((inv) => {
        const outstanding = this._getPayableInvoiceOutstanding(
          inv.id,
          companyId,
        );
        const allocated = parseFloat(inv.total_amount || 0) - outstanding;
        return {
          id: inv.id,
          voucherNumber: inv.voucher_number,
          date: inv.voucher_date,
          amount: parseFloat(inv.total_amount || 0),
          outstanding: Math.max(0, outstanding),
          allocated,
          status:
            outstanding === 0
              ? "PAID"
              : allocated > 0
                ? "PARTIALLY_PAID"
                : "OUTSTANDING",
        };
      });

      const totalOutstanding = invoiceList
        .filter((i) => i.status !== "PAID")
        .reduce((s, i) => s + i.outstanding, 0);
      const totalInvoiced = invoiceList.reduce((s, i) => s + i.amount, 0);

      res.json(
        successResponse({
          customerId: contactId,
          invoices: invoiceList,
          total: invoiceList.length,
          totalInvoiced,
          totalOutstanding,
          paidCount: invoiceList.filter((i) => i.status === "PAID").length,
          outstandingCount: invoiceList.filter((i) => i.status !== "PAID")
            .length,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async createPayableAllocation(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { invoice_voucher_id, payment_voucher_id, amount } = req.body;

      // Validate invoice
      const invoice = this.voucherRepo.findById(invoice_voucher_id, companyId);
      if (!invoice || invoice.voucher_type !== "PURCHASE") {
        throw new NotFoundError("Purchase Invoice not found");
      }
      // Validate payment
      const payment = this.voucherRepo.findById(payment_voucher_id, companyId);
      if (!payment || payment.voucher_type !== "PAYMENT") {
        throw new NotFoundError("Payment Voucher not found");
      }
      // Validate amount
      if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        throw new ValidationError("Valid allocation amount is required");
      }

      // Check invoice is for the same supplier as payment
      if (invoice.contact_id !== payment.contact_id) {
        throw new ValidationError(
          "Invoice and Payment must be for the same supplier",
        );
      }

      // Check allocation does not exceed invoice outstanding
      const invoiceOutstanding = this._getPayableInvoiceOutstanding(
        invoice.id,
        companyId,
      );
      if (parseFloat(amount) > invoiceOutstanding) {
        throw new ValidationError(
          `Allocation exceeds invoice outstanding (${invoiceOutstanding})`,
        );
      }

      // Check allocation does not exceed payment amount
      if (parseFloat(amount) > parseFloat(payment.total_amount || 0)) {
        throw new ValidationError("Allocation exceeds payment amount");
      }

      // Check for duplicate allocation
      const existing = this.voucherRepo.conn.get(
        "SELECT id FROM payable_allocations WHERE payment_id = ? AND purchase_invoice_id = ? AND status = ?",
        [payment.id, invoice.id, "ACTIVE"],
      );
      if (existing) {
        throw new ValidationError(
          "Allocation already exists for this invoice against this payment",
        );
      }

      const allocationId = generateId("palloc");
      const now = new Date().toISOString();
      this.voucherRepo.conn
        .prepare(
          `
        INSERT INTO payable_allocations (id, company_id, supplier_id, payment_id, purchase_invoice_id,
          allocated_amount, allocation_date, financial_year_id, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)
      `,
        )
        .run(
          allocationId,
          companyId,
          invoice.contact_id,
          payment.id,
          invoice.id,
          parseFloat(amount),
          now,
          invoice.financial_year_id,
          req.user?.userId || "system",
          now,
          now,
        );

      logAudit(
        this.voucherRepo.conn,
        companyId,
        req.user?.userId || "system",
        "payable_allocation",
        allocationId,
        "CREATE",
        null,
        {
          payment_id: payment.id,
          purchase_invoice_id: invoice.id,
          allocated_amount: parseFloat(amount),
        },
      );

      res.status(201).json(
        successResponse({
          success: true,
          message: "Payable allocation created",
          allocationId,
          invoiceOutstanding: invoiceOutstanding - parseFloat(amount),
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  // ─── Interest Calculation ──────────────────────────────────────────
  async calculateInterest(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const rec = this.receivableRepo.conn.get(
        "SELECT * FROM receivables WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!rec) throw new NotFoundError("Receivable not found");
      const config = this.receivableRepo.conn.get(
        "SELECT * FROM interest_configs WHERE company_id = ? LIMIT 1",
        [companyId],
      );
      if (!config)
        throw new ValidationError(
          "No interest configuration found for this company",
        );

      const daysOverdue = rec.days_overdue || 0;
      if (daysOverdue <= (config.grace_period_days || 0)) {
        return res.json(
          successResponse({
            interest_amount: 0,
            days_overdue: daysOverdue,
            grace_period: config.grace_period_days,
          }),
        );
      }

      const outstanding = parseFloat(rec.outstanding_amount) || 0;
      let rate = parseFloat(config.interest_rate) || 0;
      if (config.calculation_method === "MONTHLY") rate = rate / 12;
      else if (config.calculation_method === "YEARLY") rate = rate / 365;

      const interest =
        (outstanding * rate * (daysOverdue - (config.grace_period_days || 0))) /
        100;
      res.json(
        successResponse({
          interest_amount: interest,
          days_overdue: daysOverdue,
          outstanding,
          rate: config.interest_rate,
          grace_period: config.grace_period_days,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async postInterest(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { interest_amount, calculation_date } = req.body;
      const rec = this.receivableRepo.conn.get(
        "SELECT * FROM receivables WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!rec) throw new NotFoundError("Receivable not found");

      const tx = this.journalRepo.conn.transaction(() => {
        const interestAccount =
          this.coaRepo.conn.get(
            `SELECT * FROM accounts WHERE company_id = ? AND type = 'EXPENSE' AND code LIKE '5900%' LIMIT 1`,
            [companyId],
          ) ||
          this.coaRepo.conn.get(
            `SELECT * FROM accounts WHERE company_id = ? AND type = 'EXPENSE' LIMIT 1`,
            [companyId],
          );
        const arAccount = this.coaRepo.conn.get(
          `SELECT * FROM accounts WHERE company_id = ? AND type = 'ASSET' AND code LIKE '1003%' LIMIT 1`,
          [companyId],
        );
        if (!interestAccount || !arAccount)
          throw new ValidationError(
            "Interest or receivable account not configured",
          );

        const voucherId = generateId("vch");
        this.voucherRepo.conn
          .prepare(
            `
          INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, voucher_date, status, created_by, created_at, updated_at)
          VALUES (?, ?, ?, 'JOURNAL', ?, 'POSTED', ?, datetime('now'), datetime('now'))
        `,
          )
          .run(
            voucherId,
            companyId,
            "INT-" + Date.now(),
            calculation_date || new Date().toISOString().slice(0, 10),
            req.user.userId,
          );

        const jeId = generateId("je");
        const now = new Date().toISOString();
        this.journalRepo.conn
          .prepare(
            `
          INSERT INTO journal_entries (id, company_id, voucher_id, entry_number, entry_date, description, currency, exchange_rate, total_debit, total_credit, status, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'USD', 1.0, ?, ?, 'POSTED', ?, ?, ?)
        `,
          )
          .run(
            jeId,
            companyId,
            voucherId,
            "JE-INT-" + Date.now(),
            calculation_date || new Date().toISOString().slice(0, 10),
            `Interest on overdue receivable ${rec.id}`,
            parseFloat(interest_amount),
            0,
            req.user.userId,
            now,
            now,
          );

        this.journalRepo.conn
          .prepare(
            `
          INSERT INTO journal_entry_lines (id, company_id, journal_entry_id, account_id, debit_amount, credit_amount, description, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        `,
          )
          .run(
            generateId("jl"),
            companyId,
            jeId,
            interestAccount.id,
            parseFloat(interest_amount),
            "Interest charge",
            now,
          );

        this.journalRepo.conn
          .prepare(
            `
          INSERT INTO journal_entry_lines (id, company_id, journal_entry_id, account_id, debit_amount, credit_amount, description, created_at)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?)
        `,
          )
          .run(
            generateId("jl"),
            companyId,
            jeId,
            arAccount.id,
            parseFloat(interest_amount),
            "Interest on overdue",
            now,
          );

        this.costCentreRepo.conn
          .prepare(
            `
          INSERT INTO interest_calculations (id, company_id, receivable_id, interest_rate, interest_amount, calculation_date, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'POSTED', datetime('now'))
        `,
          )
          .run(
            generateId("int"),
            companyId,
            rec.id,
            0,
            parseFloat(interest_amount),
            calculation_date || new Date().toISOString().slice(0, 10),
          );
      });
      tx();
      res.status(201).json(
        successResponse({
          message: "Interest posted",
          receivable_id: rec.id,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  // ─── Financial Years ───────────────────────────────────────────────
  async listFinancialYears(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const fys = this.costCentreRepo.conn.all(
        "SELECT * FROM financial_years WHERE company_id = ? ORDER BY start_date DESC",
        [companyId],
      );
      res.json(
        successResponse({ items: fys, total: fys.length, financialYears: fys }),
      );
    } catch (err) {
      next(err);
    }
  }

  async createFinancialYear(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { name, start_date, end_date } = req.body;
      if (!name || !start_date || !end_date)
        throw new ValidationError("name, start_date, end_date are required");
      const id = generateId("fy");
      try {
        this.costCentreRepo.conn
          .prepare(
            `
          INSERT INTO financial_years (id, company_id, name, start_date, end_date, is_active, is_locked, created_at)
          VALUES (?, ?, ?, ?, ?, 0, 0, datetime('now'))
        `,
          )
          .run(id, companyId, name, start_date, end_date);
      } catch (e) {
        if (e.code === "SQLITE_CONSTRAINT_UNIQUE")
          throw new ValidationError("Financial year already exists");
        throw e;
      }
      res
        .status(201)
        .json(
          successResponse(
            this.costCentreRepo.conn.get(
              "SELECT * FROM financial_years WHERE id = ?",
              [id],
            ),
          ),
        );
    } catch (err) {
      next(err);
    }
  }

  async setActiveFinancialYear(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      // Deactivate all, then activate the selected one
      this.costCentreRepo.conn
        .prepare(
          "UPDATE financial_years SET is_active = 0 WHERE company_id = ?",
        )
        .run(companyId);
      this.costCentreRepo.conn
        .prepare(
          "UPDATE financial_years SET is_active = 1 WHERE id = ? AND company_id = ?",
        )
        .run(req.params.id, companyId);
      res.json(successResponse({ message: "Financial year activated" }));
    } catch (err) {
      next(err);
    }
  }

  async lockFinancialYear(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const fy = this.costCentreRepo.conn.get(
        "SELECT * FROM financial_years WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!fy) throw new NotFoundError("Financial year not found");
      this.costCentreRepo.conn
        .prepare("UPDATE financial_years SET is_locked = 1 WHERE id = ?")
        .run(fy.id);
      res.json(successResponse({ message: "Financial year locked" }));
    } catch (err) {
      next(err);
    }
  }

  // ─── Cost Categories ───────────────────────────────────────────────
  async listCostCategories(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const items = this.costCentreRepo.conn.all(
        "SELECT * FROM cost_categories WHERE company_id = ? ORDER BY code",
        [companyId],
      );
      res.json(successResponse({ items, total: items.length }));
    } catch (err) {
      next(err);
    }
  }

  async createCostCategory(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { code, name, description } = req.body;
      // Cost category code is system-generated when not supplied.
      let resolvedCode = typeof code === "string" ? code.trim() : "";
      if (!resolvedCode) {
        resolvedCode = CodeGenerator.generate(
          this.costCentreRepo.conn,
          "COST_CATEGORY",
          companyId,
        );
      }
      if (!name) throw new ValidationError("name is required");

      const id = generateId("ccat");
      try {
        this.costCentreRepo.conn
          .prepare(
            `
          INSERT INTO cost_categories (id, company_id, code, name, description, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
        `,
          )
          .run(id, companyId, resolvedCode, name, description || "");
      } catch (e) {
        if (e.code === "SQLITE_CONSTRAINT_UNIQUE")
          throw new ValidationError("Cost category code already exists");
        throw e;
      }
      res
        .status(201)
        .json(
          successResponse(
            this.costCentreRepo.conn.get(
              "SELECT * FROM cost_categories WHERE id = ?",
              [id],
            ),
          ),
        );
    } catch (err) {
      next(err);
    }
  }

  async updateCostCategory(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const cc = this.costCentreRepo.conn.get(
        "SELECT * FROM cost_categories WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!cc) throw new NotFoundError("Cost category not found");
      const updates = {};
      for (const k of ["code", "name", "description", "is_active"]) {
        if (req.body[k] !== undefined) updates[k] = req.body[k];
      }
      if (Object.keys(updates).length > 0) {
        const sets = Object.keys(updates)
          .map((k) => `${k} = ?`)
          .join(", ");
        this.costCentreRepo.conn
          .prepare(
            `UPDATE cost_categories SET ${sets}, updated_at = datetime('now') WHERE id = ?`,
          )
          .run(...Object.values(updates), cc.id);
      }
      res.json(
        successResponse(
          this.costCentreRepo.conn.get(
            "SELECT * FROM cost_categories WHERE id = ?",
            [cc.id],
          ),
        ),
      );
    } catch (err) {
      next(err);
    }
  }

  async deleteCostCategory(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const cc = this.costCentreRepo.conn.get(
        "SELECT * FROM cost_categories WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!cc) throw new NotFoundError("Cost category not found");
      const usage = this.costCentreRepo.conn.get(
        "SELECT COUNT(*) as c FROM journal_entry_lines WHERE cost_category_id = ?",
        [cc.id],
      );
      if (usage.c > 0)
        throw new AppError(
          "Cannot delete a cost category that has accounting transactions",
          "CATEGORY_IN_USE",
          400,
        );
      this.costCentreRepo.conn
        .prepare("DELETE FROM cost_categories WHERE id = ?")
        .run(cc.id);
      res.json(successResponse({ message: "Deleted" }));
    } catch (err) {
      next(err);
    }
  }

  // ─── Account Groups ────────────────────────────────────────────────
  async listAccountGroups(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const items = this.groupRepo.conn.all(
        "SELECT * FROM account_groups WHERE company_id = ? ORDER BY type, code",
        [companyId],
      );
      // Enrich with children counts
      const enriched = items.map((g) => {
        const childGroups = this.groupRepo.getChildGroupCount(g.id, companyId);
        const childAccounts = this.groupRepo.getChildAccountCount(
          g.id,
          companyId,
        );
        return {
          ...g,
          child_group_count: childGroups,
          child_account_count: childAccounts,
          allow_child_accounts:
            g.allow_child_accounts !== undefined
              ? !!g.allow_child_accounts
              : true,
          is_active: g.is_active !== 0,
        };
      });
      res.json(
        successResponse({
          items: enriched,
          total: enriched.length,
          groups: enriched,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async getAccountGroup(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const group = this.groupRepo.conn.get(
        "SELECT * FROM account_groups WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!group) throw new NotFoundError("Account group not found");
      // Get child groups
      const children = this.groupRepo.conn.all(
        "SELECT * FROM account_groups WHERE parent_id = ? AND company_id = ?",
        [group.id, companyId],
      );
      // Get child ledger accounts
      const childAccounts = this.groupRepo.conn.all(
        "SELECT id, code, name, type, is_active FROM accounts WHERE (account_group_id = ? OR parent_id = ?) AND company_id = ? AND (is_group = 0 OR is_group IS NULL) ORDER BY code",
        [group.id, group.id, companyId],
      );
      res.json(
        successResponse({
          ...group,
          is_active: group.is_active !== 0,
          allow_child_accounts: group.allow_child_accounts !== 0,
          child_groups: children.map((c) => ({
            ...c,
            is_active: c.is_active !== 0,
          })),
          child_accounts: childAccounts,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async createAccountGroup(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const context = {
        companyId,
        userId: req.user?.userId,
        permissions: req.user?.permissions || [],
        sessionId: req.user?.sessionId,
      };
      // Map frontend field names to service
      const data = {
        code: req.body.code || req.body.group_code,
        name: req.body.name || req.body.group_name,
        type: req.body.type || req.body.account_type,
        parent_id: req.body.parent_id || req.body.parent_group_id || null,
        description: req.body.description || "",
        is_active:
          req.body.is_active !== undefined
            ? req.body.is_active
            : req.body.status === "Active"
              ? true
              : req.body.status === "Inactive"
                ? false
                : true,
        allow_child_accounts:
          req.body.allow_child_accounts !== undefined
            ? req.body.allow_child_accounts
            : true,
      };

      const service = new AccountGroupService(this.groupRepo.conn);
      const group = service.create(data, context);
      logAudit(
        this.groupRepo.conn,
        companyId,
        req.user?.userId,
        "account_group",
        group.id,
        "CREATE",
        null,
        group,
      );
      res.status(201).json(
        successResponse({
          ...group,
          is_active: group.is_active !== 0,
          allow_child_accounts: group.allow_child_accounts !== 0,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async updateAccountGroup(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const context = {
        companyId,
        userId: req.user?.userId,
        permissions: req.user?.permissions || [],
        sessionId: req.user?.sessionId,
      };
      const data = {
        code: req.body.code,
        name: req.body.name,
        type: req.body.type,
        parent_id: req.body.parent_id,
        description: req.body.description,
        is_active:
          req.body.is_active !== undefined
            ? req.body.is_active
            : req.body.status === "Active"
              ? true
              : req.body.status === "Inactive"
                ? false
                : undefined,
        allow_child_accounts: req.body.allow_child_accounts,
      };
      // Remove undefined keys
      Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);

      const service = new AccountGroupService(this.groupRepo.conn);
      const updated = service.update(req.params.id, data, context);
      res.json(
        successResponse({
          ...updated,
          is_active: updated.is_active !== 0,
          allow_child_accounts: updated.allow_child_accounts !== 0,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async deleteAccountGroup(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const context = {
        companyId,
        userId: req.user?.userId,
        permissions: req.user?.permissions || [],
        sessionId: req.user?.sessionId,
      };
      const service = new AccountGroupService(this.groupRepo.conn);
      const result = service.remove(req.params.id, context);
      res.json(
        successResponse({ message: "Account Group deleted", ...result }),
      );
    } catch (err) {
      next(err);
    }
  }

  // ─── Account Group Suggest (type inheritance) ──────────────────────
  async suggestGroupType(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const context = {
        companyId,
        userId: req.user?.userId,
        permissions: req.user?.permissions || [],
        sessionId: req.user?.sessionId,
      };
      const service = new AccountGroupService(this.groupRepo.conn);
      const suggestion = service.suggestFromParent(
        req.params.parentId,
        context,
      );
      res.json(successResponse({ suggestion: suggestion || null }));
    } catch (err) {
      next(err);
    }
  }

  // ─── Account Group Tree ─────────────────────────────────────────────

  // ─── Bank Accounts ─────────────────────────────────────────────────
  async updateBankAccount(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const ba = this.costCentreRepo.conn.get(
        "SELECT * FROM bank_accounts WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!ba) throw new NotFoundError("Bank account not found");
      const updates = {};
      for (const k of [
        "account_name",
        "account_number",
        "bank_name",
        "ifsc_code",
        "account_type",
        "gl_account_id",
        "opening_balance",
        "is_active",
      ]) {
        if (req.body[k] !== undefined) updates[k] = req.body[k];
      }
      if (Object.keys(updates).length > 0) {
        const sets = Object.keys(updates)
          .map((k) => `${k} = ?`)
          .join(", ");
        this.costCentreRepo.conn
          .prepare(
            `UPDATE bank_accounts SET ${sets}, updated_at = datetime('now') WHERE id = ?`,
          )
          .run(...Object.values(updates), ba.id);
      }
      res.json(
        successResponse(
          this.costCentreRepo.conn.get(
            "SELECT * FROM bank_accounts WHERE id = ?",
            [ba.id],
          ),
        ),
      );
    } catch (err) {
      next(err);
    }
  }

  // ─── Budget Detail ─────────────────────────────────────────────────
  async getBudget(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const budget = this.budgetRepo.conn.get(
        "SELECT * FROM budgets WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!budget) throw new NotFoundError("Budget not found");
      const lines = this.budgetRepo.getBudgetLines(budget.id, companyId);
      res.json(successResponse({ ...budget, lines }));
    } catch (err) {
      next(err);
    }
  }

  // ─── Budget Actuals Update ─────────────────────────────────────────
  async updateBudgetActuals(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { account_id, period, actual_amount } = req.body;
      this.updateBudgetActualsInternal(
        companyId,
        new Date().toISOString().slice(0, 10),
        account_id,
        period,
        parseFloat(actual_amount) || 0,
      );
      res.json(successResponse({ message: "Budget actuals updated" }));
    } catch (err) {
      next(err);
    }
  }

  updateBudgetActualsInternal(
    companyId,
    date,
    accountId = null,
    period = null,
    amount = null,
  ) {
    // This is a simplified version - in production would properly aggregate journal entries
  }

  // ─── Ledger ────────────────────────────────────────────────────────
  async getLedger(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const from = req.query.from || req.query.start_date || null;
      const to = req.query.to || req.query.end_date || null;
      const balance = this.journalRepo.getAccountBalance(
        req.params.accountId,
        companyId,
        to || "9999-12-31",
        from || "1900-01-01",
      );
      // Get actual line items for this account
      const lines = this.journalRepo.conn.all(
        `
        SELECT je.entry_date, je.description, v.voucher_number, v.voucher_type, jel.debit_amount, jel.credit_amount
        FROM journal_entry_lines jel
        JOIN journal_entries je ON jel.journal_entry_id = je.id
        LEFT JOIN vouchers v ON je.voucher_id = v.id
        WHERE jel.company_id = ? AND jel.account_id = ?
        AND je.status = 'POSTED'
        ${from ? "AND je.entry_date >= '" + from + "'" : ""}
        ${to ? "AND je.entry_date <= '" + to + "'" : ""}
        ORDER BY je.entry_date ASC
      `,
        [companyId, req.params.accountId],
      );
      let runningBalance = 0;
      const items = lines.map((l) => {
        const dr = parseFloat(l.debit_amount) || 0;
        const cr = parseFloat(l.credit_amount) || 0;
        runningBalance += dr - cr;
        return {
          ...l,
          debit_balance: dr,
          credit_balance: cr,
          running_balance: runningBalance,
        };
      });
      const account = this.coaRepo?.findById(req.params.accountId, companyId) || {};
      res.json(successResponse({ account, items, total: items.length, ...balance }));
    } catch (err) {
      next(err);
    }
  }

  async getBankTransactions(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const from = req.query.from || null;
      const to = req.query.to || null;
      // Resolve bank_account_id to gl_account_id
      const bankAccount = this.journalRepo.conn.get(
        "SELECT gl_account_id FROM bank_accounts WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!bankAccount) throw new NotFoundError("BankAccount", req.params.id);
      const txns = this.journalRepo.conn.all(
        `
        SELECT je.*, v.voucher_type, v.reference_number FROM journal_entries je
        LEFT JOIN vouchers v ON je.voucher_id = v.id
        WHERE je.company_id = ? AND je.status = 'POSTED'
        AND EXISTS (SELECT 1 FROM journal_entry_lines jel WHERE jel.journal_entry_id = je.id AND jel.account_id = ?)
        ORDER BY je.entry_date DESC
      `,
        [companyId, bankAccount.gl_account_id],
      );
      res.json(successResponse({ items: txns }));
    } catch (err) {
      next(err);
    }
  }

  // ─── Report Endpoints ──────────────────────────────────────────────
  async trialBalanceReport(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.journalRepo.trialBalance(
        companyId,
        req.query.from,
        req.query.to,
      );
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async profitLossReport(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.journalRepo.profitLoss(
        companyId,
        req.query.from,
        req.query.to,
      );
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async balanceSheetReport(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const asOf = req.query.as_of || new Date().toISOString().slice(0, 10);
      const result = this.journalRepo.balanceSheet(companyId, asOf);
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async cashFlowReport(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.journalRepo.cashFlow(
        companyId,
        req.query.from,
        req.query.to,
      );
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async fundFlowReport(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.journalRepo.cashFlow(
        companyId,
        req.query.from,
        req.query.to,
      );
      res.json(
        successResponse({
          ...result,
          reportType: "fund_flow",
          note: "Fund flow derived from cash flow data",
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async ratiosReport(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.journalRepo.ratios(
        companyId,
        req.query.from,
        req.query.to,
      );
      // Replace null values with safe defaults
      const safe = {};
      for (const [k, v] of Object.entries(result)) {
        safe[k] =
          v === null ||
          v === undefined ||
          (typeof v === "number" && !isFinite(v))
            ? 0
            : v;
      }
      res.json(successResponse(safe));
    } catch (err) {
      next(err);
    }
  }

  async dayBookReport(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.journalRepo.dayBook({
        companyId,
        from: req.query.from,
        to: req.query.to,
        q: req.query.q,
        type: req.query.type,
        limit: parseInt(req.query.limit) || 50,
        offset: parseInt(
          req.query.page
            ? (parseInt(req.query.page) - 1) * (parseInt(req.query.limit) || 50)
            : 0,
        ),
      });
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  async ledgerReport(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const from = req.query.from || null;
      const to = req.query.to || null;
      const accountId = req.query.account_id;
      if (!accountId)
        throw new ValidationError("account_id query parameter is required");

      // Get all journal lines for this account
      const lines = this.journalRepo.conn.all(
        `
        SELECT jel.*, je.entry_date, je.entry_number, je.description as je_description, v.voucher_number, v.voucher_type, u.username as created_by
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        LEFT JOIN vouchers v ON v.id = je.voucher_id
        LEFT JOIN users u ON u.id = je.created_by
        WHERE jel.account_id = ? AND je.company_id = ? AND je.status = 'POSTED'
        AND je.entry_date >= COALESCE(?, '1900-01-01') AND je.entry_date <= COALESCE(?, '9999-12-31')
        ORDER BY je.entry_date ASC
      `,
        [accountId, companyId, from, to],
      );

      const balance = this.journalRepo.getAccountBalance(
        accountId,
        companyId,
        to,
        from,
      );
      res.json(successResponse({ items: lines, ...balance }));
    } catch (err) {
      next(err);
    }
  }

  // Aliases for report endpoints
  async trialBalance(req, res, next) {
    return this.trialBalanceReport(req, res, next);
  }
  async profitLoss(req, res, next) {
    return this.profitLossReport(req, res, next);
  }
  async balanceSheet(req, res, next) {
    return this.balanceSheetReport(req, res, next);
  }
  async cashFlow(req, res, next) {
    return this.cashFlowReport(req, res, next);
  }
  async fundFlow(req, res, next) {
    // Simplified fund flow: sources and applications of funds
    try {
      const companyId = getCompanyId(req);
      const from = req.query.from || null;
      const to = req.query.to || null;
      const result = this.journalRepo.fundFlow(companyId, from, to);
      res.json(
        successResponse({
          ...result,
          reportType: "fund_flow",
          note: "Sources and applications of funds derived from journal entries",
        }),
      );
    } catch (err) {
      next(err);
    }
  }
  async ratios(req, res, next) {
    return this.ratiosReport(req, res, next);
  }
  async dayBook(req, res, next) {
    return this.dayBookReport(req, res, next);
  }

  // ═══ Step 5: Opening Balances & Accounting Initialization ═══

  async listFinancialYears(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const years = this.coaRepo.conn.all(
        `SELECT * FROM financial_years WHERE company_id = ? ORDER BY start_date DESC`,
        [companyId],
      );
      res.json(successResponse({ items: years, total: years.length }));
    } catch (err) {
      next(err);
    }
  }

  async createFinancialYear(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { name, start_date, end_date } = req.body;
      if (!name || !start_date || !end_date)
        throw new ValidationError(
          "name, start_date, and end_date are required",
        );
      const fyId = generateId("fy");
      const now = new Date().toISOString();
      this.coaRepo.conn
        .prepare(
          `
        INSERT INTO financial_years (id, company_id, name, start_date, end_date, is_active, is_locked, created_at)
        VALUES (?, ?, ?, ?, ?, 0, 0, ?)
      `,
        )
        .run(fyId, companyId, name, start_date, end_date, now);
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "financial_year",
        fyId,
        "CREATE",
        null,
        { name, start_date, end_date },
      );
      res
        .status(201)
        .json(successResponse({ id: fyId, name, start_date, end_date }));
    } catch (err) {
      next(err);
    }
  }

  async setActiveFinancialYear(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      this.coaRepo.conn.exec(
        "UPDATE financial_years SET is_active = 0 WHERE company_id = ?",
      );
      this.coaRepo.conn
        .prepare(
          "UPDATE financial_years SET is_active = 1 WHERE id = ? AND company_id = ?",
        )
        .run(req.params.id, companyId);
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "financial_year",
        req.params.id,
        "ACTIVATE",
        null,
        null,
      );
      res.json(successResponse({ message: "Financial year activated" }));
    } catch (err) {
      next(err);
    }
  }

  async lockFinancialYear(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      this.coaRepo.conn
        .prepare(
          "UPDATE financial_years SET is_locked = 1 WHERE id = ? AND company_id = ?",
        )
        .run(req.params.id, companyId);
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "financial_year",
        req.params.id,
        "LOCK",
        null,
        null,
      );
      res.json(successResponse({ message: "Financial year locked" }));
    } catch (err) {
      next(err);
    }
  }

  // ─── Opening Balance CRUD ───────────────────────────────────────────

  async listOpeningBalances(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const obs = this.obRepo.findAll(companyId, { status: req.query.status });
      res.json(successResponse({ items: obs, total: obs.length }));
    } catch (err) {
      next(err);
    }
  }

  async getOpeningBalance(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const ob = this.obRepo.findById(req.params.id, companyId);
      if (!ob) throw new NotFoundError("Opening balance", req.params.id);
      const lines = this.obRepo.findLines(req.params.id);
      res.json(successResponse({ ...ob, lines }));
    } catch (err) {
      next(err);
    }
  }

  async createOpeningBalance(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { financial_year_id, opening_date, reference_number } = req.body;
      if (!financial_year_id)
        throw new ValidationError("financial_year_id is required");
      // Validate financial year belongs to company
      const fy = this.coaRepo.conn.get(
        "SELECT * FROM financial_years WHERE id = ? AND company_id = ?",
        [financial_year_id, companyId],
      );
      if (!fy)
        throw new ValidationError(
          "Financial year not found or does not belong to this company",
        );
      const ref =
        reference_number || this.obRepo.nextReferenceNumber(companyId, fy.name);
      const obId = this.obRepo.create(
        companyId,
        financial_year_id,
        opening_date || fy.start_date,
        ref,
        req.user?.userId,
      );
      const ob = this.obRepo.findById(obId, companyId);
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "opening_balance",
        obId,
        "CREATE",
        null,
        ob,
      );
      res.status(201).json(successResponse(ob));
    } catch (err) {
      next(err);
    }
  }

  async addOpeningBalanceLine(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { account_id, debit = 0, credit = 0, description = "" } = req.body;
      const ob = this.obRepo.findById(req.params.id, companyId);
      if (!ob) throw new NotFoundError("Opening balance", req.params.id);
      if (ob.status === "POSTED" || ob.status === "FINALIZED") {
        throw new AppError(
          "Cannot modify lines on a " +
            ob.status.toLowerCase() +
            " opening balance",
          "INVALID_STATE",
          400,
        );
      }
      // Validate account
      const account = this.obRepo.getAccountDetails(account_id, companyId);
      if (!account)
        throw new ValidationError("Account not found or not accessible");
      if (account.is_group === 1 || account.is_group === true)
        throw new ValidationError(
          "Account groups cannot receive opening balances. Select a Ledger Account.",
        );
      if (
        account.allow_direct_posting !== 1 &&
        account.allow_direct_posting !== true
      )
        throw new ValidationError("Account does not allow direct posting");
      if (account.is_active === 0 || account.is_active === false)
        throw new ValidationError(
          "Inactive account cannot receive opening balance",
        );
      // Validate debit/credit: only one should be non-zero
      const d = parseFloat(debit) || 0;
      const c = parseFloat(credit) || 0;
      if (d > 0 && c > 0)
        throw new ValidationError(
          "Cannot enter both Debit and Credit on the same line. Use one or the other.",
        );
      if (d < 0) throw new ValidationError("Debit amount cannot be negative");
      if (c < 0) throw new ValidationError("Credit amount cannot be negative");
      // Validate nature compatibility
      const nature = account.debit_credit_nature || "DEBIT";
      if (d > 0 && nature === "CREDIT") {
        throw new ValidationError(
          `Account ${account.code} - ${account.name} has CREDIT nature. Enter credit instead of debit.`,
        );
      }
      if (c > 0 && nature === "DEBIT") {
        throw new ValidationError(
          `Account ${account.code} - ${account.name} has DEBIT nature. Enter debit instead of credit.`,
        );
      }
      this.obRepo.addLine(
        req.params.id,
        account_id,
        d,
        c,
        description,
        companyId,
      );
      // Recalculate totals
      this._recalcTotals(req.params.id);
      const updated = this.obRepo.findById(req.params.id, companyId);
      const lines = this.obRepo.findLines(req.params.id);
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "opening_balance",
        req.params.id,
        "ADD_LINE",
        null,
        { account_id, debit: d, credit: c },
      );
      res.json(successResponse({ ...updated, lines }));
    } catch (err) {
      next(err);
    }
  }

  async updateOpeningBalanceLine(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { debit = 0, credit = 0, description = "" } = req.body;
      const ob = this.obRepo.findById(req.params.obId, companyId);
      if (!ob) throw new NotFoundError("Opening balance", req.params.obId);
      if (ob.status === "POSTED" || ob.status === "FINALIZED") {
        throw new AppError(
          "Cannot modify lines on a " +
            ob.status.toLowerCase() +
            " opening balance",
          "INVALID_STATE",
          400,
        );
      }
      const d = parseFloat(debit) || 0;
      const c = parseFloat(credit) || 0;
      if (d > 0 && c > 0)
        throw new ValidationError("Cannot enter both Debit and Credit");
      if (d < 0 || c < 0)
        throw new ValidationError("Amounts cannot be negative");
      this.obRepo.updateLine(req.params.lineId, d, c, description);
      this._recalcTotals(req.params.obId);
      const updated = this.obRepo.findById(req.params.obId, companyId);
      const lines = this.obRepo.findLines(req.params.obId);
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "opening_balance",
        req.params.obId,
        "UPDATE_LINE",
        null,
        { line_id: req.params.lineId, debit: d, credit: c },
      );
      res.json(successResponse({ ...updated, lines }));
    } catch (err) {
      next(err);
    }
  }

  async deleteOpeningBalanceLine(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const ob = this.obRepo.findById(req.params.obId, companyId);
      if (!ob) throw new NotFoundError("Opening balance", req.params.obId);
      if (ob.status === "POSTED" || ob.status === "FINALIZED") {
        throw new AppError(
          "Cannot modify lines on a " +
            ob.status.toLowerCase() +
            " opening balance",
          "INVALID_STATE",
          400,
        );
      }
      this.obRepo.deleteLine(req.params.lineId);
      this._recalcTotals(req.params.obId);
      const updated = this.obRepo.findById(req.params.obId, companyId);
      const lines = this.obRepo.findLines(req.params.obId);
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "opening_balance",
        req.params.obId,
        "DELETE_LINE",
        null,
        { line_id: req.params.lineId },
      );
      res.json(successResponse({ ...updated, lines }));
    } catch (err) {
      next(err);
    }
  }

  _recalcTotals(obId) {
    const totals = this.coaRepo.conn.get(
      `SELECT COALESCE(SUM(debit), 0) as td, COALESCE(SUM(credit), 0) as tc
       FROM opening_balance_lines WHERE opening_balance_id = ?`,
      [obId],
    );
    this.obRepo.updateTotals(obId, totals.td, totals.tc);
  }

  // ─── Validation & Finalization ──────────────────────────────────────

  async validateOpeningBalance(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const ob = this.obRepo.findById(req.params.id, companyId);
      if (!ob) throw new NotFoundError("Opening balance", req.params.id);
      const lines = this.obRepo.findLines(req.params.id);
      if (lines.length === 0)
        throw new ValidationError("No opening balance lines to validate");
      const totalDebit = lines.reduce(
        (s, l) => s + (parseFloat(l.debit) || 0),
        0,
      );
      const totalCredit = lines.reduce(
        (s, l) => s + (parseFloat(l.credit) || 0),
        0,
      );
      const difference = totalDebit - totalCredit;
      const balanced = Math.abs(difference) < 0.01;
      this.obRepo.updateTotals(req.params.id, totalDebit, totalCredit);
      const updated = this.obRepo.findById(req.params.id, companyId);
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "opening_balance",
        req.params.id,
        "VALIDATE",
        null,
        {
          total_debit: totalDebit,
          total_credit: totalCredit,
          difference,
          balanced,
        },
      );
      res.json(
        successResponse({
          ...updated,
          lines,
          balanced,
          difference: Math.abs(difference),
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  async finalizeOpeningBalance(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const ob = this.obRepo.findById(req.params.id, companyId);
      if (!ob) throw new NotFoundError("Opening balance", req.params.id);
      if (ob.status === "POSTED")
        throw new AppError(
          "Opening balance is already posted",
          "ALREADY_POSTED",
          400,
        );
      const lines = this.obRepo.findLines(req.params.id);
      const totalDebit = lines.reduce(
        (s, l) => s + (parseFloat(l.debit) || 0),
        0,
      );
      const totalCredit = lines.reduce(
        (s, l) => s + (parseFloat(l.credit) || 0),
        0,
      );
      const difference = totalDebit - totalCredit;
      if (Math.abs(difference) > 0.01)
        throw new ValidationError(
          `Opening balances are not balanced. Total Debit: ${totalDebit}, Total Credit: ${totalCredit}, Difference: ${difference}`,
        );
      this.obRepo.updateTotals(req.params.id, totalDebit, totalCredit);
      this.obRepo.updateStatus(req.params.id, "FINALIZED", req.user?.userId);
      const updated = this.obRepo.findById(req.params.id, companyId);
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "opening_balance",
        req.params.id,
        "FINALIZE",
        null,
        { total_debit: totalDebit, total_credit: totalCredit },
      );
      res.json(successResponse({ ...updated, lines }));
    } catch (err) {
      next(err);
    }
  }

  async postOpeningBalance(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const ob = this.obRepo.findById(req.params.id, companyId);
      if (!ob) throw new NotFoundError("Opening balance", req.params.id);
      if (ob.status === "POSTED")
        throw new AppError(
          "Opening balance is already posted",
          "ALREADY_POSTED",
          400,
        );
      if (ob.status !== "FINALIZED")
        throw new AppError(
          "Opening balance must be finalized before posting",
          "INVALID_STATE",
          400,
        );
      const lines = this.obRepo.findLines(req.params.id);
      if (!lines || lines.length === 0)
        throw new AppError(
          "Opening balance has no lines. Add at least one line before posting.",
          "NO_LINES",
          400,
        );
      const totalDebit = lines.reduce(
        (s, l) => s + (parseFloat(l.debit) || 0),
        0,
      );
      const totalCredit = lines.reduce(
        (s, l) => s + (parseFloat(l.credit) || 0),
        0,
      );
      const difference = totalDebit - totalCredit;
      if (Math.abs(difference) > 0.01)
        throw new ValidationError("Cannot post unbalanced opening balances");
      // Enforce: Total Debit > 0 AND Total Credit > 0 (double-entry integrity)
      if (totalDebit <= 0 || totalCredit <= 0)
        throw new ValidationError(
          "Cannot post an opening balance with zero total Debit or Credit. At least one Debit and one Credit line are required."
        );
      // Check for duplicate posting
      const existing = this.obRepo.hasExistingJournalEntry(req.params.id);
      if (existing)
        throw new AppError(
          "Opening balance has already been posted with a journal entry",
          "ALREADY_POSTED",
          400,
        );

      // Validate FY is not locked
      const fy = this.coaRepo.conn.get(
        "SELECT * FROM financial_years WHERE id = ? AND company_id = ?",
        [ob.financial_year_id, companyId],
      );
      const obLock = evaluateFinancialYearLock({ fy, context: req });
      if (obLock.blocked) throw new AppError(obLock.reason, "FY_LOCKED", 400);

      const userId = req.user?.userId || "system";
      const tx = this.coaRepo.conn.transaction(() => {
        // Create voucher (without journal_entry_id — FK constraint requires JE to exist first)
        const voucherId = generateId("vch");
        const jeId = generateId("je");
        const now = new Date().toISOString();
        const currencyRow = this.coaRepo.conn.get(
          `SELECT value FROM system_metadata WHERE key = 'default_currency' LIMIT 1`,
        );
        const defaultCurrency = currencyRow?.value || "INR";
        this.coaRepo.conn
          .prepare(
            `
          INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, voucher_date,
            reference_number, description, status, created_by, created_at, updated_at, financial_year_id,
            journal_entry_id, total_amount, currency)
          VALUES (?, ?, ?, 'JOURNAL', ?, ?, 'Opening Balance Posted', 'POSTED', ?, ?, ?, ?, NULL, ?, ?)
        `,
          )
          .run(
            voucherId,
            companyId,
            "OB-" + Date.now(),
            ob.opening_date || fy.start_date,
            ob.reference_number,
            userId,
            now,
            now,
            ob.financial_year_id,
            totalDebit,
            defaultCurrency,
          );

        // Create journal entry (balanced by definition)
        this.coaRepo.conn
          .prepare(
            `
          INSERT INTO journal_entries (id, company_id, voucher_id, entry_number, entry_date,
            description, currency, exchange_rate, total_debit, total_credit, status, created_by, created_at, updated_at, posted_at, posted_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, ?, ?, 'POSTED', ?, ?, ?, ?, ?)
        `,
          )
          .run(
            jeId,
            companyId,
            voucherId,
            "JE-OB-" + Date.now(),
            ob.opening_date || fy.start_date,
            "Opening Balance for " + fy.name,
            defaultCurrency,
            totalDebit,
            totalCredit,
            userId,
            now,
            now,
            now,
            userId,
          );

        // Create journal entry lines for each opening balance line
        for (const line of lines) {
          this.coaRepo.conn
            .prepare(
              `
            INSERT INTO journal_entry_lines (id, company_id, journal_entry_id, account_id,
              debit_amount, credit_amount, description, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
            )
            .run(
              generateId("jl"),
              companyId,
              jeId,
              line.account_id,
              parseFloat(line.debit) || 0,
              parseFloat(line.credit) || 0,
              line.description || "Opening balance",
              now,
            );
        }

        // Link voucher to journal entry (update after JE creation due to FK constraint)
        this.coaRepo.conn
          .prepare("UPDATE vouchers SET journal_entry_id = ? WHERE id = ?")
          .run(jeId, voucherId);
        // Link opening balance to journal entry
        this.obRepo.setJournalEntry(req.params.id, jeId);
        this.obRepo.updateStatus(req.params.id, "POSTED", userId);
        logAudit(
          this.coaRepo.conn,
          companyId,
          userId,
          "opening_balance",
          req.params.id,
          "POST",
          null,
          { journal_entry_id: jeId },
        );
      });
      tx();
      const updated = this.obRepo.findById(req.params.id, companyId);
      const updatedLines = this.obRepo.findLines(req.params.id);
      res.json(successResponse({ ...updated, lines: updatedLines }));
    } catch (err) {
      next(err);
    }
  }

  async deleteOpeningBalance(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const ob = this.obRepo.findById(req.params.id, companyId);
      if (!ob) throw new NotFoundError("Opening balance", req.params.id);
      if (ob.status === "POSTED")
        throw new AppError(
          "Cannot delete a posted opening balance",
          "ALREADY_POSTED",
          400,
        );
      this.obRepo.deleteAllLines(req.params.id);
      this.obRepo.delete(req.params.id, companyId);
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "opening_balance",
        req.params.id,
        "DELETE",
        ob,
        null,
      );
      res.json(successResponse({ message: "Opening balance deleted" }));
    } catch (err) {
      next(err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 17/18: Tax Master & Company Tax Configuration
  // ═══════════════════════════════════════════════════════════════════

  /**
   * List all tax masters for the company.
   * GET /api/accounting/taxes/masters
   */
  async listTaxMasters(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const options = {
        isActive:
          req.query.active !== undefined
            ? req.query.active === "true"
            : undefined,
        query: req.query.q,
      };
      const result = this.taxService.listTaxMasters(companyId, options);
      res.json(successResponse({ items: result, total: result.length }));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Get a single tax master with its components.
   * GET /api/accounting/taxes/masters/:id
   */
  async getTaxMaster(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const master = this.taxService.getTaxMaster(req.params.id, companyId);
      res.json(successResponse(master));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Create a new tax master.
   * POST /api/accounting/taxes/masters
   */
  async createTaxMaster(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const data = { ...req.body, companyId };
      const result = this.taxService.createTaxMaster(data, req.user?.userId);
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "tax_master",
        result,
        "CREATE",
        null,
        result,
      );
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Update a tax master.
   * PUT /api/accounting/taxes/masters/:id
   */
  async updateTaxMaster(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.taxService.updateTaxMaster(
        req.params.id,
        req.body,
        companyId,
      );
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "tax_master",
        req.params.id,
        "UPDATE",
        null,
        result,
      );
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Toggle tax master active/inactive.
   * POST /api/accounting/taxes/masters/:id/toggle
   */
  async toggleTaxMaster(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const isActive =
        req.body.is_active !== undefined ? req.body.is_active : true;
      const result = this.taxService.toggleTaxStatus(
        req.params.id,
        isActive,
        companyId,
      );
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "tax_master",
        req.params.id,
        "TOGGLE",
        null,
        { is_active: isActive },
      );
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Get company tax configuration.
   * GET /api/accounting/taxes/config
   */
  async getCompanyTaxConfig(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const config = this.taxService.getCompanyTaxConfig(companyId);
      res.json(
        successResponse(config || { company_id: companyId, gst_enabled: 0 }),
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * Set company tax configuration.
   * PUT /api/accounting/taxes/config
   */
  async setCompanyTaxConfig(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const config = this.taxService.setCompanyTaxConfig(
        req.body,
        companyId,
        req.user?.userId,
      );
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "company_tax_config",
        companyId,
        "UPDATE",
        null,
        config,
      );
      res.json(successResponse(config));
    } catch (err) {
      next(err);
    }
  }

  /**
   * List tax account mappings.
   * GET /api/accounting/taxes/mappings
   */
  async listTaxAccountMappings(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const mappings = this.taxService.listTaxAccountMappings(companyId);
      res.json(successResponse({ items: mappings, total: mappings.length }));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Create/update a tax account mapping.
   * POST /api/accounting/taxes/mappings
   */
  async upsertTaxAccountMapping(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const result = this.taxService.upsertTaxAccountMapping(
        { ...req.body, companyId },
        companyId,
      );
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "tax_mapping",
        null,
        "UPSERT",
        null,
        result,
      );
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 18: GST / Tax Reports & Tax Reconciliation
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Sales Tax Summary — output GST from posted sales transactions.
   * Derives data from transaction_tax_details joined to posted vouchers/JEs.
   * GET /api/accounting/taxes/reports/sales-summary
   */
  async salesTaxSummary(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const from = req.query.from || null;
      const to = req.query.to || null;
      const taxTypeCode = req.query.tax_type || null;
      let dateClause = "";
      const params = [companyId];
      if (from) {
        dateClause += " AND je.entry_date >= ?";
        params.push(from);
      }
      if (to) {
        dateClause += " AND je.entry_date <= ?";
        params.push(to);
      }
      let taxFilter = "";
      if (taxTypeCode) {
        taxFilter = " AND ttd.tax_type = ?";
        params.push(taxTypeCode);
      }

      const rows = this.journalRepo.conn.all(
        `
        SELECT
          ttd.tax_type, ttd.tax_master_id, tm.code as tax_master_code, tm.name as tax_master_name,
          ttd.place_of_supply, ttd.is_interstate,
          COALESCE(SUM(ttd.taxable_amount), 0) as taxable_value,
          COALESCE(SUM(ttd.cgst_amount), 0) as cgst_amount,
          COALESCE(SUM(ttd.sgst_amount), 0) as sgst_amount,
          COALESCE(SUM(ttd.igst_amount), 0) as igst_amount,
          COALESCE(SUM(ttd.cess_amount), 0) as cess_amount,
          COALESCE(SUM(ttd.total_tax), 0) as total_tax,
          COALESCE(SUM(ttd.grand_total), 0) as gross_value,
          COUNT(*) as transaction_count
        FROM transaction_tax_details ttd
        JOIN vouchers v ON v.id = ttd.voucher_id
        JOIN journal_entries je ON je.id = ttd.journal_entry_id
        LEFT JOIN tax_masters tm ON tm.id = ttd.tax_master_id
        WHERE ttd.company_id = ? AND v.status = 'POSTED' AND je.status = 'POSTED'${dateClause}${taxFilter}
          AND v.voucher_type IN ('SALES', 'CREDIT_NOTE')
        GROUP BY ttd.tax_type, ttd.tax_master_id, ttd.place_of_supply, ttd.is_interstate
        ORDER BY ttd.tax_type, ttd.is_interstate
      `,
        params,
      );

      // Aggregate totals
      const totals = {
        taxable_value: 0,
        cgst_amount: 0,
        sgst_amount: 0,
        igst_amount: 0,
        cess_amount: 0,
        total_tax: 0,
        gross_value: 0,
        transaction_count: 0,
      };
      rows.forEach((r) => {
        totals.taxable_value += parseFloat(r.taxable_value);
        totals.cgst_amount += parseFloat(r.cgst_amount);
        totals.sgst_amount += parseFloat(r.sgst_amount);
        totals.igst_amount += parseFloat(r.igst_amount);
        totals.cess_amount += parseFloat(r.cess_amount);
        totals.total_tax += parseFloat(r.total_tax);
        totals.gross_value += parseFloat(r.gross_value);
        totals.transaction_count += parseInt(r.transaction_count);
      });

      res.json(
        successResponse({
          items: rows,
          totals,
          transaction_count: totals.transaction_count,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * Purchase Tax Summary — input GST from posted purchase transactions.
   * GET /api/accounting/taxes/reports/purchase-summary
   */
  async purchaseTaxSummary(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const from = req.query.from || null;
      const to = req.query.to || null;
      const taxTypeCode = req.query.tax_type || null;
      let dateClause = "";
      const params = [companyId];
      if (from) {
        dateClause += " AND je.entry_date >= ?";
        params.push(from);
      }
      if (to) {
        dateClause += " AND je.entry_date <= ?";
        params.push(to);
      }
      let taxFilter = "";
      if (taxTypeCode) {
        taxFilter = " AND ttd.tax_type = ?";
        params.push(taxTypeCode);
      }

      const rows = this.journalRepo.conn.all(
        `
        SELECT
          ttd.tax_type, ttd.tax_master_id, tm.code as tax_master_code, tm.name as tax_master_name,
          ttd.place_of_supply, ttd.is_interstate,
          COALESCE(SUM(ttd.taxable_amount), 0) as taxable_value,
          COALESCE(SUM(ttd.cgst_amount), 0) as cgst_amount,
          COALESCE(SUM(ttd.sgst_amount), 0) as sgst_amount,
          COALESCE(SUM(ttd.igst_amount), 0) as igst_amount,
          COALESCE(SUM(ttd.cess_amount), 0) as cess_amount,
          COALESCE(SUM(ttd.total_tax), 0) as total_tax,
          COALESCE(SUM(ttd.grand_total), 0) as gross_value,
          COUNT(*) as transaction_count
        FROM transaction_tax_details ttd
        JOIN vouchers v ON v.id = ttd.voucher_id
        JOIN journal_entries je ON je.id = ttd.journal_entry_id
        LEFT JOIN tax_masters tm ON tm.id = ttd.tax_master_id
        WHERE ttd.company_id = ? AND v.status = 'POSTED' AND je.status = 'POSTED'${dateClause}${taxFilter}
          AND v.voucher_type IN ('PURCHASE', 'DEBIT_NOTE', 'EXPENSE')
        GROUP BY ttd.tax_type, ttd.tax_master_id, ttd.place_of_supply, ttd.is_interstate
        ORDER BY ttd.tax_type, ttd.is_interstate
      `,
        params,
      );

      const totals = {
        taxable_value: 0,
        cgst_amount: 0,
        sgst_amount: 0,
        igst_amount: 0,
        cess_amount: 0,
        total_tax: 0,
        gross_value: 0,
        transaction_count: 0,
      };
      rows.forEach((r) => {
        totals.taxable_value += parseFloat(r.taxable_value);
        totals.cgst_amount += parseFloat(r.cgst_amount);
        totals.sgst_amount += parseFloat(r.sgst_amount);
        totals.igst_amount += parseFloat(r.igst_amount);
        totals.cess_amount += parseFloat(r.cess_amount);
        totals.total_tax += parseFloat(r.total_tax);
        totals.gross_value += parseFloat(r.gross_value);
        totals.transaction_count += parseInt(r.transaction_count);
      });

      res.json(
        successResponse({
          items: rows,
          totals,
          transaction_count: totals.transaction_count,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * Tax Reconciliation — compares output/input GST from transactions vs ledger balances.
   * Output GST from transactions vs Output GST ledger balance.
   * Input GST from transactions vs Input GST ledger balance.
   * GET /api/accounting/taxes/reports/reconciliation
   */
  async taxReconciliation(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const from = req.query.from || null;
      const to = req.query.to || null;
      const conn = this.journalRepo.conn;
      let dateClause = "";
      const params = [companyId];
      if (from) {
        dateClause += " AND je.entry_date >= ?";
        params.push(from);
      }
      if (to) {
        dateClause += " AND je.entry_date <= ?";
        params.push(to);
      }

      // Output GST from transactions (sales)
      const outputFromTxns = conn.get(
        `
        SELECT
          COALESCE(SUM(cgst_amount), 0) as output_cgst,
          COALESCE(SUM(sgst_amount), 0) as output_sgst,
          COALESCE(SUM(igst_amount), 0) as output_igst,
          COALESCE(SUM(cess_amount), 0) as output_cess,
          COALESCE(SUM(total_tax), 0) as output_total
        FROM transaction_tax_details ttd
        JOIN vouchers v ON v.id = ttd.voucher_id
        JOIN journal_entries je ON je.id = ttd.journal_entry_id
        WHERE ttd.company_id = ? AND v.status = 'POSTED' AND je.status = 'POSTED'${dateClause}
          AND v.voucher_type IN ('SALES', 'CREDIT_NOTE')
      `,
        params,
      );

      // Input GST from transactions (purchases/expenses) — reverse for credit notes
      const inputFromTxns = conn.get(
        `
        SELECT
          COALESCE(SUM(cgst_amount), 0) as input_cgst,
          COALESCE(SUM(sgst_amount), 0) as input_sgst,
          COALESCE(SUM(igst_amount), 0) as input_igst,
          COALESCE(SUM(cess_amount), 0) as input_cess,
          COALESCE(SUM(total_tax), 0) as input_total
        FROM transaction_tax_details ttd
        JOIN vouchers v ON v.id = ttd.voucher_id
        JOIN journal_entries je ON je.id = ttd.journal_entry_id
        WHERE ttd.company_id = ? AND v.status = 'POSTED' AND je.status = 'POSTED'${dateClause}
          AND v.voucher_type IN ('PURCHASE', 'DEBIT_NOTE', 'EXPENSE')
      `,
        params,
      );

      // Output GST ledger balances
      const outputLedgers = conn.all(
        `
        SELECT a.id as account_id, a.name, a.code,
          COALESCE(SUM(CASE WHEN a.debit_credit_nature = 'CREDIT' THEN jel.credit_amount ELSE 0 END), 0) -
          COALESCE(SUM(CASE WHEN a.debit_credit_nature = 'CREDIT' THEN jel.debit_amount ELSE 0 END), 0) as balance
        FROM accounts a
        JOIN journal_entry_lines jel ON jel.account_id = a.id
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE a.company_id = ? AND a.is_active = 1
          AND a.id IN (SELECT tam.ledger_account_id FROM tax_account_mappings tam WHERE tam.company_id = ? AND tam.tax_scope = 'OUTPUT')
          AND je.status = 'POSTED'${dateClause}
        GROUP BY a.id, a.name, a.code
      `,
        [companyId, companyId, ...(from ? [from] : []), ...(to ? [to] : [])],
      );

      // Input GST ledger balances
      const inputLedgers = conn.all(
        `
        SELECT a.id as account_id, a.name, a.code,
          COALESCE(SUM(CASE WHEN a.debit_credit_nature = 'DEBIT' THEN jel.debit_amount ELSE 0 END), 0) -
          COALESCE(SUM(CASE WHEN a.debit_credit_nature = 'DEBIT' THEN jel.credit_amount ELSE 0 END), 0) as balance
        FROM accounts a
        JOIN journal_entry_lines jel ON jel.account_id = a.id
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE a.company_id = ? AND a.is_active = 1
          AND a.id IN (SELECT tam.ledger_account_id FROM tax_account_mappings tam WHERE tam.company_id = ? AND tam.tax_scope = 'INPUT')
          AND je.status = 'POSTED'${dateClause}
        GROUP BY a.id, a.name, a.code
      `,
        [companyId, companyId, ...(from ? [from] : []), ...(to ? [to] : [])],
      );

      const outputLedgerTotal = outputLedgers.reduce(
        (s, l) => s + Math.abs(parseFloat(l.balance) || 0),
        0,
      );
      const inputLedgerTotal = inputLedgers.reduce(
        (s, l) => s + Math.abs(parseFloat(l.balance) || 0),
        0,
      );
      const outputTxnTotal =
        parseFloat(outputFromTxns?.output_igst || 0) +
        parseFloat(outputFromTxns?.output_cgst || 0) +
        parseFloat(outputFromTxns?.output_sgst || 0);
      const inputTxnTotal =
        parseFloat(inputFromTxns?.input_igst || 0) +
        parseFloat(inputFromTxns?.input_cgst || 0) +
        parseFloat(inputFromTxns?.input_sgst || 0);

      res.json(
        successResponse({
          output: {
            from_transactions: {
              cgst: parseFloat(outputFromTxns?.output_cgst || 0),
              sgst: parseFloat(outputFromTxns?.output_sgst || 0),
              igst: parseFloat(outputFromTxns?.output_igst || 0),
              cess: parseFloat(outputFromTxns?.output_cess || 0),
              total: parseFloat(outputFromTxns?.output_total || 0),
            },
            from_ledger: {
              ledger_total: outputLedgerTotal,
              ledgers: outputLedgers,
            },
            discrepancy: parseFloat(
              (outputTxnTotal - outputLedgerTotal).toFixed(2),
            ),
            reconciled: Math.abs(outputTxnTotal - outputLedgerTotal) < 0.01,
          },
          input: {
            from_transactions: {
              cgst: parseFloat(inputFromTxns?.input_cgst || 0),
              sgst: parseFloat(inputFromTxns?.input_sgst || 0),
              igst: parseFloat(inputFromTxns?.input_igst || 0),
              cess: parseFloat(inputFromTxns?.input_cess || 0),
              total: parseFloat(inputFromTxns?.input_total || 0),
            },
            from_ledger: {
              ledger_total: inputLedgerTotal,
              ledgers: inputLedgers,
            },
            discrepancy: parseFloat(
              (inputTxnTotal - inputLedgerTotal).toFixed(2),
            ),
            reconciled: Math.abs(inputTxnTotal - inputLedgerTotal) < 0.01,
          },
          net_gst_payable: parseFloat(
            (outputTxnTotal - inputTxnTotal).toFixed(2),
          ),
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * Detailed Tax Transaction List — all taxed transactions with tax breakdowns.
   * GET /api/accounting/taxes/transactions
   */
  async taxTransactions(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const from = req.query.from || null;
      const to = req.query.to || null;
      const voucherType = req.query.voucher_type || null;
      const params = [companyId];
      let dateClause = "";
      if (from) {
        dateClause += " AND je.entry_date >= ?";
        params.push(from);
      }
      if (to) {
        dateClause += " AND je.entry_date <= ?";
        params.push(to);
      }
      let typeFilter = "";
      if (voucherType) {
        typeFilter = " AND v.voucher_type = ?";
        params.push(voucherType);
      }

      const rows = this.journalRepo.conn.all(
        `
        SELECT
          v.id as voucher_id, v.voucher_number, v.voucher_type, v.voucher_date,
          v.reference_number, je.entry_date,
          c.id as contact_id, c.first_name, c.last_name, c.email,
          ttd.taxable_amount, ttd.tax_type, ttd.tax_rate,
          ttd.cgst_rate, ttd.sgst_rate, ttd.igst_rate, ttd.cess_rate,
          ttd.cgst_amount, ttd.sgst_amount, ttd.igst_amount, ttd.cess_amount,
          ttd.total_tax, ttd.grand_total, ttd.place_of_supply, tm.code as tax_master_code
        FROM transaction_tax_details ttd
        JOIN vouchers v ON v.id = ttd.voucher_id
        JOIN journal_entries je ON je.id = ttd.journal_entry_id
        LEFT JOIN tax_masters tm ON tm.id = ttd.tax_master_id
        LEFT JOIN contacts c ON c.id = v.contact_id
        WHERE ttd.company_id = ? AND v.status = 'POSTED' AND je.status = 'POSTED'${dateClause}${typeFilter}
        ORDER BY je.entry_date DESC
      `,
        params,
      );

      const totals = {
        taxable_value: 0,
        cgst_amount: 0,
        sgst_amount: 0,
        igst_amount: 0,
        cess_amount: 0,
        total_tax: 0,
        gross_value: 0,
      };
      rows.forEach((r) => {
        totals.taxable_value += parseFloat(r.taxable_amount || 0);
        totals.cgst_amount += parseFloat(r.cgst_amount || 0);
        totals.sgst_amount += parseFloat(r.sgst_amount || 0);
        totals.igst_amount += parseFloat(r.igst_amount || 0);
        totals.cess_amount += parseFloat(r.cess_amount || 0);
        totals.total_tax += parseFloat(r.total_tax || 0);
        totals.gross_value += parseFloat(r.grand_total || 0);
      });

      res.json(successResponse({ items: rows, totals, count: rows.length }));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Tax Summary Report — aggregated tax summary across all taxed transactions.
   * GET /api/accounting/taxes/reports/summary
   */
  async taxSummaryReport(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const from = req.query.from || null;
      const to = req.query.to || null;
      const conn = this.journalRepo.conn;
      let dateClause = "";
      const params = [companyId];
      if (from) {
        dateClause += " AND je.entry_date >= ?";
        params.push(from);
      }
      if (to) {
        dateClause += " AND je.entry_date <= ?";
        params.push(to);
      }

      const salesTax = conn.get(
        `
        SELECT
          COALESCE(SUM(ttd.cgst_amount), 0) as cgst,
          COALESCE(SUM(ttd.sgst_amount), 0) as sgst,
          COALESCE(SUM(ttd.igst_amount), 0) as igst,
          COALESCE(SUM(ttd.cess_amount), 0) as cess,
          COALESCE(SUM(ttd.total_tax), 0) as total_tax,
          COALESCE(SUM(ttd.taxable_amount), 0) as taxable_amount,
          COALESCE(SUM(ttd.grand_total), 0) as gross_amount
        FROM transaction_tax_details ttd
        JOIN vouchers v ON v.id = ttd.voucher_id
        JOIN journal_entries je ON je.id = ttd.journal_entry_id
        WHERE ttd.company_id = ? AND v.status = 'POSTED' AND je.status = 'POSTED'${dateClause}
          AND v.voucher_type IN ('SALES', 'CREDIT_NOTE')
      `,
        params,
      );

      const purchaseTax = conn.get(
        `
        SELECT
          COALESCE(SUM(ttd.cgst_amount), 0) as cgst,
          COALESCE(SUM(ttd.sgst_amount), 0) as sgst,
          COALESCE(SUM(ttd.igst_amount), 0) as igst,
          COALESCE(SUM(ttd.cess_amount), 0) as cess,
          COALESCE(SUM(ttd.total_tax), 0) as total_tax,
          COALESCE(SUM(ttd.taxable_amount), 0) as taxable_amount,
          COALESCE(SUM(ttd.grand_total), 0) as gross_amount
        FROM transaction_tax_details ttd
        JOIN vouchers v ON v.id = ttd.voucher_id
        JOIN journal_entries je ON je.id = ttd.journal_entry_id
        WHERE ttd.company_id = ? AND v.status = 'POSTED' AND je.status = 'POSTED'${dateClause}
          AND v.voucher_type IN ('PURCHASE', 'DEBIT_NOTE', 'EXPENSE')
      `,
        params,
      );

      const netGstPayable =
        parseFloat(salesTax?.igst || 0) +
        parseFloat(salesTax?.cgst || 0) +
        parseFloat(salesTax?.sgst || 0) -
        (parseFloat(purchaseTax?.igst || 0) +
          parseFloat(purchaseTax?.cgst || 0) +
          parseFloat(purchaseTax?.sgst || 0));

      res.json(
        successResponse({
          sales_tax: {
            taxable_amount: parseFloat(salesTax?.taxable_amount || 0),
            cgst: parseFloat(salesTax?.cgst || 0),
            sgst: parseFloat(salesTax?.sgst || 0),
            igst: parseFloat(salesTax?.igst || 0),
            cess: parseFloat(salesTax?.cess || 0),
            total_tax: parseFloat(salesTax?.total_tax || 0),
            gross_amount: parseFloat(salesTax?.gross_amount || 0),
          },
          purchase_tax: {
            taxable_amount: parseFloat(purchaseTax?.taxable_amount || 0),
            cgst: parseFloat(purchaseTax?.cgst || 0),
            sgst: parseFloat(purchaseTax?.sgst || 0),
            igst: parseFloat(purchaseTax?.igst || 0),
            cess: parseFloat(purchaseTax?.cess || 0),
            total_tax: parseFloat(purchaseTax?.total_tax || 0),
            gross_amount: parseFloat(purchaseTax?.gross_amount || 0),
          },
          net_gst_payable: parseFloat(netGstPayable.toFixed(2)),
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * Output/Input GST Reconciliation — compares transaction-level tax with ledger balances.
   * GET /api/accounting/taxes/reports/output-input-reconciliation
   */
  async outputInputGSTReconciliation(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const from = req.query.from || null;
      const to = req.query.to || null;
      const conn = this.journalRepo.conn;
      let dateClause = "";
      const params = [companyId];
      if (from) {
        dateClause += " AND je.entry_date >= ?";
        params.push(from);
      }
      if (to) {
        dateClause += " AND je.entry_date <= ?";
        params.push(to);
      }

      // Output GST from transactions (sales)
      const outputTxns = conn.get(
        `
        SELECT
          COALESCE(SUM(cgst_amount), 0) as cgst,
          COALESCE(SUM(sgst_amount), 0) as sgst,
          COALESCE(SUM(igst_amount), 0) as igst,
          COALESCE(SUM(cess_amount), 0) as cess,
          COALESCE(SUM(total_tax), 0) as total
        FROM transaction_tax_details ttd
        JOIN vouchers v ON v.id = ttd.voucher_id
        JOIN journal_entries je ON je.id = ttd.journal_entry_id
        WHERE ttd.company_id = ? AND v.status = 'POSTED' AND je.status = 'POSTED'${dateClause}
          AND v.voucher_type IN ('SALES', 'CREDIT_NOTE')
      `,
        params,
      );

      // Input GST from transactions (purchases/expenses)
      const inputTxns = conn.get(
        `
        SELECT
          COALESCE(SUM(cgst_amount), 0) as cgst,
          COALESCE(SUM(sgst_amount), 0) as sgst,
          COALESCE(SUM(igst_amount), 0) as igst,
          COALESCE(SUM(cess_amount), 0) as cess,
          COALESCE(SUM(total_tax), 0) as total
        FROM transaction_tax_details ttd
        JOIN vouchers v ON v.id = ttd.voucher_id
        JOIN journal_entries je ON je.id = ttd.journal_entry_id
        WHERE ttd.company_id = ? AND v.status = 'POSTED' AND je.status = 'POSTED'${dateClause}
          AND v.voucher_type IN ('PURCHASE', 'DEBIT_NOTE', 'EXPENSE')
      `,
        params,
      );

      // Output GST ledger balances
      const outputLedgerAccounts = conn.all(
        `
        SELECT tam.ledger_account_id, a.name, a.code,
          COALESCE(SUM(jel.credit_amount), 0) - COALESCE(SUM(jel.debit_amount), 0) as balance
        FROM tax_account_mappings tam
        JOIN accounts a ON a.id = tam.ledger_account_id
        LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
        JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'POSTED'
          AND je.company_id = ? ${from ? "AND je.entry_date >= ?" : ""} ${to ? "AND je.entry_date <= ?" : ""}
        WHERE tam.company_id = ? AND tam.tax_scope = 'OUTPUT'
        GROUP BY tam.ledger_account_id, a.name, a.code
      `,
        [companyId, ...(from ? [from] : []), ...(to ? [to] : []), companyId],
      );

      // Input GST ledger balances
      const inputLedgerAccounts = conn.all(
        `
        SELECT tam.ledger_account_id, a.name, a.code,
          COALESCE(SUM(jel.debit_amount), 0) - COALESCE(SUM(jel.credit_amount), 0) as balance
        FROM tax_account_mappings tam
        JOIN accounts a ON a.id = tam.ledger_account_id
        LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
        JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'POSTED'
          AND je.company_id = ? ${from ? "AND je.entry_date >= ?" : ""} ${to ? "AND je.entry_date <= ?" : ""}
        WHERE tam.company_id = ? AND tam.tax_scope = 'INPUT'
        GROUP BY tam.ledger_account_id, a.name, a.code
      `,
        [companyId, ...(from ? [from] : []), ...(to ? [to] : []), companyId],
      );

      const outputLedgerTotal = outputLedgerAccounts.reduce(
        (s, a) => s + Math.abs(parseFloat(a.balance) || 0),
        0,
      );
      const inputLedgerTotal = inputLedgerAccounts.reduce(
        (s, a) => s + Math.abs(parseFloat(a.balance) || 0),
        0,
      );

      const outputTxnTotal =
        parseFloat(outputTxns?.cgst || 0) +
        parseFloat(outputTxns?.sgst || 0) +
        parseFloat(outputTxns?.igst || 0) +
        parseFloat(outputTxns?.cess || 0);
      const inputTxnTotal =
        parseFloat(inputTxns?.cgst || 0) +
        parseFloat(inputTxns?.sgst || 0) +
        parseFloat(inputTxns?.igst || 0) +
        parseFloat(inputTxns?.cess || 0);

      res.json(
        successResponse({
          output_gst: {
            from_transactions: {
              cgst: parseFloat(outputTxns?.cgst || 0),
              sgst: parseFloat(outputTxns?.sgst || 0),
              igst: parseFloat(outputTxns?.igst || 0),
              cess: parseFloat(outputTxns?.cess || 0),
              total: parseFloat(outputTxns?.total || 0),
            },
            from_ledger: {
              total: outputLedgerTotal,
              accounts: outputLedgerAccounts,
            },
            discrepancy: parseFloat(
              (outputTxnTotal - outputLedgerTotal).toFixed(2),
            ),
          },
          input_gst: {
            from_transactions: {
              cgst: parseFloat(inputTxns?.cgst || 0),
              sgst: parseFloat(inputTxns?.sgst || 0),
              igst: parseFloat(inputTxns?.igst || 0),
              cess: parseFloat(inputTxns?.cess || 0),
              total: parseFloat(inputTxns?.total || 0),
            },
            from_ledger: {
              total: inputLedgerTotal,
              accounts: inputLedgerAccounts,
            },
            discrepancy: parseFloat(
              (inputTxnTotal - inputLedgerTotal).toFixed(2),
            ),
          },
          net_gst_payable: parseFloat(
            (outputTxnTotal - inputTxnTotal).toFixed(2),
          ),
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * Tax Reconciliation — compares output/input GST from transactions vs ledger balances.
   * GET /api/accounting/taxes/reconciliation?tax_type=...
   */
  async getTaxReconciliation(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const taxId = req.params.taxId || null;
      let filter = "";
      const params = [companyId];
      if (taxId) {
        filter = " AND ttd.tax_master_id = ?";
        params.push(taxId);
      }

      const outputTxns = this.journalRepo.conn.get(
        `
        SELECT COALESCE(SUM(cgst_amount), 0) as cgst, COALESCE(SUM(sgst_amount), 0) as sgst,
          COALESCE(SUM(igst_amount), 0) as igst, COALESCE(SUM(cess_amount), 0) as cess,
          COALESCE(SUM(total_tax), 0) as total
        FROM transaction_tax_details ttd
        JOIN vouchers v ON v.id = ttd.voucher_id
        JOIN journal_entries je ON je.id = ttd.journal_entry_id
        WHERE ttd.company_id = ? AND v.status = 'POSTED' AND je.status = 'POSTED' AND v.voucher_type IN ('SALES', 'CREDIT_NOTE')${filter}
      `,
        params,
      );

      const inputTxns = this.journalRepo.conn.get(
        `
        SELECT COALESCE(SUM(cgst_amount), 0) as cgst, COALESCE(SUM(sgst_amount), 0) as sgst,
          COALESCE(SUM(igst_amount), 0) as igst, COALESCE(SUM(cess_amount), 0) as cess,
          COALESCE(SUM(total_tax), 0) as total
        FROM transaction_tax_details ttd
        JOIN vouchers v ON v.id = ttd.voucher_id
        JOIN journal_entries je ON je.id = ttd.journal_entry_id
        WHERE ttd.company_id = ? AND v.status = 'POSTED' AND je.status = 'POSTED' AND v.voucher_type IN ('PURCHASE', 'DEBIT_NOTE', 'EXPENSE')${filter}
      `,
        params,
      );

      const outputLedgerTotal =
        this.journalRepo.conn.get(
          `
        SELECT COALESCE(SUM(jel.credit_amount), 0) - COALESCE(SUM(jel.debit_amount), 0) as bal
        FROM tax_account_mappings tam
        JOIN accounts a ON a.id = tam.ledger_account_id
        LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
        JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'POSTED'
        WHERE tam.company_id = ? AND tam.tax_scope = 'OUTPUT'
      `,
          [companyId],
        ).bal || 0;

      const inputLedgerTotal =
        this.journalRepo.conn.get(
          `
        SELECT COALESCE(SUM(jel.debit_amount), 0) - COALESCE(SUM(jel.credit_amount), 0) as bal
        FROM tax_account_mappings tam
        JOIN accounts a ON a.id = tam.ledger_account_id
        LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
        JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'POSTED'
        WHERE tam.company_id = ? AND tam.tax_scope = 'INPUT'
      `,
          [companyId],
        ).bal || 0;

      const outputTxn =
        parseFloat(outputTxns?.cgst || 0) +
        parseFloat(outputTxns?.sgst || 0) +
        parseFloat(outputTxns?.igst || 0) +
        parseFloat(outputTxns?.cess || 0);
      const inputTxn =
        parseFloat(inputTxns?.cgst || 0) +
        parseFloat(inputTxns?.sgst || 0) +
        parseFloat(inputTxns?.igst || 0) +
        parseFloat(inputTxns?.cess || 0);

      res.json(
        successResponse({
          output_gst: {
            from_transactions: outputTxn,
            from_ledger: parseFloat(outputLedgerTotal),
            discrepancy: parseFloat(
              (outputTxn - parseFloat(outputLedgerTotal)).toFixed(2),
            ),
            reconciled:
              Math.abs(outputTxn - parseFloat(outputLedgerTotal)) < 0.01,
          },
          input_gst: {
            from_transactions: inputTxn,
            from_ledger: parseFloat(inputLedgerTotal),
            discrepancy: parseFloat(
              (inputTxn - parseFloat(inputLedgerTotal)).toFixed(2),
            ),
            reconciled:
              Math.abs(inputTxn - parseFloat(inputLedgerTotal)) < 0.01,
          },
          net_gst_payable: parseFloat((outputTxn - inputTxn).toFixed(2)),
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * Delete a tax account mapping.
   * DELETE /api/accounting/taxes/account-mappings/:id
   */
  async deleteTaxAccountMapping(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const mapping = this.journalRepo.conn.get(
        "SELECT * FROM tax_account_mappings WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!mapping) throw new NotFoundError("TaxAccountMapping", req.params.id);
      this.journalRepo.conn
        .prepare(
          "DELETE FROM tax_account_mappings WHERE id = ? AND company_id = ?",
        )
        .run(req.params.id, companyId);
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "tax_account_mapping",
        req.params.id,
        "DELETE",
        mapping,
        null,
      );
      res.json(successResponse({ message: "Tax account mapping deleted" }));
    } catch (err) {
      next(err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 19: Inventory Accounting & Stock Valuation
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Get inventory item stock position for a product.
   * GET /api/accounting/inventory/items/:productId
   */
  async getInventoryItem(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const requestedId = req.params.productId;

      // `inventory_items` is keyed on stock_items.id (item_id) since migration
      // 082 re-keyed it. The route parameter is historically named productId, so
      // accept EITHER a product id or a stock-item id and resolve it to the
      // canonical item_id via stock_items.product_id.
      const stockItem = this.journalRepo.conn.get(
        `SELECT si.id AS item_id, si.sku, si.name AS item_name,
                p.id AS product_id, p.name AS product_name
           FROM stock_items si
           LEFT JOIN products p ON p.id = si.product_id AND p.company_id = si.company_id
          WHERE si.company_id = ? AND si.is_active = 1
            AND (si.id = ? OR si.product_id = ?)
          LIMIT 1`,
        [companyId, requestedId, requestedId],
      );

      const item = stockItem
        ? this.journalRepo.conn.get(
          "SELECT * FROM inventory_items WHERE company_id = ? AND item_id = ?",
          [companyId, stockItem.item_id],
        )
        : null;

      if (!item) {
        // No valuation row yet: report a zero-balance position, which is the
        // correct answer for an item that has never had stock posted.
        if (!stockItem) throw new NotFoundError("Stock item or product", requestedId);
        return res.json(
          successResponse({
            item_id: stockItem.item_id,
            stock_item_sku: stockItem.sku,
            product_id: stockItem.product_id,
            product_name: stockItem.product_name,
            quantity: 0,
            unit_cost: 0,
            total_value: 0,
            valuation_method: "WEIGHTED_AVERAGE",
          }),
        );
      }

      res.json(
        successResponse({
          ...item,
          item_id: stockItem.item_id,
          stock_item_sku: stockItem.sku,
          product_id: stockItem.product_id,
          product_name: stockItem.product_name,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * List all inventory items with stock positions.
   * GET /api/accounting/inventory/items
   */
  async listInventoryItems(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const rows = this.journalRepo.conn.all(
        `
        SELECT ii.*, si.sku as stock_item_sku,
               p.id as product_id, p.name as product_name, p.price, p.cost
        FROM inventory_items ii
        JOIN stock_items si ON si.id = ii.item_id AND si.company_id = ii.company_id
        LEFT JOIN products p ON p.id = si.product_id AND p.company_id = ii.company_id
        WHERE ii.company_id = ?
        ORDER BY COALESCE(p.name, si.name)
      `,
        [companyId],
      );
      res.json(successResponse({ items: rows, total: rows.length }));
    } catch (err) {
      next(err);
    }
  }

  /**
   * List inventory movements (valuation audit trail).
   * GET /api/accounting/inventory/movements
   *
   * Source is `valuation_movements`, the canonical moving-weighted-average
   * valuation log written by InventoryEngine.applyValuation().
   *
   * This previously read `inventory_movements`, a retired table that has held
   * 0 rows since the single-writer repair: the endpoint always answered 200
   * with an empty list, so the UI looked "fine" while exposing no data. The
   * retired table's `product_id` has no counterpart here — valuation movements
   * are keyed on `stock_items.id`, so a product filter resolves through
   * `stock_items` rather than joining on a product surrogate key.
   */
  async listInventoryMovements(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const productId = req.query.product_id || null;
      const movementType = req.query.movement_type || null;
      const params = [companyId];
      let filters = "WHERE vm.company_id = ?";
      if (productId) {
        filters += " AND si.product_id = ?";
        params.push(productId);
      }
      if (movementType) {
        filters += " AND vm.source_document_type = ?";
        params.push(movementType);
      }
      const rows = this.journalRepo.conn.all(
        `
        SELECT vm.*, p.name as product_name, vm.source_document_type as movement_type
        FROM valuation_movements vm
        JOIN stock_items si ON si.id = vm.item_id AND si.company_id = vm.company_id
        JOIN products p ON p.id = si.product_id
        ${filters}
        ORDER BY vm.created_at DESC
        LIMIT ? OFFSET ?
      `,
        [
          ...params,
          parseInt(req.query.limit) || 1000,
          ((parseInt(req.query.page) || 1) - 1) *
            (parseInt(req.query.limit) || 1000),
        ],
      );
      const total = this.journalRepo.conn.get(
        `SELECT COUNT(*) as total FROM valuation_movements vm
         JOIN stock_items si ON si.id = vm.item_id AND si.company_id = vm.company_id
         ${filters}`,
        params,
      ).total;
      res.json(successResponse({ items: rows, total }));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Inventory valuation report.
   * GET /api/accounting/inventory/valuation
   */
  async inventoryValuation(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const rows = this.journalRepo.conn.all(
        `
        SELECT
          ii.item_id, si.sku as stock_item_sku,
          p.id as product_id, p.name as product_name,
          ii.quantity, ii.unit_cost, ii.total_value,
          ii.valuation_method
        FROM inventory_items ii
        JOIN stock_items si ON si.id = ii.item_id AND si.company_id = ii.company_id
        LEFT JOIN products p ON p.id = si.product_id AND p.company_id = ii.company_id
        WHERE ii.company_id = ? AND ii.quantity > 0
        ORDER BY COALESCE(p.name, si.name)
      `,
        [companyId],
      );
      const totalValue = rows.reduce(
        (s, r) => s + (parseFloat(r.total_value) || 0),
        0,
      );
      res.json(
        successResponse({
          items: rows,
          total_value: totalValue,
          count: rows.length,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  // processInventoryMovement() was removed.
  //
  // It was the last code path querying the removed inventory_items.product_id
  // column and the only other writer of the inventory_items valuation table.
  // It had no route binding and zero callers; its moving weighted-average
  // formula now lives in InventoryEngine.applyValuation(), which is the single
  // valuation authority and IS called on every stock movement.
  // Kept here as a record so it is not reintroduced.

  // ═══════════════════════════════════════════════════════════════════
  // STEP 25: Bank Reconciliation
  // ═══════════════════════════════════════════════════════════════════

  /**
   * List bank accounts.
   * GET /api/accounting/bank-accounts
   */
  async listBankAccounts(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const accounts = this.journalRepo.conn.all(
        "SELECT * FROM bank_accounts WHERE company_id = ? ORDER BY account_name",
        [companyId],
      );
      res.json(
        successResponse({
          items: accounts,
          total: accounts.length,
          bankAccounts: accounts,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * Create a bank account.
   * POST /api/accounting/bank-accounts
   */
  async createBankAccount(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const {
        account_name,
        account_number,
        bank_name,
        ifsc_code,
        account_type,
        gl_account_id,
        opening_balance,
      } = req.body;
      if (!account_name || !gl_account_id) {
        throw new ValidationError(
          "account_name and gl_account_id are required",
        );
      }
      const id = generateId("ba");
      const now = new Date().toISOString();
      this.journalRepo.conn
        .prepare(
          `
        INSERT INTO bank_accounts (id, company_id, account_name, account_number, bank_name,
          ifsc_code, account_type, gl_account_id, opening_balance, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `,
        )
        .run(
          id,
          companyId,
          account_name,
          account_number || "",
          bank_name || "",
          ifsc_code || "",
          account_type || "CHECKING",
          gl_account_id,
          parseFloat(opening_balance) || 0,
          now,
          now,
        );
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "bank_account",
        id,
        "CREATE",
        null,
        { account_name, account_number },
      );
      const result = this.journalRepo.conn.get(
        "SELECT * FROM bank_accounts WHERE id = ?",
        [id],
      );
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Update a bank account.
   * PUT /api/accounting/bank-accounts/:id
   */
  async updateBankAccount(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const fields = [];
      const params = [];
      const updatable = [
        "account_name",
        "account_number",
        "bank_name",
        "ifsc_code",
        "account_type",
        "gl_account_id",
        "opening_balance",
        "is_active",
      ];
      for (const key of updatable) {
        if (req.body[key] !== undefined) {
          fields.push(key + " = ?");
          params.push(
            typeof req.body[key] === "boolean"
              ? req.body[key]
                ? 1
                : 0
              : req.body[key],
          );
        }
      }
      if (fields.length === 0)
        throw new ValidationError("No updatable fields provided");
      const now = new Date().toISOString();
      fields.push("updated_at = ?");
      params.push(now);
      params.push(req.params.id, companyId);
      this.journalRepo.conn
        .prepare(
          `UPDATE bank_accounts SET ${fields.join(", ")} WHERE id = ? AND company_id = ?`,
        )
        .run(...params);
      const result = this.journalRepo.conn.get(
        "SELECT * FROM bank_accounts WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      res.json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Create a bank reconciliation.
   * POST /api/accounting/bank-reconciliations
   */
  async createBankReconciliation(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { bank_account_id, statement_date, statement_balance, items } =
        req.body;
      if (!bank_account_id || !statement_date) {
        throw new ValidationError(
          "bank_account_id and statement_date are required",
        );
      }
      // Get bank account and its GL account
      const bankAccount = this.journalRepo.conn.get(
        "SELECT * FROM bank_accounts WHERE id = ? AND company_id = ?",
        [bank_account_id, companyId],
      );
      if (!bankAccount) throw new NotFoundError("BankAccount", bank_account_id);

      // Calculate book balance from JE
      const bookBalanceResult = this.journalRepo.conn.get(
        `
        SELECT
          COALESCE(SUM(jel.debit_amount), 0) as total_dr,
          COALESCE(SUM(jel.credit_amount), 0) as total_cr
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE jel.account_id = ? AND je.company_id = ? AND je.status = 'POSTED'
          AND je.entry_date <= ?
      `,
        [bankAccount.gl_account_id, companyId, statement_date],
      );

      const bookBalance =
        parseFloat(bookBalanceResult?.total_dr || 0) -
        parseFloat(bookBalanceResult?.total_cr || 0);
      const statementBal = parseFloat(statement_balance) || 0;

      const reconId = this.journalRepo.conn.transaction(() => {
        const id = generateId("brc");
        const now = new Date().toISOString();
        this.journalRepo.conn
          .prepare(
            `
          INSERT INTO bank_reconciliations (id, company_id, bank_account_id, gl_account_id,
            statement_date, statement_balance, book_balance, status, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'RECONCILED', ?, ?, ?)
        `,
          )
          .run(
            id,
            companyId,
            bank_account_id,
            bankAccount.gl_account_id,
            statement_date,
            statementBal,
            bookBalance,
            req.body.notes || null,
            now,
            now,
          );

        // Insert reconciliation items
        if (Array.isArray(items)) {
          for (const item of items) {
            this.journalRepo.conn
              .prepare(
                `
              INSERT INTO bank_reconciliation_items (id, reconciliation_id, company_id, journal_entry_id,
                item_type, description, amount, reference, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
              )
              .run(
                generateId("bri"),
                id,
                companyId,
                item.journal_entry_id || null,
                item.item_type,
                item.description,
                parseFloat(item.amount) || 0,
                item.reference || null,
                now,
              );
          }
        }

        return id;
      })();

      const result = this.journalRepo.conn.get(
        "SELECT * FROM bank_reconciliations WHERE id = ?",
        [reconId],
      );
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "bank_reconciliation",
        reconId,
        "CREATE",
        null,
        null,
      );
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Get a bank reconciliation.
   * GET /api/accounting/bank-reconciliations/:id
   */
  async getBankReconciliation(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const recon = this.journalRepo.conn.get(
        "SELECT * FROM bank_reconciliations WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!recon) throw new NotFoundError("BankReconciliation", req.params.id);
      const items = this.journalRepo.conn.all(
        "SELECT * FROM bank_reconciliation_items WHERE reconciliation_id = ?",
        [req.params.id],
      );
      res.json(successResponse({ ...recon, items }));
    } catch (err) {
      next(err);
    }
  }

  /**
   * List bank reconciliations for a bank account.
   * GET /api/accounting/bank-reconciliations?bank_account_id=:id
   */
  async listBankReconciliations(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const bankAccountId = req.query.bank_account_id;
      let where = "WHERE company_id = ?";
      const params = [companyId];
      if (bankAccountId) {
        where += " AND bank_account_id = ?";
        params.push(bankAccountId);
      }
      const rows = this.journalRepo.conn.all(
        `SELECT br.* FROM bank_reconciliations br ${where} ORDER BY br.statement_date DESC`,
        params,
      );
      res.json(successResponse({ items: rows, total: rows.length }));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Delete a bank reconciliation.
   * DELETE /api/accounting/bank-reconciliations/:id
   */
  async deleteBankReconciliation(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const recon = this.journalRepo.conn.get(
        "SELECT * FROM bank_reconciliations WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!recon) throw new NotFoundError("BankReconciliation", req.params.id);
      this.journalRepo.conn
        .prepare(
          "DELETE FROM bank_reconciliations WHERE id = ? AND company_id = ?",
        )
        .run(req.params.id, companyId);
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "bank_reconciliation",
        req.params.id,
        "DELETE",
        recon,
        null,
      );
      res.json(successResponse({ message: "Bank reconciliation deleted" }));
    } catch (err) {
      next(err);
    }
  }

  /**
   * List items for a bank reconciliation.
   * GET /api/accounting/bank-reconciliations/:id/items
   */
  async listBankReconItems(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      // Verify the reconciliation exists
      const recon = this.journalRepo.conn.get(
        "SELECT id FROM bank_reconciliations WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!recon) throw new NotFoundError("BankReconciliation", req.params.id);
      const items = this.journalRepo.conn.all(
        "SELECT * FROM bank_reconciliation_items WHERE reconciliation_id = ? ORDER BY created_at",
        [req.params.id],
      );
      res.json(successResponse({ items, total: items.length }));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Add an item to a bank reconciliation.
   * POST /api/accounting/bank-reconciliations/:id/items
   */
  async createBankReconItem(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const recon = this.journalRepo.conn.get(
        "SELECT id FROM bank_reconciliations WHERE id = ? AND company_id = ?",
        [req.params.id, companyId],
      );
      if (!recon) throw new NotFoundError("BankReconciliation", req.params.id);
      const { journal_entry_id, item_type, description, amount, reference } =
        req.body;
      if (!item_type || !description) {
        throw new ValidationError("item_type and description are required");
      }
      const now = new Date().toISOString();
      const id = generateId("bri");
      this.journalRepo.conn
        .prepare(
          `
        INSERT INTO bank_reconciliation_items (id, reconciliation_id, company_id, journal_entry_id,
          item_type, description, amount, reference, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          id,
          req.params.id,
          companyId,
          journal_entry_id || null,
          item_type,
          description,
          parseFloat(amount) || 0,
          reference || null,
          now,
        );
      const result = this.journalRepo.conn.get(
        "SELECT * FROM bank_reconciliation_items WHERE id = ?",
        [id],
      );
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "bank_recon_item",
        id,
        "CREATE",
        null,
        result,
      );
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Delete an item from a bank reconciliation.
   * DELETE /api/accounting/bank-reconciliations/:reconId/items/:itemId
   */
  async deleteBankReconItem(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const item = this.journalRepo.conn.get(
        "SELECT bri.* FROM bank_reconciliation_items bri JOIN bank_reconciliations br ON br.id = bri.reconciliation_id WHERE bri.id = ? AND br.company_id = ?",
        [req.params.itemId, companyId],
      );
      if (!item) throw new NotFoundError("BankReconItem", req.params.itemId);
      this.journalRepo.conn
        .prepare("DELETE FROM bank_reconciliation_items WHERE id = ?")
        .run(req.params.itemId);
      logAudit(
        this.coaRepo.conn,
        companyId,
        req.user?.userId,
        "bank_recon_item",
        req.params.itemId,
        "DELETE",
        item,
        null,
      );
      res.json(successResponse({ message: "Reconciliation item deleted" }));
    } catch (err) {
      next(err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 26: Year-End Closing
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Get year-end closing status and summary for a financial year.
   * GET /api/accounting/year-end/status?financial_year_id=:id
   */
  async getYearEndStatus(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const fyId = req.query.financial_year_id || req.params.financial_year_id;
      const fy = this.journalRepo.conn.get(
        "SELECT * FROM financial_years WHERE id = ? AND company_id = ?",
        [fyId, companyId],
      );
      if (!fy) throw new NotFoundError("FinancialYear", fyId);

      // Check if closing already exists
      const existing = this.journalRepo.conn.get(
        "SELECT * FROM year_end_closings WHERE company_id = ? AND financial_year_id = ?",
        [companyId, fyId],
      );

      // Compute P&L for the year
      const pAndL = this.journalRepo.profitLoss(
        companyId,
        fy.start_date,
        fy.end_date,
      );

      // Check if FY is locked
      const locked = fy.is_locked === 1;

      // List temporary accounts (revenue, expense) with balances
      const tempAccounts = this.journalRepo.conn.all(
        `
        SELECT a.id, a.code, a.name, a.type, a.debit_credit_nature,
          COALESCE(SUM(jel.debit_amount), 0) as total_debit,
          COALESCE(SUM(jel.credit_amount), 0) as total_credit
        FROM accounts a
        LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id AND jel.company_id = a.company_id
        JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'POSTED'
          AND je.entry_date >= ? AND je.entry_date <= ?
        WHERE a.company_id = ? AND a.type IN ('INCOME', 'EXPENSE')
        GROUP BY a.id, a.code, a.name, a.type, a.debit_credit_nature
        ORDER BY a.type, a.code
      `,
        [fy.start_date, fy.end_date, companyId],
      );

      res.json(
        successResponse({
          financial_year: fy,
          closed: existing ? true : false,
          closing: existing || null,
          locked: locked,
          profit_loss: pAndL,
          temporary_accounts: tempAccounts,
          can_close: !existing && !locked,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * Perform year-end closing — close revenue & expense accounts to retained earnings.
   * POST /api/accounting/year-end/close
   */
  async closeFinancialYear(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const { financial_year_id, next_financial_year_id } = req.body;
      if (!financial_year_id)
        throw new ValidationError("financial_year_id is required");

      const fy = this.journalRepo.conn.get(
        "SELECT * FROM financial_years WHERE id = ? AND company_id = ?",
        [financial_year_id, companyId],
      );
      if (!fy) throw new NotFoundError("FinancialYear", financial_year_id);
      if (fy.is_locked === 1)
        throw new AppError(
          "Financial year is already locked",
          "FY_LOCKED",
          400,
        );

      // Check for existing closing
      const existing = this.journalRepo.conn.get(
        "SELECT id FROM year_end_closings WHERE company_id = ? AND financial_year_id = ?",
        [companyId, financial_year_id],
      );
      if (existing)
        throw new AppError(
          "Financial year has already been closed",
          "ALREADY_CLOSED",
          400,
        );

      const userId = req.user?.userId || "system";
      const now = new Date().toISOString();

      const closingId = this.journalRepo.conn.transaction(() => {
        const id = generateId("yec");
        const closingVoucherId = generateId("vch");
        const closingJeId = generateId("je");
        const carryFwdVoucherId = generateId("vch");
        const carryFwdJeId = generateId("je");

        // Get P&L
        const pAndL = this.journalRepo.profitLoss(
          companyId,
          fy.start_date,
          fy.end_date,
        );
        const netProfit = parseFloat(pAndL.net_profit || 0);

        // Get all revenue and expense account balances for the year
        const tempAccounts = this.journalRepo.conn.all(
          `
          SELECT a.id, a.name, a.type, a.debit_credit_nature,
            COALESCE(SUM(jel.debit_amount), 0) as total_debit,
            COALESCE(SUM(jel.credit_amount), 0) as total_credit
          FROM accounts a
          LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
          JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'POSTED'
            AND je.entry_date >= ? AND je.entry_date <= ?
          WHERE a.company_id = ? AND a.type IN ('INCOME', 'EXPENSE')
          GROUP BY a.id, a.name, a.type, a.debit_credit_nature
          HAVING (total_debit > 0 OR total_credit > 0)
        `,
          [fy.start_date, fy.end_date, companyId],
        );

        // Create closing JE voucher
        this.journalRepo.conn
          .prepare(
            `
          INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, voucher_date,
            reference_number, description, status, created_by, created_at, updated_at, financial_year_id)
          VALUES (?, ?, ?, 'JOURNAL', ?, ?, 'Year-end closing entry', 'POSTED', ?, ?, ?, ?)
        `,
          )
          .run(
            closingVoucherId,
            companyId,
            "CLOS-" + fy.name + "-001",
            fy.end_date,
            "Closing: " + fy.name,
            userId,
            now,
            now,
            financial_year_id,
          );

        // Create closing JE — close revenue (credit balance → debit to zero) and expense (debit balance → credit to zero)
        // Revenue: Dr Revenue (total), Credit Revenue accounts
        // Expense: Cr Expense (total), Debit Expense accounts
        let totalDebit = 0;
        let totalCredit = 0;

        this.journalRepo.conn
          .prepare(
            `
          INSERT INTO journal_entries (id, company_id, voucher_id, entry_number, entry_date,
            description, currency, exchange_rate, total_debit, total_credit, status,
            created_by, created_at, updated_at, posted_at, posted_by, financial_year_id)
          VALUES (?, ?, ?, ?, ?, ?, 'INR', 1.0, 0, 0, 'POSTED', ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            closingJeId,
            companyId,
            closingVoucherId,
            "JE-CLOS-" + fy.name,
            fy.end_date,
            "Closing entry for " + fy.name,
            userId,
            now,
            now,
            now,
            userId,
            financial_year_id,
          );

        // Close revenue accounts (credit balance → debit to close)
        for (const acc of tempAccounts) {
          const debitTotal = parseFloat(acc.total_debit || 0);
          const creditTotal = parseFloat(acc.total_credit || 0);
          let balance = 0;
          let closeDr = 0;
          let closeCr = 0;

          if (acc.type === "INCOME") {
            // Revenue has credit balance: close by debiting
            balance = creditTotal - debitTotal;
            closeDr = balance;
            totalDebit += closeDr;
          } else if (acc.type === "EXPENSE") {
            // Expense has debit balance: close by crediting
            balance = debitTotal - creditTotal;
            closeCr = balance;
            totalCredit += closeCr;
          }

          if (closeDr > 0 || closeCr > 0) {
            this.journalRepo.conn
              .prepare(
                `
              INSERT INTO journal_entry_lines (id, company_id, journal_entry_id, account_id,
                debit_amount, credit_amount, description, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
              )
              .run(
                generateId("jl"),
                companyId,
                closingJeId,
                acc.id,
                closeDr,
                closeCr,
                "Closing: " + acc.name,
                now,
              );
          }
        }

        // The difference (revenue - expenses = net profit) goes to retained earnings
        // If netProfit > 0: Credit Retained Earnings (profit increases equity)
        // If netProfit < 0: Debit Retained Earnings (loss decreases equity)
        let reDr = 0,
          reCr = 0;
        if (netProfit > 0) {
          reCr = netProfit;
          totalCredit += reCr;
        } else if (netProfit < 0) {
          reDr = Math.abs(netProfit);
          totalDebit += reDr;
        }

        // Find Retained Earnings account (equity type, code typically 3900 or similar)
        let reAccount = this.journalRepo.conn.get(
          "SELECT id FROM accounts WHERE company_id = ? AND type = 'EQUITY' AND (code LIKE '%39%' OR name LIKE '%Retained%') LIMIT 1",
          [companyId],
        );
        if (!reAccount) {
          // Fallback: any EQUITY account
          reAccount = this.journalRepo.conn.get(
            "SELECT id FROM accounts WHERE company_id = ? AND type = 'EQUITY' LIMIT 1",
            [companyId],
          );
        }
        if (!reAccount) {
          // Fallback: any CREDIT-nature equity-like account
          reAccount = this.journalRepo.conn.get(
            "SELECT id FROM accounts WHERE company_id = ? AND type = 'EQUITY' AND debit_credit_nature = 'CREDIT' LIMIT 1",
            [companyId],
          );
        }

        if (reAccount && (reDr > 0 || reCr > 0)) {
          this.journalRepo.conn
            .prepare(
              `
            INSERT INTO journal_entry_lines (id, company_id, journal_entry_id, account_id,
              debit_amount, credit_amount, description, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
            )
            .run(
              generateId("jl"),
              companyId,
              closingJeId,
              reAccount.id,
              reDr,
              reCr,
              "Retained earnings: " + fy.name + " net profit",
              now,
            );
        }

        // Update JE totals
        this.journalRepo.conn
          .prepare(
            "UPDATE journal_entries SET total_debit = ?, total_credit = ? WHERE id = ?",
          )
          .run(totalDebit, totalCredit, closingJeId);

        // Create carry-forward JE (balance sheet accounts carry forward — no actual posting needed,
        // just a marker that B/S accounts are carried forward to next FY)
        const carryFwdNotes = [];

        // Update year_end_closings record
        this.journalRepo.conn
          .prepare(
            `
          INSERT INTO year_end_closings (id, company_id, financial_year_id, next_financial_year_id,
            closing_journal_entry_id, carry_forward_journal_entry_id, total_revenue, total_expense,
            net_profit, validation_report_json, closed_by, closed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            id,
            companyId,
            financial_year_id,
            next_financial_year_id || null,
            closingJeId,
            carryFwdJeId,
            parseFloat(pAndL.revenue || 0),
            parseFloat(pAndL.expense || 0),
            netProfit,
            JSON.stringify({
              temporary_accounts_closed: tempAccounts.map((a) => a.id),
              retained_earnings_account: reAccount ? reAccount.id : null,
              closing_je_id: closingJeId,
              total_debit: totalDebit,
              total_credit: totalCredit,
              balanced: Math.abs(totalDebit - totalCredit) < 0.01,
            }),
            userId,
            now,
          );

        // Lock the financial year
        this.journalRepo.conn
          .prepare(
            "UPDATE financial_years SET is_locked = 1 WHERE id = ? AND company_id = ?",
          )
          .run(financial_year_id, companyId);

        logAudit(
          this.coaRepo.conn,
          companyId,
          userId,
          "financial_year",
          financial_year_id,
          "CLOSE",
          null,
          {
            closing_id: id,
            net_profit: netProfit,
          },
        );

        return id;
      })();

      const result = this.journalRepo.conn.get(
        "SELECT * FROM year_end_closings WHERE id = ?",
        [closingId],
      );
      res.status(201).json(
        successResponse({
          message: "Financial year closed successfully",
          closing: result,
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * List all year-end closing records.
   * GET /api/accounting/year-end
   */
  async listYearEndClosings(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const rows = this.journalRepo.conn.all(
        "SELECT yec.*, fy.name as financial_year_name FROM year_end_closings yec JOIN financial_years fy ON fy.id = yec.financial_year_id WHERE yec.company_id = ? ORDER BY yec.closed_at DESC",
        [companyId],
      );
      res.json(successResponse({ items: rows, total: rows.length }));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Get a specific year-end closing record.
   * GET /api/accounting/year-end/:id
   */
  async getYearEndClosing(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const closing = this.journalRepo.conn.get(
        `SELECT yec.*, fy.name as financial_year_name
         FROM year_end_closings yec
         JOIN financial_years fy ON fy.id = yec.financial_year_id
         WHERE yec.id = ? AND yec.company_id = ?`,
        [req.params.id, companyId],
      );
      if (!closing) throw new NotFoundError("YearEndClosing", req.params.id);
      res.json(successResponse(closing));
    } catch (err) {
      next(err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 27: Audit & Reconciliation Reports
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Audit trail for a specific entity (voucher/journal entry).
   * GET /api/accounting/audit-trail?entity_type=:type&entity_id=:id
   */
  async auditTrail(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const entityType = req.query.entity_type || null;
      const entityId = req.query.entity_id || null;
      const params = [companyId];
      let where = "WHERE company_id = ?";
      if (entityType) {
        where += " AND entity_type = ?";
        params.push(entityType);
      }
      if (entityId) {
        where += " AND entity_id = ?";
        params.push(entityId);
      }
      const rows = this.journalRepo.conn.all(
        `SELECT id, entity_type, entity_id, action, old_values_json, new_values_json, user_id, created_at
         FROM accounting_audit ${where} ORDER BY created_at DESC LIMIT 500`,
        params,
      );
      res.json(successResponse({ items: rows, total: rows.length }));
    } catch (err) {
      next(err);
    }
  }

  /**
   * End-to-end reconciliation report — verifies that every posted voucher
   * has a balanced JE, and all JEs sum to zero (debit = credit).
   * GET /api/accounting/reports/system-integrity
   */
  async systemIntegrity(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      const conn = this.journalRepo.conn;

      // Check 1: All posted JEs are balanced (debit = credit)
      const unbalancedJEs = conn.all(
        `
        SELECT id, entry_number, total_debit, total_credit,
          ABS(total_debit - total_credit) as difference
        FROM journal_entries
        WHERE company_id = ? AND status = 'POSTED' AND ABS(total_debit - total_credit) > 0.001
        ORDER BY created_at DESC LIMIT 50
      `,
        [companyId],
      );

      // Check 2: All posted vouchers have a linked JE
      const vouchersWithoutJE = conn.all(
        `
        SELECT v.id, v.voucher_number, v.voucher_type
        FROM vouchers v
        WHERE v.company_id = ? AND v.status = 'POSTED'
          AND (v.journal_entry_id IS NULL OR v.journal_entry_id = '')
        LIMIT 50
      `,
        [companyId],
      );

      // Check 3: JE voucher linkage consistency
      const orphanJEs = conn.all(
        `
        SELECT je.id, je.entry_number
        FROM journal_entries je
        WHERE je.company_id = ? AND je.status = 'POSTED'
          AND je.voucher_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM vouchers v WHERE v.id = je.voucher_id)
        LIMIT 50
      `,
        [companyId],
      );

      // Check 4: Total debit = total credit across all posted JEs
      const totals = conn.get(
        `
        SELECT
          COALESCE(SUM(total_debit), 0) as company_total_debit,
          COALESCE(SUM(total_credit), 0) as company_total_credit
        FROM journal_entries
        WHERE company_id = ? AND status = 'POSTED'
      `,
        [companyId],
      );

      const totalDr = parseFloat(totals?.company_total_debit || 0);
      const totalCr = parseFloat(totals?.company_total_credit || 0);

      res.json(
        successResponse({
          balanced: Math.abs(totalDr - totalCr) < 0.01,
          total_debit: totalDr,
          total_credit: totalCr,
          difference: parseFloat((totalDr - totalCr).toFixed(2)),
          checks: {
            unbalanced_jes: {
              count: unbalancedJEs.length,
              items: unbalancedJEs,
            },
            vouchers_without_je: {
              count: vouchersWithoutJE.length,
              items: vouchersWithoutJE,
            },
            orphaned_jes: { count: orphanJEs.length, items: orphanJEs },
          },
          status:
            unbalancedJEs.length === 0 &&
            vouchersWithoutJE.length === 0 &&
            orphanJEs.length === 0 &&
            Math.abs(totalDr - totalCr) < 0.01
              ? "PASS"
              : "FAIL",
        }),
      );
    } catch (err) {
      next(err);
    }
  }
}

module.exports = { AccountingController };
