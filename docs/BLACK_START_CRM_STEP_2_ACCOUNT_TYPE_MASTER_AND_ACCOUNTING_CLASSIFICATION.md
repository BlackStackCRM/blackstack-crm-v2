# BLACK START CRM — STEP 2
## ACCOUNT TYPE MASTER & ACCOUNTING CLASSIFICATION WORKFLOW
### Functional Specification & Implementation Workflow

**Document Version:** 1.0  
**Date:** September 7, 2026  
**Author:** Hermes Agent (Nous Research)  
**For:** Black Start CRM Development & Accounting Teams  

---

## TABLE OF CONTENTS

1. Purpose of Account Type Master
2. Primary Account Types
3. Accounting Behaviour Classification Table
4. Account Type Master Screen (UI)
5. Create Account Type — System-Protected Architecture
6. Account Type Codes
7. Account Type → Account Group Dependency
8. Account Type → Nature (Debit/Credit)
9. Account Type → Opening Balance
10. Account Type → Financial Statements
11. Account Type → Transaction Rules
12. Account Type Hierarchy
13. System-Protected Account Types
14. Account Type Status
15. Database Design
16. API / Backend Logic
17. Validation Rules
18. Complete Step 2 Workflow
19. Worked Examples
20. QA Test Cases
21. Final Business Rule

---

## 1. PURPOSE OF ACCOUNT TYPE MASTER

### What Is an Account Type?

An **Account Type** is the highest-level classification in the Black Start CRM accounting hierarchy. It defines the fundamental accounting behaviour of every account beneath it, including:

- **Normal balance** (Debit or Credit)
- **Financial statement** placement (Balance Sheet or Profit & Loss)
- **Transaction posting behaviour** (Dr increases or Cr increases)
- **Opening balance side** (Debit or Credit)

### Key Distinction

The system enforces a strict separation between three concepts:

| Level | Name | Description | System Role |
|-------|------|-------------|-------------|
| **Level 1** | **Account Type** | Highest-level classification (Asset, Liability, Equity, Income, Expense) | Master/Classification |
| **Level 2** | **Account Group** | A grouping of accounts under an Account Type (e.g., "Current Assets" under Asset) | Master/Group |
| **Level 3** | **Ledger Account** | An individual account that can receive debit/credit postings (e.g., "HDFC Bank") | Transactional |

These are **distinct objects with distinct roles**. The system must never confuse them.

### Why Account Type Must Come First

Account Type must be established **before** Account Groups are created because:

1. Every Account Group must belong to exactly one Account Type.
2. The Account Type determines the Nature (Debit/Credit) of the Group.
3. The Account Type determines which financial statement the Group's ledgers appear on.
4. Child Account Groups must inherit or be compatible with the parent's Account Type.
5. Without a valid Account Type, the system cannot enforce any accounting rules.

### Hierarchy Chain

```text
Company
   ↓
Financial Year
   ↓
Account Type          ← STEP 2 (this document)
   ↓
Account Group         ← STEP 3 (preceding spec)
   ↓
Sub Group
   ↓
Ledger Account        ← STEP 3 (preceding spec)
   ↓
Transactions
```

---

## 2. PRIMARY ACCOUNT TYPES

Black Start CRM defines **five primary Account Types**. These are system-defined, immutable classifications that form the foundation of all accounting logic.

| # | Code | Display Name | Normal Balance | Financial Statement |
|---|------|-------------|----------------|---------------------|
| 1 | `ASSET` | Assets | Debit | Balance Sheet |
| 2 | `LIABILITY` | Liabilities | Credit | Balance Sheet |
| 3 | `EQUITY` | Equity / Capital | Credit | Balance Sheet |
| 4 | `INCOME` | Income / Revenue | Credit | Profit & Loss |
| 5 | `EXPENSE` | Expenses | Debit | Profit & Loss |

### 2.1 Assets (`ASSET`)

- **Purpose**: Represents resources owned or controlled by the company that have economic value.
- **Meaning**: Assets are things the business will use to generate revenue or has already received (cash, inventory, receivables, equipment).
- **Examples**: Cash in Hand, Bank Accounts, Accounts Receivable, Inventory, Furniture & Fixtures, Prepaid Rent, Advance Tax.
- **Normal Balance**: Debit
- **Debit Behaviour**: Debit → Increase, Credit → Decrease
- **Financial Statement**: Balance Sheet
- **Child Groups Allowed**: ✅ Yes (Current Assets, Fixed Assets, etc.)
- **Direct Ledger Posting**: ✅ Yes (Cash, Bank, specific receivables)
- **Opening Balances Applicable**: ✅ Yes (almost always — starting balances for asset accounts)

### 2.2 Liabilities (`LIABILITY`)

- **Purpose**: Represents obligations the company owes to external parties.
- **Meaning**: Liabilities are amounts the business must pay to creditors, loans, taxes, and other parties.
- **Examples**: Bank Loans, Accounts Payable, Credit Card Balances, GST Payable, Salaries Outstanding, Tax Payable.
- **Normal Balance**: Credit
- **Debit Behaviour**: Debit → Decrease, Credit → Increase
- **Financial Statement**: Balance Sheet
- **Child Groups Allowed**: ✅ Yes (Current Liabilities, Long-term Loans, etc.)
- **Direct Ledger Posting**: ✅ Yes (specific payables, loan accounts)
- **Opening Balances Applicable**: ✅ Yes (starting balances for liability accounts)

### 2.3 Equity / Capital (`EQUITY`)

- **Purpose**: Represents the owner's claim on the company's assets after liabilities are deducted.
- **Meaning**: Equity includes capital contributed by owners, retained earnings, and reserves.
- **Examples**: Owner Capital, drawings, retained earnings, share capital, general reserve.
- **Normal Balance**: Credit
- **Debit Behaviour**: Debit → Decrease, Credit → Increase
- **Financial Statement**: Balance Sheet
- **Child Groups Allowed**: ✅ Yes (Capital, Reserves, Retained Earnings)
- **Direct Ledger Posting**: ⚠️ Limited — mainly for Capital, Drawings, Retained Earnings
- **Opening Balances Applicable**: ✅ Yes (capital contributed, retained earnings brought forward)

### 2.4 Income / Revenue (`INCOME`)

- **Purpose**: Represents earnings from the company's primary business activities.
- **Meaning**: Income accounts track revenue generated from sales, services, and other operating activities.
- **Examples**: Sales Revenue, Service Income, Interest Income, Miscellaneous Income, Discount Received.
- **Normal Balance**: Credit
- **Debit Behaviour**: Debit → Decrease, Credit → Increase
- **Financial Statement**: Profit & Loss (revenue side)
- **Child Groups Allowed**: ✅ Yes (Operating Income, Non-operating Income, etc.)
- **Direct Ledger Posting**: ✅ Yes (individual revenue accounts)
- **Opening Balances Applicable**: ⚠️ Rare — only for businesses starting mid-year with existing contracts/receivables
- **Closing Behaviour**: Closed to Retained Earnings at year-end

### 2.5 Expenses (`EXPENSE`)

- **Purpose**: Represents the cost of resources consumed in generating income.
- **Meaning**: Expense accounts track all costs incurred in the operation of the business.
- **Examples**: Salary, Office Rent, Utilities, Advertising, Depreciation, Insurance, Bank Charges, Cost of Goods Sold.
- **Normal Balance**: Debit
- **Debit Behaviour**: Debit → Increase, Credit → Decrease
- **Financial Statement**: Profit & Loss (expense side)
- **Child Groups Allowed**: ✅ Yes (Operating Expenses, Administrative Expenses, Selling Expenses, Direct Expenses)
- **Direct Ledger Posting**: ✅ Yes (individual expense accounts)
- **Opening Balances Applicable**: ⚠️ Rare — only for prepaid expenses carried forward
- **Closing Behaviour**: Closed to Income Summary (then Retained Earnings) at year-end

---

## 3. ACCOUNTING BEHAVIOUR

### Classification Table

| Account Type | Normal Balance | Debit Effect | Credit Effect | Financial Statement |
|---|---|---|---|---|
| Assets | Debit | Increase | Decrease | Balance Sheet |
| Liabilities | Credit | Decrease | Increase | Balance Sheet |
| Equity / Capital | Credit | Decrease | Increase | Balance Sheet |
| Income / Revenue | Credit | Decrease | Increase | Profit & Loss |
| Expenses | Debit | Increase | Decrease | Profit & Loss |

### Business Logic Explanation

- **Assets** and **Expenses** follow the **Debit-normal** convention: debits increase, credits decrease.
- **Liabilities**, **Equity**, and **Income** follow the **Credit-normal** convention: credits increase, debits decrease.
- This is derived from the **accounting equation**:

  ```
  Assets = Liabilities + Equity + (Income - Expenses)
  ```

  - An increase on the left (Assets) must be matched by an increase on the right. Since the right side is credit-normal for Liabilities/Equity/Income and debit-normal for Expenses, the left side (Assets) must be debit-normal to maintain balance.
  - This rule is **hardcoded into the Black Start CRM accounting engine** and validated server-side on every transaction.

### Consistency Enforcement

The system uses these rules in **three critical places**:

1. **Chart of Accounts** — When creating Account Groups and Ledger Accounts, the type determines the default `debit_credit_nature` field.
2. **Transaction Posting** — Every journal entry validates that debits and credits balance, and that the posting direction is valid for the account's type.
3. **Opening Balance** — When entering opening balances, the system validates that the balance type (Debit/Credit) is compatible with the account's normal balance.

---

## 4. ACCOUNT TYPE MASTER SCREEN

### Navigation Path

```text
Accounting
   → Chart of Accounts
      → Account Types
```

### Screen Layout

```text
┌─────────────────────────────────────────────────────────────────┐
│ ACCOUNT TYPES                                           [🔍] │
├────┬──────────┬─────────┬──────────┬────────────────┬───────┤
│ Icon │ Code   │ Name    │ Nature   │ Financial Stmt │ Status │
├────┼──────────┼─────────┼──────────┼────────────────┼───────┤
│ 📁  │ ASSET    │ Assets  │ Debit    │ Balance Sheet  │ Active │
│ 📁  │ LIABILITY│ Liabilit│ Credit   │ Balance Sheet  │ Active │
│ 📁  │ EQUITY   │ Equity  │ Credit   │ Balance Sheet  │ Active │
│ 📁  │ INCOME   │ Income  │ Credit   │ P&L            │ Active │
│ 📁  │ EXPENSE  │ Expense │ Debit    │ P&L            │ Active │
└────┴──────────┴─────────┴──────────┴────────────────┴───────┘
```

### Column Definitions

| Column | Display | Purpose |
|--------|---------|---------|
| Icon | 📁 | Visual indicator — always a folder (highest-level container) |
| Code | ASSET / LIABILITY / etc. | Stable internal identifier |
| Name | Assets / Liabilities / etc. | Human-readable display name |
| Nature | Debit / Credit | Derived from normal balance — shown for quick reference |
| Financial Statement | Balance Sheet / P&L | Where accounts of this type appear in reports |
| Number of Groups | Number | Count of Account Groups assigned to this type |
| Number of Ledgers | Number | Count of Ledger Accounts assigned to this type |
| Status | Active | Always Active — system types cannot be deactivated |

> **Note**: Unlike Account Groups and Ledger Accounts, the Account Type Master screen does **not** have Create/Edit/Delete buttons. Account Types are system-defined and immutable. The screen serves as a **reference and validation view** only.

---

## 5. CREATE ACCOUNT TYPE — SYSTEM-PROTECTED ARCHITECTURE

### Architecture Decision

**Recommendation: Account Types should be system-defined and non-editable.**

Two options were considered:

### Option A: System-Defined and Non-Editable

- Account Types are hardcoded in the application backend.
- The `VALID_ACCOUNT_TYPES` array in `server/controllers/accounting.controller.js` (line 18) defines the valid set.
- Account Types are seeded into the database during `createDefaultChartOfAccounts()`.
- Users cannot create, edit, or delete Account Types.

### Option B: User-Configurable

- Users can create custom Account Types.
- Requires a dedicated `account_types` table with CRUD endpoints.
- Risk of accounting inconsistency if users create invalid types.

### Recommended Implementation: Option A

**Reason**: The five primary Account Types are defined by standard double-entry bookkeeping accounting principles and exist universally across all accounting systems. Allowing users to create arbitrary types would risk:

1. Breaking the accounting equation.
2. Making reports meaningless (e.g., a custom "Asset" type with Credit normal balance).
3. Violating double-entry integrity.
4. Creating confusion in financial reporting.

This is consistent with professional systems like **Tally**, where the five account types (Assets, Liabilities, Capital, Income, Expenditure) are **fixed in the base configuration** and cannot be added, removed, or restructured by end users.

### Current Implementation in Black Start CRM

The current Black Start CRM codebase already follows **Option A**:

- **Backend** (`server/controllers/accounting.controller.js`, line 18):
  ```js
  const VALID_ACCOUNT_TYPES = ['CASH', 'BANK', 'ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
  ```

- **Frontend** (`public/js/pages/chart-of-accounts.js`, lines 71–75):
  ```html
  <option value="ASSET">Asset</option>
  <option value="LIABILITY">Liability</option>
  <option value="EQUITY">Equity</option>
  <option value="INCOME">Income</option>
  <option value="EXPENSE">Expense</option>
  ```

- **Repository** (`server/repositories/chart-of-accounts.repository.js`):
  - `createDefaultChartOfAccounts()` seeds the five primary types and their groups/accounts.

### Clarification: CASH and BANK Types

The backend `VALID_ACCOUNT_TYPES` array includes `CASH` and `BANK`, but these are **sub-classifications** used for specific Ledger Accounts (e.g., "Cash in Hand", "HDFC Bank"). In the current implementation:

- `CASH` and `BANK` are used in the `accounts.type` field as **specializations** of `ASSET`.
- They are **not** presented as top-level Account Type options in the frontend dropdown.
- The frontend `Account Type` dropdown shows only the five primary types: ASSET, LIABILITY, EQUITY, INCOME, EXPENSE.

**This ambiguity should be resolved in the specification**:

- **Account Type Master** supports only: `ASSET`, `LIABILITY`, `EQUITY`, `INCOME`, `EXPENSE`.
- `CASH` and `BANK` are **Account Categories** (a sub-attribute of Asset-type accounts), not Account Types.
- The `accounts.type` field should always use one of the five primary types.
- A separate `is_cash` or `account_class` field should handle the CASH/BANK distinction.

> **Recommendation for future refactoring**: Introduce an `account_class` ENUM field on `accounts` and `account_groups` for CASH/BANK/INVESTMENT classifications, keeping `type` restricted to the five primary types.

---

## 6. ACCOUNT TYPE CODES

### Stable Internal Codes

| Code | Description |
|------|-------------|
| `ASSET` | Assets — resources owned by the company |
| `LIABILITY` | Liabilities — obligations owed by the company |
| `EQUITY` | Equity / Capital — owner's claim on assets |
| `INCOME` | Income / Revenue — earnings from business activities |
| `EXPENSE` | Expenses — costs of generating revenue |

### Why Stable Codes Matter

1. **Display names can change**: An admin might rename "Equity / Capital" to "Owner's Equity" for localization. The internal code `EQUITY` remains the same.
2. **Report logic**: Financial reports use the code to determine which accounts to aggregate. `WHERE type IN ('ASSET', 'LIABILITY', 'EQUITY')` for Balance Sheet.
3. **Transaction validation**: The posting engine checks `type = 'ASSET'` to determine Debit-increase behaviour.
4. **API contracts**: Integrations use the code, not the display name, to reference account types.

### Code Format

- **Case**: UPPERCASE (e.g., `ASSET`, not `asset`)
- **Length**: 10 characters maximum
- **No spaces or special characters**
- **No localization** — codes are language-independent

---

## 7. ACCOUNT TYPE → ACCOUNT GROUP DEPENDENCY

### Critical Workflow

When creating an Account Group, the user must explicitly select an Account Type:

```text
Create Account Group
        ↓
Select Account Type          ← Dropdown: ASSET, LIABILITY, EQUITY, INCOME, EXPENSE
        ↓
System loads valid Account Type
        ↓
Auto-derive: Normal Balance, Nature, Financial Statement
        ↓
Create Group
```

### Filtering Logic

#### When Account Type = ASSET

Valid Account Groups (examples):

```text
Current Assets
Fixed Assets
Cash & Cash Equivalents
Accounts Receivable
Inventory
Prepaid Expenses
```

The system **only displays groups** where `type = 'ASSET'`.

#### When Account Type = EXPENSE

Valid Account Groups (examples):

```text
Direct Expenses
Operating Expenses
Administrative Expenses
Selling Expenses
Distribution Expenses
Finance Expenses
```

The system **only displays groups** where `type = 'EXPENSE'`.

### Backend Enforcement

In `server/controllers/accounting.controller.js`, the `createAccountGroup` method must:

1. Validate that `req.body.type` is in `VALID_ACCOUNT_TYPES`.
2. Reject any request with an invalid type.
3. Store the type in the `account_groups.type` column.
4. Auto-compute and store `debit_credit_nature` based on the type:
   ```js
   const debitCreditNature = type === 'LIABILITY' || type === 'EQUITY' || type === 'INCOME' 
     ? 'CREDIT' 
     : 'DEBIT';
   ```

### Frontend Behavior

In the Account Group creation form (`public/js/pages/chart-of-accounts.js`, lines 430–434):

```html
<option value="ASSET"      ${group.type === 'ASSET'      ? 'selected' : ''}>Asset</option>
<option value="LIABILITY"  ${group.type === 'LIABILITY'  ? 'selected' : ''}>Liability</option>
<option value="EQUITY"     ${group.type === 'EQUITY'     ? 'selected' : ''}>Equity</option>
<option value="INCOME"     ${group.type === 'INCOME'     ? 'selected' : ''}>Income</option>
<option value="EXPENSE"    ${group.type === 'EXPENSE'    ? 'selected' : ''}>Expense</option>
```

### Parent Group Type Validation

When a user specifies a **Parent Group**, the system must:

1. Load the parent group's `type`.
2. **Enforce**: The child group's `type` must match the parent's `type`.
3. **Reject**: If types don't match (e.g., trying to make an `EXPENSE` group a child of an `ASSET` group), the system shows an error.

```text
ERROR: "Parent Group is of type 'Assets'. Child groups must also be of type 'Assets'."
```

This is enforced in `server/services/account-group.service.js` via the `validateTypeInheritance()` method.

---

## 8. ACCOUNT TYPE → NATURE (DEBIT/CREDIT)

### Definition of Nature

**"Nature"** in Black Start CRM refers to the **normal balance side** of an account type:

- **Debit Nature**: The account increases when debited, decreases when credited.
- **Credit Nature**: The account increases when credited, decreases when debited.

### Auto-Derivation Rules

| Account Type | Nature | Derivation Rule |
|---|---|---|
| ASSET | Debit | Default (Debit) |
| EXPENSE | Debit | Default (Debit) |
| LIABILITY | Credit | Credit (rule: LIAB, EQUITY, INCOME → Credit) |
| EQUITY | Credit | Credit (rule: LIAB, EQUITY, INCOME → Credit) |
| INCOME | Credit | Credit (rule: LIAB, EQUITY, INCOME → Credit) |

### Implementation

In the backend (`server/controllers/accounting.controller.js`, line 212):

```js
const debitCreditNature = type === 'LIABILITY' || type === 'EQUITY' || type === 'INCOME' 
  ? 'CREDIT' 
  : 'DEBIT';
```

This is applied at:

1. **Account Group creation** — stored in `account_groups.debit_credit_nature`
2. **Ledger Account creation** — stored in `accounts.debit_credit_nature`
3. **Opening Balance entry** — validated against the account's Nature
4. **Transaction posting** — used to determine if a posting direction is valid

### User Override

**Recommended**: Nature should be **read-only and auto-derived**. Users should **not** be allowed to override it because:

1. It violates fundamental accounting principles.
2. It would break financial reporting.
3. It would make the accounting equation unbalanced.

If a user truly needs a different Nature, they should select a different Account Type (e.g., if they need a Credit-nature expense, they should reclassify the account as Income).

### Audit Logging

Any manual override of Nature should:

- Require `accounting.manage` permission (beyond default).
- Show a prominent warning: "Changing the Nature of an account type violates standard accounting principles and may cause reporting errors."
- Record an audit log entry.

> **Current Implementation**: Nature is auto-derived only. No user override exists in the current codebase. This is the correct default.

---

## 9. ACCOUNT TYPE → OPENING BALANCE

### How Account Type Affects Opening Balance

The Account Type determines the **valid side** for opening balances:

| Account Type | Valid Opening Balance Side | Reason |
|---|---|---|
| ASSET | Debit | Normal balance is Debit — opening balance must be a Debit balance |
| EXPENSE | Debit | Normal balance is Debit — opening balance must be a Debit balance |
| LIABILITY | Credit | Normal balance is Credit — opening balance must be a Credit balance |
| EQUITY | Credit | Normal balance is Credit — opening balance must be a Credit balance |
| INCOME | Credit | Normal balance is Credit — opening balance must be a Credit balance |

### Validation Rule

When entering an opening balance for a Ledger Account, the system validates:

```text
IF account.type IN ('LIABILITY', 'EQUITY', 'INCOME') THEN opening_balance_type MUST be 'CREDIT'
IF account.type IN ('ASSET', 'EXPENSE') THEN opening_balance_type MUST BE 'DEBIT'
```

If the user enters an opening balance on the **wrong side**, the system shows:

```text
ERROR: "Opening balance type 'Credit' is not valid for an Asset account. Asset accounts typically have Debit balances."

[Override] [Cancel]
```

The override requires `accounting.manage` permission and is logged.

### Opening Balance Side Auto-Select

When the user selects a Ledger Account and enters an opening balance:

1. The system reads the account's `type`.
2. Based on `type`, it auto-selects the correct `opening_balance_type`:
   - `ASSET` or `EXPENSE` → `DEBIT`
   - `LIABILITY`, `EQUITY`, `INCOME` → `CREDIT`
3. The `opening_balance_type` dropdown is pre-filled and **locked**.
4. The user can only change it with explicit override + permission.

### Implementation Reference

In `server/controllers/accounting.controller.js`, line 156:

```js
const debitCreditNature = row.debit_credit_nature || (
  row.type === 'LIABILITY' || 
  row.type === 'EQUITY' || 
  row.type === 'INCOME' 
    ? 'CREDIT' 
    : 'DEBIT'
);
```

This same logic should be applied when setting `opening_balance_type` defaults.

### Practical Examples

#### Asset Opening Balance

```text
Account: HDFC Bank
Type: ASSET
Opening Balance: ₹1,00,000
Opening Balance Type: Debit  ← Auto-selected, locked
```

#### Liability Opening Balance

```text
Account: Business Loan (Bank of Baroda)
Type: LIABILITY
Opening Balance: ₹5,00,000
Opening Balance Type: Credit  ← Auto-selected, locked
```

#### Equity Opening Balance

```text
Account: Owner Capital
Type: EQUITY
Opening Balance: ₹10,00,000
Opening Balance Type: Credit  ← Auto-selected, locked
```

#### Income Opening Balance (rare)

```text
Account: Advance Rent Received
Type: INCOME
Opening Balance: ₹50,000
Opening Balance Type: Credit  ← Auto-selected, locked
```

#### Expense Opening Balance (rare)

```text
Account: Prepaid Insurance
Type: EXPENSE
Opening Balance: ₹12,000
Opening Balance Type: Debit  ← Auto-selected, locked
```

---

## 10. ACCOUNT TYPE → FINANCIAL STATEMENTS

### Statement Assignment

| Account Type | Financial Statement | Section |
|---|---|---|
| ASSET | Balance Sheet | Assets |
| LIABILITY | Balance Sheet | Liabilities |
| EQUITY | Balance Sheet | Equity |
| INCOME | Profit & Loss | Revenue |
| EXPENSE | Profit & Loss | Expenses |

### How the Chart of Accounts Feeds Reporting

The reporting engine uses Account Type to determine where each account appears:

```text
Balance Sheet Query:
SELECT accounts.* 
FROM accounts 
WHERE type IN ('ASSET', 'LIABILITY', 'EQUITY')

Profit & Loss Query:
SELECT accounts.*
FROM accounts
WHERE type IN ('INCOME', 'EXPENSE')
```

### Balance Sheet Structure

```text
BALANCE SHEET
─────────────────────────────────
ASSETS
  Current Assets
    ├─ Cash in Hand
    ├─ Bank Accounts
    └─ Accounts Receivable
  Fixed Assets
    └─ Furniture & Fixtures

LIABILITIES
  Current Liabilities
    ├─ Accounts Payable
    └─ GST Payable
  Long-term Loans

EQUITY / CAPITAL
  ├─ Owner Capital
  └─ Retained Earnings
```

### Profit & Loss Structure

```text
PROFIT & LOSS STATEMENT
─────────────────────────────────
INCOME
  Sales Revenue
  Service Income

EXPENSES
  Purchase of Goods
  Salaries
  Rent
  Utilities
```

### Net Profit/Loss Calculation

```text
Net Profit = (Income - Expenses)

If Income > Expenses → Net Profit (Credit balance carried to Retained Earnings)
If Expenses > Income → Net Loss (Debit balance carried to Retained Earnings)
```

### Balance Sheet Validation

```text
Total Assets = Total Liabilities + Equity + (Income - Expenses)

This equation must ALWAYS balance. The system validates this on every journal entry.
```

---

## 11. ACCOUNT TYPE → TRANSACTION RULES

### Posting Behaviour by Account Type

The accounting engine uses Account Type to validate every debit/credit posting:

#### Asset Accounts

```text
Dr → Increase balance
Cr → Decrease balance
```

**Example**: Purchasing equipment for cash

```text
Dr. Equipment (Asset)  ₹50,000
    Cr. Bank (Asset)      ₹50,000
(One asset increases, another decreases — equation stays balanced)
```

#### Liability Accounts

```text
Cr → Increase balance
Dr → Decrease balance
```

**Example**: Taking a loan from the bank

```text
Dr. Bank (Asset)       ₹2,00,000
    Cr. Bank Loan (Liability) ₹2,00,000
(Asset increases to match liability increase)
```

#### Equity Accounts

```text
Cr → Increase balance
Dr → Decrease balance
```

**Example**: Owner investing cash

```text
Dr. Bank (Asset)       ₹5,00,000
    Cr. Owner Capital (Equity) ₹5,00,000
```

#### Income Accounts

```text
Cr → Increase balance
Dr → Decrease balance
```

**Example**: Providing services on credit

```text
Dr. Accounts Receivable (Asset) ₹1,00,000
    Cr. Service Revenue (Income)  ₹1,00,000
```

#### Expense Accounts

```text
Dr → Increase balance
Cr → Decrease balance
```

**Example**: Paying office rent

```text
Dr. Rent Expense (Expense) ₹25,000
    Cr. Bank (Asset)           ₹25,000
```

### Transaction Validation Rules

1. **Debits must equal Credits** — Every journal entry must have equal total debits and credits.
2. **Account Type determines valid posting side** — A Debit entry on a Credit-nature account (Liability) decreases it; a Credit entry increases it.
3. **No direct Account Type posting** — Transactions must be posted to valid Ledger Accounts, not to Account Types directly.
4. **Opening entry validation** — Opening balances must be on the correct side for the account's type.

### Implementation in Backend

In `server/controllers/accounting.controller.js`:

```js
// Validate transaction type compatibility
const debitCreditNature = row.debit_credit_nature || (
  row.type === 'LIABILITY' || row.type === 'EQUITY' || row.type === 'INCOME'
    ? 'CREDIT'
    : 'DEBIT'
);
```

When posting a journal entry, the system:

1. Looks up the account's `type` and `debit_credit_nature`.
2. Determines the effect of the posting direction.
3. Updates the running balance.
4. Validates the accounting equation is still balanced.

---

## 12. ACCOUNT TYPE HIERARCHY

### Position in the Hierarchy

Account Types sit at the **highest level** of the accounting classification hierarchy:

```text
Level 1: Account Type         (e.g., Assets, Liabilities)
   ↓
Level 2: Account Group        (e.g., Current Assets, Fixed Assets)
   ↓
Level 3: Sub Group            (e.g., Cash & Bank, Accounts Receivable)
   ↓
Level 4: Ledger Account       (e.g., HDFC Bank, SBI Bank)
   ↓
Level 5: Transaction          (individual debit/credit entries)
```

### Example: Full Hierarchy for Assets

```text
ASSET (Account Type)
├── Current Assets (Account Group)
│   ├── Cash & Bank (Sub Group)
│   │   ├── Cash in Hand (Ledger)
│   │   ├── HDFC Bank (Ledger)
│   │   └── SBI Bank (Ledger)
│   └── Accounts Receivable (Sub Group)
│       ├── Customer: ABC Corp (Ledger)
│       └── Customer: XYZ Ltd (Ledger)
└── Fixed Assets (Account Group)
    └── Furniture & Fixtures (Sub Group)
        └── Office Furniture (Ledger)
```

### Type Inheritance

- **Account Groups** inherit the type of their parent or are explicitly assigned one at creation.
- **Sub Groups** must match the type of their parent Group.
- **Ledger Accounts** inherit the type from their parent Group (or Account Group).
- **Transactions** use the type to validate posting behaviour.

### Cross-Type Prevention

The system prevents invalid hierarchies:

```text
❌ INVALID: Expense Group as child of Asset Group
   - Expenses group has type=EXPENSE
   - Parent Assets group has type=ASSET
   - Rejected: child type must match parent type

✅ VALID: "Current Assets" as child of "Assets"
   - Both have type=ASSET
   - Accepted
```

This is enforced in:

- **Backend**: `server/services/account-group.service.js` → `validateTypeInheritance()`
- **Frontend**: `_loadParentGroups()` filters out groups of different types
- **Repository**: SQL queries filter by `type` for parent-child consistency

---

## 13. SYSTEM-PROTECTED ACCOUNT TYPES

### Protection Rules

Account Types are **system-protected** and cannot be modified by users. The following operations are **always rejected**:

| Operation | Behaviour | Reason |
|---|---|---|
| **Create Account Type** | Rejected | Types are fixed by accounting standards |
| **Edit Account Type Name** | Rejected | Would break report logic |
| **Edit Account Type Code** | Rejected | Stable identifier required for integrations |
| **Edit Normal Balance** | Rejected | Violates double-entry principles |
| **Edit Financial Statement** | Rejected | Would misclassify accounts in reports |
| **Change Nature** | Rejected (unless override + permission) | Could break transaction validation |
| **Delete Account Type** | Rejected | Used by existing Groups and Ledgers |
| **Deactivate Account Type** | N/A | Types are always Active |

### Rationale

These restrictions exist because:

1. The five Account Types represent **universal accounting principles** — they are not configurable per company.
2. Allowing modifications would let users break the **accounting equation**: `Assets = Liabilities + Equity + (Income - Expenses)`.
3. Financial reports depend on these types for correct aggregation and presentation.
4. Transaction posting validation depends on the correct Nature for each type.

### Exception: Custom Account Types (Future Enhancement)

If multi-industry support is needed in the future, a **separate** custom type system could be introduced:

```text
account_type_masters table:
  id, code, name, normal_balance, financial_statement, is_system, is_active, company_id
```

Custom types would be `is_system = 0`, while the five standard types remain `is_system = 1` and immutable.

---

## 14. ACCOUNT TYPE STATUS

### Status Values

| Status | Description | Behaviour |
|---|---|---|
| **Active** | Available for Group and Ledger creation | ✅ Can create new groups and ledgers under this type |
| **Inactive** | Not available for new creation | ⚠️ Existing groups/ledgers remain accessible; new creation blocked |

### System Types Are Always Active

Since Account Types are system-defined, they have only one status:

**Recommended Implementation**: All five Account Types are **permanently Active**. There is no Inactive status for system types.

This simplifies the system and prevents accidental blocking of critical accounting functionality.

If an account type were deactivated:

- Users could not create new Account Groups of that type.
- But existing groups and ledgers would still function.
- Reports would still include accounts of the inactive type.

This could lead to inconsistent data. Therefore:

> **All five Account Types are permanently Active. No status toggle exists.**

### Future Consideration

If the system ever supports custom account types (see §13), those custom types could have Active/Inactive status with appropriate guards.

---

## 15. DATABASE DESIGN

### Current Implementation

Account Types are **not stored in a dedicated table**. Instead, they are:

1. **Hardcoded** in `server/controllers/accounting.controller.js` as the `VALID_ACCOUNT_TYPES` array.
2. **Stored as a `type` TEXT column** in both `account_groups` and `accounts` tables.
3. **Seeded** during `createDefaultChartOfAccounts()`.

### Current Schema (Relevant Columns)

```sql
-- account_groups table
type TEXT NOT NULL
debit_credit_nature TEXT NOT NULL

-- accounts table
type TEXT NOT NULL
debit_credit_nature TEXT NOT NULL
```

### Recommended Future Enhancement: account_types Table

For a more robust architecture, introduce a dedicated `account_types` table:

```sql
CREATE TABLE account_types (
    id TEXT PRIMARY KEY,               -- e.g., 'asset', 'liability'
    code TEXT NOT NULL UNIQUE,          -- e.g., 'ASSET', 'LIABILITY'
    name TEXT NOT NULL,                 -- e.g., 'Assets'
    description TEXT,                   -- e.g., 'Resources owned by the company'
    normal_balance TEXT NOT NULL,       -- 'DEBIT' or 'CREDIT'
    financial_statement TEXT NOT NULL,    -- 'BALANCE_SHEET' or 'PROFIT_LOSS'
    is_system INTEGER DEFAULT 1,        -- 1 = immutable system type
    is_active INTEGER DEFAULT 1,        -- 1 = active
    sort_order INTEGER,                 -- display order
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Relationships

```sql
-- account_groups references account_types
ALTER TABLE account_groups 
ADD CONSTRAINT fk_account_groups_type 
FOREIGN KEY (type) REFERENCES account_types(code);

-- accounts references account types (indirectly through groups)
```

### Seed Data

```sql
INSERT INTO account_types (code, name, normal_balance, financial_statement, is_system) VALUES
('ASSET',     'Assets',            'DEBIT',  'BALANCE_SHEET', 1),
('LIABILITY', 'Liabilities',       'CREDIT', 'BALANCE_SHEET', 1),
('EQUITY',    'Equity / Capital',  'CREDIT', 'BALANCE_SHEET', 1),
('INCOME',    'Income / Revenue',  'CREDIT', 'PROFIT_LOSS',    1),
('EXPENSE',   'Expenses',          'DEBIT',  'PROFIT_LOSS',    1);
```

### Foreign Key Constraints

The `account_groups.type` and `accounts.type` fields should reference `account_types.code`:

```sql
-- When creating an Account Group:
-- type must exist in account_types table
-- type must be active
-- type cannot be a system type's normal_balance or financial_statement modified
```

### Current Reality

Since there is **no `account_types` table** in the current Black Start CRM database, the system relies on:

- **Application-level validation** (`VALID_ACCOUNT_TYPES` array)
- **`type` column** on `account_groups` and `accounts` tables
- **No referential integrity** at the database level

This works for the current scope but should be refactored to a proper `account_types` table for production use.

---

## 16. API / BACKEND LOGIC

### Current Endpoints

While there is no dedicated Account Types API endpoint, the Account Type concept is used across multiple endpoints:

| Endpoint | Method | Account Type Usage |
|---|---|---|
| `/api/accounting/groups` | POST | Validate `type` against `VALID_ACCOUNT_TYPES` |
| `/api/accounting/groups/:id` | PUT | Validate `type` against `VALID_ACCOUNT_TYPES` |
| `/api/accounting/accounts` | POST | Validate `type` against `VALID_ACCOUNT_TYPES` |
| `/api/accounting/accounts/gl` | GET | Filter by `type` (returns posting accounts only) |

### Proposed: Account Types API (Future Enhancement)

If the `account_types` table is introduced, add:

```http
GET /api/accounting/account-types
Response: [{ id, code, name, normal_balance, financial_statement, is_system, is_active }]

GET /api/accounting/account-types/{code}
Response: { id, code, name, description, normal_balance, financial_statement, is_system, is_active }

GET /api/accounting/account-types?active=true
Response: [filtered list of active types]
```

### Backend Validation on Account Group Creation

```http
POST /api/accounting/groups
Body: {
    code: "1100",
    name: "Current Assets",
    type: "ASSET",           ← must be in VALID_ACCOUNT_TYPES
    parent_id: "2",
    ...
}
```

The backend (`server/controllers/accounting.controller.js`):

1. Validates `type` is in `VALID_ACCOUNT_TYPES`.
2. If `parent_id` is provided, loads the parent group.
3. Validates the parent's `type` matches the child's `type`.
4. Auto-derives `debit_credit_nature` from `type`.
5. Creates the group.

### Backend Validation on Ledger Account Creation

```http
POST /api/accounting/accounts
Body: {
    code: "11001",
    name: "HDFC Bank",
    type: "ASSET",           ← must be in VALID_ACCOUNT_TYPES
    account_group_id: "3",
    debit_credit_nature: "DEBIT",  ← auto-derived, not user-set
    opening_balance: 100000,
    opening_balance_type: "DEBIT", ← validated against type
    ...
}
```

Validation steps:

1. Validate `type` is in `VALID_ACCOUNT_TYPES`.
2. Load the parent group, verify `type` matches.
3. Auto-derive `debit_credit_nature` from `type` (ignore user-provided value).
4. Validate `opening_balance_type` matches the type's normal balance.
5. Set `is_group = 0` (ledger accounts are never groups).
6. Set `allow_direct_posting = 1` (ledger accounts can receive postings).

### Controller Code Reference

In `server/controllers/accounting.controller.js`, line 212:

```js
const debitCreditNature = type === 'LIABILITY' || type === 'EQUITY' || type === 'INCOME' 
  ? 'CREDIT' 
  : 'DEBIT';
```

This derivation is used for both Account Groups and Ledger Accounts.

---

## 17. VALIDATION RULES

### Validation Table

| # | Validation | Expected Behaviour | Error Message |
|---|---|---|---|
| 1 | Invalid Account Type code | Reject with 400 | `"Invalid account type. Valid types: ASSET, LIABILITY, EQUITY, INCOME, EXPENSE"` |
| 2 | Missing Account Type | Reject with 400 | `"Account Type is required"` |
| 3 | Account Type on child not matching parent | Reject with 400 | `"Child account type 'EXPENSE' does not match parent type 'ASSET'"` |
| 4 | Attempt to delete system Account Type | Reject — not possible via API | `"System account types cannot be deleted"` |
| 5 | Attempt to change system type Normal Balance | Reject — not possible | `"Account type properties cannot be modified"` |
| 6 | Invalid Nature override | Reject without permission | `"Invalid Nature override. Contact administrator."` |
| 7 | Opening Balance Type mismatch | Reject or warn | `"Opening balance type 'Credit' is invalid for ASSET type. Override requires permission."` |
| 8 | Inactive Account Type used | Reject for new Groups | `"Account type 'ASSET' is inactive and cannot be used for new groups"` |
| 9 | Duplicate Account Type code | N/A — system types are unique | Not applicable |
| 10 | Account Type used by existing Groups | Cannot change nature | `"Account type has existing groups and ledgers. Structural changes not allowed."` |

### Business Logic Validation Summary

1. **Type must be valid**: Must be one of `ASSET`, `LIABILITY`, `EQUITY`, `INCOME`, `EXPENSE`.
2. **Type must be consistent**: Parent and child must have the same type.
3. **Nature must be auto-derived**: Never trust user input for `debit_credit_nature`.
4. **Opening balance must be on correct side**: Validated against the account's type-derived nature.
5. **Types are immutable**: No create/edit/delete allowed via API.

---

## 18. COMPLETE STEP 2 WORKFLOW

```text
STEP 1
Company & Financial Year Setup
         ↓
STEP 2
Open Account Type Master
         ↓
[1] Load System Account Types
         │  - ASSET → Debit, Balance Sheet
         │  - LIABILITY → Credit, Balance Sheet
         │  - EQUITY → Credit, Balance Sheet
         │  - INCOME → Credit, Profit & Loss
         │  - EXPENSE → Debit, Profit & Loss
         ↓
[2] Validate Account Type Configuration
         │  - All 5 types present
         │  - All types Active
         │  - Nature auto-derived
         ↓
[3] Determine Normal Balance
         │  - ASSET, EXPENSE → Debit
         │  - LIABILITY, EQUITY, INCOME → Credit
         ↓
[4] Determine Nature (Debit/Credit)
         │  - Stored as debit_credit_nature
         │  - Auto-computed from type
         ↓
[5] Determine Financial Statement
         │  - ASSET, LIABILITY, EQUITY → Balance Sheet
         │  - INCOME, EXPENSE → Profit & Loss
         ↓
[6] Enable Account Group Creation
         │  - User can now create Account Groups
         │  - Account Group must select an Account Type
         │  - Type filters available parent groups
         ↓
[7] Account Group selects Account Type
         │  - Validation: type must match parent
         │  - Auto-derivation: Nature, Financial Statement
         ↓
[8] Account Group validated
         ↓
[9] Enable Ledger Account Creation
         │  - Ledger inherits Type from its Group
         │  - Type determines opening balance side
         │  - Type validates transaction posting
         ↓
[10] Ledger Account inherits valid Account Type
         ↓
[11] Opening Balance validated against Type
         ↓
[12] Transaction Posting validated against Type
```

---

## 19. WORKED EXAMPLES

### Example 1: Assets → Bank → HDFC Bank

```text
Step 2: Account Type
Type = ASSET
Normal Balance = Debit
Nature = Debit
Financial Statement = Balance Sheet

Step 3: Account Group (under ASSET)
Group: "Cash & Bank"
Type = ASSET (inherited)
Nature = Debit (auto-derived)

Step 3: Ledger Account (under "Cash & Bank")
Account: "HDFC Bank"
Type = ASSET (inherited from group)
Nature = Debit (auto-derived)
Opening Balance = ₹1,00,000
Opening Balance Type = Debit  ← Valid: asset accounts debit-balance
Financial Statement = Balance Sheet

Transaction: Deposit ₹50,000
Dr. HDFC Bank (Asset) ₹50,000  ← Debit increases asset ✓
    Cr. Cash in Hand (Asset) ₹50,000 ← Credit decreases asset ✓
```

### Example 2: Liabilities → Loans → Bank Loan

```text
Step 2: Account Type
Type = LIABILITY
Normal Balance = Credit
Nature = Credit
Financial Statement = Balance Sheet

Step 3: Account Group (under LIABILITY)
Group: "Loans & Advances"
Type = LIABILITY (inherited)
Nature = Credit (auto-derived)

Step 3: Ledger Account (under "Loans & Advances")
Account: "Bank Loan (SBI)"
Type = LIABILITY (inherited)
Nature = Credit (auto-derived)
Opening Balance = ₹5,00,000
Opening Balance Type = Credit  ← Valid: liability accounts credit-balance
Financial Statement = Balance Sheet

Transaction: Repay ₹1,00,000
Dr. Bank Loan (Liability) ₹1,00,000 ← Debit decreases liability ✓
    Cr. Bank (Asset)        ₹1,00,000 ← Credit decreases asset ✓
```

### Example 3: Equity → Capital → Owner Capital

```text
Step 2: Account Type
Type = EQUITY
Normal Balance = Credit
Nature = Credit
Financial Statement = Balance Sheet

Step 3: Account Group (under EQUITY)
Group: "Owner's Equity"
Type = EQUITY (inherited)

Step 3: Ledger Account (under "Owner's Equity")
Account: "Owner Capital - A. Sharma"
Type = EQUITY (inherited)
Nature = Credit (auto-derived)
Opening Balance = ₹10,00,000
Opening Balance Type = Credit  ← Valid
Financial Statement = Balance Sheet
```

### Example 4: Income → Sales → Sales Revenue

```text
Step 2: Account Type
Type = INCOME
Normal Balance = Credit
Nature = Credit
Financial Statement = Profit & Loss

Step 3: Account Group (under INCOME)
Group: "Operating Income"
Type = INCOME (inherited)

Step 3: Ledger Account (under "Operating Income")
Account: "Sales Revenue"
Type = INCOME (inherited)
Nature = Credit (auto-derived)
Opening Balance = ₹0
Opening Balance Type = Credit (default for income)
Financial Statement = Profit & Loss

Transaction: Sale of ₹2,50,000
Dr. Bank (Asset)        ₹2,50,000 ← Debit increases asset ✓
    Cr. Sales Revenue (Income) ₹2,50,000 ← Credit increases income ✓
```

### Example 5: Expenses → Office → Rent

```text
Step 2: Account Type
Type = EXPENSE
Normal Balance = Debit
Nature = Debit
Financial Statement = Profit & Loss

Step 3: Account Group (under EXPENSE)
Group: "Administrative Expenses"
Type = EXPENSE (inherited)

Step 3: Ledger Account (under "Administrative Expenses")
Account: "Office Rent"
Type = EXPENSE (inherited)
Nature = Debit (auto-derived)
Opening Balance = ₹0
Opening Balance Type = Debit (default for expense)
Financial Statement = Profit & Loss

Transaction: Pay ₹50,000 rent
Dr. Rent Expense (Expense) ₹50,000 ← Debit increases expense ✓
    Cr. Bank (Asset)        ₹50,000 ← Credit decreases asset ✓
```

---

## 20. QA TEST CASES

### Test Case Table

| Test Case ID | Scenario | Input | Expected Result | Priority |
|---|---|---|---|---|
| TC-AT-01 | Load Account Types | GET /api/accounting/account-types (future) or check frontend dropdown | Returns/ displays ASSET, LIABILITY, EQUITY, INCOME, EXPENSE | P0 |
| TC-AT-02 | All 5 types present | Query account_types seed data | 5 records: ASSET, LIABILITY, EQUITY, INCOME, EXPENSE | P0 |
| TC-AT-03 | Asset type Nature | Check ASSET type | Nature = Debit | P0 |
| TC-AT-04 | Liability type Nature | Check LIABILITY type | Nature = Credit | P0 |
| TC-AT-05 | Equity type Nature | Check EQUITY type | Nature = Credit | P0 |
| TC-AT-06 | Income type Nature | Check INCOME type | Nature = Credit | P0 |
| TC-AT-07 | Expense type Nature | Check EXPENSE type | Nature = Debit | P0 |
| TC-AT-03 | ASSET financial statement | Check ASSET type | Financial Statement = Balance Sheet | P0 |
| TC-AT-08 | INCOME financial statement | Check INCOME type | Financial Statement = Profit & Loss | P0 |
| TC-AT-09 | EXPENSE financial statement | Check EXPENSE type | Financial Statement = Profit & Loss | P0 |
| TC-AT-10 | Invalid Account Type | POST /groups with type="INVALID" | 400: "Invalid account type" | P1 |
| TC-AT-11 | Missing Account Type | POST /groups without type field | 400: "Account Type is required" | P1 |
| TC-AT-12 | Cross-type parent-child | Create EXPENSE group under ASSET parent | 400: "Child type does not match parent type" | P1 |
| TC-AT-13 | Opening Balance Debit on Asset | Debit opening balance on ASSET account | Accepted (valid) | P0 |
| TC-AT-14 | Opening Balance Credit on Asset | Credit opening balance on ASSET account | Warning + permission check required | P1 |
| TC-AT-15 | Opening Balance Credit on Liability | Credit opening balance on LIABILITY account | Accepted (valid) | P0 |
| TC-AT-16 | Opening Balance Debit on Income | Debit opening balance on INCOME account | Warning + permission check required | P1 |
| TC-AT-17 | Transaction Dr increase on Asset | Debit 1000 to ASSET ledger | Balance increases by 1000 | P0 |
| TC-AT-18 | Transaction Cr increase on Liability | Credit 1000 to LIABILITY ledger | Balance increases by 1000 | P0 |
| TC-AT-19 | Transaction Dr decrease on Liability | Debit 500 to LIABILITY ledger | Balance decreases by 500 | P0 |
| TC-AT-20 | Nature auto-derived on Group creation | Create ASSET group | debit_credit_nature auto-set to "DEBIT" | P0 |
| TC-AT-21 | Nature auto-derived on Ledger creation | Create ASSET ledger under ASSET group | debit_credit_nature = "DEBIT" | P0 |
| TC-AT-22 | System type not deletable | DELETE /account-types/ASSET | 403: "System account types cannot be deleted" | P1 |
| TC-AT-23 | System type not editable | PUT /account-types/ASSET with new name | 403: "System account types cannot be modified" | P1 |
| TC-AT-24 | Group filtering by type | Select ASSET in group form | Only ASSET-type parent groups shown | P0 |
| TC-AT-25 | Report Balance Sheet query | Run Balance Sheet report | Includes only ASSET, LIABILITY, EQUITY accounts | P0 |
| TC-AT-26 | Report P&L query | Run Profit & Loss report | Includes only INCOME, EXPENSE accounts | P0 |
| TC-AT-27 | Type inheritance in tree | Create hierarchy ASSET → Current Assets → HDFC Bank | All have type=ASSET | P0 |
| TC-AT-28 | Account Type used by groups | Count groups per type | Each type has at least 2 groups (from default COA) | P0 |
| TC-AT-29 | Account Type used by ledgers | Count ledgers per type | Each type has at least 3 ledgers (from default COA) | P0 |
| TC-AT-30 | Attempt to create custom type | POST /account-types with new type | 403 or 404 (not supported) | P1 |

---

## 21. FINAL BUSINESS RULE

> **Account Type is the highest-level accounting classification and must be established before Account Groups are created. Account Groups must belong to a valid Account Type, and Ledger Accounts must belong to a valid Account Group of the matching Account Type.**

### The Immutable Workflow

```text
COMPANY
   ↓
FINANCIAL YEAR              (Step 1 — Company Setup)
   ↓
ACCOUNT TYPE                (Step 2 — This Document)
   ↓
ACCOUNT GROUP               
   ↓
SUB GROUP                   
   ↓
LEDGER ACCOUNT              
   ↓
OPENING BALANCE             
   ↓
TRANSACTION                 
   ↓
FINANCIAL REPORT
```

### Key Assertions

1. ✅ **Five primary Account Types are system-defined**: ASSET, LIABILITY, EQUITY, INCOME, EXPENSE.
2. ✅ **Account Type determines Nature** (Debit/Credit) automatically.
3. ✅ **Account Type determines Financial Statement** placement (Balance Sheet vs. Profit & Loss).
4. ✅ **Account Type is immutable** — no create/edit/delete by users.
5. ✅ **Account Groups must match parent type** — cross-type hierarchies are rejected.
6. ✅ **Opening Balance side is validated** against the Account Type's normal balance.
7. ✅ **Transaction posting is validated** against the account's Nature derived from its Type.
8. ✅ **Reporting logic is driven by Account Type** — Balance Sheet = ASSET + LIABILITY + EQUITY; P&L = INCOME + EXPENSE.
9. ✅ **No Ledger Account can exist without a valid Account Type** (inherited from its Group).
10. ✅ **The accounting equation `Assets = Liabilities + Equity + (Income - Expenses)` is enforced by correct Account Type assignment throughout the hierarchy.**

---

*End of Document*

**Document Path:** `docs/BLACK_START_CRM_STEP_2_ACCOUNT_TYPE_MASTER_AND_ACCOUNTING_CLASSIFICATION.md`