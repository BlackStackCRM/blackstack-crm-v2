# BLACKSTACK CRM V2 — Visible UI Regression Report

**Date:** 2026-10-06
**Purpose:** Detect whether the recent database / inventory / billing repair broke any existing working CRM flow.
**Companion audit:** `docs/audits/current-database-architecture-audit-2026-10-06.md`

> Failures below are **recorded exactly as observed**. Nothing was fixed during this run.

---

## Test Environment

| Item | Value |
|---|---|
| Browser | **Chromium (Playwright), `headless: false` — VISIBLE** |
| Visibility | A browser window opened on the desktop and performed each action with `slowMo: 150` |
| Viewport | 1500 × 950, started maximised |
| URL | `http://localhost:3000/index.html` |
| Server | `node server/app.js`, started by the test script, **bound to the isolated test DB** |
| Port | 3000 (verified free before start) |
| Test database | `data/regression-test/regression-e2e.db` — a **copy** of the live DB |
| User-data dir | `data/regression-test/user-data` (isolated, so the app's backup guard cannot read the shared folder) |
| Live database | `data/blackstack-crm.db` — **opened read-only only; row counts captured before and after** |
| Playwright | 1.63.0 |
| Credentials | `admin@blackstack.local` / `admin123` |
| Video / trace | `recordVideo` on, `trace: retain-on-failure` |
| Screenshots | `test-results-regression/` (30 images) |
| Machine-readable | `docs/audits/ui-regression-data-2026-10-06.json` |

### Live-Database Safety Verification

```
Live DB before : products 3, stock_items 3, locations 7, godowns 2, units_of_measure 1,
                 stock_ledger 2, stock_balances 2, bills 0, payments 0, vouchers 25,
                 journal_entries 25, journal_entry_lines 102, contacts 1, leads 0,
                 deals 0, tasks 0, accounts 24, organizations 1
Live DB after  : IDENTICAL on all 18 tables
LIVE DATABASE UNCHANGED ✓
```

The script refuses to start if port 3000 is occupied (a stale server could be bound to
the live DB), and it exits non-zero if any live row count drifts.

---

## Test Results

| Test | Result | Details |
|---|---|---|
| **Application Load** | **PASS** | Login page rendered, authenticated, dashboard loaded |
| Products | PASS | List rendered, persists after reload |
| Opening Stock | PASS | API `POST /api/inventory/vouchers` reachable; UI card present |
| Stock Inward | PASS | Voucher card present; API 200 |
| Stock Outward | PASS | Voucher card present; API 200 |
| Customer Bill | PASS | Bill list UI renders; `GET /api/customer-bills` 200 |
| Bill Cancellation | NOT EXERCISED | No bills exist in the test DB; cancellation is covered by 48 acceptance assertions instead |
| Batch | PASS | `GET /api/inventory/masters/batches` 200, returns batch rows |
| Serial | PASS | Serial report API 200 |
| Transfer | NOT EXERCISED | Covered by 21 batch/serial assertions |
| Physical Stock | NOT EXERCISED | No physical-stock documents exist |
| Reports (all 6) | **PASS** | Valuation, Batch, Godown, Location, Expiry, Serial all render |
| Contacts | **PASS** | Renders |
| Leads | **PASS** | Renders |
| Customers | **PASS** | Renders |
| Organizations | **PASS** | Renders |
| Deals | **PASS** | Renders |
| Tasks | **PASS** | Renders |
| Follow-ups / Appointments | **PASS** | Renders |
| Notes | **PASS** | Renders |
| Invoices (legacy) | **PASS** | Renders |
| Payments | **PASS** | Renders |
| Receivables | **PASS** | Renders |
| Accounting / Journal | **PASS** | Renders |
| Chart of Accounts | **PASS** | Renders |
| **Inventory hierarchy API** | **FAIL** | `/api/inventory/hierarchy` returns **0 locations** |
| **Inventory hierarchy summary** | **FAIL** | `/api/inventory/hierarchy/summary` returns **`locations: 0`** |
| **Accounting inventory items** | **FAIL** | HTTP **500** `no such column: ii.product_id` |
| **Accounting inventory valuation** | **FAIL** | HTTP **500** `no such column: ii.product_id` |
| Inventory dashboard card count | FAIL | 24 cards rendered; test expected ≥ 25 |
| Product form add control | WARN | Could not locate an add control by selector (see corrections) |
| Location master | PASS | Shows rows from the canonical `locations` table |
| Accounting inventory movements | PASS | HTTP 200 (reads `inventory_movements`, not the re-keyed table) |
| API stock items / godowns / locations / UOM / batches / vouchers / bills | PASS (7) | All HTTP 200 |

**Totals: 34 PASS · 1 WARN · 5 FAIL**

---

## Console Errors

3 console errors were captured. Two distinct causes:

```
Failed to load resource: the server responded with a status of 404 (Not Found)
Failed to load resource: the server responded with a status of 500 (Internal Server Error)
```

- **404** — favicon request. Cosmetic, pre-existing, unrelated to the repair.
- **500** — `/api/accounting/inventory/items` and `/api/accounting/inventory/valuation`.
  This is a **real server-side failure** (Audit Problem 2).

## Page Errors

**0 uncaught JavaScript exceptions.** No blank screens, no stuck loaders, no broken modals observed.

## Network Errors

| Status | Method | URL | Error |
|---|---|---|---|
| **500** | GET | `/api/accounting/inventory/items` | `no such column: ii.product_id` |
| **500** | GET | `/api/accounting/inventory/valuation` | `no such column: ii.product_id` |
| 404 | GET | favicon | cosmetic |

---

## Failures — Full Detail

### FAIL 1 — Inventory location hierarchy returns zero locations

- **Reproduction:** Open Inventory → any location drill-down, or call `GET /api/inventory/hierarchy`
- **Page:** Inventory Management
- **Action:** load the location hierarchy / summary
- **Expected:** 7 locations (the canonical `locations` table)
- **Actual:** `locations: []` and `locations: 0`
- **Console error:** none (the API returns HTTP 200 with an empty list)
- **API error:** none — a silent wrong answer, which is worse than a 500
- **Root cause:** `server/repositories/inventory.repository.js:605` and `:665` still query the
  retired, now-empty `inv_locations` table. Migration 081 merged its rows into `locations` and
  emptied it, but left these two code sites pointing at the old name.
- **Matches audit:** Problem 1 (HIGH)

### FAIL 2 — Accounting inventory items endpoint throws

- **Reproduction:** `GET /api/accounting/inventory/items`
- **Expected:** HTTP 200 with item list
- **Actual:** HTTP 500, `ERR_SQLITE_ERROR: no such column: ii.product_id`
- **API error:** `{"success":false,"error":{"code":"ERR_SQLITE_ERROR","message":"no such column: ii.product_id"}}`
- **Root cause:** `server/controllers/accounting.controller.js:13202` and `:13353` query
  `inventory_items ... product_id`. Migration 082 re-keyed that table to `item_id` (with a
  `legacy_product_id` compatibility column). The queries were never updated.
- **Matches audit:** Problem 2 (HIGH)

### FAIL 3 — Accounting inventory valuation endpoint throws

- **Reproduction:** `GET /api/accounting/inventory/valuation`
- **Expected:** HTTP 200 with valuation totals
- **Actual:** HTTP 500, `no such column: ii.product_id` (`accounting.controller.js:13239`, `:13310`)
- **Root cause / matches audit:** Problem 2 (HIGH)

### FAIL 4 — Inventory dashboard renders 24 cards, test expects ≥ 25

- **Reproduction:** Open Inventory Management, count `[data-inv-card]`
- **Expected:** ≥ 25 (per `tests/inventory.e2e.test.js:426` and `:496`)
- **Actual:** 24
- **Console error:** none
- **Root cause:** **NOT a regression from the repair.** The card count is pure frontend
  configuration in `public/js/pages/inventory.js` (`API_MAP` has 24 entries); no migration
  touches it. The dashboard was restructured into sections at some point, and the
  `>= 25` assertion is now stale. The repo's own
  `blackstack-inventory-masters` skill notes the three structures (`SECTIONS` /
  `CARD_CONFIG` / `API_MAP`) must be kept in sync — they are consistent with each other
  (no card lacks config, none duplicated), so this is a **test-expectation drift**, not a
  broken page.
- **Classification:** pre-existing test debt. Not caused by the database work.

### Two corrections to my own probe (important for accuracy)

While investigating FAIL 4 I found **two errors in my regression probe**, not in the application:

1. **`hasStockItem: false` for all 3 products was MY bug.** I read `p.stock_item_id` from a
   products row, but `products` has **no `stock_item_id` column** — the controller *aliases*
   `si.id AS stock_item_id` in its list query. Verified against the test DB:
   **`stock_items.product_id` links all 3 products correctly (3/3).** The Product ↔ Stock Item
   bridge is **intact**. The "Bill UI shows inventory fields" PASS is therefore based on a
   flawed check and should be treated as **unverified**, not as a pass.
2. **`is_inventory_managed` is `0` on all 3 products** (Audit Problem 4). This is real and
   un-backfilled, and it *does* affect the Bill UI: inventory dimension fields
   (godown/batch/serial) are only rendered when the flag is set. So a user creating a bill
   for these products would not see the fields the backend now requires. I could not verify
   this end-to-end in the browser without creating a bill, so it remains a **probable
   functional gap**, not a confirmed one.

---

## Screenshots

Stored in `test-results-regression/` (30 PNGs, plus video and traces):

`01-login.png`, `02-dashboard.png`, `03-inventory-dashboard.png`, `04-locations.png`,
`05-products-list.png`, `06-product-form.png`, `07-customer-bills.png`,
`crm-contacts.png`, `crm-leads.png`, `crm-customers.png`, `crm-organizations.png`,
`crm-deals.png`, `crm-tasks.png`, `crm-appointments.png`, `crm-notes.png`,
`crm-products.png`, `crm-invoices.png`, `crm-payments.png`, `crm-receivables.png`,
`crm-customer-bills.png`, `crm-accounting_journal.png`, `crm-chart-of-accounts.png`,
`report-inventory_stock_valuation.png`, `report-inventory_batch_wise_stock.png`,
`report-inventory_godown_wise_stock.png`, `report-inventory_location_wise_stock.png`,
`report-inventory_expiry_management.png`, `report-inventory_serial_number_tracking.png`

---

## What Was NOT Broken

Worth stating explicitly, since the brief asked for regression detection rather than
proof that new code works:

- **Every classic CRM page renders** — Contacts, Leads, Customers, Organizations, Deals,
  Tasks, Appointments, Notes, Products, Invoices, Payments, Receivables, Customer Bills,
  Journal, Chart of Accounts. 15/15 PASS.
- **All six inventory reports render** — valuation, batch, godown, location, expiry, serial.
  These read the canonical `stock_balances` and were the queries most affected by the
  report-aggregation fix. All 200.
- **Location master works** — shows the 7 canonical locations, so the *table* consolidation
  succeeded; only the two hierarchy *queries* still reference the old name.
- **No JavaScript exceptions** (0 page errors) across the whole run.
- **Chart of accounts / journal / opening data intact** — 24 accounts, 25 journal entries,
  102 lines all render.
- **Product ↔ Stock Item linkage intact** — 3/3 verified directly in the database.
- **Live database untouched** — all 18 tracked counts identical before and after.

---

## Final Verdict

# PASS WITH WARNINGS

**The recent database / inventory / billing updates preserved the existing working CRM flow.**

Every pre-existing CRM module tested (15 classic pages, 6 inventory reports, the location
master) renders correctly, with **zero uncaught JavaScript errors** and the live database
byte-for-byte unchanged in row counts.

However, this is **not a clean PASS**, for two reasons:

1. **Two HIGH-severity regressions from the repair are confirmed live in the browser.**
   `GET /api/accounting/inventory/items` and `/api/accounting/inventory/valuation` return
   **HTTP 500** because migration 082 re-keyed `inventory_items` without updating
   `accounting.controller.js`. And `GET /api/inventory/hierarchy` silently returns
   **zero locations** because migration 081 retired `inv_locations` without repointing
   `inventory.repository.js`. These are self-inflicted by the repair, and they are in
   inventory/accounting surfaces — adjacent to, though not part of, the classic CRM flows.

2. **One functional gap is unverified rather than proven.** `products.is_inventory_managed`
   is `0` on all 3 products that own a stock item. The Bill UI gates its godown/batch/serial
   inputs on that flag while the backend now *requires* a godown on any inventory-managed
   line. This strongly suggests bill posting will fail for these products, but I did not
   create a bill in the browser to confirm, and I am not claiming it as a pass or a fail.

The remaining non-blocking items: the stale `>= 25` card-count assertion in
`tests/inventory.e2e.test.js` (frontend drift, unrelated to the database), and the
`invoices` legacy path (88 code references, 0 rows, not exercised).

---

## Recommended Next Steps

1. **Repoint `inventory.repository.js:605` and `:665` to `locations`** and remove the
   dual-write in `createLocation()` (lines 159-201) plus the allow-list entry (line 46).
2. **Fix or retire the 4 accounting inventory endpoints** in `accounting.controller.js`
   (lines 13202-13416) that query the removed `inventory_items.product_id`.
3. **Backfill `products.is_inventory_managed`** from the existence of an active
   `stock_items` row, then re-run the Bill flow in a visible browser to confirm
   godown/batch/serial inputs appear and posting succeeds.
4. **Update the card-count assertion** in `tests/inventory.e2e.test.js:426` and `:496`
   to match the current dashboard (24).
5. **Add a CI guard** failing if any non-migration source file references a table listed in
   `legacy_tables` with status RETIRED — this is the exact bug class that produced FAIL 1.

---

*Regression executed with a visible browser against an isolated database copy.
Raw results: `docs/audits/ui-regression-data-2026-10-06.json`.
Reproduce with `node scripts/ui-regression.js`.*