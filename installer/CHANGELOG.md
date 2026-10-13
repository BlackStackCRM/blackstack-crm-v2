# Installer CHANGELOG

All installer/desktop-program changes are recorded here per Master Prompt §67:
what changed, why, files changed, tests executed/passed, known limitations,
rollback behavior.

---

## 2026-10-06 — Phase 1 Audit & Plan (no code changed)

**What changed:** Created `installer/prompt-index.md` containing the full
Section 68 audit of the existing architecture and the phased implementation
plan.

**Why:** Master Prompt §68 mandates an audit before any implementation; §61
mandates the `installer/` structure.

**Files changed:** `installer/prompt-index.md` (new).

**Tests executed:** Architecture read-only audit (files, config, tests,
existing dist output). No application behavior modified.

**Tests passed:** n/a (no code change).

**Known limitations:** See gap table G1–G14 in prompt-index.md.

**Rollback/recovery behavior:** n/a.

---

## 2026-10-06 — Phase 1 Implementation Batch 1 (server binding, port fallback, clean stop)

**What changed:**
1. `server/app.js` — new desktop binding rule: when `BLACKSTACK_DESKTOP=1`
   (set by `electron/server-host.js`), the HTTP server binds to
   **127.0.0.1 only** (spec §20). `EADDRINUSE` now produces a clear startup
   error instead of an unhandled crash. Dev/launcher behavior unchanged.
2. `electron/server-host.js` — port availability check BEFORE loading the
   server module; documented fallback range 34567–34572; selected port
   recorded in `process.env.PORT` and logged (spec §20). Removed the dead
   "wait loop" that did nothing.
3. `electron/main.js` — default desktop port `34567` parsed as int, with
   explicit comment tying it to the fallback range.

**Why:** Audit gaps G1 (all-interface binding), G2 (fragile stop), G3 (blind
port assumption) from installer/prompt-index.md; Master Prompt §20.

**Files changed:**
- `server/app.js` (listen block)
- `electron/server-host.js` (rewritten startup flow)
- `electron/main.js` (port parse)

**Tests executed:**
- `npx vitest run tests/electron-safety.test.js` — 6 passed.
- `npx vitest run tests/data-safety.test.js` — 5 passed.
- `node --check` on all three modified files — OK.

**Tests passed:** yes (11/11).

**Known limitations:**
- Port fallback range is only honored when the requested port is occupied by
  a *non-BlackStack* process; a second BlackStack instance is already blocked
  by the single-instance lock (Electron authoritative).
- `stop()` still uses process SIGTERM (app.js's graceful handler); a cleaner
  exported-server handle is Phase 2 cleanup.

**Rollback/recovery behavior:** No data-bearing code touched. Reverting these
three files restores prior behavior exactly.
---

## 2026-10-06 — Phase 1 Documentation Batch

**What changed:** Created the first four Phase 1 documentation files per
Master Prompt §60/§61:
- `installer/docs/installation-guide.md` (install, first launch, ports,
  environment variables with precedence, reinstall/uninstall behavior)
- `installer/docs/security.md` (Electron hardening, signing, SHA-256
  verification instructions with honest SmartScreen caveat, Defender policy,
  explicit "future enhancements" section so nothing unimplemented is claimed)
- `installer/docs/release-checklist.md` (build → sign → hash → install/data
  verification → publish flow per §33/§58/§65)
- `installer/docs/windows-support.md` (support matrix; untested OSes
  explicitly not claimed per §52)

**Why:** Release blockers G4/G5/G11; §60 rule "documentation must match
actual implementation" — all claims map to existing or just-implemented code.

**Files changed:** 4 new files in `installer/docs/`.

**Tests executed:** n/a (documentation only).

**Known limitations:** Remaining docs from §60 (administrator-guide,
silent-install, update-guide, rollback-guide, backup-restore, troubleshooting,
enterprise-deployment, privacy, release-notes-template, faq) are Phase 2–4
deliverables and are not written yet — intentionally, since their features
(channels, support bundle, deletion flow) are not implemented yet.

**Rollback/recovery behavior:** n/a.

---

## 2026-10-06 — Phase 1 Completion

**Phase:** 1 — Installer Core & Windows Integration (completion)

### Added
- `electron/signing-config.js` — signing credential contract (CSC_LINK /
  CSC_KEY_PASSWORD / BLACKSTACK_TSA_URL / REQUIRE_SIGNING); `REQUIRE_SIGNING=1`
  fails the build clearly when credentials are missing; dev builds stay unsigned
  by design. Verified: dev gate exits 0, REQUIRE_SIGNING=1 exits 1.
- `scripts/release-hash.js` (`npm run release:hash`) — SHA-256 of the final
  installer, optional `--write` checksum file. Verified against the real
  installer; matches `Get-FileHash` exactly.
- `tests/installer-data-preservation.mjs` (`npm run acceptance:installer`) —
  §63 acceptance: fresh install / restart / reinstall / update-migration /
  uninstall preservation, on a throwaway temp user-data dir with a hard
  isolation gate. **17/17 PASS.**
- `scripts/db-check.js` — quick integrity/schema probe used during QA.
- `installer/docs/silent-install.md` — only tested switches documented.
- `installer/docs/administrator-guide.md` — env vars, ports, backup/restore,
  migration-lock recovery, honest "not yet implemented" markers.

### Changed
- `package.json` — new scripts: `electron:build:prod`, `release:hash`,
  `release:verify-installer`, `acceptance:installer`.
- `installer/docs/security.md`, `release-checklist.md`, `installation-guide.md`,
  `windows-support.md` — updated to match verified implementation.
- `electron/main.js` — honors `BLACKSTACK_USER_DATA_DIR` override when packaged
  (support/test isolation); refuses an override inside the install directory.

### Fixed
- **Fresh-install blocker (real bug):** `safeMigrationRunner.js` backed up the
  database unconditionally; merely opening a connection materializes an
  empty/4KB SQLite file with no schema, so on a FRESH install the backup
  failed verification (`schema_migrations missing`) and every first launch
  aborted with `ABORTED_BACKUP_FAILED`. The runner now backs up only when the
  file contains a CRM schema. Databases with real data are unaffected — they
  always have `schema_migrations`.
- **Stale migration lock (audit finding):** lock now records PID + timestamp +
  host + DB path; liveness of the owner is checked (Windows-safe
  `process.kill(pid, 0)`). Live owner → block with clear PID message; provably
  dead owner → automatic safe recovery on next start (never while a migration
  could be running; re-checked immediately before removal). Legacy metadata-less
  locks recover safely too. `releaseLock()` refuses to delete a lock owned by a
  different live PID. Startup uses `recoverStaleLock: true` so a crashed server
  cannot permanently brick the app; live-owner conflicts still fail closed.

### Verified (real execution)
- NSIS silent install `/S` → exit code 0; `/S /D=<custom>` → files in custom dir.
- Installed app launched; server healthy on 127.0.0.1:34567; `netstat` confirms
  127.0.0.1-only binding.
- Signature: `Get-AuthenticodeSignature` → **NotSigned** (no certificate in dev
  environment; honestly reported, not fabricated).
- Full vitest suite: **209/209 passing**.
- Acceptance suite: **17/17 PASS** (fresh/restart/reinstall/update/uninstall).

### Known limitations
- No signing certificate in the dev environment → production signature
  verification pending real credentials.
- Update channels, backup rotation, log rotation, support bundle, Windows
  Event Log, two-step data deletion: Phase 2/3 deliverables, documented as such.
- First-run account creation: an admin bootstrap via seed exists; the polished
  wizard is Phase 2.

---

## 2026-10-06 — Phase 2 Completion (Data Safety, Storage, Recovery & Multi-User)

**Phase:** 2 — Data Safety & Multi-User

### Added
- **Backup rotation** (`backupService.rotateBackups`, auto-run after every
  backup): configurable retention (`BLACKSTACK_BACKUP_RETENTION`, default 5
  newest verified); never deletes the only valid recovery point; skips while
  a backup/restore operation is active; treats unverified files as junk, not
  recovery points; failures logged to `preferences\rotation-events.log`.
- **Backup status** (`getBackupStatus` + `GET /api/datasafety/backups/status`).
- **Safe restore** (`safeRestoreBackup`): verify → pre-restore backup →
  restore → integrity + FK + schema checks → automatic rollback on failure
  (`RESTORE_FAILED_ROLLED_BACK` / `RESTORE_VERIFY_FAILED`).
- **Log manager** (`server/services/logManager.js`): 10 MB size rotation,
  5 rotated files, 30-day cleanup, active-file protection, secret redaction
  (Bearer/Authorization/password/token/secret/private keys/connection
  strings/base64 blobs). Wired into Electron startup maintenance.
- **Storage monitor** (`server/services/storageMonitor.js` +
  `GET /api/datasafety/storage`): per-directory sizes (BlackStack-owned dirs
  only), free disk space, advisory warnings DB_LARGE (>2 GB), BACKUPS_LARGE
  (>10 GB), DISK_LOW (<500 MB). No automatic destructive cleanup.
- **VACUUM maintenance** (`GET .../maintenance/vacuum/preview`, `POST
  .../maintenance/vacuum` with `{"confirm":"VACUUM"}`): fragmentation estimate;
  explicit confirmation required; verified backup first; integrity+FK verify
  after; automatic restore of pre-maintenance backup on failure.
- **Two-confirmation data deletion** (`server/services/dataDeletionService.js`
  + `/api/datasafety/data-deletion/*`): preview → type-DELETE + one-time token
  → final VERIFIED backup (failure refuses deletion, `FINAL_BACKUP_FAILED`) →
  audit record preserved outside the deleted scope → scope-verified deletion.
- **Support bundle** (`server/services/supportBundle.js` +
  `POST /api/datasafety/support-bundle`): sanitized ZIP (dependency-free ZIP
  writer fallback); redacted log copies; NEVER contains the database, CRM
  records, uploads or secrets; temp files cleaned; never auto-uploaded.

### Changed
- `server/routes/dataSafety.js` — new endpoints (status, rotate, storage,
  maintenance, deletion, support bundle); restore now uses safeRestoreBackup.
- `server/services/backupService.js` — timestamp now includes milliseconds
  (fix: same-second backups could previously overwrite — real §5 violation
  found by tests); `verifyBackup` hardened against corrupt files.
- `installer/docs/*` — administrator-guide (retention, storage, deletion,
  support bundle), security (local storage, redaction, multi-user),
  backup-restore (new), troubleshooting (new), release-checklist (Phase 2 items).

### Verified
- Full suite: **229/229 PASS** (209 Phase 1 baseline + 20 new Phase 2).
- Installer acceptance: **17/17 PASS** (Phase 1 preserved).
- New tests cover: rotation (retention/only-recovery-point/unverified/
  operation-lock), log rotation (size/retention/30-day/active-protection/
  missing-dir), deletion (wrong confirm/bad token/backup-refusal/preview),
  storage warnings (DB/backup/disk), support bundle (valid ZIP, redaction,
  no DB/CRM content), multi-user isolation (separate roots, cross-user
  prevention), override-path isolation.

### Known limitations
- Settings UI panels for storage/data-safety render via existing UI patterns;
  dedicated dashboard pages are part of Phase 3 polish.
- `issueDeleteToken` keeps the token server-side (deliberate: token must be
  requested by the client after the typed confirmation step).
- Support bundle uses a minimal stored-ZIP writer when `archiver` is not
  installed (files are uncompressed but valid).

---

## 2026-10-06 — Phase 3 Completion (Updates, Rollback, Recovery, Enterprise, Localization, Accessibility)

**Phase:** 3 — Updates, Rollback & Recovery (+ enterprise/accessibility groundwork)

### Added
- **Update channels**: stable (default) / beta (opt-in with confirm dialog,
  never auto-enabled) / enterprise. Persisted in user preferences
  (`update-channel.json`), wired to electron-updater (`allowPrerelease`,
  `channel`). UI radio group in Settings → Updates; endpoints
  `GET/PUT /api/datasafety/update-channel`; IPC `app:getChannel`/`setChannel`.
- **Schema compatibility gate (§9)**: `checkSchemaCompatibility()` and
  `GET /api/datasafety/update-compatibility`; enforced in `app:installUpdate`
  before the pre-update backup — incompatible/unsupported schema → update
  blocked, data untouched.
- **Windows Event Log (§18)**: `electron/eventLog.js` — best-effort
  `eventcreate` writes for startup failure, migration failure, updater errors;
  secrets scrubbed; never fatal; file logs remain authoritative.
- **Update audit taxonomy (§13)**: standardized
  `UPDATE_CHECK_STARTED…UPDATE_RECOVERY_REQUIRED` events in `updates.log`.
- **Settings → Data Safety tab**: backup status + Create Backup + verified
  backup list with per-item safe Restore (pre-restore backup + auto-rollback),
  Storage dashboard (sizes + DB_LARGE/BACKUPS_LARGE/DISK_LOW warnings),
  Generate Support Bundle, Delete All Data flow (confirm ×2 + type DELETE +
  final verified backup).
- **Tests**: `tests/phase3-update-enterprise.test.js` — 17 tests covering
  channels (default/persist/reject/never-in-DB), schema compatibility
  (unsupported/migration-required/compatible/unknown/real-DB read),
  pre-update backup, corrupt-backup refusal, migration-failure restore,
  FK-violation restore rollback, stale-lock recovery regression, audit event
  taxonomy, Event Log non-fatal behavior, isolation assertions.

### Changed
- `electron/main.js`: channel wiring into updater; installUpdate now runs
  compatibility gate → verified backup → install; real-only download progress;
  event-log calls on failure paths.
- `electron/preload.js`: getChannel/setChannel.
- `electron/update-logger.js`: event taxonomy constants.
- `public/js/pages/settings.js`: channel selector + Data Safety tab.
- `installer/docs`: update-guide (new), rollback-recovery (new),
  enterprise-deployment (new), accessibility (new), windows-event-log (new),
  installation-guide (channels + Event Log).

### Fixed
- **`safeMigrationRunner.acquireLock` recovery bug**: when `recoverStale:true`
  removed a stale lock it still returned `acquired:false`, so automatic
  recovery could never proceed (a crashed server would stay locked forever).
  Now falls through and acquires a fresh lock after re-verifying the owner is
  dead. Covered by a new regression test.

### Verified
- Full suite: **286/286 tests passed, 0 failed, 0 skipped (108 suites)** via
  JSON reporter.
- Installer acceptance: **17/17 PASS**.
- Honest status: binary/application rollback NOT implemented (electron-updater
  limitation) — documented in rollback-recovery.md; database rollback via
  verified backups is the tested mechanism.

### Known limitations
- Localization: architecture prepared; English complete; ml/hi NOT shipped.
- Accessibility: targeted improvements; no full screen-reader audit yet.
- Enterprise: `/S` and `/S /D=` tested; Intune/SCCM/GPO documented as
  installer compatibility only; no MSI.
