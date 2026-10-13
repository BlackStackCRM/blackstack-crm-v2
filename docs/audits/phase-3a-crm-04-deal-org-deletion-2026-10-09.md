# PHASE 3 STEP 3A — CRM-04 FIXED: DEAL AND ORGANIZATION DELETION SAFETY

**Date:** 2026-10-09
**Release gate:** `E2E_PORT=32551 npm run test:release` → **EXIT=0, 16/16 PASS**
**Tests:** **532 passed** (was 524 — 8 new), 0 failures
**Production fingerprint:** `5a0215eb…` — unchanged before and after

---

## 1. DEFECT REPRODUCED FIRST

`tests/crm-deal-org-deletion.test.js` was written and run against the **unfixed**
code. It failed exactly as the audit predicted:

```
× a deal with a task, activity and appointment is refused
  → delete should be refused: {"success":true,"data":{"deleted":true},"status":200}
× an organization with a contact and a deal is refused
  → organization delete should be refused: {"success":true,...,"status":200}
```

Both deletes returned **200 `deleted: true`**, silently destroying dependents.
That is the CRM-01 defect class, unfixed for these two entities.

The 6 passing cases in that first run were the behaviours that were already
correct: clean deletes, 404s, and unauthorized rejection.

---

## 2. ROOT CAUSE

Both handlers were a bare DELETE:

```js
const result = this.conn.run('DELETE FROM deals WHERE id = ? AND company_id = ?', ...);
```

No dependency check, no transaction, no FK-violation handling.

Measured cascade exposure from the live schema:

| Parent | Inbound FKs | CASCADE | Effect of the old DELETE |
|---|---|---|---|
| `deals` | 8 | **3** | destroyed tasks, activities, appointments |
| `organizations` | 14 | 1 | destroyed activities; **SET NULL** on contacts and deals — a partial teardown |

The organization case was the more insidious: same request, rows silently
surviving with their owner nulled *and* rows being destroyed, with no error.

---

## 3. FIX

Both now mirror the policy already proven for contacts
(`server/controllers/contacts.controller.js`) rather than inventing a new one.

### `server/controllers/deals.controller.js`

- `static DELETE_BLOCKERS` — tasks, activities, appointments, notes, invoices,
  payments. `invoices`/`payments` are RESTRICT at the schema level and are listed
  so the 409 names them instead of leaking a raw SQLite message.
- `_dealDependents(dealId, companyId)` — counts each blocker, skipping tables
  absent from the schema.
- `remove()` — existence check, dependency check and DELETE inside **one
  `BEGIN IMMEDIATE` transaction**, so a row created between check and delete
  cannot be silently lost. 409 `ENTITY_HAS_DEPENDENCIES` naming the blockers.
- FK-violation fallback → the same 409, so nothing has committed.

### `server/controllers/organizations.controller.js`

- `static DELETE_BLOCKERS` — contacts, deals, activities, tasks, appointments,
  invoices. `contacts` and `deals` are included precisely because they are SET
  NULL: losing an owner silently is as much a data-loss event as a cascade.
- Same single-transaction structure and same 409 contract.

### Policy preserved

A parent with **no** dependents is still permanently deleted. No soft delete was
introduced. Permission checks, routes and response shapes are unchanged.

---

## 4. VERIFICATION

| Suite | Result |
|---|---|
| `crm-deal-org-deletion.test.js` (new) | **8/8 PASS** |
| `crm-contact-deletion.test.js` + `crm-permissions.test.js` | **99/99 PASS** — no regression |
| Full vitest | **532 passed, 0 failed** |
| Release gates | **16/16 PASS, exit 0** |
| Gate 9 production unmodified | **PASS** |

### Test coverage

- deal with task + activity + appointment → refused 409, **all four rows unchanged**
- deal with no dependents → permanently deleted
- non-existent deal → 404
- unauthorized delete → 401/403, deal and task intact
- organization with contact + deal + activity → refused 409, all rows unchanged
- organization with no dependents → permanently deleted
- non-existent organization → 404
- **no fixture row appears in production** (verified by tag scan of every CRM table)

The suite drives the real HTTP API against a real server on a disposable clone,
so routing, auth, permission, controller and FK layers are all exercised together.

---

## 5. PRODUCTION UNCHANGED

| Metric | Expected | Actual |
|---|---|---|
| content fingerprint | `5a0215eb…` | `5a0215eb…` |
| `journal_entries` | 31 | 31 |
| `journal_entry_lines` | 112 | 112 |
| `bills` | 1 | 1 |
| `audit_logs` | 431 | 431 |
| probe entries | 6 | 6 |
| `deals` | 0 | 0 |
| `organizations` | 1 | 1 |
| `financial_years.is_locked` | 1 / 1 | `fy_2024=1, fy_2026=1` |
| `CUSTOMER_BILL.next_seq` | 2 | 2 |
| `integrity_check` | ok | ok |
| `foreign_key_check` | 0 | 0 |

---

## 6. STILL OPEN

| Item | State |
|---|---|
| CRM-03 deals/tasks **state-transition validation** | open |
| CRM-05 generic RESTRICT 409 outside contacts | open (now also improved for deals/orgs) |
| CRM-06 `activities` has **no delete handler** | open |
| CRM-07 two N+1 sites | open |
| CRM-08 `customers` orphaned from Billing | open |
| CRM-09 lead attributes duplicated | open |
| `relationships.js` unmounted | open |
| **Billing audit** | **not started** |
| **Inventory audit** | **not started** |
| **Cross-module integration audit** | **not started** |
| Cleanup A / B | **HOLD — not authorized** |

CRM-04 is fixed for `deals` and `organizations`, the two entities with real
cascade or silent-null exposure. The remaining six entities
(leads, customers, tasks, appointments, notes, pipelines) have **no inbound
foreign keys**, so their deletes cannot cascade; they are still non-atomic, which
is a lesser finding and is left for the remaining CRM pass.

---

## 7. STATUS

**Phase 3 is NOT complete.** Billing, Inventory and cross-module integration
remain unaudited. Cleanup A and B remain unauthorized and were not executed.

Per owner instruction, no finding above is treated as fixed unless a new code
test proves it — CRM-04 above is the only item closed in this step.
