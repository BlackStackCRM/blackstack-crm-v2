# PHASE 3A — FINANCIAL YEAR CONFIGURATION AUDIT (READ-ONLY)

**Date:** 2026-10-09
**Status: AUDIT COMPLETE — no production write performed**
**Purpose:** establish the intended financial-year configuration so the owner can
decide the `is_locked` remediation. This audit changed nothing.

Tooling: `scripts/phase-3a-fy-config-audit.js` (read-only; inspects a temp
snapshot of the database plus its `-wal`/`-shm` sidecars).

---

## 1. Correction to an earlier statement of mine

In the incident report I noted that the genuine journal entries are dated
`2026-10-01 … 2026-10-05` while `fy_2026` spans `2026-04-01 … 2027-03-31`, and
implied the dates fell outside that range. **That was wrong.** 2026-10-01 is
*after* 2026-04-01, so the dates are inside the configured window.

Measured: **all 25 genuine entries fall inside a configured financial year. 25/25.
Zero outside.** There is no date-based inconsistency.

---

## 2. Financial year records (verbatim)

| id | name | start_date | end_date | is_active | is_locked | created_at |
|---|---|---|---|---|---|---|
| `fy_2024` | FY 2024 | 2024-01-01 | 2024-12-31 | 0 | **1** | 2024-01-01T00:00:00Z |
| `fy_2026` | FY 2026 | 2026-04-01 | 2027-03-31 | **1** | **1** | 2024-01-01T00:00:00Z |

Columns: `id, company_id, name, start_date, end_date, is_active, is_locked, created_at`

- Active year: **`fy_2026`** (the only one)
- Locked years: **`fy_2024` and `fy_2026`** (both)
- There is **no `updated_at` column**, so the lock change cannot be dated from the
  row. The only evidence it was my probe is the incident transcript.

**There is no configuration in the database that records what `is_locked` was
meant to be.** Both values now read `1`. The `fy_2024` row is `is_active=0` and
has no transactions; `fy_2026` is active and carries all 25 genuine entries plus
25 `vouchers`.

---

## 3. Which year do the genuine entries belong to?

```
genuine JV-* entries                 : 25
entry_date range                     : 2026-10-01 .. 2026-10-05
inside a configured year             : 25/25
outside every configured year        : 0/25
stored financial_year_id on entries  : (null) for all 25
distinct entry_date values           : 2026-10-01 -> 22, 2026-10-03 -> 1, 2026-10-05 -> 2
```

**Observation:** all 25 genuine `journal_entries` have
`financial_year_id = NULL`. Their year is therefore resolved **at read/report
time** from `entry_date`, not stored. By contrast `vouchers` does carry it:

| table | rows with `financial_year_id` | value |
|---|---|---|
| `vouchers` | 25 | `fy_2026` |
| `journal_entries` | 5 | `fy_2024` — **these 5 are the probe entries only** |
| `budgets`, `opening_balances`, `payable_allocations`, `year_end_closings` | 0 | — |

---

## 4. How the year is resolved when posting

`server/repositories/billing-cost.repository.js` → `FinancialYearRepository`:

```js
getActive(companyId)   // SELECT … WHERE company_id = ? AND is_active = 1 LIMIT 1
getByDate(date, comp)  // SELECT … WHERE company_id = ? AND start_date <= ? AND end_date >= ? LIMIT 1
```

**Neither method checks `is_locked`.** The repository will happily hand back a
locked year. That is not itself a defect — resolution and enforcement are
separated by design — but it means enforcement depends entirely on the caller.

`customer-bill.service.js` uses `fyRepo.getByDate(...)` at **five** posting sites
(bill post, payment, credit note, debit note, and one more), and contains
**zero** references to `is_locked` or the word "locked". Those five paths resolve
a financial year and do not enforce the lock themselves.

---

## 5. Where the lock IS enforced — and the asymmetry between layers

### Engine (`accounting-engine.service.js:60`) — has an escape hatch

```js
if (fy.is_locked && !Authorizer.assertPermission(context, 'accounting.override_locked')) {
  throw new ValidationError('Financial year is locked');
}
```

- `accounting.override_locked` **exists** as `perm_acc_008`.
- Only **`role_admin`** holds it.
- An ADMIN session receives `['*']` at login, and `assertPermission` returns early
  on `*` — so **an admin satisfies the override and is not blocked.**

### Controller (`accounting.controller.js`) — no escape hatch

`is_locked` is referenced **27 times**, and `"Financial year is locked"` is pushed
in **10 distinct validators**:

| validator | line |
|---|---|
| `_validateJournalLines` | 2245 |
| `_validateReceipt` | 2543 |
| `_validateContra` | 3068 |
| `_validateSales` | 4175 |
| `_validatePurchase` | 4926 |
| `_validateExpense` | 5672 |
| `_validatePayment` | 6490 |
| `_validateDebitNote` | 7295 |
| `_validateCreditNote` | 12055 area |
| `postOpeningBalance` (throws `FY_LOCKED` 400) | 12055 |

Every one of these is an unconditional rejection. `accounting.controller.js`
contains **zero** references to `override_locked`.

**Consequence:** the controller rejects a locked year for **every** user,
including an administrator who legitimately holds the override permission. The
override works in the engine but is unreachable through the controller.

---

## 6. Why gates 5/6/7 are failing

`tests/bill-lifecycle.test.js` logs in as **`admin@blackstack.local`** — an
ADMIN session holding `['*']` and therefore `accounting.override_locked`. It posts
a bill, which reaches the controller validators, which reject unconditionally with
`{"code":"VALIDATION_ERROR","message":"Financial year is locked"}`.

So the failure is **not** a permission problem and **not** a code regression. It
is a locked active financial year meeting a validation path that offers no
override. The engine — the only layer with an escape hatch — is not on this path.

This is why unlocking the years would restore gates 5/6/7, and equally why it is
a judgement call: **no artifact in the database or repository records the intended
lock state.**

---

## 7. Findings

| # | Severity | Finding | Evidence |
|---|---|---|---|
| FY-1 | **HIGH** | Lock enforcement is inconsistent between layers. The engine honours `accounting.override_locked`; ten controller validators reject unconditionally. An admin holding the documented override is still blocked on every controller path. | `accounting.controller.js` has 0 references to `override_locked`; `accounting-engine.service.js:60` uses it |
| FY-2 | MEDIUM | `FinancialYearRepository.getActive` / `getByDate` ignore `is_locked`, so every caller must remember to enforce it. `customer-bill.service.js` enforces it **nowhere** across five posting sites. | repository line 276; 0 `is_locked` refs in the service |
| FY-3 | MEDIUM | All 25 genuine `journal_entries` store `financial_year_id = NULL`; year membership is re-derived from `entry_date` at report time, while `vouchers` stores it. Two sources of truth for the same fact. | §3 |
| FY-4 | LOW | `financial_years` has no `updated_at`, so configuration changes are not attributable from the data. | §2 |
| FY-5 | INFO | `fy_2024` is `is_active=0`, holds no transactions, and is now locked. Its intended state is not recorded anywhere. | §2 |

---

## 8. Explicitly NOT concluded

- **I am not recommending that `is_locked` be set to 0.** That is the owner's call.
  Nothing in the database or repository establishes the intended value.
- **I have not verified** what the intended FY configuration was before
  2026-10-09, because no artifact records it. The `…-pre-migration.sqlite`
  backups show `is_locked=0`, but they were produced by the migration runner
  against a **fresh empty database** (`journal_entries=0`) — they are
  fresh-install baselines, not production snapshots, and must not be treated as
  evidence of production's prior state.
- **No writes were performed.** Fingerprint before and after this audit:
  `3fdf4f230b0ee5e9dbf8cffa5abf48ac` — unchanged.

---

## 9. Owner decision required

Whether to unlock `fy_2024` and `fy_2026`, and if so which, remains unresolved
and is deliberately left to the owner. Two inputs that may help:

1. **FY-1 is a genuine design inconsistency** independent of the lock value. Even
   after any unlock decision, an administrator holding `accounting.override_locked`
   cannot use it on any controller path. That is worth fixing regardless.
2. If `is_locked=1` is in fact the intended state for `fy_2026`, then the failing
   tests are correctly asserting that a locked year cannot be posted to — and
   `bill-lifecycle.test.js` would need an unlocked year in its disposable
   database rather than inheriting production's.
