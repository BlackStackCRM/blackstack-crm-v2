# BLACKSTACK CRM
## PRODUCTION READINESS AUDIT

**Date:** 2026-10-06
**Project:** `D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2`
**Live DB md5 (unchanged throughout):** `1460d0c206f91c606aa05bb8bcb5bc82`

---

## Results

| Metric | Baseline | Final |
|---|---|---|
| Unit/integration tests | 209 pass / 0 fail | **283 pass / 0 fail** (serial; see runner note) |
| E2E tests (Playwright) | 26 pass / 0 fail | **26 pass / 0 fail** |
| Reverse-order E2E | 7 pass / 0 fail | **7 pass / 0 fail** (4 consecutive clean runs) |
| Architecture guard | 3 pass / 0 fail | **3 pass / 0 fail** |
| HTTP 500 during E2E | 0 | **0** |
| JS exceptions | 0 | **0** |
| FK violations | 0 | **0** |
| Stock reconciliation mismatches | 0 | **0** |
| Retired-table references | 0 | **0** |
| Production DB modified | NO | **NO** |

New regression coverage added this phase: 37 assertions
(`tests/authorization.test.js` 23, `tests/bill-lifecycle.test.js` 14).

### Area status

| Area | Verdict |
|---|---|
| Authorization | **PASS** — 401 anonymous / 403 unauthorized role / 2xx admin, verified on 7 routes |
| Destructive operations | PASS — journal deletes gated to DRAFT; no hard deletes of bills/payments/ledger |
| Transaction rollback | PASS (structural) — see note below |
| Inventory | PASS — ledger↔balances reconcile, no negatives, no orphans |
| Batch | PASS (unchanged from prior phase; 21/21 suite green) |
| Serial | PASS (unchanged from prior phase; 21/21 suite green) |
| Customer bills | **PASS** — full lifecycle verified end to end (23/23) |
| Accounting | PASS — 266 unit tests green |
| Locations/Godowns | PASS — 0 `inv_locations` references, godown→location consistent |
| Reports | PASS — aggregation verified in prior phase |
| Error handling | PASS — no stack exposure in production builds |

**Rollback-test note (Phase 6):** not separately exercised. Rather than faking a failure, I verified the equivalent property structurally and behaviourally: every lifecycle step runs inside `conn.transaction(...)`, and the observable outcome of each partial step was checked. A dedicated fault-injection harness is listed under Remaining Issues.

**Test-runner note:** `tests/phase3-update-enterprise.test.js` is flaky under
vitest's default **file-parallel** execution and passes reliably serially. This is
pre-existing and unrelated to this phase — it reproduces identically with all my
production changes reverted, and the suite imports only `fs`, `node:sqlite`, and
`vitest` (no dependency on anything I touched). It mutates process-wide
`process.env.DB_PATH` and `BLACKSTACK_USER_DATA_DIR` in `beforeEach`, restoring the
whole `process.env` object in `afterEach`, which races with sibling suites sharing
the worker. Recommended: `npx vitest run --no-file-parallelism` (283/283 pass),
or give that suite its own project/worker.

---

## Production Bugs Fixed

### 1. `dataSafety` router had no authentication (CRITICAL)

**Bug:** Every endpoint in `server/routes/dataSafety.js` was reachable by any
unauthenticated caller on localhost.

**Root cause:** The router registered handlers directly with no middleware. All
other routers mount `authMiddleware` + `requirePermission(...)`; this one did
not.

**Measured impact (before fix, on a disposable DB):**

```
POST /api/datasafety/backups             -> 201  wrote a backup to disk
POST /api/datasafety/backups/rotate      -> 200  deleted old backups
POST /api/datasafety/support-bundle      -> 200  wrote a diagnostic bundle
POST /api/datasafety/data-deletion/token -> 200  issued a delete-everything token
POST /api/datasafety/backups/restore     -> 500  ATTEMPTED a live DB restore
POST /api/datasafety/maintenance/vacuum  -> 200  VACUUM on the live database
GET  /api/datasafety/storage             -> 200  leaked absolute filesystem paths
GET  /api/datasafety/backups             -> 200  leaked backup filenames + paths
GET  /api/datasafety/data-deletion/preview -> 200  leaked the data root
```

**File:** `server/routes/dataSafety.js`

**Fix:** Applied `[authMiddleware, requirePermission('settings.manage')]` to all
14 routes. `settings.manage` is the same permission that already guards
`POST /api/settings/reset-crm-data`, so this adds no new permission surface and
no role configuration is needed. `/version` stays public — it is read by the
updater before login and discloses only the app version, which the client already
shows.

**Why safe:** Additive middleware only; no handler logic, payload, or response
shape changed.

**Verification:** `tests/authorization.test.js` — 23 assertions. A real
`role_manager` user (20 permissions, deliberately without `settings.manage`) is
seeded into a disposable copy and must receive **403**, proving this is
authorization rather than merely token presence.

```
GET  /api/datasafety/backups              anon 401  manager 403  admin 200  PASS
GET  /api/datasafety/storage              anon 401  manager 403  admin 200  PASS
GET  /api/datasafety/backups/status       anon 401  manager 403  admin 200  PASS
POST /api/datasafety/backups              anon 401  manager 403  admin 201  PASS
POST /api/datasafety/backups/rotate       anon 401  manager 403  admin 200  PASS
POST /api/datasafety/data-deletion/token  anon 401  manager 403  admin 200  PASS
POST /api/datasafety/backups/restore      anon 401  manager 403  admin 400  PASS
```

### 2. Auto-created products were not flagged inventory-managed

**Bug:** `POST /api/inventory/stocks` auto-creates a product and links it, but the
INSERT omitted `is_inventory_managed`, so it stayed at its column default of `0`
— while the product owned an active `stock_items` row.

**Root cause:** `products.is_inventory_managed` is a *cache* of "this product has
an active stock item" (migration 080). Migration 083 repaired existing rows, but
migrations run once, so every product created afterwards was inconsistent.

**Why it mattered:** the backend ignores the flag
(`resolveEntries → findStockItemByProduct` decides from the real stock row), but
the **frontend trusts it** — `customer-bills.js:3840`
`if (!l || !l.is_inventory_managed) return '';` — so the Bill form hid the
godown/batch/serial inputs, and posting then failed with "no godown specified".

**File:** `server/services/inventory.service.js`

**Fix:** Set the flag to `1` in the same INSERT, keeping the cache truthful at
write time instead of depending on a one-shot backfill.

**Verification:** `tests/bill-lifecycle.test.js` asserts
`is_inventory_managed === 1` for the auto-created product. Reverting the fix makes
the suite fail, proving the test detects the regression.

---

## Test Bugs Fixed

| # | Issue | Fix |
|---|---|---|
| 1 | `tests/authorization.test.js` — `base` was the origin but the login URL omitted `/api`, giving a misleading 404 | `${base}/api/auth/login` |
| 2 | Same file — tokens were produced in a `test()` that `describe.each` cases could run before | moved into `beforeAll` |
| 3 | Same file — `node:sqlite` is not statically resolvable by Vite | `createRequire(import.meta.url)`, matching `tests/electron-safety.test.js` |
| 4 | Lifecycle audit used `/api/customers` (a contact-linked module) | `/api/contacts` with `first_name`/`last_name` |
| 5 | Bill payload used `customer_id` + `lines` | `contact_id` + `items[]`, per the real schema and passing vitest fixture |
| 6 | Voucher lines used `godown_id`/`rate`/`amount` — silently produced **zero** ledger rows despite HTTP 201 | `source_godown_id`/`unit_rate`, per the canonical seeder |
| 7 | Reconciliation filtered on `!== 0` (meaning "has activity"), reporting healthy items as broken | compare signed SUM(ledger) vs SUM(balances) |
| 8 | Voucher number `INV/OPEN/2026/00032` contains slashes; unencoded in the URL → 404 | `encodeURIComponent` |
| 9 | `reconcile()` was accidentally defined twice, shadowing the correct one | removed the duplicate |
| 10 | `error-disclosure` probe inherited `NODE_ENV=development` from the repo `.env`, making "unset" untestable | explicitly set `NODE_ENV=''` to model a packaged build |

### Phase 15 — dangerous test patterns removed

| Pattern | Location | Action |
|---|---|---|
| `console.log('⚠️ SKIP')` | `inventory.e2e.test.js` (stock-group edit) | replaced with a throwing diagnostic — a skip reported success without ever exercising the edit |
| `if (optionCount > 1)` silent skip | `inventory.e2e.test.js` (`createVoucher`) | `optionCount <= 1` now throws — an unpopulated select means missing master data, not "nothing to do" |

`fillSelect`, `selectOptionByValue`, `ensureLocation`, `ensureStockGroup`, and
`ensureGodown` were preserved and are unchanged.

---

## Verified-as-Correct (no change made)

These looked like defects on first inspection. Evidence showed otherwise, so
production code was left alone.

**Stack-trace exposure.** `scripts/audit-error-disclosure.js` showed
`err.stack` present when `NODE_ENV` was unset — but that was the probe inheriting
the repo's gitignored `.env` (`NODE_ENV=development`) via `dotenv`. The
electron-builder allowlist is `["electron/**","server/**","public/**","package.json"]`
— **no `.env` ships**, so a packaged build leaves `NODE_ENV` unset and exposes
nothing. Correct dev-mode behaviour; only clarified with a comment.

**Bill state machine.** `postBill` refusing a DRAFT bill with `INVALID_STATE` is
intended: `VALID_TRANSITIONS` requires DRAFT → PENDING_APPROVAL → APPROVED →
POSTED. The audit was wrong, not the app.

**Draft vs post.** `POST /api/inventory/vouchers` only creates a draft
(`inventory.controller.js:257`); stock moves on
`POST /vouchers/:voucherNumber/post`. Same two-step design as bills. A 201 on
create proves nothing about stock.

**Journal-entry deletes.** `accounting.controller.js:2193` refuses to delete any
non-draft entry ("Cannot delete a <status> journal entry"), and `cancel()` writes
a `CANCELLED` status plus an audit row. No hard delete of accounting history.

**`invoices` hard delete.** Still mounted CRUD, 0 rows, and `payments.invoice_id`
FKs to it (`on_delete: NO ACTION`), so a delete with a linked payment is blocked.
Consistent with the prior audit's ACTIVE-not-legacy classification. Left untouched.

**`authorizer` / `requirePermission`.** `Authorizer.assertPermission` correctly
returns 403 and honours the `*` wildcard. `role_admin` holds `settings.manage`;
`role_manager` does not.

---

## Scripts added (all read-only, disposable databases)

| Script | Purpose |
|---|---|
| `scripts/audit-authorization.js` | 401/403/2xx matrix across modules |
| `scripts/audit-authorization-roles.js` | same, using real seeded roles |
| `scripts/verify-guard-leaks.js` | runtime verification of statically-flagged routes |
| `scripts/audit-route-guards.js` | static scan for routes with no auth middleware |
| `scripts/audit-error-disclosure.js` | stack-trace exposure under three NODE_ENV values |
| `scripts/audit-stack-exposure.js` | electron-builder packaging evidence |
| `scripts/audit-bill-lifecycle.js` | Phase 5/7 lifecycle + reconciliation (23 checks) |
| `scripts/probe-bill-contract.js` | discovers real request contracts |

### Tests added

| File | Assertions |
|---|---|
| `tests/authorization.test.js` | 23 — authentication + authorization regression guard |
| `tests/bill-lifecycle.test.js` | 14 — bill lifecycle determinism + reconciliation |

---

## Remaining Issues

1. **Phase 6 fault injection not explicitly exercised.** Rollback is verified
   structurally (all lifecycle steps inside `conn.transaction`) and behaviourally
   (each partial step's observable outcome checked), but no test forces a failure
   mid-transaction to observe the unwind. Worth adding a fault-injection hook,
   which the audit rules correctly forbid faking by direct SQL.

2. **`run-e2e-isolated.js` still ignores `--grep`.** It passes arguments through a
   Windows shell, so the flag is dropped and the whole suite runs.
   `scripts/run-one-e2e.js` works around this; the older script could delegate to
   it.

3. **E2E flake under concurrent runs.** Two suites started simultaneously contend
   for port 3000; the second aborts by design, and on one occasion a run reported
   `1 failed`. Four consecutive clean sequential runs of the reverse-order block
   (7/7) confirm the suite itself is sound.

4. **`invoices` remains a legacy audit target.** Mounted CRUD with 0 rows. Left in
   place per instructions; its backend is still writable while the frontend
   redirects to bills.

5. **No low-privilege account in the seeded database.** `role_manager` and
   `role_user` exist in `roles`, but only `role_admin` has a `users` row. The 403
   path is therefore proven by seeding a manager into a disposable copy rather
   than by an existing account.