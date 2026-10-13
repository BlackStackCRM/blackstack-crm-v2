# Phase 3 Architecture Audit

Audit performed 2026-10-06 before any Phase 3 implementation, per the
"search the complete repository" rule. Frozen baselines: Phase 1 (installer,
Electron, data safety) and Phase 2 (rotation, storage, deletion, support
bundle) — 252 tests passing, 17/17 installer acceptance.

## Update infrastructure

| Component | State | Notes |
|---|---|---|
| `electron-updater` | EXISTS | Integrated in `electron/main.js`: background check (15s initial, 4h interval), auto-download, `update-downloaded`, verified pre-update **backup** before `quitAndInstall` (backup before update already implemented in Phase 1!). |
| `UpdateService` (server/services) | EXISTS | Provider-binding stub; `getUpdateStatus` used by support bundle & dataSafety route. |
| Update status events → UI | EXISTS | `electron/ipc.js` `sendToRenderer('update-status', …)`; preload exposes `onUpdateStatus`; statuses CHECKING/UP_TO_DATE/AVAILABLE/DOWNLOADING/DOWNLOADED/OFFLINE/ERROR. |
| Update UI | EXISTS | `public/js/pages/settings.js` → `renderUpdates`: full status display, manual "Check for Updates" with Checking…/up-to-date/available/offline/error states, "Restart & Update" with pre-install backup, error surfacing. |
| Download progress | PARTIAL | Uses `download-progress` percent when provided; there is no fabricated progress. Indeterminate fallback exists via message text. |
| Update channels | **MISSING** | No channel concept anywhere. → implement in `updateService` + preferences, wired to electron-updater `channel`/allowPrerelease. |
| Schema compatibility gate for updates | **MISSING** | `version.js` has `MIN_SCHEMA_VERSION` + `compareVersions`; no update-time compatibility check. → implement. |
| Update audit log | PARTIAL | `electron/update-logger.js` (18 lines) logs app-start/update events to `logs/`. Extend with the §13 event taxonomy. |
| package.json version | EXISTS | `1.0.0`, must stay in sync with `server/version.js` `APP_VERSION` (single authoritative source documented). |

## Recovery infrastructure

| Component | State |
|---|---|
| `backupService` (create/verify/rotate/safe restore) | EXISTS (authoritative) |
| `safeMigrationRunner` (lock+PID, backup, rollback, integrity) | EXISTS (authoritative) |
| Data-safety APIs | EXISTS (`server/routes/dataSafety.js`) |
| Rollback-on-failed-migration | EXISTS (tested) |
| Binary/app rollback | **NOT IMPLEMENTED** — will be documented honestly; electron-updater NSIS path does not provide tested app rollback. |
| Crash/recovery UI | PARTIAL — `dialog.showErrorBox` paths exist in main; renderer-side recovery screen MISSING. |

## Settings / UI

| Component | State |
|---|---|
| Settings page | EXISTS — tabs: Account, Appearance, System, Updates (`settings.js`) |
| Updates panel | EXISTS (see above) — needs channel selector + schema-compat display |
| Data Safety / Storage panels | **MISSING** — Phase 2 APIs exist; UI panels to be added as new "Data Safety" tab |
| Support bundle UI | **MISSING** — Phase 2 API exists; add button in Data Safety tab |
| Modal system | EXISTS — `public/js/components/…Modal…` used by settings (confirmResetCrmData) |
| Toast/notifications | EXISTS in component set (used across pages) |

## Windows integration

| Component | State |
|---|---|
| NSIS installer config | EXISTS (assisted, `deleteAppOnUninstall:false`, x64) |
| Silent install | EXISTS + TESTED (`/S`, `/S /D=`) |
| Code signing gate | EXISTS (`electron/signing-config.js`) |
| Windows Event Log | **MISSING** → implement non-fatal writer (PowerShell `EventWrite`/`eventcreate` fallback or `winston`-free native attempt; must never break startup) |
| Firewall rule | EXISTS (correctly: none created) |
| Single instance | EXISTS (Electron lock + diagnostic file) |
| Port fallback / 127.0.0.1 | EXISTS + tested |

## Localization

| Component | State |
|---|---|
| Translation architecture | **MISSING** (hard-coded English strings throughout `public/js`) |
| Installer language | electron-builder NSIS defaults (en) |
| Plan | Add minimal `public/js/i18n.js` dictionary architecture (en complete; ml/hi scaffolding marked untranslated, NOT shipped as "supported") |

## Accessibility

| Item | State |
|---|---|
| Keyboard nav on tabs/buttons | PARTIAL — native `<button>`s are focusable/Enter-activatable; no arrow-key tab nav, no visible focus audit |
| Modals | PARTIAL — Modal component exists; focus trap/Escape/restore not verified |
| Labels/ARIA | PARTIAL — some unlabeled icon buttons |
| Contrast | Material 3 tokens in use (base palette is AA) |
| Plan | Targeted fixes only (tablist roles, focus trap in Modal, aria-labels, focus-visible) |

## Conclusion
No duplicates or conflicts found. Phase 3 work: channels, schema-compat gate,
update audit taxonomy, Event Log, Data Safety/Storage/Support UI tab, recovery
screen, i18n architecture, accessibility fixes, enterprise docs. All
extensions of existing systems.
