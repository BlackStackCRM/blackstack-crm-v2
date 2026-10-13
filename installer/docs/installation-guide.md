# BlackStack CRM — Installation Guide (Windows)

Applies to: BlackStack CRM desktop edition (Electron), version 1.0.0+.

## System requirements

| Component | Requirement |
|---|---|
| OS | Windows 10 1809+ or Windows 11, 64-bit |
| Disk | ≥ 500 MB free on the system drive |
| Runtime | None required for the user — Node.js/Electron runtime is bundled |
| Privileges | Administrator only when installing to `C:\Program Files` (UAC prompt) |
| Network | Optional — the CRM works fully offline; updates require internet |

## Where things are installed

| What | Location | Notes |
|---|---|---|
| Application binaries | `C:\Program Files\BlackStack CRM` (default; changeable in the wizard) | Contains only program files. |
| **User data** | `%APPDATA%\BlackStack CRM` | Database, backups, uploads, logs, locks. Per-Windows-user, isolated (spec §18/§23). |
| Database | `%APPDATA%\BlackStack CRM\database\blackstack-crm.db` | SQLite, WAL mode. |
| Verified backups | `%APPDATA%\BlackStack CRM\backups\` | Created before every migration/update. |

**Rule:** the install directory never contains user data. Uninstalling the
application does **not** delete user data (spec §37).

## Standard installation

1. Download `BlackStack CRM Setup <version>.exe` from the official release page.
2. *(Recommended)* Verify the SHA-256 hash — see `security.md` §"Verifying the installer".
3. Double-click the installer. A standard wizard appears:
   - Welcome → what is installed and where.
   - License agreement → acceptance required.
   - Install location (changeable).
   - Ready to install → summary.
   - Progress → real installation steps.
   - Finish → optional "Launch BlackStack CRM".
4. Shortcuts are created on the Desktop and in the Start Menu.

## First launch (fully automatic)

On first launch the application:

1. Uses `%APPDATA%\BlackStack CRM` as the user-data root.
2. Detects any pre-existing database (including databases from a previous
   portable/dev installation — they are migrated safely with a verified
   backup; the source is never deleted).
3. Runs safe, sequential schema migrations (tracked in `schema_migrations`
   with checksums). On any failure: stop, leave the database untouched,
   show a recovery message.
4. Starts the local CRM server **bound to 127.0.0.1 only**.
5. Opens the CRM window when the health check passes.

No Node.js, npm, terminal, or manual database work is ever required.

## Ports

- Default desktop port: **34567**, bound to **127.0.0.1** (never `0.0.0.0`).
- If 34567 is occupied by another process, the app uses fallback ports
  **34568–34572** and records the selection in the log.
- **No Windows Firewall inbound rule is created** — the server is local-only
  (spec §21).

## Environment variables

| Variable | Purpose | Default | Valid values | Example | Security notes |
|---|---|---|---|---|---|
| `BLACKSTACK_USER_DATA_DIR` | Overrides the user-data root (DB, backups, logs) | `%APPDATA%\BlackStack CRM` | Any writable path | `D:\CRMData` | Point only to trusted local storage. Set BEFORE launching, by the app itself; manual override is for support/testing. |
| `BLACKSTACK_PORT` / `PORT` | HTTP port for the local CRM server | `34567` | 1024–65535 | `34570` | Local only; changing it does not expose the app to the network. |
| `BLACKSTACK_LOG_LEVEL` | Log verbosity | `info` | `debug`, `info`, `warn`, `error` | `warn` | `debug` may include more technical detail; never secrets. |
| `NODE_ENV` | Runtime mode | `production` (packaged app) | `production`, `development` | `production` | Do not set `development` in production installs. |

Precedence: **environment variable → user/application configuration → built-in default.**

## Silent / unattended installation

See `silent-install.md`. The tested switches are `/S` and `/S /D=<path>`
(verified against the real generated installer, exit code 0).

## Update channels (stable/beta/enterprise)

Phase 3 implements channels: **stable** (default), **beta** (explicit opt-in
with a confirmation dialog; never auto-enabled), and **enterprise** (follows
stable; intended for IT-managed rollouts). Stored in
`preferences\update-channel.json` — never in the database. The active channel
is shown in Settings → Updates and selectable there.

## Reinstall & upgrades

- Running the installer again over an existing installation performs an
  upgrade/reinstall. **User data is preserved** in all cases.
- Before any database migration, a verified backup is created in
  `%APPDATA%\BlackStack CRM\backups\` (default retention: 5).
- If an installation/update fails midway, the installer rolls back the
  application files; the database is never reset or recreated (spec §12).
- Verified data-preservation acceptance (fresh install / reinstall / update /
  uninstall) can be re-run at any time with `npm run acceptance:installer`.
- Schema compatibility is checked before an update is allowed to install
  (Settings → Updates shows a clear "Update blocked" message when the new
  version cannot safely use the current database). See `update-guide.md` and
  `rollback-recovery.md`.

## Windows Event Log

Critical events (startup failure, migration failure, update failure/recovery)
are additionally written to the Windows Application event log (source
"BlackStack CRM") on a best-effort basis. See `windows-event-log.md`.

## Uninstallation

- Removes application files and shortcuts only.
- `%APPDATA%\BlackStack CRM` (your CRM database) is **kept** so a later
  reinstall recovers your data.
- Deleting all data permanently requires a separate, explicit in-app flow
  with two confirmations (including typing `DELETE`) and a final verified
  backup first — see `administrator-guide.md`.
