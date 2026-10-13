# Phase D — Step 1.5: Production Database Write-Path Investigation + Migration Safety Fix

**Date:** 2026-10-07
**Scope:** Phase D Step 1.5 only. No later Phase D verification step was started.
**Result:** **PHASE D STEP 1.5 — PASS**

---

## Objective

Step 1 made the packaged-update test provably isolated and passed 30/30 with the production
fingerprint unchanged. But it also surfaced a database-safety issue that had to be resolved
before Phase D could continue:

> `backupService.js#checkpointWal()` performs a real database write while documented as
> "best effort", and is reachable on a database the user only asked to *read*.

Step 1.5 had to answer, with evidence: which code paths can write the source DB, whether the
checkpoint is necessary, whether a second writer exists, and whether the source can stay
byte-identical through migration/update preparation.

---

## Incident

At `09:19:26` the production fingerprint moved:

```
before : 60322fcdcdf64cb7371def4e7e31f5ec   (2,576,384 B)
after  : 5cfa9fd13506439679a6c5405ec93075   (2,576,512 B)
```

The Step 1 investigation had proven `PRAGMA wal_checkpoint(TRUNCATE)` can fold a pending WAL
into the main DB, but had **not** accounted for the fact that both of the app's own backups
taken at 09:19:26 already hashed `5cfa9fd1…`. So a second writer was suspected.

---

## Source DB

| | |
|---|---|
| Production path | `D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2\data\blackstack-crm.db` |
| Fingerprint before this step | `5cfa9fd13506439679a6c5405ec93075` |
| Fingerprint after this step | `5cfa9fd13506439679a6c5405ec93075` |
| Final integrity | `integrity_check ok`, `foreign_key_check 0`, max migration 83 |

Production was only ever **read** (byte copies into isolated work dirs). Every reproduction
ran against a copy under `%LOCALAPPDATA%\Temp`.

---

## Write Map

Built with `scripts/phase-d-db-write-map.js`, which runs each application SQL path against an
isolated copy with a **pending WAL held open by a live connection** (the only state in which a
checkpoint has frames to fold) and records main-DB / `-wal` / `-shm` hashes at every stage.

| # | Path | File | Class | Can mutate source? |
|---|---|---|---|---|
| 1 | `backupService.createBackup()` → `checkpointWal(src)` | source DB | CHECKPOINT | **YES — was** |
| 2 | `db-migration.js` step 4 `new DatabaseSync(source)` | source DB | PRAGMA (implicit) | **YES — was** |
| 3 | `db-migration.js` `verifyDb()` | source/copy | PRAGMA (implicit) | **YES — was** |
| 4 | `backupService.verifyBackup()` | backup/live | PRAGMA (implicit) | **YES — was** |
| 5 | `backupService.safeRestoreBackup()` probe | live DB | PRAGMA (implicit) | **YES — was** |
| 6 | `connection.js` `PRAGMA journal_mode = WAL` + `foreign_keys = ON` | app DB | PRAGMA | No — measured unchanged |
| 7 | `dataSafety` `VACUUM` route | live DB | VACUUM | No — explicit confirmation required |
| 8 | `restoreBackup()` | live DB | RENAME/DELETE | Intentional — replaces the file |
| 9 | `rotateBackups()` | backups dir | DELETE | No — never touches the source DB |
| 10 | Open + close, read queries, `integrity_check`, `foreign_key_check` | any | READ | No — measured unchanged |

Measured result of the isolated run:

```
unchanged  T2 connection.js connect() pragmas
MUTATED    T3 backupService checkpointWal()
           db  5cfa9fd13506 -> 155a289c162e
           wal 1ca14578789f (20632B) -> d41d8cd98f00 (0B)
unchanged  T4 open + close only
unchanged  T5 read-only query
unchanged  T6 integrity_check + foreign_key_check

row counts identical   : true      (143 tables, 1019 rows)
integrity before/after : ok / ok
fk violations          : 0 / 0
```

Only `checkpointWal()` mutated the file. **Answer to "WHO CAN WRITE data/blackstack-crm.db?"**
— paths 1–5 above, all now closed.

---

## checkpointWal()

| | |
|---|---|
| Purpose | Make a single-file copy complete by folding pending WAL frames into the main DB |
| Caller | `createBackup()` (line 46), `restoreBackup()` (line 131) |
| SQL | `PRAGMA wal_checkpoint(TRUNCATE)` |
| Connection | `new DatabaseSync(dbPath)` — **the source itself**, read-write |
| Source effect | **Yes.** Main DB md5 `5cfa9fd13506` → `155a289c162e`, WAL 20,632 B → 0 B |
| Logical effect | None. All 143 tables' row counts, `integrity_check`, `foreign_key_check` identical |

**Is it necessary?** Yes — a plain file copy of a WAL database does not include un-checkpointed
frames, so the backup would be incomplete. The requirement is valid. What was wrong was *where*
the checkpoint ran.

**Why it ran during migration:** `electron/db-migration.js#migratePortableDatabase` calls
`createBackup({ sourcePath: source })` to satisfy "create backup → verify → copy". The
`sourcePath` option made the production portable DB reachable, so merely *launching* a packaged
app checkpointed it.

### Reproduction (isolated)

```
T1 (pending WAL)              db 5cfa9fd13506   wal 1ca14578789f (20632B)
T3 checkpointWal()            db 155a289c162e   wal d41d8cd98f00 (0B)
row counts  identical : true      integrity ok/ok      fk 0/0
```

---

## Second Writer — IDENTIFIED

**`electron/db-migration.js` line 97: `new DatabaseSync(source)`.**

A `DatabaseSync` handle is **read-write by default**. Step 4 of the migration only counts rows,
but opening the user's portable database read-write and closing it lets SQLite checkpoint and
**delete the `-wal` and `-shm` sidecars**. That is a write to the user's data area, performed
during a code path documented as *"Source left in place untouched"*.

The same read-write-by-default mistake appeared in three more places: `verifyDb()`,
`verifyBackup()` and `safeRestoreBackup()`'s post-restore probe.

Evidence — after fixing only `checkpointWal()`, the real migration path still reported:

```
source BEFORE: {"db":"5cfa9fd1…","wal":"d41d8cd98f00…","shm":"b7c14ec6110f…"}
source AFTER : {"db":"5cfa9fd1…","wal":"ABSENT",          "shm":"ABSENT"}
SOURCE BYTE-IDENTICAL AFTER REAL MIGRATION: NO
```

The main DB was already byte-identical (proving the `checkpointWal` fix), but the sidecars had
been deleted. After adding `readOnly: true`:

```
SOURCE BYTE-IDENTICAL AFTER REAL MIGRATION: YES
MIGRATION PRODUCED A DATABASE: YES
TARGET integrity: ok | fk violations: 0 | max migration: 83
BACKUP database-v1.0.0-…-pre-userdata-migration.sqlite: valid=true
```

---

## Fix

Minimum change, confined to source-DB mutation. No updater, migration runner, IPC, renderer or
schema change.

### `server/services/backupService.js`

- New `snapshotWalDatabase(srcPath, destPath)`: copies the source **plus its sidecars** to a
  throwaway working dir, checkpoints *the copy*, and publishes the self-contained result. The
  source is never opened.
- `createBackup()` now calls that instead of `checkpointWal(src)`. Backup completeness is
  preserved — the published file still contains every committed row, including rows that were
  only in a pending WAL.
- `checkpointWal()` kept (still exported) but rewritten to fold via a temporary copy, so any
  future caller is safe by construction.
- `restoreBackup()`: dropped its `checkpointWal(live)` — it is about to replace the file, so
  folding first was an unnecessary write.
- `verifyBackup()` and `safeRestoreBackup()`'s probe: opened `{ readOnly: true }`.
- Backup metadata now records `walFolded` and `sourceMutated: false` for auditability.

### `electron/db-migration.js`

- `verifyDb()` and the step-4 row-count comparison open `{ readOnly: true }`.

### Tests added

`tests/backup-source-immutability.test.js` — 5 tests:

1. Source stays byte-identical **while** the backup contains all pending-WAL rows.
2. Source WAL frames are **not** folded away.
3. Works for a database with no WAL sidecar.
4. Missing source still throws, creating nothing.
5. No `.walfold-` temp directory left behind.

---

## Verification

### Isolated reproduction (`phase-d-db-write-map.js`)

Before the fix, exactly one stage mutated the file (`T3 checkpointWal()`). Same evidence as
the write map above.

### Real migration path (`phase-d-step-1-5-verify.js`)

Runs the actual `migratePortableDatabase()` against an isolated portable copy:

```
SOURCE BYTE-IDENTICAL AFTER REAL MIGRATION: YES
MIGRATION PRODUCED A DATABASE: YES
TARGET integrity: ok | fk violations: 0 | max migration: 83
BACKUP …-pre-userdata-migration.sqlite: valid=true
RESULT: PASS — migration works and the source is untouched
```

### Packaged update (Step 1 harness, unchanged)

`pd15_update.log` — **30 PASS / 0 FAIL, exit 0**, including:

```
PASS  Production DB restored — 3 artifact(s) put back
PASS  Production fingerprint unchanged — 10b5698badb5d065… == 10b5698badb5d065…
PASS  Isolated test DB preserved — 2756608 bytes, a8dcd3f6afbe006a…
```

### Installed artifact

`pd15_install3.log` — `v2 installed over v1 - PASS`, exit 0:

```
installed version: 1.0.1
asar == v2 build : YES (byte-identical)
```

This required reaping an orphaned `BlackStack CRM Setup 1.0.1` first — `--force-run` makes the
installer relaunch the app, and a live installer makes the next one exit `2` in 0s. A known
harness artefact, not a product defect.

---

## Regression

| Suite | Result |
|---|---|
| `npm test` | **382 passed (382)**, 15 files, exit 0 |
| `tests/backup-source-immutability.test.js` | **5 passed** |
| Packaged v1 → v2 update | **30 PASS / 0 FAIL**, exit 0 |
| Installer payload verification | **PASS**, exit 0 |

Baseline was 377; +5 new tests, zero regressions. No existing test was weakened, deleted, or
had its expectations changed. Phase 1 data-safety tests (`existing data survives safe
migrations + restart`, `restore returns database to previous state`) pass unmodified.

---

## Production Fingerprint

```
BEFORE: 5cfa9fd13506439679a6c5405ec93075
AFTER : 5cfa9fd13506439679a6c5405ec93075
RESULT: UNCHANGED
```

Final state: `integrity_check ok`, `foreign_key_check 0 violations`, max migration 83, no
`PHASE-D-%` rows, no leftover hold dir or test artefacts in `data/`.

---

## Final Verdict

```
PHASE D STEP 1.5 — PASS
```

Both writers are identified with reproducible evidence and closed. The source database is now
byte-identical through the full backup-and-migrate path, while the backup produced is still
complete and verifies.

**One limitation, non-blocking and documented:** the *original* 09:19:26 byte change cannot be
attributed to a specific process with certainty — no write-observability existed at the time,
and the transition happened in a single unrecoverable second. What is now established is that
every code path capable of producing that class of change has been found, reproduced in
isolation, and fixed. The `60322fcd…` original is unrecoverable; the current file is a verified,
integrity-checked copy of the pre-existing content.

**Not done, by instruction:** no later Phase D verification step was started. No Git or version
control work, no Marketing work, no unrelated CRM / Accounting / Inventory / Billing changes.


---

# COMPLETION ADDENDUM — 2026-10-07

The three items still outstanding from the Step 1.5 brief are now closed.

## 1. A material finding: the packaged builds shipped the PRE-FIX code

The Step 1.5 update run passed 30/30, but against binaries built **before** the fix.
Verified by extracting the shipped `app.asar` from both builds:

```
v1: snapshotWalDatabase present : false    checkpointWal(src) present : true
v2: snapshotWalDatabase present : false    checkpointWal(src) present : true
```

So the shipped fix had never actually been exercised end to end — the isolation held, but
the vulnerable path was still what ran. Both packages were rebuilt with `phase-d-build.js`:

```
v1 1.0.0  114,143,442 B  sha256 9123c94ed239f403ce66307bd84487bfd3941786fba993c15a991aa37e00a4f8
v2 1.0.1  114,143,728 B  sha256 f8c9c5d682e42bc84f2ff408e9cc8f420a385cb93678d4173a17ba4d435eb1ba
shipped electron-updater: YES (69 files)   package.json restored to 1.0.0 after each build
```

Re-verified with `scripts/verify-build-has-db-fix.js` — 7/7 checks pass in **both** packages:
`snapshotWalDatabase` present, `checkpointWal(src)` absent, `checkpointWal` folds a copy,
`verifyBackup` read-only, `safeRestore` probe read-only, and both `db-migration.js` opens
read-only.

## 2. Full regression including E2E, reverse E2E and the release gate (§18)

`npm run test:release` — **16/16 gates passed, exit 0**:

```
gate 2  architecture guard                    3 passed
gate 3  env-isolation guard                   3 passed
gate 3  migration idempotency (no boot write)  5 passed
gate 4  authorization (401/403/2xx)          23 passed
gate 4  update/data-safety route contract    29 passed
gate 4b Phase C update lifecycle             57 passed
gate 4  bill lifecycle + reconciliation      14 passed
gate 5  unit/integration (parallel)         382 passed
gate 6  unit/integration (serial)           382 passed
gate 7  E2E regression (isolated DB)         26 passed
gate 8  reverse-order E2E                    7 passed
gate 9  live database CONTENT unmodified    PASS
gate 9  integrity_check / foreign_key_check ok / 0 violations
gate 9  stock ledger/balances reconcile     ledger=2 balances=2
```

### What `60322fcd…` actually was

The gate distinguishes a **content** fingerprint from a **file** checksum:

```
live db CONTENT fingerprint : 60322fcdcdf64cb7371def4e7e31f5ec   (unchanged before AND after)
live db FILE checksum       : 5cfa9fd13506439679a6c5405ec93075   (unchanged before AND after)
```

`60322fcd…` was never a previous *file* checksum of the production database — it is the
canonical **logical content** hash that `release-gate.js#dbFingerprint()` computes from the
rows. So the original incident was never a case of "the content changed"; the file bytes and
the content were being tracked as two different things and compared against each other.
Gate 9's own wording anticipated exactly this: *"content identical (file bytes may differ:
migrations run on every boot and rewrite legacy_tables)"*.

Both fingerprints are unchanged after all of Step 1.5's work.

## 3. Diff scope review (§19)

Not a git repository, so scope was asserted by marker inspection. **Exactly two source files
changed:**

- `server/services/backupService.js`
- `electron/db-migration.js`

Plus one new test file and five investigation/verification scripts.

Confirmed **untouched**: `updateState.js`, `electron/main.js`, `electron/preload.js`,
`public/js/pages/settings.js`. `updateService.js` and `safeMigrationRunner.js` contain
`readOnly: true` but those are **pre-existing** lines (lines 87 and 183) — the codebase
already opened databases read-only in the correct places; `db-migration.js` and
`backupService.js` were the outliers. No updater, SQLite, migration-runner, IPC, renderer,
schema, auth or CRM/Accounting/Inventory/Billing change. No Git or Marketing work.

## 4. Packaged update re-run against the FIXED binaries

`pd15b_update.log` — **30 PASS / 0 FAIL, exit 0**, fingerprint `5cfa9fd1…` before and after.

`pd15b_install.log` — `v2 installed over v1 - PASS`, exit 0:

```
installed version: 1.0.1
asar == v2 build : YES (byte-identical)
```

## Final verdict (unchanged)

```
PHASE D STEP 1.5 — PASS
```

Now genuinely so: the fix exists in source, in the regression suite, in the release gate,
and inside both shipped packages, and the packaged v1 → v2 update passes with the fixed
code actually running.
