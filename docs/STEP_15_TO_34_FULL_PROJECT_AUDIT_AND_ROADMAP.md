# BLACK STACK CRM V2 — Step 15–34 Full Project Audit & Future Implementation Planning

> **Audit-only. No source code, schema, API, UI, or package changes are made in this document.**
> Generated from live inspection of the repository, the live SQLite database, migration files, source code, and test suite.

---

## 0. Executive Summary

Black Stack CRM V2 is a **Node.js + Express + node:sqlite** full-stack CRM/business system, currently at **Step 14** (Steps 1–14 implemented in code and migrations files). The application uses **HTML + CSS + vanilla JavaScript** for the frontend (single-page-style navigation via hash routing), with no Electron or desktop bundling.

### Key State Findings

| Metric | Value |
|--------|-------|
| Codebase lines (services) | ~15 service files, ~10 repository files |
| Migration files created | 66 (001–066) |
| Migrations applied to live DB | 57 (001–045, 056–058) |
| Migrations NOT applied | 9 (059, 059–066 except those listed above) |
| Live database tables | 90 |
| Total test cases | 172 in `customer-bills.vitest.test.js` |
| Node.js dependencies | 14 production, 5 dev (minimal: Express, JWT, bcryptjs, etc.) |
| Frontend JS pages | 30+ page modules |

### ⚠️ Critical Finding: Migration Gap

**Migrations 59–66 (Steps 10–14) are NOT applied to the live database**, but the application code, controllers, routes, services, and repositories for Steps 10–14 all exist and reference the tables those migrations would create. Specifically:

| Migration | Step | Tables Created | Applied? |
|-----------|------|----------------|----------|
| 059 | 10 | `payments.payment_number` column | ❌ No |
| 060 | 11 | (part of Step 11) | ❌ No |
| 061 | 11 | Credit/debit note columns | ✅ Yes |
| 062 | 11 | Credit/debit note permissions | ✅ Yes |
| 063 | 12 | `collection_assignments`, `collection_activities`, `promises_to_pay`, `customer_disputes` | ❌ No |
| 064 | 12 | Step 12 RBAC permissions | ❌ No |
| 065 | 14 | `collection_rules`, `collection_actions`, `collection_action_logs`, `communication_templates`, `interest_rules`, `interest_charges`, `bad_debt_cases`, `payment_plans`, `payment_plan_installments`, `collection_risk_scores`, `collection_escalations` | ❌ No |
| 066 | 14 | Step 14 RBAC permissions | ❌ No (also has a **bug** — uses `permission` column instead of `code`) |

**Impact**: The Step 12 `receivable-summary.repository.js` and `collections.repository.js` code references tables (`collection_assignments`, `collection_activities`, `promises_to_pay`, `customer_disputes`, `interest_rules`, `bad_debt_cases`, `payment_plans`, `collection_risk_scores`, `collection_escalations`) that do not exist in the live database. These will throw SQL errors at runtime.

---

## 1. Project Structure

### 1.1 High-Level Architecture Map

```
blackstack-crm-v2/
├── server/                          # Backend (Node.js + Express + SQLite)
│   ├── app.js                       # Express app entry — middleware, routes, error handler
│   ├── config/                      # Configuration (env, etc.)
│   ├── database/
│   │   ├── connection.js            # node:sqlite adapter (ConnectionAdapter wrapper)
│   │   ├── migrate.js              # Migration runner (checksum-verified)
│   │   ├── seed.js                 # Development/demo seed data
│   │   └── migrations/             # 66 migration files (001–066)
│   ├── middleware/
│   │   ├── auth.js                 # JWT token verification + user validity check
│   │   └── rbac.js                 # requirePermission(), optionalAuth()
│   ├── auth/
│   │   ├── authorizer.js           # Authorizer class — static permission checking
│   │   └── session.js              # JWT token creation/verification (SessionManager)
│   ├── controllers/                # 34 controller files (one per domain)
│   ├── services/                   # 30 service files
│   ├── repositories/               # 25 repository files (data access layer)
│   ├── routes/                     # 25 route files
│   ├── utils/                      # Utilities (errors, generateId, db, caseConverter, response)
│   └── app.js
├── public/                         # Frontend (static, served by Express)
│   ├── index.html                  # SPA shell
│   ├── login.html
│   ├── css/
│   ├── js/
│   │   ├── api/                    # Frontend API client (client.js, auth.js, crud.js)
│   │   ├── components/             # Reusable UI components
│   │   ├── pages/                  # 30+ page modules (vanilla JS, hash routing)
│   │   └── utils/                  # Frontend utilities
│   └── assets/
├── tests/                          # Test files (~172 test cases in customer-bills)
├── docs/                           # Documentation (functional specs, implementation reports)
├── package.json
└── config.yaml                     # Hermes agent profile config
```

### 1.2 Technology Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Node.js (v26.7.0 detected) | `node:sqlite` (built-in, no native compilation) |
| Framework | Express.js ^4.21.1 | REST API |
| Database | SQLite (node:sqlite) | WAL mode, foreign keys ON, sync=FULL |
| Auth | JWT (jsonwebtoken ^9.0.2) + bcryptjs ^2.4.3 | Token-based, bearer auth |
| Validation | express-validator ^7.2.0, zod ^3.23.8 | Server-side input validation |
| Testing | vitest ^2.1.6 | 172 test cases in customer-bills spec |
| Frontend | Vanilla HTML/CSS/JS | No framework (no React/Vue/Angular) |
| Currency | INR (₹) | Hardcoded in application logic |
| Timezone | India Standard Time (UTC+5:30) | Application assumes IST |

### 1.3 Source File Inventory

#### Services (30 files)

| File | Lines | Purpose | Steps |
|------|-------|---------|-------|
| `customer-bill.service.js` | ~117K chars | Core billing: CRUD, lifecycle, CN/DN, payment, allocation, collections, reports | 9-14 |
| `collections.service.js` | 249 lines | Step 14: Collections automation (rules, dunning, interest, bad debt, payment plans, risk) | 14 |
| `accounting-engine.service.js` | 19K chars | Core accounting: JE posting, reconciliation, balances | 1-8 |
| `accounting-reports.service.js` | 15K chars | Step 18-27: Financial reports (trial balance, P&L, balance sheet) | 18-27 |
| `tax-calculation-engine.js` | 19K chars | GST/tax calculation, compliance | 9-27 |
| `receivable-payable.service.js` | 16K chars | AR/AP service layer | 2-3 |
| `voucher.repository.js` | ~37K chars | Voucher/CN/DN persistence (receipt, payment, sales, expense vouchers) | 7-11 |
| `journal-entry.repository.js` | ~32K chars | Journal entry CRUD, reversal, trial balance, balance sheet, P&L | 1-8 |
| `chart-of-accounts.repository.js` | ~12K chars | CoA: accounts, account groups, account types, opening balances | 1-5 |
| `reporting.repository.js` | ~53K chars | Step 13: 17 report methods (billing dashboard, sales register, aging, etc.) | 13 |
| `event-hooks.service.js` | 134 lines | Workflow triggers on domain events (lead, deal, task, appointment, contact) | 2-3 |
| `auth.service.js` | 6K chars | Authentication: login, token generation, password management | 1 |
| `code-generator.service.js` | 8.5K chars | Sequential code/number generation (bills, vouchers, JEs, etc.) | 9-14 |

#### Controllers (34 files)

| File | Lines | Purpose |
|------|-------|---------|
| `customer-bill.controller.js` | 1560 lines | 76 controller methods (CRUD + lifecycle + CN/DN + payment + collections + reports) |
| `accounting.controller.js` | 14K chars | Accounting operations |
| `auth.controller.js` | — | Authentication |
| 30+ other controllers | — | Domain-specific CRUD |

#### Repositories (25 files)

| File | Lines | Purpose |
|------|-------|---------|
| `collections.repository.js` | ~53K chars | Step 14: 30+ methods (rules, actions, dunning, interest, bad debt, payment plans, risk, forecast, escalation) |
| `receivable-summary.repository.js` | 873 lines | Step 12: AR outstanding, aging, statement, collection management |
| `voucher.repository.js` | ~37K chars | Voucher/CN/DN data access |
| `journal-entry.repository.js` | ~32K chars | JE data access + financial statements |
| `chart-of-accounts.repository.js` | ~12K chars | CoA data access |
| `reporting.repository.js` | ~53K chars | Step 13: 17 reporting methods |
| `billing-cost.repository.js` | ~11K chars | Step 9: Bill/invoice data access |
| `receivable.repository.js` | 7.9K chars | AR data access |
| `payable.repository.js` | 2.8K chars | AP data access |
| `accounting-base.repository.js` | 2.2K chars | Base repository class |
| `BaseRepository.js` | 1.7K chars | Base CRUD repository |

#### Routes (25 files)

| File | Routes | Purpose |
|------|--------|---------|
| `customer-bills.js` | 109 `router.` entries | Full customer billing API (Steps 9-14) |
| `accounting.js` | ~4.1K chars | Accounting routes |
| `auth.js` | — | Authentication routes |
| 23 other route files | — | Domain-specific CRUD routes |

**Note**: Step 14 collections routes are integrated into `customer-bills.js` (lines 187-262), not in a separate `collections.route.js` file.

---

## 2. Database Audit

### 2.1 Live Database State

- **File**: `data/blackstack-crm.db` (SQLite, WAL mode)
- **Applied migrations**: 57 of 66 (see migration status table in §0)
- **Total tables**: 90
- **Company isolation**: All tables use `company_id TEXT NOT NULL DEFAULT 'default'`

### 2.2 Applied Migration Versions

```
001–045: All applied
056: customer_bills_lifecycle (applied)
057: customer_bills_permissions (applied)
058: step9_advanced_billing (applied)
059: step10_payment_number (NOT applied)
060: step11_credit_debit_note_base (NOT applied — but 061/062 are)
061: step11_credit_debit_note (applied)
062: step11_permissions (applied)
063: step12_collection_management (NOT applied)
064: step12_permissions (NOT applied)
065: step14_collections_automation (NOT applied)
066: step14_permissions (NOT applied)
```

### 2.3 Complete Table List (90 tables)

**Core Identity & Setup:**
- `organizations`, `companies`, `company_tax_configs`, `financial_years`, `year_end_closings`

**Accounting (Chart of Accounts):**
- `account_types`, `account_groups`, `accounts`, `accounts_new`, `budgets`, `budget_lines`, `cost_centres`, `tax_masters`, `tax_types`, `tax_components`, `tax_account_mappings`, `transaction_tax_details`

**Accounting Engine:**
- `journal_entries`, `journal_entry_lines`, `vouchers`, `voucher_lines` (implied), `receivables`, `receivable_allocations`, `payables`, `payable_allocations`, `opening_balances`, `opening_balance_lines`, `payment_reconciliations`

**Bills & Invoices:**
- `bills`, `bill_items`, `bill_allocations`, `bill_approvals`, `bill_events`, `bill_templates`, `recurring_bills`, `recurring_generation_log`

**Payments:**
- `payments`, `bank_accounts`, `bank_reconciliation_items`, `bank_reconciliations`, `ar_reconciliation_log`, `ap_reconciliation_log`

**Customers & Contacts:**
- `contacts`, `relationships`, `contact_tags`, `customer_advances`

**CRM Core:**
- `leads`, `deals`, `pipelines`, `pipeline_stages`, `activities`, `tasks`, `appointments`, `notes`, `tags`, `notes`

**Products & Inventory:**
- `products`, `inventory_items`, `inventory_movements`

**Sales:**
- `invoices`, `invoice_line_items`, `deals`

**Users & Auth:**
- `users`, `roles`, `role_permissions`, `permissions`, `user_roles`

**Workflows:**
- `workflow_definitions`, `workflow_executions`, `workflow_instances`, `workflow_nodes`

**Notifications & Audit:**
- `notifications`, `audit_logs`, `accounting_audit`, `customer_bill_audit_log`, `tax_audit_log`, `database_health_logs`

**Step 10 (Payment Numbers):**
- `_payments_backup` (used during migration 059)

**Step 11 (Credit/Debit Notes):**
- `credit_note_lines`, `debit_note_lines`, `customer_bill_disputes`, `customer_bill_writeoffs`, `interest_calculations`, `interest_configs`, `payment_reminders`

**System:**
- `system_metadata`, `number_sequences`

### 2.4 Missing Tables (Steps 10-14 migrations not applied)

| Table | Migration | Purpose | Referenced By |
|-------|-----------|---------|---------------|
| `payments.payment_number` column | 059 | Sequential receipt number on payments | `receivable-summary.repository.js` (line 318), `customer-bill.service.js` |
| `collection_assignments` | 063 | Who owns collections for each customer | `receivable-summary.repository.js`, `collections.repository.js` |
| `collection_activities` | 063 | Collection call/meeting logs | `receivable-summary.repository.js`, `collections.repository.js` |
| `promises_to_pay` | 063 | Promise-to-pay tracking | `receivable-summary.repository.js`, `collections.repository.js` |
| `customer_disputes` | 063 | Collection-level disputes | `receivable-summary.repository.js`, `collections.repository.js` |
| `collection_rules` | 065 | Configurable dunning triggers | `collections.service.js`, `collections.repository.js` |
| `collection_actions` | 065 | Collection action records | `collections.service.js`, `collections.repository.js` |
| `collection_action_logs` | 065 | Immutable execution history | `collections.repository.js` |
| `communication_templates` | 065 | Email/SMS/WhatsApp templates | `collections.service.js`, `collections.repository.js` |
| `interest_rules` | 065 | Configurable late-fee rules | `collections.service.js`, `collections.repository.js` |
| `interest_charges` | 065 | Calculated and posted late fees | `collections.service.js`, `collections.repository.js` |
| `bad_debt_cases` | 065 | Bad debt write-off workflow | `collections.service.js`, `collections.repository.js` |
| `payment_plans` | 065 | Customer payment plan headers | `collections.service.js`, `collections.repository.js` |
| `payment_plan_installments` | 065 | Payment plan installment lines | `collections.service.js`, `collections.repository.js` |
| `collection_risk_scores` | 065 | Collection risk scoring | `collections.service.js`, `collections.repository.js` |
| `collection_escalations` | 065 | Escalation records | `collections.service.js`, `collections.repository.js` |

**Missing permissions in DB**: All Step 12 permissions (migration 064) and all Step 14 permissions (migration 066) are absent from the `permissions` table. Migration 066 has a bug using `permission` column instead of `code`.

### 2.5 Key Table Schemas (from live DB)

#### `bills` (51 columns, source of truth for customer invoices)

```sql
-- Primary key & company isolation
id TEXT PRIMARY KEY
company_id TEXT NOT NULL DEFAULT 'default'

-- Document identity
bill_number TEXT NOT NULL
bill_type TEXT NOT NULL           -- 'CUSTOMER' or 'VENDOR'
invoice_number TEXT               -- nullable

-- Parties
contact_id TEXT NOT NULL
organization_id TEXT              -- nullable

-- Financial
currency TEXT DEFAULT 'USD'       -- NOTE: defaults to USD, not INR
status TEXT DEFAULT 'DRAFT'       -- DRAFT, PENDING_APPROVAL, APPROVED, POSTED, PARTIALLY_PAID, PAID, CANCELLED, VOID
issue_date TEXT NOT NULL
due_date TEXT NOT NULL
subtotal REAL DEFAULT 0.0
tax REAL DEFAULT 0.0
discount REAL DEFAULT 0.0
total REAL DEFAULT 0.0
paid_amount REAL DEFAULT 0.0
balance REAL DEFAULT 0.0

-- India/GST specific (added in Step 9)
customer_gstin TEXT
billing_address TEXT
shipping_address TEXT
place_of_supply TEXT
customer_po_number TEXT
customer_po_date TEXT
salesperson_id TEXT
sales_channel TEXT
payment_terms TEXT
price_list_id TEXT
branch_id TEXT
warehouse_id TEXT
project_id TEXT
cost_centre_id TEXT
is_tax_inclusive INTEGER DEFAULT 0
round_off REAL DEFAULT 0.0
other_charges REAL DEFAULT 0.0
discount_amount REAL DEFAULT 0.0
taxable_amount REAL DEFAULT 0.0
tax_master_id TEXT
is_interstate INTEGER DEFAULT 0
company_state TEXT

-- GST tax breakdown
cgst_amount REAL, sgst_amount REAL, igst_amount REAL
cgst_rate REAL, sgst_rate REAL, igst_rate REAL

-- Lifecycle
journal_entry_id TEXT REFERENCES journal_entries(id)
approved_by TEXT, approved_at TEXT
posted_by TEXT, posted_at TEXT
cancelled_by TEXT, cancelled_at TEXT, cancellation_reason TEXT
reversal_journal_entry_id TEXT

-- Metadata
reference_number TEXT
notes TEXT, terms TEXT
salesperson_name TEXT
idempotency_key TEXT
payment_terms_days INTEGER DEFAULT 30
due_date_calc TEXT
other_charges_taxable INTEGER DEFAULT 0
other_charges_tax_amount REAL DEFAULT 0.0
line_discount_amount REAL DEFAULT 0.0

-- Timestamps
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
created_by TEXT
```

#### `bill_items` (29 columns)

```sql
id TEXT PRIMARY KEY, company_id TEXT, bill_id TEXT, product_id TEXT
description TEXT, quantity REAL, unit_price REAL, tax_rate REAL, discount REAL, total REAL
gl_account_id TEXT, created_at DATETIME, sku TEXT, hsn_sac TEXT, unit TEXT
discount_percent REAL, discount_amount REAL, taxable_amount REAL
cgst_rate REAL, sgst_rate TEXT, igst_rate REAL, cess_rate REAL, cess_amount REAL
other_tax REAL, tax_master_id TEXT, warehouse_id TEXT, batch TEXT, serial_number TEXT
expiry TEXT, project_id TEXT, cost_centre_id TEXT
cgst_amount REAL, sgst_amount REAL, igst_amount REAL
line_total REAL, line_tax REAL, discount_type TEXT
```

#### `payments` (13 columns — NOTE: `payment_number` is NOT present)

```sql
id TEXT PRIMARY KEY, company_id TEXT, invoice_id TEXT, bill_id TEXT, contact_id TEXT
amount REAL, payment_method TEXT, status TEXT, reference_number TEXT, notes TEXT
payment_date TEXT, currency TEXT, created_at TEXT, updated_at TEXT
-- MISSING: payment_number (Step 10 migration 059 not applied)
```

#### `vouchers` (40+ columns including Step 9-11 additions)

Key columns: `id`, `company_id`, `voucher_type` (RECEIPT, SALES, EXPENSE, CREDIT_NOTE, DEBIT_NOTE), `voucher_number`, `voucher_date`, `contact_id`, `bill_id`, `total_amount`, `status`, `journal_entry_id`, `receipt_mode`, `credit_note_number`, `credit_note_type`, `reason`, `original_sales_invoice_id`, `original_purchase_invoice_id`

#### `receivables` (18 columns)

```sql
id, company_id, bill_id, contact_id, organization_id, deal_id, due_date,
original_amount, paid_amount, outstanding_amount, currency, status,
credit_limit, credit_period_days, payment_terms, days_overdue,
created_at, updated_at
```

#### `contacts` (27 columns — NOTE: `customer_code` and `gstin` are NOT present)

```sql
id, company_id, first_name, last_name, email, phone, job_title, organization_id,
address, city, state, postal_code, country, notes, status, created_at, updated_at,
lead_status, customer_status, source, lead_score, next_action, next_action_due,
owner_id, deleted_at, deleted_by, delete_reason, version, updated_by
-- MISSING: customer_code, gstin (Step 12 migration 063 not applied)
```

#### `journal_entries` (key columns)

```sql
id, company_id, je_number, journal_type, reference_type, reference_id,
description, entry_date, status (DRAFT, POSTED, REVERSED, CANCELLED),
total_debit, total_credit, created_by, posted_by, posted_at, created_at, updated_at
```

#### `journal_entry_lines` (key columns)

```sql
id, company_id, journal_entry_id, account_id, debit_amount, credit_amount,
description, entity_type, entity_id, created_at
```

#### `accounts` (Chart of Accounts)

Contains: `id`, `company_id`, `code`, `name`, `account_type`, `account_group_id`, `is_active`, `is_system`, `is_protected`, `created_at`, `updated_at`, `description`, `tax_type`, `tax_rate`, `opening_balance`, `current Balance`

#### `roles` / `role_permissions` / `permissions`

```sql
-- permissions: 71 rows in live DB (Step 12 and Step 14 permissions missing)
-- roles: id, company_id, name, code, description, is_system, created_at
-- role_permissions: role_id, permission_id (many-to-many)
```

### 2.6 Schema Limitations & Issues

1. **Migration gap**: 9 migrations not applied (059-066 except 061, 062). Code references tables that don't exist.
2. **Migration 066 bug**: Uses column `permission` instead of `code` in INSERT statement.
3. **`bills.currency` defaults to `USD`** not `INR` — inconsistent with India-focused business.
4. **`contacts` table missing `customer_code` and `gstin`** columns (needed by Step 12 outstanding query which LEFT JOINs `credit_rules`).
5. **`credit_rules` table missing** — `receivable-summary.repository.js` line 106 LEFT JOINs `credit_rules` on `contacts`.
6. **`receivables` table has `days_overdue` column** as stored field, but `getCustomerAging` recalculates dynamically.
7. **No foreign key enforcement issues**: `vouchers.total_amount` is nullable but expected by reports.
8. **`_payments_backup`** table exists — likely a temporary backup from migration 059 that was never cleaned up.

---

## 3. Accounting Architecture Audit

### 3.1 Core Accounting Flow

```
Chart of Accounts (Step 1-5)
    ↓
Journal Entries ←→ Ledger Accounts ←→ Financial Statements (Steps 18-27)
    ↓
Vouchers (Receipt, Payment, Sales, Expense, Credit Note, Debit Note) (Steps 7-11)
    ↓
Customer Bills / Invoices (Steps 8-9)
    ↓
Payment Allocation (Steps 2-3)
    ↓
AR/Aging/Statements (Step 12)
    ↓
Reports & Analytics (Step 13)
    ↓
Collections Automation (Step 14)
```

### 3.2 Key Accounting Components

#### Chart of Accounts
- **`account_types`**: ASSET, LIABILITY, EQUITY, INCOME, EXPENSE, COGS, OTHER
- **`account_groups`**: Hierarchical grouping (e.g., "Current Assets" > "Banks")
- **`accounts`**: Individual ledger accounts with `account_type`, `account_group_id`, `code`, `name`
- **Accounting equation**: Assets = Liabilities + Equity + (Income - Expenses)
- **Opening balances**: `opening_balances` + `opening_balance_lines` tables, posted to JE on financial year open

#### Journal Entries
- **`journal_entries`**: Header table with `je_number`, `status` (DRAFT/POSTED/REVERSED/CANCELLED), `total_debit`, `total_credit`
- **`journal_entry_lines`**: Line items with `account_id`, `debit_amount`, `credit_amount`, `entity_type`, `entity_id`
- **Reversal**: `journalRepo.reverse()` creates a balancing reversal entry, never deletes
- **Balancing**: Every posting creates balanced JEs (Dr = Cr)
- **Financial year locking**: Posted JEs are immutable; can only reverse

#### Voucher System (Steps 7-11)
- **Receipt voucher** (`voucher_type = 'RECEIPT'`): Cash/bank inflow → Dr Bank, Cr Receivable/Payable/Sales
- **Payment voucher** (`voucher_type = 'PAYMENT'`): Cash/bank outflow → Dr Expense/Payable, Cr Bank
- **Sales voucher** (`voucher_type = 'SALES'`): Credit sale → Dr Receivable, Cr Sales + Tax
- **Expense voucher** (`voucher_type = 'EXPENSE'`): Expense → Dr Expense, Cr Payable/Bank
- **Credit note** (`voucher_type = 'CREDIT_NOTE'`): Dr Sales Returns, Cr Receivable
- **Debit note** (`voucher_type = 'DEBIT_NOTE'`): Dr Receivable, Cr Other Charges + Tax

#### Receivables
- **`receivables`** table: Tracks per-bill AR position with `original_amount`, `paid_amount`, `outstanding_amount`, `days_overdue`, `status`
- **`receivable_allocations`**: Payment-to-bill allocation tracking
- **`bill_allocations`**: Bill-to-JE allocation tracking
- **Balance updates**: Direct `balance = balance - reduction` updates on bills

### 3.3 Tax Calculation Engine

- **`tax-calculation-engine.js`**: 19K chars, handles GST (CGST/SGST/IGST), cess, interstate tax rules
- **Tax tables**: `tax_masters`, `tax_types`, `tax_components`, `tax_account_mappings`, `transaction_tax_details`
- **India-specific**: CGST/SGST for intrastate, IGST for interstate, place-of-supply logic
- **Tax on other charges**: `other_charges_taxable`, `other_charges_tax_amount` columns in `bills`

### 3.4 Key Design Principles

1. **No duplicate accounting**: Reports read from authoritative tables (`bills`, `payments`, `vouchers`, `receivables`, `journal_entries`)
2. **Balanced JEs**: Every posting creates Dr = Cr journal entries
3. **Reversal, not deletion**: Cancellation creates reversal JEs, preserves audit trail
4. **Company isolation**: Every query filtered by `company_id`
5. **Idempotency**: Credit notes use idempotency keys to prevent duplicates
6. **Overpayment handling**: Phase 7 logic tracks excess credit note amounts on paid bills
7. **Phase-gated posting**: DRAFT → PENDING_APPROVAL → APPROVED → POSTED → PAID/CANCELLED

---

## 4. Receivables & Collections Architecture (Steps 9-14)

### 4.1 Step 9 — Advanced Billing (Applied)

**Status**: ✅ Migration 058 applied, code complete.
- Bill lifecycle: DRAFT → SUBMIT (approval) → APPROVE → POST → CANCEL
- Payment recording: `POST /payments` endpoint with allocation logic
- Bill allocation: `bill_allocations` table tracks payment-to-bill linkage via JEs
- Payment allocation: `receivable_allocations` for partial/over payments
- Reconciliation: `POST /payments/reconcile` endpoint
- Write-off: `POST /:id/writeoff` → Dr Bad Debt, Cr Receivable
- Dispute (operational): `POST /:id/dispute` → status flag, no accounting impact

**Key columns added to `bills`**: `journal_entry_id`, `approved_by/at`, `posted_by/at`, `cancelled_by/at`, `reversal_journal_entry_id`, `idempotency_key`, `payment_terms_days`, `due_date_calc`, `is_interstate`, `company_state`, `cgst_amount/rate`, `sgst_amount/rate`, `igst_amount/rate`

**Key columns added to `bill_items`**: `hsn_sac`, `unit`, `batch`, `serial_number`, `expiry`, `discount_type`, `line_total`, `line_tax`, `cgst_rate/amount`, `sgst_rate/amount`, `igst_rate/amount`, `cess_rate/amount`, `tax_master_id`

### 4.2 Step 10 — Payment Numbers (Not Applied)

**Status**: ❌ Migration 059 NOT applied. Code references `payment_number` column.
- Adds `payment_number TEXT` column to `payments` table
- Sequential receipt number format: `RCPT-yyyy-00001`
- Generated by `CodeGenerator` service
- **Risk**: `receivable-summary.repository.js` line 318 references `p.payment_number` — will return NULL without the column

### 4.3 Step 11 — Credit Notes, Debit Notes & Reversals (Applied)

**Status**: ✅ Migrations 061, 062 applied. Code complete.
- **Credit notes**: Full/Partial/Line-level, tax-preserving scaling, idempotency, overpayment tracking
- **Debit notes**: Flat amount, linked to bills, tax calculation
- **Cancellation**: JE reversal via `journalRepo.reverse()`, bill balance restoration using `overpayment_amount`
- **Voucher types**: `CREDIT_NOTE`, `DEBIT_NOTE`
- **Columns added to `vouchers`**: `idempotency_key`, `overpayment_amount`, `receipt_mode`, `journal_entry_id`, `total_amount`, `credit_note_number`, `credit_note_type`, `reason`, `original_sales_invoice_id`, `original_purchase_invoice_id`
- **Permissions**: `customer_bills.view_credit_note`, `customer_bills.cancel_credit_note`, `customer_bills.view_debit_note`, `customer_bills.cancel_debit_note`

### 4.4 Step 12 — AR Aging, Statements & Collection Management (Partially Applied)

**Status**: ⚠️ Migration 063 NOT applied. Migration 064 NOT applied. Code: `receivable-summary.repository.js` exists.

**What exists:**
- `receivable-summary.repository.js` (873 lines) — AR Outstanding, Aging, Statement, Collection Management
- Controller methods: `getCustomerOutstanding`, `getCustomerAging`, `getInvoiceAging`, `getAgingSummary`, `getReceivablesSummary`, `getCustomerStatement`, `assignCollectionOwner`, `getCollectionActivities`, `createPromiseToPay`, `getPromisesToPay`, `createPromiseToPay`, `getPromisesToPay`, `recordPromisePayment`, `createDispute`, `getDisputes`, `resolveCollectionDispute`, `getCollectionDashboard`
- Routes: 15 new routes for outstanding, aging, statement, collection management
- 22 test cases

**What's missing (from migration 063):**
- `collection_assignments` table — assigned collection owner, priority, status
- `collection_activities` table — activity log (phone calls, meetings, etc.)
- `promises_to_pay` table — promise tracking with status (PROMISED, FULFILLED, PARTIAL, BROKEN, CANCELLED)
- `customer_disputes` table — collection-level disputes with resolution workflow
- `contacts.customer_code` column — customer code for display
- `contacts.gstin` column — GSTIN for display
- `credit_rules` table — credit limit rules referenced in outstanding query (line 106)

**What's missing (from migration 064):**
- 10 new RBAC permissions for Step 12 features

**Collection Management API (defined in routes, depends on missing tables):**

| Method | Route | Permission | Depends On Missing Table |
|--------|-------|-----------|--------------------------|
| GET | `/outstanding` | `customer_bills.view_outstanding` | `credit_rules` |
| GET | `/customers/:contactId/aging` | `customer_bills.view_aging` | — |
| GET | `/bills/:billId/invoice-aging` | `customer_bills.view_aging` | — |
| GET | `/customers/:contactId/summary` | `customer_bills.view_outstanding` | — |
| GET | `/customers/:contactId/statement` | `customer_bills.view_statement` | — |
| GET | `/receivables/summary` | `customer_bills.view_outstanding` | — |
| GET | `/aging` | `customer_bills.view_aging` | — |
| GET | `/collection-dashboard` | `customer_bills.view_collection_dashboard` | — |
| POST | `/customers/:contactId/collection-owner` | `customer_bills.assign_collection_owner` | `collection_assignments` |
| GET | `/customers/:contactId/activities` | `customer_bills.manage_collections` | `collection_activities` |
| POST | `/customers/:contactId/activities` | `customer_bills.manage_collections` | `collection_activities` |
| POST | `/customers/:contactId/promises` | `customer_bills.manage_promises` | `promises_to_pay` |
| POST | `/promises/:promiseId/payment` | `customer_bills.manage_promises` | `promises_to_pay` |
| GET | `/promises/:contactId` | `customer_bills.manage_collections` | `promises_to_pay` |
| POST | `/disputes` | `customer_bills.manage_disputes` | `customer_disputes` |
| GET | `/disputes` | `customer_bills.manage_disputes` | `customer_disputes` |
| POST | `/disputes/:disputeId/resolve` | `customer_bills.manage_disputes` | `customer_disputes` |

### 4.5 Step 13 — Reports & Analytics (Applied, code-only)

**Status**: ✅ Code complete (no new migrations needed). `reporting.repository.js` exists.
- **28 reporting routes** under `/reports/`
- **17 report methods** in `ReportingRepository`: `getBillingDashboard`, `getBillingTrend`, `getSalesRegister`, `getInvoiceRegister`, `getCustomerOutstandingReport`, `getCustomerAging`, `getCustomerStatement`, `getPaymentRegister`, `getCollectionReport`, `getCollectionPerformance`, `getOverdueAnalytics`, `getTopCustomers`, `getCreditNoteRegister`, `getDebitNoteRegister`, `getTaxReport`, `getSalespersonReport`, `getProductSalesReport`, `getBranchWarehouseReport`, `getCollectionTrend`, `getPaymentMethodDistribution`, `getAgingDistribution`
- **50 test cases** added
- **Permissions**: `customer_bills.view_reports`, `customer_bills.export_reports`
- **No new tables**: all reports read from existing schema

### 4.6 Step 14 — Collections Automation (Not Applied)

**Status**: ❌ Migrations 065, 066 NOT applied. Migration 066 has a **bug** (column `permission` vs `code`).

**What exists:**
- `collections.service.js` (249 lines) — 30+ service methods
- `collections.repository.js` (~53K chars) — 30+ repository methods
- Routes integrated into `customer-bills.js` (lines 187-262) — 20+ routes
- Controller methods in `customer-bill.controller.js` (lines 1276-1552) — 25+ methods
- **172 test cases** in `customer-bills.vitest.test.js` (some for Steps 12-14)

**What's missing (from migration 065):**
- `collection_rules` — configurable dunning triggers
- `collection_actions` — collection action records
- `collection_action_logs` — immutable execution history
- `communication_templates` — email/SMS/WhatsApp templates
- `interest_rules` — configurable late-fee rules
- `interest_charges` — calculated and posted late fees
- `bad_debt_cases` — bad debt write-off workflow
- `payment_plans` / `payment_plan_installments` — payment plan tracking
- `collection_risk_scores` — risk scoring
- `collection_escalations` — escalation records

**Step 14 Collections API (defined in routes, depends on missing tables):**

| Method | Route | Permission |
|--------|-------|-----------|
| GET | `/collections/dashboard` | `customer_bills.view_collections` |
| GET | `/collection-rules` | `customer_bills.manage_collection_rules` |
| POST | `/collection-rules` | `customer_bills.manage_collection_rules` |
| PUT | `/collection-rules/:id` | `customer_bills.manage_collection_rules` |
| DELETE | `/collection-rules/:id` | `customer_bills.manage_collection_rules` |
| POST | `/dunning/run` | `customer_bills.execute_collection_actions` |
| GET | `/dunning/actions` | `customer_bills.execute_collection_actions` |
| GET | `/collection-actions` | `customer_bills.execute_collection_actions` |
| POST | `/collection-actions` | `customer_bills.execute_collection_actions` |
| POST | `/collection-actions/:id/execute` | `customer_bills.execute_collection_actions` |
| GET | `/templates` | `customer_bills.manage_collection_rules` |
| POST | `/templates` | `customer_bills.manage_collection_rules` |
| GET | `/interest-rules` | `customer_bills.calculate_interest` |
| POST | `/interest-rules` | `customer_bills.calculate_interest` |
| GET | `/bills/:billId/interest/calculate` | `customer_bills.calculate_interest` |
| POST | `/bills/:billId/interest/charges` | `customer_bills.calculate_interest` |
| POST | `/interest-charges/:id/approve` | `customer_bills.approve_interest` |
| POST | `/interest-charges/:id/post` | `customer_bills.approve_interest` |
| GET | `/bad-debt` | `customer_bills.manage_bad_debt` |
| POST | `/bad-debt` | `customer_bills.manage_bad_debt` |
| POST | `/bad-debt/:id/approve` | `customer_bills.approve_bad_debt` |
| POST | `/bad-debt/:id/write-off` | `customer_bills.approve_bad_debt` |
| POST | `/bad-debt/:id/reverse` | `customer_bills.approve_bad_debt` |
| GET | `/payment-plans` | `customer_bills.manage_payment_plans` |
| POST | `/payment-plans` | `customer_bills.manage_payment_plans` |
| POST | `/payment-plans/:id/approve` | `customer_bills.manage_payment_plans` |
| POST | `/payment-plans/:id/cancel` | `customer_bills.manage_payment_plans` |
| POST | `/payment-plans/:id/apply-payment` | `customer_bills.manage_payment_plans` |
| GET | `/customers/:contactId/risk` | `customer_bills.view_collection_risk` |
| GET | `/collection-forecast` | `customer_bills.view_collections` |
| GET | `/escalations` | `customer_bills.manage_escalations` |
| POST | `/escalations` | `customer_bills.manage_escalations` |
| POST | `/escalations/:id/approve` | `customer_bills.manage_escalations` |

---

## 5. Permissions Architecture

### 5.1 RBAC System

The RBAC system is implemented in:
- `server/middleware/rbac.js` — `requirePermission(permissionCode)` middleware
- `server/auth/authorizer.js` — `Authorizer` class with `assertPermission()` and `hasPermission()`
- `server/middleware/auth.js` — `authMiddleware` for JWT verification
- DB: `permissions`, `roles`, `role_permissions` tables

### 5.2 The `Authorizer` Permission Set Issue

**Critical inconsistency**: The `Authorizer` class in `authorizer.js` has a hardcoded `PERMISSIONS` Set (lines 1-16) that does NOT include Step 9-14 permissions. However, the `requirePermission` middleware checks against `req.user.permissions` (from the JWT token/session), NOT against the `PERMISSIONS` Set. The `PERMISSIONS` Set is used only by `getAllPermissions()` for listing purposes.

The actual permission check path:
1. `authMiddleware` verifies JWT → sets `req.user.session` (contains `permissions` array from DB)
2. `requirePermission('code')` → `Authorizer.assertPermission(context, code)` → checks `context.permissions.includes(code)`
3. Permissions are loaded from DB `role_permissions` join at login time

**Problem**: Steps 12-14 permissions (migrations 064, 066) are NOT in the live DB. The `permissions` table only has 71 rows (all pre-Step 12). The Step 12/14 route permissions will fail at runtime for all users.

### 5.3 Permission Inventory

**Permissions in live DB (71 total)**:
- `accounting.*`: 6 (view, create, edit, manage, override_locked, post, reverse)
- `activities.*`: 2
- `audit.view`
- `budget.manage`
- `coa.manage`
- `contacts.*`: 4
- `customer_bills.*`: 17 (view, create, edit, approve, post, cancel, delete_draft, record_payment, create_credit_note, view_credit_note, cancel_credit_note, create_debit_note, view_debit_note, cancel_debit_note, view_reports, write_off, dispute, allocate, reconcile, export, send, manage_advance)
- `deals.*`: 4
- `database.view`
- `finance.manage`
- `invoices.*`: 4
- `organizations.*`: 4
- `payments.*`: 3
- `products.*`: 4
- `reports.*`: 2
- `settings.manage`
- `tasks.*`: 4
- `users.*`: 2
- `workflows.*`: 2

**Missing from DB (defined in migration files but NOT applied)**:
- Step 12: `customer_bills.view_outstanding`, `customer_bills.view_aging`, `customer_bills.view_statement`, `customer_bills.export_reports`, `customer_bills.manage_collections`, `customer_bills.assign_collection_owner`, `customer_bills.manage_promises`, `customer_bills.manage_disputes`, `customer_bills.view_reports`, `customer_bills.view_collection_dashboard`
- Step 14: `customer_bills.view_collections`, `customer_bills.manage_collection_rules`, `customer_bills.execute_collection_actions`, `customer_bills.manage_payment_plans`, `customer_bills.calculate_interest`, `customer_bills.approve_interest`, `customer_bills.manage_bad_debt`, `customer_bills.approve_bad_debt`, `customer_bills.view_collection_risk`, `customer_bills.manage_escalations`, `customer_bills.export_collections`

**Note**: Migration 064 defines `customer_bills.view_reports` but it already exists from migration 057. This is a duplicate that will cause `INSERT OR IGNORE` to skip.

---

## 6. Frontend Architecture Audit

### 6.1 Frontend Tech Stack

- **No framework**: Vanilla HTML5 + CSS3 + JavaScript (ES6+)
- **Routing**: Hash-based client-side routing (`window.location.hash`)
- **API client**: `public/js/api/client.js` — wrapper around `fetch()` with JWT bearer auth
- **Page modules**: `public/js/pages/*.js` — each page is a module registered on `window.PageModules`
- **Components**: `public/js/components/` — reusable UI components
- **CSS**: `public/css/` — custom CSS (no framework like Bootstrap/Tailwind)

### 6.2 Frontend Pages (30+ modules)

| Page | File | Purpose | Step |
|------|------|---------|------|
| Customer Bills | `customer-bills.js` | Full CRUD + lifecycle + CN/DN + payment + writeoff + dispute | 9-14 |
| Outstanding | `outstanding.js` | Customer outstanding, aging, collection dashboard | 12 |
| Receivables | `receivables.js` | AR summary, aging, customer statements | 12 |
| Reports | `reports.js` | Billing reports, sales register, tax summary, aging | 13 |
| Invoices | `invoices.js` | Sales invoices (legacy) | 8 |
| Payments | `payments.js` | Payment recording | 8 |
| Bills | `bills.js` | Vendor bills | 8 |
| Accounting | `accounting.js` | Chart of accounts, JEs | 1-5 |
| Accounting Masters | `accounting-masters.js` | Account types, groups, ledger accounts | 1-5 |
| Accounting Reports | `accounting-reports.js` | Trial balance, P&L, balance sheet | 18-27 |
| Ledger | `ledger.js` | Account ledger view | 3 |
| Dashboard | `dashboard.js` | KPI dashboard | 1-3 |
| Contacts/Customers | `contacts.js`, `customers.js` | Contact/customer management | 1 |
| Leads | `leads.js` | Lead management | 2 |
| Deals | `deals.js` | Deal pipeline | 2 |
| Products | `products.js` | Product catalog | 2 |
| Users | `users.js` | User management | 1 |
| Workflows | `workflows.js` | Workflow definition | 2 |
| Tasks | `tasks.js` | Task management | 2 |
| Activities | `activities.js` | Activity tracking | 2 |
| Appointments | `appointments.js` | Appointment scheduling | 2 |
| Notes | `notes.js` | Notes | 2 |
| Search | `search.js` | Global search | 4 |
| Settings | `settings.js` | System settings | 1 |
| Profile | `profile.js` | User profile | 1 |

### 6.3 Frontend Coverage Assessment

| Step | Backend Complete? | Frontend Page? | Frontend API Calls Wired? |
|------|-------------------|----------------|--------------------------|
| 9 | ✅ | ✅ `customer-bills.js` | ✅ (bill CRUD, payment, CN/DN, writeoff, dispute) |
| 10 | ❌ (migration not applied) | ❌ | ❌ |
| 11 | ✅ | ✅ `customer-bills.js` | ✅ (CN/DN create/list/cancel) |
| 12 | ⚠️ (migration not applied) | ✅ `outstanding.js`, `receivables.js` | ⚠️ Partial (API exists but tables missing) |
| 13 | ✅ | ✅ `reports.js` | ✅ (report endpoints wired) |
| 14 | ❌ (migration not applied) | ❌ No collections page | ❌ |

**Key observation**: The frontend has pages for Steps 12 and 13 but Step 14 (collections automation) has NO frontend page at all. The frontend is entirely API-driven — there is no server-side rendering.

---

## 7. Testing Architecture

### 7.1 Test Suite

| File | Framework | Tests | Purpose |
|------|-----------|-------|---------|
| `tests/customer-bills.vitest.test.js` | vitest | 172 | Steps 9-14 (bills, CN/DN, payment, outstanding, aging, statement, collections, reports) |
| `tests/accounting-complete.test.js` | ? | — | Full accounting cycle (1-8) |
| `tests/accounting-e2e.test.js` | ? | — | End-to-end accounting |
| `tests/audit-opening-balance.test.js` | node:test | 16 | Opening balance audit |
| `tests/auth-crud.integration.test.js` | ? | — | Auth integration |
| `tests/code-generator.regression.test.js` | ? | — | Code generation regression |
| `tests/contact-centric.e2e.js` | ? | — | Contact-centric E2E |
| `tests/create-ledger-account.regression.test.js` | ? | — | CoA regression |
| `tests/deletion-safety.integration.test.js` | ? | — | Deletion safety |
| `tests/integration-customer-bills.js` | ? | — | Customer bill integration |
| `tests/persistence.e2e.js` | ? | — | Persistence E2E |
| `tests/reset-crm-data.integration.test.js` | ? | — | Test data reset |
| `tests/tax-gst.test.js` | ? | — | Tax/GST tests |
| `tests/update-account-is-group.test.js` | ? | — | Account type change regression |

### 7.2 Test Status

From `HERMES_PROGRESS.md`: "Ran `npx vitest run`: 44/44 pass (6 files fail to load under vitest, expected)."

However, `customer-bills.vitest.test.js` has **172 test cases** — these include Step 12, 13, and 14 tests (S12.*, S13.*, S14.* test IDs). These tests will **fail** because:
1. Migrations 059-066 not applied (missing tables)
2. Permissions 064, 066 not applied (missing permissions)

### 7.3 Test Coverage Gaps

- No frontend/UI tests (no Selenium, Cypress, or Puppeteer tests for UI)
- `puppeteer` is in devDependencies but no test files use it
- No unit tests for `collections.service.js` / `collections.repository.js` (Step 14) as a separate file — Step 14 tests are embedded in `customer-bills.vitest.test.js`
- No tests for `receivable-summary.repository.js` as a standalone file — Step 12 tests are in `customer-bills.vitest.test.js`

---

## 8. Key Dependencies Between Modules

### 8.1 Module Dependency Graph

```
┌────────────────────────────────────────────────────────┐
│  database/migrate.js  →  connection.js  →  DatabaseSync │
└────────────────────────────────────────────────────────┘
         │
         ├──► auth.service.js / session.js → auth.controller.js → routes/auth.js
         │
         ├──► chart-of-accounts.repository.js → accounting-engine.service.js → routes/accounting.js
         │
         ├──► voucher.repository.js → customer-bill.service.js → customer-bill.controller.js → routes/customer-bills.js
         │    ├──► journal-entry.repository.js (JE creation/reversal)
         │    ├──► receivable.repository.js (AR balance updates)
         │    ├──► receivable-summary.repository.js (Step 12: aging, statements, collections)
         │    ├──► reporting.repository.js (Step 13: 17 report methods)
         │    ├──► collections.service.js → collections.repository.js (Step 14: automation)
         │    └──► tax-calculation-engine.js (GST calculation)
         │
         ├──► event-hooks.service.js → workflow-executor.service.js (triggers on domain events)
         │
         └──► rbac.js ← authorizer.js ← middleware/auth.js (all routes protected)
```

### 8.2 Reusable Components (Must NOT Duplicate)

| Component | File | Reused By |
|-----------|------|-----------|
| `AccountingEngine` | `accounting-engine.service.js` | All voucher/bill operations |
| `JournalEntryRepository` | `journal-entry.repository.js` | Every accounting posting |
| `VoucherRepository` | `voucher.repository.js` | CN/DN creation, cancellations |
| `ReceivableRepository` | `receivable.repository.js` | AR balance tracking |
| `TaxCalculationEngine` | `tax-calculation-engine.js` | All tax calculations |
| `CodeGenerator` | `code-generator.service.js` | Bill/VN/CN/DN numbering |
| `BaseRepository` | `accounting-base.repository.js` | All accounting repositories |
| `requirePermission()` | `middleware/rbac.js` | All protected routes |
| `ConnectionAdapter` | `database/connection.js` | All database access |
| `ReceivableSummaryRepository` | `receivable-summary.repository.js` | Step 12 outstanding/aging/statement |
| `ReportingRepository` | `reporting.repository.js` | Step 13 all reports |
| `CollectionsRepository` | `collections.repository.js` | Step 14 all collections |

### 8.3 Critical Cross-References

1. **`customer-bill.service.js`** (117K chars) is the **monolith** — it contains Step 9 through Step 14 logic, delegating to:
   - `VoucherRepository` for CN/DN
   - `JournalEntryRepository` for JEs
   - `ReceivableRepository` for AR
   - `ReceivableSummaryRepository` for Step 12 analytics
   - `ReportingRepository` for Step 13 reports
   - `CollectionsService`/`CollectionsRepository` via delegation

2. **`customer-bill.controller.js`** (1560 lines) has **duplicate method names**: `listCreditNotes` appears at lines 632 and 842; `getSalesRegister` appears at lines 82 and 1098. The later definition shadows the earlier in JS class context (actually, these are both `async listCreditNotes` — the second shadows the first, meaning the Step 11 version is lost).

3. **`receivable-summary.repository.js` line 106**: LEFT JOINs `credit_rules` table which does NOT exist in the DB. This will silently return NULL for all credit rule columns.

4. **Step 12 `getCustomerOutstanding`**: Uses `bills.contact_id` as the customer key, but Step 14 `collections.repository.js` uses `customer_id`. **Inconsistency in customer identification**.

---

## 9. Technical Risks

### 9.1 Critical Risks

| # | Risk | Impact | Likelihood |
|---|------|--------|------------|
| 1 | **Migrations 059-066 not applied** | Steps 10-14 code will throw SQL errors (table not found) | High |
| 2 | **Migration 066 bug** (`permission` vs `code` column) | Step 14 permissions will fail to insert, all Step 14 routes return 403 | High |
| 3 | **Duplicate controller methods** (`listCreditNotes`, `getSalesRegister`) | Step 11 list credit notes endpoint broken, Step 13 sales register shadows Step 9 | Medium |
| 4 | **`Authorizer.Permissions` Set is incomplete** | Missing all Step 9-14 permissions from the static set | Medium |
| 5 | **`contacts` missing `customer_code`, `gstin` columns** | Step 12 outstanding query returns NULL fields | Medium |

### 9.2 High-Priority Risks

| # | Risk | Impact |
|---|------|--------|
| 6 | **`credit_rules` table missing** | `getCustomerOutstanding` always returns NULL for credit_limit/credit_days |
| 7 | **No `_payments_backup` cleanup** | Temporary table from migration 059 lingers in DB |
| 8 | **`bills.currency` defaults to `USD`** | Wrong default for India-focused system |
| 9 | **Step 14 has no frontend page** | Collections automation backend will be unused |
| 10 | **`days_overdue` stored + recomputed** | Potential inconsistency between stored and computed values |

### 9.3 Architecture Risks

| # | Risk | Impact |
|---|------|--------|
| 11 | **Monolithic `customer-bill.service.js`** (117K chars) | Extremely hard to maintain; single point of failure |
| 12 | **`CollectionsRepository` is 53K chars** | Second largest file after the service |
| 13 | **No API versioning** | All routes under `/api/` with no version prefix |
| 14 | **Error messages use `String(err.message).slice(0, 200)`** | Truncates useful debugging info in production |
| 15 | **Case conversion middleware** converts all request bodies to snake_case | May break nested object structures |

---

## 10. Database/Schema Limitations

### 10.1 Missing Tables (Steps 10-14)

See §4.6 for complete list. The most impactful missing tables for Steps 12-14 functionality:

| Table | Blocked Feature |
|-------|----------------|
| `collection_assignments` | Collection owner assignment, dashboard |
| `collection_activities` | Activity timeline |
| `promises_to_pay` | Promise-to-pay tracking |
| `customer_disputes` | Collection-level dispute management |
| `credit_rules` | Customer credit limits (referenced in outstanding query) |
| `collection_rules` | Dunning rule configuration |
| `interest_rules` | Interest/late fee configuration |
| `bad_debt_cases` | Write-off workflow |
| `payment_plans` | Payment plan management |

### 10.2 Missing Columns

| Table | Column | Needed By | Step |
|-------|--------|-----------|------|
| `payments` | `payment_number` | Payment register, statement display | 10 |
| `contacts` | `customer_code` | Outstanding display | 12 |
| `contacts` | `gstin` | Outstanding/aging display | 12 |

### 10.3 Schema Design Patterns

1. **Company isolation**: Every table has `company_id TEXT NOT NULL DEFAULT 'default'`
2. **ID generation**: ULID-style (via `generateId` utility, prefixes like `bill_`, `vch_`, `je_`)
3. **Audit trail**: `created_at`/`updated_at` on every table; `created_by`/`updated_by` on many
4. **Soft deletes**: `deleted_at`, `deleted_by`, `delete_reason` on `contacts` (Step 7 pattern)
5. **Status enums**: String-based (no FK to status tables): DRAFT, PENDING_APPROVAL, APPROVED, POSTED, CANCELLED, VOID, COMPLETED, etc.
6. **Tax columns**: CGST/SGST/IGST amounts and rates stored directly on `bills` and `bill_items`
7. **No cascade deletes**: Foreign keys use `ON DELETE RESTRICT` implicitly (FK constraint errors caught by middleware)

---

## 11. Step-by-Step Implementation Status

| Step | Title | Code? | Migrations? | Tests? | Frontend? | Route Prefix |
|------|-------|-------|-------------|-------|-----------|--------------|
| 1 | Company & Financial Year Setup | ✅ | ✅ | — | ✅ | `/api/*` |
| 2 | Account Type & Classification | ✅ | ✅ | — | ✅ | `/api/accounting` |
| 3 | Account Group Master | ✅ | ✅ | — | ✅ | `/api/accounting` |
| 4 | Ledger Account Master | ✅ | ✅ | — | ✅ | `/api/accounting` |
| 5 | Opening Balances | ✅ | ✅ | ✅ 16 tests | ✅ | `/api/accounting` |
| 6 | (Reserved) | — | — | — | — | — |
| 7 | Receipt Voucher | ✅ | ✅ | — | ✅ | `/api/accounting` |
| 8 | Payment Voucher | ✅ | ✅ | — | ✅ | `/api/accounting` |
| 9 | Advanced Billing | ✅ | ✅ | ✅ (in 172-test file) | ✅ | `/api/customer-bills` |
| 10 | Payment Number | ✅ | ❌ 059 not applied | ? | ❌ | `/api/customer-bills/payments` |
| 11 | Credit/Debit Notes | ✅ | ✅ 061,062 applied | ✅ | ✅ | `/api/customer-bills/credit-notes` |
| 12 | AR Aging & Collections | ✅ | ❌ 063,064 not applied | ✅ 22 tests | ✅ partial | `/api/customer-bills/outstanding` |
| 13 | Reports & Analytics | ✅ | ✅ (no new tables) | ✅ 50 tests | ✅ | `/api/customer-bills/reports` |
| 14 | Collections Automation | ✅ | ❌ 065,066 not applied | ✅ 90+ tests | ❌ | `/api/customer-bills/collections` |
| 15-34 | **Future** | — | — | — | — | — |

---

## 12. Future Implementation Planning (Steps 15-34)

### 12.1 Step Inventory (Planned)

| Step | Title | Reuses Existing | New Components Needed |
|------|-------|-----------------|----------------------|
| 15 | Customer Receivables Follow-up (UI) | Steps 9-14 backend, `receivables`, `bills`, `payments`, `vouchers` | Frontend pages for collections workflow |
| 16 | Collection Activity Tracking (UI) | `collection_activities`, `collection_assignments` (Step 12) | Timeline component |
| 17 | Promise-to-Pay Management (UI) | `promises_to_pay` (Step 12) | Form + status workflow UI |
| 18 | Automated Dunning | `EmailService`, `communication_templates` (Step 14) | Scheduler (cron), email delivery |
| 19 | Interest on Overdue | `interest_rules`, `interest_charges` (Step 14) | Interest calculation scheduler |
| 20 | Bad Debt Write-off | `bad_debt_cases` (Step 14) | Write-off workflow UI, approval |
| 21 | Payment Plans | `payment_plans`, `payment_plan_installments` (Step 14) | Plan creation UI |
| 22 | Risk Scoring | `collection_risk_scores` (Step 14) | Scoring algorithm implementation |
| 23 | Collection Forecast | `receivables`, `payment_plans` | Forecast algorithm |
| 24 | Escalation Management | `collection_escalations` (Step 14) | Escalation workflow UI |
| 25 | Customer Communication Hub | `communication_templates`, `notifications` | Template editor, channel management |
| 26 | Bulk Operations | All existing repositories | Batch processing framework |
| 27 | Collection Performance Analytics | Step 13 reporting, Step 14 collections | Performance dashboards |
| 28 | Integration Readiness | All existing APIs | API export formats |
| 29 | Data Export & Archiving | Existing repositories | Export service |
| 30 | Mobile Responsiveness | All frontend pages | UI responsive design |
| 31 | Advanced Search & Filtering | `search.service.js` | Enhanced search |
| 32 | Multi-currency Support | `currencies`, `bills.currency` | Exchange rate integration |
| 33 | Audit Trail Enhancement | `accounting_audit`, `audit_logs` | Enhanced audit UI |
| 34 | System Administration | All existing components | Admin console |

### 12.2 Recommended Implementation Order

**Phase A: Fix Current State (Prerequisite)**
1. Apply migrations 059-066 (fix 066 bug first)
2. Fix duplicate controller methods
3. Update `Authorizer.Permissions` Set to include Steps 9-14
4. Run tests to verify all 172 pass

**Phase B: Frontend for Step 14 (Steps 15-17)**
1. Step 15: Build collections dashboard and workflow UI (reuse outstanding/aging APIs)
2. Step 16: Build activity timeline (reuse `collection_activities`)
3. Step 17: Build promise-to-pay management UI (reuse `promises_to_pay`)

**Phase C: Automation (Steps 18-24)**
4. Step 18: Dunning engine (cron + email/SMS)
5. Step 19: Interest calculation (cron + JE posting)
6. Step 20: Bad debt write-off (workflow + JE)
7. Step 21: Payment plans (workflow)
8. Step 22: Risk scoring (algorithm)
9. Step 23: Collection forecast (analytics)
10. Step 24: Escalation management (workflow)

**Phase D: Enhancement (Steps 25-34)**
11. Step 25: Communication hub
12. Step 26: Bulk operations
13. Step 27: Collection performance analytics
14. Step 28-34: Export, multi-currency, audit, search, admin

### 12.3 Architecture That Must Remain Source of Truth

1. **`customer-bill.service.js`** — the monolith service for all billing operations
2. **`journal-entry.repository.js`** — JE creation/reversal is the accounting backbone
3. **`voucher.repository.js`** — CN/DN/voucher persistence
4. **`chart-of-accounts.repository.js`** — CoA is the accounting foundation
5. **`database/connection.js`** — the node:sqlite adapter pattern
6. **`middleware/rbac.js` + `auth/authorizer.js`** — the RBAC/permissions system
7. **`migrate.js`** — migration runner with SHA-256 checksum verification

### 12.4 Future Step Planning Matrix

| Step | Depends On | New Tables | New Routes | New Services | Key Risk |
|------|-----------|------------|------------|--------------|----------|
| 15 | Step 12 (applied) | 0 | ~5 | 0 | Migration gap |
| 16 | Step 12 (applied) | 0 | ~3 | 0 | Migration gap |
| 17 | Step 12 (applied) | 0 | ~5 | 0 | Migration gap |
| 18 | Step 14 (email/sms not available) | 0 | ~3 | 1 (scheduler) | No email/SMS provider |
| 19 | Step 14 (applied) | 0 | ~5 | 0 | JE posting integration |
| 20 | Step 14 (applied) | 0 | ~5 | 0 | Approval workflow |
| 21 | Step 14 (applied) | 0 | ~7 | 0 | Payment plan logic |
| 22 | Step 14 (applied) | 0 | ~3 | 1 (risk algo) | Algorithm complexity |
| 23 | Step 12 (applied) | 0 | ~2 | 1 (forecast algo) | Prediction accuracy |
| 24 | Step 14 (applied) | 0 | ~5 | 0 | Escalation rules |
| 25 | Step 14 (applied) | 0 | ~5 | 1 (template manager) | Template engine |
| 26 | All existing | 0 | ~3 | 1 (batch) | Performance at scale |
| 27 | Step 13 (applied) | 0 | ~5 | 0 | Analytics accuracy |
| 28 | Step 13 (applied) | 0 | ~5 | 1 (export) | Export formats |
| 29 | Step 18-24 (applied) | 0 | ~5 | 1 (archiver) | Archive strategy |
| 30 | All frontend | 0 | 0 | 0 | Large refactor effort |
| 31 | Step 13 (applied) | 0 | ~3 | 1 (search enh.) | Search complexity |
| 32 | None | ~3 | ~10 | 2 (rates, converter) | Currency consistency |
| 33 | Step 13 (applied) | 0 | ~5 | 0 | Audit detail |
| 34 | All above | 0 | ~15 | 1 (admin) | Consolidation |

---

## 13. Summary of Findings

### 13.1 What Already Exists (Complete & Working)

- **Steps 1-8**: Fully implemented (code + migrations + frontend) — accounting foundation
- **Step 9**: Advanced billing fully implemented (code + migration 058 + frontend)
- **Step 11**: Credit/debit notes fully implemented (code + migrations 061-062 + frontend)
- **Step 13**: Reporting fully implemented (code only, no new migrations + frontend)
- **Core infrastructure**: Auth, RBAC, migration runner, connection adapter, error handling, case conversion middleware, code generator, event hooks, workflows

### 13.2 What Is Partially Implemented

- **Step 10**: Code exists (payment_number references), migration 059 NOT applied
- **Step 12**: Code exists (receivable-summary.repository.js, 22 tests), migrations 063-064 NOT applied
- **Step 14**: Code exists (collections.service.js, collections.repository.js, routes, controller methods, 172 test cases), migrations 065-066 NOT applied (066 has a bug)

### 13.3 What Is Missing

- **Database migrations 059-066 not applied** to live database (9 migrations missing)
- **Step 14 migration 066 has a bug**: uses `permission` column instead of `code`
- **Step 14 frontend page**: No collections UI page exists
- **No email/SMS provider integration** for Step 18 (dunning)
- **No PDF export library** (only CSV via string manipulation)
- **No `xlsx` package** for Excel export
- **No multi-currency support** beyond the `currency` column on `bills`
- **No scheduling framework** for automated tasks (cron, dunning, interest)
- **Authorizer PERMISSIONS Set** is outdated (doesn't include Steps 9-14 permissions)
- **Duplicate controller methods** in `customer-bill.controller.js` (shadowing issue)

### 13.4 Reuse Opportunities (Maximize Before Building New)

1. **`ReportingRepository`** (Step 13) — 17 methods already provide collection analytics; Steps 18-24 should extend this, not create new reporting layers
2. **`ReceivableSummaryRepository`** (Step 12) — AR aging, outstanding, statement engines; Steps 15-17 should call these, not reimplement
3. **`CollectionsRepository`** (Step 14) — 30+ methods for rules, dunning, interest, bad debt, payment plans, risk; Steps 18-24 should use these
4. **`AccountingEngine`** — JE posting/reversal is the backbone; all Steps 18-24 accounting effects should go through this
5. **`EventHooksService`** — existing trigger system can be extended for collection events
6. **`CodeGenerator`** — sequential numbering for all new entities
7. **`notification.service.js`** — existing notification system (email, in-app) can be used for dunning
8. **`workflow-executor.service.js`** — existing workflow engine can be extended for escalation workflows
9. **`AccountingBaseRepository`** — the base class pattern for all new repositories
10. **`caseConverter` middleware** — automatic request/response snake_case ↔ camelCase conversion for new APIs