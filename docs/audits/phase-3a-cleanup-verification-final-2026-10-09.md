# PHASE 3A — CLEANUP VERIFICATION COMPLETE

**Date:** 2026-10-09
**Owner decision:** A — HOLD. B — HOLD. FY locks — keep `is_locked = 1`.
Bill sequence — keep `next_seq = 2`.
**Status:** VERIFIED READY — awaiting separate authorization for A and B.
**Production data changed by this phase: NONE.**

---

## 1. WHAT WAS DONE

No deletion. The work was verification only, in two parts, produced by
`scripts/phase-3a-verify-cleanup.js`:

| Part | Purpose | Result |
|---|---|---|
| 1 | Archive completeness and currency | **ARCHIVE IS COMPLETE AND CURRENT** |
| 2 | Disposable rehearsal of the exact cleanup statements | **ALL PRECONDITIONS HOLD** |

**24 checks, 0 failures.** Production fingerprint `5a0215eb…` before and after.

---

## 2. PART 1 — ARCHIVE COMPLETENESS

The point of this part: if the archive were incomplete, deleting would destroy
unrecoverable evidence. So completeness is proven in both directions — the
archive covers what exists, and each archived row still matches production.

| Check | Result |
|---|---|
| All 6 archived entries still exist in production, unchanged | **OK** |
| All 10 archived lines present and unchanged | **OK** 10/10 |
| No *unarchived* probe entry exists in production | **OK** — production 6, archive 6 |
| Every live probe entry is in the archive | **OK** |
| No *unarchived* probe line exists in production | **OK** — production 10, archive 10 |
| Bill still in production (`BILL-2026-00001`, `PENDING_APPROVAL`) | **OK** |
| `bill_items` dependents present | **OK** 1 row |
| `receivables` dependents present | **OK** 1 row |
| `accounting_audit` dependents present | **OK** 2 rows |
| All bill dependents accounted for in the archive | **OK** 4/4 |
| Every archived entry matches an approved probe description | **OK** |
| Archive bill id matches the target | **OK** |

The two "unarchived" checks are the ones that matter most: they would catch a
seventh probe entry created after archiving, which would otherwise be deleted
without evidence.

---

## 3. PART 2 — DISPOSABLE REHEARSAL

Executed against a throwaway clone of production, never the live file.

### Rehearsal 1 — ROLLBACK restores everything

```
                        je    jl   bills  items recv aud  auditLogs seq  net
BEFORE                   31   112   1      1     1    2      431      2    0
inside transaction       25   102   0      0     0    0      431      2    0
after ROLLBACK           31   112   1      1     1    2      431      2    0
```

**[OK] ROLLBACK restores the database exactly.** This matters because the
production run must be able to abort without partial damage — and it proves the
whole operation is atomic.

### Rehearsal 2 — apply, validate, then commit

| Precondition (checked BEFORE commit) | Result |
|---|---|
| `journal_entries` == 25 genuine entries | **OK** got 25 |
| genuine entries intact (25) | **OK** |
| `journal_entry_lines` == 102 | **OK** got 102 |
| `bills` == 0 | **OK** got 0 |
| bill dependents == 0 (items/receivables/audit) | **OK** all 0 |
| **`audit_logs` PRESERVED** | **OK** 431 vs 431 |
| **bill sequence NOT reset** | **OK** `next_seq=2` |
| **financial-year locks unchanged** | **OK** `fy_2024=1, fy_2026=1` |
| trial balance balanced | **OK** dr=8100 cr=8100 |
| `integrity_check` | **OK** ok |
| `foreign_key_check` | **OK** 0 violations |

Validation passed, so the clone committed — **on the clone only**.

### Post-cleanup ledger sanity

| Check | Result |
|---|---|
| genuine entries keep their date range | **OK** 2026-10-01 .. 2026-10-05 |
| `vouchers` intact | **OK** 25 |
| `stock_ledger` intact | **OK** 2 |
| no negative-amount lines remain | **OK** |
| no zero-line entries remain | **OK** |

---

## 4. PERMANENT REGRESSION TEST

`tests/phase-3a-cleanup-plan-verification.test.js` — **5/5 PASS**

Locks in both properties so neither can rot before authorization:

- the archive stays complete and current (a new probe entry fails the test rather
  than being deleted unarchived);
- the rehearsal keeps passing end to end;
- production is untouched by the verification itself;
- the current authorization state is reported explicitly:
  `cleanup state: 6/6 probe entries present, bill present=true`.

That last one is deliberate — when A/B are authorized this line changes, and
that change *is* the authorization record.

---

## 5. EXACT STATEMENTS HELD IN RESERVE

Identical text was rehearsed. Nothing has been run against production.

**Target A — six journal entries, ten lines:**
```
DELETE FROM journal_entry_lines WHERE id = '<each of the 10 archived line ids>';
DELETE FROM journal_entries    WHERE id = '<each of the 6 archived entry ids>';
```

**Target B — leaked bill and four dependents:**
```
DELETE FROM bill_items       WHERE bill_id   = 'bill_01M4GPPH2HW3B3H56AFSR01FT5';
DELETE FROM receivables      WHERE bill_id   = 'bill_01M4GPPH2HW3B3H56AFSR01FT5';
DELETE FROM accounting_audit WHERE entity_id = 'bill_01M4GPPH2HW3B3H56AFSR01FT5';
DELETE FROM bills            WHERE id        = 'bill_01M4GPPH2HW3B3H56AFSR01FT5';
```

Both inside one `BEGIN IMMEDIATE`, with the full precondition set re-checked
before `COMMIT`, and `ROLLBACK` proven to work.

---

## 6. PRESERVED AND UNCHANGED

| Item | State |
|---|---|
| `audit_logs` | 431 rows, untouched |
| `number_sequences` `CUSTOMER_BILL.next_seq` | **2**, not reset — `BILL-2026-00001` never reused |
| `financial_years.is_locked` | **1 / 1**, per owner decision |
| Backup — pre-leak | `%LOCALAPPDATA%\Temp\bs-backup-20261009-205746` |
| Backup — current | `%LOCALAPPDATA%\Temp\bs-backup2-20261009-214827` |
| Evidence archive | `.json` (197 KB, full row payloads) + `.md` |
| 25 genuine entries / 25 vouchers / 2 stock_ledger | untouched |

---

## 7. STILL OPEN

- **A** — delete six synthetic journal entries + 10 lines.
- **B** — delete `BILL-2026-00001` + 4 dependent records.
- Full 16-gate suite — **not run**, deliberately withheld until cleanup completes
  so gate 9 is judged once against a corrected database.
- Phase 3 is **not** complete.
