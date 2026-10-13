# PHASE 3 STEP 3D — CRM-06 FIXED: ACTIVITIES DELETE HANDLER

**Date:** 2026-10-09
**Release gate:** `E2E_PORT=32571 npm run test:release` → **EXIT=0, 16/16 PASS**
**Tests:** **569 passed** (was 562 — 7 new), 0 failures
**Production:** fingerprint `5a0215eb…` unchanged; the gate's own content
fingerprint identical BEFORE and AFTER (`cd060e67…`)

---

## 1. DEFECT REPRODUCED FIRST

`tests/crm-activities-deletion.test.js` run against the **unfixed** code:

```
× an activity is permanently deletable
  → delete must succeed: {"code":"NOT_FOUND"}            (the route does not exist)
× an UNAUTHENTICATED delete is rejected and changes nothing
  → expected auth failure, got 404
× the route is permission-gated like its sibling entities
  → DELETE /:id must exist: source does not contain "router.delete('/:id'"
```

`/api/activities` was mounted but exposed only `GET` and `POST`. A logged
activity — a call, a meeting, a note-to-self about a deal — could never be
retracted, while every sibling entity could.

---

## 2. ROOT CAUSE

`server/routes/activities.js` declared two verbs:

```js
router.get('/',  ...);
router.post('/', ...);
```

and `ActivitiesController` implemented only `list` and `create`. Nothing else
referenced deletion.

---

## 3. FIX

### `server/controllers/activities.controller.js` — new `remove()`

A tenant-scoped permanent DELETE, matching `tasks`, `notes` and `appointments`:

```js
DELETE FROM activities WHERE id = ? AND company_id = ?
```

`changes === 0` raises `NotFoundError` → 404.

**Why a plain delete and NOT the refuse-when-referenced policy** used for
contacts / deals / organizations (CRM-01, CRM-04): measured, not assumed.
`activities.id` has **ZERO inbound foreign keys** — no table references it. An
activity delete therefore cannot cascade into anything. There is nothing to
protect, so a dependency gate would reject nothing while adding a second failure
mode and more code. The distinction is recorded as a structural test so a future
schema change that adds an inbound FK will fail that test.

### `server/routes/activities.js` — the route

```js
router.delete('/:id', authMiddleware, requirePermission('activities.create'),
              controller.remove.bind(controller));
```

### The permission decision — deliberately NOT an invented code

The permission table has `activities.view` and `activities.create` but **no
`activities.delete`**. `requirePermission` fails closed on an unknown code, so
inventing one would have denied **every** role — including admin — and produced a
route that looked correct and was unusable.

Verified before wiring: `role_admin` holds `activities.create` (1 row), so the
route is reachable. `role_manager` and `role_user` do not, which is the correct
outcome for a destructive verb.

Reusing `activities.create` is a deliberate compromise: whoever may log an
activity may retract one, and no schema or role-grant change is needed. A
dedicated `activities.delete` permission is the cleaner long-term answer and is
recorded as a follow-up requiring owner approval.

---

## 4. VERIFICATION

| Suite | Result |
|---|---|
| `crm-activities-deletion.test.js` (new) | **7/7 PASS** |
| 5 existing CRM suites | **137/137 PASS** — no regression |
| Full vitest | **569 passed, 0 failed** |
| Release gates | **16/16 PASS, exit 0** |
| Gate 9 production unmodified | **PASS** |

### Coverage

- an activity is permanently deleted (no soft-delete flag introduced)
- non-existent activity → 404 `NOT_FOUND`
- **tenant-scoped**: an activity owned by another company is NOT deleted and
  reports 404 (which also avoids confirming another tenant's record exists)
- unauthenticated delete → 401/403 and the row survives
- the route sits behind `authMiddleware` and an **existing** permission code
- **activities has zero inbound FKs** — the structural guarantee behind choosing
  a plain delete
- no fixture row appears in production

---

## 5. A TOOLING DEFECT I HIT AND FIXED

My first version of the test used a regex literal with escaped slashes:

```js
/router\.delete\('/:\/id'/      // Vite: "Failed to parse source"
```

`node --check` **passed**, because it parsed the file as CommonJS — Vite parses
these `tests/*.test.js` files as ESM (they use `import.meta`). So the ESM parse
failed while the CJS parse succeeded, which is a genuine blind spot in using
`node --check` as a syntax gate on test files. Replaced with a plain
`toContain("router.delete('/:id'")`.

This is the second time in this phase that `node --check` gave a misleading
result — the first being the missing `AppError` import in CRM-03. Recorded as a
pattern: **on ESM-parsed test files, `node --check` is not sufficient; run the
suite.**

---

## 6. A NOTE ON THE GATE RUN

My terminal call timed out at 420s while the suite was still running. I did NOT
kill it or start a competing run on another port. I confirmed production was
untouched, verified the E2E port was still held by the live run, waited for it to
release, and then read the completed log:

```
live db CONTENT fingerprint AFTER : cd060e67165f6a3bf959c5a093002b43
16/16 gates passed
RELEASE GATE: PASS
```

The verdict is the real completed run, not a partial or inferred one.

---

## 7. STILL OPEN

| Item | State |
|---|---|
| CRM-07 two N+1 sites (`contacts.controller.js`, `organizations.controller.js`) | open |
| CRM-08 `customers` table orphaned from Billing | open |
| CRM-09 lead attributes duplicated between `leads` and `contacts` | open |
| Delete safety for leads, customers, tasks, appointments, notes, pipelines | open — no inbound FKs so no cascade, but still non-atomic |
| `server/routes/relationships.js` unmounted | open |
| `activities.delete` dedicated permission | recommended, needs owner approval |
| `customer-bill.service.js` ignores request `bill_type` (found in CRM-05) | open |
| `deal.service.js` dead and broken (found in CRM-05) | open |
| **Billing audit** | **not started** |
| **Inventory audit** | **not started** |
| **Cross-module integration audit** | **not started** |
| Cleanup A / B | **HOLD — not authorized** |

**Phase 3 is NOT complete.** Per owner instruction, nothing above is treated as
fixed unless a new code test proves it; only the item in this report is closed.
