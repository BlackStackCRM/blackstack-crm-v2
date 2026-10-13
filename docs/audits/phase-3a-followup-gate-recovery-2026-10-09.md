# PHASE 3A — FOLLOW-UP: GATE RECOVERY AND A NEW PRODUCTION LEAK

**Date:** 2026-10-09
**Status:** GATES 15/16 — STOPPED. A NEW PRODUCTION WRITE OCCURRED AND IS NOT AUTHORISED.

---

## 1. HEADLINE

| Result | Value |
|---|---|
| Release gates | **15/16** (was 12/16) |
| Gate 4 bill lifecycle | **PASS** — 14 tests |
| Gate 5 unit/integration | **PASS** — 507 tests |
| Gate 6 unit/integration serial | **PASS** — 507 tests |
| Gate 7 E2E regression | **PASS** — 26 tests |
| Gate 9 production unmodified | **FAIL — DATA CHANGED** |
| Integrity / FK | ok / 0 violations |

Gates 4, 5, 6 and 7 all pass. One gate fails, and it is the safety gate:
**a test wrote to production during the run.**

---

## 2. NEW PRODUCTION WRITE — REQUIRES AUTHORISATION

Fingerprint: `62ca344d…` (before) → `cd060e67…` (after).

Per-table diff against the pre-run backup identified exactly 7 changed tables:

| Table | Rows before → after | Content |
|---|---|---|
| `bills` | 0 → 1 | **test bill** |
| `bill_items` | 0 → 1 | test line |
| `receivables` | 0 → 1 | derived |
| `accounting_audit` | 0 → 2 | CREATE + SUBMIT |
| `number_sequences` | 5 → 6 | CUSTOMER_BILL counter |
| `system_metadata` | 1 → 2 | company_name |
| `users` | 1 → 1 | `updated_at` touched |

The leaked record:

```
bill_01M4GPPH2HW3B3H56AFSR01FT5
BILL-2026-00001   status PENDING_APPROVAL   total 2000 INR
created_by admin  created_at 2026-10-09 16:07:20
product prod_01M45JAQMT43CJ5K8WWVHM7N92 ("Victus Gaming Laptop 15-fb3385AX")
contact cnt_001
```

`journal_entries` remains **31** — unchanged. `financial_years` locks remain
**1/1** — unchanged. No accounting data was corrupted.

### Root cause — PROVEN, not inferred

`server/database/connection.js` line 13:

```js
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/blackstack-crm.db');
```

This is a **module-level constant**, evaluated at first `require()` and cached
for the life of the process.

`tests/customer-bills.vitest.test.js` sets `process.env.DB_PATH` at line 14 and
then requires the modules — but it runs in the **same worker process** as other
suites under vitest's parallel execution. If any earlier-loaded file required
`connection.js` first, that module is already cached and bound to production.
The test's later `process.env.DB_PATH` assignment is then **ignored**.

Demonstrated directly:

```
delete process.env.DB_PATH
require('server/database/connection.js')      // binds production
process.env.DB_PATH = tests/test-cb-vitest.sqlite
require('server/database/connection.js')      // same cached instance
→ same module instance: true
→ bound file: main=...\datalackstack-crm.db
```

This is **the same defect class as the 2026-10-09 accounting incident**. The
`assert-disposable-db.js` guard already documents it and even fails closed via
`PRAGMA database_list` — but this suite **does not call the guard at all**
(`guard=0`), so nothing protected it.

### Why the suite is dangerous

It also runs `DEMO_MODE=true` and calls `seed()`, and it deletes its DB file in
`afterAll`. Under a shared worker it writes production rows *and* the demo
seeder can write further.

### NOT FIXED — awaiting authorisation

No isolation change was made to `customer-bills.vitest.test.js`, because any
fix changes test behaviour and the leaked production rows still need a decision.

---

## 3. A REAL REGRESSION I INTRODUCED AND FIXED

While diagnosing gate 4 I found that **my own FY-2 change had broken every bill
posting path**:

```
ReferenceError: evaluateFinancialYearLock is not defined
  at CustomerBillService.postBill (customer-bill.service.js:469)
```

The five guards I added had **no matching import**. The HTTP layer masked this
as `INTERNAL_ERROR`, and the test asserted on status codes, so it surfaced only
as 4 failing tests.

Why it escaped:
- `node --check` validates **syntax only** — it does not resolve identifiers.
- My own regression test asserted on **source text** (guard count, `|| {}`),
  which cannot detect a missing binding.

**Fixed** by adding the import. **Regression test added** that asserts, for
every file using the policy, that it is actually imported or declared, plus a
`require()`-in-a-child-process check.

Lesson recorded: text assertions prove intent; only execution proves wiring.

---

## 4. GATE 7 — FIXED (test isolation, not a code change)

`scripts/run-one-e2e.js` cloned production and inherited `is_locked=1`.
`inventory.service.js` reaches `accounting-engine.service.postVoucher()`, which
**refuses a locked year**, so `Test 14: Post draft voucher through UI` failed on
a status assertion while touching no E2E code.

I verified the inventory stack was genuinely independent of my FY changes
(`inventory.controller.js` and `inventory.service.js` contain **zero**
`evaluateFinancialYearLock` references), then traced the real dependency to the
**pre-existing** engine lock check.

**Fixed** by unlocking financial years in the E2E disposable clone only, with
a fail-closed assertion. Result: Test 14 PASS; gate 7 **26/26**.

---

## 5. CLEANUP OPTIONS — MEASURED, NOT ASSUMED

Each option was executed on its own throwaway copy.

| Option | Entries | Lines | Trial net | ABS debits | Probes left |
|---|---|---|---|---|---|
| **A** Retain | 31 | 112 | 0 | 8855 | zero-line 1, neg 4 |
| **B** Hard delete | 25 | 102 | 0 | **8100** | 0 |
| **C** Reversal | **36** | **120** | 0 | **9110** | zero-line 1, neg 4 |

**This reverses my earlier recommendation.** I previously suggested reversal was
safest. Measured, it is the **worst** option here:

- `reverse()` **clones** lines into new offsetting entries and marks the original
  `REVERSED` — rows **increase**, they are not removed.
- It **duplicates the negative amounts** into the offsets, so absolute-value
  reports stay distorted *and* the ledger grows.
- Only 5 of 6 probes are reversible; the **DRAFT** entry throws
  "Cannot reverse a non-posted entry" and would be left behind.
- It leaves the invalid `fy_2024` linkage on the entries it marks `REVERSED`.

**Hard delete (B)** is the only option that actually removes the distortion and
restores the ledger to its 25 genuine entries. Its cost is loss of the audit
trail, so it should follow a verified backup — one now exists at
`%LOCALAPPDATA%\Temp\bs-backup-20261009-205746` (integrity ok, FK 0).

**No cleanup performed. Awaiting authorisation.**

---

## 6. VERSION CONTROL

No `.git` anywhere in the project or any parent directory up to the drive root.
A `.gitignore` **is** present (excludes `node_modules/`, `*.db`, `*.db-wal`,
`dist/`, `.env`), which implies a repository existed or was planned.

Also found: `D:\Work\Projects\blackstack\CB%20CRM%20V2\blackstack-crm-v2\`
— a URL-encoded path artifact containing only an empty `docs/` directory from
Sep 25. Not a repository, not a project copy.

**No repository was initialised. No project file was altered to make git work.**

### Changed-file inventory (10 files)

| File | Change |
|---|---|
| `server/services/financial-year-policy.service.js` | NEW — shared FY lock policy |
| `server/controllers/accounting.controller.js` | 10 lock sites → policy; `ctx` on 9 validators; 29 call sites |
| `server/services/customer-bill.service.js` | 5 posting paths guarded pre-transaction; **import added (fix)** |
| `server/controllers/customer-bill.controller.js` | passes `req` at 5 sites |
| `scripts/run-one-e2e.js` | unlock FY in E2E clone; fail closed |
| `tests/bill-lifecycle.test.js` | explicit FY setup in disposable DB |
| `tests/phase-3a-fy-lock-policy.test.js` | NEW — 20 tests incl. binding regression |
| `scripts/phase-3a-fy-config-audit.js` | NEW — read-only FY audit |
| `scripts/phase-3a-fp-diff.js` | NEW — fingerprint drift diff |
| `docs/audits/phase-3a-consolidated-incident-report-2026-10-09.md` | report |

---

## 7. PRODUCTION SAFETY EVIDENCE

- `integrity_check` : **ok**
- `foreign_key_check` : **0 violations**
- `financial_years.is_locked` : **1 / 1** (untouched)
- Six probe journal entries : **intact**, unmodified
- `journal_entries` : **31** — no journal data touched by any of this work
- Backup verified: `%LOCALAPPDATA%\Temp\bs-backup-20261009-205746`
- Disposable-DB guard proven to **refuse** a mis-bound connection
  (3 negative cases + `tests/phase-3a-db-isolation-guard.test.js` 6/6)

---

## 8. OPEN — AUTHORISATION REQUIRED

1. **Leaked test bill** `BILL-2026-00001` (+ item, receivable, 2 audit rows,
   sequence counter) — delete, or retain?
2. **`customer-bills.vitest.test.js` isolation defect** — fix it? This is a live
   leak path; every future parallel gate run can repeat it.
3. **Six probe journal entries** — hard delete now recommended (measured above).
4. **Production FY lock** — still `1`; intended state still unestablished.

Phase 3 is **not** complete.
