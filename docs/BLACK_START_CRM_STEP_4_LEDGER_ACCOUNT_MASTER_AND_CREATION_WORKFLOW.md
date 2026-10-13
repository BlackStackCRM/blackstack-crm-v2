# Step 4: Ledger Account Master & Ledger Account Creation Workflow

**Project:** Black Start CRM / Blackstack CRM V2
**Version:** 2.0
**Date:** September 7, 2026
**Author:** Implementation Spec
**Status:** ✅ IMPLEMENTED & TESTED (116/116 tests passing)

---

## 1. Overview

This specification describes the **Ledger Account Master** and **Ledger Account Creation Workflow** for Blackstack CRM V2. The Ledger Account is the final posting node in the accounting hierarchy:

```
Company → Financial Year → Account Type → Account Group → Sub Group → Ledger Account
```

Transactions are posted to **Ledger Accounts**, not to intermediate hierarchy nodes (Account Groups, Sub Groups), unless those nodes explicitly support direct posting.

---

## 2. Hierarchy & Concepts

| Level | Entity | is_group | allow_direct_posting | Description |
|-------|--------|----------|---------------------|-------------|
| 1 | Company | N/A | N/A | Business entity |
| 2 | Financial Year | N/A | N/A | Accounting period |
| 3 | Account Type | N/A | N/A | High-level classification (ASSET, LIABILITY, EQUITY, INCOME, EXPENSE, CASH, BANK) |
| 4 | Account Group | `true` | `false` | Intermediate classification node |
| 5 | Sub Group | `true` | `false` | Child of Account Group |
| 6 | Ledger Account | `false` | `true` | **Final posting account** where transactions are recorded |

### Example Hierarchy

```
Assets (Account Type)
└── Current Assets (Account Group, type=ASSET)
    └── Bank Accounts (Sub Group, parent=Current Assets)
        └── HDFC Bank (Ledger Account, posting=true)
```

---

## 3. Database Schema

### 3.1 `accounts` Table (Ledger Accounts)

| Field | Type | Required | Purpose | Validation |
|-------|------|----------|---------|------------|
| `id` | TEXT (PK) | Yes | Surrogate key (auto-generated, e.g., `acc_xxxxx`) | System-generated via `generateId('acc')` |
| `company_id` | TEXT | Yes | Tenant scope | Must match authenticated company |
| `code` | TEXT | Yes | Unique account code (e.g., `1101`, `AST-BANK-001`) | Unique within company; not whitespace-only |
| `name` | TEXT | Yes | Account display name (e.g., `HDFC Bank`) | Non-empty, non-whitespace; max 255 chars |
| `type` | TEXT | Yes | Account Type | Must be one of: CASH, BANK, ASSET, LIABILITY, EQUITY, INCOME, EXPENSE |
| `account_group_id` | TEXT (FK) | Yes | Parent Account Group/Sub Group | Must belong to same company; group's `type` must match account's `type` |
| `parent_id` | TEXT (FK) | No | Parent ledger (for consolidation) | Must be same `type`; no self-reference; no circular |
| `is_group` | INTEGER | Yes | `1` = group node, `0` = ledger | Ledger accounts must be `0` |
| `allow_direct_posting` | INTEGER | Yes | `1` = can post transactions | Ledger must be `1`; groups must be `0` |
| `debit_credit_nature` | TEXT | Auto | DEBIT or CREDIT | Auto-derived from Account Type; see section 4.4 |
| `opening_balance` | REAL | No | Initial balance at FY start | Must be ≥ 0; default 0 |
| `opening_balance_type` | TEXT | No | DEBIT or CREDIT for opening balance | Required if opening_balance > 0 |
| `opening_balance_date` | TEXT | No | Date of opening balance | YYYY-MM-DD format |
| `reconciliation_required` | INTEGER | No | Whether bank reconciliation needed | Default 0; only for BANK/CASH |
| `is_active` | INTEGER | Yes | Account active status | Default 1 |
| `is_system` | INTEGER | Yes | Protected system account | System accounts: cannot delete or change critical fields |
| `currency` | TEXT | No | Currency code | Default 'INR' |
| `description` | TEXT | No | Account remarks | Optional |
| `created_at` | DATETIME | Auto | Creation timestamp | System-managed |
| `updated_at` | DATETIME | Auto | Last update timestamp | System-managed |

### 3.2 `account_groups` Table (Existing — Reused)

| Field | Type | Purpose |
|-------|------|---------|
| `id` | TEXT (PK) | Surrogate key |
| `company_id` | TEXT | Tenant scope |
| `code` | TEXT | Unique group code (e.g., `1000`) |
| `name` | TEXT | Group display name |
| `type` | TEXT | Account Type (ASSET, LIABILITY, etc.) |
| `parent_id` | TEXT | Parent group for sub-groups |
| `description` | TEXT | Optional |
| `is_active` | INTEGER | Active status |
| `allow_child_accounts` | INTEGER | Whether children allowed |
| `debit_credit_nature` | TEXT | DEBIT/CREDIT |
| `is_group` | INTEGER | Always `1` for groups |
| `allow_direct_posting` | INTEGER | Always `0` for groups |
| `created_at` | DATETIME | Timestamp |
| `updated_at` | DATETIME | Timestamp |

**UNIQUE constraint:** `(company_id, code)`

---

## 4. Business Rules

### 4.1 Account Type → Group Dependency

**Rule:** A Ledger Account's `type` (Account Type) must match its parent group's `type`.

- When creating a ledger account with `type: ASSET`, the selected `account_group_id` must point to a group whose `type` is also `ASSET`.
- When the Account Type is changed during update, the group must be re-validated or the change is rejected.
- **Violation → HTTP 400 Validation Error**

### 4.2 Nature Auto-Derivation

The `debit_credit_nature` is **automatically derived** from the Account Type. Manual override is rejected if it conflicts.

| Account Type | Auto-Derived Nature |
|-------------|-------------------|
| CASH | DEBIT |
| BANK | DEBIT |
| ASSET | DEBIT |
| LIABILITY | CREDIT |
| EQUITY | CREDIT |
| INCOME | CREDIT |
| EXPENSE | DEBIT |

- If the user manually provides `debit_credit_nature` that conflicts with the auto-derived value → **HTTP 400 Validation Error**
- If the user does not provide it, it is set automatically.

### 4.3 Account Type Change Protection

**Rule:** Once a Ledger Account has journal entries (transactions), its `account_type` cannot be changed.

- This maintains audit trail integrity.
- **Violation → HTTP 400 Validation Error**

### 4.4 Opening Balance Journal Entries

When a Ledger Account is created with `opening_balance > 0`:

1. **Atomicity:** The account INSERT and journal entry creation are wrapped in a single database transaction.
2. **Journal Entry Structure:**
   - A voucher of type `JOURNAL` is created with `reference_number = 'OB-<account_id>'`.
   - A journal entry is created with `total_debit` and `total_credit` equal to the opening balance (balanced by definition).
3. **Debit Opening Balance (for ASSET/CASH/BANK/EXPENSE accounts):**
   - Debit line: the ledger account itself (debit = opening_balance)
   - Credit line: the offset equity account (e.g., Retained Earnings, credit = opening_balance)
4. **Credit Opening Balance (for LIABILITY/EQUITY/INCOME accounts):**
   - Credit line: the ledger account itself (credit = opening_balance)
   - Debit line: the offset equity account (debit = opening_balance)
5. **Idempotency:** If an opening balance already exists for the account (by reference_number), it is updated, not duplicated.
6. **Zero Balance:** If `opening_balance = 0`, no journal entry is created. `openingBalanceEntry` in the response is `null`.
7. **Only posting accounts** (`is_group=0 AND allow_direct_posting=1`) receive opening balances.

### 4.5 Protected / System Accounts

Accounts with `is_system = 1` are protected:

- **Cannot be deleted** → HTTP 400 with error message
- **Cannot change critical fields:** `type`, `account_group_id`, `code`, `is_group`, `allow_direct_posting`, `debit_credit_nature`, `is_system`
- **Can update non-critical fields:** `name`, `description`, `is_active`, `opening_balance`, `opening_balance_type`, `opening_balance_date`, `reconciliation_required`

**Default system account:** `acc_retained` (Retained Earnings, code `3200`, type `EQUITY`, is_system=1)

### 4.6 Delete Protection

A Ledger Account cannot be deleted if:
1. It is a system account (`is_system = 1`)
2. It has journal entry lines referencing it
3. It has child accounts (sub-ledgers) referencing it via `parent_id`

**Violation → HTTP 400 / 409 with appropriate error message**

### 4.7 Activation / Deactivation

- `PATCH /accounting/accounts/:id` with `{ is_active: 0 }` deactivates an account
- Deactivated accounts:
  - Are excluded from the GL posting list endpoint
  - Cannot be selected for new transactions
  - Historical transactions remain visible
  - Can be reactivated with `{ is_active: 1 }`

### 4.8 GL Account Selection

The `GET /accounting/accounts/gl` endpoint returns only valid posting accounts:
- `is_group = 0` (not a group)
- `allow_direct_posting = 1` (allows posting)
- `is_active = 1` (active)
- Ordered by `code`

---

## 5. API Endpoints

### 5.1 Create Ledger Account

**Endpoint:** `POST /api/accounting/accounts`

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | Yes | Unique account code |
| `name` | string | Yes | Account name (non-empty, non-whitespace) |
| `type` | string | Yes | Account Type (CASH, BANK, ASSET, LIABILITY, EQUITY, INCOME, EXPENSE) |
| `account_group_id` | string | Yes | Parent group ID (must match type) |
| `description` | string | No | Account description |
| `allow_direct_posting` | boolean | No | Default: `true` for ledgers |
| `parent_id` | string | No | Parent ledger for consolidation |
| `opening_balance` | number | No | Default: 0 |
| `opening_balance_type` | string | No | DEBIT/CREDIT (auto-set from type if not provided) |
| `opening_balance_date` | string | No | YYYY-MM-DD |
| `reconciliation_required` | boolean | No | Default: false |
| `is_active` | boolean | No | Default: true |

**Response (201):** Full account object with camelCase keys, including:
- `id`, `code`, `name`, `type`, `accountGroup`, `nature` (debitCreditNature), `openingBalance`, `openingBalanceEntry` (null or journal entry reference), `allowDirectPosting`, `isGroup`, `isActive`, `isSystem`, timestamps.

**Error Responses:**
- `400 VALIDATION_ERROR` — Duplicate code, invalid type, type-group mismatch, nature conflict
- `403 AUTHORIZATION_ERROR` — Insufficient RBAC permissions

### 5.2 Update Ledger Account

**Endpoint:** `PUT /api/accounting/accounts/:id`

**Behaviors:**
- Validates Account Type → Group dependency (if group is changed)
- Re-derives nature from type (if type is changed)
- Prevents type change if journal entries exist
- Enforces `is_group=true → allow_direct_posting=false`
- Protects system accounts from critical field changes
- Audits all changes

### 5.3 Delete Ledger Account

**Endpoint:** `DELETE /api/accounting/accounts/:id`

**Behaviors:**
- Prevents deletion of system accounts
- Prevents deletion if journal entries exist
- Prevents deletion if child accounts exist

### 5.4 List GL Accounts

**Endpoint:** `GET /api/accounting/accounts/gl`

**Query Parameters:**
- `type` — Filter by Account Type
- `group_id` — Filter by parent group
- `active` — Filter by active status (default: active only)

**Response:** `{ accounts: [...], total: N }`

### 5.5 Get Account Tree

**Endpoint:** `GET /api/accounting/accounts/tree`

Returns the full hierarchy tree with nodes tagged as `kind: 'group'` or `kind: 'ledger'`.

### 5.6 Get Account Details

**Endpoint:** `GET /api/accounting/accounts/:id`

Returns account details including:
- `currentBalance` — computed from journal entries
- `transactionCount` — number of journal entry lines
- `openingBalanceEntry` — opening balance journal entry reference
- Full account fields

---

## 6. Frontend Implementation

### 6.1 Ledger Account Form (ACCOUNT Modal)

The existing ACCOUNT modal form in `public/js/pages/chart-of-accounts.js` is reused with the following fields:

| Field | Input Type | Source | Behavior |
|-------|-----------|--------|----------|
| Account Code | Text input | Manual | Required; unique; auto-focus |
| Account Name | Text input | Manual | Required; non-empty |
| Account Type | Select dropdown | Account Type Master | Filters Account Group dropdown |
| Account Group | Select dropdown | Filtered by Account Type | Cascade: only shows groups matching selected type |
| Description | Textarea | Manual | Optional |
| Opening Balance | Number input | Manual | Default 0; triggers journal entry creation |
| Nature | Select dropdown (read-only) | Auto-derived from Type | DEBIT for ASSET/CASH/EXPENSE; CREDIT for LIABILITY/EQUITY/INCOME |
| Opening Balance Type | Select (DEBIT/CREDIT) | Auto-set from Nature | Cannot conflict with auto-derived nature |
| Opening Balance Date | Date picker | Manual | Required if opening balance > 0 |
| Reconciliation Required | Checkbox | Manual | Default false |
| Status | Toggle (Active/Inactive) | Manual | Default active |

**Key Frontend Behaviors:**
- Account Group dropdown filters by selected Account Type (cascade dependency)
- Nature field is auto-populated and read-only
- Opening Balance Type is auto-set to match Nature
- Form validation matches backend rules

---

## 7. RBAC Permissions

| Action | Permission Code |
|--------|----------------|
| Create Ledger Account | `accounting.manage` |
| Update Ledger Account | `accounting.manage` |
| Delete Ledger Account | `accounting.manage` |
| View Ledger Accounts | `accounting.view` |
| View GL Accounts | `accounting.view` |
| View Account Tree | `accounting.view` |
| View Account Details | `accounting.view` |

---

## 8. Audit Trail

All Ledger Account operations are recorded in the `accounting_audit` table:

| Action | Entity Type | Description |
|--------|-------------|-------------|
| CREATE | `account` | Recorded on ledger account creation |
| UPDATE | `account` | Recorded on ledger account update |
| DELETE | `account` | Recorded on ledger account deletion |
| CREATE | `opening_balance` | Recorded when opening balance journal entry is created |

**Audit Log Schema:**
- `id` (PK), `company_id`, `user_id`, `action`, `entity_type`, `entity_id`, `old_values_json`, `new_values_json`, `ip_address`, `session_id`, `created_at`

---

## 9. QA Test Cases

### 9.1 Ledger Account Creation Tests

| # | Test | Expected Result |
|---|------|-----------------|
| 1 | Create asset ledger under asset group | ✅ Success, `allowDirectPosting=true`, `isGroup=false` |
| 2 | Create liability ledger under liability group | ✅ Success |
| 3 | Create equity ledger under equity group | ✅ Success |
| 4 | Create income ledger under income group | ✅ Success |
| 5 | Create expense ledger under expense group | ✅ Success |
| 6 | Create ledger under sub-group (receivable nesting) | ✅ Success |
| 7 | Reject asset ledger under income group | ❌ 400 (type-group mismatch) |
| 8 | Reject liability ledger under asset group | ❌ 400 (type-group mismatch) |
| 9 | Nature auto-derivation: ASSET → DEBIT | ✅ `debitCreditNature=DEBIT` |
| 10 | Nature auto-derivation: LIABILITY → CREDIT | ✅ `debitCreditNature=CREDIT` |
| 11 | Nature auto-derivation: INCOME → CREDIT | ✅ `debitCreditNature=CREDIT` |
| 12 | Nature auto-derivation: EXPENSE → DEBIT | ✅ `debitCreditNature=DEBIT` |
| 13 | Reject duplicate account code | ❌ 400 |
| 14 | Reject empty account name | ❌ 400 |
| 15 | Reject whitespace-only account name | ❌ 400 |
| 16 | Opening balance = 0 | ✅ Success, `openingBalanceEntry=null` |
| 17 | Debit opening balance creates balanced JE | ✅ Dr=Cr=opening_balance |
| 18 | Credit opening balance creates balanced JE | ✅ Dr=Cr=opening_balance |
| 19 | Prevent duplicate OB entries | ✅ Original entry remains balanced |
| 20 | Ledger appears in COA tree | ✅ Tree node with `kind=ledger` |
| 21 | Ledger in GL endpoint | ✅ Listed with `allowDirectPosting=true` |
| 22 | Inactive ledger excluded from GL | ✅ Not in GL list |
| 23 | Historical transactions survive update | ✅ Journal entries retained |
| 24 | Prevent deletion of account with transactions | ❌ 400 |
| 25 | Prevent deletion of system account | ❌ 400 |
| 26 | Prevent modifying system account critical fields | ❌ 400 for type/group/code |
| 27 | Allow non-critical field update on system account | ✅ Success |
| 28 | Deactivate account with transactions | ✅ Success |
| 29 | RBAC: ledger endpoint responds | ✅ Success |
| 30 | Audit log on creation | ✅ Audit record exists |
| 31 | Audit log on update | ✅ Audit record exists |
| 32 | Audit log on deactivation | ✅ Audit record exists |
| 33 | Company isolation | ✅ All accounts scoped to company |
| 34 | Group hierarchy integrity | ✅ All ledgers match parent group type |
| 35 | Atomic creation (account + OB + JE) | ✅ All created in transaction |

---

## 10. Migration

### 029_ledger_account_protected_flag.sql

```sql
-- Add is_system column if not already present
```

**Note:** The `is_system` column was already present in the `accounts` table schema. Migration 029 is a no-op marker for documentation purposes.
