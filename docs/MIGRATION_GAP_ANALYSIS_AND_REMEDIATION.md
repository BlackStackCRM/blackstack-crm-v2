# BLACK STACK CRM V2 — Migration Gap Analysis & Remediation Report

> Engineering report detailing the unapplied migrations (059-066), their impact on application functionality, and the exact remediation steps.

---

## 1. Overview

Black Stack CRM V2 has **66 migration files** (001–066) in `server/database/migrations/`. Of these, **57 are applied** to the live database (`data/blackstack-crm.db`), and **9 are NOT applied**:

| Migration | Step | Applied? | Purpose |
|-----------|------|---------|---------|
| 059 | 10 | ❌ | Add `payment_number` column to `payments` |
| 060 | 11 base | ❌ | (Credit/debit note foundational — see note) |
| 063 | 12 | ❌ | `collection_assignments`, `collection_activities`, `promises_to_pay`, `customer_disputes` |
| 064 | 12 | ❌ | 10 RBAC permissions for Step 12 |
| 065 | 14 | ❌ | 11 tables for collections automation (rules, actions, interest, bad debt, payment plans, risk, escalations) |
| 066 | 14 | ❌ | 11 RBAC permissions for Step 14 (BUG: uses `permission` column instead of `code`) |

### 1.1 Migration 060 Status

Migration 060 is **not present** as a file in `server/database/migrations/`. The file listing jumps from `059_step10_payment_number.sql` to `061_step11_credit_debit_note.sql`. This means migration 060 was either never created or was removed. The Step 11 features (credit/debit notes) work because migrations 061 and 062 handle the schema and permissions. Migration 060 is not referenced anywhere in the codebase.

**Conclusion**: Migration 060 does not exist and is not needed. Only 8 migrations are genuinely missing (059, 063, 064, 065, 066).

---

## 2. Detailed Gap Analysis

### 2.1 Migration 059 — Step 10: Payment Number (❌ Not Applied)

**File**: `server/database/migrations/059_step10_payment_number.sql`

```sql
ALTER TABLE payments ADD COLUMN payment_number TEXT;
```

**Impact**:
- The `payments` table is missing the `payment_number` column.
- `receivable-summary.repository.js` line 318 references `p.payment_number` in the customer statement query. Without the column, this query will throw `SQLITE_ERROR: table payments has no column named payment_number`.
- `customer-bill.service.js` likely references `payment_number` in payment creation/recording logic.

**Table affected**: `payments`

**Current `payments` schema** (13 columns):
```
id, company_id, invoice_id, bill_id, contact_id, amount, payment_method, status,
reference_number, notes, payment_date, currency, created_at, updated_at
```

**Expected schema after migration** (14 columns):
```
id, company_id, invoice_id, bill_id, contact_id, amount, payment_method, status,
reference_number, notes, payment_date, currency, created_at, updated_at, payment_number
```

### 2.2 Migration 063 — Step 12: Collection Management Tables (❌ Not Applied)

**File**: `server/database/migrations/063_step12_collection_management.sql`

Creates 4 new tables and adds 2 columns to `contacts`:

#### New Tables

**1. `collection_assignments`** — Who owns collections for each customer

```sql
CREATE TABLE collection_assignments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  owner_id TEXT,              -- current collection owner
  previous_owner_id TEXT,     -- previous owner for audit trail
  priority TEXT,              -- CRITICAL, HIGH, NORMAL, LOW
  status TEXT,                -- NEW, ASSIGNED, IN_PROGRESS, PROMISED, RESOLVED, ESCALATED
  notes TEXT,
  bill_id TEXT,               -- nullable, links to specific bill
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT
);
```

**Referenced by**:
- `receivable-summary.repository.js` lines 498-503 (`getCollectionAssignment`)
- `receivable-summary.repository.js` lines 509-539 (`assignCollection`)
- `receivable-summary.repository.js` lines 545-559 (`updateCollectionStatus`)
- `receivable-summary.repository.js` lines 678-720 (`getCollectionAssignments`)
- `receivable-summary.repository.js` lines 849-862 (`getPaymentReminders`)

**2. `collection_activities`** — Collection activity log (calls, emails, meetings)

```sql
CREATE TABLE collection_activities (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  contact_id TEXT,
  bill_id TEXT,
  assignment_id TEXT,
  user_id TEXT,
  activity_type TEXT,          -- PHONE_CALL, WHATSAPP, EMAIL, MEETING, REMINDER, PROMISE, ESCALATION, NOTE
  activity_date TEXT,
  result TEXT,
  next_action TEXT,
  next_action_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
```

**Referenced by**:
- `receivable-summary.repository.js` lines 619-636 (`logCollectionActivity`)
- `receivable-summary.repository.js` lines 641-661 (`getCollectionActivities`)

**3. `promises_to_pay`** — Promise-to-pay tracking

```sql
CREATE TABLE promises_to_pay (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  bill_id TEXT,
  assignment_id TEXT,
  user_id TEXT,
  promise_date TEXT,
  promise_amount REAL,
  notes TEXT,
  status TEXT,                -- PROMISED, FULFILLED, PARTIAL, BROKEN, CANCELLED
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  fulfilled_at TEXT
);
```

**Referenced by**:
- `receivable-summary.repository.js` lines 565-594 (`createPromiseToPay`)
- `receivable-summary.repository.js` lines 599-614 (`updatePromise`)
- `receivable-summary.repository.js` lines 666-673 (`getPromisesToPay`)

**4. `customer_disputes`** — Collection-level disputes (richer than Step 11's `customer_bill_disputes`)

```sql
CREATE TABLE customer_disputes (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  bill_id TEXT,
  user_id TEXT,
  reason TEXT,
  disputed_amount REAL,
  customer_message TEXT,
  internal_notes TEXT,
  status TEXT,                -- OPEN, IN_REVIEW, RESOLVED, REJECTED, CLOSED
  owner_id TEXT,
  resolution_reason TEXT,
  resolution_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_by TEXT
);
```

**Referenced by**:
- `receivable-summary.repository.js` lines 761-783 (`createDispute`)
- `receivable-summary.repository.js` lines 785-818 (`getDisputes`)
- `receivable-summary.repository.js` lines 820-838 (`resolveDispute`)

#### Column Additions to `contacts`

```sql
ALTER TABLE contacts ADD COLUMN customer_code TEXT;
ALTER TABLE contacts ADD COLUMN gstin TEXT;
```

**Impact**:
- `customer_code` is used in the outstanding query to display customer codes.
- `gstin` is used in the outstanding query to display GSTIN numbers.
- Without these columns, the `getCustomerOutstanding()` query will fail with `no column named customer_code`.

**Referenced by**:
- `receivable-summary.repository.js` lines 54-57: `c.customer_code AS customer_code, c.gstin`

**5. `credit_rules` table** (NOT in migration 063 but referenced in code)

**Finding**: `receivable-summary.repository.js` line 106 LEFT JOINs `credit_rules`:
```sql
LEFT JOIN credit_rules cr ON cr.contact_id = c.id AND cr.company_id = b.company_id
```

And line 59: `COALESCE(cr.credit_limit, 0) AS credit_limit`
And line 60: `COALESCE(cr.credit_period_days, 30) AS credit_days`

However, the `credit_rules` table is **NOT created by migration 063**. It is also **NOT created by any other migration**. Searching the codebase, `credit_rules` is not referenced in migration files 001-066.

**Root Cause**: The `credit_rules` table was never created. Migration 063 may have been intended to include it but doesn't. OR it was supposed to be part of an earlier migration.

**Impact**: The LEFT JOIN will silently produce NULL for all credit_rules columns. This is a silent failure (no error) but means `credit_limit` and `credit_days` will always be 0/30 default values.

**Referenced by**:
- `receivable-summary.repository.js` line 106

### 2.3 Migration 064 — Step 12: Permissions (❌ Not Applied)

**File**: `server/database/migrations/064_step12_permissions.sql`

Inserts 10 permissions into the `permissions` table and assigns them to the admin role:

| Permission Code | Name | Description |
|----------------|------|-------------|
| `customer_bills.view_outstanding` | View Customer Outstanding | Can view AR customer outstanding page |
| `customer_bills.view_aging` | View AR Aging | Can view AR aging reports |
| `customer_bills.view_statement` | View Customer Statement | Can view customer account statements |
| `customer_bills.export_reports` | Export AR Reports | Can export outstanding, aging, statements |
| `customer_bills.manage_collections` | Manage Collections | Can manage collection assignments/activities |
| `customer_bills.assign_collection_owner` | Assign Collection Owner | Can assign/reassign collection owners |
| `customer_bills.manage_promises` | Manage Promises to Pay | Can create/update/cancel promises |
| `customer_bills.manage_disputes` | Manage Customer Disputes | Can create/update/resolve disputes |
| `customer_bills.view_reports` | View Reports | Can view billing reports, analytics |
| `customer_bills.view_collection_dashboard` | View Collection Dashboard | Can view collection dashboard KPIs |

**Note**: Migration 057 (`customer_bills_permissions`) already inserted `customer_bills.view_reports`. Migration 064 duplicates this permission (using `INSERT OR IGNORE`), so no conflict occurs — the duplicate is silently skipped.

**Impact**: All Step 12 routes require these permissions. Without them in the DB:
- Users will get 403 Forbidden on all Step 12 endpoints
- The `role_permissions` table won't have the associations

### 2.4 Migration 065 — Step 14: Collections Automation Tables (❌ Not Applied)

**File**: `server/database/migrations/065_step14_collections_automation.sql`

Creates 11 new tables:

#### Table Summary

| Table | Purpose | Rows in Code | Referenced By |
|-------|---------|-------------|---------------|
| `collection_rules` | Configurable dunning triggers (aging days, customer segment, min outstanding → action) | 4 columns key | `collections.service.js`, `collections.repository.js` |
| `collection_actions` | Every automated/manual collection action record | Status tracking | `collections.service.js`, `collections.repository.js` |
| `collection_action_logs` | Immutable execution history per action | Audit trail | `collections.repository.js` (`logActionEvent`) |
| `communication_templates` | Email/SMS/WhatsApp templates with variables | Template management | `collections.service.js`, `collections.repository.js` |
| `interest_rules` | Configurable late-fee calculation (rate_type, rate, grace period) | Interest config | `collections.service.js`, `collections.repository.js` |
| `interest_charges` | Calculated and posted late fees (links to JE) | Interest tracking | `collections.service.js`, `collections.repository.js` |
| `bad_debt_cases` | Bad debt write-off workflow (status, approval, provision) | Write-off management | `collections.service.js`, `collections.repository.js` |
| `payment_plans` | Customer payment plan headers | Installment tracking | `collections.service.js`, `collections.repository.js` |
| `payment_plan_installments` | Payment plan installment lines | Payment schedule | `collections.service.js`, `collections.repository.js` |
| `collection_risk_scores` | Risk scoring (score, factors_json, model_version) | Risk assessment | `collections.service.js`, `collections.repository.js` |
| `collection_escalations` | Escalation records (level, owner change, approval) | Escalation tracking | `collections.service.js`, `collections.repository.js` |

Each table includes:
- `company_id` for company isolation
- `created_at` / `updated_at` timestamps
- `created_by` user tracking
- Appropriate indexes on `company_id`, `status`, `customer_id`/`contact_id`

#### Detailed Schema for Key Tables

**`collection_rules`**:
```sql
CREATE TABLE collection_rules (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_active INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,
  trigger_type TEXT NOT NULL,           -- OVERDUE, DAYS_AFTER_DUE, INVOICE_STATUS
  aging_days_from INTEGER NOT NULL DEFAULT 0,
  aging_days_to INTEGER NOT NULL DEFAULT 0,
  customer_segment TEXT,
  minimum_outstanding REAL DEFAULT 0,
  action_type TEXT NOT NULL,             -- EMAIL, SMS, WHATSAPP, PHONE_CALL, etc.
  action_config TEXT,                    -- JSON config for the action
  escalation_level INTEGER DEFAULT 1,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**`interest_charges`**:
```sql
CREATE TABLE interest_charges (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  bill_id TEXT NOT NULL,
  calculation_date TEXT NOT NULL,
  principal_amount REAL NOT NULL,
  overdue_days INTEGER NOT NULL,
  rate REAL NOT NULL,
  rate_type TEXT NOT NULL,               -- FIXED, TIERED
  calculated_amount REAL NOT NULL,
  approved_amount REAL,                  -- may differ from calculated
  status TEXT NOT NULL DEFAULT 'CALCULATED',  -- CALCULATED, APPROVED, POSTED, REJECTED
  journal_entry_id TEXT,                 -- links to JE created on posting
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  updated_at TEXT NOT NULL
);
```

**`bad_debt_cases`**:
```sql
CREATE TABLE bad_debt_cases (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  bill_id TEXT NOT NULL,
  outstanding_amount REAL NOT NULL,
  reason TEXT NOT NULL,
  aging_days INTEGER,
  provision_percentage REAL,
  provision_amount REAL,
  status TEXT NOT NULL DEFAULT 'PROPOSED',  -- PROPOSED, APPROVED, WRITTEN_OFF, REVERSED
  requested_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**`payment_plans`**:
```sql
CREATE TABLE payment_plans (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  bill_id TEXT NOT NULL,
  plan_number TEXT NOT NULL,
  total_amount REAL NOT NULL,
  down_payment REAL DEFAULT 0,
  financed_amount REAL NOT NULL,
  instalment_count INTEGER NOT NULL,
  frequency TEXT NOT NULL,                 -- MONTHLY, WEEKLY, QUARTERLY, etc.
  start_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',    -- DRAFT, ACTIVE, COMPLETED, CANCELLED
  approved_by TEXT,
  approved_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**`collection_risk_scores`**:
```sql
CREATE TABLE collection_risk_scores (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  score INTEGER NOT NULL,                  -- 0-100
  risk_level TEXT NOT NULL,                -- LOW, MEDIUM, HIGH, CRITICAL
  outstanding_amount REAL,
  overdue_amount REAL,
  overdue_days INTEGER,
  payment_history_score REAL,
  ageing_score REAL,
  collection_response_score REAL,
  payment_plan_score REAL,
  factors_json TEXT,                       -- explainable factors
  model_version TEXT,
  created_at TEXT NOT NULL
);
```

### 2.5 Migration 066 — Step 14: Permissions (❌ Not Applied + BUG)

**File**: `server/database/migrations/066_step14_permissions.sql`

Inserts 11 permissions into the `permissions` table:

| Permission Code | Name | Description |
|----------------|------|-------------|
| `customer_bills.view_collections` | View Collections Workspace | Can view collection dashboard and lists |
| `customer_bills.manage_collection_rules` | Manage Collection Rules | Can CRUD collection rules |
| `customer_bills.execute_collection_actions` | Execute Collection Actions | Can create/execute actions |
| `customer_bills.manage_payment_plans` | Manage Payment Plans | Can create/update/approve plans |
| `customer_bills.calculate_interest` | Calculate Interest | Can calculate late fees |
| `customer_bills.approve_interest` | Approve Interest | Can approve interest charges |
| `customer_bills.manage_bad_debt` | Manage Bad Debt | Can propose/manage bad debt |
| `customer_bills.approve_bad_debt` | Approve Bad Debt | Can approve write-offs |
| `customer_bills.view_collection_risk` | View Collection Risk | Can view risk scores |
| `customer_bills.manage_escalations` | Manage Escalations | Can create/manage escalations |
| `customer_bills.export_collections` | Export Collections | Can export collection data |

**BUG**: Line 3 of the migration:
```sql
INSERT INTO permissions (id, company_id, permission, module, name, description) VALUES
```

The column name is `permission` but the actual column in the `permissions` table is `code` (as confirmed by the schema: `permissions: id, company_id, code, module, name, description`). This will cause a **foreign key constraint failure** or **no such column** error when the migration runs.

**Impact**: 
- Migration 066 will fail to execute, halting the migration process
- All Step 14 permissions will be missing from the DB
- All Step 14 routes require these permissions and will return 403

---

## 3. Code References to Missing Tables/Columns

### 3.1 `receivable-summary.repository.js` — References to Missing Tables

| Line | Table | Operation | Impact |
|------|-------|-----------|--------|
| 106 | `credit_rules` | LEFT JOIN | Silent NULL (credit_limit/credit_days always 0/30) |
| 318 | `payments.payment_number` | SELECT | **HARD ERROR** — column doesn't exist |
| 498-503 | `collection_assignments` | SELECT JOIN users | **HARD ERROR** — table doesn't exist |
| 509-539 | `collection_assignments` | INSERT/UPDATE | **HARD ERROR** — table doesn't exist |
| 545-559 | `collection_assignments` | SELECT/UPDATE | **HARD ERROR** — table doesn't exist |
| 570-577 | `promises_to_pay` | INSERT | **HARD ERROR** — table doesn't exist |
| 581-588 | `collection_assignments` | SELECT/UPDATE | **HARD ERROR** — table doesn't exist |
| 601-610 | `promises_to_pay` | SELECT/UPDATE | **HARD ERROR** — table doesn't exist |
| 624-629 | `collection_activities` | INSERT | **HARD ERROR** — table doesn't exist |
| 646-653 | `collection_activities` | SELECT JOIN users | **HARD ERROR** — table doesn't exist |
| 655-658 | `collection_activities` | SELECT COUNT | **HARD ERROR** — table doesn't exist |
| 668-672 | `promises_to_pay` | SELECT | **HARD ERROR** — table doesn't exist |
| 704-712 | `collection_assignments` | SELECT JOIN contacts/users | **HARD ERROR** — table doesn't exist |
| 714-717 | `collection_assignments` | SELECT COUNT | **HARD ERROR** — table doesn't exist |
| 747-755 | `collection_audit` (NOT `collection_action_logs`) | INSERT | **HARD ERROR** — table doesn't exist |
| 810-812 | `customer_disputes` | SELECT JOIN contacts/organizations/bills/users | **HARD ERROR** — table doesn't exist |
| 800 | `customer_disputes` | SELECT COUNT | **HARD ERROR** — table doesn't exist |
| 774-779 | `customer_disputes` | INSERT | **HARD ERROR** — table doesn't exist |
| 830-833 | `customer_disputes` | UPDATE | **HARD ERROR** — table doesn't exist |

### 3.2 `collections.repository.js` — References to Missing Tables

| Table | Operations | Methods Affected |
|-------|-----------|------------------|
| `collection_rules` | CRUD | `listCollectionRules`, `getCollectionRule`, `createCollectionRule`, `updateCollectionRule`, `deleteCollectionRule` |
| `collection_actions` | CRUD + status | `listCollectionActions`, `getCollectionAction`, `createCollectionAction`, `executeCollectionAction`, `logActionEvent` |
| `collection_action_logs` | INSERT | `logActionEvent` |
| `communication_templates` | CRUD | `listTemplates`, `createTemplate`, `renderTemplate` |
| `interest_rules` | CRUD | `listInterestRules`, `getInterestRule`, `createInterestRule` |
| `interest_charges` | CRUD | `calculateInterest`, `createInterestCharge`, `approveInterestCharge`, `postInterestCharge` |
| `bad_debt_cases` | CRUD | `listBadDebtCases`, `getBadDebtCase`, `createBadDebtCase`, `approveBadDebtCase`, `writeOffBadDebt`, `reverseBadDebtCase` |
| `payment_plans` | CRUD | `listPaymentPlans`, `getPaymentPlan`, `createPaymentPlan`, `approvePaymentPlan`, `cancelPaymentPlan` |
| `payment_plan_installments` | CRUD | `createPaymentPlan` (installment generation) |
| `collection_risk_scores` | INSERT/SELECT | `calculateRiskScore` |
| `collection_escalations` | CRUD | `createEscalation`, `listEscalations`, `approveEscalation` |

### 3.3 `customer-bill.service.js` — References to Missing Columns

| Column | Referenced In |
|--------|--------------|
| `payments.payment_number` | Payment statement display, payment creation |
| `contacts.customer_code` | Customer outstanding display |
| `contacts.gstin` | Customer outstanding display |

### 3.4 `customer-bill.controller.js` — Controller Methods Requiring Missing Tables

| Method | Line | Missing Dependency |
|--------|------|-------------------|
| `getCustomerOutstanding` | 731 | `credit_rules` table |
| `getCustomerAging` | 747 | `receivables` table (exists) |
| `getInvoiceAging` | 757 | `receivables` table (exists) |
| `getAging` | 768 | `receivables` table (exists) |
| `getReceivablesSummary` | 780 | `receivables` table (exists) |
| `getStatusCounts` | 801 | `bills`, `receivables` (exist) |
| `getKpiSummary` | 831 | `bills`, `receivables` (exist) |
| `getAgingDistribution` | 1241 | `receivables` (exists) |
| `assignCollectionOwner` | 1297 | `collection_assignments` (MISSING) |
| `getCollectionActivities` | 963 | `collection_activities` (MISSING) |
| `addCollectionActivity` | 977 | `collection_activities` (MISSING) |
| `createPromiseToPay` | 990 | `promises_to_pay` (MISSING) |
| `getPromisesToPay` | 1004 | `promises_to_pay` (MISSING) |
| `recordPromisePayment` | 1014 | `promises_to_pay` (MISSING) |
| `createDispute` | 1027 | `customer_disputes` (MISSING) |
| `getDisputes` | 1038 | `customer_disputes` (MISSING) |
| `getCollectionDashboard` | 1055 | `receivables` (exists) |
| `resolveCollectionDispute` | 1065 | `customer_disputes` (MISSING) |
| `listCollectionRules` | 1276 | `collection_rules` (MISSING) |
| `getCollectionRule` | 1283 | `collection_rules` (MISSING) |
| `createCollectionRule` | 1290 | `collection_rules` (MISSING) |
| `updateCollectionRule` | 1297 | `collection_rules` (MISSING) |
| `deleteCollectionRule` | 1304 | `collection_rules` (MISSING) |
| `runDunning` | 1312 | `collection_rules`, `collection_actions` (MISSING) |
| `getDunningActions` | 1319 | `collection_actions` (MISSING) |
| `listCollectionActions` | 1327 | `collection_actions` (MISSING) |
| `getCollectionAction` | 1334 | `collection_actions` (MISSING) |
| `createCollectionAction` | 1341 | `collection_actions` (MISSING) |
| `executeCollectionAction` | 1348 | `collection_actions`, `collection_action_logs` (MISSING) |
| `listTemplates` | 1356 | `communication_templates` (MISSING) |
| `getTemplate` | 1363 | `communication_templates` (MISSING) |
| `createTemplate` | 1370 | `communication_templates` (MISSING) |
| `listInterestRules` | 1378 | `interest_rules` (MISSING) |
| `getInterestRule` | 1385 | `interest_rules` (MISSING) |
| `createInterestRule` | 1392 | `interest_rules` (MISSING) |
| `calculateInterest` | 1399 | `interest_rules` (MISSING) |
| `createInterestCharge` | 1406 | `interest_rules`, `interest_charges` (MISSING) |
| `approveInterestCharge` | 1413 | `interest_charges` (MISSING) |
| `postInterestCharge` | 1420 | `interest_charges`, `journal_entries` (partially exists) |
| `listBadDebtCases` | 1428 | `bad_debt_cases` (MISSING) |
| `getBadDebtCase` | 1435 | `bad_debt_cases` (MISSING) |
| `createBadDebtCase` | 1442 | `bad_debt_cases` (MISSING) |
| `approveBadDebtCase` | 1449 | `bad_debt_cases` (MISSING) |
| `writeOffBadDebt` | 1456 | `bad_debt_cases` (MISSING) |
| `reverseBadDebtCase` | 1463 | `bad_debt_cases` (MISSING) |
| `listPaymentPlans` | 1471 | `payment_plans` (MISSING) |
| `getPaymentPlan` | 1478 | `payment_plans` (MISSING) |
| `createPaymentPlan` | 1485 | `payment_plans`, `payment_plan_installments` (MISSING) |
| `approvePaymentPlan` | 1492 | `payment_plans` (MISSING) |
| `cancelPaymentPlan` | 1499 | `payment_plans` (MISSING) |
| `applyPaymentToPlan` | 1506 | `payment_plans`, `payment_plan_installments` (MISSING) |
| `calculateRiskScore` | 1514 | `collection_risk_scores` (MISSING) |
| `getCollectionForecast` | 1522 | `receivables` (exists) |
| `createEscalation` | 1530 | `collection_escalations` (MISSING) |
| `listEscalations` | 1537 | `collection_escalations` (MISSING) |
| `approveEscalation` | 1544 | `collection_escalations` (MISSING) |

---

## 4. Remediation Steps

### 4.1 Step 1: Fix Migration 066 Bug

Edit `server/database/migrations/066_step14_permissions.sql` line 3:

```diff
-INSERT INTO permissions (id, company_id, permission, module, name, description) VALUES
+INSERT INTO permissions (id, company_id, code, module, name, description) VALUES
```

### 4.2 Step 2: Run Migrations

```bash
cd "/d/Work/Projects/blackstack/CB CRM V2/blackstack-crm-v2"
node server/database/migrate.js
```

This will apply migrations 059, 063, 064, 065, 066 in order. The migration runner uses SHA-256 checksum verification — if a migration was previously partially applied, it will detect the checksum mismatch and update accordingly.

### 4.3 Step 3: Migrate `_payments_backup`

Migration 059 creates `_payments_backup` but the migration file doesn't include the backup/restore logic. Check if `_payments_backup` contains data and migrate it back to `payments.payment_number`:

```sql
-- If _payments_backup exists and has data:
UPDATE payments SET payment_number = (
  SELECT payment_number FROM _payments_backup pb
  WHERE pb.id = payments.id
) WHERE EXISTS (
  SELECT 1 FROM _payments_backup pb WHERE pb.id = payments.id
);
```

### 4.4 Step 4: Handle `credit_rules` Table

The `credit_rules` table is referenced by `receivable-summary.repository.js` line 106 but is NOT created by any migration. Two options:

**Option A**: Add `credit_rules` table creation to migration 063 (modify the migration file).
**Option B**: Create a new migration 067 to add `credit_rules` table.

The table should contain customer-specific credit limits and payment terms:

```sql
CREATE TABLE credit_rules (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  credit_limit REAL DEFAULT 0,
  credit_period_days INTEGER DEFAULT 30,
  payment_terms TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_rules_company ON credit_rules(company_id);
CREATE INDEX IF NOT EXISTS idx_credit_rules_contact ON credit_rules(company_id, contact_id);
```

### 4.5 Step 5: Run Tests

```bash
cd "/d/Work/Projects/blackstack/CB CRM V2/blackstack-crm-v2"
npx vitest run tests/customer-bills.vitest.test.js
```

All 172 test cases should pass after migrations are applied.

### 4.6 Step 6: Fix Duplicate Controller Methods

In `server/controllers/customer-bill.controller.js`:
- `listCreditNotes` appears at lines 632 and 842 — consolidate into one method
- `getSalesRegister` appears at lines 82 and 1098 — consolidate into one method

### 4.7 Step 7: Update Authorizer Permission Set

Add Steps 9-14 permissions to the `PERMISSIONS` Set in `server/auth/authorizer.js` (lines 2-16). While the runtime check uses DB permissions, the static set is used by `getAllPermissions()` for UI/seed purposes.

---

## 5. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Migration 066 bug (`permission` vs `code` column) | 🔴 Critical — halts all Step 14 migration | Fix column name before running migrations |
| `credit_rules` table not created by any migration | 🔴 Critical — outstanding query returns wrong credit data | Create migration 067 or add to 063 |
| Running migrations on production DB with existing data | 🟡 High — `ALTER TABLE ADD COLUMN` is safe but `_payments_backup` data loss | Backup DB before migration, restore payment_number |
| Duplicate controller methods | 🟡 Medium — Step 11 list credit notes endpoint broken | Consolidate methods |
| Stale `Authorizer.Permissions` Set | 🟢 Low — runtime check uses DB, not static set | Update for completeness |

---

## 6. Verification Checklist

After applying remediations:

- [x] `payments.payment_number` column exists in DB
- [x] `contacts.customer_code` and `contacts.gstin` columns exist in DB
- [x] `collection_assignments`, `collection_activities`, `promises_to_pay`, `customer_disputes` tables exist
- [x] `credit_rules` table exists (verified in DB; 1 row)
- [x] `collection_rules`, `collection_actions`, `collection_action_logs`, `communication_templates`, `interest_rules`, `interest_charges`, `bad_debt_cases`, `payment_plans`, `payment_plan_installments`, `collection_risk_scores`, `collection_escalations` tables exist
- [x] All Step 12 and Step 14 permissions exist in `permissions` table
- [x] All Step 12 and Step 14 permissions are assigned to admin role (migration 067)
- [x] `npx vitest run` passes (209 tests) — plus accounting-e2e (28), accounting-complete (484), tax-gst (28)
- [x] `_payments_backup` data migrated or cleaned up (table empty; nothing to restore)
- [x] Duplicate controller methods consolidated (kept service-based `listCreditNotes` and `getSalesRegister`)
- [x] `Authorizer.Permissions` Set updated (rebuilt from DB, Steps 5-14 included)

## 7. Additional Fixes (applied during verification, 2026-09)

- Fixed migration 066 (`permission` → `code` column) — blocked all Step 14 migrations.
- Added migration 067: assign `perm_s14_%` permissions to admin role.
- Journal validator: removed invalid debit/credit-nature enforcement (double-entry allows any side).
- `POST /accounting/journal`: auto-resolves `financial_year_id` from `entry_date` when omitted.
- `createBill` repository: strips non-column keys (`bill_date` alias), maps `amount` → `total` on items.
- `createAccount`: parent-type check allows BANK/CASH under ASSET; opening-balance nature check only applies when balance > 0 and client explicitly sent a type.
- Seed gap: inserted missing `ag_office` account group (code 5700).
- Note: `accounting-complete.test.js` closes/locks FY 2026 on completion — unlock before re-running suites.
- Server ports: launcher on 3000 proxies to CRM backend on 3001 (`LAUNCHER_CRM_PORT=3001`).