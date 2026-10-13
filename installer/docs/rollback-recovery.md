# Rollback & Recovery — BlackStack CRM

Honest separation of what is automatic, what is manual, and what does not exist.

## Database rollback (implemented, tested, automatic)

Every risky operation is wrapped by the existing verified-backup architecture:

| Operation | Protection |
|---|---|
| Schema migration | verified pre-migration backup → migration → integrity + FK + row-count checks → **auto-restore on failure** |
| Update install | verified pre-update backup (created only after the schema-compatibility gate passes) |
| Restore | verified pre-restore backup; post-restore integrity + FK checks; **auto-rollback to pre-restore state on failure** (`RESTORE_FAILED_ROLLED_BACK`) |
| VACUUM | verified pre-maintenance backup; auto-restore on failed verification |

Manual recovery paths are in `backup-restore.md` (in-app restore, emergency
file-level restore) and `troubleshooting.md`.

## Application (binary) rollback — NOT implemented

electron-updater with NSIS does **not** provide a tested automatic rollback to
a previous app version. Honest status:

- If an update fails during installation, Windows keeps the previous
  installation intact (NSIS replaces files at the end); the next launch runs
  the previous version with the untouched database.
- If an update installs but the new version cannot start:
  1. Your data is safe (the update never modified the database until the
     verified backup existed).
  2. Reinstall the previous version's installer (download from the release
     page); user data in `%APPDATA%\BlackStack CRM` is preserved and picked up
     automatically.
- We do not claim or fake automatic binary rollback.

## Startup failure recovery

- **Stale migration lock**: detected via PID liveness; auto-recovered on the
  next start when the owner process is provably dead. A live owner blocks
  startup with `RECOVERY_REQUIRED` naming the PID (fail-closed).
- **Migration failure at startup**: the app refuses to start against an
  unknown database state; a clear message is shown and the Event Log records
  the failure. Nothing is deleted.
- **Server never becomes healthy**: error dialog; data untouched; retry.

## Update audit trail

All update events (`UPDATE_CHECK_STARTED` … `UPDATE_RECOVERY_REQUIRED`) are
appended to `%APPDATA%\BlackStack CRM\logs\updates.log`, and critical
failures additionally go to the Windows Application event log (source
"BlackStack CRM") when available. No secrets or CRM data are logged.
