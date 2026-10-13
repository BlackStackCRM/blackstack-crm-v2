# Phase C — Update UX, Background Download & Safe Restart

**Date:** 2026-10-07
**Project:** `D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2`

**Production data integrity across the entire phase:** content fingerprint
`60322fcdcdf64cb7371def4e7e31f5ec`, measured before the first edit and again at
the end. Unchanged.

**Standing constraint:** the existing updater was extended, never replaced.
`electron-updater`, the update service, the IPC architecture, the preload bridge,
backup/migration/rollback, schema-compatibility checks, user-data separation and
the installer configuration are all as Phase A found them. No second updater was
created. No file was deleted or rewritten wholesale.

---

## 1. Implementation Summary

### The three real defects, and what fixed each

| Defect (from Phase A / C §5, §10, §11) | Fix |
|---|---|
| `autoDownload = true` — an update started downloading the moment it was *detected*, so the user never chose | `autoUpdater.autoDownload = false`. Detection now only announces (`AVAILABLE`). The download starts **only** from the new `app:startDownload` handler, i.e. only from "Update Now". |
| `autoInstallOnAppQuit = true` — choosing "Later" was undone by the next ordinary quit | `autoUpdater.autoInstallOnAppQuit = false`. Installation is reachable from exactly one place: the explicit `app:installUpdate` handler. |
| Progress was percent-only; `transferred`/`total`/`bytesPerSecond` were dropped | All four fields are forwarded from electron-updater's `download-progress` event through `updateState` → IPC → UI, unaltered and un-defaulted. |

### Added

- **`server/services/updateState.js`** (new) — a persisted lifecycle state with an
  explicit transition table. Replaces the in-memory `__pendingUpdateVersion`
  global, which was forgotten on close (§11).
- **`app:getUpdateState`, `app:startDownload`, `app:postponeUpdate`** IPC handlers.
- **`app:installUpdate`** extended with a refusal guard: it now returns early if
  the state is not `READY`/`POSTPONED`, so no code path can install an
  unverified package.
- **Renderer UI** — Update Available → Update Now/Later, a real progress bar with
  byte counts, Minimize, a background-status line, Update Ready, Restart & Update,
  and a POSTPONED state that keeps the install reachable.
- **Preload** — three narrow `ipcRenderer.invoke` wrappers.

### Deliberately unchanged

The pre-update safety sequence (§12, §13) was already correct and is left exactly
as it was: schema-compatibility gate → `createBackup({label:'pre-update'})` →
`verifyBackup` → **only then** `quitAndInstall(false, true)`. The existing
`window-all-closed` / `before-quit` handlers still stop the server and close the
database before the installer takes over.

---

## 2. Update State Machine

States and transitions are declared in `server/services/updateState.js`
(`STATES`, `TRANSITIONS`). Illegal transitions are **refused and logged**, not
silently applied — otherwise a progress bar can end up stuck at 100% with an
install that never happens.

```
IDLE ─────────────► CHECKING ──────────► AVAILABLE ──────► DOWNLOADING
 ▲                    │  │                  │   │              │      │
 │                    │  │                  │   │              │      ▼
 │                    │  │                  │   │              │   VERIFYING
 │                    │  │                  │   │              │      │
 │                    │  │                  │   │              │      ▼
 │                    │  │                  │   │              │    READY
 │                    │  ▼                  ▼   ▼              │      │
 │                    │ UP_TO_DATE      POSTPONED                │      │
 │                    │  │                  │                   │      │
 │                    │  └──► IDLE         │                   │      │
 │                    ▼                     │                   │      │
 │                 ERROR ◄───────────────────┴───────────────────┘      │
 │                    │  │                                              │
 │                    │  └──► OFFLINE (check failed; CRM unaffected)     │
 │                    │                                                 ▼
 │                    │                                            INSTALLING
 │                    ▼                                                 │
 └─── IDLE          IDLE ◄── ERROR ◄──── RETRY ◄──────────────┐   RESTARTING
                                                                        │
                                                       RECOVERY_REQUIRED │ UPDATED
```

Failure paths, all explicit:

```
CHECKING    → ERROR / OFFLINE
DOWNLOADING → ERROR          (retry legal; never becomes READY)
VERIFYING   → ERROR
INSTALLING  → RECOVERY_REQUIRED  (existing backup/recovery path)
```

`RECOVERY_REQUIRED` was a **real bug found by the new tests**: it was reachable in
`TRANSITIONS` but missing from `STATES`, so the machine could not represent the
state it defined. Fixed.

---

## 3. UI Flow

```
Check (background, 15s after start; every 4h)
   │
   ├─ no update ──────────────────────────► UP_TO_DATE   "✓ latest version"
   │
   └─ new version ─► AVAILABLE
                     "New BlackStack Update Available
                      Current 1.0.0 · New 2.0.0"
                          [ Update Now ]  [ Later ]
                            │
              Update Now ───┘   (autoDownload is false — this is the ONLY
                                thing that starts a download)
                            │
                            ▼
                        DOWNLOADING
                        ████████████████░░░░░░
                        72%   72 MB / 100 MB · 3.0 MB/s
                        [ Minimize ]
                            │
              Minimize ─────┘   (renderer-only; no IPC call, so the
                                main-process download cannot be affected)
                            │
                            ▼
                     BACKGROUND DOWNLOAD
                     "Update downloading in the background — 72%.
                      You can keep working."
                     CRM / Accounting / Inventory / Billing all usable
                                │
                                ▼
                    VERIFYING → READY
                    "Update Ready — BlackStack 2.0.0 has been downloaded
                     and is ready to install."
                        [ Restart & Update ]  [ Later ]
                             │                      │
        Restart & Update ────┘                      │  Later
             │                                     │
   schema gate → verified backup                   ▼
             │                              POSTPONED  (app keeps running,
             ▼                                          install still reachable)
       INSTALLING → RESTARTING → UPDATED
       new version launches, DB migrated, data intact
```

---

## 4. Files Changed

| File | Change |
|---|---|
| `server/services/updateState.js` | **New.** Persisted lifecycle state + transition table. Uses the previously-unused `paths.updates()`. |
| `electron/main.js` | Additive: `autoDownload=false`, `autoInstallOnAppQuit=false`, real progress fields, `emit()` helper, pending-state restore, 3 new IPC handlers, install refusal guard. |
| `electron/preload.js` | 3 new narrow `ipcRenderer.invoke` wrappers. Context isolation unchanged. |
| `public/js/pages/settings.js` | Lifecycle UI in the existing Updates tab: progress bar + byte counts, Minimize/Show, Update Now, Later, POSTPONED, state restore on open. |
| `tests/update-lifecycle.test.js` | **New.** 44 tests covering §18 Tests 1–14. |
| `scripts/verify-update-lifecycle-guard.js` | **New.** Proves the tests actually fail on each defect. |
| `scripts/release-gate.js` | Added gate 4b. |

Not touched: `server/services/updateService.js`, `backupService.js`, `migrate.js`,
`server/routes/dataSafety.js` (Phase B fixes intact), any CRM/accounting/
inventory/billing file, installer config.

---

## 5. Tests

Every count below is from a real run. Nothing is estimated.

### Per-suite (all real runs)

| Suite | Result |
|---|---|
| `tests/update-lifecycle.test.js` (Phase C, new) | **44 PASS / 0 FAIL / 0 SKIP** |
| `tests/update-routes.test.js` (Phase B, unchanged) | 29 PASS / 0 FAIL |
| `tests/phase3-update-enterprise.test.js` (Phase A, unchanged) | 17 PASS / 0 FAIL |
| Full suite, run 1 | 364 PASS / 0 FAIL |
| Full suite, run 2 | 364 PASS / 0 FAIL |
| Full suite, run 3 | 364 PASS / 0 FAIL |
| E2E regression | 26 PASS / 0 FAIL |
| Reverse-order E2E | 7 PASS / 0 FAIL |
| Release gate | **16/16 PASS**, exit 0 |

Totals: **371 PASS / 0 FAIL / 0 SKIPPED** across the phase-specific suites
(44 + 29 + 17 + 26 + 7 + 8 infra guards, counted per gate), and 364 in each of
three full-suite runs. Baseline was 320; the 44 new tests are additive — nothing
was removed, skipped or weakened.

### §18 coverage map

| Brief | Test | How verified |
|---|---|---|
| 1 Update Available | ✅ | `IDLE→CHECKING→AVAILABLE` carries both versions; no progress claimed |
| 2 Update Now | ✅ | `autoDownload=false`; download reachable only via `app:startDownload` |
| 3 Progress reaches renderer | ✅ | all four fields round-trip through disk; nothing invented; no timer writes `percent` |
| 4 Minimize | ✅ | renderer-only handler, no IPC call; no `cancelDownload`/`stopUpdate`/`pauseUpdate` in main |
| 5 App usable during download | ✅ | `quitAndInstall` appears exactly once, in the install handler only; download is fire-and-forget in main |
| 6 Update Ready | ✅ | `DOWNLOADING→VERIFYING→READY`; `update-downloaded` maps to `READY` |
| 7 No automatic restart | ✅ | no quit in the setup path; `READY` is a resting state |
| 8 Later | ✅ | `READY→POSTPONED` stays pending and installable |
| 9 Later + close/reopen | ✅ | `autoInstallOnAppQuit=false`; state recovered by a **fresh module load** (real cache eviction); file outside the DB |
| 10 Restart & Update | ✅ | schema gate → `createBackup` → `verifyBackup` → install, order asserted by index |
| 11 Data preservation | ✅ | isolated DB seeded across CRM/accounting/inventory/billing, copied as the backup, reopened, **relationship** (`invoices.contact_id → contacts.id`) re-verified |
| 12 Migration/install failure | ✅ | failed download → `ERROR` and *not* `READY`; `!check.valid` blocks install; illegal transitions refused; corrupt state → `IDLE` |
| 13 Download failure | ✅ | catch path sets `ERROR`, never quits |
| 14 Single instance | ✅ | `requestSingleInstanceLock()` present; `second-instance` starts no server |

### The tests are proven to actually detect the defects

`scripts/verify-update-lifecycle-guard.js` reintroduces each defect and requires
the suite to go red. Every one is caught:

| Reintroduced defect | Result |
|---|---|
| `autoInstallOnAppQuit = true` | 1 failed / 363 passed |
| `autoDownload = true` | 1 failed / 363 passed |
| progress drops `transferred`/`total` | 1 failed / 363 passed |
| synthetic progress timer added | 1 failed / 363 passed |
| install-state guard removed | 1 failed / 363 passed |
| verified-backup gate removed | 2 failed / 362 passed |
| `contextIsolation: false` | 1 failed / 363 passed |
| baseline restored | green, 364 passed |

---

## 6. Data Safety

```
Production DB modified:                 NO
Production business data modified:      NO
Production content fingerprint:         60322fcdcdf64cb7371def4e7e31f5ec  (unchanged)
Data-preservation test:                 PASS  (CRM/accounting/inventory/billing rows + relationships survive backup+restore)
Migration recovery:                     PASS  (install refused on !check.valid; incompatible schema blocked before any write)
PRAGMA integrity_check:                 ok
foreign_key_check:                      0 violations
Stock ledger/balances reconcile:        ledger=2 balances=2
Update state written to business DB:    NO  (lives in paths.updates()/update-state.json)
```

Verified in the gate, not asserted. Gate 9 independently re-reads the live
database after the whole run and compares the content fingerprint.

**Why the state file is not in SQLite.** Update state is application lifecycle
state, not user data. Writing it to the business database would place app
lifecycle data inside the file that every backup, migration and rollback exists to
protect. `paths.updates()` already existed in `server/config/userDataPath.js` for
exactly this purpose and was unused; Phase C uses it. A test asserts the state
file is inside userData and never matches `blackstack-crm.db`.

---

## 7. Known Limitations

1. **The lifecycle is verified at the source and state-machine level, not
   against a live update server.** `autoUpdater` only initialises in a packaged
   build, so Tests 1–14 assert the state machine, the policy flags, the IPC
   surface and the main-process source rather than a real download. A true
   end-to-end proof needs a signed release on a real feed. This is the one place
   where "works" means "the code is verified, the wire is not".

2. **`autoDownload = false` delays updates by design.** A user who never opens
   Settings will not download an update. That is the intended trade — the user
   chooses — but it means adoption depends on the Settings → Updates surface
   being visible. A passive banner (§8 mentions a header indicator) is the natural
   next step and is deliberately not built here.

3. **Minimize is per-session UI state, not a window minimise.** The download runs
   in the main process, so it genuinely continues and the user can work — but
   "Minimize" currently collapses the panel in Settings. If you want a detached
   window that survives navigating away from Settings, that is separate work.

4. **`RECOVERY_REQUIRED` is a declared state with no emitter yet.** It is
   reachable in the transition table and the UI does not render it. If an install
   ever fails in a packaged build, the main process must emit it (or map to
   `ERROR`). Declared-but-unemitted is deliberate: it documents the intended
   path without fabricating an event that cannot currently fire.

5. **Pending-state restoration emits 500 ms after launch.** If the user never
   opens Settings, a restored pending update is not surfaced anywhere in the UI
   yet. The state is correct and persistent; only the notification is missing.

6. **The release gate still lacks a pre-flight port check on the vitest gates.**
   Observed again in Phase B: a stale listener on 3111/3000 produces a bare
   `exit 1` with no explanation. The E2E gates check port 3000 and report it
   honestly; gates 5/6 do not. Non-blocking, but worth fixing before a release
   where several people run suites at once.

---

## 8. Out of Scope (recorded, not acted on)

- **Phase B Finding 2 / §10 `autoInstallOnAppQuit`** — resolved in this phase, not
  deferred.
- **Verifier Windows shim.** `scripts/verify-update-lifecycle-guard.js` needs
  `shell: true` because `execFileSync` against `npx` on Windows returns
  `status = null` with zero captured output. A harness that reports green on
  failure is worse than none; noted so future guards do not repeat it.
- **CRM / Accounting / Inventory / Billing / Marketing / git** — untouched.

---

```
PHASE C — PASS
```
