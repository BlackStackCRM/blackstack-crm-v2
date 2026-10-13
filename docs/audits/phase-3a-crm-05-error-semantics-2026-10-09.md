# PHASE 3 STEP 3C — CRM-05 FIXED: ERROR SEMANTICS

**Date:** 2026-10-09
**Release gate:** `E2E_PORT=32567 npm run test:release` → **EXIT=0, 16/16 PASS**
**Tests:** **562 passed** (was 545 — 17 new), 0 failures
**Production fingerprint:** `5a0215eb…` — unchanged before and after

---

## 1. ROOT CAUSE

The Express error handler in `server/app.js` matched **four** different failures
with one pattern and then emitted the **same** message for all of them:

```js
const FK_RE = /FOREIGN KEY constraint failed|UNIQUE constraint failed
            |NOT NULL constraint failed|CHECK constraint failed/i;
if (FK_RE.test(err.message)) {
  // both branches:
  //   'The operation was blocked because related records reference this data.'
}
```

So a duplicate key, a bad enum value and a missing required field all told the
user that **"related records reference this data"** — which is false in three of
the four cases, and sends them looking for dependents that do not exist.

### Measured, old logic vs new

| SQLite error | OLD | NEW |
|---|---|---|
| `FOREIGN KEY constraint failed` | `ENTITY_HAS_DEPENDENCIES` / 409 | `ENTITY_HAS_DEPENDENCIES` / 409 |
| `UNIQUE constraint failed` | `CONSTRAINT_VIOLATION` / 409 + dependency message | **`DUPLICATE_VALUE` / 409** |
| `CHECK constraint failed` | `CONSTRAINT_VIOLATION` / 409 + dependency message | **`VALIDATION_ERROR` / 400** |
| `NOT NULL constraint failed` | `CONSTRAINT_VIOLATION` / 409 + dependency message | **`VALIDATION_ERROR` / 400** |
| anything unrecognised | 500 | 500 |

A genuine internal fault still surfaces as 500. That distinction is deliberate:
laundering a server fault into a 4xx would hide real defects.

---

## 2. FIX

The mapping is extracted to **`server/utils/errorMapping.js`** exporting
`classifyError(err)`. `server/app.js` now delegates to it.

Two reasons for extraction rather than an inline edit:

1. The logic was inside `app.use((err, req, res, next) => …)` and **unreachable
   from any test** — `server/app.js` exports nothing. Extracting it makes the
   real logic directly assertable.
2. It allows one authoritative definition instead of a comment that can drift
   from the code.

`classifyError` returns `{ code, status, message, classification }`. An
`AppError`/`ValidationError`/`NotFoundError` that already carries its own 4xx
status is trusted unchanged, so the deliberate messages in
`contacts.controller.js`, `deals.controller.js` and `organizations.controller.js`
(CRM-01 / CRM-04) are preserved rather than overwritten.

---

## 3. `deal.service.js` — USAGE AND INTENT (recorded, not changed)

**Usage:** required by **nothing**. The only file importing it is the regression
test this step added, purely to assert that it stays unwired.

**Intent (from its own structure):** a service layer mirroring the controller's
deal lifecycle — `list`, `get`, `create`, `update`, `updateStage`, `markWon`,
`markLost`, `remove` — using `DealRepository` + `PipelineRepository` and
`Authorizer.assertPermission('deals.edit')`.

**Why it cannot be wired up as-is:**
- `markWon` writes `won_at`, `markLost` writes `lost_at`. **Neither column exists
  on `deals`** (verified against the live schema). Both would throw
  `no such column`.
- It also duplicates logic the controller already performs correctly, and the
  controller's version is the one actually exercised by tests and the UI.

**Recommendation (needs owner decision):** delete it, or repair and wire it
deliberately. Leaving it invites the belief that a lifecycle layer exists when the
controller is the only enforcement point. **Not changed here.**

---

## 4. A FALSE-PASS RISK I CAUGHT IN MY OWN TEST

My first attempt tested a **copy** of the mapping logic embedded in the test file.
That would have passed regardless of the real code — the exact "text assertion
proves intent, not wiring" trap hit earlier in this phase.

I replaced it with:
- direct assertions against the real `server/utils/errorMapping.js`, and
- a genuine SQLite `UNIQUE` violation forced on a disposable clone, run through
  the real `classifyError` (helper: `tests/helpers/crm05-unique-violation.js`).

Two further honest notes:
- I could **not** trigger a duplicate through any HTTP API, because every UNIQUE
  index in this schema is pre-checked by its controller. That is a *good* property
  and is recorded as such; the DB-level path is therefore defence-in-depth.
- My premise that `bills.bill_type` could be driven to an invalid enum was
  **wrong**: `customer-bill.service.js` hardcodes `bill_type: 'CUSTOMER'` and
  ignores the request. The CHECK is enforced by the database, but this API cannot
  reach it. That silent coercion is a **new finding**, not fixed here.
- Three of my assertions initially encoded wrong expectations (wrong route,
  wrong status code, wrong message wording) and were corrected against real
  behaviour rather than loosened.

---

## 5. VERIFICATION

| Suite | Result |
|---|---|
| `crm-error-semantics.test.js` (new) | **17/17 PASS** |
| Release gates | **16/16 PASS, exit 0** |
| Full vitest | **562 passed, 0 failed** |
| Gate 9 production unmodified | **PASS** |

### Coverage

- FOREIGN KEY → 409 `ENTITY_HAS_DEPENDENCIES` + dependency wording
- UNIQUE → 409 `DUPLICATE_VALUE`, **no** dependency wording
- CHECK → 400 `VALIDATION_ERROR`, no dependency wording
- NOT NULL → 400 `VALIDATION_ERROR`, no dependency wording
- unrecognised fault stays **500** (a real defect must not be disguised)
- `NotFoundError` keeps its own 404
- **no** classification claims a dependency unless it truly is one
- `app.js` delegates to the module; the old inline `FK_RE` branch is gone
- a real SQLite UNIQUE violation maps to `DUPLICATE_VALUE`
- 401 unauthenticated, 404 missing, 400 validation, 409 genuine dependency
- 409 refusal leaves parent **and** dependents unchanged
- no fixture row appears in production

---

## 6. PRODUCTION UNCHANGED

Fingerprint `5a0215eb…` before and after. `integrity_check` ok,
`foreign_key_check` 0 violations, gate 9 content identical.

---

## 7. NEW FINDINGS RAISED (not fixed)

| Finding | Detail |
|---|---|
| `customer-bill.service.js` ignores request `bill_type` | hardcodes `'CUSTOMER'`; a client sending `SUPPLIER` gets a customer bill silently |
| `deal.service.js` dead and broken | see §3 |
| `app.js` exports nothing | the error handler was untestable; the same applies to other inline middleware |

---

## 8. STILL OPEN

CRM-06 (`activities` has no delete handler), CRM-07 (N+1 sites), CRM-08
(`customers` orphaned from Billing), CRM-09 (duplicated lead attributes),
delete-safety for leads / customers / tasks / appointments / notes / pipelines,
`relationships.js` unmounted, and the **Billing, Inventory and cross-module
integration audits — not started**.

Cleanup A / B remain **HOLD — not authorized**, and were not executed.

**Phase 3 is NOT complete.**
