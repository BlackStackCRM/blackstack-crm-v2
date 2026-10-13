# Phase D — Production Fingerprint Incident (reported immediately per §22)

**Raised:** 2026-10-07, mid-Phase-D
**Status:** production DB fingerprint no longer matches the Phase A/B/C baseline
**Phase D verdict:** withheld pending your decision (see §4)

---

## 1. The finding

```
Phase A/B/C baseline : 60322fcdcdf64cb7371def4e7e31f5ec
Current              : 5cfa9fd13506439679a6c5405ec93075
Status               : DIFFERENT
```

Section 22 requires me to stop and report this rather than continue, so I have.

**Production business data was not lost and no test data was written into it.**

| Check | Result |
|---|---|
| `PRAGMA integrity_check` | **ok** |
| `PRAGMA foreign_key_check` | **0 violations** |
| `schema_migrations` | 69 rows, max version **83** (unchanged) |
| `PHASE-D-%` contacts in production DB | **0** |
| `phase-d%` users in production DB | **0** |
| File stable across repeated reads | **yes** |

So the database is intact and uncontaminated by this phase's testing. The byte-level
fingerprint changed; the *data* did not lose or gain anything.

---

## 2. When it happened

```
09:18:31  my first Phase D command ran (server timestamp)
09:19:25  packaged dist/win-unpacked launched with BLACKSTACK_USER_DATA_DIR=.../pd-probe
09:19:26  <-- production DB last modified  (data/blackstack-crm.db)
09:19:28  that command returned
09:31:44  my first Phase D source file created
```

The write was **55 seconds after my first Phase D command** and inside that launch's
window. Nothing has touched the file in the ~12 hours since.

---

## 3. What that launch did to production

The app log from that launch is unambiguous:

```
[03:49:25.966Z] Found portable database at
                 D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2\data\blackstack-crm.db
                 — migrating safely...
[03:49:26.028Z] created backup database-...-091926-pre-userdata-migration.sqlite
[03:49:26.052Z] Verified backup: ...\pd-probe\backups\...sqlite
[03:49:26.091Z] Portable DB migration verified OK. Source left in place untouched.
[03:49:28.492Z] electron-updater unavailable: Cannot find module 'electron-updater'
```

This is `electron/db-migration.js: migratePortableDatabase()`. It is designed to be
non-destructive: verify backup → copy source → copy WAL/SHM → row-count compare →
write `MIGRATED_FROM.txt`. It never issues a write to the source by design.

**Both backups it created at 09:19:26 already hash to `5cfa9fd1...` — byte-identical to
the current production file.** That is the decisive evidence: whatever changed the file
did so **before** the first byte was copied. The migration is not the cause.

### What I could NOT prove

I tested the plausible write mechanisms against copies of the real DB and **none of them
mutate the file**:

| Mechanism | Mutates the DB file? |
|---|---|
| `open + SELECT` | no |
| `open + close`, no query | no |
| `PRAGMA wal_checkpoint(TRUNCATE)` (what `checkpointWal()` runs) | **no** |
| `node:sqlite` open + `foreign_keys=ON` + `integrity_check` | no |

I specifically tested `checkpointWal()` because `server/services/backupService.js:30`
opens a connection to the source and runs `PRAGMA wal_checkpoint(TRUNCATE)` with a
`catch { /* best effort */ }`, which reads as though it might write. On a file with a
populated 20KB WAL it left the main DB unchanged.

So I have **not** identified the mechanism. I am not going to guess at one. The honest
statement is: something wrote to the file in that one-second window during a launch whose
only database activity on that path was a backup-and-copy, and my reproduction attempts do
not reproduce it.

---

## 4. Two things worth fixing regardless of cause

**a. The launch read from the production path at all.** I set
`BLACKSTACK_USER_DATA_DIR` to an isolated directory, but the packaged app still opened
`data/blackstack-crm.db` as the "portable database" to migrate *from*. Isolation was not
complete: the test environment inherited a read-and-backup path to production. A true
isolation harness must also prevent that lookup, not just redirect the target.

**b. `--force-run` left orphaned shortcuts.** The installer's `--force-run` flag launched
the app from the throwaway install tree and created Start Menu / desktop shortcuts pointing
into `%LOCALAPPDATA%\Temp\phase-d-install\...`. Deleting that tree orphaned them, and
Windows raised "Problem with Shortcut", offering to repoint a BlackStack CRM shortcut at
an unrelated `egnedge32.exe`. Those shortcuts are test artifacts and should be deleted, not
fixed. This is also a real (cosmetic) user-facing behaviour with
`allowToChangeInstallationDirectory: true`.

---

## 5. Recommendation

1. Treat production data as **intact but no longer matching the old fingerprint.** If you
   have a known-good copy from before 09:19:26 today, diffing it against the current file
   would identify what the one-second write actually did. I did not modify, restore, or
   overwrite anything.
2. Before resuming Phase D, decide whether the 09:19:26 write is acceptable. If not, the
   packaged-update test should not run against a checkout containing a real
   `data/blackstack-crm.db`.
3. The backup the app itself wrote at 09:19:26
   (`pd-probe/backups/database-...-pre-userdata-migration.sqlite`) is a verified, integrity-checked
   snapshot of the file as it was at that moment, if you want a reference copy.

I have stopped here as §22 directs and have not continued the update-flow verification.

---

# ADDENDUM — 2026-10-07, Phase D Step 1.5

The original incident record above is preserved unchanged. This addendum records the
completed root-cause investigation. Full evidence:
`docs/audits/phase-d-step-1-5-db-write-path-2026-10-07.md`.

## Root cause found

**Two independent writers**, both in the backup/verify path, both capable of changing the
production database's bytes with **no change to any logical row**.

### Writer 1 — `backupService.js#checkpointWal()`

`createBackup()` ran `PRAGMA wal_checkpoint(TRUNCATE)` against the **source** database, so
that a plain file copy would capture every committed row.

A checkpoint is a **write**: it folds pending WAL frames into the main `.db`. Reproduced in
isolation against a copy of production with a live-held pending WAL:

```
T1 (pending WAL)   db 5cfa9fd13506   wal 1ca14578789f (20,632 B)
T3 checkpointWal() db 155a289c162e   wal d41d8cd98f00 (0 B)
row counts identical : true (143 tables, 1019 rows)
integrity ok/ok      foreign_key_check 0/0
```

This was reachable on production because
`electron/db-migration.js#migratePortableDatabase` passes the portable DB as
`createBackup({ sourcePath })`. **Merely launching a packaged app checkpointed it** — the code
was even documented as "Source left in place untouched".

### Writer 2 — the previously unidentified second writer

**`electron/db-migration.js` line 97: `new DatabaseSync(source)`.**

A `DatabaseSync` handle is **read-write by default**. Step 4 of the migration only counts rows,
but opening the user's portable database read-write and closing it lets SQLite checkpoint and
**delete the `-wal` and `-shm` sidecars** — a write to the user's data area.

Proof: with only Writer 1 fixed, the real migration path still reported the source as changed:

```
source BEFORE: {"db":"5cfa9fd1…","wal":"d41d8cd98f00…","shm":"b7c14ec6110f…"}
source AFTER : {"db":"5cfa9fd1…","wal":"ABSENT",          "shm":"ABSENT"}
SOURCE BYTE-IDENTICAL AFTER REAL MIGRATION: NO
```

The same read-write-by-default mistake existed in three more places — `verifyDb()`,
`verifyBackup()` and `safeRestoreBackup()`'s post-restore probe.

## Fix applied

- `backupService.js`: `createBackup()` now snapshots via a **throwaway working copy**
  (`snapshotWalDatabase()`), checkpointing the copy rather than the source. `checkpointWal()`
  itself was rewritten the same way so future callers are safe by construction.
  `restoreBackup()`'s `checkpointWal(live)` removed — it replaces the file moments later.
- `verifyBackup()` and the `safeRestoreBackup()` probe: `{ readOnly: true }`.
- `db-migration.js`: `verifyDb()` and the step-4 row-count comparison: `{ readOnly: true }`.
- Backup metadata records `walFolded` / `sourceMutated: false`.

Backup completeness is preserved: the published backup is still a single self-contained file
containing every committed row, including rows that were only in a pending WAL.

## Verification

- Real `migratePortableDatabase()` on an isolated copy:
  `SOURCE BYTE-IDENTICAL AFTER REAL MIGRATION: YES`, target `integrity ok`, `fk 0`,
  max migration 83, backup `valid=true`.
- New regression suite `tests/backup-source-immutability.test.js` — **5 passed**, including
  "source stays byte-identical while the backup still contains all pending-WAL rows".
- `npm test`: **382 passed (382)**, exit 0 — baseline 377 plus the 5 new tests, no regressions.
- Packaged v1 → v2 update (Step 1 harness, isolation unchanged): **30 PASS / 0 FAIL**, exit 0.
- Installed payload: `v2 installed over v1 - PASS`, `app.asar` byte-identical to the v2 build.

## Fingerprint after the fix

```
BEFORE: 5cfa9fd13506439679a6c5405ec93075
AFTER : 5cfa9fd13506439679a6c5405ec93075
RESULT: UNCHANGED
```

`integrity_check ok`, `foreign_key_check 0 violations`, max migration 83.

## Remaining uncertainty

The *original* 09:19:26 transition cannot be attributed to a specific process with certainty:
no write-observability existed at the time and the change happened in one unrecoverable
second. The `60322fcd…` original is unrecoverable.

What is now established is that every code path capable of producing that class of change has
been identified, reproduced in isolation, and fixed. Both writers are closed. The current
production file is a verified, integrity-checked copy of the pre-existing content — no data
was lost at any point.


---

## Addendum 2 — clarification of `60322fcd…` (2026-10-07)

While running the full release gate as part of Step 1.5, the meaning of the original
baseline value became clear. `scripts/release-gate.js` tracks two different things:

```
live db CONTENT fingerprint : 60322fcdcdf64cb7371def4e7e31f5ec
live db FILE checksum       : 5cfa9fd13506439679a6c5405ec93075
```

`60322fcd…` is **not** a historical file checksum of `data/blackstack-crm.db`. It is the
canonical *logical content* hash computed by `dbFingerprint()` from the database's rows.

So the 09:19:26 incident was never "the data changed". Two different measurements were
being compared against each other as though they were the same quantity. The content hash
is unchanged to this day, before and after every run in Steps 1 and 1.5:

```
gate 9: live database CONTENT unmodified by the gate run   PASS
gate 9: integrity_check ok / foreign_key_check 0 violations
```

The two write paths identified in the addendum above (the source `wal_checkpoint(TRUNCATE)`
and the read-write `DatabaseSync(source)` handle) were nonetheless real defects and are
fixed — they changed file bytes, and in the second case deleted the `-wal`/`-shm` sidecars.
Both are now closed and regression-tested.
