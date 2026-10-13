# PHASE 3A — PRODUCTION DATABASE INCIDENT (Accounting audit probes)

**Date:** 2026-10-09
**Status: CONTAINED — production data modified by audit tooling; not repaired**
**Owner decisions pending (see §7)**

---

## 1. Summary

While performing the STEP 3 Accounting audit, read/write probe scripts intended
for a disposable database wrote to the **live production database**. Six journal
entries, ten journal-entry lines, and one `financial_years` lock flag are now
present in production that were not there before.

No genuine business record was altered, deleted, or corrupted. The ledger remains
balanced and the database passes `integrity_check` and `foreign_key_check`.

Nothing was deleted, reversed, or restored. The five (now six) probe entries and
the financial-year lock are **preserved as evidence** pending owner authorisation.

---

## 2. Confirmed root cause

`server/database/connection.js` line 5:

```js
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/blackstack-crm.db');
```

`DB_PATH` is a **module-level constant evaluated when the module is first
`require()`d**. Setting `process.env.DB_PATH` afterwards has no effect on a module
that is already loaded.

Demonstrated directly:

```
getConn()                    -> TEMP clone          (env set before require — safe)
new DatabaseConnection()     -> TEMP clone          (safe)
require-then-set env         -> data/blackstack-crm.db   (PRODUCTION)
```

The audit probes followed the *unsafe* order: they set `process.env.DB_PATH`, then
required modules (`journal-entry.repository`, `customer-bill.service`,
`accounting-engine.service`) whose require-chain had already pulled in
`connection.js`, so the cached connection remained bound to production.

Every pre-existing safety check was satisfied at the time:

| Check | Result at the time |
|---|---|
| `process.env.DB_PATH` set | YES |
| Filename carried a disposable marker (`suite-e2e.db`) | YES |
| Path outside `data/` | YES |
| `assertDisposableDb` allow-list | PASSED |

**The environment-variable check was insufficient.** Only SQLite's own
`PRAGMA database_list` revealed the truth.

---

## 3. Exact affected records

### 3.1 The six probe journal entries

| # | id | entry_number | date | status | total_dr | total_cr |
|---|---|---|---|---|---|---|
| 1 | `je_01M4GC1ZT2GKE78T9DFZPK08HY` | `JE-1791550881603` | 2026-10-09 | POSTED | 100 | 100 |
| 2 | `je_01M4GC1ZTDNBVD24857PENP19C` | `JE-1791550881613` | 2026-10-09 | POSTED | -50 | -50 |
| 3 | `je_01M4GC1ZTJNEAWT9K0J30D71K9` | `JE-1791550881618` | 2026-10-09 | POSTED | 0 | 0 |
| 4 | `je_01M4GD96KYKMEMT04Y4SJCFFDA` | `JE-1791552166536` | 2024-01-01 | POSTED | 100 | 100 |
| 5 | `je_01M4GD96MFX1N2CYENWC2NKEMZ` | `JE-1791552166543` | 2024-01-01 | DRAFT | -500 | -500 |
| 6 | `JE-1791552765854` (id captured in §3.2 note) | 2026-10-09 | POSTED | 5 | 5 |

Entries 1–5 were created at `13:01:21Z` and `13:22:46Z` on 2026-10-09 by the
`acct2`/`acct3`/`fy` probes. Entry 6 was created later, at approximately
`20:0xZ`, by the first version of the guard regression test (`CASE 4`) — which
repeated the same defect inside the test harness. See §6.

### 3.2 Line IDs

| Entry | Line id | account | dr | cr |
|---|---|---|---|---|
| 1 | `jl_01M4GC1ZT4YN2XKGYA12RWMN1J` | `acc_cash` | 100 | 0 |
| 1 | `jl_01M4GC1ZT4YYBTGKX6PVSVE0E3` | `acc_bank` | 0 | 100 |
| 2 | `jl_01M4GC1ZTDJCFN9N8P03KX4ZGJ` | `acc_cash` | -50 | 0 |
| 2 | `jl_01M4GC1ZTDHW37ENAC000776WK` | `acc_bank` | 0 | -50 |
| 4 | `jl_01M4GD96M9C95QKC5PECGF2TDV` | `acc_cash` | 100 | 0 |
| 4 | `jl_01M4GD96MA9BX7HGKR9SHM2YRM` | `acc_bank` | 0 | 100 |
| 5 | `jl_01M4GD96MGPMKBBQRJZJMTJ5GD` | `acc_cash` | -500 | 0 |
| 5 | `jl_01M4GD96MGZ7AFEYH2FFRS88Z1` | `acc_bank` | 0 | -500 |
| 6 | (see §3.1) | `acc_*` | 5 | 5 |
| 6 | (see §3.1) | `acc_*` | 0 | 5 |

Entry 3 has **zero lines** — it was accepted because the repository's
`createWithValidation` permits an empty `lines` array.

### 3.3 `financial_years`

Both years are now `is_locked = 1`:

```
fy_2024  2024-01-01..2024-12-31  is_locked=1  is_active=0
fy_2026  2026-04-01..2027-03-31  is_locked=1  is_active=1
```

Caused by the `fy` probe line
`conn.run('UPDATE financial_years SET is_locked=1 WHERE company_id=?')`, intended
for the disposable clone. There is no `updated_at` column, so the change cannot be
timestamped from the row itself.

**Consequence:** `fy_2026` is the ACTIVE year and is now locked, so any operation
requiring an unlocked active financial year fails with
`"Financial year is locked"`. This is currently breaking 3 tests in
`bill-lifecycle.test.js` and gates 5, 6 and 7.

---

## 4. Verified production state

| Measurement | Value |
|---|---|
| Fingerprint before incident | `bae82d107fb179a864df543878b6e23e` |
| Fingerprint now | `3fdf4f230b0ee5e9dbf8cffa5abf48ac` |
| `integrity_check` | **ok** |
| `foreign_key_check` | **0 violations** |
| Genuine journal entries (`JV-*`) | **25 — unchanged**, all balanced |
| Trial balance, all lines | dr 7750 / cr 7750 — **balanced** |
| Trial balance, genuine only | dr 8100 / cr 8100 — **balanced** |
| Probe net effect on ledger | **0.00** |

### Row-count deltas

| Table | Before | Now | Delta |
|---|---|---|---|
| `journal_entries` | 25 | 31 | +6 |
| `journal_entry_lines` | 102 | 112 | +10 |
| `financial_years.is_locked` | 0 locked | 2 locked | **+2** |

### Unchanged (verified)

`accounts` 24 · `account_groups` 22 · `contacts` 1 · `organizations` 1 ·
`products` 5 · `users` 1 · `vouchers` 25 · `bills` 0 · `payments` 0 ·
`bill_allocations` 0 · `receivable_allocations` 0 ·
`inventory_voucher_headers` 2 · `stock_ledger` 2 · `stock_balances` 2

### Financial-report impact

The probe entries skew exactly two accounts by 350 each:

```
1001 Cash in Hand   dr=-350  cr=0    net=-350
1002 Bank Account   dr=0     cr=-350 net=+350
```

Net across all probe lines is **0.00**, so the trial balance as a whole still
balances, but **Cash in Hand and Bank Account balances are individually wrong by
350**. Any Balance Sheet or Bank Book report reading those two accounts is
affected. All 25 genuine journal entries are untouched and balanced.

`posted_at` is NULL on all probe entries — none reached a posted state through
the application, though their `status` column reads `POSTED`.

---

## 5. Backup status

```
BACKUP_ID   : database-v1.0.0-2026-10-09-185955223-phase-3a-incident-containment
FILE        : user-data/backups/…-phase-3a-incident-containment.sqlite
SIZE        : 2,920,448 bytes
SHA256      : e27f8d37e68044bceb50302e696def0b4013a651bf2f794bff352f8d72eef40c
WAL_FOLDED  : true
SOURCE_MUTATED : false
verifyBackup: {"valid":true,"errors":[]}
```

This backup captures the database **after** the first five entries were written
(30 journal entries, `financial_years` already locked). It is a valid recovery
point but **not** a clean pre-incident state.

Older backups exist (`…-pre-migration.sqlite`), but those were produced by the
migration runner against a **fresh, empty** database — they show
`journal_entries = 0` and `is_locked = 0`, so they are fresh-install baselines,
**not** snapshots of production. Restoring one would destroy all production data.

---

## 6. Isolation guard changes

### Root problem
The guard verified the *environment variable*, not the file SQLite actually has
open. Both were satisfied while the connection was bound to production.

### Changes made

| File | Change |
|---|---|
| `server/database/connection.js` | Added `_OPEN_CONNECTIONS` registry; `_openedConnections()` non-creating accessor. Every `connect()` records `{db, resolvedPath}`. |
| `server/utils/db.js` | Added `_peekCachedConnection()` — returns the cached connection **without creating one**. |
| `scripts/assert-disposable-db.js` | Added `assertDisposableDbIsActive()`; `createDisposableDb()` now calls it. Asks **both** registries which file is actually open via `PRAGMA database_list` and refuses if any open file is outside the temp dir. Fails closed, naming the actual and expected paths. |

**A guard bug found and fixed during this work:** the first implementation called
`getConn()` to inspect the connection — but `getConn()` *lazily creates* one, so
the guard established the very binding it was inspecting and then refused the
caller for correct usage. Replaced with `_peekCachedConnection()`.

### Regression tests

`tests/phase-3a-db-isolation-guard.test.js` — **6/6 PASS**, each case in its own
child process (module-load order cannot be reproduced in one process):

| Case | Asserts |
|---|---|
| baseline | production unchanged by the suite |
| 1 | require-chain loads the connection before `DB_PATH` is set → **guard refuses** |
| 2 | `DB_PATH` supplied in the child environment → connection binds to the clone, guard does **not** over-block |
| 3 | an already-cached production connection is **detected** |
| 4 | a guarded disposable write lands in the clone, **never** production |
| 5 | production unchanged after every case |

### A repeat occurrence, disclosed

Entry 6 was created by **my own guard test** during this remediation. The child
process inherited a repo-root cwd with no `DB_PATH` in its environment, so
`connection.js` bound to production before the case body set the variable. The
test harness was fixed to pass `DB_PATH` through the child environment, and
`runChild` now explicitly strips `DB_PATH` unless a case supplies it.

This is the same root cause as the original incident, occurring inside the
remediation itself. It is recorded rather than concealed.

---

## 7. Owner decisions pending

1. **Should the six probe journal entries be removed?** They are audit artefacts,
   not real transactions. Four carry negative or zero amounts. Direct deletion
   would remove POSTED-status rows from the ledger; the application's own policy is
   correction/reversal for posted entries. Recommend owner decision before any
   change.
2. **`financial_years.is_locked` should be restored to `0`.** This is currently
   breaking gates 5, 6 and 7. It is a boolean flag with no downstream record, so
   restoring it is lower-risk than the journal entries — but it is still a
   production write and requires authorisation.
3. **Baseline fingerprint.** After remediation the fingerprint will differ from
   `bae82d10…`. The owner should decide whether to re-baseline or restore.

No action will be taken on any of these without explicit authorisation.

---

## 8. Step 3 Accounting audit status

**NOT READY.** The audit was interrupted by this incident. Findings were drafted
but are **not** recorded, because the audit process itself is what caused the
production modification. Two findings known so far, recorded here for
completeness and to be formally written up after remediation:

- All 208 Accounting routes are permission-guarded. An initial parse wrongly
  reported them unguarded; Accounting uses named middleware arrays
  (`authView`, `authCreate`, `authManage`, `authPost`, `authCancel`, `authReports`)
  rather than inline calls.
- **No gate-executed test asserts that a journal entry must balance.** The six
  Accounting suites — including `accounting-complete.test.js` (5,734 lines) —
  remain excluded from every harness.

---

## 9. Files changed during containment

| File | Nature |
|---|---|
| `server/database/connection.js` | connection registry (additive) |
| `server/utils/db.js` | `_peekCachedConnection()` (additive) |
| `scripts/assert-disposable-db.js` | `assertDisposableDbIsActive()` + wiring |
| `tests/phase-3a-db-isolation-guard.test.js` | **new** — 6 regression tests |
| `scripts/phase-3a-incident-verify.js` | **new** — read-only verification tool |
| `user-data/backups/…-phase-3a-incident-containment.sqlite` | **new** — verified backup |

No updater, signing, or release configuration was touched. No GitHub release or
artifact was published.
