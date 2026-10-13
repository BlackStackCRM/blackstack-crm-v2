# PHASE 3A — ISOLATION FIXED; CLEANUP PLANS READY (AWAITING AUTHORISATION)

**Date:** 2026-10-09
**Status:** LEAK PATH CLOSED — NO PRODUCTION CLEANUP PERFORMED

---

## 1. PHASE A — PRESERVED AND VERIFIED

Two verified backups, both opening cleanly with `integrity_check: ok` and
`foreign_key_check: 0`:

| Backup | Contents | Restorable |
|---|---|---|
| `%LOCALAPPDATA%\Temp\bs-backup-20261009-205746` | **pre-leak** state (bills=0) | yes |
| `%LOCALAPPDATA%\Temp\bs-backup2-20261009-214827` | current state (bills=1), 11 files | yes |

Both are self-contained single files — no `-wal` needed to open them.

Production fingerprint at start and end of this phase: **`5a0215eb…` unchanged.**

---

## 2. PHASE B — THE LEAK PATH IS CLOSED

### Root cause fixed at source

`server/database/connection.js` resolved its path as a module-level constant:

```js
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/blackstack-crm.db');
```

Now the path is captured on **first `connect()`**, not at import, and then frozen.
A later `process.env.DB_PATH` change is no longer silently ignored — it is
reported through `_pathDrift()`, so a guard can fail closed.

New exports: `_pathDrift()`, `_boundDbPath()`. `_openedConnections()` unchanged.

Production behaviour is unaffected: the app sets `DB_PATH` (or `DEMO_MODE`)
before anything connects, so the first `connect()` resolves the same file.

### Guard hardened

`assertDisposableDbIsActive()` now runs a **drift check before anything else** and
refuses when the environment disagrees with the file already bound — the exact
shape of the 2026-10-09 incident.

### The leaky suite fixed

`tests/customer-bills.vitest.test.js` now:
1. calls `createDisposableDb()` — a temp clone outside `data/`;
2. does so **before** requiring any database module (ordering asserted);
3. re-asserts isolation with `assertDisposableDbIsActive()` before its first write;
4. **no longer unlinks its own DB** — that raced sibling suites in the same worker;
5. unlocks financial years **in the disposable clone only**, with a fail-closed
   assertion (it otherwise inherited production's locked years and failed with
   "Financial year is locked").

### Runtime regression tests — `tests/phase-3a-db-bind-isolation.test.js`

**12/12 PASS.** Each case runs in a **child process** so module state cannot
leak between them, and asks SQLite which file is really open:

| Case | Asserts |
|---|---|
| import-then-set-DB_PATH | binding does **not** move, and the drift is now **detectable** |
| set-DB_PATH-then-import | binding **does** move to the intended file |
| shared-worker "second suite" | **refused**, not silently allowed |
| leaky suite structure | uses the guard, no hand-rolled path, no `unlinkSync` |
| require ordering | disposable DB chosen **before** the db module require |
| 5 bill/accounting suites | all show evidence of isolation |
| production untouched | counts + FY locks identical before/after |

### The proof that matters

The previously-leaking suite, run alone and then **together with** its sibling
under the same shared worker:

```
customer-bills.vitest.test.js alone     177 passed
both suites together                    191 passed
production fingerprint   5a0215eb...  ->  5a0215eb...   UNCHANGED
```

**No production write. The leak path is closed.**

---

## 3. PHASE C — EXACT CLEANUP PLANS (NOT EXECUTED)

### 3A. Leaked test bill — proven synthetic

```
bill_01M4GPPH2HW3B3H56AFSR01FT5   BILL-2026-00001   PENDING_APPROVAL   Rs 2000
```

Evidence it is **not** a business transaction:

- status `PENDING_APPROVAL` — never approved, never posted
- `approved_by`, `posted_by`, `journal_entry_id`, `inventory_voucher_header_id` all **NULL**
- **no journal entry, therefore no ledger impact whatsoever**
- `reference_number`, `notes`, `terms` all empty
- `stock_ledger` unchanged at 2 rows
- created `2026-10-09 16:07:20` by `admin` — during the gate run
- it is the **only** bill in production

### 3B. Exact dependents

| Table | Column | Rows |
|---|---|---|
| `bill_items` | `bill_id` | 1 |
| `receivables` | `bill_id` | 1 |
| `accounting_audit` | `entity_id` | 2 (CREATE, SUBMIT) |

No other table references it. No payment, allocation, or voucher links.

### 3C. Six probe journal entries — exact IDs

| Entry | Entry ID | Date | Status | FY ID | Lines |
|---|---|---|---|---|---|
| JE-1791550881603 | `je_01M4GC1ZT2GKE78T9DFZPK08HY` | 2026-10-09 | POSTED | fy_2024 | 2 |
| JE-1791550881613 | `je_01M4GC1ZTDNBVD24857PENP19C` | 2026-10-09 | POSTED | fy_2024 | 2 |
| JE-1791550881618 | `je_01M4GC1ZTJNEAWT9K0J30D71K9` | 2026-10-09 | POSTED | fy_2024 | **0** |
| JE-1791552166536 | `je_01M4GD96KYKMEMT04Y4SJCFFDA` | 2024-01-01 | POSTED | fy_2024 | 2 |
| JE-1791552166543 | `je_01M4GD96MFX1N2CYENWC2NKEMZ` | 2024-01-01 | **DRAFT** | fy_2024 | 2 |
| JE-1791552765854 | `je_01M4GDVFWXKHWGY5JCJV9VVS7E` | 2026-01-01 | POSTED | null | 2 |

**10 line IDs** are enumerated in the working notes; totals reconcile to the
report's 6 entries / 10 lines.

**Dependents: ZERO.** No `accounting_audit`, no `audit_logs`, no `vouchers` rows
reference any of the six. Deleting them orphans nothing.

Confirmed anomalies:
- entries 1–3 are dated **2026-10-09** but tagged `fy_2024` (2024-01-01..2024-12-31)
  — `dateInRange=false`
- entry 3 has **zero lines** despite being POSTED
- entries 2 and 5 carry **negative** amounts (−50, −500)
- entry 5 is **DRAFT** — `reverse()` throws "Cannot reverse a non-posted entry",
  so reversal cannot cover it

### 3D. Dry run of the proposed cleanup

Executed on a throwaway copy:

```
                          je   jl   net   ABSdr  bills  audit
BEFORE                    31  112    0    8855      1      2
after probe delete        25  102    0    8100      1      2
after bill delete         25  102    0    8100      0      0
```

Post-cleanup checks, all on the dry run:

- `integrity_check` : **ok**
- `foreign_key_check` : **0 violations**
- 25 genuine entries survive; date range 2026-10-01..2026-10-05
- `vouchers` 25, `stock_ledger` 2 — untouched
- trial balance: debits 8100 = credits 8100, **balanced**
- `audit_logs` **431 rows preserved**
- `number_sequences` CUSTOMER_BILL `next_seq` stays **2** — deliberately NOT reset,
  so `BILL-2026-00001` can never be reused
- `financial_years` locks stay **1 / 1**

---

## 4. PHASE D — NOT RUN

Full gate verification is **deliberately withheld** until you authorise the
cleanup, because a gate run would otherwise execute against a database still
holding the leaked bill, and gate 9 would fail again for a reason we would then
have to diagnose a second time.

---

## 5. DECISIONS REQUESTED

**Approve, per-item, by record ID:**

1. **Delete** the 6 probe journal entries + 10 lines (no dependents; restores the
   ledger to its 25 genuine entries; removes the negative-amount and zero-line
   distortions). Hard delete is recommended over reversal — reversal clones rows,
   so it would *increase* the entry count to 36 and cannot process the DRAFT entry.
2. **Delete** `BILL-2026-00001` + 1 bill_item + 1 receivable + 2 accounting_audit
   rows. No journal entry involved, so no ledger impact. `audit_logs` and the
   sequence counter preserved.
3. **Keep** production `financial_years.is_locked = 1`.

On authorisation I will re-verify the backup, apply exactly the dry-run
statements inside a transaction, then run integrity, FK, trial-balance and
fingerprint checks before reporting.

**Nothing in production has been modified in this phase.**
