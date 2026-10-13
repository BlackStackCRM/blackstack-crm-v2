# PHASE 3A — FIXTURE REPAIRED, 16/16 GATES PASS

**Date:** 2026-10-09
**Command:** `E2E_PORT=32543 npm run test:release` → **EXIT=0, 16/16 gates**
**Full vitest:** **524 passed, 0 failed, 21/21 files**
**Production fingerprint:** `5a0215eb…` — identical before and after every run.

---

## 1. FINAL STATE

| Criterion | Previous | Now |
|---|---|---|
| **READY TO RUN** | achieved | achieved |
| **VERIFICATION PASSED** | **14/16** | **16/16 — PASSED** |
| **CLEANUP AUTHORIZED** | not granted | **still not granted** |

Gate output, verbatim:

```
[PASS] gate 1: live database present
[PASS] gate 2: architecture guard (retired tables)          Tests 3 passed
[PASS] gate 3: env-isolation guard (process.env)            Tests 3 passed
[PASS] gate 3: migration idempotency                        Tests 5 passed
[PASS] gate 4: authorization (401/403/2xx)                  Tests 23 passed
[PASS] gate 4: update/data-safety route contract            Tests 29 passed
[PASS] gate 4b: Phase C update lifecycle                    Tests 57 passed
[PASS] gate 4: bill lifecycle + reconciliation               Tests 14 passed
[PASS] gate 5: unit/integration (parallel)                  Tests 524 passed
[PASS] gate 6: unit/integration (serial)                    Tests 524 passed
[PASS] gate 7: E2E regression (isolated DB)                 Tests 26 passed
[PASS] gate 8: reverse-order E2E                            Tests 7 passed
[PASS] gate 9: live database CONTENT unmodified             content identical
[PASS] gate 9: PRAGMA integrity_check                      ok
[PASS] gate 9: foreign_key_check                            0 violations
[PASS] gate 9: stock ledger/balances reconcile              ledger=2 balances=2

16/16 gates passed
RELEASE GATE: PASS
```

---

## 2. THE FIXTURE DEFECT — TWO CAUSES, NOT ONE

The previous report blamed the seeded checksum `sha256='abc'`. That was **only
half the cause**. Fixing it alone left the test failing, so I kept digging.

### Cause 1 — fake checksum (fixed)

`makeCrmDb()` seeded `schema_migrations(version 1, name 'test', sha256 'abc')`.
`migrate()` compares the stored checksum against the real file hash; a mismatch
means "already applied, file changed later", so it rewrites the checksum and
`continue`s — **the DDL never runs**. The fixture claimed version 1 was applied
when its schema did not exist.

Now seeded with the genuine SHA-256 of the matching migration file.

### Cause 2 — a stub `contacts` table (the real cause)

The fixture also ran `CREATE TABLE IF NOT EXISTS contacts (id, name)`.
Migration 002 creates the **full** `contacts` table — including
`organization_id` — but as `CREATE TABLE IF NOT EXISTS`. The stub already
occupied that name, so 002 became a no-op and migration 014 then ran:

```
CREATE INDEX IF NOT EXISTS idx_contacts_organization ON contacts(organization_id);
```

against a two-column table, failing with
`no such column: organization_id`.

Verified independently against a **genuinely empty** database: all migrations
apply cleanly and `contacts` ends up with its full column set including
`organization_id`. The stub was the cause; the checksum alone could not have
cured it.

No migration ever adds `contacts.organization_id` by `ALTER` — migration 002
creates it, so anything that pre-creates the table permanently loses it.

### Cause 3 — the test's own sequence was impossible

The stale-lock test planted a stale lock and asked for recovery **on a database
that had never been migrated**. Its "recovery" run was the first migration the
database ever saw, so it could only fail. The scenario the guard exists for is:
migrations ran, a later run was interrupted, the next run recovers. The test now
migrates first, then plants the lock.

---

## 3. CHANGES TO `tests/phase3-update-enterprise.test.js`

- `makeCrmDb()` seeds a **real** SHA-256 for the claimed migration version
- `makeCrmDb()` **no longer pre-creates `contacts`** — migrations own the schema
- new `runMigrations()` helper applies the real migrations
- new `makeContacts(dbPath, count)` seeds rows into an **already-migrated**
  `contacts` table
- the stale-lock test migrates first, then simulates the interrupted run
- two backup/restore tests updated to migrate-then-seed

**No assertion was weakened.** The file still contains **31 `expect()` calls**,
and the contact-count expectations (7 and 3) are unchanged — they now verify
rows in the real schema rather than in a stub.

No production code was changed to make this pass.

---

## 4. PRODUCTION VERIFICATION AFTER THE FULL GATE RUN

| Metric | Expected | Actual | Status |
|---|---|---|---|
| `content fp` | `5a0215eb…` | `5a0215eb…` | unchanged |
| `journal_entries` | 31 | 31 | OK |
| `journal_entry_lines` | 112 | 112 | OK |
| `bills` | 1 | 1 | OK |
| `audit_logs` | 431 | 431 | OK |
| `financial_years.is_locked` | 1 / 1 | `fy_2024=1, fy_2026=1` | OK |
| `CUSTOMER_BILL.next_seq` | 2 | 2 | OK |
| `permissions` | 126 | 126 | OK |
| `vouchers` | 25 | 25 | OK |
| genuine journal entries | 25 | 25 | OK |
| probe entries | 6 | 6 | OK |
| `integrity_check` | ok | ok | OK |
| `foreign_key_check` | 0 | 0 | OK |

Gate 9 independently confirms the run did not modify production content.

---

## 5. CLEANUP STATUS — UNCHANGED

**A — six synthetic journal entries + 10 lines: NOT AUTHORIZED.**
**B — `BILL-2026-00001` + 4 dependent records: NOT AUTHORIZED.**

Both remain on HOLD. No bill or journal record was deleted. No FY lock, bill
sequence, audit history or genuine accounting record was modified. The leaked
bill is still present — which is why gate 9 now passes *with* it rather than
because of it: the leak **path** is closed, the leaked **data** is not yet removed.

---

## 6. PRESERVATION

- `tests/phase3-update-enterprise.test.js` copied to
  `%LOCALAPPDATA%\Temp\bs-backup2-20261009-214827\final\`
- 10 audit reports and 20 changed source files preserved outside the project tree
- Both DB backups intact and previously verified restorable by actual copy-and-open
- No backup restored over production; no Git repository created

---

## 7. CONCLUSION

**Verification PASSED: 16/16 gates, exit 0, 524/524 tests.** The production
database is byte-for-byte unchanged.

**Phase 3A is NOT complete.** Cleanup A and B are still unauthorized, and the
six probe entries plus the leaked bill remain in production pending your
explicit, separate approval for each.

---

## 8. OWNER ACKNOWLEDGEMENT — 2026-10-09

Recorded at owner instruction:

> "പരിശോധനാ ഗേറ്റുകൾ വിജയിച്ചതായി രേഖപ്പെടുത്താം. എന്നാൽ A, B നടപടികൾക്ക് അനുമതി ലഭിക്കുന്നതുവരെ അവ നടപ്പാക്കരുത്."

Translation: the release gates passing is recorded; A and B must **not** be
executed until authorization is given.

Accordingly:

| Item | State |
|---|---|
| Release verification | **PASSED — recorded** |
| Cleanup A | **HOLD — not executed** |
| Cleanup B | **HOLD — not executed** |
| Phase 3A | **not complete** |
| Phase 3 overall | **not complete — not yet determined** |

The owner's further instruction is to examine the remaining Phase 3 core-module
issues before Phase 3 is declared complete. That examination is read-only; no
production mutation is implied or permitted by it.
