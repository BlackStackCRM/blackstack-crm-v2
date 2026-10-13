# BLACKSTACK CRM V2 — Current Database Architecture Audit (Post-Fix Revision)

**Date:** 2026-10-06 (revision 2 — supersedes the pre-fix audit of the same date)
**Supersedes:** the "Problems Found" section of `current-database-architecture-audit-2026-10-06.md`
**Fix report:** `audit-fix-report-2026-10-06.md`
**Live database:** `D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2\data\blackstack-crm.db`

> Read-only audit. No architecture was modified while producing this document.

---

# Executive Summary

The architecture is now **internally consistent with zero outstanding findings**.

`scripts/architecture-audit.js` — which previously reported 1 automated finding and
2 manually-confirmed HIGH issues — now reports:

```
--- FINDINGS ---
  none
```

| | Pre-fix | Post-fix |
|---|---|---|
| `PRAGMA integrity_check` | ok | **ok** |
| `PRAGMA foreign_key_check` | 0 | **0** |
| ledger ↔ balances mismatch | 0 | **0** |
| orphan balances | 0 | **0** |
| products flagged `is_inventory_managed` | 0 / 3 | **3 / 3** |
| `locations` (canonical) | 7 | **7** |
| `inv_locations` (retired) | 0 | **0** |
| active `inv_locations` code refs | 5 | **0** |
| active `inventory_items.product_id` refs | 7 | **0** |
| `inventory_items.item_id` FK | **absent** | **present** |
| browser HTTP 500 | 2 | **0** |

---

# Database Overview

| Property | Value |
|---|---|
| File | `data/blackstack-crm.db`, 2.74 MB |
| SQLite | 3.53.4, WAL, FK enforcement on |
| Tables / Indexes / Triggers / Views | 141 (+`audit_fix_log`) / 271 / 0 / 0 |
| Foreign keys | 234, **0 violations** |
| Migrations | max version **83**; Step 084 applied programmatically |
| `stock_ledger` ↔ `stock_balances` | 2 = 2, 0 mismatches, 0 orphans |

---

# Current Architecture Diagram

```
                    stock_groups ──< stock_categories ──< models ──> brands
                                     (Brand: independent master)      │
                                                                        ▼
┌──────────────────┐   product_id    ┌──────────────────┐   ┌────────────────────┐
│ products         │────────────────>│ stock_items      │──>│ units_of_measure   │
│ commercial       │<────────────────│ INVENTORY        │   │ (RESTRICT)         │
│ is_inventory_    │                 │ uom, batch/serial│   └────────────────────┘
│   managed = 1    │                 │ flags, cost,     │   ┌────────────────────┐
└──────────────────┘                 │ COGS/asset accts │──>│ locations (7) ★    │
                                     └────────┬─────────┘   └────────┬───────────┘
                                              │                      │ 1:N
                                              │               ┌──────▼───────┐
   7 voucher types          ┌───────────────────┴──────────────┴──────────┐
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
          │              │   item_id FK→stock_items ON DELETE CASCADE ★    │
          │              │   legacy_product_id (compat)  → valuation_movements
          │              └─────────────────────────────────────────────────┘
          ├──> receivables ──> receivable_allocations
          └──> journals ──> journal_entry_lines  (incl. COGS + inventory asset)
                     │
                     └── cancel ──> INVERSE ledger rows + reversal journal
                                     (originals preserved, never deleted)

   LEGACY (retained, 0 rows, no FK targets, recorded in legacy_tables):
   uoms · inv_locations · batch_wise_stock · inventory_movements ·
   stock_adjustment_reasons · invoices · inventory_items_v2 · _payments_backup
```

---

# Table Inventory

Unchanged from the pre-fix audit: **141 tables** across CRM/Contacts (4), CRM/Pipeline (6),
CRM/Tasks & Workflow (7), Inventory/Product Master (13), Inventory/Units & Pricing (7),
Inventory/Locations (3), Inventory/Tracking (3), Inventory/Transactions (7),
Inventory/Balances & Valuation (4), Billing/Bills (8), Billing/Payments (5),
Billing/Collections (14), Billing/Legacy (2), Accounting/Core (7),
Accounting/Receivables & Payables (7), Accounting/Vouchers (4), Accounting/Tax (7),
Accounting/Banking & Budget (12), System (15), Ungrouped (6).
**New:** `audit_fix_log` (migration 083).

---

# Foreign Key Audit

**234 foreign keys. `PRAGMA foreign_key_check` → 0 violations.**

Post-fix change:

| From | Column | → Target | ON DELETE |
|---|---|---|---|
| `inventory_items` | `item_id` | **`stock_items.id`** ★ restored | **CASCADE** |

This constraint was declared in migration 082's `CREATE TABLE` but never materialised,
because that rebuild runs under `PRAGMA foreign_keys = OFF`. Step 084 rebuilds it with
enforcement on. No FK references `inv_locations`.

---

# Duplicate / Legacy Systems

| Role | System A | System B | Status |
|---|---|---|---|
| Location master | `locations` (7) | `inv_locations` (0) | ✅ **A only — 0 production references to B** |
| UOM | `units_of_measure` (1) | `uoms` (0) | ✅ A only |
| Movement history | `stock_ledger` (2) | `inventory_movements` (0) | ✅ A only |
| Inventory balance | `stock_balances` (2) | `inventory_items` (0) | ✅ not duplicates — different roles |
| Batch balance | `stock_balances` + `batches` | `batch_wise_stock` (0) | ✅ A only |
| Adjustment reason | `adjustment_reasons` | `stock_adjustment_reasons` (0) | ✅ A only |
| Sales document | `bills` (0) | `invoices` (0) | ⚠️ 88 code refs, unreviewed |

`legacy_tables` registry (all retained, none dropped):

| Table | Status | Canonical replacement |
|---|---|---|
| `uoms` | LEGACY | `units_of_measure` |
| `batch_wise_stock` | LEGACY | `stock_balances` |
| `inventory_movements` | LEGACY | `stock_ledger` |
| `stock_adjustment_reasons` | LEGACY | `adjustment_reasons` |
| `inv_locations` | RETIRED (7 rows) | `locations` |

---

# Inventory Architecture

Commercial identity = `products`. Physical inventory identity = `stock_items`.
`products` carries no quantity and no unit FK; all physical attributes live on `stock_items`.
Bridge: `stock_items.product_id → products.id`. **3 / 3 products linked.**

`products.is_inventory_managed` is now an accurate mirror of "has an active stock item"
(**3 / 3 agree**, verified with a set-difference query returning 0 mismatches).

### Hierarchy verification

| Relationship | Resolved |
|---|---|
| Product → Model / Brand / Stock Category / Stock Group | 3 / 3 each |
| Model → Brand / Stock Category | 2 / 2 each |
| Stock Category → Stock Group (RESTRICT) | 2 / 2 |
| Brand → Stock Category | **No FK — by design** (migration 078b; Brand is an independent master) |

---

# Stock Ledger Architecture

**Authoritative transaction history. Exactly ONE writer:**

```
server/services/inventory-engine.service.js:178   INSERT INTO stock_ledger
```

via `InventoryEngine.postLedgerMovement()`, reached from `bill-inventory-bridge.service.js`
:296 (bill out), :376 (bill reversal), :462 (sales return) and `inventory.service.js:490`
(all manual vouchers).

Ledger rows carry `source_document_type`, `source_document_id`, `created_by`.

---

# Stock Balance Architecture

**Derived.** Verified by independent recomputation: **0 mismatches, 0 orphans,
ledger qty 2 = balance qty 2, 0 negative balances.**

**Writers — 4 statements, all inside rebuild functions:**

```
inventory.repository.js:343   DELETE FROM stock_balances   (legacy, 0 callers)
inventory.repository.js:363   INSERT INTO stock_balances   (legacy, 0 callers)
inventory-engine.service.js:201  DELETE FROM stock_balances  (scoped by item)
inventory-engine.service.js:216  INSERT INTO stock_balances  (scoped by item)
```

**No `UPDATE stock_balances` anywhere. No direct quantity mutation.**

---

# Opening Stock Flow

```
Product form -> products.controller.js:_postOpeningStockVoucher()
   -> opening_stock voucher -> stock_ledger -> stock_balances
```

No code path writes `stock_balances` without a ledger entry.

---

# Customer Bill → Inventory Flow

**Verified live in a visible browser:** `stock 100 → 99 → 100`.

```
bill POSTED   → stock_outward voucher (source_document_type='CUSTOMER_BILL')
               → stock_ledger -10 → stock_balances 99
               → COGS + inventory asset in the SAME journal entry
               → receivables
bill CANCELLED→ inverse +10 ledger row (originals preserved)
               → reversal voucher header + reversal journal
```

Idempotency: application check **plus** the `uq_ivh_one_per_source_document` unique index.

---

# Batch / Serial / Location / Godown / UOM Architecture

Unchanged and verified:

- **Batch:** batch required and isolated for batch-tracked items; expiry enforced. 0 batch-tracked items in live data.
- **Serial:** `CHECK(status IN ('in_transit','available','sold','returned','damaged','scrapped','expired'))`; availability, item match, godown match and count/quantity parity all enforced. 2 serials, both `available`, 0 invalid.
- **Location/Godown:** `locations` (7) → `godowns` (2) → stock rows. 0 godown/location disagreements.
- **UOM:** `units_of_measure` canonical, RESTRICT-guarded.

---

# Valuation Architecture

**Single authority: `InventoryEngine.applyValuation()` → `inventory_items` + `valuation_movements`.**

`inventory_items` is now FK-constrained to `stock_items.id`. The competing
`AccountingController.processInventoryMovement()` has been **removed** (zero callers,
no route binding), and the wrong-key `reporting.repository.js` join now resolves via
`godowns`/`locations`.

---

# Accounting Integration

```
Stock Inward   → Dr Inventory Asset / Cr Purchase
Stock Outward  → Dr COGS / Cr Inventory Asset
Customer Bill  → Dr Receivable / Cr Sales / Cr Tax  +  Dr COGS / Cr Inventory Asset
Cancellation   → reversal journal + inverse ledger rows
```

All four accounting inventory endpoints return **HTTP 200** (were 500).

---

# Reporting Architecture

All six inventory reports plus the product on-hand list read the canonical
`stock_balances`, aggregated per item. **No report reads a legacy/dead table.**

---

# Code/Database Consistency

| Check | Result |
|---|---|
| Active `inv_locations` references | **0** (comments only) |
| Active `inventory_items.product_id` queries | **0** (one explanatory comment) |
| Direct `stock_balances` quantity writers | **0** |
| Competing stock engines | **0** |
| Dead valuation writers | **0** (`processInventoryMovement` removed) |
| Orphan tables | `inventory_items_v2`, `_payments_backup` (pre-existing, retained) |

---

# Integrity Results

| Check | Result |
|---|---|
| `PRAGMA integrity_check` | **ok** |
| `PRAGMA foreign_key_check` | **0** |
| ledger ↔ balances | **0** mismatches, **0** orphans |
| Negative stock | 0 |
| Invalid serial states | 0 |
| Duplicate SKU / batch / serial | 0 / 0 / 0 |
| Godown-location disagreement | 0 |
| Products flagged vs reality | **0 mismatches** |
| `audit_fix_log` | migration 83 recorded |

**`scripts/architecture-audit.js` reports zero findings.**

---

# Problems Found

**None outstanding from the audit scope.**

| Severity | Status |
|---|---|
| ~~HIGH — `inv_locations` read by 5 production sites~~ | ✅ **FIXED** (0 refs; hierarchy returns 7) |
| ~~HIGH — `inventory_items.product_id` → HTTP 500~~ | ✅ **FIXED** (200; 0 refs; dead method removed) |
| ~~MEDIUM — wrong `inventory_items` → `warehouse_id` join~~ | ✅ **FIXED** (resolves via godowns/locations) |
| ~~MEDIUM — `is_inventory_managed = 0` on stock-owning products~~ | ✅ **FIXED** (3/3, migration 083) |
| ~~HIGH — `inventory_items.item_id` FK absent~~ | ✅ **FIXED** (Step 084) |
| ~~HIGH — Bill UI read snake_case from camelCase API~~ | ✅ **FIXED** (inventory inputs render) |

---

# Working Systems

- **Ledger integrity** — single writer, immutable rows, source document + actor on every row
- **Balance derivation** — exactly reproducible, scoped rebuild
- **Location consolidation** — 7 canonical, retired table has 0 production references
- **Bill → inventory bridge** — proven in a visible browser (100 → 99 → 100)
- **Idempotency** — application check + unique index
- **Atomicity** — bill, journal, receivable, stock commit together
- **Batch / serial validation** — batch required and isolated; expiry enforced; serial availability enforced
- **Valuation** — one weighted-average engine, FK-constrained, with a full audit trail
- **Report aggregation** — correct across godowns and locations
- **Test suites** — acceptance 48/48, batch-serial 21/21, bill-UI 25/25, DB-guard 16/16, vitest 203/206 (3 pre-existing Electron path failures)
- **Browser regression** — 50 PASS / 0 FAIL, 0 HTTP 500, 0 JS exceptions, live DB untouched

---

# Regression Risks

1. **Batch and serial bill paths are code-verified but not browser-verified** — no suitable multi-unit tracked item exists in the live data.
2. **`invoices` legacy path** — 88 references, unreviewed.
3. **`tests/electron-safety.test.js`** — 3 pre-existing failures; expects the module at `launcher/modules/db-migration.js` but it lives at `electron/db-migration.js`.
4. **`tests/inventory.e2e.test.js`** asserts `>= 25` inventory cards; the dashboard renders 24. Stale expectation.
5. **No CI guard** prevents a future edit from reintroducing a reference to a RETIRED table.

---

# Recommended Next Steps

1. Add a CI check failing if any non-migration source file references a table in `legacy_tables` with status RETIRED — the exact bug class behind the HIGH #1 finding.
2. Update the stale `>= 25` card assertion to read the dashboard's own `SECTIONS` config.
3. Decide where the Electron DB-migration module belongs and realign the test fixture.
4. Review the `invoices` legacy path (88 references, 0 rows).
5. Retire `inventory_items_v2` and `_payments_backup` via a documented migration.
6. Seed a multi-unit batch-tracked and serial-tracked item so those browser paths can be exercised.

---

*Produced by read-only inspection of the live SQLite database and the server source.
Reproduce with `node scripts/architecture-audit.js` (currently reports: none).
Raw data: `docs/audits/audit-data-2026-10-06.json`.*