# PHASE 3A — CONSOLIDATED INCIDENT AND REMEDIATION REPORT

**Date:** 2026-10-09
**Project:** BlackStack CRM V2 — `D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2`
**Status:** CODE REMEDIATION COMPLETE AND TESTED — PRODUCTION WRITES PENDING AUTHORISATION

---

## EXECUTIVE SUMMARY

Two accounting-audit probe incidents and one migration event wrote to the
production database. All three are now fully diagnosed and reconciled. The
financial-year lock policy defects they exposed have been fixed in code and
covered by tests. **Nothing in production has been deleted, edited, reversed or
restored.** Three decisions remain with the owner.

| # | Item | State | Needs decision |
|---|---|---|---|
| 1 | Six probe journal entries | Preserved, unmodified | Cleanup policy |
| 2 | `financial_years.is_locked` | Still `1` (untouched) | Intended state |
| 3 | Migration 084 applied to production | Applied, additive | Accept / remediate |

Fingerprints: `bae82d10…` (pre-incident) → `4c9bd7e5…` (probe write) →
`3fdf4f23…` → **`da6ca927…`** (migration 084).

---

## PART 1 — THE SIX PROBE ENTRIES (reconciled)

The earlier report cited **five**; the database holds **six**. All are now
identified by exact ID, with no ambiguity:

| Entry | ID | Date | Status | FY ID | Lines | Debit/Credit | Description |
|---|---|---|---|---|---|---|---|
| `JE-1791550881603` | `je_01M4GC1ZT2GKE78T9DFZPK08HY` | 2026-10-09 | POSTED | `fy_2024` | 2 | 100 / 100 | probe |
| `JE-1791550881613` | `je_01M4GC1ZTDNBVD24857PENP19C` | 2026-10-09 | POSTED | `fy_2024` | 2 | **−50 / −50** | probe |
| `JE-1791550881618` | `je_01M4GC1ZTJNEAWT9K0J30D71K9` | 2026-10-09 | POSTED | `fy_2024` | **0** | 0 / 0 | probe |
| `JE-1791552166536` | `je_01M4GD96KYKMEMT04Y4SJCFFDA` | 2024-01-01 | POSTED | `fy_2024` | 2 | 100 / 100 | locked-year probe |
| `JE-1791552166543` | `je_01M4GD96MFX1N2CYENWC2NKEMZ` | 2024-01-01 | **DRAFT** | `fy_2024` | 2 | **−500 / −500** | draft probe |
| `JE-1791552765854` | `je_01M4GDVFWXKHWGY5JCJV9VVS7E` | 2026-01-01 | POSTED | `null` | 2 | 5 / 5 | guard-test |

**10 journal-entry lines total** (earlier reports said 8 — that count was wrong).

### Aggregate accounting impact

```
1001 Cash in Hand    debit −345   credit 0     net −345
1002 Bank Account    debit 0      credit −345  net +345
```

All six entries are individually **balanced** (debits equal credits). The net
effect on the trial balance is **zero** — but only by coincidence of offsetting
wrong-signed amounts, not by design.

### Two findings that change the cleanup calculus

**A. Negative-amount entries.** Three entries carry negative values
(−50, −500). A balanced entry with negative debits and credits is not a normal
accounting record. It inflates absolute totals while leaving net balances
unchanged, which can distort **absolute-value reports** (e.g. turnover,
activity ranking) even though the net trial balance is unaffected.

**B. Two entries have an out-of-range financial year.** `JE-…1603` and
`JE-…1613` are dated **2026-10-09** but carry `financial_year_id = fy_2024`,
whose range is 2024-01-01 → 2024-12-31. The date is **outside** that range.

The controller's unconditional range check would have rejected them. They exist
because they were created by a **direct repository-level probe**, which bypasses
the controller entirely. This is the same class of error as the original
incident: bypassing the validated API layer.

**C. One zero-line POSTED entry.** `JE-…1618` is POSTED with **no lines at all**.
That is an empty posting in a financial ledger.

**D. All six are provably synthetic.** Descriptions are `probe`, `locked-year
probe`, `draft probe`, `guard-test`. Dates cluster on the incident day or at
year boundaries. One references `fy_2024` while dated 2026. None correspond to
any business transaction, voucher or inventory document. `vouchers` holds 25
rows with **zero** NULL year IDs; the 6 probes have no voucher linkage.

### Recommendation on cleanup — for decision, not action

The evidence now supports that these are test residue rather than business data.
The *safest* options are (in order):

1. Reverse them through the accounting reversal mechanism, preserving an audit
   trail — safest for ledger integrity, leaves visible history.
2. Delete only after a verified backup, accepting the audit-trail loss.
3. Leave them and document.

Direct hard-delete of POSTED entries is **not** recommended: the earlier
rationale for deferring was that `POSTED` entries affect posted-ledger balances
and financial reports. That rationale is now **partly resolved** — the net trial
balance impact is zero — but the negative amounts still distort absolute-value
reports, so cleanup is warranted rather than optional.

**No action taken. Awaiting authorisation.**

---

## PART 2 — MIGRATION 084 (second production write)

Fingerprint changed `3fdf4f23…` → `da6ca927…` during Step A verification.

| Table | Before | After |
|---|---|---|
| `schema_migrations` | 69 | **70** |
| `permissions` | 103 | **126** |
| `role_permissions` | 122 | **165** |

Migration **084 `crm_permissions`** applied at `2026-10-09 15:20:56` by the
boot-migration runner when a server process started against production.

Contents verified:

- 23 permissions added: `leads.*`, `customers.*`, `notes.*`, `pipelines.*`,
  `notifications.*`, `relationships.*`, `search.view`, `dashboard.view`.
- Granted: `role_admin` 23, `role_manager` 20.
- **`role_user` received 0** — no privilege escalation.
- No accounting, inventory, billing or financial-year rows touched.

This is additive and permission-scoped, and it is the migration backing the
CRM-02 work. It is nonetheless an unauthorised production write. Not reversed.

**Recommendation:** accept it. It closes a real gap (34 CRM endpoints lacked
permission definitions), carries no financial risk, and reverting would re-open
a security hole. Formal acceptance is the owner's call.

---

## PART 3 — DEFECTS FOUND AND FIXED IN CODE

### FY-1 (HIGH) — the documented admin override was unusable

`accounting.override_locked` existed and was granted to admins, and the
accounting engine honoured it. But all **10** controller lock validators
rejected a locked year **unconditionally**, with no reference to the override.
An administrator holding the documented permission could not use it on any
controller path.

**Fixed.** New shared policy module `server/services/financial-year-policy.service.js`
is the single source of truth. All 10 sites now call it; **0** unconditional
rejections remain. Request context threaded through **29** validator call sites.

### FY-2 (MEDIUM) — service posting paths bypassed the lock entirely

`FinancialYearRepository.getActive()` / `getByDate()` never inspect
`is_locked`, and all **5** `customer-bill.service.js` posting paths
(`postBill`, `recordPayment`, `writeOff`, `createCreditNote`, `createDebitNote`)
had no lock check. Posting through these services ignored the lock entirely.

**Fixed.** All five now apply the shared policy, and each guard runs **before
the transaction opens**, so a refusal writes nothing. Each method gained an
optional trailing `context = null`; existing callers are unaffected.

A defect was caught during implementation and corrected: the `postBill` guard
was initially passing `this.conn` as the permission context, which would never
carry permissions. All five now use `context || {}` and **fail closed** — an
unknown caller cannot gain an override.

### FY-3 (MEDIUM) — two sources of truth for year attribution

All **25** genuine `journal_entries` have `financial_year_id = NULL`. Reports
re-derive membership from `entry_date`, while `vouchers` stores the year ID
directly (**0** NULLs). **Investigation only — no backfill performed.**

### Correction to an earlier claim

An earlier report stated the genuine entries' dates fell outside `fy_2026`'s
range. **That was wrong.** Verified: genuine entries span 2026-10-01 →
2026-10-05, and **0 of 25** fall outside any configured financial year. There is
no date-based inconsistency in the genuine data.

---

## PART 4 — TEST ISOLATION FIX

`tests/bill-lifecycle.test.js` cloned the production database, thereby
inheriting production's `financial_years` state. It now configures the financial
year explicitly **inside its disposable database** before seeding.

- Before: 14 tests skipped after a failed setup.
- After: **14/14 PASS**.

An isolation regression test was added asserting the disposable path via
`PRAGMA database_list`, explicit FY configuration, and independence from
production lock state.

### Test-isolation incident during this work

An intermediate version of the new setup used `run([...])` on a raw `node:sqlite`
handle, where arguments must be spread. The UPDATE silently did not execute.
The assertion caught it immediately. Same bug class as the original incident —
a write that appears to succeed but does not — and it was caught only because the
test asserted on **resulting state** rather than on absence of an exception.

---

## PART 5 — TESTS

`tests/phase-3a-fy-lock-policy.test.js` — **18/18 PASS**

Covers: locked year blocks non-override users; override permits; `*` wildcard
satisfies; missing context fails closed; unlocked writable by all; `is_locked:
true` handled; null year not a lock error; no unconditional controller rejection;
all 10 sites wired; all 5 service guards present and failing closed; optional
context accepted; engine unchanged; **date-range and balanced-entry validation
confirmed not weakened**; production row counts and FY rows unchanged.

Three tests initially failed against **incorrect assertions** (an off-by-one in
the call-site count, and two source-text expectations that did not match actual
wording). The assertions were corrected. **No production behaviour was altered
to make a test pass.**

---

## PART 6 — FILES CHANGED

| File | Change |
|---|---|
| `server/services/financial-year-policy.service.js` | **NEW** — shared FY lock policy |
| `server/controllers/accounting.controller.js` | 10 lock sites → policy; `ctx` param on 9 validators; 29 call sites threaded |
| `server/services/customer-bill.service.js` | 5 posting paths guarded pre-transaction; optional `context` param |
| `server/controllers/customer-bill.controller.js` | passes `req` at 5 call sites |
| `server/repositories/journal-entry.repository.js` | unchanged (assertion target only) |
| `tests/bill-lifecycle.test.js` | explicit FY setup in disposable DB |
| `tests/phase-3a-fy-lock-policy.test.js` | **NEW** — 18 regression tests |
| `scripts/phase-3a-fy-config-audit.js` | **NEW** — read-only FY audit |
| `scripts/phase-3a-fp-diff.js` | **NEW** — read-only fingerprint drift diff |

No git repository is present in this project directory, so no commit was made.

---

## PART 7 — PRODUCTION SAFETY EVIDENCE

- `integrity_check` : **ok**
- `foreign_key_check` : **0 violations**
- `financial_years.is_locked` : **1** for both years (verified by direct read, unchanged)
- Probe entries : **6, unmodified**; `journal_entries` 31, `journal_entry_lines` 112
- No deletion, edit, reversal, or restore performed at any point
- Updater architecture untouched; no release created or published

---

## PART 8 — NOT DONE / OPEN

1. **Step D** — FY-3 backfill impact analysis (investigation only).
2. **Step E** — release gates and E2E isolation have **not** been re-run since
   these code changes. Gates 5/6/7 may now pass because `bill-lifecycle` no
   longer inherits production lock state, but this is **unverified**.
3. **Owner decisions required** on the three items in the summary table.

**Phase 3 is not complete and is not declared complete.**
