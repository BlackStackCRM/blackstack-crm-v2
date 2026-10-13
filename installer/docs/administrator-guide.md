# Administrator Guide — Black CRM Desktop

Operational reference for installing, configuring, monitoring, backing up and
recovering BlackStack CRM on Windows. Every item reflects implemented
behavior; future/unimplemented items are explicitly marked.

## 1. Installation and layout

See `installation-guide.md` for the full walkthrough. Summary:

| Item | Location |
|---|---|
| Binaries | `C:\Program Files\BlackStack CRM` (default, changeable) |
| User data (per Windows user) | `%APPDATA%\BlackStack CRM` |
| Database | `%APPDATA%\BlackStack CRM\database\blackstack-crm.db` |
| Backups | `%APPDATA%\BlackStack CRM\backups\` |
| Logs | `%APPDATA%\BlackStack CRM\logs\` |
| Locks | `%APPDATA%\BlackStack CRM\locks\` |
| Server | In-process, bound to **127.0.0.1** only |
| Default port | 34567; automatic fallback 34568–34572 (recorded in logs) |

## 2. Configuration

### Environment variables

| Variable | Purpose | Default | Valid values | Example | Notes |
|---|---|---|---|---|---|
| `BLACKSTACK_USER_DATA_DIR` | Overrides the user-data root | `%APPDATA%\BlackStack CRM` | Any writable local path | `D:\CRMData` | Never point inside the install directory; the app rejects that and falls back to the default. Used for support/testing isolation. |
| `BLACKSTACK_PORT` / `PORT` | Local server port | `34567` | 1024–65535 | `34570` | If occupied, automatic fallback within 34567–34572; never exposed to the network. |
| `BLACKSTACK_LOG_LEVEL` | Log verbosity | `info` | `debug`, `info`, `warn`, `error` | `warn` | Never contains secrets. |
| `NODE_ENV` | Runtime mode | `production` when packaged | `production`, `development` | `production` | Setting `development` in production installs is unsupported. |
| `DEMO_MODE` | Enables demo seeding at startup | `false` | `true`, `false` | `false` | **Leave false in production** — `true` seeds demo business data. |
| `MIGRATION_BACKUP` | Create pre-migration backup | `true` | `true`, `false` | `true` | Disabling is strongly discouraged; diagnostics only. |
| `BLACKSTACK_BACKUP_RETENTION` | Verified backups kept by rotation | `5` | 1–100 | `10` | Values below 1 are clamped to 1. |
| `BLACKSTACK_LOG_MAX_MB` | Per-log-file rotation size | `10` | 1–1000 | `10` | MB units. |
| `BLACKSTACK_LOG_RETAIN` | Rotated log files kept per category | `5` | 1–50 | `5` | |
| `BLACKSTACK_LOG_MAX_AGE_DAYS` | Log retention before cleanup | `30` | 1–365 | `30` | Active file is never deleted. |
| `REQUIRE_SIGNING` | Build-time: fail release build without signing credentials | unset | `1` | `1` | Used by `npm run electron:build:prod` only. |

**Precedence:** environment variable → user/application configuration → built-in default.

## 3. First run

1. The app creates the user-data structure on first launch.
2. Safe migrations run automatically (idempotent, checksum-tracked in
   `schema_migrations`, with a verified pre-migration backup for databases
   that already contain data).
3. The initial administrator account is created by the existing seeding
   mechanism (`DEMO_MODE=true` creates demo data + admin; production
   deployments should create the admin account in the first-run UI, or use
   `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` with `npm run seed`
   before first launch).

## 4. Monitoring

### Health check

`GET http://127.0.0.1:34567/health` → `{"success":true,"data":{"status":"ok",...}}`
If the default port was busy, check the app log (`logs\app-*.log`) for
`Fallback selected: port NNNNN`.

### Database & storage

`GET /api/datasafety/storage` (Settings → Storage) reports database, backups,
uploads, logs, cache and preferences sizes plus available disk space and
advisory warnings. Thresholds: database > 2 GB (`DB_LARGE`), backups > 10 GB
(`BACKUPS_LARGE`), free disk < 500 MB (`DISK_LOW`). Warnings never trigger
automatic cleanup. See `backup-restore.md` for maintenance (VACUUM) options.

## 5. Backups and restore

See `backup-restore.md` for the complete picture. Summary:

- A **verified** backup is created automatically before every migration,
  update, restore, VACUUM, and manual backup.
- Backups live in `%APPDATA%\BlackStack CRM\backups\` as
  `database-v<version>-<timestamp>-<label>.sqlite` plus a `.json` metadata file.
- **Retention:** the 5 newest verified backups are kept by default
  (`BLACKSTACK_BACKUP_RETENTION` env var, e.g. 5/10/20). Rotation never
  deletes the only valid recovery point and never runs while a backup/restore
  operation is active.
- Restore uses the safe sequence (verify → pre-restore backup → restore →
  integrity + FK + schema checks → automatic rollback on failure) via
  `POST /api/datasafety/backups/restore`.
- Emergency manual restore when the app cannot start: see `backup-restore.md`
  §"Emergency manual restore".

## 6. Migration lock: what it means and how to recover

The migration runner uses a lock file
(`%APPDATA%\BlackStack CRM\locks\migration.lock`) to guarantee that only one
migration process can touch the database.

- The lock records: format version, start time, **process ID**, hostname, and
  database path.
- **Lock owner alive** (e.g. another app instance is genuinely migrating):
  startup is blocked with `RECOVERY_REQUIRED` and a message naming the PID.
  Do nothing; the running process will release the lock when finished.
- **Stale lock** (owner process is provably dead, e.g. after a crash or
  forced kill): the app recovers automatically on the next start and proceeds.
  The database is never touched until the lock situation is resolved.
- Legacy locks (no PID metadata, from older builds) are treated as stale and
  also recovered automatically.
- **Never** delete `migration.lock` by hand while any BlackStack process is
  running. Manual deletion is only for support diagnostics with all app
  instances closed.

## 7. Deleting all data (destructive — two-step confirmation)

Implemented as an explicit, fail-safe flow (API: `/api/datasafety/data-deletion/*`):

1. **Preview** (`GET .../preview`): shows exactly what will be deleted
   (database, backups, uploads, preferences, logs, locks, updates, cache) and
   their sizes. Application binaries in Program Files are never touched.
2. **Confirmation 1**: explicit warning — *this cannot be undone*.
3. **Confirmation 2**: the user must type exactly `DELETE`, then a one-time
   token is issued (`POST .../token`).
4. **Execute** (`POST .../execute` with typed `DELETE` + token):
   - a final **verified** backup of the database is created first;
   - if the final backup cannot be created/verified → deletion is REFUSED
     (`FINAL_BACKUP_FAILED`); data is untouched;
   - a deletion audit record (timestamp, Windows user, app version, scope,
     backup location) is preserved **outside** the deleted scope (in `%TEMP%`);
   - the BlackStack user-data root is deleted and the deletion is verified.

Uninstall never triggers this flow; deletion requires the explicit API/UI path.

## 8. Updates

- The app checks for updates in the background (never blocking startup) and
  shows status in the UI. Installing an update automatically creates and
  verifies a database backup first; if the backup cannot be verified the
  update is refused.
- If an update fails, restart the app: the previous version remains usable
  and the database untouched. Restore a backup only if a migration actually
  corrupted data (see §5).
- Update channels (stable/beta/enterprise) are a Phase 3 deliverable.

## 9. Diagnostics for support

**Support bundle (Settings → Help → Generate Support Bundle):**
`POST /api/datasafety/support-bundle` creates a sanitized ZIP (in `%TEMP%`)
containing: app/Electron/OS versions, database schema version and migration
history, backup status, storage status, update status, and **redacted** recent
logs. It NEVER contains CRM records, the database, uploads, or secrets —
every text file passes through secret redaction (Bearer tokens, passwords,
API keys, private keys, connection strings). Nothing is uploaded
automatically; the user chooses where to send it.

When reporting a problem manually, include the bundle or:

- `%APPDATA%\BlackStack CRM\logs\` (recent files; secrets are redacted)
- App version: shown in the app / from the installer filename
- The exact error message shown by the app, if any

## 10. Known limitations (current build)

- Update channels (stable/beta/enterprise), Windows Event Log integration,
  and the Settings UI panels for storage/data-safety are Phase 3 deliverables
  (the underlying Phase 2 APIs exist and are tested).
- The "Autonomous Agent" described in early planning documents does not exist
  as a separate process; AI features use a local Ollama service if installed
  (optional, port 11434) and degrade gracefully otherwise.
