# PHASE 3A — STEP C/D/E PROGRESS: FY LOCK POLICY + A SECOND PRODUCTION WRITE

**Date:** 2026-10-09
**Status: CODE COMPLETE + TESTS GREEN — STOPPED FOR AUTHORISATION (new production write)**

---

## 1. INCIDENT NOTICE — A SECOND PRODUCTION WRITE OCCURRED

During Step A verification the production fingerprint changed a second time:

```
before this step : 3fdf4f230b0ee5e9dbf8cffa5abf48ac
after            : da6ca9275fdcac7c0f6b137fc08b49e4
```

**Cause — identified, and it is NOT a stray probe:**

| Table | Before | After |
|---|---|---|
| `schema_migrations` | 69 | **70** |
| `permissions` | 103 | **126** |
| `role_permissions` | 122 | **165** |

Migration **084 `crm_permissions`** was applied to production at
`2026-10-09 15:20:56`. This is the application's boot-migration runner, which
applied a pending migration when a server process started against the production
database. It is the same migration that backs the CRM-02 permission work from
Step 2A.

Contents verified:

- 23 new permissions: `leads.*`, `customers.*`, `notes.*`, `pipelines.*`,
  `notifications.*`, `relationships.*`, `search.view`, `dashboard.view`.
- Granted to `role_admin` (23), `role_manager` (20).
- **`role_user` received 0** — no privilege escalation.
- No accounting, inventory, billing or financial-year data was touched.

**Not yet authorised.** This was an additive, permission-scoped schema change,
not financial data, but it is a production write and is reported as such.
No attempt was made to reverse it.

---

## 2. WHAT WAS *NOT* CHANGED

- `financial_years.is_locked` — **still 1 for both years** (verified by direct read).
- No journal entries deleted, edited or reversed.
- The six probe entries remain exactly as recorded (31 entries / 112 lines).
- `integrity_check: ok`, `foreign_key_check: 0 violations`.

---

## 3. STEP A — TEST ISOLATION (COMPLETE)

`tests/bill-lifecycle.test.js` cloned the production database and therefore
inherited its `financial_years` state. It now configures the financial year
explicitly **inside its disposable database**, before seeding.

Result: **14/14 PASS** (was 14 skipped after a failed setup).

Production lock state untouched; test outcome is now independent of it.

---

## 4. STEPS B/C — FY-1 and FY-2 IMPLEMENTED

### New shared policy
`server/services/financial-year-policy.service.js`

Single source of truth. Exports `evaluateFinancialYearLock()` and
`assertFinancialYearWritable()`. Resolves the override from
`accounting.override_locked` (including a `*` wildcard) and **fails closed**
when no context is supplied.

### FY-1 — controller (HIGH)
All **10** lock sites now call the shared policy; **0** unconditional
rejections remain. An administrator holding the documented override can now
actually use it.

Request context threaded through 29 validator call sites (9 validators gained
a trailing `ctx` parameter; `postOpeningBalance` already had `req`).

### FY-2 — service (MEDIUM)
All **5** `customer-bill.service.js` posting paths guarded:
`postBill`, `recordPayment`, `writeOff`, `createCreditNote`, `createDebitNote`.

Each guard runs **before** the transaction opens, so a refusal writes nothing.
Each method gained an optional trailing `context = null`; existing callers are
unaffected. `customer-bill.controller.js` now passes `req` at all 5 sites.

A defect was caught during implementation and fixed: the `postBill` guard was
initially passing `this.conn` as the permission context, which would never
carry permissions. All five now use `context || {}` and fail closed.

### Unchanged, deliberately
- Date-range validation — **not** gated behind the override.
- Balanced-entry validation.
- Accounting engine behaviour (already honoured the override).
- No broad permission grants; no client-side-only checks.

---

## 5. TESTS

`tests/phase-3a-fy-lock-policy.test.js` — **18/18 PASS**

Covers: locked blocks non-override users; override permits; `*` wildcard
satisfies; missing context fails closed; unlocked writable by all;
`is_locked: true` handled; null year not a lock error; controller has no
unconditional rejection; all 10 sites wired; all 5 service guards present and
failing closed; methods accept optional context; engine unchanged; date-range and
balance validation intact; production row counts and FY rows unchanged.

Three of these initially failed against **incorrect assertions** (an off-by-one
in the call-site count, and two source-text expectations that did not match the
real wording). The assertions were corrected; no production behaviour was
changed to make a test pass.

---

## 6. OPEN — REQUIRES AUTHORISATION

1. **Migration 084 on production** — accept as-is, or remediate?
2. **Production FY lock** — still `1`; intended state still unestablished.
3. **Six probe entries** — still preserved; cleanup still undecided.

## 7. NOT DONE

- Step D (FY-3 `financial_year_id` backfill impact) — investigation only, no writes.
- Step E full verification — release gates and E2E isolation have **not** been
  re-run since these code changes. Gates must be run against a disposable DB
  and the resulting fingerprint reviewed before any further step.
