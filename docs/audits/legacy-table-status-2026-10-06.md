# BLACKSTACK CRM V2 — Legacy Table Status Report

**Date:** 2026-10-06
**Phase:** 6, Phase 11
**Live database:** `data/blackstack-crm.db` — **unmodified** (md5 `1460d0c206f91c606aa05bb8bcb5bc82`, verified before and after every run)

---

## Status Table

Reference counts use the **same detection rules as the CI guard**
(`scripts/legacy-table-refcount.js` shares its logic with
`tests/architecture-retired-tables.test.js`), so these numbers cannot drift from
what the build actually enforces. 292 production files scanned.

| Table | Status | Production References | Action |
|---|---|---:|---|
| `inv_locations` | Retired | **0** | Guard against reintroduction ✅ |
| `inventory_movements` | Retired | **0** | Guard against reintroduction ✅ |
| `batch_wise_stock` | Retired | **0** | Guard against reintroduction ✅ |
| `uoms` | Retired | **0** | Guard against reintroduction ✅ |
| `stock_adjustment_reasons` | Retired | **0** | Guard against reintroduction ✅ |
| `inventory_items_v2` | Legacy | **0** | Do not delete — orphan, 0 rows |
| `_payments_backup` | Legacy/Backup | **0** | Do not delete — backup snapshot, 0 rows |
| `invoices` | **Legacy/Active uncertainty** | **26** | **Separate review — see below** |

### Canonical replacements (verified present, enforced by the guard)

| Retired table | Canonical replacement | Rows | Guard-enforced |
|---|---|---:|---|
| `inv_locations` | `locations` | 7 | ✅ |
| `inventory_movements` | `stock_ledger` (+ `valuation_movements`) | 12 | ✅ |
| `batch_wise_stock` | `stock_balances` + `batches` | 5 / 2 | ✅ |
| `uoms` | `units_of_measure` | 1 | ✅ |
| `stock_adjustment_reasons` | `adjustment_reasons` | 7 | ✅ |

`locations` has 13 production SQL references and `stock_ledger` has 12 — both are the actively used canonical tables.

---

## The five retired tables are now genuinely clean

All five reached **0 executable references** during Phase 6. Two did not get there for free — the guard found real live code:

| Table | What the guard found | Fix |
|---|---|---|
| `inventory_movements` | `GET /api/accounting/inventory/movements` queried the retired table. It had **0 rows**, so the endpoint always answered `200` with an empty list — the UI looked healthy while serving nothing. | Repointed to `valuation_movements`, the canonical moving-WAC valuation log with an identical field shape. Product filtering now resolves through `stock_items` instead of the retired table's `product_id`. |
| `stock_adjustment_reasons` | Listed in the generic master-CRUD `softMasters` array, while the **canonical** `adjustment_reasons` — the actual FK target of `inventory_voucher_lines.reason_id`, holding 7 live rows — was **missing**. Name search therefore did nothing on the table that holds the data. | Replaced with `adjustment_reasons`. |

The remaining apparent references are **not** table references and are deliberately tolerated:

- `batch_wise_stock` — a dashboard **card key** and URL segment (`#/inventory/batch_wise_stock`)
- `uoms` — a **local JS variable** in `public/js/pages/products.js`
- `inv_locations` — 4 **explanatory comments** recording why the dual-write was removed

Flagging those would produce false positives, and a guard that cries wolf gets ignored.

---

## `invoices` — status: **not retired, and still writable**

Full detail in `invoices-legacy-path-audit-2026-10-06.md`. Summary:

- **0 rows**, but **26 production SQL references** and a **fully mounted CRUD API** at `/api/invoices`.
- Empirically proven live: `POST` → **201 (row persisted)**, `PUT` → 200, `DELETE` → 200 (row removed).
- The UI is a 22-line shim that redirects to `#accounting/bills`, so **no human can reach the write path** — but any direct API caller can.
- `invoices` is a **strict subset** of `bills` (all 19 shared columns; `bills` adds 52 more, including GST, approval workflow, journal links and inventory voucher links).
- The customer-bill flow contains **zero SQL** against `invoices` — it is fully independent.
- **Blocker to any DROP:** `payments.invoice_id → invoices.id ON DELETE NO ACTION` is a live FK on an **active** table.

### Why it is not in the guard's RETIRED list

The guard fails CI on any reference to a retired table. Classifying `invoices` as retired today would make the build fail on **correct current code**, and the only way to "fix" it would be deleting working code — precisely the wrong incentive. A guard must track reality.

**When `/api/invoices` is unmounted, add `invoices` to `RETIRED_TABLES` in the same commit.**

### Recommended action

1. **Unmount `/api/invoices`** (`server/app.js:143`) and remove `server/routes/invoices.js`. Highest-value, fully reversible, one-line revert.
2. Add `invoices` to the guard in that same commit.
3. Only then rename to `invoices_legacy` — **never drop**, given the `payments` FK.

---

## Orphan tables — retained, not deleted

Per the retire-don't-delete policy:

| Table | Rows | Why retained |
|---|---:|---|
| `inventory_items_v2` | 0 | Pre-repair snapshot of the valuation table. No FK targets it, 0 code references. |
| `_payments_backup` | 0 | Backup taken before the payments rework. |

Both are candidates for a future documented rename-based retirement, but neither is harmful and **neither is dropped**.

---

## Verification

```bash
npm test                                              # includes the guard
node scripts/architecture-audit.js                    # → "none"
node scripts/legacy-table-refcount.js                 # → the table above
node scripts/verify-e2e-db-guard.js                   # 16/16
node scripts/probe-invoices-legacy.js                 # live CRUD evidence
```

The guard prints `Table / File / Line / Matched text` for every violation and
exits non-zero. It was verified to **fail correctly** on a deliberately planted
`SELECT * FROM inv_locations` and pass once removed.

---

*No table was dropped. No live data was modified.*
*Companions: `invoices-legacy-path-audit-2026-10-06.md`, `phase6-hardening-report-2026-10-06.md`.*