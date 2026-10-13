# Troubleshooting — BlackStack CRM

Practical fixes for the most common issues. All paths assume the default
user-data location; if `BLACKSTACK_USER_DATA_DIR` is set, use that directory.

## App does not start / window never appears

1. Check `%APPDATA%\BlackStack CRM\logs\app-*.log` for the last entries.
2. **"Migration lock held by running process PID N"** — another instance is
   (or was) migrating. If no BlackStack process is running, the next launch
   recovers automatically (stale-lock recovery). If one is running, wait.
3. **"The database could not be safely prepared"** — the startup was aborted
   to protect data. Do NOT delete anything. Restore the newest verified
   backup (see backup-restore.md) and restart.
4. **"Port … is occupied"** — the app tries 34567 then 34568–34572
   automatically. If none is free, free one and restart.

## Server not responding on the expected port

- The actual port is logged at startup (`Fallback selected: port NNNNN`).
- Verify: `netstat -ano | findstr 34567` should show `127.0.0.1:34567`.

## Data looks wrong / partially missing after a crash

1. Stop the app.
2. List `%APPDATA%\BlackStack CRM\backups\` (newest `.json` metadata first).
3. Restore via the app (Settings → Data Safety → Restore) or manually per
   backup-restore.md. The pre-restore state is always quarantined
   automatically, so a restore attempt is itself reversible.

## "A final backup could not be created" (during data deletion)

The deletion was **refused by design** — your data has NOT been deleted.
Fix the backup/storage problem (usually disk space or permissions on
`backups\`) and retry.

## Disk space warnings

- `DISK_LOW` / `BACKUPS_LARGE` warnings are advisory; the app never deletes
  data or backups automatically.
- Safe order of operations: free disk space manually → optionally lower
  `BLACKSTACK_BACKUP_RETENTION` → `POST /api/datasafety/backups/rotate`.

## Logs grow too large

Automatic rotation is active (10 MB per file, 5 rotated files, 30-day
cleanup). If a log file is locked by another process, rotation skips it and
retries next time — no crash, no data loss.

## Antivirus flagged the installer

See security.md → "Verifying the installer" (SHA-256 + Authenticode). If both
are valid, report the false positive to your antivirus vendor.

## Collecting information for support

Settings → Help → Generate Support Bundle (creates a sanitized ZIP in
`%TEMP%`; review before sharing). It contains system info, schema/migration
history, backup status, and redacted logs — never CRM records or secrets.
