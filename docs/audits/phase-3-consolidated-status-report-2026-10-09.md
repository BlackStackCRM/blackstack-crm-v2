# PHASE 3 — CONSOLIDATED STATUS REPORT

**Date:** 2026-10-09
**Release gates:** **16/16 PASS**, exit 0
**Tests:** **569 passed**, 0 failures (21→24 test files)
**Production:** fingerprint `5a0215eb…` — unchanged throughout
**Phase 3: INCOMPLETE**

---

## 1. HEADLINE

The release gate passes and production is byte-for-byte unchanged. Phase 3 is
**not** complete: three of four core modules plus cross-module integration have
never been audited, and several confirmed findings remain open.

| State | Status |
|---|---|
| Release verification | **PASSED — 16/16, exit 0** |
| Production data | **unchanged, 0 records deleted** |
| Cleanup A / B | **NOT AUTHORIZED — HOLD** |
| CRM findings closed | 4 of 9 (CRM-01, CRM-02 from Step 2A; **CRM-03, CRM-04, CRM-05, CRM-06** this phase) |
| Billing / Inventory / integration audits | **NOT STARTED** |
| **Phase 3** | **INCOMPLETE** |

---

## 2. WHAT WAS FIXED THIS PHASE — SIX DEFECTS, EACH PROVEN FIRST

Every fix followed the same discipline: write the regression test, run it against
the **unfixed** code, confirm it fails for the stated reason, then fix, then prove
16/16.

| Step | Finding | Defect proven | Fix |
|---|---|---|---|
| 3A | DB isolation | `connection.js` resolved `DB_PATH` at **module load**, so a later env assignment was silently ignored under vitest's shared workers | Resolve on **first connect**; `_pathDrift()` makes a mismatch detectable; guard fails closed on drift |
| 3A | Test harness | Guard inspected a **historical log** of connections, refusing safe suites; `createDisposableDb()` never set `DB_PATH`; `migrate()` leaked its handle | `_liveConnections()`; helper assigns `DB_PATH`; handle closed by caller |
| 3A | Fixture | `makeCrmDb` seeded a fake checksum **and** a stub `contacts` table that suppressed migration 002, so 014 died on a missing column | Real checksums; no pre-created `contacts`; migrate-then-seed |
| 3B | **CRM-03** | Deal stage validated for **existence only** — backward moves, terminal-deal re-staging, and a nonsense task status all returned `200`. Also: staging a **non-existent deal** returned `200 success` | Transition policy from `stage_order` / `is_won` / `is_lost`; 404 on missing deal; task status vocabulary |
| 3C | **CRM-04** | `deals` and `organizations` were bare `DELETE`s. Deals had **8 inbound FKs, 3 CASCADE**; organizations produced a **partial teardown** (activities destroyed, contacts/deals silently nulled) | `DELETE_BLOCKERS` + dependency check + DELETE in **one transaction**; 409 naming blockers |
| 3C | **CRM-05** | One regex matched **four** failures and emitted the same "related records reference this data" for all — a duplicate key told the user they had dependents | Extracted to `server/utils/errorMapping.js`: FK→409, UNIQUE→409 `DUPLICATE_VALUE`, CHECK/NOT NULL→400, unknown→**500** |
| 3D | **CRM-06** | `/api/activities` mounted but **GET/POST only** — a logged activity could never be retracted | Tenant-scoped `remove()` + route, reusing an **existing** permission |

### Measured before/after for CRM-05

| SQLite error | Before | After |
|---|---|---|
| `FOREIGN KEY` | `ENTITY_HAS_DEPENDENCIES` / 409 | same |
| `UNIQUE` | `CONSTRAINT_VIOLATION` / 409 + dependency wording | **`DUPLICATE_VALUE` / 409** |
| `CHECK` | `CONSTRAINT_VIOLATION` / 409 + dependency wording | **`VALIDATION_ERROR` / 400** |
| `NOT NULL` | `CONSTRAINT_VIOLATION` / 409 + dependency wording | **`VALIDATION_ERROR` / 400** |
| unrecognised | 500 | **500** (real faults must not be laundered into 4xx) |

---

## 3. TEST TOTALS PER STEP

| Step | Tests | Gate |
|---|---|---|
| baseline (pre-incident) | 481 | 16/16 |
| after FY lock fixes | 507 | 15/16 |
| after fixture fix | 524 | **16/16** |
| after CRM-04 | 532 | **16/16** |
| after CRM-03 | 545 | **16/16** |
| after CRM-05 | 562 | **16/16** |
| after CRM-06 | **569** | **16/16** |

Command used throughout: `E2E_PORT=<free port> npm run test:release`.

---

## 4. OPEN FINDINGS — RE-VERIFIED AGAINST TODAY'S CODE

Not carried over from memory; each was re-checked.

| ID | Severity | Finding | Verified state |
|---|---|---|---|
| CRM-03 | — | ~~deal/task state transitions~~ | **CLOSED** |
| CRM-04 | — | ~~deal/org deletion safety~~ | **CLOSED** (2 of 8 entities) |
| CRM-05 | — | ~~error semantics~~ | **CLOSED** |
| CRM-06 | — | ~~activities delete~~ | **CLOSED** |
| CRM-07 | LOW | N+1 query sites | **still open** — `contacts.controller.js:145, 227` and `organizations.controller.js:116, 120` run a query per loop iteration |
| CRM-08 | INFO | `customers` orphaned from Billing | **still open** — table exists with 12 columns, FKs to `users`/`contacts`, and **nothing references it** |
| CRM-09 | INFO | lead attributes duplicated | **still open** — one `INSERT INTO leads` column list, overlapping `contacts` |
| — | LOW | `server/routes/relationships.js` **unmounted** | **still unmounted** — confirmed absent from `app.js` |
| — | LOW | delete safety: leads, customers, tasks, appointments, notes, pipelines | **open** — none have inbound FKs, so no cascade, but all are non-atomic single statements |
| — | MEDIUM | `activities.delete` permission absent | **still absent** (0 rows) — CRM-06 reuses `activities.create`; a dedicated permission needs owner approval |
| — | MEDIUM | `customer-bill.service.js` **ignores request `bill_type`** | hardcodes `'CUSTOMER'`; a client sending `SUPPLIER` silently gets a customer bill |
| — | MEDIUM | `server/services/deal.service.js` **dead and broken** | required by nothing; `markWon`/`markLost` write `won_at`/`lost_at`, **columns that do not exist** |

---

## 5. CLEANUP A / B — STILL HOLD

| Item | State |
|---|---|
| **A** — 6 synthetic journal entries + 10 lines | **NOT AUTHORIZED** |
| **B** — `BILL-2026-00001` + 4 dependent rows | **NOT AUTHORIZED** |
| financial-year locks | keep `1 / 1`, untouched |
| `CUSTOMER_BILL.next_seq` | keep `2`, not reset |

Both plans are archived with full row payloads and rehearsed on a throwaway
clone: integrity ok, FK 0, trial balance balanced, `audit_logs` preserved. The
net trial-balance impact of the probes is **zero** (all balanced), but three
carry negative amounts, one is a zero-line POSTED entry, and three are dated
outside their declared financial year.

**Nothing was deleted.**

---

## 6. PRODUCTION SAFETY — EVIDENCE

| Metric | Value |
|---|---|
| Content fingerprint | `5a0215eb…` — identical before and after every run |
| Gate's own fingerprint (own algorithm) | `cd060e67…` BEFORE and AFTER |
| `integrity_check` | ok |
| `foreign_key_check` | 0 violations |
| `journal_entries` / `journal_entry_lines` | 31 / 112 — unchanged |
| `bills` / `audit_logs` | 1 / 431 — unchanged |
| FY locks / `next_seq` | `1 / 1` / `2` — unchanged |
| Records deleted | **0** |

Gate 9 (`live database CONTENT unmodified`) passes independently.

Two verified backups, each proven restorable by **copying to a scratch path and
opening it there**, then integrity/FK/writability checking:
`bs-backup-20261009-205746` (pre-leak) and `bs-backup2-20261009-214827`
(current, plus 33 preserved source files).

---

## 7. DEFECTS I INTRODUCED AND CAUGHT

Recorded because each was found by a test rather than by inspection, and each is
the kind that silently survives a green suite.

| # | Defect | Caught by |
|---|---|---|
| 1 | FY-2 guards referenced `evaluateFinancialYearLock` with **no import** — every bill posting path threw `ReferenceError`, masked as `INTERNAL_ERROR`. `node --check` passed | 4 failing lifecycle tests |
| 2 | `createDisposableDb()` assigned `DB_PATH` unconditionally, **masking the mis-bound case** so the guard allowed a mis-bound run | existing `CASE 1` guard test |
| 3 | `AppError` required inside `updateStage` but used in a helper — `require` is method-scoped, so every intended 409 surfaced as 500 | CRM-03 transition tests |
| 4 | A test asserted on an embedded **copy** of the error mapping — would have passed regardless of the real code | self-review |
| 5 | `node --check` passed a file Vite rejected (CJS vs ESM parse) — regex with escaped slashes | running the suite |

**Pattern:** text assertions prove intent; only execution proves wiring. And
`node --check` is not a sufficient syntax gate on these ESM test files.

---

## 8. NOT DONE

- **Billing audit** — not started
- **Inventory audit** — not started
- **Cross-module integration audit** — not started
- CRM-07, CRM-08, CRM-09, unmounted `relationships.js`, six lesser delete-safety
  entities, `activities.delete` permission
- The three findings CRM-05/CRM-06 surfaced (`bill_type` coercion, dead
  `deal.service.js`, untestable inline middleware)
- Cleanup A / B

---

## 9. RECOMMENDED SEQUENCE

1. **Authorize cleanup A and/or B**, separately — both are rehearsed.
2. **`customer-bill.service.js` `bill_type` coercion** — a client can silently
   create the wrong kind of bill. Highest-impact unfixed item.
3. **Delete safety** for the remaining six entities — lower risk (no inbound FKs)
   but closes the CRM-04 finding completely.
4. **CRM-07/08/09** and decide `relationships.js`: mount or delete.
5. **Billing audit**, then **Inventory audit**, then **cross-module integration**.
6. FY-3 (`journal_entries.financial_year_id` backfill) last — documentation, not
   a schema change.

**Phase 3 cannot be declared complete until steps 5 is done.**
