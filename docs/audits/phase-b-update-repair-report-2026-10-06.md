# Phase B — Repair Existing Update System + Route-Level Test Coverage

**Date:** 2026-10-06
**Project:** `D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2`

**Production data integrity across this phase:**
```
md5(data/blackstack-crm.db)   af017ab18394b28b0d1e61b70e04a72d  (before = after)
content fingerprint           60322fcdcdf64cb7371def4e7e31f5ec  (before = after)
```

---

## 1. Changes Made

### `server/routes/dataSafety.js` — Findings 2 and 3

**What changed.** The module import now destructures the functions that are
actually exported:

```js
const { UpdateService, getChannel, setChannel, checkSchemaCompatibility,
        getCurrentDbSchemaVersion, CHANNELS } = require('../services/updateService');
```

and four call sites were corrected to use them:

| Route | Was (broken) | Now |
|---|---|---|
| `GET /update-channel` | `UpdateService.getChannel()` → 500 | `getChannel()` → 200 |
| `GET /update-channel` | `UpdateService.CHANNELS` → 500 | `CHANNELS` → 200 |
| `PUT /update-channel` | `UpdateService.setChannel(channel)` → 400 | `setChannel(channel)` → 200 |
| `GET /update-compatibility` | `UpdateService.checkSchemaCompatibility({...})` → 500 | `checkSchemaCompatibility({...})` → 200 |
| `GET /update-compatibility` | `UpdateService.getCurrentDbSchemaVersion()` → 500 | `getCurrentDbSchemaVersion()` → 200 |

**Why.** `updateService.js` exports two different shapes. The channel and
compatibility helpers are **module-level functions**; the `UpdateService` object
carries only the provider surface — `_provider`, `bindProvider`,
`getCurrentVersion`, `checkForUpdate`, `downloadUpdate`, `installUpdate`,
`getUpdateStatus`, `isNewerVersion`. Calling the non-existent statics threw a
`TypeError` that the global error handler turned into a 500.

`electron/main.js` already used the module form correctly, which is why the desktop
path worked and only the HTTP routes were broken.

**What was deliberately NOT changed.** `UpdateService.getUpdateStatus()` in
`/update-status` is a **genuine static** and stays as-is. `supportBundle.js:59` also
calls a valid static and was left alone. I verified both rather than assuming.

### `public/js/pages/settings.js` — Finding 1

**What changed.** All 11 bare `fetch()` calls to protected `/api/datasafety/*`
routes were converted to the existing `window.API` wrapper, which attaches
`Authorization: Bearer <token>` and unwraps the `data` envelope.

| Line | Endpoint | Before | After |
|---|---|---|---|
| 267 | `update-channel` GET | `fetch()` | `API.get` |
| 283 | `update-channel` PUT | `fetch(…, {method:'PUT'})` | `API.put` |
| 456-457 | `backups/status`, `backups` | `fetch().then(r=>r.json())` | `API.get` ×2 |
| 481 | `backups` POST | `fetch(…, {method:'POST'})` | `API.post` |
| 494 | `storage` | `fetch()` | `API.get` |
| 516 | `support-bundle` POST | `fetch(…, {method:'POST'})` | `API.post` |
| 547 | `backups/restore` POST | `fetch(…, {method:'POST'})` | `API.post` |
| 568, 571 | `data-deletion/token`, `/execute` POST | `fetch(…, {method:'POST'})` ×2 | `API.post` ×2 |

**Why.** `authMiddleware` + `requirePermission('settings.manage')` were added to all
14 routes during the production-readiness phase. A bare `fetch()` sends no
Authorization header, so every one of these calls returned 401 and the Settings →
Updates and Data Safety screens silently fell back to defaults. **This regression
was mine**; the hardening was correct.

**Response shapes preserved.** `API.get/post` returns `result.data`, so each call
site was adjusted to drop the now-redundant `j?.data` / `j.success` unwrapping.
Verified by reading every changed block, not by assumption.

### `tests/update-routes.test.js` — NEW, Finding 4

29 assertions covering the HTTP contract the existing tests never touched:
401 / 403 / 2xx **with response bodies** for six routes, plus behaviour tests for
channel read/write/validation and compatibility verdicts, plus four
regression guards (§ Regression Protection).

### `scripts/release-gate.js`

Added gate `4: update/data-safety route contract` so this cannot regress silently.

### Scripts added (verification only)

- `scripts/verify-update-routes.js` — standalone 19-check route matrix
- `scripts/verify-update-routes-guard.js` — proves the new tests detect each defect
- `scripts/audit-update-ui-auth.js` — read-only probe written during Phase A

---

## 2. Route Verification

Anonymous (no token) / Unauthorized (`role_manager`, 20 permissions, **no**
`settings.manage`) / Authorized admin:

| Route | Anonymous | Unauthorized | Admin | Result |
|---|---:|---:|---:|---|
| `GET /update-channel` | 401 | 403 | 200 | **FIXED** (was 500) |
| `PUT /update-channel` | 401 | 403 | 200 | **FIXED** (was 400) |
| `GET /update-compatibility?target=2.0.0` | 401 | 403 | 200 | **FIXED** (was 500) |
| `GET /update-status` | 401 | 403 | 200 | unchanged |
| `GET /backups/status` | 401 | 403 | 200 | unchanged |
| `GET /storage` | 401 | 403 | 200 | unchanged |
| `GET /backups` | 401 | 403 | 200 | unchanged |

**Body assertions (authorized admin):**

| Assertion | Observed |
|---|---|
| `update-channel` GET returns a channel | `channel=stable` |
| `update-channel` GET returns the catalogue | `channels=stable,beta,enterprise` |
| `update-channel` PUT accepts each valid channel | `beta`, `stable`, `enterprise` all 200 + round-trip |
| `update-channel` PUT rejects unknown | 400 `INVALID_CHANNEL` |
| `update-channel` PUT rejects missing | 400 |
| `update-compatibility` returns a verdict | `result=MIGRATION_REQUIRED` |
| compatibility body carries schema context | `currentApp=1.0.0 dbSchemaVersion=83` |
| compatibility rejects missing/malformed target | 400 / 400 |
| no response leaks `is not a function` | confirmed on all |

**Security not weakened:** 18 `requireDataSafety` references intact; the only
unguarded route remains `/version`, which the updater reads before login
(verified 200 anonymously, and `role_manager` still refused `/storage` with 403).

---

## 3. Test Results

| Suite | Result |
|---|---|
| Existing update-service tests (`phase3-update-enterprise.test.js`) | **17 pass / 0 fail** |
| Authorization tests (`tests/authorization.test.js`) | **23 pass / 0 fail** |
| New route-level tests (`tests/update-routes.test.js`) | **29 pass / 0 fail** |
| Data-safety / migration-idempotency / electron | **16 pass / 0 fail** |
| **Targeted subtotal** | **85 pass / 0 fail** |
| **Full suite — 3 consecutive runs** | **320 pass / 0 fail** each |
| E2E (`run-one-e2e.js "Test"`) | **26 pass / 0 fail** |

Baseline was 291. The suite is now 320 — **+29** from the new route tests, no
existing test removed or weakened.

### Regression protection — verified, not assumed

`scripts/verify-update-routes-guard.js` reintroduces each Phase A defect in turn
and requires the suite to go red:

```
baseline (fixes in place)  -> failing tests: 0
detected   routes call nonexistent UpdateService statics -> 7 failing
detected   Settings UI uses an unauthenticated fetch()     -> 1 failing
detected   permission guard removed from /api/datasafety   -> 13 failing

GUARD VERIFIED: detects all three regressions
```

Both source files are restored in a `finally` block; post-run inspection confirmed
the executable code was intact (the one remaining `UpdateService.getChannel`
occurrence is inside an explanatory comment).

### Release gate

```
[PASS] gate 1: live database present
[PASS] gate 2: architecture guard (retired tables)          3 passed
[PASS] gate 3: env-isolation guard (process.env)              3 passed
[PASS] gate 3: migration idempotency                          5 passed
[PASS] gate 4: authorization (401/403/2xx)                   23 passed
[PASS] gate 4: update/data-safety route contract              29 passed   <- new
[PASS] gate 4: bill lifecycle + reconciliation               14 passed
[PASS] gate 5: unit/integration (parallel)                  320 passed
[PASS] gate 6: unit/integration (serial)                    320 passed
[PASS] gate 7: E2E regression                                26 passed
[PASS] gate 8: reverse-order E2E                              7 passed
[PASS] gate 9: live database content unmodified / integrity / FK / reconciliation

15/15 gates passed          RELEASE GATE: PASS
```

---

## 4. Data Safety

| Question | Answer |
|---|---|
| Production DB changed? | **NO** — md5 and content fingerprint identical |
| Production business data changed? | **NO** — CRM, Accounting, Inventory, Billing untouched |
| Existing backup/recovery behaviour preserved? | **YES** — not modified |

Specifically preserved, unchanged and still covered by passing tests:
pre-update backup, backup verification, migration safety, rollback on migration
failure, source-DB preservation, DB outside the install directory,
`deleteAppDataOnUninstall: false`, recovery logic, schema compatibility checks.

Every test and verification script ran against a disposable database copy in a
temporary directory. The only writes outside SQLite are `update-channel.json`
preferences files, written inside the disposable user-data dir.

---

## 5. Remaining Known Issues

**Deliberately deferred to the next phase** (per the brief — not bugs in this phase):
progress UI, Minimize, background update, Update Ready, Later, Restart & Update,
persistent pending-update state, `autoInstallOnAppQuit` behaviour.

**OUT OF SCOPE FINDINGS** — noticed, not acted on:

1. **`autoInstallOnAppQuit = true`** (`electron/main.js:155`). Choosing "Later" does
   not prevent installation on quit. Not changed: the brief explicitly postpones
   "Later" behaviour and this phase is a repair baseline, not the UX phase.
2. **`__pendingUpdateVersion` is an in-memory global** (`electron/main.js:184`). A
   pending update is lost on restart. Same rationale.
3. **`download-progress` is truncated to `percent`** (`electron/main.js:180`);
   `transferred`/`total` are dropped, so the target's "72 MB / 100 MB" needs a
   main-process change. Progress UI is next-phase work.
4. **Orphaned `INSTALLING` UI branch** — `settings.js` handles a state `main.js`
   never emits; `AVAILABLE` is effectively unreachable because `autoDownload` fires
   immediately.
5. **`UpdateService.UPDATE_STATUS`** (11 states) is dead code — no consumers.
6. **`acceptance:installer` and `release:verify-installer` remain outside the
   release gate** (they need a real install). Pre-existing, not update-specific.
7. **`schema_migrations` max is 83 while programmatic Steps 081/082/084 exist in
   `migrate.js`.** Harmless; a reporting inconsistency noted earlier.

---

## 6. Success Criteria

| Criterion | Status |
|---|---|
| Settings update API calls authenticate correctly | PASS |
| No protected Settings update call receives an unexpected 401 | PASS |
| `update-channel` GET works for an authorized admin | PASS (was 500) |
| `update-channel` PUT works for an authorized admin | PASS (was 400) |
| `update-compatibility` works for an authorized admin | PASS (was 500) |
| Invalid/unauthorized requests remain protected | PASS — 401 / 403 verified |
| Route-level tests exist | PASS — 29 assertions |
| Route-level tests verify actual response bodies | PASS |
| Existing update-service tests still pass | PASS — 17/17 |
| Existing data-safety mechanisms remain intact | PASS — 16/16 |
| Production data remains unchanged | PASS — fingerprint identical |
| No unrelated architecture changed | PASS — 2 source files, 4 repairs total |

---

```
PHASE B — PASS
```

The existing update system now functions correctly end-to-end, with the route-level
coverage that would have caught both Phase A defects. The new update UX is not
started.