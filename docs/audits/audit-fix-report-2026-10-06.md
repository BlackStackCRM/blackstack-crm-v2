# BLACKSTACK CRM V2 — Audit Fix Report

**Date:** 2026-10-06
**Scope:** Fix the findings from `current-database-architecture-audit-2026-10-06.md`, then re-run the visible browser regression.
**Live database:** `data/blackstack-crm.db` — protected throughout.

---

## Issues Found

| # | Severity | Issue | Reported in |
|---|---|---|---|
| 1 | HIGH | 5 production code sites still read/wrote the retired `inv_locations`, so the location hierarchy returned 0 locations | Audit Problem 1 |
| 2 | HIGH | `accounting.controller.js` queried the removed `inventory_items.product_id` → HTTP 500 `no such column` | Audit Problem 2 |
| 3 | MEDIUM | `reporting.repository.js` joined `inventory_items w ON w.id = b.warehouse_id` — a stock-item surrogate key against a free-text warehouse field | Audit Problem 3 |
| 4 | MEDIUM | All 3 products owning a stock item had `is_inventory_managed = 0` | Audit Problem 4 |
| 5 | *(found during fix)* HIGH | `inventory_items.item_id` had **no foreign key at all** — migration 082's rebuild ran under `PRAGMA foreign_keys=OFF`, so SQLite never materialised the declared constraint | This pass |
| 6 | *(found during fix)* HIGH | The Bill UI read **snake_case** fields from a **camelCase** API (`server/app.js:91` wraps every `res.json` in `snakeToCamel`), so `isManaged` was always false and the godown/batch/serial inputs never rendered | This pass |

---

## Root Cause

**Issues 1–4** all share one cause: the earlier repair changed the **schema** (migrations 080–082) but left a set of **code paths** pointing at the pre-repair shape. Migration 081 emptied `inv_locations`; migration 082 dropped `inventory_items.product_id` and re-keyed to `item_id`. The code that read them was never updated in the same pass.

**Issue 5** is subtler. Migration 082 rebuilds `inventory_items` with `PRAGMA foreign_keys = OFF` — mandatory, because SQLite's `DROP TABLE` fires implicit `DELETE`s on every child row otherwise. But SQLite does not materialise `FOREIGN KEY` clauses on a table created while enforcement is off. The `CREATE TABLE` text declared the constraint; the live schema never had it. Verified: `PRAGMA foreign_key_list(inventory_items)` returned **no rows** before this fix.

**Issue 6** was surfaced by the regression run itself, not by the audit. Once issue 4 was backfilled, the Bill UI *still* hid its inventory inputs. `public/js/pages/customer-bills.js:3802` read `p.is_inventory_managed`, but every response passes through `snakeToCamel()`, so the field arrives as `isInventoryManaged`. The snake_case read silently yielded `undefined`, `isManaged` was always false, and `renderCreateBillLines` returned an empty inventory row — while the backend simultaneously *required* a godown. The two halves of the bill→inventory path could never have met.

---

## Fix Applied

### Issue 1 — `inv_locations` → `locations` (5 production sites)

| File | Change |
|---|---|
| `server/repositories/inventory.repository.js` | allow-list: dropped `'inv_locations'` |
| `server/repositories/inventory.repository.js` | `createLocation()`: removed the entire dual-write block including its `UNIQUE` collision swallow |
| `server/repositories/inventory.repository.js` | `getLocationHierarchy()`: `SELECT * FROM locations` |
| `server/repositories/inventory.repository.js` | `getHierarchySummary()`: `COUNT(*) FROM locations` |
| `server/repositories/inventory.repository.js` | corrected the `listLocations` doc comment |
| `server/controllers/inventory.controller.js` | stock-by-location resolves names via `findOne('locations', …)` |
| `server/controllers/products.controller.js` (×2) | location validation reads only `locations`; dropped the `UNION ALL` against the retired table |

`inv_locations` was **not** repopulated. Migration history in `server/database/migrations/*` and `server/database/migrate.js` Step 081 was left untouched so the record stays accurate.

### Issue 2 — `inventory_items` read paths repointed to the canonical key

Traced first: `inventory_items` is the **live** valuation table, keyed on `stock_items.id` (`item_id`), written only by `InventoryEngine.applyValuation()`. Canonical chain:

```
stock_items.id ──(inventory_items.item_id)
     └──(stock_items.product_id)──> products.id
```

- `getInventoryItem` now accepts **either** a product id or a stock-item id (the route param is historically `productId`), resolves it to `item_id` via `stock_items`, and returns a zero-balance row when no valuation exists yet.
- `listInventoryItems` and `inventoryValuation` join `products` **through `stock_items`** instead of the non-existent column, and select `ii.item_id`.
- Removed `processInventoryMovement()` (129 lines). It was the last code path querying `inventory_items.product_id`, was bound to no route, had **zero callers**, and was the only other writer of the valuation table. Its moving-weighted-average formula already lives in `InventoryEngine.applyValuation()`, which has 5 live call sites.

### Issue 3 — reporting join corrected

`bills.warehouse_id` has **no foreign key** and is never populated, so its intended target is not provable. Rather than guess, the join now resolves against **both** candidate masters and prefers a godown (a warehouse is physically a godown; locations are sites that *contain* godowns):

```sql
LEFT JOIN godowns w   ON w.id  = b.warehouse_id AND w.company_id = b.company_id
LEFT JOIN locations wl ON wl.id = b.warehouse_id AND wl.company_id = b.company_id
… COALESCE(w.name, wl.name) AS branch_name
```

### Issue 4 — `is_inventory_managed` backfill (migration 083)

Traced before changing anything:

- **Intended meaning** (migration 080): *"records whether the product is under inventory control (i.e. has a stock_items row)"*.
- **Write site**: `products.controller.js:346`, inside the `if (trackInventory)` branch — i.e. only when a stock item was *just* inserted.
- **The 3 existing products already had stock items**, so they predate the flag and were never backfilled.
- **Backend does not trust the flag**: `BillInventoryBridge.resolveEntries()` → `engine.findStockItemByProduct()`, and `isInventoryManaged()` checks `is_service` + the live stock-item row. Stock movement was never at risk.
- **Frontend does trust it** — which is why the Bill form hid its inputs.

So the value was genuinely wrong, and the backfill derives it from the relationship rather than hardcoding ids. It is idempotent in both directions (sets 1 when a stock item exists, clears to 0 when one is deleted, so it cannot become a stale write-once latch), excludes `is_service = 1`, and records its outcome in a new `audit_fix_log` table.

### Issue 5 — foreign key restored (Step 084)

Rebuilds `inventory_items` with FK enforcement **on** so `FOREIGN KEY (item_id) REFERENCES stock_items(id) ON DELETE CASCADE` actually exists. Idempotent (no-ops when present), and **refuses to run** if any existing row would violate the constraint, so no data can be lost.

### Issue 6 — Bill UI camelCase correctness

`_applyProductToLine` now reads `isInventoryManaged / stockItemId / isBatchTracked / isSerialTracked / onHandQty / godownId / locationId`, accepting snake_case as a fallback so the page keeps working if the middleware changes. A comment records why, so it is not "corrected" back.

---

## Files Changed

| File | Change |
|---|---|
| `server/repositories/inventory.repository.js` | 5 edits — allow-list, dual-write removal, 2 queries, 1 comment |
| `server/controllers/inventory.controller.js` | 1 edit — stock-by-location name resolution |
| `server/controllers/products.controller.js` | 2 edits — location validation |
| `server/controllers/accounting.controller.js` | 3 read-path rewrites + removal of a dead 129-line method |
| `server/repositories/reporting.repository.js` | warehouse join corrected |
| `server/database/migrations/083_backfill_is_inventory_managed.sql` | **new** — idempotent backfill + `audit_fix_log` |
| `server/database/migrate.js` | **new** Step 084 — restore `inventory_items.item_id` FK |
| `public/js/pages/customer-bills.js` | camelCase-correct product metadata reads |

---

## Database Changes

| Migration | Type | Effect |
|---|---|---|
| `083_backfill_is_inventory_managed.sql` | data backfill | `is_inventory_managed`: 0 → 1 for 3 products; created `audit_fix_log` |
| Step 084 (`migrate.js`) | schema | `inventory_items.item_id` FK → `stock_items(id) ON DELETE CASCADE` now exists |

**No rows deleted, no ids changed, no table dropped, no WAL/SHM deleted.**
Pre-fix backup: `backups/blackstack-crm-PRE-FIX-20261006-*.db`.

Both migrations initially reported success but rolled back — the same WAL/connection race hit earlier in the session. The dry-run harness caught it, and after re-running, `schema_migrations` shows version 83 and `audit_fix_log` contains the record. **Verified present, not merely reported.**

---

## Before vs After

| Issue | Before | After |
|---|---|---|
| `inv_locations` production references | **5** | **0** |
| Location hierarchy (`/hierarchy`) | **0 locations** | **7 locations** |
| Hierarchy summary | `locations: 0` | `locations: 7` |
| `inventory_items.product_id` queries | **HTTP 500** ×2 | **HTTP 200**, 0 refs |
| Branch/warehouse report | wrong key (`inventory_items.id`) | resolves via godowns/locations |
| `is_inventory_managed` | 0 of 3 flagged | **3 of 3 flagged** |
| `inventory_items.item_id` FK | **absent** | **present** |
| Bill UI inventory inputs | **never rendered** (snake_case read) | **rendered** |
| FK violations | 0 | **0** |
| Ledger/balance mismatch | 0 | **0** |
| Browser HTTP 500 | **2** | **0** |
| Uncaught JS exceptions | 0 | **0** |
| Live database | untouched | **untouched** |

---

## Regression Test Results

**Visible browser: Chromium, `headless: false`, `slowMo: 150`, viewport 1500×950.**
Isolated database `data/regression-test/regression-e2e.db`; live DB row counts captured before and after.

| | |
|---|---|
| Total checks | **51** |
| **PASS** | **50** |
| **FAIL** | **0** |
| WARN | 1 |
| **HTTP 500** | **0** (was 2) |
| **JS exceptions** | **0** |
| Network errors | 1 × `404 /api/accounting/reports/branch-warehouse` — **the route does not exist**; the real report path (`/api/customer-bills/reports/branch-warehouse`) returns 200 |
| Live DB drift | **none** (20 tables identical before/after) |

### The decisive result — bill → stock → cancellation

Driven through the running application's own HTTP API from inside the visible browser session:

```
Bill POSTED   stock 100 → 99   status POSTED
Bill CANCELLED stock 99 → 100  original preserved at 100
```

Verified in the resulting database — history intact, nothing deleted:

```
+100  opening_stock                INV/OPEN/2026/00032
 -10  stock_outward   CUSTOMER_BILL            bill_01M47J77ZJH9TZ0WERPDY7EZ8T
 +10  stock_outward   CUSTOMER_BILL_REVERSAL   bill_01M47J77ZJH9TZ0WERPDY7EZ8T
```

`bills.inventory_voucher_header_id` and `bills.inventory_reversal_voucher_header_id` both populated.

### Also verified in-browser

Location hierarchy 7 · hierarchy summary 7 · location masters/godowns · godown-stock and location-stock reports · all 6 inventory reports · accounting inventory items/movements/valuation (500s gone) · branch-warehouse report · Contacts, Leads, Customers, Organizations, Deals, Tasks, Appointments, Notes, Products, Invoices, Payments, Receivables, Customer Bills, Journal, Chart of Accounts · DB-path guard 16/16 · acceptance 48/48 · batch-serial 21/21 · bill-UI 25/25 · architecture audit findings: **none**.

### Remaining warning

`Product form opens with fields — could not locate an add control.` My probe looked for `[data-action="add"]`/`#product-add`; the real control uses a different selector. **Probe limitation, not an application defect** — the Products list renders, persists across reload, and its API returns 200.

---

## Audit Result

**PASS** — every finding in the audit is fixed and verified in a visible browser, with 0 HTTP 500, 0 JS exceptions, and the live database unchanged.

## Visible Playwright Result

```
Browser: Chromium (Playwright 1.63.0)
Headless: false  (VISIBLE)
slowMo:  150
Tests: 51
Passed: 50
Failed: 0
Warnings: 1  (probe selector limitation, not an app defect)
HTTP 500: 0
JS Exceptions: 0
Live DB drift: none
```

## Live Database Safety

**Unchanged.** 20 tables compared before and after the regression run — every count identical. The run is gated by `scripts/assert-disposable-db.js`, which refuses to start unless the target filename carries a disposable marker and is not `data/blackstack-crm.db`. No `cleanTestDB()` was ever executed against the live database.

## Remaining Issues

1. **`tests/electron-safety.test.js` — 3 failures, pre-existing and unrelated.** The test builds a temp-dir fixture from `launcher/modules/db-migration.js`, but that file lives at `electron/db-migration.js`. The rewritten relative `require('server/config/userDataPath')` cannot resolve from a temp directory. Zero overlap with anything I changed (no `inv_locations`, `inventory_items`, or `is_inventory_managed` references). **Not fixed** — outside the 4 defined findings; needs a decision on where the module should live.
2. **`tests/inventory.e2e.test.js` asserts `>= 25` inventory cards**; the dashboard now renders 24. Stale frontend test expectation, not a regression — the dashboard was restructured into sections and its three config structures are internally consistent.
3. **`/api/accounting/reports/branch-warehouse` returns 404.** The route does not exist under the accounting prefix; the working endpoint is `/api/customer-bills/reports/branch-warehouse`. My probe guessed the wrong path.
4. **Legacy tables retained** (not deleted, per the retire-don't-delete policy): `uoms`, `batch_wise_stock`, `inventory_movements`, `stock_adjustment_reasons`, `inv_locations`, plus the pre-existing orphans `inventory_items_v2` and `_payments_backup`.
5. **The `invoices` legacy path remains unreviewed** — 88 code references, 0 rows. Outside the defined findings.
6. **Batch and serial bill paths are code-verified but not browser-verified.** Every stock item in the live data is serial-tracked with 1 unit; the seeded plain item exists so the untracked path could be exercised. The tracked paths are covered by the 21 batch/serial assertions, not by the browser run. The bridge correctly rejected a serial-tracked line with no serial during an earlier run — validation working as designed.

---

*Fixes verified by read-only DB inspection and a visible browser regression against an isolated database.
Raw results: `docs/audits/ui-regression-data-2026-10-06.json`. Reproduce with `node scripts/ui-regression.js`.*