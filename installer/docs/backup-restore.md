# Backup & Restore Guide — BlackStack CRM

Reflects the implemented Phase 2 data-safety features.

## Automatic backups (always on)

A **verified** backup is created automatically before:

- every schema migration (`pre-migration` label)
- every update installation (`pre-update` label)
- every restore (`pre-restore` label)
- database maintenance/VACUUM (`pre-vacuum` label)
- every manual backup request (`manual` label)

Backups live in `%APPDATA%\BlackStack CRM\backups\` as
`database-v<version>-<timestamp>-<label>.sqlite` plus a `.json` metadata file.
Verification = file opens as SQLite, passes `PRAGMA integrity_check`, and
contains `schema_migrations`. Unverified files are never treated as recovery
points and are cleaned by rotation.

## Retention (rotation)

- Default: keep the **5 newest verified** backups (`BLACKSTACK_BACKUP_RETENTION`
  env var; values like 5/10/20; minimum 1 is enforced).
- Rotation runs automatically after every successful backup and can be
  triggered manually: `POST /api/datasafety/backups/rotate`.
- Safety rules enforced by rotation:
  - only verified backups count as recovery points;
  - nothing is deleted while a backup/restore operation is active;
  - the only valid recovery point is never removed;
  - rotation failures are logged (in `preferences\rotation-events.log`) and
    never interrupt normal CRM operation.

## Backup status (Settings → Data Safety)

`GET /api/datasafety/backups/status` returns: last backup, last **verified**
backup, number of verified backups, total backup storage size, and the
active retention policy.

## Manual backup

`POST /api/datasafety/backups` creates and immediately verifies a backup.
Failed verification → HTTP 500 with `BACKUP_VERIFICATION_FAILED`; the backup
file is left for inspection but is not a recovery point.

## Restore (safe procedure)

`POST /api/datasafety/backups/restore` with `{ "file": "<path>" }` runs the
hardened safe-restore sequence:

1. Verify the selected backup (refuse if invalid).
2. Create a verified `pre-restore` backup of the current live database.
3. Restore (the previous live file is additionally quarantined in `backups\`).
4. Post-restore verification: `PRAGMA integrity_check`, `PRAGMA foreign_key_check`
   (0 violations required), and `schema_migrations` presence.
5. On any failure: the pre-restore backup is automatically restored and
   re-verified. The error returned is `RESTORE_FAILED_ROLLED_BACK` /
   `RESTORE_VERIFY_FAILED` — the app never keeps running against an
   unverified restored database.

## Storage monitoring (Settings → Storage)

`GET /api/datasafety/storage` (read-only) returns sizes of database,
backups, uploads, logs, cache, preferences, and available disk space on the
user-data volume, plus advisory warnings:

| Warning | Trigger | Guidance shown |
|---|---|---|
| `DB_LARGE` | database > 2 GB | review storage / maintenance options |
| `BACKUPS_LARGE` | backups > 10 GB | review backups and retention (recovery points preserved) |
| `DISK_LOW` | < 500 MB free | free space before creating new backups |

No automatic destructive cleanup exists. Low disk space produces a warning,
never deletion.

## Database maintenance (VACUUM)

- `GET /api/datasafety/maintenance/vacuum/preview` — read-only fragmentation
  estimate (`freelist_count / page_count`); recommends only.
- `POST /api/datasafety/maintenance/vacuum` with `{"confirm":"VACUUM"}` —
  requires explicit confirmation; sequence: verified backup → VACUUM →
  `integrity_check` + `foreign_key_check`; on failure the pre-maintenance
  backup is restored automatically.
- VACUUM is never run automatically.

## Emergency manual restore (app cannot start)

1. Close the app.
2. Pick the newest backup with valid `.json` metadata.
3. Copy it over `%APPDATA%\BlackStack CRM\database\blackstack-crm.db`;
   delete `-wal`/`-shm` sidecars next to it.
4. Start the app; safe migrations verify and complete as needed.
