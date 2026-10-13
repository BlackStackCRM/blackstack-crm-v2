# BLACK START CRM — STEP 1
## COMPANY & FINANCIAL YEAR ACCOUNTING SETUP
### Functional Specification & Implementation Workflow

**Document Version:** 1.0  
**Date:** September 7, 2026  
**Author:** Senior ERP/Accounting Software Architect  
**Status:** Implementation-Ready  

---

## 1. COMPANY ACCOUNTING SETUP

### Overview

Step 1 of the Black Start CRM accounting system establishes the foundational accounting context that all subsequent operations depend on. No Chart of Accounts, Account Groups, Ledger Accounts, Opening Balances, or Transactions can be created until the company and its accounting period configuration are complete.

This step is inspired by the practical workflow principles of professional accounting systems (e.g., Tally's company creation and accounting period setup), while maintaining the Black Start CRM's original architecture and UI conventions.

### Company Setup vs. Accounting Setup

| Aspect | Company Setup | Accounting Setup |
|--------|--------------|-----------------|
| **Scope** | Business entity identification | Financial accounting configuration |
| **Purpose** | Who is being served | How accounting is conducted |
| **Data Stored** | Name, code, status, registration details | Financial year, currency, method, period |
| **Created By** | System or admin during onboarding | Finance manager during setup |
| **Frequency** | Once per company | Per financial year cycle |
| **Dependencies** | None | Requires existing company |
| **Impact** | Entity-level | Company-wide accounting behavior |

### Company Setup Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| **Company Name** | ✅ Yes | String (max 200) | Legal/business name of the entity |
| **Company Code** | ✅ Yes | String (alphanumeric, 3-20) | Unique identifier used in URLs, reports, and system references |
| **Status** | ✅ Yes | Enum: `ACTIVE`, `INACTIVE` | Whether the company is active |
| **Created At** | System | Timestamp | Auto-set on creation |

**Database Table: `companies`**
```sql
CREATE TABLE companies (
  id TEXT PRIMARY KEY,          -- e.g., 'default', 'cmp_abc123'
  name TEXT NOT NULL,            -- e.g., 'Acme Trading Co.'
  status TEXT DEFAULT 'ACTIVE',  -- ACTIVE, INACTIVE
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

### Accounting Setup Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| **Financial Year** | ✅ Yes | Date range | The 12-month accounting period |
| **Books Beginning Date** | ✅ Yes | Date | The actual date from which transactional books start |
| **Base Currency** | ✅ Yes | Currency code (3-char ISO) | Primary accounting currency (e.g., INR) |
| **Accounting Method** | ✅ Yes | Enum: `ACCRUAL` | The recognition method used |
| **Decimal Precision** | ✅ Yes | Integer (0-4) | Number of decimal places for amounts |
| **Number Format** | ✅ Yes | String pattern | Locale-specific number display format |
| **Tax Configuration** | Optional | JSON/object | Statutory tax settings (GST for India) |

### Current Database State

The existing database has:
- `companies` table with `id`, `name`, `status`, `created_at`
- `financial_years` table with `id`, `company_id`, `name`, `start_date`, `end_date`, `is_active`, `is_locked`
- `currencies` table with `id`, `company_id`, `code`, `name`, `symbol`, `locale`, `is_base`, `is_active`

**Gap identified**: The current system lacks an `accounting_settings` or equivalent table to store accounting method, decimal precision, number format, books beginning date, and tax configuration. These need to be stored somewhere — either in a new table or embedded in the financial_years record.

---

## 2. FINANCIAL YEAR

### Definition

A Financial Year (also called Accounting Period or Fiscal Year) is the 12-month period used for budgeting, reporting, and tax purposes. The system must support multiple financial years (past, present, and future) while ensuring only one is active at any time.

### Standard Indian Financial Year

```
Financial Year 2026–27
Start Date: 01-04-2026 (April 1, 2026)
End Date:   31-03-2027 (March 31, 2027)
```

### Financial Year Operations

| Operation | Description | Permission Required |
|-----------|-------------|---------------------|
| **Creation** | Define a new financial year with start and end dates | `accounting.manage` |
| **Activation** | Set as the currently active financial year | `accounting.manage` |
| **Deactivation** | Switch to a different active year | `accounting.manage` |
| **Locking** | Prevent all modifications to the year's data | `accounting.manage` |
| **Closing** | Year-end close process: P&L → Retained Earnings, B/S → next year | `accounting.manage` |
| **Reopening** | Unlock a closed/locked year for corrections | `accounting.admin` (highest privilege) |

### Financial Year Statuses

| Status | Description | Behaviour |
|--------|-------------|-----------|
| **Draft** | Created but not yet active | Can be edited, deleted, or activated |
| **Active** | Currently in use | New transactions can be created, modifications allowed per permissions |
| **Closed** | Year-end close completed | No new transactions; viewing only. Can be switched away from |
| **Locked** | Frozen — no changes allowed at all | Read-only access; requires admin unlock for any changes |

### Database Schema

```sql
-- financial_years table (existing)
CREATE TABLE financial_years (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,              -- e.g., '2026-27'
  start_date TEXT NOT NULL,         -- '2026-04-01'
  end_date TEXT NOT NULL,           -- '2027-03-31'
  is_active INTEGER DEFAULT 0,      -- 1 = active, 0 = inactive
  is_locked INTEGER DEFAULT 0,      -- 1 = locked, 0 = unlocked
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, name)
)
```

### Year-End Closing Process

```text
1. Verify all transactions for the year are posted
2. Run Trial Balance → ensure Debits = Credits
3. Verify Profit & Loss accounts are finalized
4. Verify Balance Sheet accounts are accurate
5. Close all temporary (Income/Expense) accounts:
   Dr Income Accounts   → Cr Retained Earnings
   Cr Expense Accounts  → Dr Retained Earnings
   (Net effect: Retained Earnings updated)
6. Verify all permanent (Asset/Liability/Equity) balances are correct
7. Mark the financial year as "Closed"
8. Carry forward account balances to the next financial year
9. Set the next financial year as "Active"
10. Reset temporary accounts to zero balance for the new year
```

---

## 3. BOOKS BEGINNING DATE

### Critical Distinction

| Term | Definition | Scope | Impact |
|------|------------|-------|--------|
| **Financial Year Start Date** | The official start of the accounting period (e.g., April 1) | Period definition | Determines reporting periods |
| **Books Beginning Date** | The actual date from which the company starts recording transactions in Black Start CRM | Transactional | Determines when journals can be posted, affects opening balances timing |

### Scenario 1: Books Begin at Financial Year Start

```
Financial Year:  01-04-2026 → 31-03-2027
Books Beginning: 01-04-2026
```
**Result**: Full-year accounting from day one. Opening balances are as of April 1, 2026. All reports span the full financial year.

### Scenario 2: Books Begin After Financial Year Starts

```
Financial Year:  01-04-2026 → 31-03-2027
Books Beginning: 01-07-2026
```
**Result**: 
- Transactions dated before July 1, 2026 are rejected
- Opening balances are carried as of June 30, 2026
- The first 3 months (April–June) show zero activity
- Profit & Loss report shows activity from July 1 only
- Balance Sheet reflects pre-July balances via opening entries

### Impact Analysis

| System Component | Impact of Books Beginning Date |
|------------------|-------------------------------|
| **Opening Balances** | Must be entered with a date ≤ Books Beginning Date |
| **Transactions** | Cannot be dated before Books Beginning Date |
| **Ledger Creation** | No restriction — accounts can be created anytime |
| **Reports** | P&L filtered by Books Beginning Date; B/S as of any date |
| **Trial Balance** | Only includes activity from Books Beginning Date |
| **Profit & Loss** | Period-based: Books Beginning → Report Date |
| **Balance Sheet** | Point-in-time: All posted balances as of report date |

### Recommendation

Store `books_beginning_date` in the `financial_years` table (new column) or in a separate `accounting_settings` table. The system must validate every journal entry date against this beginning date.

---

## 4. BASE CURRENCY

### Default Configuration for Indian Companies

```
Currency Code:   INR
Currency Symbol: ₹
Decimal Places:  2
Format:          ₹1,00,000.00
Negative Format: -₹1,00,000.00
```

### Field Specifications

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| **Currency Code** | String (3-char ISO 4217) | `INR` | Primary accounting currency |
| **Currency Symbol** | String (1-3 chars) | `₹` | Display symbol |
| **Decimal Places** | Integer (0-4) | `2` | Precision for monetary amounts |
| **Symbol Position** | Enum: `PREFIX`, `SUFFIX` | `PREFIX` | ₹100 vs 100₹ |
| **Thousand Separator** | String | `,` | Indian format: 1,00,000 |
| **Decimal Separator** | String | `.` | 100.00 |
| **Negative Format** | Enum: `SIGN_PREFIX`, `SIGN_SUFFIX`, `PARENTHESES` | `SIGN_PREFIX` | -₹100 or ₹-100 or (₹100) |
| **Is Base** | Boolean | true (first currency) | Only one base currency per company |

### Current Database State

The existing `currencies` table supports:
- `code`, `name`, `symbol`, `locale`, `is_base`, `is_active`
- **Gap**: Missing `decimal_places`, `symbol_position`, `thousand_separator`, `negative_format`

### Currency Usage

| Context | Currency Used |
|---------|--------------|
| Journal entries | Base currency (unless multi-currency enabled) |
| Opening balances | Base currency |
| Ledger balances | Base currency |
| Reports | Base currency by default; multi-currency if enabled |
| Bank accounts | Can have separate currency (multi-currency accounts) |

### Amount Formatting Example

```
₹1,00,000.00   (100,000 rupees — Indian numbering)
-₹50,000.00    (negative amount)
(₹25,000.00)    (alternative negative format)
```

---

## 5. ACCOUNTING METHOD

### Supported Method: Accrual Accounting (Default)

**Accrual Accounting** recognizes revenues and expenses when they are **earned or incurred**, regardless of when cash changes hands.

| Concept | Accrual Method |
|---------|---------------|
| **Revenue** | Recognized when earned (sale made), not when cash received |
| **Expenses** | Recognized when incurred, not when paid |
| **Receivables** | Recorded at time of sale/service |
| **Payables** | Recorded at time of purchase/receipt of goods/service |
| **Assets** | Recorded when business owns/control the resource |
| **Liabilities** | Recorded when obligation is incurred |

### Why Accrual is the Only Method

Black Start CRM implements **Accrual Accounting only**. This ensures:

1. **Compliance**: Meets accounting standards (Ind-AS / Indian GAAP)
2. **Consistency**: All features (trial balance, P&L, balance sheet) work correctly
3. **Multi-period accuracy**: Revenue and expenses align with the period they belong to
4. **Financial health visibility**: True picture of receivables, payables, and obligations

> **Cash Accounting is NOT supported** in Black Start CRM. While simpler, it creates inconsistencies in reporting, makes inventory tracking difficult, and does not comply with Indian accounting standards for businesses above the threshold.

### Impact on System Components

| Component | Accrual Impact |
|-----------|---------------|
| **Opening Balances** | Include unpaid receivables and unpaid payables |
| **Journal Entries** | Debit/credit recorded at transaction date regardless of cash flow |
| **Invoices** | Created on date of sale, revenue recognized immediately |
| **Bills** | Created on receipt of goods/services, expense recognized immediately |
| **Payments** | Reduce receivables/payables but don't create revenue/expenses |
| **Reports** | All reports reflect economic activity, not cash movement |

---

## 6. ACCOUNTING PERIOD VALIDATION

### Rule: All transactions must fall within the active financial year

### Validation Logic

```javascript
function validateTransactionDate(entryDate, companyId) {
  const activeFY = getActiveFinancialYear(companyId);
  
  if (!activeFY) {
    throw new ValidationError('No active financial year. Please activate a financial year first.');
  }
  
  // Check date is within FY boundaries
  if (entryDate < activeFY.start_date || entryDate > activeFY.end_date) {
    throw new ValidationError(
      `Transaction date ${entryDate} is outside the active financial year ` +
      `(${activeFY.start_date} to ${activeFY.end_date}). ` +
      `Switch to the correct financial year or extend the period.`
    );
  }
  
  // Check against books beginning date
  if (entryDate < activeFY.books_beginning_date) {
    throw new ValidationError(
      `Transaction date ${entryDate} is before the books beginning date ` +
      `(${activeFY.books_beginning_date}). Cannot post prior to this date.`
    );
  }
  
  // Check if year is locked
  if (activeFY.is_locked) {
    throw new ValidationError(
      `Financial year ${activeFY.name} is locked. Contact administrator to unlock.`
    );
  }
}
```

### Examples

| Scenario | Financial Year | Books Beginning | Transaction Date | Result |
|----------|----------------|-----------------|-----------------|--------|
| ✅ Valid | 2026-04-01 → 2027-03-31 | 2026-04-01 | 2026-08-15 | Accepted |
| ❌ Before FY | 2026-04-01 → 2027-03-31 | 2026-04-01 | 2026-02-15 | Rejected: outside FY |
| ❌ Before Books | 2026-04-01 → 2027-03-31 | 2026-07-01 | 2026-05-15 | Rejected: before books date |
| ❌ Locked FY | 2025-04-01 → 2026-03-31 (locked) | 2025-04-01 | 2026-01-15 | Rejected: year locked |
| ⚠️ Wrong FY | 2026-04-01 → 2027-03-31 (active) | 2026-04-01 | 2025-08-15 | Rejected: must switch to FY 2025-26 |

---

## 7. FINANCIAL YEAR STATUSES

### Status Matrix

| Status | Can Create Journals | Can Create Masters | Can Edit Existing | Can Delete | Can Run Reports | Can Close | Can Unlock |
|--------|-------------------|-------------------|-------------------|------------|----------------|-----------|------------|
| **Draft** | ❌ No | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes (draft) | ✅ Yes | ✅ Yes |
| **Active** | ✅ Yes | ✅ Yes | ✅ Yes (permissions apply) | ❌ No | ✅ Yes | ✅ Yes (admin) | ✅ Yes (admin) |
| **Closed** | ❌ No | ❌ No | ❌ No | ❌ No | ✅ Yes | ❌ No | ⚠️ Admin only |
| **Locked** | ❌ No | ❌ No | ❌ No | ❌ No | ✅ Yes (read-only) | ❌ No | ⚠️ Admin only |

### Status Transitions

```
Draft → Active → Closed → [Archived]
Draft → Active → Locked → [Archived]
Draft → Deleted (only if never activated)
```

**Rules:**
- Only one `Active` financial year per company at any time
- Cannot set a `Closed` or `Locked` year back to `Active` without admin approval
- `Closed` years can be switched away from but not re-opened for new entries
- `Locked` years require admin override for any modification

---

## 8. YEAR SWITCHING

### Workflow

```text
User Action:
  Accounting → Financial Year → [2026–27] → Switch

System Actions:
1. Validate user has accounting.manage permission
2. Check target year is not locked
3. Check target year is not closed
4. Deactivate current active year
5. Activate target year
6. Log audit entry: "Financial year switched from X to Y"
7. Reload UI components: COA tree, reports, dashboard
8. Update session context with active year
```

### What Happens When Switching

| Component | Behavior on Year Switch |
|-----------|------------------------|
| **Chart of Accounts** | Remains available (masters are not period-specific) |
| **Ledger Accounts** | Remain available |
| **Transactions** | Filtered by active financial year's date range |
| **Opening Balances** | Reflect the beginning-of-year balances for the selected year |
| **Reports** | P&L, Trial Balance filtered to active year; Balance Sheet shows current state |
| **Journal Entries** | Date validation uses active year's boundaries |
| **Vouchers** | All voucher numbering continues sequentially |
| **Budgets** | Only show budgets linked to the active financial year |

### Backend Implementation

```javascript
// Controller method: switchFinancialYear
async switchFinancialYear(req, res, next) {
  const companyId = getCompanyId(req);
  const targetFyId = req.params.id;
  
  // Verify permission
  Authorizer.assertPermission(context, 'accounting.manage');
  
  // Get target FY
  const targetFy = conn.get(
    'SELECT * FROM financial_years WHERE id = ? AND company_id = ?',
    [targetFyId, companyId]
  );
  if (!targetFy) throw new NotFoundError('Financial year not found');
  if (targetFy.is_locked) throw new ValidationError('Cannot switch to a locked financial year');
  if (targetFy.is_closed) throw new ValidationError('Cannot switch to a closed financial year');
  
  // Deactivate current active
  conn.run(
    'UPDATE financial_years SET is_active = 0, updated_at = datetime(\'now\') WHERE company_id = ? AND is_active = 1',
    [companyId]
  );
  
  // Activate target
  conn.run(
    'UPDATE financial_years SET is_active = 1, updated_at = datetime(\'now\') WHERE id = ? AND company_id = ?',
    [targetFyId, companyId]
  );
  
  // Log audit
  logAudit(conn, companyId, req.user.userId, 'FINANCIAL_YEAR', targetFyId, 'SWITCH', null, targetFy);
  
  res.json(successResponse({ message: 'Financial year switched to ' + targetFy.name, financialYear: targetFy }));
}
```

---

## 9. YEAR CLOSING

### Year-End Close Process

```text
Step 1: Pre-Close Verification
  → Run Trial Balance → Verify total debits = total credits
  → Verify all journals are posted
  → Verify no pending/draft entries exist
  → Verify all payments/bills are reconciled

Step 2: Profit & Loss Summary
  → Calculate Net Profit/Loss for the year
  → Verify against manual calculations
  → Generate P&L report for review

Step 3: Closing Entries
  → Close Revenue accounts: Dr Sales/Revenue, Cr Retained Earnings
  → Close Expense accounts: Dr Retained Earnings, Cr Expenses
  → Net effect: Retained Earnings = Beginning RE + Net Profit - Drawings

Step 4: Balance Sheet Verification
  → Verify Assets = Liabilities + Equity
  → Confirm all permanent account balances
  → Generate Balance Sheet for review

Step 5: Close Financial Year
  → Update financial_years.is_active = 0
  → Update financial_years.is_closed = 1 (new field needed)
  → Log audit trail of all closing entries

Step 6: Carry Forward
  → Permanent account balances carry forward automatically
  → Temporary accounts (Revenue/Expense) reset to zero
  → Opening balances for next year = current balances

Step 7: Activate Next Year
  → Set next financial year as active
  → Enable Chart of Accounts for new year transactions
```

### Closing Entry Examples

```
Closing Revenue (Sales Revenue ₹5,00,000):
  Dr Sales Revenue          5,00,000.00
    Cr Retained Earnings    5,00,000.00

Closing Expenses (Rent ₹1,20,000):
  Dr Retained Earnings      1,20,000.00
    Cr Rent Expense         1,20,000.00

Net effect on Retained Earnings: +3,80,000.00 (Profit)
```

### Database Changes Needed

The current `financial_years` table needs:
- `books_beginning_date` column (TEXT) — when transactions actually begin
- `is_closed` column (INTEGER DEFAULT 0) — closed status flag
- `closed_at` column (DATETIME) — timestamp of closure

---

## 10. PRECONDITIONS FOR CHART OF ACCOUNTS

### Mandatory Requirements Before COA Setup

The system must enforce that **ALL** of the following conditions are met before allowing access to Chart of Accounts creation:

1. ✅ **Company exists** — At least one company record in `companies` table
2. ✅ **Financial Year exists** — At least one record in `financial_years` table
3. ✅ **Financial Year is active** — `is_active = 1` for one financial year
4. ✅ **Financial Year is not locked or closed** — `is_locked = 0 AND is_closed = 0`
5. ✅ **Books Beginning Date is set** — Date before which no transactions can be posted
6. ✅ **Base Currency is configured** — At least one currency with `is_base = 1`
7. ✅ **Accounting Method is set** — Defaults to `ACCRUAL`
8. ✅ **Decimal precision is configured** — Defaults to `2`

### System Enforcement

```javascript
// Middleware/check applied to all COA routes
function requireAccountingSetup(req, res, next) {
  const companyId = req.user?.companyId || 'default';
  
  // Check company exists
  const company = conn.get('SELECT * FROM companies WHERE id = ?', [companyId]);
  if (!company) throw new ValidationError('Company not configured');
  
  // Check active financial year
  const activeFY = conn.get(
    'SELECT * FROM financial_years WHERE company_id = ? AND is_active = 1 LIMIT 1',
    [companyId]
  );
  if (!activeFY) throw new ValidationError('No active financial year. Complete accounting setup first.');
  
  // Check not locked
  if (activeFY.is_locked) throw new ValidationError('Financial year is locked');
  if (activeFY.is_closed) throw new ValidationError('Financial year is closed');
  
  // Check books beginning date
  if (!activeFY.books_beginning_date) {
    throw new ValidationError('Books beginning date not set');
  }
  
  // Check base currency
  const baseCurrency = conn.get(
    'SELECT * FROM currencies WHERE company_id = ? AND is_base = 1 LIMIT 1',
    [companyId]
  );
  if (!baseCurrency) throw new ValidationError('Base currency not configured');
  
  // All checks passed
  req.activeFinancialYear = activeFY;
  req.baseCurrency = baseCurrency;
  next();
}
```

If any precondition fails, the UI should show:

```
┌─────────────────────────────────────────────────┐
│ ⚠️ Accounting Setup Incomplete                   │
├─────────────────────────────────────────────────┤
│ Before creating accounts, you must:              │
│ • Configure the company                        │
│ • Create and activate a financial year          │
│ • Set the books beginning date                  │
│ • Configure the base currency                   │
│                                                │
│ [ Go to Accounting Setup ]                     │
└─────────────────────────────────────────────────┘
```

---

## 11. FIRST-TIME COMPANY WORKFLOW

### Complete 10-Step Setup Process

#### Step 1: Create Company
```
Navigation: Settings → Companies → Add Company
User enters:
  - Company Name: BlackStack Default Company
  - Company Code: default
  - Status: Active
System: Creates record in `companies` table
```

#### Step 2: System Prompts for Financial Year
```
System shows: "No financial year configured. Create one to start."
User clicks: [ Create Financial Year ]
```

#### Step 3: Configure Financial Year
```
Modal: "Create Financial Year"
User enters:
  - Name: 2026-27
  - Start Date: 2026-04-01
  - End Date: 2027-03-31
  - Books Beginning Date: 2026-04-01 (default, editable)
System: Creates record in `financial_years` table, sets is_active = 1
```

#### Step 4: Set Base Currency
```
System auto-detects: INR (₹) for Indian companies
OR
User selects from dropdown: INR, USD, EUR, GBP, etc.
System: Creates/activates currency in `currencies` table with is_base = 1
```

#### Step 5: Confirm Accounting Method
```
System shows: "Accounting Method: Accrual (default, not changeable)"
Info: "Cash accounting is not supported. Accrual ensures compliance with Ind-AS."
User: Clicks [ Confirm ]
```

#### Step 6: Configure Number Format
```
System shows defaults:
  - Decimal Places: 2
  - Number Format: Indian (##,##,###.##)
  - Symbol Position: Prefix (₹)
  - Negative Format: Sign Prefix (-₹)
User: Can adjust or accepts defaults
```

#### Step 7: System Validates Configuration
```
System checks:
  ✅ Company: default
  ✅ Financial Year: 2026-07 (active)
  ✅ Books Beginning Date: 2026-04-01
  ✅ Base Currency: INR (₹)
  ✅ Accounting Method: ACCRUAL
  ✅ Decimal Precision: 2
```

#### Step 8: Activate Accounting Period
```
System:
  - Sets financial_years.is_active = 1
  - Sets books_beginning_date
  - Stores accounting_settings (method, precision, format)
  - Creates audit log entry
Shows: "✅ Accounting period activated. You can now set up your Chart of Accounts."
```

#### Step 9: Enable Chart of Accounts
```
Navigation: Accounting → Chart of Accounts
System: Menu item enabled, shows:
  "Your Chart of Accounts is empty. Start by creating Account Groups."
  [ Create Account Group ] [ Import COA ] [ Create Default COA ]
```

#### Step 10: Begin Account Creation
```
User can now:
  → Create Account Groups (Assets, Liabilities, Equity, Income, Expenses)
  → Create Ledger Accounts under groups
  → Enter Opening Balances
  → Start recording Transactions
```

---

## 12. DATABASE REQUIREMENTS

### Required Tables

#### `companies` (existing)
```sql
CREATE TABLE companies (
  id TEXT PRIMARY KEY,           -- e.g., 'default', 'cmp_abc123'
  name TEXT NOT NULL,             -- Legal company name
  status TEXT DEFAULT 'ACTIVE',   -- ACTIVE, INACTIVE
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

#### `financial_years` (existing + needs extension)
```sql
CREATE TABLE financial_years (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,              -- e.g., '2026-27'
  start_date TEXT NOT NULL,         -- '2026-04-01'
  end_date TEXT NOT NULL,           -- '2027-03-31'
  books_beginning_date TEXT,        -- NEW: '2026-04-01'
  is_active INTEGER DEFAULT 0,      -- 1 = active
  is_locked INTEGER DEFAULT 0,      -- 1 = frozen
  is_closed INTEGER DEFAULT 0,      -- NEW: 1 = year-end closed
  closed_at DATETIME,               -- NEW: timestamp of closure
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, name),
  UNIQUE(company_id) WHERE is_active = 1  -- Only one active per company (enforced in app)
)
```

#### `accounting_settings` (NEW table — recommended)
```sql
CREATE TABLE accounting_settings (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  accounting_method TEXT DEFAULT 'ACCRUAL',     -- ACCRUAL only (future: CASH)
  decimal_places INTEGER DEFAULT 2,             -- 0-4
  number_format TEXT DEFAULT 'INDIAN',          -- INDIAN, WESTERN
  symbol_position TEXT DEFAULT 'PREFIX',        -- PREFIX, SUFFIX
  thousand_separator TEXT DEFAULT ',',
  decimal_separator TEXT DEFAULT '.',
  negative_format TEXT DEFAULT 'SIGN_PREFIX',   -- SIGN_PREFIX, SIGN_SUFFIX, PARENTHESES
  tax_configuration JSON,                      -- GST settings, etc. (optional)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id)
)
```

#### `currencies` (existing + needs extension)
```sql
CREATE TABLE currencies (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  code TEXT NOT NULL,               -- 'INR', 'USD', 'EUR'
  name TEXT NOT NULL,               -- 'Indian Rupee', 'US Dollar'
  symbol TEXT,                      -- '₹', '$', '€'
  locale TEXT,                      -- 'en-IN', 'en-US'
  decimal_places INTEGER DEFAULT 2, -- NEW: per-currency precision
  is_base INTEGER DEFAULT 0,        -- 1 = base currency
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, code),
  UNIQUE(company_id) WHERE is_base = 1  -- One base per company
)
```

### Relationships

```text
companies
  └── financial_years (one-to-many: company → FYs)
  └── accounting_settings (one-to-one: company → settings)
  └── currencies (one-to-many: company → currencies, one is_base)
  └── account_groups (one-to-many: company → groups)
  └── accounts (one-to-many: company → accounts)
  └── journal_entries (one-to-many: company → JEs, linked to active FY by date)
```

### Constraints

| Constraint | Description |
|-----------|-------------|
| `UNIQUE(company_id, name)` on `financial_years` | No duplicate FY names per company |
| `is_active = 1` max one per company | Enforced in application layer |
| `is_base = 1` max one per company | Enforced in application layer |
| `start_date < end_date` | Validated on insert/update |
| `books_beginning_date >= start_date` | Books cannot begin before FY starts |
| `books_beginning_date <= end_date` | Books cannot begin after FY ends |

---

## 13. VALIDATION RULES

### Complete Validation Table

| Field | Required | Data Type | Validation Rules | Error Message | Default |
|-------|----------|-----------|-----------------|---------------|---------|
| **Company Name** | ✅ | String (max 200) | Non-empty, unique | `"Company name is required"` / `"Company name already exists"` | — |
| **Company Code** | ✅ | String (3-20) | Alphanumeric, unique | `"Company code is required"` / `"Must be 3-20 alphanumeric characters"` / `"Code already exists"` | — |
| **Company Status** | ✅ | Enum | ACTIVE, INACTIVE | `"Invalid status"` | `ACTIVE` |
| **Financial Year Name** | ✅ | String | Format: YYYY-YY, unique per company | `"Financial year name is required"` / `"Use format: 2026-27"` / `"Financial year already exists"` | — |
| **Start Date** | ✅ | Date | Valid date, < end date | `"Start date is required"` / `"Start date must be before end date"` | — |
| **End Date** | ✅ | Date | Valid date, > start date, exactly 365/366 days apart | `"End date is required"` / `"End date must be after start date"` / `"Financial year must be 365 or 366 days"` | — |
| **Books Beginning Date** | ✅ | Date | ≥ start_date, ≤ end_date | `"Books beginning date is required"` / `"Cannot be before FY start"` / `"Cannot be after FY end"` | = start_date |
| **Currency Code** | ✅ | String (3) | Valid ISO 4217 code | `"Base currency is required"` / `"Invalid currency code"` | `INR` |
| **Accounting Method** | ✅ | Enum | ACCRUAL only | `"Invalid accounting method. Only ACCRUAL is supported."` | `ACCRUAL` |
| **Decimal Places** | ✅ | Integer | 0-4 | `"Decimal places must be between 0 and 4"` | `2` |
| **Financial Year Status** | ✅ | Enum | DRAFT, ACTIVE, CLOSED, LOCKED | `"Invalid status"` | `DRAFT` |

### Cross-Field Validations

| # | Condition | Validation | Error Message |
|---|----------|------------|---------------|
| 1 | Start date ≥ End date | `start_date < end_date` | `"Financial year start date must be before end date"` |
| 2 | FY span ≠ 365/366 days | `DATEDIFF(end, start) IN (365, 366)` | `"Financial year must span exactly 365 or 366 days"` |
| 3 | Books date < FY start | `books_beginning_date >= start_date` | `"Books beginning date cannot be before financial year start date"` |
| 4 | Two active FYs | Count is_active=1 per company ≤ 1 | `"Only one financial year can be active at a time"` |
| 5 | Transaction date in active FY | `date BETWEEN start_date AND end_date` | `"Date is outside the active financial year"` |
| 6 | Transaction date before books date | `date >= books_beginning_date` | `"Date is before the books beginning date"` |
| 7 | Locked FY modification | `is_locked = 0` | `"Financial year is locked. Contact administrator."` |
| 8 | Closed FY modification | `is_closed = 0` | `"Financial year is closed. No modifications allowed."` |

---

## 14. PERMISSIONS

### Permission Definitions

| Permission | Description | Role Required |
|-----------|-------------|---------------|
| `accounting.setup` | Create/edit company & accounting settings, financial years | System Administrator, Finance Manager |
| `accounting.manage` | Create/edit accounts, groups; manage FYs | System Administrator, Finance Manager, Accountant |
| `accounting.view` | View accounting setup, financial years, reports | System Administrator, Finance Manager, Accountant, Viewer |
| `accounting.fy.switch` | Switch active financial year | System Administrator, Finance Manager |
| `accounting.fy.close` | Close a financial year | System Administrator |
| `accounting.fy.lock` | Lock/unlock a financial year | System Administrator |
| `accounting.fy.reopen` | Reopen a closed financial year | System Administrator (audit logged) |
| `accounting.create` | Create ledger accounts, groups | System Administrator, Finance Manager, Accountant |

### Role-Based Access Matrix

| Role | Setup | Manage | View | Switch FY | Close FY | Lock FY | Reopen FY | Create |
|------|-------|--------|------|-----------|----------|---------|-----------|--------|
| **System Administrator** | ✅ Full | ✅ Full | ✅ Full | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Finance Manager** | ✅ Full | ✅ Full | ✅ Full | ✅ | ❌ | ❌ | ❌ | ✅ |
| **Accountant** | ❌ | ✅ Create/Edit | ✅ Read | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Viewer** | ❌ | ❌ | ✅ Read | ❌ | ❌ | ❌ | ❌ | ❌ |

### Permission Enforcement

```javascript
// Route protection for financial year endpoints
router.post('/financial-years', authSetup, controller.createFinancialYear.bind(controller));
router.put('/financial-years/:id/activate', authSetup, controller.setActiveFinancialYear.bind(controller));
router.post('/financial-years/:id/close', authManage, controller.closeFinancialYear.bind(controller));
router.post('/financial-years/:id/lock', authManage, controller.lockFinancialYear.bind(controller));
router.get('/financial-years', authView, controller.listFinancialYears.bind(controller));

// COA routes require accounting setup to be complete
router.get('/accounts/tree', requireAccountingSetup, authView, controller.getAccountTree.bind(controller));
router.post('/accounts', requireAccountingSetup, authManage, controller.createAccount.bind(controller));
```

---

## 15. UI REQUIREMENTS

### Step 1 Setup Screen Design

```text
┌─────────────────────────────────────────────────────────────────┐
│ Accounting Setup                                      [ ? ] [X] │
├─────────────────────────────────────────────────────────────────┤
│ Set up your company's accounting foundation before creating    │
│ Chart of Accounts, ledger accounts, or recording transactions.    │
└─────────────────────────────────────────────────────────────────┘

┌────────────────────────────┐  ┌────────────────────────────────┐
│ COMPANY                    │  │ Base Currency                  │
│                           │  │                                │
│ Company Name              │  │ Currency: [INR ▼]               │
│ [BlackStack Default Co. ]  │  │ Symbol: ₹ (auto)                │
│                            │  │ Decimal Places: [2 ▼]           │
│ Company Code              │  │ Format: Indian (auto)           │
│ [default _______________]  │  │                                │
│                            │  │ [✓] This is my base currency    │
│ Status                    │  └────────────────────────────────┘
│ [Active ▼]                 │
└────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ FINANCIAL YEAR                                                  │
├─────────────────────────────────────────────────────────────────┤
│ Financial Year Name                                             │
│ [2026-27 ___________]   ← Auto-generated from start date         │
│                                                                 │
│ Start Date    [2026-04-01 📅]                                    │
│ End Date      [2027-03-31 📅]                                    │
│                                                                 │
│ Books Beginning Date  [2026-04-01 📅]                          │
│ (earliest transaction date)                                      │
│                                                                 │
│ Accounting Method     [Accrual Basis (default) ▼]              │
│ (Cash basis not supported)                                     │
│                                                                 │
│ [ ] Lock this financial year                                    │
└─────────────────────────────────────────────────────────────────┘

[ Cancel ] [ Save & Activate ]
```

### UI Components Specification

| Component | Details |
|----------|---------|
| **Financial Year Date Pickers** | Show calendar picker; pre-fill April 1 / March 31; enforce 365/366 day rule with error on invalid range |
| **Books Beginning Date** | Disabled by default (same as FY start); enable with checkbox "Set custom books beginning date" |
| **Currency Dropdown** | Searchable; shows code + symbol + name (e.g., "INR — ₹ — Indian Rupee") |
| **Accounting Method** | Disabled dropdown showing "Accrual (default)" with info icon explaining why |
| **Required Indicators** | Red `*` on all mandatory fields |
| **Inline Validation** | Green check for valid, red X + message for invalid |
| **Save Button** | Disabled until all required fields are valid |
| **Success Notification** | Green toast: "✅ Accounting setup complete. You can now create Chart of Accounts." |

### Navigation After Setup

Once Step 1 is complete, the main navigation shows:

```text
Accounting & Finance
├── Chart of Accounts     ← NOW ENABLED
├── Journal
├── Bills
├── Receivables
├── Payables
├── Financial Year        ← Manage financial years
├── Reports
└── ...
```

Before setup, the COA menu item shows:

```text
Accounting & Finance
├── ⚠️ Chart of Accounts   ← DISABLED (tooltip: "Complete accounting setup first")
├── Financial Year
└── ...
```

---

## 16. FINAL STEP 1 WORKFLOW

### Complete Process Flow

```text
START
  │
  ▼
┌─────────────────────────────────────────────┐
│           COMPANY & ACCOUNTING SETUP        │
└─────────────────────────────────────────────┘
  │
  ├─ Step 1: Company Identity
  │     Create/select company in `companies` table
  │     Fields: Name, Code, Status
  │
  ├─ Step 2: Financial Year Creation
  │     Create financial year in `financial_years` table
  │     Fields: Name, Start Date, End Date, Books Beginning Date
  │     Auto-set is_active = 1
  │
  ├─ Step 3: Base Currency Configuration
  │     Create/activate currency in `currencies` table
  │     Fields: Code, Name, Symbol, is_base = 1
  │     Default: INR (₹) for Indian companies
  │
  ├─ Step 4: Accounting Method Confirmation
  │     Store in `accounting_settings` table (new)
  │     Method: ACCRUAL (only supported method)
  │     Fields: Decimal Places, Number Format, Separators
  │
  ├─ Step 5: System Validation
  │     ✅ Company exists
  │     ✅ Financial year active and not locked/closed
  │     ✅ Books beginning date set
  │     ✅ Base currency configured
  │     ✅ Accounting settings stored
  │
  ├─ Step 6: Activate Accounting Period
  │     Set financial_years.is_active = 1
  │     Create audit log entry
  │     Show success notification
  │
  └─ Step 7: Enable Downstream Systems
        Enable Chart of Accounts navigation
        Enable Journal Entries
        Enable Bills, Payments, Reports
        Enable Dashboard metrics

  │
  ▼
┌─────────────────────────────────────────────┐
│    PROCEED TO STEP 2: Chart of Accounts     │
└─────────────────────────────────────────────┘
```

### Hard Gate Rule

> **No Ledger Account, Account Group, Opening Balance, or Transaction can be created unless the company's accounting setup (Step 1) is complete and validated.**

This is enforced via:
- Backend middleware: `requireAccountingSetup` on all COA/journal/bill/payment routes
- Frontend: COA menu item disabled with tooltip
- Database constraints: FK references to financial_years and currencies

### Dependencies for Next Step (Chart of Accounts)

| Prerequisite | Source |
|-------------|--------|
| Active Financial Year | `financial_years.is_active = 1` |
| Books Beginning Date | `financial_years.books_beginning_date` |
| Base Currency | `currencies.is_base = 1` |
| Company ID | `companies.id` |
| Accounting Method | `accounting_settings.accounting_method` |
| Decimal Precision | `accounting_settings.decimal_places` |

### Implementation Checklist

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Add `books_beginning_date` column to `financial_years` | ⬜ Not Done | Requires migration |
| 2 | Add `is_closed` column to `financial_years` | ⬜ Not Done | Requires migration |
| 3 | Add `closed_at` column to `financial_years` | ⬜ Not Done | Requires migration |
| 4 | Add `decimal_places` column to `currencies` | ⬜ Not Done | Requires migration |
| 5 | Create `accounting_settings` table | ⬜ Not Done | New table |
| 6 | Add `requireAccountingSetup` middleware | ⬜ Not Done | Frontend/backend |
| 7 | Add UI for Step 1 setup screen | ⬜ Not Done | React/Vanilla JS modal |
| 8 | Implement financial year CRUD + statuses | ⬜ Not Done | Controller methods |
| 9 | Implement year switching + closing | ⬜ Not Done | Controller + service |
| 10 | Add permission checks for FY operations | ⬜ Not Done | RBAC rules |
| 11 | Add validation for transaction dates | ⬜ Partially Done | Partial in journal repo |
| 12 | Add COA gatekeeping logic | ⬜ Not Done | Middleware + UI |

---

## 17. EDGE CASES

### Edge Case 1: User Skips Step 1
**Scenario**: User navigates directly to Chart of Accounts.
**Expected**: System shows "Accounting setup incomplete" message with link to setup.

### Edge Case 2: Multiple Active Financial Years
**Scenario**: User activates a second FY while one is already active.
**Expected**: System auto-deactivates the previous one. Audit log records the switch.

### Edge Case 3: Books Beginning Date is in the Future
**Scenario**: User sets books beginning date to next year.
**Expected**: System warns: "No transactions can be recorded until this date."

### Edge Case 4: Financial Year Span Isn't Exactly 365/366 Days
**Scenario**: User creates FY from Jan 1 to Dec 30 (364 days).
**Expected**: Validation error: "Financial year must span exactly 365 or 366 days."

### Edge Case 5: Trying to Post Before Books Beginning Date
**Scenario**: User tries to create a journal entry dated before the books beginning date.
**Expected**: Error: "Transaction date is before the books beginning date (2026-04-01). Cannot post prior to this date."

### Edge Case 6: Year Close with Unbalanced Books
**Scenario**: User tries to close FY but Trial Balance doesn't balance.
**Expected**: Error: "Cannot close financial year. Trial balance is unbalanced. Review journal entries."

### Edge Case 7: Currency Change After Transactions Exist
**Scenario**: User tries to change base currency after posting transactions.
**Expected**: Warning: "Changing the base currency will not convert existing transactions. All new entries will use the new currency. Proceed?"

### Edge Case 8: Deleting a Closed Financial Year
**Scenario**: User tries to delete a closed FY.
**Expected**: Error: "Cannot delete a closed financial year. Archive it instead."

---

*This document is Part 1 of the Black Start CRM Accounting Functional Specification series. Part 2 (Chart of Accounts & Ledger Account Creation) is documented in `BLACK_START_CRM_CHART_OF_ACCOUNTS_FUNCTIONAL_SPECIFICATION.md`.*

**Database file:** `data/blackstack-crm.db`  
**Server:** `node server/app.js` on port 3000  
**Default company:** `default` (BlackStack Default Company)  
**Admin user:** `admin@blackstack.local` / [REDACTED]  
**All 68 Chart of Accounts tests passing**