# PHASE 3A — FINAL SAFETY VERIFICATION AND GATE RUN

**Date:** 2026-10-09
**Status: INCOMPLETE — 14/16 gates. Two blocking failures remain.**
**Cleanup A and B: NOT AUTHORIZED. Nothing deleted.**
**Production fingerprint `5a0215eb…` unchanged before and after every run.**

---

## 1. STATE DISTINCTIONS (as required)

| State | Status |
|---|---|
| **READY TO RUN** | **ACHIEVED** — harness audited, isolation proven, guard verified able to fail |
| **VERIFICATION PASSED** | **NOT ACHIEVED** — 14/16; gates 5 and 6 fail |
| **CLEANUP AUTHORIZED** | **NOT GRANTED** — A and B both remain on HOLD |

These are separate. Readiness was reached; verification was not; cleanup was
never authorized.

---

## 2. PREFLIGHT — PRODUCTION UNTOUCHED

Resolved path: `…\blackstack-crm-v2\data\blackstack-crm.db`, `DB_PATH` unset.
Live connection inspected via `PRAGMA database_list`; `bound path: not yet bound`,
`path drift: null`, `open connections: 0`.

| Metric | Expected | Actual | Status |
|---|---|---|---|
| `journal_entries` | 31 | 31 | OK |
| `journal_entry_lines` | 112 | 112 | OK |
| `bills` | 1 | 1 | OK |
| `audit_logs` | 431 | 431 | OK |
| `financial_years.is_locked` | 1 / 1 | 1 / 1 | OK |
| `CUSTOMER_BILL.next_seq` | 2 | 2 | OK |
| production records deleted | 0 | 0 | OK |

`integrity_check: ok`, `foreign_key_check: 0 violations`.

---

## 3. HARNESS AUDIT — DEFECTS FOUND AND FIXED

### 3.1 Two unguarded suites reached production-capable code

Of the 21 files gates 5/6 execute, two opened a database without calling the
disposable guard:

- `tests/data-safety.test.js` — builds a temp clone, sets `process.env.DB_PATH`
  **at runtime**, and contains a `DROP TABLE IF EXISTS tasks`
- `tests/auth-crud.integration.test.js` — mints a temp path, passes `DB_PATH` to
  every child process

The `DROP` targets a `.broken` scratch copy, so it was never a live threat — but
both relied on the *environment variable* being honoured, which is exactly the
assumption that failed on 2026-10-09. Both now assert against the real open file.

### 3.2 The guard was refusing suites that were safe

Adding the guard produced `REFUSING TO WRITE — data-safety is bound to the WRONG
DATABASE`. Investigating rather than suppressing it found three genuine defects:

**Defect A — the guard inspected a historical log, not what was open.**
`_openedConnections()` returns *every handle ever created*, including closed ones.
A closed handle cannot write, so treating it as "open" made the guard refuse any
suite that cycles disposable databases — `data-safety` builds a fresh one per
test. Fixed by adding `_liveConnections()` and inspecting only that.

**Defect B — `createDisposableDb()` never set `process.env.DB_PATH`.**
It returned `dbPath` and trusted the caller to assign it. Since `connection.js`
resolves `process.env.DB_PATH || <production>` on every `connect()`, a caller that
connected before assigning silently opened **production**. Now assigned when unset.

**Defect C — `migrate()` leaked its connection.**
`server/database/migrate.js` opens a connection and returns it; `safeMigrationRunner`
did `await migrate()` and discarded the handle, leaving a live binding that made
the process look pinned to that file. The handle is now closed by the caller.

### 3.3 A regression I introduced, and caught

Making `createDisposableDb()` assign `DB_PATH` **unconditionally** masked the
mis-bound case: a caller that had already opened production and *then* called the
helper got `DB_PATH` pointed at the throwaway copy, so the live-connection check
saw environment and file "agreeing" and allowed the run.

That is precisely what `CASE 1` in `tests/phase-3a-db-isolation-guard.test.js`
exists to catch, and it started reporting `GUARD_DID_NOT_REFUSE`. Fixed by
assigning only when `DB_PATH` is unset. **CASE 1 is the test that saved the guard
from being quietly defeated by my own fix.**

### 3.4 Verification-harness defects

- **ANSI codes broke result parsing.** vitest writes colour escapes between
  `Tests` and the count, so `/Tests\s+(\d+)\s+passed/` never matched; four passing
  suites reported "no result line" and looked like failures.
- **`spawnSync('npx', …)` cannot exec on Windows.** `npx` is a `.cmd` shim, so the
  call returned `status === null` — indistinguishable from a timeout.

Both would have produced a false FAIL, never a false PASS.

### 3.5 Guard proven capable of failing

| Case | Result |
|---|---|
| production path | **refused** |
| `DB_PATH` unset | **refused** |
| unmarked filename | **refused** |
| live production connection vs disposable expectation | **DETECTED** |
| closed handle | correctly ignored |

---

## 4. TEST RESULTS

```
PRE : 5a0215ebba657c679c412d8ff8935497
COMMAND : E2E_PORT=32537 npm run test:release
EXIT    : 1
```

| Gate | Result |
|---|---|
| 1 live database present | PASS |
| 2 architecture guard | PASS — 3 |
| 3 env-isolation guard | PASS — 3 |
| 3 migration idempotency | PASS — 5 |
| 4 authorization | PASS — 23 |
| 4 update/data-safety contract | PASS — 29 |
| 4b update lifecycle | PASS — 57 |
| 4 bill lifecycle + reconciliation | PASS — 14 |
| **5 unit/integration (parallel)** | **FAIL — exit 1** |
| **6 unit/integration (serial)** | **FAIL — exit 1** |
| 7 E2E regression | PASS — 26 |
| 8 reverse-order E2E | PASS — 7 |
| 9 live database CONTENT unmodified | **PASS — content identical** |
| 9 integrity_check | PASS — ok |
| 9 foreign_key_check | PASS — 0 |
| 9 stock ledger reconcile | PASS — 2 / 2 |

**14/16 gates passed.**

Full vitest run: **523 passed, 1 failed, 524 total** across 21 files.

**Gate 9 now passes** — the 2026-10-09 leak is closed; the gate run no longer
writes to production. Previously this was the blocking failure.

`POST: 5a0215eb…` — **fingerprint unchanged.**

---

## 5. THE ONE FAILING TEST — PRE-EXISTING, NOT MINE

```
× update/migration failure recovery > stale-lock recovery still works
  expected 'MIGRATION_FAILED' to be 'OK'
```

`tests/phase3-update-enterprise.test.js` was **not modified in this session**, and
the test still fails with `connection.js`, `safeMigrationRunner.js` and
`migrate.js` all reverted to their pre-session state — verified empirically, not
asserted.

**Root cause:** its `makeCrmDb()` fixture seeds
`schema_migrations(version 1, name 'test', sha256 'abc')`. Migration 001 is
therefore treated as already applied with a mismatched checksum, so its DDL never
runs, and migration 014 (`indexes`) then fails:

```
Migration 14_indexes failed: no such column: organization_id.
```

Reproduced standalone. The fixture needs a valid checksum (or to seed no rows and
let migrations run).

---

## 6. CLEANUP PLANS — REVIEWED, NOT APPLIED

### Option A — six journal entries, ten lines

All six entry IDs and all ten line IDs are archived with full rows.
Dependency sweep across every table: only their own `journal_entry_lines`.
Zero `accounting_audit`, `audit_logs` or `vouchers` rows reference any of them.

### Option B — `BILL-2026-00001`, four dependents

`journal_entry_id` is NULL, so **no ledger impact**. Dependents:
1 `bill_items`, 1 `receivables`, 2 `accounting_audit`. No payment, allocation or
voucher links.

### Rehearsal result (throwaway clone)

| | je | jl | bills | auditLogs | seq | net |
|---|---|---|---|---|---|---|
| before | 31 | 112 | 1 | 431 | 2 | 0 |
| after A | 25 | 102 | 1 | 431 | 2 | 0 |
| after B | 25 | 102 | 0 | 431 | 2 | 0 |

`integrity_check: ok`, `foreign_key_check: 0`, trial balance 8100 = 8100,
25 genuine entries intact, `audit_logs` preserved, sequence **not** reset.

**Neither option was executed.**

---

## 7. ARTIFACT PRESERVATION

- Audit reports: 10 files, copied outside the project tree
- Changed source files: 20 files preserved to
  `%LOCALAPPDATA%\Temp\bs-backup2-20261009-214827\final`
- Backups: `bs-backup-20261009-205746` (pre-leak) and
  `bs-backup2-20261009-214827` (current) — both verified restorable by copying
  to a scratch path, opening, integrity/FK/writability checking

No backup was restored over production. No Git repository was created.

---

## 8. REMAINING BLOCKERS

| # | Blocker | Recommended fix |
|---|---|---|
| 1 | `phase3-update-enterprise.test.js` stale-lock test fails, blocking gates 5 and 6 | Fix `makeCrmDb()` to seed a real checksum for migration 1, or seed nothing so migrations apply. **Not fixed here** — it is outside this phase's authorised scope and is a test-fixture defect, not a product defect. |
| 2 | Gate 9 passes but the leaked bill remains | Execute cleanup A and/or B once authorised |
| 3 | Two previously-leaking suites had no guard before today | Now guarded and covered |

---

## 9. CONCLUSION

**Phase 3A is INCOMPLETE.** Verification has NOT passed: 14/16 gates, with gates
5 and 6 blocked by a pre-existing test-fixture defect that this phase did not
introduce and is not authorised to fix.

Cleanup A and B remain **NOT AUTHORIZED**. No production record was deleted. No
financial-year lock, bill sequence, audit history or genuine accounting record was
modified. The production database is byte-for-byte unchanged
(`5a0215eb…`).
