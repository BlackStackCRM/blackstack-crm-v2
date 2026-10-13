# PHASE 3 STEP 3B — CRM-03 FIXED: STATE-TRANSITION VALIDATION

**Date:** 2026-10-09
**Release gate:** `E2E_PORT=32561 npm run test:release` → **EXIT=0, 16/16 PASS**
**Tests:** **545 passed** (was 532 — 13 new), 0 failures
**Production fingerprint:** `5a0215eb…` — unchanged before and after

---

## 1. DEFECTS REPRODUCED FIRST

`tests/crm-state-transitions.test.js` was run against the **unfixed** code. Five
defects, all returning `200 success`:

| # | Defect | Observed |
|---|---|---|
| 1 | Backward stage move (Closing → Discovery) | `200 success` |
| 2 | Terminal WON deal re-staged | `200 success` |
| 3 | Terminal LOST deal re-staged | `200 success` |
| 4 | `tasks.status = 'BANANA'` accepted and persisted | `200 success` |
| 5 | **Staging a NON-EXISTENT deal returned `200 success`** | `200 success` |

Defect 5 was not in the original audit — it surfaced while reproducing the
others. `updateStage()` never checked that the deal existed: it ran an UPDATE
matching zero rows, then returned the (null) row inside a success envelope. A
client could believe a phantom deal had been moved.

---

## 2. ROOT CAUSE

`stage_id` was validated for **existence only**:

```js
const stage = this.conn.get('SELECT * FROM pipeline_stages WHERE id = ? ...');
if (!stage) throw new NotFoundError('PipelineStage', stage_id);
// no comparison against the deal's CURRENT stage
```

`tasks.status` had no validation at all, and the column carries **no CHECK
constraint** in the schema — so any string was persisted.

### Dead-code discovery

`server/services/deal.service.js` implements `updateStage`, `markWon` and
`markLost` and looks like the intended lifecycle layer. It is **unreachable**:
no route mounts it. Worse, `markWon`/`markLost` write to columns `won_at` and
`lost_at` which **do not exist** on `deals` — they would throw
`no such column` if ever wired up.

So there was no lifecycle enforcement anywhere in the request path, and a
plausible-looking service file gave the impression that one existed. That is a
finding in its own right: dead code implying a control that is not there.

---

## 3. FIX

Rules are derived from data **already in the schema**, not invented.

### `server/controllers/deals.controller.js`

New `_assertStageTransition(companyId, dealId, nextStageId)`:

1. **Existence** — a missing deal raises `NotFoundError` (404). This closes
   defect 5.
2. **Terminal** — a deal whose `status` is `WON` or `LOST` cannot be re-staged;
   409 `INVALID_STATE_TRANSITION` telling the caller to use
   `POST /api/deals/:id/reopen`, which already exists as an explicit route.
3. **Ordering** — `pipeline_stages.stage_order` defines funnel order. A move may
   go forward or stay put, never backward. Re-staging to the *current* stage is
   allowed as a no-op.

The UPDATE additionally checks `changes === 0` and raises 404 rather than
returning success.

### `server/controllers/tasks.controller.js`

New `static STATUSES = new Set(['TODO', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])`,
derived from what the codebase already uses — `TODO` is the schema default,
`COMPLETED` is what dashboards and reports aggregate on, and `IN_PROGRESS` /
`CANCELLED` are the conventional values used elsewhere. An unrecognised status is
rejected 400 with the permitted list in the message.

Existing `completed_at` stamping/clearing behaviour is untouched and still
verified by tests.

### One defect I introduced and fixed

The first implementation put `const { AppError } = require(...)` inside
`updateStage`, then used `AppError` in the helper `_assertStageTransition`.
`require` in a method body is scoped to that method, so the helper threw
`ReferenceError: AppError is not defined` and every intended 409 surfaced as
`INTERNAL_ERROR`. Caught by the tests, fixed by requiring inside the helper with
a comment explaining why.

---

## 4. VERIFICATION

| Suite | Result |
|---|---|
| `crm-state-transitions.test.js` (new) | **13/13 PASS** |
| `crm-contact-deletion` + `crm-permissions` + `crm-deal-org-deletion` | **107/107 PASS** |
| Full vitest | **545 passed, 0 failed** |
| Release gates | **16/16 PASS, exit 0** |
| Gate 9 production unmodified | **PASS** |

### Coverage

- backward stage move → 409, stage unchanged
- forward stage move → allowed, stage updated
- re-stage to current stage → allowed (no-op)
- WON deal re-staged → 409, stage and status unchanged
- LOST deal re-staged → 409, stage and status unchanged
- unknown `stage_id` → refused, unchanged
- **non-existent deal → 404** (the newly-found defect)
- missing `stage_id` in body → refused, unchanged
- task status `BANANA` → 400, unchanged
- task status `IN_PROGRESS` → allowed
- task → `COMPLETED` still stamps `completed_at`
- `COMPLETED` → `TODO` still clears it
- no fixture row appears in production

Real HTTP API, real server, disposable clone.

---

## 5. PRODUCTION UNCHANGED

Fingerprint `5a0215eb…` before and after. `integrity_check` ok,
`foreign_key_check` 0 violations, gate 9 content identical.

---

## 6. RECOMMENDED FOLLOW-UP (not actioned)

`server/services/deal.service.js` remains dead code that would throw if mounted.
It should either be deleted or wired up deliberately — leaving it invites the
belief that a lifecycle is enforced when the controller is the only thing
enforcing it. Not changed here because it is outside the CRM-03 scope and any
wiring decision needs owner input.

---

## 7. STILL OPEN

| Item | State |
|---|---|
| CRM-05 generic RESTRICT 409 outside contacts | open |
| CRM-06 `activities` has **no delete handler** | open |
| CRM-07 two N+1 sites | open |
| CRM-08 `customers` orphaned from Billing | open |
| CRM-09 lead attributes duplicated | open |
| Delete safety for leads, customers, tasks, appointments, notes, pipelines | open (no inbound FKs, so no cascade — but still non-atomic) |
| `deal.service.js` dead code | newly identified |
| **Billing audit** | **not started** |
| **Inventory audit** | **not started** |
| **Cross-module integration audit** | **not started** |
| Cleanup A / B | **HOLD — not authorized** |

**Phase 3 is NOT complete.** Per owner instruction, nothing above is treated as
fixed unless a new code test proves it; only the items in this report are closed.
