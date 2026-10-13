# Phase A — Existing Update System Audit

**Date:** 2026-10-06
**Project:** `D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2`
**Phase:** AUDIT ONLY — no application source, tests, migrations, config, or documentation were modified.

**Baseline integrity across this audit:**
```
md5(data/blackstack-crm.db)   af017ab18394b28b0d1e61b70e04a72d  (before = after)
content fingerprint           60322fcdcdf64cb7371def4e7e31f5ec  (before = after)
```
One read-only audit script was added (`scripts/audit-update-ui-auth.js`); it opens
only disposable database copies and issues GET requests.

---

## 1. Executive Summary

**An update foundation genuinely exists and is better than the documentation
claims.** `electron-updater` is wired end to end: real `autoUpdater` events,
IPC, a preload bridge, a Settings → Updates tab with a working state renderer,
channel selection, a schema-compatibility gate, a verified pre-update backup, and
`quitAndInstall`. The data-safety layer — portable-DB migration, safe migrations
with rollback, `deleteAppDataOnUninstall: false` — is the strongest part of the
system and I found no defect in it.

**However, the update experience is not usable today, and one defect is mine.**

The single most important finding: **during the production-readiness phase I added
`authMiddleware` + `requirePermission('settings.manage')` to all 14
`/api/datasafety` routes. `public/js/pages/settings.js` calls 11 of those
endpoints with a bare `fetch()` and no `Authorization` header.** Measured, every
one now returns 401. The Settings → Updates and Data Safety screens cannot reach
their own backend. The shared API wrapper (`public/js/api/client.js`) attaches the
token correctly; these call sites bypass it. My authorization hardening is
correct, and this UI is the regression it exposed.

A second, pre-existing defect: **`/api/datasafety/update-channel` returns 500 and
`PUT` returns 400 for an authenticated admin**, because the route calls
`UpdateService.getChannel()` / `.setChannel()` / `.checkSchemaCompatibility()` as
statics of an exported object that only contains `_provider`, `bindProvider` and
`isNewerVersion`. Those functions are module-level exports. Seven call sites are
affected, including `update-compatibility` and `supportBundle`.

**Biggest blockers:** the missing auth headers (my regression), the broken
`UpdateService` statics, and `autoInstallOnAppQuit = true` which silently violates
the "Later" requirement.

---

## 2. Existing Architecture

```
Electron main (electron/main.js, 292 lines)
├── single-instance lock .................... app.requestSingleInstanceLock()
├── userData routing (BEFORE server load) .. BLACKSTACK_USER_DATA_DIR = app.getPath('userData')
│   └── refuses an override inside the install directory
├── portable DB migration ................... electron/db-migration.js
│   └── verified backup → copy → integrity check → row-count compare; source untouched
├── in-process Express server ............... electron/server-host.js (port 34567)
├── setupAutoUpdate()  [app.isPackaged only]
│   ├── channel from UpdateService.getChannel(); allowPrerelease when beta
│   ├── autoDownload = true
│   ├── autoInstallOnAppQuit = true        ← breaks the "Later" contract
│   ├── events: checking-for-update, update-available, update-not-available,
│   │           download-progress, update-downloaded, error
│   └── check: 15s after start, then every 4h
├── IPC handlers
│   ├── app:getInfo / app:checkForUpdate / app:installUpdate
│   └── app:getChannel / app:setChannel
└── shutdown: server.stop() → _closeCachedConnection() → app.quit()

preload.js (contextBridge, 20 lines)
└── window.desktop = { isDesktop, platform, getAppInfo, checkForUpdate,
                       installUpdate, getChannel, setChannel, onUpdateStatus }

renderer: public/js/pages/settings.js — tab "Updates"
├── #update-status text, #update-actions buttons
├── channel radios (stable / beta / enterprise) → PUT /api/datasafety/update-channel
├── case AVAILABLE / CHECKING / DOWNLOADING / DOWNLOADED / OFFLINE / ERROR / UP_TO_DATE
└── DOWNLOADED → [Restart & Update] + [Later]

installUpdate handler (main.js:211)
├── 1. checkSchemaCompatibility({targetAppVersion, dbSchemaVersion})
│      → INCOMPATIBLE / UNSUPPORTED ⇒ block, log RECOVERY_REQUIRED, return
├── 2. createBackup({label:'pre-update'}) + verifyBackup()
│      → invalid ⇒ block, return
└── 3. au.quitAndInstall(false, true)
```

---

## 3. Update State Machine — actual

Emitted by `electron/main.js`, handled by `settings.js`:

```
            ┌──────────────────────────────────────────────┐
            │ (no updater — dev mode, or require failed)   │
            ▼                                              │
        [ DISABLED ]                                       │
                                                         │
  start+15s ──► CHECKING ──► UP_TO_DATE ──► (idle)         │
                    │                                     │
                    ├─► AVAILABLE ──► (auto-download)     │
                    │                     │               │
                    │                     ▼               │
                    │                 DOWNLOADING (percent only)
                    │                     │               │
                    │                     ▼               │
                    │                 DOWNLOADED ──► "Update Ready"
                    │                        │              │
                    │              [Restart & Update]       │
                    │                        │              │
                    │                        ▼              │
                    │         quitAndInstall → app restarts ─┘
                    │                        │
                    └─► ERROR / OFFLINE ◄────┘
                         (non-fatal, CRM continues)
```

Observed discrepancies against the declared vocabulary:

| State | Emitted by main | Handled by UI | Note |
|---|---|---|---|
| `INSTALLING` | **never** | yes | orphaned UI branch |
| `AVAILABLE` | yes | yes | effectively unreachable — `autoDownload` starts the download immediately |
| `READY_TO_INSTALL` | no (only `UPDATE_STATUS` const) | no | declared but unused |
| `VERIFYING` | no | no | **does not exist** |
| `CHECK_FAILED` / `DOWNLOAD_FAILED` / `INSTALL_FAILED` / `MIGRATION_FAILED` / `STARTUP_FAILED` | no — collapsed into `ERROR` / `OFFLINE` | as `ERROR`/`OFFLINE` | not distinguishable |
| `UPDATED` | no | no | absent |

`UpdateService.UPDATE_STATUS` (11 states, `updateService.js:15`) is **dead code** —
no other file references it.

---

## 4. Audit Matrix

| Capability | Status | Implementation | Evidence / Test | Risk | Required Next Step |
|---|---|---|---|---|---|
| Version detection | **DONE** | `server/version.js` `APP_VERSION`; `electron/main.js:58` | used at startup + logged; `phase3` asserts `getCurrentDbSchemaVersion` reads real DB | LOW | none |
| Update availability check | **DONE** | `autoUpdater.checkForUpdates()`, `main.js:197,199` | wired; fires at 15s and every 4h | LOW | none |
| Update channels | **PARTIAL** | `UpdateService.getChannel/setChannel`, `preferences/update-channel.json`, IPC handlers | `phase3-update-enterprise.test.js` 3 tests pass; **but the HTTP route is broken (500)** | MEDIUM | fix static-vs-module call in `dataSafety.js`; add HTTP-level test |
| Update metadata | **PARTIAL** | GitHub `publish` block in `package.json` | config present; no `latest.yml` committed, no release-evidence test | MEDIUM | verify a real publish produces resolvable metadata |
| Update download | **PARTIAL** | `autoUpdater.downloadUpdate()` on `update-available` | wired; failure caught → `ERROR` | MEDIUM | none functional; confirm download target dir |
| Download progress | **PARTIAL** | `download-progress` → `{percent}` only | `main.js:180` **drops `transferred`/`total`/`bytesPerSecond`** | MEDIUM | forward full progress payload |
| Progress UI (bar, stage, size) | **MISSING** | `settings.js:315` text only: `Downloading… NN%` | no `<progress>`, no bar, no MB, no stage label | HIGH | build progress panel per target UX |
| Download verification | **NOT VERIFIED** | electron-updater internal (NSIS + GitHub checksums) | no test; cannot exercise offline | MEDIUM | document reliance; add checksum assertion on a real artifact |
| Update preparation | **DONE** | `app:installUpdate` → schema gate + verified backup, `main.js:211-244` | `phase3` covers backup + corrupt-backup rejection | LOW | none |
| Background update | **DONE** | download runs in main process, independent of renderer | architecture supports it | LOW | none |
| Minimize update UI | **MISSING** | no minimize control anywhere | no code | MEDIUM | add if required by target UX |
| Continue using app during update | **DONE** | main-process download; `ERROR` path states "CRM continues normally" | architecture supports it | LOW | none |
| Update Ready state | **DONE** | `DOWNLOADED` → "Update Ready" + Restart & Update | `settings.js:319-322` | LOW | none |
| "Later" | **PARTIAL** | button sets text and disables itself, `settings.js:356-359` | **persists nothing**; text says "installed on next restart" | HIGH | persist a postpone decision; reconcile with `autoInstallOnAppQuit` |
| No automatic restart | **DONE** (except quit) | no `quitAndInstall` outside the explicit handler | `autoInstallOnAppQuit=true` is the exception | MEDIUM | set `autoInstallOnAppQuit = false` |
| Database backup pre-update | **DONE** | `createBackup` + `verifyBackup`, `main.js:226-233` | `phase3` "creates and verifies a pre-update backup" | LOW | none |
| Database migration | **DONE** | `safeMigrationRunner` — verified backup → migrate → count compare → rollback on throw | `phase3` 2 recovery tests + `migration-idempotency.test.js` | LOW | none |
| Schema compatibility | **DONE** | `checkSchemaCompatibility`, `updateService.js:60` | `phase3` 5 tests cover all four results | LOW | none |
| Data preservation | **PARTIAL** | DB in `userData`, never in install dir; source DB never deleted; `deleteAppDataOnUninstall:false` | `phase3` isolation tests; `installer-data-preservation.mjs` (**not in CI**) | MEDIUM | add installer acceptance to the release gate |
| Update failure recovery | **PARTIAL** | updater errors are non-fatal; migration rollback exists | no test for update-download/install failure | MEDIUM | add failure-path tests |
| Rollback / recovery | **DONE** | `restoreBackup` on migration throw; `RECOVERY_REQUIRED` gate | `phase3` "restores the verified backup when a migration throws" | LOW | none |
| Downgrade protection | **PARTIAL** | `MIN_SCHEMA_VERSION` floor; unknown version ⇒ INCOMPATIBLE | `phase3` asserts; no downgrade-specific test | LOW | none |
| Logging | **DONE** | `update-logger.js` 10-event taxonomy → `logs/updates.log` | `phase3` "writes standardized event names" | LOW | none |
| Error handling | **PARTIAL** | errors ⇒ `ERROR`/`OFFLINE`, CRM continues | `main.js:188-193` | MEDIUM | distinguish failure states |
| Update tests | **PARTIAL** | 17 tests in `phase3-update-enterprise.test.js` | unit-level; **no route-level, no IPC-level** | HIGH | add HTTP + IPC tests |
| E2E verification | **MISSING** | none | no Playwright coverage of the update flow | HIGH | add |
| Installer verification | **NOT VERIFIED** | `acceptance:installer`, `release:verify-installer` scripts exist | **excluded from `npm test` and the release gate**; requires a real install | MEDIUM | wire into gate |

---

## 5. Data-Safety Assessment

This is the strongest area. No defect found.

| Layer | Mechanism | Evidence | Verdict |
|---|---|---|---|
| DB location | `userData/database/blackstack-crm.db`, outside the install dir; an override pointing inside the install dir is **refused** with a dialog | `main.js:34-47` | sound |
| Portable migration | verified backup → copy → integrity check → per-table row-count compare; **source never deleted**; on any failure: "source untouched" | `db-migration.js:79-117` | sound |
| Pre-migration | `runSafeMigrations({backup:true})` → `createBackup({label:'pre-migration'})` | `safeMigrationRunner.js:190` | sound |
| Migration rollback | on throw → `restoreBackup(backupMeta.file)`; `RECOVERY_REQUIRED` if it cannot proceed | `safeMigrationRunner.js:211,226` | sound |
| Startup migration gate | `app.js:274` refuses to start on `RECOVERY_REQUIRED` / `ABORTED*` | `app.js:275-277` | sound |
| Migration idempotency | verified — no-op migrate leaves the DB unchanged; content fingerprint stable | `tests/migration-idempotency.test.js` | sound |
| Uninstall | `deleteAppDataOnUninstall: false` | `package.json` `build.nsis` | sound |
| Pre-update backup | created **and verified** before `quitAndInstall`; unverified ⇒ block | `main.js:226-233` | sound |
| Schema gate | blocks before backup/install when incompatible | `main.js:216-224` | sound |
| Shutdown | `server.stop()` → `_closeCachedConnection()` → `quit` | `main.js:273-290` | sound |

**Every CRM / Accounting / Inventory / Billing entity is protected**, because all of
them live in one SQLite file covered by the mechanisms above. There is no
per-entity exposure.

**One caveat:** "the update downloaded successfully" is never verified against the
user's data on first launch of the new version. `safeMigrationRunner` covers
migration failure, but there is no post-install startup validation that the
database is intact *after* the update completes.

---

## 6. Test Coverage

**Existing — `tests/phase3-update-enterprise.test.js` (17 tests, all passing):**

| Group | Tests | Level |
|---|---|---|
| update channels | default + persist, reject unknown, never writes to DB | unit |
| schema compatibility | UNSUPPORTED, MIGRATION_REQUIRED, COMPATIBLE, INCOMPATIBLE, reads real DB | unit |
| pre-update safety | creates+verifies backup, corrupt backup never counts as verified | unit + real DB |
| migration recovery | restores backup when migration throws, rollback on post-restore FK failure, stale-lock recovery | unit + real DB |
| audit taxonomy | standardized event names written to `updates.log` | unit |
| Windows event log | never throws on bad input | unit |
| isolation | custom user-data keeps DB+backups inside it; never touches real user data | unit |

**Also:** `tests/migration-idempotency.test.js` (5), `tests/electron-safety.test.js`
(6), `tests/installer-data-preservation.mjs` (acceptance, **not automated**).

**Gaps — and why the two real defects survived:**

1. **No HTTP-level tests of `/api/datasafety/update-*`.** Every test calls
   `require('server/services/updateService.js')` directly, so a route calling
   `UpdateService.getChannel` instead of the exported `getChannel` is invisible.
   `tests/authorization.test.js` touches these routes but asserts only 401/403 —
   never a 2xx body. **This is precisely why the 500 was not caught.**
2. **No IPC-level tests.** `autoUpdater` events, `quitAndInstall`, and the
   `app:installUpdate` safety sequence are untested.
3. **No E2E coverage** of the update flow.
4. **Installer acceptance is not in the gate** (`acceptance:installer` requires a
   real install; it cannot run in CI as configured).

---

## 7. Critical Risks

### CRITICAL

**C1 — Settings → Updates and Data Safety are entirely non-functional (401).**
My authorization hardening on `/api/datasafety` conflicts with 11 bare `fetch()`
calls in `settings.js`. Introduced by me in the production-readiness phase.
Fix: route those calls through the `API` wrapper (or attach the token).

**C2 — `/api/datasafety/update-channel` and `/update-compatibility` return 500 for
an authorized admin; PUT returns 400.** `dataSafety.js` treats module functions as
statics of the exported `UpdateService` object. Seven call sites affected
(`dataSafety.js:191,198,205,218,220`, `supportBundle.js:59`).

### HIGH

**H1 — "Later" does not prevent installation.** `autoInstallOnAppQuit = true`
(`main.js:155`) means quitting after choosing "Later" installs the update anyway.
The UI even says so: *"or installed on next restart."* This contradicts the stated
requirement directly.

**H2 — A pending update is not persisted.** `__pendingUpdateVersion` is an
in-memory global (`main.js:184`). "Later", then restart, loses all knowledge that
an update was downloaded and ready.

**H3 — Update path has no route-level or IPC-level test.** Both critical defects
above sat in code that has 17 passing unit tests.

### MEDIUM

**M1 — Progress payload truncated to `percent`.** `transferred`, `total`,
`bytesPerSecond` are discarded (`main.js:180`), so the target UX's
"72 MB / 100 MB" is not achievable without a code change.

**M2 — Failure states collapsed.** Download / verification / install / migration
failures all surface as `ERROR` or `OFFLINE`.

**M3 — Update metadata never verified.** No evidence a publish produces
resolvable `latest.yml`; no release-artifact test.

**M4 — `INSTALLING` is an orphaned UI branch** (main never emits it) and
`AVAILABLE` is effectively unreachable because `autoDownload` fires immediately.

### LOW

**L1 — `UpdateService.UPDATE_STATUS` is dead code** (11 states, no consumers).

**L2 — No post-install data validation** after the update completes.

---

## 8. Required Implementation Work

Ordered logically. Items 1–3 are prerequisites — the update experience is not
usable until they are done.

1. **Repair the routes I broke and the pre-existing static bug.**
   - Route the 11 bare `fetch()` calls in `settings.js` through the authenticated
     API wrapper. *(Restores C1.)*
   - Correct `dataSafety.js` and `supportBundle.js` to call the module-level
     exports (`getChannel`, `setChannel`, `checkSchemaCompatibility`,
     `getCurrentDbSchemaVersion`, `getUpdateStatus`) rather than
     `UpdateService.*`. *(Resolves C2.)*
2. **Add route-level tests immediately.** Extend `tests/authorization.test.js` (or
   add a dedicated suite) to assert a **2xx body** for every `/api/datasafety/update-*`
   route as an authenticated admin. A 401/403-only assertion is what let C2 through.
3. **Make "Later" real.** Set `autoInstallOnAppQuit = false`; persist the
   postpone decision and the pending-update version to `preferences/` so it
   survives restart. *(Resolves H1, H2.)*
4. **Persist and expose update readiness** so "Update Ready" survives a restart.
5. **Forward the full progress payload** and build the progress UI: stage label,
   progress bar, `transferred`/`total` in MB, error surface. *(M1.)*
6. **Distinguish failure states** — `DOWNLOAD_FAILED`, `VERIFICATION_FAILED`,
   `INSTALL_FAILED` — instead of collapsing into `ERROR`. *(M2.)*
7. **Reconcile the state machine** with the target: add `VERIFYING`, emit
   `INSTALLING`, remove or wire `AVAILABLE`/`READY_TO_INSTALL`, delete the dead
   `UPDATE_STATUS` or make it the single source of truth. *(M4, L1.)*
8. **IPC-level tests** for `app:installUpdate` — assert the compatibility gate and
   verified-backup sequence actually run before `quitAndInstall`, and that a failed
   backup blocks the install.
9. **E2E coverage** of the update flow in the desktop shell.
10. **Post-install startup validation** that the database is intact after an
    update completes. *(L2.)*
11. **Verify the publish path** produces resolvable update metadata, and add a
    release-artifact assertion. *(M3.)*
12. **Wire `acceptance:installer` and `release:verify-installer` into the release
    gate** (they exist but are excluded).
13. **Clean Windows verification** on a real packaged install: update available →
    download → minimize → Later → Restart & Update → data intact.

---

## 9. Final Verdict

```
UPDATE SYSTEM AUDIT — PARTIALLY READY
```

**Why not READY FOR IMPLEMENTATION:** the update *experience* cannot currently be
exercised at all. Opening Settings → Updates produces a 401 on every backend call,
so there is nothing to design a progress UI around until C1 is fixed. Building the
new update interface on top of a screen that cannot load its own data would produce
something that looks complete and fails on first run.

**Why not BLOCKED:** the foundation is real and good. `electron-updater` is wired
end to end, the data-safety layer is sound on every dimension I could verify
(verified backups, rollback, source never deleted, DB outside the install
directory, uninstall preserves data), and 17 tests pass against real
functionality. The blockers are two localized defects — one introduced by me, one
pre-existing — plus a UI/API contract gap. Both are small, well-understood fixes.

**Recommended sequence:** items 1–3 first (repair, then prove with route-level
tests). Once Settings → Updates loads and a 2xx is asserted, the remaining
implementation work becomes verifiable rather than speculative.

**Sequencing note:** item 2 must land with item 1. Adding HTTP tests after
rebuilding the UI would repeat the gap that let both defects survive 17 passing
tests.