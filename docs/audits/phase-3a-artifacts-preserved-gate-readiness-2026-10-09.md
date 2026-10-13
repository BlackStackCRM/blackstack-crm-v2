# PHASE 3A — ARTIFACTS PRESERVED; POST-CLEANUP GATE VERIFICATION PREPARED

**Date:** 2026-10-09
**Owner decisions in force:** A — HOLD. B — HOLD. FY locks — keep `1 / 1`.
Bill sequence — keep `next_seq = 2`.
**Status:** NOTHING DELETED. Gate suite PREPARED BUT NOT RUN.
**Production fingerprint:** `5a0215eb…` — unchanged across this entire phase.

---

## 1. OWNER DECISION RECORDED

> "ഇപ്പോഴും A, B രണ്ടും HOLD-ൽ തുടരട്ടെ. പരിശോധനകൾ വിജയിച്ചതുകൊണ്ട് മാത്രം production-ൽ records delete ചെയ്യാനുള്ള അനുമതി ലഭിക്കുന്നില്ല."

Successful verification is **not** authorization. Noted explicitly: no record is
deleted until you acknowledge and authorize A and B **separately**.

---

## 2. ARTIFACTS PRESERVED

Copied to `%LOCALAPPDATA%\Temp\bs-backup2-20261009-214827\artifacts\` — 10 files:

| Artifact |
|---|
| `phase-3a-cleanup-evidence-2026-10-09.json` (full row payloads, 197 KB) |
| `phase-3a-cleanup-evidence-2026-10-09.md` |
| `phase-3a-cleanup-evidence-and-snapshot-2026-10-09.md` |
| `phase-3a-cleanup-verification-final-2026-10-09.md` |
| `phase-3a-isolation-fix-and-cleanup-plans-2026-10-09.md` |
| `phase-3a-followup-gate-recovery-2026-10-09.md` |
| `phase-3a-fy-lock-fixes-2026-10-09.md` |
| `phase-3a-consolidated-incident-report-2026-10-09.md` |
| `phase-3a-fy-config-audit-2026-10-09.md` |
| `phase-3-a-incident-2026-10-09.md` |

All **14 changed source files** preserved alongside them in `.../changed/`.

Both DB backups remain in place and restorable:
`bs-backup-20261009-205746` (pre-leak) and `bs-backup2-20261009-214827` (current).

---

## 3. POST-CLEANUP GATE VERIFICATION — PREPARED, NOT RUN

`scripts/phase-3a-gate-readiness.js`

It deliberately **does not run the gate suite**. It answers only: *would running
it be safe?* so that when cleanup is authorized, verification is one deliberate
step rather than an improvisation.

### Result: READY — 0 blocking failures

```
--- 1. production state (must still be PRE-cleanup) ---
  [OK] journal_entries == 31 (25 genuine + 6 probes)      — 31
  [OK] journal_entry_lines == 112                          — 112
  [OK] bills == 1 (the leaked BILL-2026-00001, not yet removed) — 1

--- 2. preserved-by-decision state ---
  [OK] two financial years present                         — 2
  [OK] BOTH financial years still is_locked = 1            — fy_2024=1 fy_2026=1
  [OK] CUSTOMER_BILL.next_seq == 2 (not reset)             — 2
  [OK] audit_logs == 431 (history preserved)               — 431
  [OK] integrity_check ok                                  — ok
  [OK] foreign_key_check 0 violations                      — 0

--- 3. backups still restorable ---
  [OK] pre-leak backup restores cleanly                    — integrity=ok fk=0 je=31
  [OK] current backup restores cleanly                      — integrity=ok fk=0 je=31

--- 4. evidence archive still complete ---
  [OK] archive completeness + rehearsal: no failed check
  [OK] rehearsal reports READY

--- 5. anti-leak guards currently green ---
  [OK] tests/phase-3a-db-isolation-guard.test.js            — 6 passed
  [OK] tests/phase-3a-db-bind-isolation.test.js             — 12 passed
  [OK] tests/phase-3a-cleanup-plan-verification.test.js     — 5 passed
  [OK] tests/phase-3a-fy-lock-policy.test.js                — 20 passed

--- 6. gate preconditions ---
  [OK] E2E_PORT 32523 is free
  [OK] scripts/run-one-e2e.js present (gates 7/8 need it)

READINESS: READY — the 16-gate suite is safe to run when authorized.
```

**43 anti-leak assertions currently green** (6 + 12 + 5 + 20). These are the
guards that would catch a repeat of the 2026-10-09 production leak, so the gate
run is not merely permitted by luck — it is protected.

---

## 4. WHY THE GATE RUN IS STILL WITHHELD

Gate 9 (`live database CONTENT unmodified`) fails while `BILL-2026-00001` remains
in production. Running now would fail that gate for a **known** reason, and would
boot the full E2E stack against a database known to contain test residue. Waiting
costs nothing and removes a variable.

When authorized, the sequence is:

1. apply A (six entries + 10 lines) — or B (bill + 4 rows) — or both
2. re-run `scripts/phase-3a-verify-cleanup.js` to re-prove the result
3. `E2E_PORT=<free port> npm run test:release`
4. report exact gate results, exit codes, test totals
5. verify integrity, foreign keys, production fingerprint

---

## 5. TWO DEFECTS FOUND IN MY OWN VERIFICATION SCRIPT

Both were caught before they could mislead, and both are the same lesson from
the FY-2 incident — a check that cannot fail is not a check:

1. **ANSI codes broke result parsing.** vitest writes colour escapes between
   `Tests` and the count (`"\u001b[22m Tests \u001b[1m\u001b[32m6 passed"`), so
   `/Tests\s+(\d+)\s+passed/` never matched. All four suites reported
   "no result line" and looked like failures while actually passing.
   Fixed by stripping ANSI before matching.

2. **`spawnSync('npx', …)` cannot exec on Windows.** `npx` is a `.cmd` shim, so
   the call returned `status === null` — indistinguishable from a timeout.
   Fixed by invoking `node_modules/vitest/vitest.mjs` directly.

Neither defect could have caused a false PASS; both would have caused a false
FAIL. The honest report at the time was "NOT READY", which was wrong, and I
diagnosed it rather than accepting it.

---

## 6. PRODUCTION SAFETY EVIDENCE

| Check | Value |
|---|---|
| Content fingerprint | `5a0215eb…` unchanged |
| `integrity_check` | ok |
| `foreign_key_check` | 0 violations |
| `journal_entries` | 31 (25 genuine + 6 probes, untouched) |
| `journal_entry_lines` | 112 (untouched) |
| `bills` | 1 (leaked bill, untouched) |
| `financial_years.is_locked` | 1 / 1, per decision |
| `CUSTOMER_BILL.next_seq` | 2, per decision |
| `audit_logs` | 431, preserved |
| Records deleted | **0** |

---

## 7. OPEN

- **A** — six synthetic journal entries + 10 lines. **HOLD.**
- **B** — `BILL-2026-00001` + 4 dependent records. **HOLD.**
- Full 16-gate suite — prepared, **not run**, awaiting authorization.

Phase 3 is **not** complete. No further action taken.
