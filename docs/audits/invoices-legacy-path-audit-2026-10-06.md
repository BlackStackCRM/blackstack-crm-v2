# BLACKSTACK CRM V2 — Legacy `invoices` Path Audit

**Date:** 2026-10-06
**Phase:** 6, Phase 10
**Scope:** Read-only audit of the legacy `invoices` table, its API surface, and its relationship to the customer-bills architecture.
**Live database:** `data/blackstack-crm.db` — **not modified by this audit.**
**Verdict:** ⚠️ **`invoices` is NOT retired. It is a live, writable API duplicating the bills architecture. Do not drop it.**

---

## Headline Finding

> **`/api/invoices` is a fully functional CRUD API that creates, updates and deletes rows in the `invoices` table right now.**

This was verified empirically, not inferred, by running the real server against a disposable copy of the database (`scripts/probe-invoices-legacy.js`):

| Operation | Endpoint | Result |
|---|---|---|
| List | `GET /api/invoices` | **200** — returns a paginated envelope |
| **Create** | `POST /api/invoices` | **201** — row persisted to the table |
| Update | `PUT /api/invoices/:id` | **200** |
| Delete | `DELETE /api/invoices/:id` | **200** — row removed (`rowsAfterCreate: 1` → `rowsAfterDelete: 0`) |
| Set status | `PATCH /api/invoices/:id/status` | **404** — this route does not exist |

So the table is not a stranded historical artifact. It is reachable, authenticated, permission-gated, **and writable**. Any plan that assumes `invoices` is inert would be wrong.

---

## 1. Database Facts

| Property | Value |
|---|---|
| Table | `invoices` |
| Rows | **0** |
| Columns | `id, company_id, invoice_number, contact_id, organization_id, deal_id, status, issue_date, due_date, subtotal, tax, discount, total, paid_amount, balance, notes, terms, created_at, updated_at, currency` |
| Outgoing FKs | `deal_id → deals`, `organization_id → organizations`, `contact_id → contacts` |
| Incoming FKs | `invoice_line_items → invoices.id`, **`payments.invoice_id → invoices.id` (`ON DELETE NO ACTION`)** |
| Registered in `legacy_tables` | **No** — it is not classified anywhere |

### The `payments` dependency matters

`payments.invoice_id` carries a live foreign key to `invoices.id`. Both tables hold 0 rows, so nothing is broken today — but dropping `invoices` would either fail on that FK or require dropping `payments.invoice_id` as well. `payments` is an **active** table in the collections architecture. This alone rules out an uninformed `DROP TABLE`.

### Column overlap with `bills`

`invoices` shares **all 19** of its columns with `bills` (identical names). `bills` carries **52** additional columns the legacy table lacks, including:

- `bill_number`, `bill_type`, `reference_number`, `created_by`
- `customer_gstin`, `billing_address`, `shipping_address`, `place_of_supply`
- `customer_po_number`, `customer_po_date`, `salesperson_id`, `sales_channel`
- `payment_terms`, `payment_terms_days`, `price_list_id`, `branch_id`, `warehouse_id`
- `project_id`, `cost_centre_id`, `taxable_amount`, `tax_master_id`, `round_off`
- `is_interstate`, `company_state`, `cgst_*`, `sgst_*`, `igst_*` (full GST breakdown)
- `journal_entry_id`, `approved_by/at`, `posted_by/at`, `cancelled_by/at`, `cancellation_reason`, `reversal_journal_entry_id`
- **`inventory_voucher_header_id`, `inventory_reversal_voucher_header_id`**

**Conclusion: `invoices` is a strict subset of `bills`.** It is a pre-GST, pre-inventory, pre-approval-workflow ancestor. It duplicates the billing architecture but is missing every capability added since — most importantly it has **no inventory or accounting linkage at all**.

---

## 2. Production Code References

**22 backend files** mention `invoices` (excluding migration history). Categorised:

### 2a. The live legacy stack (self-contained, 5 files)

| File | Role |
|---|---|
| `server/routes/invoices.js` | 6 CRUD routes |
| `server/app.js` | mounted at `/api/invoices` (2 references) |
| `server/controllers/invoices.controller.js` | raw SQL on the table |
| `server/services/invoice.service.js` | tenant validation, code generation |
| `server/repositories/invoice.repository.js` | data access |

This stack is coherent and functional. It is a complete, self-contained parallel billing implementation.

### 2b. Cross-cutting references (4 files)

| File | Nature of reference |
|---|---|
| `server/auth/authorizer.js` | `invoices.*` permission keys |
| `server/services/deletion.service.js` | `invoices` is a **hard-deleted** entity in the deletion registry (line 40, 48, 79) |
| `server/services/search.service.js` + `server/controllers/search.controller.js` | global search indexes the table |
| `server/controllers/settings.controller.js` | likely module/permission listing |

### 2c. Accounting/collections reports (5 files)

`server/controllers/accounting.controller.js`, `server/repositories/collections.repository.js`, `server/repositories/receivable-summary.repository.js`, `server/controllers/payments.controller.js`, `server/services/payment.service.js`, `server/services/dashboard.service.js`.

**Important:** most of these are *accounting* modules. Their `invoices` references are frequently the **English word**, or a route name like `/accounts-receivable/customers/:id/invoices` — **not** SQL against the table. Verified for the two most load-bearing:

- `customer-bill.service.js` — its only 2 `invoices` hits are **prose in comments** ("outstanding invoices", "Invoices + Debit Notes"). **No SQL. The bills flow is completely independent of the `invoices` table.**
- `deletion.service.js` — a genuine registry entry mapping the `invoice` entity to `table: 'invoices'`, permission `invoices`, `soft: false`.

### 2d. Model & infrastructure (3 files)

`server/models/Invoice.js` (an unused Mongoose-style model — the project uses `node:sqlite`, not Mongoose), `server/services/code-generator.service.js`, `server/services/safeMigrationRunner.js`.

---

## 3. API Surface

| Method | Path | Handler | Status |
|---|---|---|---|
| GET | `/api/invoices` | `list` | ✅ live, 200 |
| GET | `/api/invoices/:id` | `get` | ✅ live |
| POST | `/api/invoices` | `create` | ✅ live, **201 — writes** |
| PUT | `/api/invoices/:id` | `update` | ✅ live, 200 |
| DELETE | `/api/invoices/:id` | `remove` | ✅ live, **200 — hard delete** |
| PATCH | `/api/invoices/:id/status` | — | ❌ **404, not registered** |

All are gated by `authMiddleware` plus explicit permissions (`invoices.view`, `invoices.create`, `invoices.edit`, `invoices.delete`). Also present: `invoices` appears in the app's module-permission list (`server/app.js:173`).

The create path runs `assertTenantRef()` from `server/utils/tenantScope.js`, so it cannot write cross-tenant rows. It is therefore *safe* — but genuinely *functional*.

---

## 4. UI Surface

| Finding | Detail |
|---|---|
| `public/js/pages/invoices.js` | **22-line compatibility shim.** Sets `window.location.hash = '#accounting/bills'` and returns. No invoice UI exists. |
| `public/js/app.js` | 2 route entries: `'invoices'` and `'invoices/:id'`, both `module: 'accounting'` — these resolve to the shim, which redirects. |
| Real invoice UI | **None.** No page lists, creates or edits invoices. |

**Consequence:** there is **no user-facing way to reach the write API.** Every human path lands on `#accounting/bills`. The legacy surface exists only for direct API callers — integrations, scripts, or a stale bookmark hitting the REST endpoint.

---

## 5. Active Workflow Dependence

| Question | Answer |
|---|---|
| Does the customer-bill flow use `invoices`? | **No.** Verified: zero SQL. Bills are fully self-contained. |
| Do inventory movements use `invoices`? | **No.** Bills → `stock_ledger` via `BillInventoryBridge`. |
| Does accounting depend on it? | Only via report/permission references, mostly the English word or route names. |
| Does anything auto-populate `invoices`? | **No.** 0 rows, and the bills flow never writes to it. |
| Is it indexed by global search? | **Yes** — `search.service.js` would return invoice rows if any existed. |
| Can a row be deleted by the deletion module? | **Yes**, hard delete (`soft: false`). |
| Can `payments` reference it? | **Yes**, via `payments.invoice_id`. |

---

## 6. Duplication Assessment

`invoices` and `bills` are **duplicate sales-document tables** with:

- identical column sets for the shared 19 fields,
- `bills` a strict superset in capability,
- **no synchronisation between them** — a bill never creates an invoice, and an invoice never affects stock, journals, receivables or GST.

This is the exact "competing source of truth" pattern Phase 6 has been eliminating elsewhere (`inv_locations`, `inventory_movements`, `batch_wise_stock`, `uoms`). `invoices` is the last one standing — **but unlike the others, it is still writable**, so it can diverge again at any moment.

---

## 7. Is Retirement Safe?

**Not as a single action.** Prerequisites, in order:

1. **Do not drop the table.** `payments.invoice_id` has a live FK with `ON DELETE NO ACTION`.
2. **Remove the write surface first.** Unmount `/api/invoices` in `server/app.js` and delete `server/routes/invoices.js`. That closes the only path by which rows can appear, and is reversible by re-adding one line.
3. **Confirm zero integrations.** The UI is already redirected, so remaining callers would be external. `/api/invoices` has never been exercised by any test in this repository — grep found no test referencing it. Verify with access logs before unmounting.
4. **Then, and only then, plan migration.** Rename → `invoices_legacy`, drop the FK from `payments`, migrate any rows if they exist. Renaming preserves history, which matches this project's stated policy.
5. **Never drop `payments`** — it is part of the active collections architecture.

Estimated effort for steps 2–4: small. The blocker is not technical, it is that nobody has confirmed whether an external system still calls the endpoint.

---

## 8. Recommendation

| Priority | Action |
|---|---|
| **1** | **Unmount `/api/invoices`.** It is an unaudited, unreferenced write path that can silently create documents invisible to every report, journal and stock movement. This is the single highest-value change and is fully reversible. |
| **2** | Add `invoices` to the architecture guard's watch list (not the RETIRED list — see below) so the day it is unmounted, reintroducing a reference fails CI. |
| **3** | Rename to `invoices_legacy` rather than dropping, after step 1 is confirmed safe by access logs. |
| **4** | Leave `payments.invoice_id` in place. It is a nullable FK on an active table; removing it is unnecessary while `invoices` exists. |

**Not recommended:** dropping the table, and "fixing" the 404 on `PATCH /status`. That route was never registered; adding it would extend a surface that should be closing.

---

## 9. Guard Configuration Decision

`invoices` is **deliberately excluded** from `RETIRED_TABLES` in `tests/architecture-retired-tables.test.js`, and this is documented in that file.

Reason: the guard fails the build on any production reference to a retired table. Since `invoices` is still **live and writable**, classifying it as retired would make the guard fail immediately on correct current code — and the fix would be to delete working code, which is exactly the wrong incentive. The guard must track reality, so `invoices` stays out until step 2 above actually happens.

When it is unmounted, add it to the retired list in the same commit that removes the route. That keeps the guard honest in both directions.

---

## 10. Verification Method

```
node scripts/probe-invoices-legacy.js
```

- Starts the real server against a **disposable copy** (`data/invoices-probe-test/invoices-probe.db`).
- Refuses to run against a non-disposable path via `scripts/assert-disposable-db.js`.
- Authenticates, exercises all five CRUD endpoints, then reads the table directly to confirm persistence.
- Deletes the working directory on completion.

The live database was never opened for writing at any point in this audit.

---

*Read-only audit. No project file, migration or live data was modified.*
*Companion: `legacy-table-status-2026-10-06.md`.*
*Reproduce: `node scripts/probe-invoices-legacy.js`.*