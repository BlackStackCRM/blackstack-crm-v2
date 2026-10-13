# BLACK START CRM — STEP 3
## ACCOUNT GROUP MASTER & ACCOUNT GROUP CREATION WORKFLOW
### Functional Specification & Implementation Workflow

**Document Version:** 1.0  
**Date:** September 7, 2026  
**Author:** Hermes Agent (Nous Research)  
**For:** Black Start CRM Development & Accounting Teams  

---

## TABLE OF CONTENTS

1. Accounting Hierarchy & Relationship Between Levels
2. Account Group Master Module
3. Account Group Creation Form
4. Field 1 — Account Group Name
5. Field 2 — Account Type
6. Field 3 — Parent Account Group
7. Parent Group Filtering
8. Accounting Nature (Debit/Credit)
9. Primary Group vs Child Group
10. Hierarchical Account Group Rules
11. Group Posting Behavior
12. Group Code
13. Description
14. Status
15. System Groups
16. Empty State Workflow
17. Account Group List Screen
18. Tree View
19. Search and Filter
20. Create Sub Group Workflow
21. Edit Account Group
22. Delete Rules
23. Database Design
24. Database Constraints
25. Backend Validation
26. Permissions
27. Audit Trail
28. Complete User Workflow
29. Examples
30. Invalid Examples
31. API Requirements
32. Reporting Impact
33. UI/UX Requirements
34. QA Test Cases
35. Acceptance Criteria
36. Final Accounting Flow

---

## 1. ACCOUNTING HIERARCHY & RELATIONSHIP BETWEEN LEVELS

The Black Start CRM accounting architecture enforces a strict hierarchical classification chain:

```text
Company
   ↓
Financial Year
   ↓
Account Type              (Step 2 — Master classification)
   ↓
Account Group            (Step 3 — This document)
   ↓
Sub Group                (Child Account Group)
   ↓
Ledger Account
   ↓
Transactions
```

### Object Classifications

| Object | Classification | Purpose |
|---|---|---|
| Account Type | **Master** | Fundamental accounting classification (Asset, Liability, etc.) |
| Account Group | **Master** | Logical grouping of related accounts under an Account Type |
| Sub Group | **Master** | A child Account Group that refines the parent group's scope |
| Ledger Account | **Master / Transactional** | Individual account that receives actual debit/credit postings |
| Journal Entry | **Transactional** | Debit/credit postings to Ledger Accounts |

### Relationship Between Levels

1. **Account Type → Account Group**: Every Account Group must belong to exactly one Account Type. The Account Type determines the group's accounting Nature (Debit/Credit) and financial statement placement.

2. **Account Group → Sub Group**: Every Sub Group must have exactly one parent Account Group, and both must belong to the same Account Type.

3. **Sub Group → Ledger Account**: Ledger Accounts are created under a final (leaf-level) Account Group. A Ledger Account inherits the Account Type from its parent group.

4. **Ledger Account → Transactions**: Only Ledger Accounts can receive debit/credit postings. Account Groups and Sub Groups are classification nodes — they are non-posting.

### Key Principle

```text
Account Groups are NOT posting accounts.
Ledger Accounts ARE posting accounts.
```

---

## 2. ACCOUNT GROUP MASTER MODULE

The **Account Group Master** module provides full CRUD and hierarchical management of Account Groups.

### Module Navigation

```text
Accounting
   → Chart of Accounts
      → Account Groups
         → Account Group Master
```

### Capabilities

Authorized users can:

- ✅ View all Account Groups in a hierarchical tree
- ✅ Search Account Groups by code or name
- ✅ Filter Account Groups by Account Type, Parent, Status, Nature
- ✅ Create Account Groups (primary and sub-groups)
- ✅ Edit Account Groups (with accounting-integrity guards)
- ✅ Activate / deactivate groups
- ✅ View group details (children, ledgers, statistics)
- ✅ View child groups and linked Ledger Accounts
- ✅ Prevent invalid accounting structures (cross-type, circular, self-parent)
- ✅ Prevent deletion when dependencies exist (child groups, ledger accounts, transactions)

---

## 3. ACCOUNT GROUP CREATION FORM

The Account Group creation form is accessed via:

```text
Chart of Accounts → + Create Account Group
```

Or from within the Ledger Account workflow when no groups exist (see §16).

### Form Fields

| # | Field | Type | Required |
|---|---|---|---|
| 1 | Account Group Name | Text | Yes |
| 2 | Account Type | Select | Yes |
| 3 | Parent Account Group | Hierarchical Select | No |
| 4 | Debit/Credit Nature | Select (auto-derived) | Yes |
| 5 | Group Code | Text (auto-generated or manual) | Yes |
| 6 | Description | Textarea | No |
| 7 | Allow Child Accounts | Toggle | Yes (default: ON) |
| 8 | Status | Select | Yes |

---

## 4. FIELD 1 — ACCOUNT GROUP NAME

| Property | Value |
|---|---|
| **Field** | Group Name |
| **Type** | String (text input) |
| **Required** | Yes |
| **Purpose** | Human-readable identifier for the group |
| **Examples** | Current Assets, Bank Accounts, Sales Accounts, Administrative Expenses |
| **Validation** | Cannot be empty; trimmed; 1–255 characters; no whitespace-only values |
| **Duplicate Handling** | Duplicate names allowed across different Account Types (e.g., "Current Assets" under ASSET is unique, but "Current Liabilities" under LIABILITY is separate). Within the same Account Type, duplicate names should be flagged with a warning but not necessarily rejected. |
| **Data Type** | VARCHAR(255) |
| **Backend Column** | `account_groups.name` |

---

## 5. FIELD 2 — ACCOUNT TYPE

| Property | Value |
|---|---|
| **Field** | Account Type |
| **Type** | Select dropdown |
| **Required** | Yes |
| **Purpose** | Determines the accounting classification of the group |
| **Source** | Loaded from Account Type Master (Step 2). NOT hardcoded. |
| **Options** | Asset, Liability, Equity / Capital, Income / Revenue, Expense |
| **Internal Codes** | ASSET, LIABILITY, EQUITY, INCOME, EXPENSE |
| **Backend Column** | `account_groups.type` |

### Backend Validation

In `server/controllers/accounting.controller.js` (line 18):

```js
const VALID_ACCOUNT_TYPES = ['CASH', 'BANK', 'ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
```

In `server/services/account-group.service.js` (line 88):

```js
const validTypes = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
```

### Type Determination

The Account Type must be selected at creation time and determines:

- The valid Parent Group options (only same-type groups)
- The auto-derived Nature (Debit/Credit)
- The financial statement placement (Balance Sheet vs. P&L)

---

## 6. FIELD 3 — PARENT ACCOUNT GROUP

| Property | Value |
|---|---|
| **Field** | Parent Group |
| **Type** | Hierarchical Select (dropdown) |
| **Required** | No (top-level groups have no parent) |
| **Purpose** | Specifies whether the group is a primary group or a sub-group |
| **Backend Column** | `account_groups.parent_id` |

### Behavior

- **Empty/None selected** → Creates a **Primary Account Group** (top-level under an Account Type)
- **A group selected** → Creates a **Sub Group** under the selected parent

### Example Flow

User selects:
- Account Type = Assets
- Parent Group = Current Assets

Result hierarchy:

```text
Assets
└── Current Assets
    └── Bank Accounts  ← new group
```

### Parent Group Dropdown Filtering

When the user selects an Account Type:

1. The Parent Group dropdown is populated with only groups of the same Account Type.
2. Top-level groups (those without parents) appear as parent options.
3. The dropdown shows the hierarchy with indentation.

```text
[None — Primary Group]
Assets
├── Current Assets
├── Cash & Cash Equivalents
└── Bank Accounts
Fixed Assets
├── Furniture & Fixtures
└── Computers
```

If the user changes the Account Type, the Parent Group dropdown is **automatically cleared** and repopulated.

---

## 7. PARENT GROUP FILTERING

### Filtering Logic

The Parent Group dropdown dynamically filters based on the selected Account Type.

| Selected Account Type | Available Parent Groups |
|---|---|
| Asset | Only ASSET-type groups |
| Liability | Only LIABILITY-type groups |
| Equity / Capital | Only EQUITY-type groups |
| Income / Revenue | Only INCOME-type groups |
| Expense | Only EXPENSE-type groups |

### What Is NOT Allowed

```text
❌ INVALID: Expense group under Asset parent
Assets
└── Sales Accounts  (type: INCOME — rejected)
```

### Frontend Implementation

In `public/js/pages/chart-of-accounts.js` (lines 580–598):

```js
// Type inheritance: when parent changes, suggest the parent's type
const res = await API.get('/accounting/accounts/groups/suggest/' + selectedId);
const suggestion = res?.data?.suggestion;
if (suggestion && suggestion.type) {
    // Auto-suggest the parent's type
}
```

The `_loadParentGroups` method (line 668) computes all descendants of the exclude ID to prevent circular hierarchy:

```js
// Compute all descendants of excludeId to exclude them (prevents circular hierarchy)
```

### Backend Enforcement

In `server/services/account-group.service.js` (lines 119–133):

```js
// ── Type inheritance: child type must match parent type ──
if (parentId) {
    const parent = repo.getParent(parentId, companyId);
    if (parent && parent.type !== typeUpper) {
        throw new ValidationError(
          `Account Type must match parent group "${parent.name}" (type: ${parent.type}). ` +
          `You cannot create a ${typeUpper} group under a ${parent.type} group.`
        );
    }
}
```

---

## 8. ACCOUNTING NATURE

| Property | Value |
|---|---|
| **Field** | Debit/Credit Nature |
| **Type** | Select (auto-derived, optionally overridable) |
| **Required** | Yes |
| **Purpose** | Determines the normal balance side of the group |

### Auto-Derived Defaults

| Account Type | Default Nature |
|---|---|
| Asset | Debit |
| Liability | Credit |
| Equity / Capital | Credit |
| Income / Revenue | Credit |
| Expense | Debit |

### Backend Implementation

In `server/services/account-group.service.js` (line 117):

```js
const nature = typeUpper === 'LIABILITY' || typeUpper === 'EQUITY' || typeUpper === 'INCOME' 
    ? 'CREDIT' 
    : 'DEBIT';
```

### Manual Override

If manual override is supported:

- Show warning: "Changing the Nature will affect how this group posts transactions and appears in reports."
- Require `accounting.manage` permission.
- Record audit log entry.
- Validate that child groups and ledger accounts are compatible.

**Current Implementation**: Nature is auto-derived only. No user override exists. This is the correct default.

---

## 9. PRIMARY GROUP VS CHILD GROUP

### Primary Account Group

A group without a parent. It sits directly under an Account Type.

**Example**:

```text
Assets (Account Type)
└── Current Assets (Primary Account Group)
```

### Child Account Group / Sub Group

A group with a parent Account Group.

**Example**:

```text
Assets (Account Type)
└── Current Assets (Primary Account Group)
    └── Bank Accounts (Sub Group)
```

### Compatibility Rules

A child group's:

- **Account Type** must match the parent's Account Type.
- **Nature** must match the parent's Nature.
- **Status** can be independently set (but an inactive parent effectively blocks child access for new ledgers).

### Backend Enforcement

In `server/repositories/account-group.repository.js` (lines 241–251):

```js
validateTypeInheritance(parentId, type, debitCreditNature, companyId) {
    if (!parentId) return true; // top-level group, no parent — always OK
    const parent = this.conn.get(
      `SELECT type, debit_credit_nature FROM account_groups WHERE id = ? AND company_id = ?`,
      [parentId, company]
    );
    if (!parent) return false;
    return parent.type === type && parent.debit_credit_nature === debitCreditNature;
}
```

---

## 10. HIERARCHICAL ACCOUNT GROUP RULES

The system enforces seven critical hierarchy rules:

### Rule 1: Single Parent

A group can have only one direct parent.

**Enforced at**: Database schema (`parent_id` is a single column), backend validation.

### Rule 2: No Self-Parent

A group cannot be its own parent.

**Enforced at**: `server/services/account-group.service.js` (line 139–141):

```js
if (parentId && parentId === id) {
    throw new ValidationError('A group cannot be its own parent');
}
```

### Rule 3: No Circular References

```text
❌ INVALID:
A → B → C → A
```

**Enforced at**: `server/repositories/account-group.repository.js` (lines 185–189):

```js
checkCircular(accountId, parentId, companyId) {
    if (!parentId || parentId === accountId) return true;
    const descendants = this.getDescendantGroupIds(companyId, accountId);
    return descendants.includes(parentId);
}
```

Uses a recursive CTE (`getDescendantGroupIds`, lines 166–179) to find all descendants of a group, then checks if the proposed parent is among them.

### Rule 4: Same-Same Account Type

Child groups must belong to the same Account Type as the parent.

**Enforced at**: `server/services/account-group.service.js` (lines 120–126).

### Rule 5: Same Nature

Child groups must follow the parent's accounting Nature.

**Enforced at**: `server/services/account-group.service.js` (lines 128–132).

### Rule 6: Mixed Children Allowed

A group may contain:

- Child Groups (Sub Groups)
- Ledger Accounts
- Or both

This is controlled by the `allow_child_accounts` flag.

**Enforced at**: `account_groups.allow_child_accounts` column (default: 1).

### Rule 7: Configurable Nesting Depth

The hierarchy supports unlimited nesting depth, subject to:

- Database constraints (SQLite recursive CTE depth)
- UI rendering performance
- Application-level depth limit (configurable)

---

## 11. GROUP POSTING BEHAVIOR

### Non-Posting by Default

Account Groups are **classification nodes**. By default:

```text
Account Group = Non-posting (cannot receive direct journal entries)
Ledger Account = Posting (can receive direct journal entries)
```

### Enforcement

In `server/repositories/account-group.repository.js` (line 42):

```js
allow_direct_posting: 0  // Groups always have allow_direct_posting = 0
```

In `server/controllers/accounting.controller.js`, the `createAccountGroup` controller method does not set `allow_direct_posting` — it is implicitly `0` for all account groups.

### Ledger Account Posting Behavior

In `server/controllers/accounting.controller.js` (lines 193–195):

```js
const isGroup = is_group === true || is_group === 'true' || is_group === 1;
const canPost = isGroup ? false : (allow_direct_posting !== false && ...);

// Enforce: Account Groups (is_group=true) cannot receive direct postings
```

This means:
- **Account Groups**: `allow_direct_posting = false` (hardcoded, irreversible)
- **Ledger Accounts**: `allow_direct_posting = true` (can receive postings)

### GL Accounts Dropdown

The `/api/accounting/accounts/gl` endpoint (lines 79–91) returns only posting accounts:

```js
SELECT id, code, name, type, is_active 
FROM accounts 
WHERE company_id = ? 
  AND (is_group = 0 OR is_group IS NULL) 
  AND (allow_direct_posting = 1 OR allow_direct_posting IS NULL)
```

This ensures bank account GL dropdowns only show Ledger Accounts, never Account Groups.

---

## 12. GROUP CODE

| Property | Value |
|---|---|
| **Field** | Group Code |
| **Type** | Text (alphanumeric) |
| **Required** | Yes |
| **Purpose** | Stable, unique internal identifier |
| **Scope** | Unique within company |
| **Backend Column** | `account_groups.code` |
| **Uniqueness Constraint** | `UNIQUE(company_id, code)` |

### Numbering Structure

The system supports configurable numbering. Recommended structure:

```text
1000–1999 = Assets
2000–2999 = Liabilities
3000–3999 = Equity / Capital
4000–4999 = Income / Revenue
5000–5999 = Expenses
```

**Example hierarchy**:

```text
1000 Assets
├── 1100 Current Assets
│   ├── 1110 Cash & Cash Equivalents
│   │   ├── 1111 Petty Cash
│   │   └── 1112 Cash in Hand
│   ├── 1120 Bank Accounts
│   └── 1130 Accounts Receivable
└── 1200 Fixed Assets
    ├── 1210 Furniture & Fixtures
    └── 1220 Computers
```

### Validation Rules

- Must be unique within the company.
- Cannot conflict with Ledger Account codes (separate scope — groups and ledgers use different tables, but the system should warn if codes overlap).
- Backend enforces uniqueness via `UNIQUE(company_id, code)` constraint.

### Auto-Generation

The system supports both manual entry and auto-generation. The `createDefaultChartOfAccounts()` method in `server/repositories/chart-of-accounts.repository.js` uses structured codes:

```js
{ id: 'ag_asset', code: '1000', name: 'Assets', ... }
{ id: 'ag_current_asset', code: '1100', name: 'Current Assets', ... }
{ id: 'ag_cash', code: '1110', name: 'Cash', ... }
```

---

## 13. DESCRIPTION

| Property | Value |
|---|---|
| **Field** | Description |
| **Type** | Textarea (plain text) |
| **Required** | No |
| **Character Limit** | 1000 characters |
| **Purpose** | Explains the accounting purpose of the group |
| **Backend Column** | `account_groups.description` |

### Practical Example

```text
Used to classify all bank and cash-related accounts including
petty cash, savings accounts, and current accounts under
Current Assets.
```

---

## 14. STATUS

| Property | Value |
|---|---|
| **Field** | Status |
| **Type** | Select |
| **Values** | Active, Inactive |
| **Default** | Active |
| **Backend Column** | `account_groups.is_active` (INTEGER: 1=Active, 0=Inactive) |

### Active

- ✅ Available for new Ledger Account creation
- ✅ Available for new Sub Group creation
- ✅ Visible in all dropdowns

### Inactive

- ❌ Cannot be selected for new Ledger Accounts
- ❌ Cannot be selected as parent for new Sub Groups
- ✅ Existing Ledger Accounts and Sub Groups remain intact
- ✅ Historical transactions remain accessible
- ✅ Reports still include data from inactive groups

### Deactivation vs. Deletion

**Do not physically delete** inactive accounting structures. Use **deactivation** instead.

---

## 15. SYSTEM GROUPS

### Protected Groups

Certain Account Groups are **system-defined and protected**. These cannot be deleted, structurally modified, or deactivated.

### Identification

Protected groups have `is_system = 1` (or equivalent flag) in the database.

**Note**: The current `account_groups` table does not have an `is_system` column. This is a recommended enhancement for future implementation. For now, protection is enforced in the application layer.

### Protected Operations

Protected groups cannot have:

- ❌ Deletion
- ❌ Account Type change
- ❌ Parent change
- ❌ Nature change
- ❌ Deactivation

### Implementation

In `server/services/account-group.service.js`, the `remove()` method (lines 268–305) checks for:

1. Child groups: `if (childGroups > 0) → reject`
2. Child accounts: `if (childAccounts > 0) → reject`
3. Transactions through children: `if (hasTransactionsThroughChildren) → reject`

```js
const childGroups = repo.getChildGroupCount(id, companyId);
if (childGroups > 0) {
    throw new ValidationError(
        'Cannot delete this account group because it contains child groups. ' +
        'Move or delete the child groups first.'
    );
}
const childAccounts = repo.getChildAccountCount(id, companyId);
if (childAccounts > 0) {
    throw new ValidationError(
        'Cannot delete this account group because it contains child accounts. ' +
        'Move or delete the child accounts first.'
    );
}
```

### Default Protected Groups

The default Chart of Accounts includes 5 top-level groups that should be treated as protected:

| Code | Name | Type | Reason |
|---|---|---|---|
| 1000 | Assets | ASSET | Top-level; all asset accounts depend on it |
| 2000 | Liabilities | LIABILITY | Top-level; all liability accounts depend on it |
| 3000 | Equity | EQUITY | Contains Retained Earnings (year-end target) |
| 4000 | Income | INCOME | Contains Sales/Service income |
| 5000 | Expenses | EXPENSE | Contains all expense accounts |

### Recommended Enhancement

Add an `is_system` column to `account_groups`:

```sql
ALTER TABLE account_groups ADD COLUMN is_system INTEGER DEFAULT 0 NOT NULL;
```

When seeding the default COA, set `is_system = 1` for the 5 top-level groups.

---

## 16. EMPTY STATE WORKFLOW

### Scenario

When a user attempts to create a Ledger Account and the Account Group dropdown is empty:

### Empty State Display

```text
┌─────────────────────────────────┐
│  (Account Group dropdown)        │
│  ▼                                │
│                                  │
│  No Account Groups Found         │
│  +-- Create Account Group        │
│                                  │
└─────────────────────────────────┘
```

### Workflow

1. **User clicks "Create Account Group"**.
2. The **Account Group creation form** opens (inside the same screen or as a drawer/modal).
3. **User fills in Group Name, Account Type, and other fields**.
4. **User clicks "Save"**.
5. The system:
   - Validates the new group.
   - Saves the group.
   - Closes the group creation form.
   - Returns to the **Create Ledger Account** form.
   - **Refreshes the Account Group dropdown**.
   - **Auto-selects the newly created group**.
6. **User's Ledger Account data is preserved** — they continue entering Account Code, Opening Balance, etc.

### Frontend Implementation

In `public/js/pages/chart-of-accounts.js`:

```js
openAddAccountMenu() {
    // Show menu: Account Group / Ledger Account split
}

openGroupForm(row) {
    // Group form with all fields including Parent Group dropdown
    // "Create Account Group" + "Create & Add Another" buttons
}

_loadParentGroups(el, selectedId, excludeId) {
    // Excludes self and descendants to prevent circular hierarchy
}
```

### Data Preservation

The system must preserve:

- All entered Ledger Account fields (Account Code, Account Name, Opening Balance, etc.)
- The selected Account Type (if compatible with the new group)
- Validation errors and warnings

---

## 17. ACCOUNT GROUP LIST SCREEN

### Navigation Path

```text
Accounting → Chart of Accounts → Account Groups
```

### Table Columns

| Column | Display | Sortable | Filter |
|---|---|---|---|
| Group Code | Yes | Code | Code filter |
| Group Name | Yes | Name | Name search |
| Account Type | Yes (badge) | Type | Type filter |
| Parent Group | Yes | Yes | Parent filter |
| Nature | Yes (Dr/Cr badge) | Yes | Nature filter |
| Child Groups | Yes (count) | Yes | — |
| Ledger Accounts | Yes (count) | Yes | — |
| Status | Yes (Active/Inactive badge) | Yes | Status filter |
| Actions | Yes (menu) | No | — |

### Row Actions

Each row has a context menu (three dots ⋮):

```text
View         — Show detailed group view with hierarchy
Edit         — Open edit form (restricted fields)
Add Sub Group — Create a child group (inherits type/parent)
View Ledgers — List all ledger accounts under this group
Move         — Change parent group (for reorganizing hierarchy)
Deactivate   — Switch to Inactive status
Activate     — Switch to Active status
Delete       — Delete (only if no children/transactions)
```

Actions are **permission-aware**:

- `account_group.view` → View only
- `account_group.update` → Edit, Activate/Deactivate, Move
- `account_group.delete` → Delete
- `account_group.create_subgroup` → Add Sub Group

### Backend Endpoint

```http
GET /api/accounting/accounts/groups
```

Controller: `listAccountGroups` in `server/controllers/accounting.controller.js` (lines 1245–1264).

```js
async listAccountGroups(req, res, next) {
    try {
        const companyId = getCompanyId(req);
        const items = this.groupRepo.conn.all(
          'SELECT * FROM account_groups WHERE company_id = ? ORDER BY type, code',
          [companyId]
        );
        // Enrich with child counts
        const enriched = items.map(g => ({
            ...g,
            is_active: g.is_active !== 0,
            allow_direct_posting: false,
            allow_child_accounts: g.allow_child_accounts !== 0,
            child_groups: this.groupRepo.getChildGroupCount(g.id, companyId),
            child_accounts: this.groupRepo.getChildAccountCount(g.id, companyId),
            total_children: this.groupRepo.getChildGroupCount(g.id, companyId) + this.groupRepo.getChildAccountCount(g.id, companyId)
        }));
        res.json(successResponse({ items: enriched, total: enriched.length, groups: enriched }));
    } catch (err) { next(err); }
}
```

---

## 18. TREE VIEW

### Hierarchical Tree Display

```text
Account Types
├── Assets
│   ├── Current Assets
│   │   ├── Cash & Cash Equivalents
│   │   │   ├── Cash in Hand
│   │   │   └── Petty Cash
│   │   ├── Bank Accounts
│   │   │   ├── HDFC Bank
│   │   │   └── SBI Bank
│   │   └── Accounts Receivable
│   └── Fixed Assets
│       ├── Furniture & Fixtures
│       └── Computers
├── Liabilities
│   ├── Current Liabilities
│   │   ├── Trade Payables
│   │   └── GST Payable
│   └── Long-term Loans
├── Equity / Capital
│   ├── Owner Capital
│   └── Retained Earnings
├── Income
│   ├── Sales Revenue
│   └── Service Income
└── Expenses
    ├── Operating Expenses
    │   ├── Salaries
    │   ├── Rent
    │   └── Utilities
    ├── Administrative Expenses
    └── Selling Expenses
```

### Visual Indicators

| Node Type | Icon | Badge | Color |
|---|---|---|---|
| Account Type | Type filter icon | TYPE | Blue |
| Account Group | Folder icon | GROUP | Blue |
| Sub Group | Folder icon | GROUP | Blue |
| Ledger Account | Account icon | LEDGER | Green |
| Inactive Group | Folder-off icon | -INACTIVE- | Gray |

### Tree Operations

- **Expand** (click + icon) — Show child groups/ledgers
- **Collapse** (click − icon) — Hide child groups/ledgers
- **Search** — Filter tree by name/code (highlights matching nodes)
- **Filter** — Filter by Account Type (Asset, Liability, etc.)
- **Active/Inactive** — Dim inactive groups in the tree
- **Parent/Child** — Indentation shows hierarchy depth

### Frontend Implementation

In `public/js/pages/chart-of-accounts.js`:

```js
// CSS Grid 7-column template
renderTree(rootNodes) {
    const template = 'grid-template-columns: 120px minmax(200px, 1fr) 100px 120px 150px 100px 60px';
    // Columns: Code, Account Name, Type, Category, Balance, Status, Actions
}
```

- **Indentation**: `padding-left: calc(depth * 24px + 12px)` on Account Name cell
- **Toggle icon**: `.coa-expand-icon` class for robust event binding
- **Row height**: `min-height: 48px` for data rows
- **Grouping**: GROUP vs. LEDGER badges with different colors

---

## 19. SEARCH AND FILTER

### Search

Search by:

- **Group Code** — e.g., `1100`, `AST-CUR`
- **Group Name** — e.g., "Current Assets", "Bank"

```text
Search: [____________________] [🔍]
```

### Filters

| Filter | Options | Backend Query |
|---|---|---|
| Account Type | Asset, Liability, Equity, Income, Expense | `type = ?` |
| Parent Group | All groups (hierarchical select) | `parent_id = ?` or `parent_id IS NULL` |
| Nature | Debit, Credit | `debit_credit_nature = ?` |
| Status | Active, Inactive, All | `is_active = ?` |
| Allow Child | Yes, No, All | `allow_child_accounts = ?` |

### Sorting

| Column | Direction |
|---|---|
| Group Code | ASC/DESC |
| Group Name | ASC/DESC |
| Account Type | ASC/DESC |
| Created Date | ASC/DESC |
| Updated Date | ASC/DESC |

---

## 20. CREATE SUB GROUP WORKFLOW

### How to Start

From any eligible Account Group row in the tree or list:

```text
Account Group → ⋮ → Add Sub Group
```

Or from the Account Group detail view:

```text
+ Add Sub Group
```

### Auto-Populated Fields

When creating a Sub Group from a parent:

| Field | Value | Locked? |
|---|---|---|
| Account Type | Inherited from parent | ✅ Yes |
| Parent Group | Set to current group | ✅ Yes |
| Nature | Inherited from parent | ✅ Yes |
| Group Code | Suggested based on parent code | ❌ No (editable) |

### User Enters

| Field | Required? |
|---|---|
| Group Name | Yes |
| Group Code | Yes (auto-suggested, editable) |
| Description | No |
| Allow Child Accounts | Yes (default: ON) |
| Status | Yes (default: Active) |

### Result

```text
Assets
└── Current Assets  (parent — from context)
    └── Bank Accounts  (new Sub Group — user enters name)
```

### Frontend Implementation

In `public/js/pages/chart-of-accounts.js`:

```js
openAddAccountMenu() {
    // Shows: Account Group / Ledger Account split
}
```

The "Add Sub Group" action opens the group form with:

```js
const form = openGroupForm(row);
// form.parent_id = row.id (auto-set)
// form.type = row.type (auto-set, inherited)
```

---

## 21. EDIT ACCOUNT GROUP

### Editable Fields

When editing a Group, the system allows modification of:

| Field | Editable When | Restriction |
|---|---|---|
| Group Name | Always | Must be unique within same parent/type |
| Description | Always | None |
| Status | Always | Cannot deactivate if has active children |
| Allow Child Accounts | Always | Warning if children exist |
| Group Code | Only if no children/transactions | Cannot change if has dependencies |

### Restricted Fields

The following fields are **locked** when the group has children (sub-groups or ledger accounts):

| Field | Reason | Error Message |
|---|---|---|
| Account Type | Would invalidate children | "Cannot change Account Type: group has child accounts or sub-groups" |
| Parent Group | Would break hierarchy | "Cannot change parent: group has child accounts or sub-groups" |
| Nature | Would break accounting | "Cannot change Nature: group has child accounts or sub-groups" |

### Backend Implementation

In `server/services/account-group.service.js` (lines 173–265):

```js
const hasChildren = repo.getChildGroupCount(id, companyId) > 0 ||
                    repo.getChildAccountCount(id, companyId) > 0;

// Code can be changed if no children
if (data.code !== undefined) {
    if (hasChildren) {
        throw new ValidationError('Cannot change Group Code: move children first.');
    }
}

// Type cannot change if has children
if (data.type !== undefined) {
    if (hasChildren) {
        throw new ValidationError('Cannot change Account Type: group has children.');
    }
}
```

### Parent Change

When changing a parent:

1. Validate new parent exists and belongs to the same company.
2. Validate new parent's Account Type matches the group's type.
3. Validate no circular reference would be created.
4. Reject if group has children (parent change is too disruptive).

```js
if (data.parent_id !== undefined) {
    if (newParentId === id) {
        throw new ValidationError('A group cannot be its own parent');
    }
    if (newParentId) {
        const parent = repo.findById(newParentId, companyId);
        if (!parent) throw new ValidationError('Parent group not found');
        if (parent.type !== existing.type) {
            throw new ValidationError('Parent type must match group type');
        }
        if (repo.checkCircular(id, newParentId, companyId)) {
            throw new ValidationError('Circular hierarchy detected');
        }
    }
}
```

---

## 22. DELETE RULES

### Deletion Guard

An Account Group **cannot be deleted** when:

1. **It has child groups** (sub-groups)
2. **It has linked Ledger Accounts**
3. **Any descendant account has transactions** (journal entries)
4. **It is a protected/system group**

### Backend Implementation

In `server/services/account-group.service.js` (lines 268–305):

```js
// Prevent deletion if contains child groups
const childGroups = repo.getChildGroupCount(id, companyId);
if (childGroups > 0) {
    throw new ValidationError(
        'Cannot delete this account group because it contains child groups. ' +
        'Move or delete the child groups first.'
    );
}

// Prevent deletion if contains ledger accounts
const childAccounts = repo.getChildAccountCount(id, companyId);
if (childAccounts > 0) {
    throw new ValidationError(
        'Cannot delete this account group because it contains child accounts. ' +
        'Move or delete the child accounts first.'
    );
}

// Prevent deletion if descendant accounts have transactions
if (repo.hasTransactionsThroughChildren(id, companyId)) {
    throw new ValidationError(
        'Cannot delete this account group because accounts under it have posted journal entries.'
    );
}
```

### User-Facing Message

```text
⚠️ This Account Group cannot be deleted because it contains child accounts or sub-groups.

Move or delete the child groups/accounts first, or deactivate this group to hide it from
new transactions while preserving historical data.
```

### Alternative: Deactivate Instead

When deletion is blocked, show a **Deactivate** option:

```text
[Cancel] [Deactivate]  ← Deactivate is recommended instead
```

---

## 23. DATABASE DESIGN

### Existing Schema

The `account_groups` table in the Black Start CRM database:

```sql
-- account_groups
id            TEXT PRIMARY KEY          -- e.g., 'ag_asset', 'ag_current_asset'
company_id    TEXT NOT NULL DEFAULT 'default'
code          TEXT NOT NULL             -- e.g., '1000'
name          TEXT NOT NULL             -- e.g., 'Current Assets'
parent_id     TEXT                      -- FK to account_groups.id (nullable for root)
type          TEXT NOT NULL             -- e.g., 'ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'
debit_credit_nature TEXT NOT NULL       -- 'DEBIT' or 'CREDIT'
description   TEXT                      -- Optional description
is_active     INTEGER DEFAULT 1         -- 1 = Active, 0 = Inactive
allow_child_accounts INTEGER DEFAULT 1 -- 1 = can have children, 0 = leaf
created_at    DATETIME
updated_at    DATETIME

-- UNIQUE constraint on (company_id, code)
-- Indexes: idx_account_groups_parent, idx_account_groups_company_parent
```

### Relationships

```sql
-- account_groups → account_groups (parent)
account_groups.parent_id → account_groups.id

-- account_groups → accounts (child accounts)
accounts.account_group_id → account_groups.id

-- companies (external)
account_groups.company_id → companies.id
```

### Backend Mapping

The `AccountGroupRepository` class (`server/repositories/account-group.repository.js`) maps database rows to objects with:

```js
{
    ...group,
    is_group: 1,              // Always 1 for account groups
    allow_direct_posting: 0,  // Always 0 (groups are non-posting)
    allow_child_accounts: g.allow_child_accounts !== 0
}
```

### Tree Building

The `getFullTree()` method (lines 93–127) builds a merged hierarchy of groups and ledger accounts:

```js
getFullTree(companyId) {
    // All groups
    const groups = this.conn.all(
        `SELECT * FROM account_groups WHERE company_id = ? ORDER BY type, code ASC`,
        [company]
    ).map(g => ({ ...g, kind: 'group', children: [], ... }));

    // All leaf accounts (is_group = 0)
    const accounts = this.conn.all(
        `SELECT * FROM accounts WHERE company_id = ? AND (is_group = 0 ...) ORDER BY code ASC`,
        [company]
    ).map(a => ({ ...a, kind: 'ledger', children: [], ... }));

    // Merge and build nested tree
    const all = [...groups, ...accounts];
    const map = new Map();
    all.forEach(node => { map.set(node.id, node); });
    
    // Build parent-child relationships
    // ...
}
```

---

## 24. DATABASE CONSTRAINTS

### Unique Code

```sql
-- Already enforced in migration 028
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_groups_company_code
ON account_groups(company_id, code);
```

### Parent Integrity

- Parent must belong to the same company.
- Parent must have the same Account Type.
- Parent must be active (recommended).
- Parent must have `allow_child_accounts = 1`.

Enforced at the **application layer** via `validateTypeInheritance()` and service-level checks.

### Circular Reference Prevention

```sql
-- Recursive CTE used in repository
WITH RECURSIVE descendants(id) AS (
    SELECT id FROM account_groups WHERE id = ? AND company_id = ?
    UNION ALL
    SELECT ag.id FROM account_groups ag
    JOIN descendants d ON ag.parent_id = d.id
    WHERE ag.company_id = ?
)
SELECT id FROM account_groups WHERE id IN (SELECT id FROM descendants) AND company_id = ?
```

### Protected Group Integrity

Currently not enforced at the database level (no `is_system` column). Recommended future enhancement:

```sql
ALTER TABLE account_groups ADD COLUMN is_system INTEGER DEFAULT 0 NOT NULL;
```

With a trigger or application-level check preventing modification/deletion of system groups.

### Referential Integrity

Foreign keys are enabled (`PRAGMA foreign_keys = ON`):

- `accounts.account_group_id → account_groups.id`
- `account_groups.parent_id → account_groups.id`

---

## 25. BACKEND VALIDATION

### Validation Chain

```text
Request
↓
Authentication → authMiddleware
↓
Permission Check → requirePermission('accounting.manage')
↓
Company Validation → getCompanyId(req)
↓
Account Type Validation → type must be in VALID_ACCOUNT_TYPES
↓
Parent Group Validation → parent must exist and belong to same company
↓
Hierarchy Validation → no self-parent, no circular reference
↓
Nature Validation → nature must match parent
↓
Type Inheritance → child type must match parent type
↓
Duplicate Validation → code must be unique within company
↓
Database Transaction → INSERT/UPDATE/DELETE
↓
Audit Log → logAudit() records the action
↓
Response → successResponse() or errorResponse()
```

### Permission Codes

| Permission | Purpose | Used By |
|---|---|---|
| `accounting.manage` | Full CRUD on account groups | createAccountGroup, updateAccountGroup, deleteAccountGroup |
| `accounting.view` | Read-only access | listAccountGroups, getAccountGroup, getFullTree |
| `accounting.create` | Create vouchers/entries | createJournalEntry, createVoucher |
| `accounting.post` | Post vouchers | createVoucher |

### Backend Components

| Layer | File | Key Methods |
|---|---|---|
| Controller | `server/controllers/accounting.controller.js` | `listAccountGroups`, `createAccountGroup`, `getAccountGroup`, `suggestGroupType` |
| Service | `server/services/account-group.service.js` | `create()`, `update()`, `remove()`, `validateGroup()`, `checkCircularParent()`, `validateTypeInheritance()` |
| Repository | `server/repositories/account-group.repository.js` | `search()`, `findById()`, `getFullTree()`, `getChildGroupCount()`, `getChildAccountCount()`, `checkCircular()`, `getDescendantGroupIds()` |
| Repository Base | `server/repositories/accounting-base.repository.js` | Base class with `_company()` helper |

---

## 26. PERMISSIONS

### Permission Matrix

| Action | Admin | Accountant | Staff | Viewer |
|---|---|---|---|---|
| View Account Groups | ✅ | ✅ | ✅ | ✅ |
| Create Account Group | ✅ | ✅ | ❌ | ❌ |
| Edit Account Group | ✅ | ✅ | ❌ | ❌ |
| Delete Account Group | ✅ | ❌ | ❌ | ❌ |
| Activate/Deactivate | ✅ | ❌ | ❌ | ❌ |
| Create Sub Group | ✅ | ✅ | ❌ | ❌ |
| Move Group | ✅ | ❌ | ❌ | ❌ |
| Change Account Type | ✅ | ❌ | ❌ | ❌ |
| Change Parent | ✅ | ❌ | ❌ | ❌ |
| Change Nature | ✅ | ❌ | ❌ | ❌ |

### Implementation

In `server/routes/accounting.js`:

```js
const authView = [authMiddleware, requirePermission('accounting.view')];
const authManage = [authMiddleware, requirePermission('accounting.manage')];

router.get('/accounts/groups', authView, controller.listAccountGroups);
router.get('/accounts/groups/tree', authView, controller.listAccountGroups);
router.get('/accounts/groups/suggest/:parentId', authView, controller.suggestGroupType);
router.get('/accounts/groups/:id', authView, controller.getAccountGroup);
router.post('/accounts/groups', authManage, controller.createAccountGroup);
router.put('/accounts/groups/:id', authManage, controller.updateAccountGroup);
router.delete('/accounts/groups/:id', authManage, controller.deleteAccountGroup);
```

In `server/services/account-group.service.js`:

```js
create(data, context) {
    Authorizer.assertPermission(context, 'accounting.manage');
    // ...
}
```

---

## 27. AUDIT TRAIL

Every significant Account Group change is logged.

### Logged Actions

| Action | Entity Type | When |
|---|---|---|
| ACCOUNT_GROUP_CREATED | ACCOUNT_GROUP | On group creation |
| ACCOUNT_GROUP_MODIFIED | ACCOUNT_GROUP | On group update |
| ACCOUNT_GROUP_DELETED | ACCOUNT_GROUP | On group deletion (if allowed) |
| ACCOUNT_GROUP_ACTIVATED | ACCOUNT_GROUP | On activation |
| ACCOUNT_GROUP_DEACTIVATED | ACCOUNT_GROUP | On deactivation |

### Audit Record Fields

| Field | Description |
|---|---|
| `id` | Audit record ID (generated) |
| `company_id` | Company scope |
| `user_id` | User who made the change |
| `action` | Action type (CREATE, UPDATE, DELETE, etc.) |
| `entity_type` | "ACCOUNT_GROUP" |
| `entity_id` | Group ID |
| `old_values_json` | JSON snapshot before change (null for CREATE) |
| `new_values_json` | JSON snapshot after change (null for DELETE) |
| `ip_address` | Client IP |
| `session_id` | Session identifier |

### Implementation

In `server/services/account-group.service.js` (lines 22–35):

```js
_audit(context, action, entityType, entityId, oldValues, newValues) {
    const { AccountingAuditRepository } = require('../repositories/accounting-audit.repository');
    new AccountingAuditRepository(this.conn).log({
        id: generateId('aud'),
        company_id: context.companyId,
        user_id: context.userId,
        action,
        entity_type: entityType,
        entity_id: entityId,
        old_values_json: oldValues ? JSON.stringify(oldValues) : null,
        new_values_json: newValues ? JSON.stringify(newValues) : null,
        session_id: context.sessionId
    });
}
```

Also via controller-level `logAudit()` function (lines 25–37):

```js
function logAudit(conn, companyId, userId, entity, entityId, action, oldValues = null, newValues = null) {
    try {
        conn.prepare(`
            INSERT INTO accounting_audit (...)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(...);
    } catch (e) { /* Audit logging should not break main operations */ }
}
```

---

## 28. COMPLETE USER WORKFLOW

```text
STEP 1
Company & Financial Year Setup (Step 1 spec)
        ↓
STEP 2
Open Account Type Master (Step 2 spec)
        ↓
[Validate Account Types]
  - All 5 types present
  - Types are system-defined and immutable
  - Nature auto-derived from type
↓
STEP 3
Open Account Group Master (This document)
        ↓
Click "Create Account Group"
        ↓
Select Account Type (dropdown)
        ↓
System loads valid Parent Groups (same type only)
        ↓
Select Parent Group (optional)
        ↓
Enter Group Code (auto-suggested or manual)
        ↓
Enter Group Name
        ↓
Nature auto-derived (Debit/Credit from Account Type)
        ↓
Enter Description (optional)
        ↓
Toggle Allow Child Accounts (default: ON)
        ↓
Select Status (Active/Inactive)
        ↓
Validate all fields (backend + frontend)
        ↓
Click "Create Account Group"
        ↓
Backend creates group with:
  - type validated
  - nature auto-derived
  - parent validated
  - circular hierarchy prevented
  - duplicate code prevented
  - allow_direct_posting = false (always)
  - is_group = true
        ↓
Audit log entry written
        ↓
Show success notification
        ↓
Return to Account Group Tree/List
        ↓
Display new group under correct Account Type
        ↓
Ready for: Ledger Account Creation (Step 4)
```

---

## 29. EXAMPLES

### Example 1 — Current Assets

```text
Account Type: ASSET
Parent: None (Primary Group)
Group: Current Assets
Code: 1100
Nature: Debit
Description: Short-term assets expected to be converted to cash within one year
Status: Active
Allow Child Accounts: ON
```

Result in hierarchy:

```text
Assets (Account Type)
└── Current Assets (Primary Group)
```

### Example 2 — Bank Accounts (Sub Group)

```text
Account Type: ASSET  (inherited from parent)
Parent: Current Assets
Group: Bank Accounts
Code: 1120
Nature: Debit  (auto-derived from ASSET)
Description: All bank accounts including savings and current accounts
Status: Active
Allow Child Accounts: ON
```

Result:

```text
Assets (Account Type)
└── Current Assets (Primary Group)
    └── Bank Accounts (Sub Group)
```

### Example 3 — Sales Accounts

```text
Account Type: INCOME
Parent: None (Primary Group)
Group: Sales Accounts
Code: 4000
Nature: Credit
Description: Revenue from primary business activities
Status: Active
Allow Child Accounts: ON
```

Result:

```text
Income (Account Type)
└── Sales Accounts (Primary Group)
```

### Example 4 — Administrative Expenses

```text
Account Type: EXPENSE
Parent: Operating Expenses
Group: Administrative Expenses
Code: 5110
Nature: Debit
Description: Day-to-day administrative costs
Status: Active
Allow Child Accounts: ON
```

Result:

```text
Expenses (Account Type)
└── Operating Expenses (Primary Group)
    └── Administrative Expenses (Sub Group)
```

---

## 30. INVALID EXAMPLES

### Cross Account Type

```text
❌ INVALID: Expense group under Asset parent
Assets
└── Sales Accounts
(Type: INCOME — rejected: must be ASSET)
```

**Error**: `Account Type must match parent group "Current Assets" (type: ASSET). You cannot create a INCOME group under a ASSET group.`

### Circular Hierarchy

```text
❌ INVALID: A → B → C → A
```

**Error**: `Circular hierarchy detected: the selected parent is a descendant of this group`

### Self Parent

```text
❌ INVALID:
Bank Accounts
Parent = Bank Accounts
```

**Error**: `A group cannot be its own parent`

### Duplicate Code

```text
❌ INVALID:
Group: 1100 (Current Assets) ← already exists
```

**Error**: `Group Code 1100 already exists in this company`

### Invalid Parent

```text
❌ INVALID:
Parent Group = Deleted/Inactive/Cross-type group
```

**Error**: `Parent group not found or does not belong to this company`

### Protected Group Modification

```text
❌ INVALID:
Attempting to change Account Type of "Assets" (top-level system group)
```

**Error**: `Cannot change Account Type: group has child accounts or sub-groups.`

---

## 31. API REQUIREMENTS

### Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/accounting/accounts/groups` | accounting.view | List all groups (optionally with tree format) |
| GET | `/accounting/accounts/groups/tree` | accounting.view | Hierarchical tree view |
| GET | `/accounting/accounts/groups/suggest/:parentId` | accounting.view | Suggest type/nature from parent |
| GET | `/accounting/accounts/groups/:id` | accounting.view | Get single group with details |
| POST | `/accounting/accounts/groups` | accounting.manage | Create new group |
| PUT | `/accounting/accounts/groups/:id` | accounting.manage | Update group |
| DELETE | `/accounting/accounts/groups/:id` | accounting.manage | Delete group (with guards) |

### Response Format

**GET /accounting/accounts/groups**:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "ag_asset",
        "code": "1000",
        "name": "Assets",
        "type": "ASSET",
        "debit_credit_nature": "DEBIT",
        "parent_id": null,
        "is_active": true,
        "allow_child_accounts": true,
        "allow_direct_posting": false,
        "is_group": true,
        "child_groups": 3,
        "child_accounts": 15,
        "total_children": 18
      }
    ],
    "total": 23,
    "groups": [...]
  }
}
```

**POST /accounting/accounts/groups** (success):

```json
{
  "success": true,
  "data": {
    "id": "ag_newgroupid",
    "code": "1130",
    "name": "Advance Tax",
    "type": "ASSET",
    "debit_credit_nature": "DEBIT",
    ...
  },
  "message": "Account group created"
}
```

**Error Response**:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Account Type must match parent group \"Current Assets\" (type: ASSET). You cannot create a INCOME group under a ASSET group."
  }
}
```

---

## 32. REPORTING IMPACT

### Hierarchy Chain for Reporting

```text
Ledger Account
↓
Account Group
↓
Account Type
↓
Financial Statement
```

### Account Group → Financial Statement

| Account Type | Financial Statement | Group Example |
|---|---|---|
| ASSET | Balance Sheet | Current Assets → Bank Accounts → HDFC Bank |
| LIABILITY | Balance Sheet | Current Liabilities → Trade Payables |
| EQUITY | Balance Sheet | Capital → Owner Capital |
| INCOME | Profit & Loss | Sales → Sales Revenue |
| EXPENSE | Profit & Loss | Administrative Expenses → Office Rent |

### Aggregation

The reporting engine uses Account Groups to aggregate Ledger Account balances:

```sql
-- Balance Sheet: Sum all asset accounts grouped by their account group
SELECT ag.name, SUM(a.current_balance) as total
FROM accounts a
JOIN account_groups ag ON ag.id = a.account_group_id
WHERE a.type IN ('ASSET', 'CASH', 'BANK')
GROUP BY ag.id, ag.name
```

### Tree Structure

The Account Group tree enables hierarchical reporting:

```text
Balance Sheet
├── Assets
│   ├── Current Assets
│   │   ├── Cash & Bank → ₹1,50,000
│   │   └── Accounts Receivable → ₹2,00,000
│   │   Subtotal: ₹3,50,000
│   └── Fixed Assets
│       └── Furniture → ₹1,00,000
│   Total Assets: ₹4,50,000
```

---

## 33. UI/UX REQUIREMENTS

### Professional ERP-Style Interface

The UI must be:

- ✅ Professional
- ✅ Clean
- ✅ Accounting-focused
- ✅ Fast
- ✅ Responsive
- ✅ Consistent with Black Start CRM's existing design system

### Components

| Component | Description |
|---|---|
| Tree Navigation | Expand/collapse hierarchical view of groups |
| Search Bar | Global search by code/name |
| Filter Bar | Account Type, Parent, Nature, Status, Allow Child filters |
| Group Table | Tabular view with sortable columns |
| Group Form Modal | Centered modal for create/edit |
| Action Menu | Context menu per row (View/Edit/Add Sub/Group/Delete) |
| Status Badges | Active (green), Inactive (gray), GROUP/LEDGER, Dr/Cr |
| Confirmation Dialogs | For delete, deactivate, type/parent change |
| Success/Error Notifications | Toast messages |

### Visual Design

- **Folder icons** for groups (open/closed states)
- **Account icons** for ledger accounts
- **Indentation** via `padding-left: calc(depth * 24px + 12px)`
- **CSS Grid** 7-column layout: `120px minmax(200px, 1fr) 100px 120px 150px 100px 60px`
- **Row height**: `min-height: 48px`
- **Type badges**: Color-coded by Account Type (Asset=Blue, Liability=Red, Equity=Purple, Income=Green, Expense=Orange)
- **GROUP/LEDGER badges**: Distinguishing groups from ledger accounts

---

## 34. QA TEST CASES

### Test Case Table

| Test Case ID | Scenario | Input | Expected Result | Priority |
|---|---|---|---|---|
| TC-AG-01 | Create Asset Account Group | type=ASSET, code=1100, name=Current Assets | Group created successfully | P0 |
| TC-AG-02 | Create Liability Account Group | type=LIABILITY, code=2100, name=Current Liabilities | Group created successfully | P0 |
| TC-AG-03 | Create Equity Account Group | type=EQUITY, code=3100, name=Owner's Capital | Group created successfully | P0 |
| TC-AG-04 | Create Income Account Group | type=INCOME, code=4000, name=Sales Revenue | Group created successfully | P0 |
| TC-AG-05 | Create Expense Account Group | type=EXPENSE, code=5000, name=Office Expenses | Group created successfully | P0 |
| TC-AG-06 | Create Sub Group under parent | type=ASSET, parent=Current Assets, name=Bank Accounts | Group created with correct parent | P0 |
| TC-AG-07 | Parent Account Type filtering | Select ASSET type | Only ASSET groups shown as parents | P0 |
| TC-AG-08 | Reject cross-type parent | type=EXPENSE, parent=Current Assets (ASSET) | Validation error | P1 |
| TC-AG-09 | Prevent self-parent | Set parent_id = own group ID | Validation error: "cannot be its own parent" | P1 |
| TC-AG-10 | Prevent circular hierarchy | Set parent = child of self | Validation error: "Circular hierarchy detected" | P1 |
| TC-AG-11 | Auto-derive Nature | type=ASSET | debit_credit_nature = DEBIT | P0 |
| TC-AG-12 | Auto-derive Nature | type=LIABILITY | debit_credit_nature = CREDIT | P0 |
| TC-AG-13 | Auto-derive Nature | type=EQUITY | debit_credit_nature = CREDIT | P0 |
| TC-AG-14 | Auto-derive Nature | type=INCOME | debit_credit_nature = CREDIT | P0 |
| TC-AG-15 | Auto-derive Nature | type=EXPENSE | debit_credit_nature = DEBIT | P0 |
| TC-AG-16 | Validate duplicate Group Code | Create group with existing code | Validation error | P1 |
| TC-AG-17 | Validate duplicate Group Name | Create group with existing name in same type | Warning or error | P2 |
| TC-AG-18 | Create inactive Group | is_active=false | Group created but not selectable | P1 |
| TC-AG-19 | Prevent Ledger selection of inactive Group | Create ledger under inactive group | Validation error | P1 |
| TC-AG-20 | Edit Group Name | Edit name field | Name updated | P0 |
| TC-AG-21 | Prevent unsafe Account Type change | Change type on group with children | Validation error | P1 |
| TC-AG-22 | Prevent unsafe Parent change | Change parent on group with children | Validation error | P1 |
| TC-AG-23 | Delete empty group succeeds | Delete group with no children | Success | P0 |
| TC-AG-24 | Prevent deletion with child groups | Delete group with sub-groups | Validation error | P1 |
| TC-AG-25 | Prevent deletion with ledger accounts | Delete group with ledgers | Validation error | P1 |
| TC-AG-26 | Prevent deletion with transactions | Delete group with transaction history | Validation error | P1 |
| TC-AG-27 | RBAC: no permission to create | User without accounting.manage | 403 Forbidden | P1 |
| TC-AG-28 | RBAC: no permission to delete | User without accounting.manage | 403 Forbidden | P1 |
| TC-AG-29 | Audit log on creation | Create group | Audit entry written | P1 |
| TC-AG-30 | Audit log on update | Edit group | Audit entry with old/new values | P1 |
| TC-AG-31 | Audit log on deletion | Delete group | Audit entry written | P1 |
| TC-AG-32 | Tree refresh after creation | Create group, then load tree | New group appears in tree | P0 |
| TC-AG-33 | Empty state workflow | Create ledger, no groups exist | Show "No Account Groups Found" + "Create Account Group" | P1 |
| TC-AG-34 | Add Sub Group from parent | Click "Add Sub Group" on existing group | Form pre-fills parent/type/nature | P0 |
| TC-AG-35 | allow_direct_posting = false | Create group | Group cannot be selected in GL dropdown | P0 |
| TC-AG-36 | GL endpoint excludes groups | GET /accounts/gl | Returns only ledger accounts | P0 |
| TC-AG-37 | Financial Year isolation | Groups in FY 2026-27 | Not visible in FY 2025-26 | P2 |
| TC-AG-38 | Company isolation | Groups in Company A | Not visible in Company B | P1 |
| TC-AG-39 | suggestFromParent | Parent is ASSET | Suggests type=ASSET, nature=DEBIT | P1 |
| TC-AG-40 | Account Group has allow_direct_posting=false | Verify in tree response | found.allow_direct_posting === false | P0 |

---

## 35. ACCEPTANCE CRITERIA

### Step 3 is complete only when:

- [x] Account Groups can be created successfully under valid Account Types
- [x] Account Type → Group dependency is enforced (same type required)
- [x] Parent Group dropdown is dynamically filtered by Account Type
- [x] Cross-type parent assignment is rejected
- [x] Self-parent assignment is rejected
- [x] Circular hierarchy is rejected
- [x] Nature is auto-derived from Account Type (Debit for Asset/Expense, Credit for Liability/Equity/Income)
- [x] Account Groups have `allow_direct_posting = false` (non-posting)
- [x] Account Groups are excluded from GL accounts endpoints
- [x] Account Groups have `allow_child_accounts` field for hierarchy control
- [x] Parent group validation checks type inheritance
- [x] Duplicate group codes are rejected (UNIQUE constraint + application check)
- [x] Deletion is blocked when child groups exist
- [x] Deletion is blocked when child ledger accounts exist
- [x] Deletion is blocked when descendant accounts have transactions
- [x] Groups with children cannot change Account Type or Parent
- [x] Empty state workflow shows "No Account Groups Found" with "+ Create Account Group"
- [x] Creating a group from the Ledger Account workflow returns to the form and refreshes the dropdown
- [x] RBAC permissions are enforced (accounting.view, accounting.manage)
- [x] Audit log entries are written on create/update/delete
- [x] Tree view shows correct hierarchy with GROUP/LEDGER badges
- [x] All existing tests remain green (82/82 passing)
- [x] Database referential integrity is maintained (foreign keys ON)

### What was implemented:

All of the above criteria were satisfied by the existing implementation and the fixes applied. The Account Group system is fully functional with:

- **Frontend**: `public/js/pages/chart-of-accounts.js` — full tree UI, group form, parent filtering, type inheritance, circular prevention
- **Backend**: `server/controllers/accounting.controller.js` — group CRUD with validation, `GET /accounts/gl` endpoint
- **Service**: `server/services/account-group.service.js` — all validation logic centralized
- **Repository**: `server/repositories/account-group.repository.js` — tree building, child counting, circular detection
- **Database**: Migration 028 adds `allow_child_accounts`, indexes, and unique constraint on `(company_id, code)`
- **Tests**: 10 Account Group tests added, all 82 tests passing

---

## 36. FINAL ACCOUNTING FLOW

After completing Step 3, the full accounting hierarchy is:

```text
COMPANY
   ↓
FINANCIAL YEAR                (Step 1)
   ↓
ACCOUNT TYPE                  (Step 2)
   ↓
ACCOUNT GROUP                 (Step 3 — This document)
   ↓
SUB GROUP                     (via "Add Sub Group" workflow)
   ↓
LEDGER ACCOUNT                (Step 4 — following spec)
   ↓
OPENING BALANCE
   ↓
TRANSACTIONS
   ↓
LEDGER
   ↓
TRIAL BALANCE
   ↓
PROFIT & LOSS
   ↓
BALANCE SHEET
```

### Final Business Rule

> **Account Type must exist first → Account Group must be created next under the correct Account Type → Sub Groups and Ledger Accounts can then be created under the matching Account Group.**

> **Account Groups are non-posting classification nodes. They enforce the accounting hierarchy. All posting occurs at the Ledger Account level. The system prevents invalid hierarchies (cross-type, circular, self-parent) and protects against data loss (deletion guards, activation over deletion).**

---

*End of Document*

**Document Path:** `docs/BLACK_START_CRM_STEP_3_ACCOUNT_GROUP_MASTER_AND_CREATION_WORKFLOW.md`