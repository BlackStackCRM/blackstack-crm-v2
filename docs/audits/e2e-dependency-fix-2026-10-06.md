# E2E Dependency Fix — Audit Report

**Date:** 2026-10-06
**Scope:** `tests/inventory.e2e.test.js` — order-independence and prerequisite fixes
**Project:** `D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2`

---

## Result

```
E2E DEPENDENCY FIX COMPLETE

Test 7  — Godown:        PASS
Test 9  — Stock Category: PASS
Test 11 — Stock Item:     PASS

Tests 7–11:   PASS 5 / FAIL 0
Tests 20–29: PASS 7 / FAIL 0   (run standalone from a clean DB)
Reverse-order block (25,24,23,21,11,9,7): PASS 7 / FAIL 0
Full suite:  PASS 26 / FAIL 0

Production Bugs Found:
1. StockItemPage was defined but never dispatched — `stock_items` was absent from
   the `masterKeys` array in inventory-sub.js, so the route fell through to the
   generic MasterPage. The dashboard card rendered a name-only form posting to
   /inventory/masters/stock_items; uom, group, brand, category, model, colour,
   size, style, pricing and the batch/serial flags were all unreachable.
2. The inventory dashboard had no `stock_items` card, although products.js links
   to #inventory/stock_items twice. The one page the product form navigates to
   could not be reached from the dashboard.

Test Setup Bugs Fixed:
1.  Test 7 — Godown required a Location, but beforeAll DELETEs all locations and
    the test that creates one ran later. Added ensureLocation().
2.  Test 7/9/11 — required selects were silently skipped when unpopulated
    (optionCount > 1 guard) and fillSelect() discarded its result, so a godown was
    submitted with no location and the save failed with no visible cause.
    fillSelect() now throws; optionCount <= 1 is a failure; added
    selectOptionByValue() for id-bearing fields.
3.  Test 9 — Stock Category required a Stock Group assumed from a prior test.
    Added ensureStockGroup() and assert the persisted stock_group_id.
4.  Test 11 — asserted against the generic master form; StockItemPage uses
    camelCase fields and #inv-master-form. Rewritten against the real DOM.
5.  Test 21 — a location-wise report is empty without stock; it relied on
    vouchers posted by Tests 12–15. It now creates its item and posts its own
    opening stock.
6.  Test 23 — clicked [data-inv-card="price_levels"], a card that does not exist
    (20s timeout). price_levels is in masterKeys, so the sub-route
    #inventory/price_levels renders the table. Test-selector fix, no UI change.
    Its `⚠️ SKIP` fallback (which could pass without testing deletion) now throws.
7.  Test 24 — looked up a stock item "created by Test 11" and asserted bare
    toBeTruthy(); it now establishes its own unit, godown and stock item.
8.  Test 25 — same inherited dependency; now creates its own fixture.
9.  Tests 24/25 — read /api/inventory/masters/stock_items instead of the
    canonical /api/inventory/stocks the UI renders from.
10. EXPECTED_INV_CARDS split cards arrays on commas, so a comment containing a
    comma inside the array inflated the count and every dashboard navigation
    timed out. Comments are now stripped per line.
11. ensureGodown() matched on `code`, missing the E2E-WH godown Test 7 created,
    then attempting a duplicate name → HTTP 409. Now matches on name.
12. run-e2e-isolated.js passes Playwright args through a Windows shell, so
    --grep is silently dropped (full suite runs) and alternation "|" dies in
    cmd.exe. Added scripts/run-one-e2e.js, which calls cli.js without a shell.

Production DB Modified: NO
FK Violations: 0
Stock Ledger/Balance Mismatches: 0
```

---

## Verification detail

### Live database untouched

```
md5(data/blackstack-crm.db) = 1460d0c206f91c606aa05bb8bcb5bc82   (unchanged)
PRAGMA integrity_check      = ok
PRAGMA foreign_key_check    = 0 violations
stock_ledger  sum(quantity) = 2   (2 rows)
stock_balances sum(quantity)= 2   (2 rows)
```

### Regression check

| Suite | Result |
|---|---|
| `npx vitest run` | 209 passed / 0 failed (6 files) |
| `tests/architecture-retired-tables.test.js` | 3 passed |
| Retired-table refcount | inv_locations 0, inventory_movements 0, batch_wise_stock 0, uoms 0, stock_adjustment_reasons 0 |

### Order-independence proof

Each of these passes **standalone** against a freshly wiped database, and the
seven dependency-heaviest tests pass in **reverse** order in a single run. The
dependency is removed, not merely reordered:

```
Test 24:  1 passed     Test 25:  1 passed
Test 21:  1 passed     Test 23:  1 passed
reverse block (25,24,23,21,11,9,7):  7 passed
```

---

## Production changes (2 files, both additive)

**`public/js/pages/inventory.js`**
- Added `'stock_items'` to the inventory-masters `cards:` array, a `CARD_META`
  entry (label / icon / description), and an `API_MAP` entry pointing at
  `/api/inventory/stocks`. Uses the dashboard's existing card architecture; no
  parallel navigation was introduced.

**`public/js/pages/inventory-sub.js`**
- Registered `stock_items` in the dispatch and routed it to `StockItemPage`.

These are the only production edits. Both restore surfaces that already existed
and were already linked to, rather than adding new features.

## Test-side changes

`tests/inventory.e2e.test.js` — nine `ensureX()` helpers (`ensureMaster`,
`ensureLocation`, `ensureUnit`, `ensureStockGroup`, `ensureStockCategory`,
`ensureBrand`, `ensureModel`, `ensureGodown`, `ensurePriceLevel`) that query
first, create only when absent, verify the write, and throw on failure. Plus
throwing select helpers, corrected form contracts for Tests 11/21/23/24/25, and
a comment-aware card counter.

No assertion was weakened. The `⚠️ SKIP` fallback in Test 23 was replaced with a
throwing diagnostic, and the vague `toBeTruthy()` lookups in Tests 24/25 were
replaced with assertions naming the expected id and the values actually seen.

## Supporting scripts (read-only, disposable databases)

- `scripts/run-one-e2e.js` — single-test isolated runner (port-busy guard, WAL copy, `/health` readiness)
- `scripts/probe-dashboard-cards.js` — which `[data-inv-card]` keys actually render
- `scripts/probe-stock-item-form.js` — real `#inv-master-form` DOM contract
- `scripts/probe-stock-items-endpoint.js` — `/inventory/stocks` vs `/inventory/masters/stock_items`
- `scripts/probe-e2e-endpoints.js` — masters-endpoint availability on a wiped DB