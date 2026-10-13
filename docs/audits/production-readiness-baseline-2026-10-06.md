# Production Readiness — Baseline

**Date:** 2026-10-06
**Project:** `D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2`
**Live DB md5 at start:** `1460d0c206f91c606aa05bb8bcb5bc82`

Recorded before any modification in this phase, to satisfy the
"do not continue if the baseline unexpectedly regresses" rule.

## Test counts

| Suite | Tests | Pass | Fail | Warnings |
|---|---|---|---|---|
| `npx vitest run` (6 files) | 209 | 209 | 0 | 0 |
| Playwright inventory E2E | 26 | 26 | 0 | 1 (`[CONSOLE ERROR] 404` on a static asset, non-blocking) |
| Reverse-dependency block (25,24,23,21,11,9,7) | 7 | 7 | 0 | 0 |
| `tests/architecture-retired-tables.test.js` | 3 | 3 | 0 | 0 |

## Runtime health

| Metric | Value |
|---|---|
| HTTP 500 during E2E | 0 |
| JavaScript exceptions (pageerror) | 0 |
| Unexpected console errors | 0 (one 404 on a static asset) |

## Database

| Check | Value |
|---|---|
| `PRAGMA integrity_check` | ok |
| `PRAGMA foreign_key_check` | 0 violations |
| Tables | 142 |
| `stock_ledger` sum(quantity) | 2 (2 rows) |
| `stock_balances` sum(quantity) | 2 (2 rows) |
| Ledger ↔ balance parity | match |
| `schema_migrations` max version | 83 |

Note: max migration is 83 while programmatic Steps 081/082/084 exist in
`server/database/migrate.js`; those Steps are applied in code and are not rows in
`schema_migrations`. Reconciled in Phase 12.

## Retired-table references

```
inv_locations             0
inventory_movements       0
batch_wise_stock          0
uoms                      0
stock_adjustment_reasons  0
inventory_items_v2        0
_payments_backup          0
adjustment_reasons        0
```

`invoices` remains a separate legacy audit target with 26 references in its own
controller — classified ACTIVE (mounted CRUD, `payments.invoice_id` FK depends on
it). Not touched.

## Conclusion

Baseline matches the stated verified state. No regression. Audit proceeds.