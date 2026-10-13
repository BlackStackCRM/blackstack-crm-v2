# BLACKSTACK CRM V2 — Current Database Architecture Audit

**Date:** 2026-10-06
**Scope:** Read-only audit of the live SQLite database and the code that reads/writes it.
**Auditor:** Hermes Agent
**Live database:** `D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2\data\blackstack-crm.db`

> **No architecture was modified during this audit.** Every query ran read-only
> (`DatabaseSync(path, { readOnly: true })`). No migration, no cleanup, no test
> reset, no WAL/SHM deletion. Problems found are **reported, not fixed**.

---

# Executive Summary

The database is **structurally sound and internally consistent at the data level**:
`PRAGMA integrity_check` returns `ok`, `PRAGMA foreign_key_check` returns **0 violations**,
and `stock_balances` is **exactly reproducible** from `stock_ledger` (0 mismatches, 0 orphans).

The recent repair achieved its primary goals: **one ledger writer, one canonical
location master, one valuation authority, and a real bill → inventory bridge.**

However, the consolidation left **two live code paths pointing at retired schema**.
These are genuine regressions introduced by the repair, not pre-existing defects:

| Severity | Finding |
|---|---|
| **HIGH** | 5 code locations still read/write the retired, now-empty `inv_locations` table. The location hierarchy and hierarchy-summary APIs will return **0 locations** instead of 7. |
| **HIGH** | `accounting.controller.js` queries `inventory_items ... product_id`, but migration 082 re-keyed that table to `item_id`. Verified to **throw `no such column: product_id`** at runtime. |
| **MEDIUM** | `reporting.repository.js` joins `inventory_items w ON w.id = b.warehouse_id` — semantically wrong (the table is keyed by stock item, not warehouse). Currently masked because `bills` is empty. |
| **MEDIUM** | 3 products that own a stock item have `is_inventory_managed = 0`. Cosmetic (the bridge decides on the stock-item row, not the flag) but misleading. |
| **LOW** | Dead code retained: `InventoryRepository.rebuildStockBalances()` has zero callers; `AccountingController.processInventoryMovement()` has zero callers; `inventory_items_v2` is an orphan table. |

**Data is intact.** 46 tables hold data; `bills`/`payments`/`receivables` are empty
because no bills exist yet in this database.

---

# Database Overview

| Property | Value |
|---|---|
| File | `data/blackstack-crm.db` |
| Size | 2.74 MB (2,875,392 bytes) |
| SQLite version | 3.53.4 |
| `journal_mode` | `wal` |
| `foreign_keys` pragma | `1` (enabled) |
| Tables | **141** |
| Indexes (with SQL) | **271** |
| Triggers | **0** |
| Views | **0** |
| Foreign keys | **234** |
| Migrations recorded | **68** (max version **80**) |
| Last modified | 2026-10-05T19:15:38Z |

**Path resolution (two code paths, must agree):**
- `server/database/connection.js:5` — `process.env.DB_PATH || '../../data/blackstack-crm.db'`
- `server/config/userDataPath.js:33` — `process.env.DB_PATH || '../data/blackstack-crm.db'`
- `.env` — `DB_PATH=./data/blackstack-crm.db`, `PORT=3000`
- Backups and locks live under `BLACKSTACK_USER_DATA_DIR` (default `server/../user-data`)

**Migration state note:** `schema_migrations` records version 80 only. Steps **081**
(location consolidation) and **082** (`inventory_items` re-key) are *programmatic*
steps in `server/database/migrate.js`, so by design they leave no `schema_migrations`
row. Their effects are visible in the schema (`locations` = 7, `inv_locations` = 0,
`inventory_items.item_id` exists).

---

# Current Architecture Diagram

```
                    ┌──────────────────────────────┐
                    │  stock_groups                │
                    │    └──< stock_categories     │
                    │           └──< models ──> brands
                    └──────────────┬───────────────┘
                                   │ (hierarchy FKs)
   ┌───────────────────────────────┴────────────────────────────┐
   │                                                            │
┌──▼──────────────┐                                    ┌────────▼─────────┐
│ products        │  (commercial identity)             │ stock_items      │ (inventory identity)
│  - NO quantity  │──── stock_items.product_id ───────>│  - uom_id        │
│  - NO unit FK   │                                    │  - is_batch_tr.. │
│  - NO batch/    │                                    │  - is_serial_tr. │
│    serial flags │                                    │  - cogs_account  │
└─────────────────┘                                    └────────┬─────────┘
                                                               │
   ┌───────────────────────────────────────────────────────────┼──────────────┐
   │                                                           │              │
┌──▼─────────────┐   ┌──────────────┐   ┌──────────────┐   ┌─────▼──────┐  ┌────▼──────┐
│ locations  ★   │◄──│ godowns      │   │ batches      │   │ item_serials│  │ units_of_ │
│ (CANONICAL)    │   │ (belong to  │   │ item_id FK   │   │ status enum│  │ measure   │
│ inv_locations  │   │  a location) │   │ mfg + expiry │   │ available..│  │ (CANONICAL)│
│ (RETIRED, 0)  │   └──────┬───────┘   └──────┬───────┘   └────────────┘  │ uoms      │
└─────────────────┘          │                  │                          │ (LEGACY)  │
                            │                  │                          └───────────┘
                            └────────┬─────────┘
                                     ▼
                  ┌──────────────────────────────────────┐
                  │ inventory_voucher_headers / _lines   │  7 voucher types
                  │   opening_stock, stock_inward,       │
                  │   stock_outward, stock_transfer,     │
                  │   stock_adjustment, physical_stock,  │
                  │   stock_journal                       │
                  │   + source_document_type / _id   ★    │  ← idempotency
                  └──────────────────┬───────────────────┘
                                     ▼
                  ┌──────────────────────────────────────┐
                  │ stock_ledger      ★ SINGLE WRITER    │  immutable history
                  │   signed quantity, godown, location, │
                  │   batch, serial, unit_rate, amount,  │
                  │   source_document_*, created_by      │
                  └──────────────────┬───────────────────┘
                                     ▼  (derived, never hand-written)
                  ┌──────────────────────────────────────┐
                  │ stock_balances    ★ DERIVED CACHE    │
                  │   UNIQUE(company,item,batch,godown,   │
                  │          location)                    │
                  └──────────────────┬───────────────────┘
                                     ▼
                  ┌──────────────────────────────────────┐
                  │ inventory_items  ★ VALUATION         │  moving weighted
                  │   item_id FK, unit_cost, total_value │  average
                  │   legacy_product_id (compat)         │
                  │   → valuation_movements (audit)      │
                  └──────────────────────────────────────┘

BILLING (parallel, now bridged)
   bills ──< bill_items (+stock_item_id, godown, location, batch, serial)>
     │  status: DRAFT→PENDING_APPROVAL→APPROVED→POSTED→PARTIALLY_PAID/PAID
     │  journal_entry_id ─────────────► journal_entries / journal_entry_lines
     │  inventory_voucher_header_id ─► inventory_voucher_headers  (★ NEW)
     │  receivable ──────────────────► receivables ─► receivable_allocations
     └── cancel ─► inverse stock_ledger rows + reversal journal (history preserved)

   ★ = added or consolidated by the recent repair
```

---

# Table Inventory

**141 tables.** Grouped by domain (from live `sqlite_master`, not assumptions):

### CRM / Contacts (4)
`contacts`, `contact_tags`, `customers`, `organizations`

### CRM / Pipeline (6)
`leads`, `deals`, `pipelines`, `pipeline_stages`, `activities`, `appointments`

### CRM / Tasks, Notes & Workflow (7)
`tasks`, `notes`, `relationships`, `workflow_definitions`, `workflow_nodes`, `workflow_instances`, `workflow_executions`

### Inventory / Product Master (13)
`products`, `stock_items`, `models`, `brands`, `stock_categories`, `stock_groups`, `product_specifications`, `specification_templates`, `specification_attributes`, `colours`, `sizes`, `styles`, `select_options`

### Inventory / Units & Pricing (7)
`units_of_measure` ★canonical, `uoms` (legacy), `alternate_units`, `compound_units`, `item_prices`, `price_levels`, `rate`

### Inventory / Locations (3)
`locations` ★canonical (7 rows), `inv_locations` (retired, 0 rows), `godowns` (2 rows)

### Inventory / Tracking (3)
`batches` (1), `item_serials` (2), `batch_wise_stock` (legacy, 0)

### Inventory / Transactions (7)
`inventory_voucher_headers` (2), `inventory_voucher_lines` (2), `stock_ledger` (2), `physical_stock_documents` (0), `physical_stock_lines` (0), `adjustment_reasons`, `stock_adjustment_reasons` (legacy)

### Inventory / Balances & Valuation (4)
`stock_balances` (2), `inventory_items` (0), `inventory_movements` (legacy, 0), `valuation_movements` (0, new)

### Billing / Bills (8)
`bills` (0), `bill_items` (0), `bill_allocations`, `bill_approvals`, `bill_events`, `bill_templates`, `recurring_bills`, `recurring_generation_log`

### Billing / Payments (5)
`payments` (0), `payment_plans`, `payment_plan_installments`, `payment_reconciliations`, `payment_reminders`

### Billing / Collections (14)
`collection_assignments`, `collection_activities`, `collection_actions`, `collection_action_logs`, `collection_escalations`, `collection_risk_scores`, `collection_rules`, `credit_rules`, `promises_to_pay`, `customer_disputes`, `customer_bill_disputes`, `customer_bill_audit_log`, `customer_bill_writeoffs`, `customer_advances`

### Billing / Legacy (2)
`invoices`, `invoice_line_items` (88 code references — see Legacy Systems)

### Accounting / Core (7)
`journal_entries` (25), `journal_entry_lines` (102), `accounts`, `account_groups`, `account_types`, `opening_balances`, `opening_balance_lines`

### Accounting / Receivables & Payables (7)
`receivables` (0), `receivable_allocations`, `ar_reconciliation_log`, `payables`, `payable_allocations`, `ap_reconciliation_log`, `customer_advances`

### Accounting / Vouchers (4 populated in schema)
`vouchers` (25), `expense_voucher_lines`, `credit_note_lines`, `debit_note_lines`

### Accounting / Tax (7)
`tax_masters`, `tax_components`, `tax_types`, `tax_account_mappings`, `company_tax_configs`, `transaction_tax_details`, `tax_audit_log`

### Accounting / Banking, Budget, Interest (12)
`bank_accounts`, `bank_reconciliations`, `bank_reconciliation_items`, `budgets`, `budget_lines`, `cost_centres`, `cost_categories`, `interest_configs`, `interest_rules`, `interest_charges`, `interest_calculations`, `year_end_closings`

### System (15)
`companies`, `users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `audit_logs`, `currencies`, `financial_years`, `number_sequences`, `system_metadata`, `schema_migrations`, `database_health_logs`, `legacy_tables` ★new, `_payments_backup`

### Ungrouped (6)
`accounting_audit`, `collection_audit`, `communication_templates`, **`inventory_items_v2`** (orphan), `notifications`, `tags`

---

# Foreign Key Audit

**234 foreign keys** across the schema. Spot-check of the inventory chain:

| From | Column | → Target | ON DELETE |
|---|---|---|---|
| `products` | `model_id` | `models.id` | SET NULL |
| `products` | `brand_id` | `brands.id` | SET NULL |
| `products` | `stock_category_id` | `stock_categories.id` | SET NULL |
| `products` | `stock_group_id` | `stock_groups.id` | SET NULL |
| `products` | `location_id` | **`locations.id`** ★ | SET NULL |
| `stock_items` | `product_id` | `products.id` | SET NULL |
| `stock_items` | `uom_id` | `units_of_measure.id` | **RESTRICT** |
| `stock_items` | `location_id` | **`locations.id`** ★ | SET NULL |
| `stock_items` | `godown_id` | `godowns.id` | SET NULL |
| `stock_items` | `cogs_account_id` | `accounts.id` | SET NULL |
| `stock_groups` | `location_id` | **`locations.id`** ★ | SET NULL |
| `stock_categories` | `stock_group_id` | `stock_groups.id` | **RESTRICT** |
| `models` | `brand_id` | `brands.id` | SET NULL |
| `models` | `stock_category_id` | `stock_categories.id` | SET NULL |
| `godowns` | `location_id` | `locations.id` | SET NULL |
| `stock_ledger` | `item_id` | `stock_items.id` | **RESTRICT** |
| `stock_ledger` | `godown_id` | `godowns.id` | **RESTRICT** |
| `stock_ledger` | `batch_id` | `batches.id` | SET NULL |
| `stock_ledger` | `location_id` | `locations.id` | SET NULL |
| `stock_balances` | `item_id`/`batch_id`/`godown_id`/`location_id` | respective | CASCADE |
| `inventory_items` | `item_id` | `stock_items.id` | CASCADE |
| `bill_items` | `stock_item_id` ★ | `stock_items.id` | SET NULL |
| `bill_items` | `batch_id` ★ | `batches.id` | SET NULL |
| `bill_items` | `serial_id` ★ | `item_serials.id` | SET NULL |
| `bills` | `inventory_voucher_header_id` ★ | `inventory_voucher_headers.id` | SET NULL |

### `PRAGMA foreign_key_check`

```
0 violations
```

**No FK references `inv_locations` remain** — the repointing was complete at the schema level.

---

# Duplicate / Legacy Systems

| Role | System A | System B | A active? | B active? | FK target? | Verdict |
|---|---|---|---|---|---|---|
| Location master | `locations` (**7 rows**) | `inv_locations` (**0 rows**) | ✅ canonical | ❌ retired | none to B | **B still read by 5 code sites — HIGH** |
| UOM | `units_of_measure` (1) | `uoms` (0) | ✅ canonical | ❌ dead | `stock_items.uom_id` → A | A correct |
| Movement history | `stock_ledger` (2) | `inventory_movements` (0) | ✅ canonical | ❌ dead | `inventory_movements.product_id` → products (legacy) | A correct |
| Inventory balance | `stock_balances` (2) | `inventory_items` (0) | ✅ canonical | ✅ valuation | — | **Not duplicates — different roles** |
| Batch balance | `stock_balances` + `batches` | `batch_wise_stock` (0) | ✅ canonical | ❌ dead | none | A correct |
| Adjustment reason | `adjustment_reasons` | `stock_adjustment_reasons` (0) | ✅ canonical | ❌ dead | `inventory_voucher_lines.adjustment_reason_id` → A | A correct |
| Sales document | `bills` (0) | `invoices` (0) | ✅ canonical | ⚠️ 88 code refs | — | Needs review |

**Nothing was deleted.** All legacy tables are retained and recorded in `legacy_tables`:

| Table | Status | Canonical replacement |
|---|---|---|
| `uoms` | LEGACY | `units_of_measure` |
| `batch_wise_stock` | LEGACY | `stock_balances` |
| `inventory_movements` | LEGACY | `stock_ledger` |
| `stock_adjustment_reasons` | LEGACY | `adjustment_reasons` |
| `inv_locations` | RETIRED (7 rows at retirement) | `locations` |

**`invoices` is the notable open question:** 88 code references, 0 rows. If any UI or
report still reads it, that is a live legacy path. **Not verified in depth in this audit.**

---

# Inventory Architecture

**Commercial identity = `products`. Physical inventory identity = `stock_items`.**

`products` deliberately carries **no quantity column and no unit FK**. All physical
attributes live on `stock_items` (`uom_id`, `is_batch_tracked`, `is_serial_tracked`,
`cost_price`, `selling_rate`, COGS/asset accounts, `godown_id`, `location_id`).
Bridge: `stock_items.product_id → products.id`.

### Hierarchy verification (live data)

| Relationship | Resolved | Notes |
|---|---|---|
| Product → Model | **3 / 3** | FK, SET NULL |
| Product → Brand | 3 / 3 | FK, SET NULL (denormalised onto product) |
| Product → Stock Category | 3 / 3 | FK, SET NULL |
| Product → Stock Group | 3 / 3 | FK, SET NULL |
| Model → Brand | 2 / 2 | FK, SET NULL |
| Model → Stock Category | 2 / 2 | FK, SET NULL |
| Stock Category → Stock Group | 2 / 2 | FK, **RESTRICT** |
| **Brand → Stock Category** | **NO FK EXISTS** | By design — Brand is an independent master |

The requested `Stock Group → Stock Category → Brand → Model → Product` chain is
enforced **except** for Brand → Stock Category. Migration 078b explicitly *removed*
`brands.stock_category_id` and `migrate.js` documents Brand as independent master data.
Category is reachable only via `models.stock_category_id`. **This is intentional, not a defect.**

---

# Stock Ledger Architecture

**`stock_ledger` IS the authoritative transaction history.** Verified by writer inventory:

### Writers to `stock_ledger` — exactly ONE

```
server/services/inventory-engine.service.js:178   INSERT INTO stock_ledger
```

Reached through `InventoryEngine.postLedgerMovement()`, whose callers are:
- `bill-inventory-bridge.service.js:296` — bill stock-out
- `bill-inventory-bridge.service.js:376` — bill cancellation reversal
- `bill-inventory-bridge.service.js:462` — credit-note (sales return) stock-in
- `inventory.service.js:490` — all manual vouchers (opening/inward/outward/transfer/adjustment/journal)

### Writers to `stock_balances` — all inside rebuild functions

```
server/repositories/inventory.repository.js:379   DELETE FROM stock_balances WHERE company_id = ?
server/repositories/inventory.repository.js:399   INSERT INTO stock_balances  (rebuildStockBalances)
server/services/inventory-engine.service.js:201  DELETE FROM stock_balances WHERE <dims>
server/services/inventory-engine.service.js:216  INSERT INTO stock_balances  (rebuildBalances)
```

**No `UPDATE stock_balances` anywhere. No direct quantity mutation.**
The previous regression — `products.controller.js` writing opening quantity straight
into `stock_balances` — is **gone**; opening stock now flows through an `opening_stock`
voucher (`products.controller.js:301` comment + `_postOpeningStockVoucher`).

### Ledger data captured (migration 080)

`source_document_type`, `source_document_id`, `created_by` — previously absent entirely.

### Live data

```
stock_ledger: 2 rows, both voucher_type = opening_stock, total qty 2
by source document: (none) x2   ← these predate migration 080, so NULL is correct
```

### Voucher lifecycle

`inventory_voucher_headers.status` ∈ `draft`, `posted`, `cancelled`.
7 `voucher_type` values: `opening_stock`, `stock_inward`, `stock_outward`,
`stock_transfer`, `stock_adjustment`, `physical_stock`, `stock_journal`.

---

# Stock Balance Architecture

`stock_balances` is **derived**. Verified by independent recomputation:

```
stock_balances rows                     : 2
rows disagreeing with ledger SUM        : 0
balance rows with no ledger backing     : 0
SUM(stock_ledger.quantity)              : 2
SUM(stock_balances.quantity)            : 2   ✓ consistent
negative balances                       : 0
```

**Readers:** `inventory.service.js` (valuation, batch, godown, location, expiry reports),
`inventory.controller.js:212`, `products.controller.js:51,65,414` (product on-hand list
and detail), and the new `InventoryEngine.rebuildBalances`.

**Rebuild safety:** `rebuildBalances(companyId, { itemId })` deletes and recomputes
**only the affected item**, replacing the previous whole-company wipe on every post.

**Report aggregation fix:** valuation/batch/expiry reports now `SUM()` over
`stock_balances` per item. Previously they selected `sb.quantity` per row, which
under-reported any item split across godowns.

---

# Opening Stock Flow

**Correct as implemented:**

```
Product form (opening_quantity, opening_rate, godown, location)
   └─> products.controller.js:_postOpeningStockVoucher()
         └─> InventoryService.createDraftVoucher({ voucher_type: 'opening_stock' })
               └─> POST /api/inventory/vouchers/:number/post
                     └─> InventoryEngine.postLedgerMovement()   [immutable row]
                     └─> InventoryEngine.rebuildBalances()     [derived]
```

**Verified:** no code path inserts into `stock_balances` without a ledger entry.
`grep -rnE "(INSERT INTO|UPDATE|DELETE FROM) stock_balances" server/` returns only
the two rebuild functions.

---

# Customer Bill → Inventory Flow

```
createBill (DRAFT)          → no stock effect          ✓ verified by test
submitForApproval           → no stock effect          ✓
approveBill (APPROVED)      → no stock effect          ✓
postBill (POSTED)           → stock deducted           ✓
   ├─ preflight()  validates godown/batch/serial + available qty  (BEFORE the transaction)
   ├─ journal entry: Dr Receivable / Cr Sales / Cr Tax
   ├─ BillInventoryBridge.postForBill()
   │    ├─ idempotency check (findVoucherBySource)
   │    ├─ INSERT inventory_voucher_headers (source_document_type='CUSTOMER_BILL', source_document_id=bill_id)
   │    ├─ INSERT inventory_voucher_lines
   │    ├─ INSERT stock_ledger (negative qty, source_document_*, created_by)
   │    ├─ InventoryEngine.applyValuation(direction=-1)  → COGS cost
   │    ├─ item_serials: available → sold
   │    └─ rebuildBalances(itemId)
   ├─ bills.inventory_voucher_header_id ← voucher id
   ├─ COGS lines appended to the SAME journal entry (Dr COGS / Cr Inventory Asset)
   ├─ _upsertReceivable()
   └─ all inside conn.transaction()  → atomic with accounting
```

### Idempotency — two independent mechanisms

1. **Application:** `InventoryEngine.findVoucherBySource()` early-returns the existing voucher.
2. **Database:** `uq_ivh_one_per_source_document` UNIQUE index on
   `(company_id, source_document_type, source_document_id) WHERE source_document_id IS NOT NULL`.

**Verified present in the live database:**
`uq_ivh_one_per_source_document`, `idx_stock_ledger_source_document`,
`idx_bill_items_stock_item`, `idx_bills_inventory_voucher`.

A second `POST` cannot deduct stock twice: the state machine rejects it
(`canTransition` disallows `POSTED → POSTED`), and even if reached, the unique index blocks it.

### Credit note / sales return

`createCreditNote` posts a `stock_inward` via `BillInventoryBridge.postReturn()` when
`wantsRestock` is true, and reverses COGS into the same journal entry.

**Live data:** 0 bills exist, so this path is **structurally present but not exercised by production data.**

---

# Bill Cancellation Flow

```
cancelBill
   ├─ InventoryBridge.reverseForBill()
   │    ├─ finds the ORIGINAL stock_outward ledger rows by source document
   │    ├─ APPENDS inverse rows (+qty, source_document_type='CUSTOMER_BILL_REVERSAL')
   │    ├─ applyValuation(direction=+1) at the original unit_rate
   │    ├─ item_serials: sold → available
   │    └─ rebuildBalances(itemId)
   ├─ journalRepo.reverse() → reversing JE
   ├─ bills.reversal_journal_entry_id, inventory_reversal_voucher_header_id
   └─ all inside conn.transaction()
```

**History is preserved.** The original `-10` row is never deleted or modified — an
inverse `+10` row is appended. Verified by test: *"ledger has 2 bill-related rows
(out + reversal)"*, *"original -10 still present (not deleted)"*.

Repeated cancellation is rejected by the state machine (`CANCELLED` has no outgoing transitions).

---

# Batch Architecture

```
stock_items.is_batch_tracked = 1
   └─> batches (batch_number, manufacturing_date, expiry_date, purchase_rate)
         └─> stock_ledger.batch_id   → batch stock is LEDGER-DERIVED, not a separate table
```

**Validation hardening (confirmed in `inventory.validator.js`):**
- A batch-tracked item **requires** `batch_id` on any outward — throws otherwise.
- Validation applies `AND batch_id = ?` so it checks **only the selected batch**, never the cross-batch total.
- Non-batch items get `AND (batch_id IS NULL)` — never a stray batch dimension.
- **Expired batches are refused**: `batch.expiry_date < today` → `ValidationError`.
- Expired batches are excluded from `getActiveBatches()` by default.

**Live data:** 1 batch, **0 batch-tracked stock items** — so this path is code-verified
but not data-exercised in the live database. Covered by `scripts/test-batch-serial.js` (21 assertions).

---

# Serial Architecture

`item_serials.status` CHECK constraint — the real enum:

```
'in_transit', 'available', 'sold', 'returned', 'damaged', 'scrapped', 'expired'
```

**Validation (`inventory.validator.js` + `bill-inventory-bridge.service.js`):**
- Serial-tracked items **require** a serial number.
- The serial must exist, belong to the same `item_id`, be **`available`**, and sit in the same godown.
- `count` must equal `quantity`: *"quantity is X but N serial(s) were selected. They must match."*
- Transfers move godown/location and **keep status `available`** (verified by test S8).
- Cancellation returns `sold → available` only if still `sold`.

**Live data:** 2 serials, both `available`, on 2 serial-tracked stock items. **0 invalid statuses.**

---

# Location/Godown Architecture

```
locations (CANONICAL, 7 rows)
   │  godowns.location_id → locations.id  (ON DELETE SET NULL, RESTRICT on physical_stock_documents)
   ▼
godowns (2 rows)
   │  stock_items.godown_id, stock_ledger.godown_id (RESTRICT), stock_balances.godown_id (CASCADE)
   ▼
stock_ledger / stock_balances (both carry godown_id AND location_id independently)
```

**Consistency check:** 0 rows where a balance's `location_id` disagrees with its
godown's own `location_id`.

**`inv_locations` is retired and empty (0 rows), and no FK references it.**
Its 7 rows were merged into `locations` with ids preserved; the one id that existed
in both tables (with divergent names "MVP" vs "MVP (3YV3JD)") was reconciled in favour
of the row that godowns/ledger/reports actually point at.

⚠️ **But 5 code sites still read/write it — see Problem 1.**

---

# UOM Architecture

**Canonical: `units_of_measure`** (1 row: Unit/unit).

- `stock_items.uom_id → units_of_measure.id` **ON DELETE RESTRICT** — a stock item cannot exist without a valid UOM.
- `inventory_voucher_lines.uom_id → units_of_measure.id` **RESTRICT**.
- `alternate_units.base_unit_id`, `compound_units.base_unit_id` → `units_of_measure` **RESTRICT**.
- `products` has **no** unit column (by design — units are an inventory attribute).
- `bill_items.unit` is a **free-text** column defaulting to `'PCS'`; it is **not** FK-backed.

`uoms` is retained as a legacy shell with 0 rows and **no code references**.

---

# Valuation Architecture

**Authoritative: `InventoryEngine.applyValuation()` → `inventory_items` + `valuation_movements`.**

```
inventory_items (0 rows)
  item_id (FK → stock_items)  ← re-keyed by migration 082
  quantity, unit_cost, total_value, valuation_method='WEIGHTED_AVERAGE'
  legacy_product_id  ← compat for accounting.controller.js (still broken, see Problem 2)
  last_inward_at, last_outward_at
       │ 1:1 audit
       ▼
valuation_movements (0 rows, new in 080)
  records every cost change: direction, qty, unit_cost, balance_qty, balance_value,
  resulting_unit_cost, source_document_type/_id, created_by
```

**Moving weighted average (carried over from the previously-dead `processInventoryMovement`):**
- Increase: `new_cost = (old_value + new_value) / (old_qty + new_qty)`
- Decrease: cost released at the existing `unit_cost`; unit cost unchanged
- Transfer: no net company value change (rate is carried across both ledger legs)

**Callers:** `bill-inventory-bridge.service.js:318,398,483` (bill out, bill reversal,
sales return) and `inventory.service.js:347,955` (manual vouchers, voucher cancellation).

### Dead / competing valuation code

| Location | Function | Callers | Reports depend on it? |
|---|---|---|---|
| `accounting.controller.js:13337` | `processInventoryMovement()` | **0** | No — superseded |
| `accounting.controller.js:13202,13353,13377,13394,13416` | `inventory_items` by `product_id` | route-bound | Yes, but **throws** (Problem 2) |
| `reporting.repository.js:1024` | `LEFT JOIN inventory_items w ON w.id = b.warehouse_id` | warehouse report | Yes, semantically wrong (Problem 3) |
| `inventory.repository.js:376` | `rebuildStockBalances()` | **0** | No — superseded by `rebuildBalances()` |

**There is exactly one functioning valuation engine.** The others are dead or broken.

---

# Accounting Integration

```
Stock Inward   → Dr Inventory Asset / Cr Purchase (or source account)
Stock Outward  → Dr COGS / Cr Inventory Asset     (via _buildAccountingLines)
Stock Transfer → no P&L entry (value-neutral)
Physical Stock → approval generates an adjustment voucher → normal outward path

Customer Bill POSTED
  → Dr Receivable  Cr Sales  Cr Output Tax        (pre-existing)
  → Dr COGS        Cr Inventory Asset             (NEW, same journal entry)
  → receivables row + bill_allocations on payment

Cancellation
  → journalRepo.reverse()  (reversing JE, originals preserved)
  → inventory reversal rows appended
```

**Account resolution:** `InventoryService._inventoryAccountFallbacks()` provides
company-level fallbacks (`acc_cogs`, `acc_inventory`, `acc_capital`, `acc_purchases`,
`acc_sales`) so a stock item without mapped accounts still posts. Previously a NULL
`account_id` made opening stock impossible to post at all.

`CustomerBillService._resolveAccountMappings()` gained `cogs`, `inventoryAsset`,
`inventoryVariance` — deliberately **optional**, so a service-only bill can still post.

**Live data:** 25 journal entries / 102 lines exist (chart-of-accounts and opening
balances seeded). **0 bills, so the bill→COGS path is not data-exercised in the live DB.**

---

# Reporting Architecture

| Report | Endpoint | Source | Status |
|---|---|---|---|
| Valuation | `GET /api/inventory/reports/valuation` | `stock_balances` **aggregated per item** ★ | ✅ fixed |
| Batch-wise | `GET /reports/batch-stock` | `stock_balances` subquery grouped by item+batch ★ | ✅ fixed |
| Godown-wise | `GET /reports/godown-stock` | `stock_balances` by godown | ✅ |
| Location-wise | `GET /reports/location-stock` | `stock_balances` JOIN **`locations`** | ✅ |
| Expiry | `GET /reports/expiry` | `batches` + aggregated `stock_balances` ★ | ✅ fixed |
| Serial | `GET /reports/serials` | `item_serials` | ✅ (no quantity — by design) |
| Product on-hand | `GET /api/products` | `products` LEFT JOIN `stock_items` + `stock_balances` | ✅ |
| Stock by location | `GET /api/inventory/stocks` | `stock_balances` — **joins `inv_locations`** ⚠️ | ❌ **Problem 1** |

**No report reads `batch_wise_stock`, `inventory_movements`, or `uoms`.**

---

# Code/Database Consistency

| Check | Result |
|---|---|
| Code referencing deleted columns | **`accounting.controller.js` → `inventory_items.product_id`** ❌ |
| Code referencing retired tables | **5 sites → `inv_locations`** ❌ |
| Dead repositories | `rebuildStockBalances()` — 0 callers ⚠️ |
| Unused services | `processInventoryMovement()` — 0 callers ⚠️ |
| Orphan tables | `inventory_items_v2` (created by 080, never adopted) ⚠️ |
| Orphan table | `_payments_backup` — 0 rows, 0 references ⚠️ |
| Mismatched column names | `inventory_items.item_id` vs code expecting `product_id` ❌ |
| Frontend using old architecture | **Not verified** — requires browser run |
| Frontend fields not persisted | **Not verified** — requires browser run |
| Backend fields not exposed | **Not verified** — requires browser run |

---

# Integrity Results

| Check | Result |
|---|---|
| `PRAGMA integrity_check` | **`ok`** |
| `PRAGMA quick_check` | **`ok`** |
| `PRAGMA foreign_key_check` | **0 violations** |
| Orphan detection (FK) | 0 |
| `stock_balances` vs ledger | 0 mismatches, 0 orphans |
| Negative stock | 0 rows |
| Invalid serial states | 0 rows |
| Duplicate `stock_items.sku` | 0 |
| Duplicate batch per item | 0 |
| Duplicate serial numbers | 0 |
| Godown/location disagreement | 0 rows |
| Posted bills missing a stock voucher | **0** (no bills exist) |
| `bill_items` → missing stock item | 0 |

**Only one automated finding: 3 products own a stock item but have `is_inventory_managed = 0` (MEDIUM, cosmetic).**

---

# Problems Found

## Problem 1 — Live code still uses the retired `inv_locations` table

- **Severity: HIGH**
- **Files / lines:**
  - `server/repositories/inventory.repository.js:605` — `getLocationHierarchy()`: `SELECT * FROM inv_locations ...`
  - `server/repositories/inventory.repository.js:665` — `getHierarchySummary()`: `SELECT COUNT(*) ... FROM inv_locations`
  - `server/repositories/inventory.repository.js:159-201` — `createLocation()` still dual-writes into `inv_locations`
  - `server/repositories/inventory.repository.js:46` — `inv_locations` still in the master-table allow-list
  - `server/controllers/inventory.controller.js:219` — stock-by-location resolves names via `findOne('inv_locations', ...)`
  - `server/controllers/products.controller.js:236,426` — accepts locations from either table
- **Exact issue:** migration 081 merged all `inv_locations` rows into `locations` and emptied `inv_locations`, but five code sites were left pointing at it.
- **Current behaviour:** `inv_locations` has **0 rows** while `locations` has **7**. `getLocationHierarchy()` therefore returns an **empty location list**, and `getHierarchySummary().locations` returns **0** instead of 7. `GET /api/inventory/hierarchy` and `/hierarchy/summary` are wrong. Stock-by-location falls back to `'Unknown'` for location names because `findOne('inv_locations', id)` returns null — even though the same `location_id` resolves correctly in `locations` (verified against live `stock_balances` rows).
- **Expected behaviour:** all five sites read/write `locations` only.
- **Risk:** the Inventory dashboard's Location hierarchy and the stock-by-location report will appear empty or show "Unknown". The Product form's location validation silently accepts nothing from the canonical table. Re-creating a location will attempt an insert into `inv_locations` that silently fails (the pre-existing silent `catch`), reproducing the original dual-write divergence.
- **Recommended fix (NOT applied):** repoint all five sites to `locations`; remove the dual-write from `createLocation()`; drop `inv_locations` from the master allow-list at line 46.

## Problem 2 — `accounting.controller.js` queries a column that no longer exists

- **Severity: HIGH**
- **File / lines:** `server/controllers/accounting.controller.js:13202`, `:13239`, `:13310`, `:13353`, `:13377`, `:13394`, `:13416`
- **Exact issue:** migration 082 re-keyed `inventory_items` from `product_id` to `item_id`. These queries still use `product_id`.
- **Current behaviour:** **verified to throw at runtime** — `no such column: product_id`. Affected routes: `GET /api/accounting/inventory/items`, `GET /api/accounting/inventory/items/:productId`, `GET /api/accounting/inventory/movements`, `GET /api/accounting/inventory/valuation`.
- **Expected behaviour:** these routes either read `item_id`/`legacy_product_id`, or are removed as superseded by `InventoryEngine`.
- **Risk:** any UI or report hitting those four endpoints returns HTTP 500. Currently masked because `inventory_items` and `bills` are both empty, so no test exercises the path.
- **Recommended fix (NOT applied):** repoint to `item_id`, or retire these endpoints in favour of `GET /api/inventory/reports/valuation`.

## Problem 3 — Semantically wrong join to `inventory_items`

- **Severity: MEDIUM**
- **File / line:** `server/repositories/reporting.repository.js:1024`
- **Exact issue:** `LEFT JOIN inventory_items w ON w.id = b.warehouse_id` — `inventory_items.id` is a surrogate key of a stock item, and `bills.warehouse_id` is a free-text business field. They are unrelated.
- **Current behaviour:** the query resolves (0 rows, because `bills` is empty) but would return nulls for any warehouse-grouped bill report.
- **Expected behaviour:** either join on a real key or drop the join.
- **Risk:** silent empty output in the branch/warehouse report once bills exist.
- **Recommended fix (NOT applied):** use `stock_groups`/`godowns` for the warehouse dimension, or remove the join.

## Problem 4 — `is_inventory_managed` flag drift

- **Severity: MEDIUM**
- **Table:** `products.is_inventory_managed` (added in migration 080)
- **Exact issue:** all 3 products that own a stock item have the flag `= 0`, because the flag was introduced after those products were created and no backfill ran.
- **Current behaviour:** **no functional impact.** `BillInventoryBridge.resolveEntries()` calls `InventoryEngine.isInventoryManaged()`, which decides on `products.is_service` plus the existence of an active `stock_items` row — not on this flag.
- **Expected behaviour:** the flag should agree with reality, since the Products list query and Bill UI use it to decide whether to render inventory fields.
- **Risk:** the Bill UI may not show godown/batch/serial inputs for these products even though they are inventory-managed, producing a POST failure. **This needs browser verification.**
- **Recommended fix (NOT applied):** backfill `UPDATE products SET is_inventory_managed = 1 WHERE EXISTS (SELECT 1 FROM stock_items ...)`; or drop the flag and always derive it.

## Problem 5 — Dead code retained after consolidation

- **Severity: LOW**
- **Items:**
  - `server/repositories/inventory.repository.js:376` — `rebuildStockBalances()`, **0 callers**
  - `server/controllers/accounting.controller.js:13337` — `processInventoryMovement()`, **0 callers**
  - table `inventory_items_v2` — created by migration 080, never adopted, 0 rows
  - table `_payments_backup` — 0 rows, 0 code references
- **Current behaviour:** no functional impact; they inflate the schema and mislead readers about which engine is authoritative.
- **Risk:** a future developer re-activates the wrong engine and reintroduces the competing-systems problem.
- **Recommended fix (NOT applied):** delete the dead methods and the two orphan tables in a documented migration.

---

# Working Systems

Everything below is functioning and verified:

- **Ledger integrity** — single writer, immutable rows, source document + actor captured on every row.
- **Balance derivation** — `stock_balances` exactly reproducible from `stock_ledger`; scoped rebuild replaces the whole-company wipe.
- **Location consolidation** — 7 locations canonical, `inv_locations` retired, **no FK references it**.
- **Bill → inventory bridge** — draft/approve move no stock; post deducts exactly once with COGS in the same journal entry; cancel restores stock by appending inverses.
- **Idempotency** — application check + `uq_ivh_one_per_source_document` unique index.
- **Atomicity** — bill, journal, receivable and stock all commit or roll back together (SAVEPOINT-nested transactions).
- **Batch validation** — batch required and isolated for batch-tracked items; expiry enforced.
- **Serial validation** — availability, item match, godown match, count/quantity parity.
- **Valuation** — moving weighted average with a per-change audit trail in `valuation_movements`.
- **Report aggregation** — valuation/batch/expiry correctly sum across godowns and locations.
- **Opening stock** — voucher-mediated; no direct balance writes remain.
- **Product hierarchy** — 5 levels enforced by FK (Brand intentionally independent).
- **UOM** — one canonical table, RESTRICT-guarded from stock items and voucher lines.
- **Account fallbacks** — stock posts even when a stock item has no mapped inventory accounts.
- **Existing test suite** — 200 vitest assertions passing, 0 failures.
- **Repair verification suites** — 48 + 21 + 25 + 16 = **110 assertions passing** across acceptance, batch/serial, bill-UI and DB-guard.

---

# Regression Risks

Areas the recent repair could plausibly have affected, ranked by risk:

1. **Inventory location hierarchy UI** — reads the retired table (Problem 1). **Highest risk: expected to be visibly broken.**
2. **Stock-by-location report** — resolves location names via `inv_locations` (Problem 1).
3. **Accounting inventory endpoints** — throw on a removed column (Problem 2).
4. **Branch/warehouse bill report** — wrong join (Problem 3).
5. **Bill UI inventory fields** — depend on `is_inventory_managed` (Problem 4).
6. **Product creation with opening quantity** — behaviour changed from a direct balance write to a voucher; a failure mode (e.g. no godown) now throws where it previously silently inserted.
7. **`_buildAccountingLines` fallback accounts** — newly permissive; could post to an unintended account if a stock item lacks mappings.
8. **Legacy `invoices` path** — 88 references, unverified whether still reachable.

---

# Final Architecture Diagram

```
                    stock_groups ──< stock_categories ──< models ──> brands
                                     (Brand: independent master)      │
                                                                        ▼
┌──────────────────┐   product_id    ┌──────────────────┐   ┌────────────────────┐
│ products         │────────────────>│ stock_items      │──>│ units_of_measure   │
│ commercial       │<────────────────│ INVENTORY        │   │ (RESTRICT)         │
│ NO quantity      │                 │ uom, batch/serial│   └────────────────────┘
│ NO unit          │                 │ flags, cost,     │   ┌────────────────────┐
└──────────────────┘                 │ COGS/asset accts │──>│ locations (7) ★    │
                                     └────────┬─────────┘   └────────┬───────────┘
                                              │                      │ 1:N
                                              │               ┌──────▼───────┐
                                              │               │ godowns (2)  │
                                              │               └──────┬───────┘
                                              ▼                      │
   7 voucher types          ┌──────────────────────────────────────┴──────────┐
   (opening/inward/  ─────>  │ stock_ledger      ★ IMMUTABLE, SINGLE WRITER    │
    outward/transfer/         │  qty(godown, location, batch, serial)          │
    adjust/physical/          │  unit_rate, amount, source_document_*,         │
    journal)                  │  created_by                                    │
                             └───────────────────┬──────────────────────────┘
                                                 │ derived (never hand-written)
                                                 ▼
   ┌──────────────┐        ┌─────────────────────────────────────────────────┐
   │ bills        │───────>│ stock_balances      ★ DERIVED CACHE             │
   │ bill_items   │ POST   │  UNIQUE(company,item,batch,godown,location)     │
   │  +stock dims │        └─────────────────────────────────────────────────┘
   └──────┬───────┘                 │
          │ journal_entry_id       ▼
          │              ┌─────────────────────────────────────────────────┐
          │              │ inventory_items ★ VALUATION (moving WAC)        │
          │              │   item_id FK  +  valuation_movements (audit)    │
          │              └─────────────────────────────────────────────────┘
          ├──> receivables ──> receivable_allocations
          └──> journals ──> journal_entry_lines  (incl. COGS + inventory asset)
                     │
                     └── cancel ──> INVERSE ledger rows + reversal journal
                                     (originals preserved, never deleted)

   LEGACY (retained, 0 rows, no FK targets):
   uoms · inv_locations · batch_wise_stock · inventory_movements ·
   stock_adjustment_reasons · invoices · inventory_items_v2 · _payments_backup
```

---

# Recommended Next Steps

Ordered by severity, all **not yet applied**:

1. **HIGH — Repoint the 5 `inv_locations` code sites to `locations`** and remove the
   dual-write in `createLocation()`. Restore Location hierarchy, hierarchy summary
   and stock-by-location. (`inventory.repository.js:46,159-201,605,665`,
   `inventory.controller.js:219`, `products.controller.js:236,426`)
2. **HIGH — Fix or retire the 4 accounting inventory endpoints** that query the
   removed `inventory_items.product_id`. (`accounting.controller.js:13202-13416`)
3. **MEDIUM — Backfill `products.is_inventory_managed`** from the existence of an
   active `stock_items` row, or remove the flag and always derive it.
4. **MEDIUM — Correct the `inventory_items` → warehouse join** in
   `reporting.repository.js:1024`.
5. **LOW — Delete dead code** (`rebuildStockBalances`, `processInventoryMovement`) and
   orphan tables (`inventory_items_v2`, `_payments_backup`) via a documented migration.
6. **LOW — Review the `invoices` legacy path** (88 references) and decide retire-or-keep.
7. **Add a CI check** that fails if any non-migration source file references a table
   listed in `legacy_tables` with status RETIRED. This is the class of bug that
   produced Problem 1, and it is mechanically detectable.

---

*Audit produced by read-only inspection of the live SQLite database and the server
source. Machine-readable data: `docs/audits/audit-data-2026-10-06.json`.
Reproduce with `node scripts/architecture-audit.js`.*