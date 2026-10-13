# Phase 2 Architecture Audit (pre-implementation)

Frozen Phase 1 baseline: Electron startup, userData isolation, portable
migration, single-instance, 127.0.0.1 binding + port fallback, safe
migrations, stale-lock recovery, installer, silent install, preservation
acceptance (17/17), release hashing, signing gate, 209/209 vitest baseline.

## Existing components (reuse, never rebuild)

| Component | State | Phase 2 relevance |
|---|---|---|
| `server/services/backupService.js` | EXISTS | create/verify/restore/list + WAL checkpoint + quarantine copy before restore. Rotation & status will be added HERE. |
| `server/routes/dataSafety.js` | EXISTS | /version, /backups (list/create), /backups/verify, /backups/restore, /update-status. Storage + maintenance + deletion endpoints extend THIS router. |
| `server/config/userDataPath.js` | EXISTS | Central path resolution (BLACKSTACK_USER_DATA_DIR). Storage monitor uses these paths only. |
| `server/services/safeMigrationRunner.js` | EXISTS | Lock w/ PID liveness, verified pre-migration backup, rollback. Untouched except reuse. |
| `server/services/updateService.js` | EXISTS | Provider-bound stub. Support bundle reads status from it. |
| `electron/main.js` logging | PARTIAL | Daily app log file, no rotation, no redaction. New log module must integrate without replacing. |
| `electron/update-logger.js` | EXISTS | Update event log. |
| Settings UI / datasafety UI | PARTIAL | Backend-first Phase 2; UI wiring kept minimal. |
| Multi-user isolation | EXISTS (by design) | per-user %APPDATA% resolution; needs explicit tests. |
| Backup rotation | MISSING | Implement per §5–§7. |
| Log rotation / redaction | MISSING | Implement per §10–§13. |
| Storage monitor + warnings | MISSING | Implement per §18–§22. |
| Safe restore hardening (pre-restore backup + post-verify + rollback) | PARTIAL | restoreBackup already quarantines live DB & post-verifies; needs pre-restore backup + FK/schema check + rollback-on-fail. |
| VACUUM maintenance | MISSING | §21. |
| Two-confirmation data deletion | MISSING | §14–§17. |
| Support bundle | MISSING | §23–§27. |

## Conflicts
None found. No second system will be created.

## Safety invariants for all new code
- Rotation/deletion never removes the newest valid recovery point.
- Deletion requires two explicit confirmations + verified final backup;
  failed backup aborts deletion (fail-safe).
- Restore: verify backup → back up live DB → restore → integrity + FK +
  schema checks → on failure restore the pre-restore backup.
- Support bundles: sanitized copies only; never originals; no CRM records.
- Storage monitor reads only BlackStack-owned dirs.
