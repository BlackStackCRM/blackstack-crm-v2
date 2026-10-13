# BlackStack CRM — Installer & Desktop Program Index

This directory tracks the conversion of BlackStack CRM into a production-grade
Windows desktop application, driven by the Master Prompt (71 sections).

## Document map

| File | Purpose |
|---|---|
| `prompt-index.md` | This index + Phase 1 audit summary + implementation plan |
| `CHANGELOG.md` | Change control record for every installer milestone (§67) |
| `docs/…` (created per phase) | User/administrator documentation per §60 |

## Phase 1 audit (completed 2026-10-06)

Audited per Master Prompt §68 before any implementation. Key findings:

### Already implemented (reuse — do not rebuild)
- **Electron main process** (`electron/main.js`): single-instance lock
  (`requestSingleInstanceLock`), `BLACKSTACK_USER_DATA_DIR` set to
  `app.getPath('userData')` before backend boot, subdirectory scaffolding
  (`backups/ uploads/ preferences/ locks/ updates/ logs/ database/`),
  in-process Express server, health-wait before window load, graceful
  shutdown, electron-updater wiring with **verified pre-update backup**.
- **Portable DB migration** (`electron/db-migration.js`): idempotent, verified
  backup before copy, integrity check, row-count comparison, source never
  deleted, aborts on any failure (spec §2/§24 compliant).
- **Secure preload** (`electron/preload.js`): `contextIsolation: true`,
  `nodeIntegration: false`, minimal `window.desktop` API only.
- **Path abstraction** (`server/config/userDataPath.js`): honors
  `BLACKSTACK_USER_DATA_DIR`; single source for DB/backups/locks paths.
- **Data-safety services**: `backupService.js` (create/verify/restore),
  `safeMigrationRunner.js` (sequential migrations, checksums, integrity,
  restore-on-failure), `updateService.js` (provider-binding stub).
- **Installer build**: `electron-builder` NSIS config in `package.json`
  (assisted installer, changeable install dir, `deleteAppDataOnUninstall: false`
  → uninstall preserves `%APPDATA%\BlackStack CRM` per §37). A first
  `BlackStack CRM Setup 1.0.0.exe` was previously built to `dist/`.
- **Tests**: `tests/electron-safety.test.js`, `tests/data-safety.test.js`.

### Gaps found (drives the plan below)
| # | Gap | Spec section | Risk |
|---|---|---|---|
| G1 | `server/app.js` listens on all interfaces (`app.listen(PORT)`) | §20 | Medium — local server exposed on LAN |
| G2 | `electron/server-host.js` stop() sends SIGTERM to own PID (fragile) | §4/§57 | Low |
| G3 | No port-availability check / fallback strategy | §20 | Medium |
| G4 | No code signing configuration | §34 | High (public release blocker) |
| G5 | No SHA-256 release hashing step / release checklist | §33 | High |
| G6 | No update channels (stable/beta/enterprise) | §30 | Low |
| G7 | No log rotation | §43 | Medium (disk growth) |
| G8 | No support bundle generation | §45 | Low |
| G9 | No double-confirmation "delete all data" flow | §38 | Medium |
| G10 | No Windows Event Log integration | §46 | Low |
| G11 | No `installer/docs/` documentation set | §60 | High (release blocker) |
| G12 | First-launch wizard / skip / local-mode flow | §16/§17 | Low |
| G13 | DB/backup size monitoring + Settings → Storage | §28 | Low |
| G14 | No installer rollback UX guarantees documented/tested | §12 | Medium |

### Interpretation notes (anti-fabrication, §60)
- **"Autonomous Agent"**: no standalone Agent process exists in this codebase.
  The nearest components are the Ollama-backed `ai.service.js` (port 11434,
  optional) and the legacy `launcher/app.js` gateway (3000→3001), which the
  Electron path does not use. We will NOT invent a fake Agent. Electron-mode
  runs the CRM backend in-process; AI features degrade gracefully when Ollama
  is absent (already the case). Document this honestly in docs/faq.md.
- **Port**: production Electron port is `34567` (set in `electron/main.js`);
  dev ports 3000/3001 belong to the launcher workflow, not the desktop app.
- **Silent install**: NSIS `/S` will only be documented AFTER being tested
  against the real generated installer (§36).

## Implementation plan

### Phase 1 — Installer core & Windows integration (current)
1. Bind server to `127.0.0.1` in Electron mode (G1).
2. Port availability check + fallback + recorded/propagated selected port (G3).
3. Clean in-process server stop (G2).
4. Code signing hooks (env-driven; placeholder until cert available) (G4).
5. Release process: build → hash (SHA-256) → publish checklist (G5).
6. Tested silent-install documentation (G5/G11).
7. Installer/upgrade verification script (fresh install, reinstall, update,
   data preservation) — see §58 checklist in CHANGELOG.
8. `installer/docs/installation-guide.md`, `security.md`,
   `release-checklist.md`, `windows-support.md`.

### Phase 2 — Data safety & multi-user
1. Backup rotation (default 5 verified, configurable, never delete all) (§27).
2. Log rotation (10 MB / 5 files / 30 days) (G7/§43).
3. Double-confirmation data deletion (type DELETE, final backup first) (G9/§38).
4. DB/backup/uploads size monitoring + Settings → Storage (G13/§28).
5. Support bundle generator (redacted) (G8/§45).
6. Multi-user isolation verification (§23).
7. Version/schema compatibility gate at startup (§25 — partially exists in
   safeMigrationRunner; wire explicit block + recovery message).

### Phase 3 — Updates, rollback & recovery
1. Update channels in preferences (stable default, beta opt-in) (G6/§30).
2. Update diagnostics + failure UI states (§29/§32).
3. Crash logs (opt-in upload; local always) (§44).
4. Windows Event Log for critical failures (G10/§46).
5. Failed-update recovery runbook + tests (§31/§63).

### Phase 4 — Enterprise, localization, accessibility, QA
1. Enterprise deployment docs (Intune/SCCM/GPO, silent install) (§36/§53).
2. Accessibility pass on installer-facing UI (§54).
3. Localization architecture (en default; ml/hi only when actually
   translated — no untested claims) (§55).
4. Offline installer architecture decision (§47 — future, measured size).
5. Full acceptance-test pass per §63–§65.

## Rules honoured
- No second migration/backup system was introduced; existing
  `safeMigrationRunner` + `backupService` remain authoritative (§3).
- Nothing in this plan can destroy user data. All destructive flows are
  deferred behind double confirmation + verified backup (§38/§69).
