# PHASE 3 — REMAINING CORE-MODULE WORK (READ-ONLY SURVEY)

**Date:** 2026-10-09
**Basis:** `docs/audits/phase-3-core-modules-finalization-2026-10-08.md` §"Remaining
CRM findings", plus the FY work of 2026-10-09.
**Mode:** READ-ONLY. Nothing deleted, no production write, no code changed.
**Production:** fingerprint `5a0215eb…` — untouched.

---

## 1. WHY PHASE 3 IS NOT COMPLETE

| Module | Audit | High fixes | Status |
|---|---|---|---|
| CRM | complete | CRM-01, CRM-02 done | **open findings remain** |
| Accounting & Finance | complete | FY-1, FY-2 done | FY-3 open; cleanup A/B unauthorized |
| Billing | **not started** | — | unaudited |
| Inventory | **not started** | — | unaudited |
| Cross-module integration | **not started** | — | unaudited |

Phase 3 cannot be declared complete while three modules plus integration are
unaudited.

---

## 2. CRM-04 — CONFIRMED STILL OPEN

The CRM audit fixed deletion safety for `contacts` only. The other entities were
left as a scope boundary. Verified against the code today:

| Entity | Method | Transaction | Dependency pre-check | Deletes |
|---|---|---|---|---|
| `contacts` | `remove` | **yes** | **yes** (`_contactDependents`) | contacts |
| `deals` | `remove` | no | no | deals |
| `organizations` | `remove` | no | no | organizations |
| `leads` | `remove` | no | no | leads |
| `customers` | `remove` | no | no | customers |
| `tasks` | `remove` | no | no | tasks |
| `appointments` | `remove` | no | no | appointments |
| `notes` | `remove` | no | no | notes |
| `pipelines` | `remove` | no | no | pipelines |
| `activities` | — | — | — | **no delete handler at all** |

### Why this matters — cascade exposure measured

Foreign keys pointing at each entity, read from the live schema:

| Entity | Inbound FKs | Of which CASCADE |
|---|---|---|
| `contacts` | 24 | 11 |
| `organizations` | 14 | 1 |
| `deals` | **8** | **3** |
| `leads` | 1 | 1 |
| `customers` | 1 | 1 |
| `tasks`, `appointments`, `activities`, `notes` | 0 | 0 |

So deleting a **deal** silently destroys its activities, tasks and appointments
via CASCADE, with no transaction and no warning — the exact failure mode CRM-01
was raised to fix, simply not applied to deals. Deleting an **organization**
nulls `contacts.organization_id` and `deals.organization_id` (SET NULL) while
cascading `activities` — a partial, inconsistent teardown.

`tasks`/`notes`/`appointments`/`activities` have no inbound FKs, so a plain
delete is comparatively safe, though still non-atomic.

---

## 3. OTHER OPEN CRM FINDINGS (unchanged since 2026-10-08)

| ID | Severity | Finding |
|---|---|---|
| CRM-03 | MEDIUM | Deal/task **state-transition validation absent** — an invalid stage change is not rejected on its merits. Permissions were added; the business rule was not. |
| CRM-05 | LOW | RESTRICT failures still return a generic 409 outside the contacts path. |
| CRM-06 | LOW | `activities` exposes no delete handler (confirmed above). |
| CRM-07 | LOW | Two N+1 query sites unchanged: `contacts.controller.js`, `organizations.controller.js`. |
| CRM-08 | INFO | `customers` table still orphaned from Billing. |
| CRM-09 | INFO | Lead attributes duplicated between `leads` and `contacts`. |
| NEW | LOW | `server/routes/relationships.js` still unmounted — decide mount or delete. |

---

## 4. ACCOUNTING — FY-3 (investigation only)

All 25 genuine `journal_entries` carry `financial_year_id = NULL`, while
`vouchers` stores the year ID (0 NULLs). Year attribution therefore has two
sources of truth: reports re-derive from `entry_date`; vouchers store it.

Backfill impact **not** analysed, and no backfill is proposed without separate
approval.

---

## 5. CLEANUP A / B — STILL UNAUTHORIZED

Owner instruction recorded:

> "പരിശോധനാ ഗേറ്റുകൾ വിജയിച്ചതായി രേഖപ്പെടുത്താം. എന്നാൽ A, B നടപടികൾക്ക് അനുമതി ലഭിക്കുന്നതുവരെ അവ നടപ്പാക്കരുത്."

| Item | State |
|---|---|
| Release verification | **PASSED — 16/16, recorded** |
| Cleanup A (6 journal entries + 10 lines) | **HOLD** |
| Cleanup B (`BILL-2026-00001` + 4 rows) | **HOLD** |
| Phase 3A complete? | **No** |
| Phase 3 complete? | **No — not yet determined** |

---

## 6. RECOMMENDED SEQUENCE (for approval — not actioned)

1. **Authorize cleanup A and/or B**, separately. Both are rehearsed; dry runs
   leave integrity ok, FK 0, trial balance balanced, `audit_logs` preserved and
   the bill sequence not reset.
2. **CRM-04** — extend the contacts deletion policy to `deals` and
   `organizations` first (highest cascade exposure: 3 and 1 inbound CASCADEs with
   real dependents), then the remaining entities. Requires regression tests that
   reproduce each defect before the fix.
3. **Billing audit**, then **Inventory audit**, then **cross-module integration**.
4. **FY-3** investigation last; it is documentation, not a schema change.

---

## 7. WHAT THIS SURVEY DID NOT DO

- No cleanup executed.
- No production record created, edited or deleted.
- No financial-year lock, bill sequence or audit row touched.
- No code changed.
- No gate run (the last one stands: 16/16, exit 0, 524/524).
