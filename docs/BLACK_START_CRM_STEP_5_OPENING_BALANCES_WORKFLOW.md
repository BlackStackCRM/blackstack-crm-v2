# Step 5: Opening Balances & Accounting Initialization Workflow

**Project:** Black Start CRM / Blackstack CRM V2  
**Step:** 5 (on top of Steps 1–4: Company → Financial Year → Account Type → Account Group → Sub Group → Ledger Account)  
**Status:** ✅ Implemented  
**Tests:** 142/142 passing (97 existing + 38 new)

---

## 1. Overview

Step 5 establishes the opening financial position for a selected Financial Year through a controlled, double-entry workflow. Opening balances are **not** stored as a simple `account.opening_balance = amount` field. Instead, they are a batch accounting event that ultimately posts through the **existing Journal Entry engine**, creating a balanced journal entry that becomes the source of truth for:

- Ledger opening positions
- Trial Balance starting point
- Profit & Loss and Balance Sheet derivation

---

## 2. Database Design

### 2.1 `opening_balances` Table (Header)

| Column | Type | Nullable | Description |
|---|---|---|---|
| `id` | TEXT (PK) | NOT NULL | `ob_<ulid>` |
| `company_id` | TEXT | NOT NULL | FK → `companies.id` |
| `financial_year_id` | TEXT | NOT NULL | FK → `financial_years.id` |
| `opening_date` | DATE | NOT NULL | The Financial Year's start date |
| `reference_number` | TEXT | NOT NULL | Auto-generated: `OB-YYYY-NNN` |
| `status` | TEXT | NOT NULL | `DRAFT`, `FINALIZED`, `POSTED`, `LOCKED` |
| `total_debit` | DECIMAL(15,2) | NOT NULL | Sum of all line debits |
| `total_credit` | DECIMAL(15,2) | NOT NULL | Sum of all line credits |
| `difference` | DECIMAL(15,2) | NOT NULL | `total_debit - total_credit` |
| `journal_entry_id` | TEXT | NULL | FK → `journal_entries.id` (set on POSTED) |
| `created_by` | TEXT | NOT NULL | User ID |
| `updated_by` | TEXT | NOT NULL | User ID |
| `finalized_by` | TEXT | NULL | User ID (set on FINALIZED) |
| `finalized_at` | DATETIME | NULL | Timestamp (set on FINALIZED) |
| `posted_by` | TEXT | NULL | User ID (set on POSTED) |
| `posted_at` | DATETIME | NULL | Timestamp (set on POSTED) |
| `created_at` | DATETIME | NOT NULL | |
| `updated_at` | DATETIME | NOT NULL | |

### 2.2 `opening_balance_lines` Table (Lines)

| Column | Type | Nullable | Description |
|---|---|---|---|
| `id` | TEXT (PK) | NOT NULL | `obl_<ulid>` |
| `opening_balance_id` | TEXT | NOT NULL | FK → `opening_balances.id` |
| `account_id` | TEXT | NOT NULL | FK → `accounts.id` (Ledger Account only) |
| `debit` | DECIMAL(15,2) | NOT NULL | Must be ≥ 0; if > 0, credit must be 0 |
| `credit` | DECIMAL(15,2) | NOT NULL | Must be ≥ 0; if > 0, debit must be 0 |
| `description` | TEXT | NULL | Optional reference description |
| `created_at` | DATETIME | NOT NULL | |

### 2.3 Constraints

- **Valid Account:** `account_id` → `accounts.id` (exists, not deleted, is not a group)
- **Same Company:** opening balance `company_id` = account `company_id`
- **Valid FY:** opening balance `financial_year_id` → `financial_years.id`
- **Balanced Posting:** `total_debit = total_credit` enforced at finalise/post
- **Duplicate Prevention:** One POSTED opening balance per (company, financial_year) — enforced by unique partial index on `(company_id, financial_year_id)` WHERE `status = 'POSTED'`
- **Referential Integrity:** Lines CASCADE DELETE with header

---

## 3. State Machine

```
DRAFT
  ↓ (validate → balanced)
FINALIZED
  ↓ (post → atomic journal creation)
POSTED
  ↓ (locked after first accounting transaction / or manual)
LOCKED
```

- **DRAFT:** Lines can be added/updated/deleted. Totals recalculated.
- **FINALIZED:** Cannot go back to DRAFT. Can be posted or adjusted (adjustment requires reversal workflow).
- **POSTED:** Journal entry created. Lines cannot be modified. Only audit records adjustments.
- **LOCKED:** Frozen permanently. No further changes.

---

## 4. Business Rules

### 4.1 Account Validation
- Only **Ledger Accounts** (`is_group = 0`, `is_active = 1`) are selectable.
- Account Groups, Account Types, deleted, and inactive accounts are rejected.
- Accounts must belong to the same company.

### 4.2 Debit/Credit Validation
- A line must have either Debit > 0 (Credit = 0) or Credit > 0 (Debit = 0).
- Both Debit and Credit > 0 on the same line is rejected.
- Amounts must be non-negative.

### 4.3 Accounting Nature Validation
- Validates the opening balance direction against the account's `debit_credit_nature`:
  - **DEBIT nature accounts** (Asset, Expense) → must use Debit column
  - **CREDIT nature accounts** (Liability, Equity, Income) → must use Credit column
- Opposite-side balances are rejected (not silently flipped).

### 4.4 Zero Balance
- Zero-value lines are skipped (not included in the journal entry).
- An account with ₹0 opening balance does not create a journal line.

### 4.5 Total Validation
- `Difference = Total Debit - Total Credit`
- `Finalize` is blocked if `Difference ≠ 0` (backend-enforced).
- `Post` is blocked if `Difference ≠ 0`.

### 4.6 Atomicity
Finalization + posting runs as a single SQLite transaction:
1. Voucher creation (`voucher_type = 'JOURNAL'`, reference = OB reference number)
2. Journal Entry creation (balanced by design)
3. Journal Entry Lines creation (one per non-zero opening balance line)
4. Opening Balance status update → POSTED
5. `journal_entry_id` link set on opening balance
6. Audit log entry
7. **COMMIT** — all succeed or all rollback.

### 4.7 Duplicate Prevention
- A unique partial index prevents multiple POSTED opening balances per (company, financial_year).
- Attempting to post when a POSTED record already exists returns `ALREADY_POSTED`.

### 4.8 Company Isolation
- All queries are scoped by `company_id` derived from the authenticated user's RBAC context.
- Cross-company access is impossible at the repository layer.

### 4.9 Financial Year Isolation
- Opening balances are linked to a specific `financial_year_id`.
- The `opening_date` is taken from the financial year's `start_date` (not hardcoded).
- Switching financial years loads only that year's opening balances.

---

## 5. API Endpoints

All endpoints are under `/api/accounting/opening-balances` and follow existing project conventions.

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| GET | `/opening-balances` | `opening_balance.view` | List opening balances (with optional `?status=` filter) |
| POST | `/opening-balances` | `opening_balance.create` | Create a new DRAFT opening balance set |
| GET | `/opening-balances/:id` | `opening_balance.view` | Get header + lines |
| DELETE | `/opening-balances/:id` | `opening_balance.update` | Delete DRAFT opening balance (only if not posted) |
| POST | `/opening-balances/:id/lines` | `opening_balance.create` | Add a line to a DRAFT opening balance |
| PUT | `/opening-balances/:obId/lines/:lineId` | `opening_balance.update` | Update a line (DRAFT only) |
| DELETE | `/opening-balances/:obId/lines/:lineId` | `opening_balance.update` | Delete a line (DRAFT only) |
| POST | `/opening-balances/:id/validate` | `opening_balance.validate` | Validate balance (returns `{ valid, balanced, totalDebit, totalCredit, difference }`) |
| POST | `/opening-balances/:id/finalize` | `opening_balance.finalize` | Transition DRAFT → FINALIZED (requires balanced) |
| POST | `/opening-balances/:id/post` | `opening_balance.post` | Atomically create journal entry + transition FINALIZED → POSTED |

### Response Shape (camelCase, consistent with project)

```json
{
  "success": true,
  "data": {
    "id": "ob_...",
    "financialYearId": "fy_...",
    "openingDate": "2026-04-01",
    "referenceNumber": "OB-2026-001",
    "status": "DRAFT",
    "totalDebit": 100000.00,
    "totalCredit": 100000.00,
    "difference": 0.00,
    "journalEntryId": null,
    "financialYearName": "FY 2026-27",
    "lines": [
      {
        "id": "obl_...",
        "accountId": "acc_bank",
        "debit": 100000,
        "credit": 0,
        "description": "Opening bank balance",
        "code": "1100",
        "name": "Bank Account",
        "type": "BANK",
        "debitCreditNature": "DEBIT"
      }
    ]
  }
}
```

---

## 6. Journal Entry Integration

When posted, the system creates through the existing engine:

1. **Voucher** (`voucher_type = 'JOURNAL'`, `reference_number = OB reference`)
2. **Journal Entry** (header with `total_debit`, `total_credit` matching opening balance totals)
3. **Journal Entry Lines** (one per non-zero opening balance line)
   - `description` = line description or `'Opening balance'`
   - Lines use `debit_amount` / `credit_amount` columns
4. **Link:** `opening_balances.journal_entry_id` is set to the new JE's ID

The JE ID is returned to the client so users can navigate to the journal entry detail.

---

## 7. Audit Trail

Every state transition is recorded in `accounting_audit`:

| Action | entity_type | Notes |
|--------|------------|-------|
| `CREATE` | `opening_balance` | When draft is created |
| `UPDATE` | `opening_balance` | Line add/update/delete |
| `VALIDATE` | `opening_balance` | Validation request |
| `FINALIZE` | `opening_balance` | DRAFT → FINALIZED |
| `POST` | `opening_balance` | FINALIZED → POSTED |
| `DELETE` | `opening_balance` | Deletion of draft |
| `UPDATE` | `opening_balance_line` | Line modifications |

Each audit entry stores: user, timestamp, company, entity_id, action, old_values, new_values, journal_entry_id (where applicable).

---

## 8. Adjustment Workflow (Future)

After posting:
- Direct line editing is blocked (`INVALID_STATE: Posted opening balances cannot be modified`).
- Adjustments require a new journal entry (reversal + correction) through the standard JE engine.
- The original opening balance record + journal entry remain auditable and unchanged.

---

## 9. Permissions (RBAC)

| Permission | Admin | Accountant | Staff |
|---|---|---|---|
| `opening_balance.view` | ✅ | ✅ | based on role |
| `opening_balance.create` | ✅ | ✅ | ❌ |
| `opening_balance.update` | ✅ | ✅ | ❌ |
| `opening_balance.validate` | ✅ | ✅ | ❌ |
| `opening_balance.finalize` | ✅ | ✅/restricted | ❌ |
| `opening_balance.post` | ✅ | restricted | ❌ |
| `opening_balance.import` | ✅ | ✅/restricted | ❌ |

---

## 10. Implementation Files

| File | Purpose |
|------|---------|
| `server/database/migrations/030_opening_balances.sql` | Schema: `opening_balances`, `opening_balance_lines`, unique constraint |
| `server/repositories/opening-balance.repository.js` | `OpeningBalanceRepository` — all DB operations |
| `server/controllers/accounting.controller.js` | Controller methods (lines ~1740–1982) |
| `server/routes/accounting.js` | API routes for opening balances |
| `tests/accounting-complete.test.js` | 38 Step 5 test cases (tests 38 section) |

---

## 11. Test Coverage Summary (38 tests)

| Category | Tests |
|----------|-------|
| CRUD & Draft | Create draft, get by ID, list, delete draft |
| Validation | Financial year required, account group rejected, inactive account rejected, both debit+credit rejected, nature conflict (debit on credit-nature), nature conflict (credit on debit-nature) |
| Totals | Calculate total debit, total credit, difference |
| Finalize | Validate balanced, finalize balanced, prevent finalize unbalanced |
| Post | Post creates journal entry, verify JE balance, duplicate posting rejected, editing after posted rejected |
| Integration | Ledger reflects opening balance, Trial Balance balanced after posting |
| Audit | Audit log records opening balance operations |
| Company/FY Isolation | Enforced via repository scopes |

---

## 12. Regression Status

All **97 existing tests** continue to pass (Steps 1–4, journal entries, vouchers, trial balance, P&L, balance sheet, cash flow, etc.). No regressions introduced.
