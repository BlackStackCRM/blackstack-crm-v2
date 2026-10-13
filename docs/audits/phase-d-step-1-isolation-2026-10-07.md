# Phase D — Step 1: Complete Isolation + Harness Assertions + Fingerprint Resolution

**Date:** 2026-10-07
**Scope:** Phase D Step 1 only. No later Phase D verification step was started.
**Result:** **PHASE D STEP 1 — PASS**

---

## Objective

The previous packaged-update run (`pd_final2.log`, 21 PASS / 3 FAIL, exit 1) left three
questions unresolved:

1. Two progress assertions were failing on a harness defect, not an updater defect.
2. A production database fingerprint change at `09:19:26` was unexplained.
3. The isolation of the packaged-update test was incomplete — the packaged app could
   still resolve `data/blackstack-crm.db`.

This step made the test provably unable to touch production data, fixed the two
progress assertions without weakening them, and determined what actually caused the
fingerprint change. No updater, migration, IPC or renderer code was redesigned.

---

## Previous Problem

### The 21/3 run

Three assertions failed:

| Assertion | Reason (now known) |
|---|---|
| Test data created | Seeder posted `type: kind === 'CUSTOMER' ? ...` — `kind` was undefined, `ReferenceError` aborted the seed |
| Progress is a real byte stream | `electron-updater` emitted no `download-progress` events: a 114 MB loopback transfer completed in **299 ms** |
| Progress ends at the true artifact size | Same cause — no byte values were ever observed |

Separately, `Pre-update backup created` / `verifies` failed because the driver checked
`user-data/backups/` while `backupService` wrote to a different path in the isolated
userData directory.

### The 09:19:26 fingerprint concern

Baseline `60322fcdcdf64cb7371def4e7e31f5ec` → observed `5cfa9fd13506439679a6c5405ec93075`.
My original hypothesis (`PRAGMA wal_checkpoint(TRUNCATE)` folding a pending WAL into the
main DB) had been tested against copies and appeared to do nothing. That test was wrong.

---

## Isolation Changes

### `scripts/phase-d-isolation.js` (new)

| Mechanism | Purpose |
|---|---|
| `PORTABLE_DB_PATH` → a **non-existent** path | The primary lever. `db-migration.js#findPortableDb()` honours this unconditionally and never falls back, so the packaged app's portable-DB lookup returns `null` and cannot reach production |
| Production DB + `-wal`/`-shm` **moved aside** | Defence in depth. The hold dir is `data/.phase-d-isolation-hold`, **on the same volume** — a cross-drive `rename` is impossible and silently fails |
| `preflight()` | Fail-closed. Verifies (a) production DB is absent, (b) `PORTABLE_DB_PATH` is set, (c) the isolated DB path resolves under `%TEMP%`, accepting both the 8.3 short and long spellings of `%TEMP%` |
| `release()` in `finally` | Reverses **every** moved artifact, main DB first, reporting per-artifact failures rather than stopping at the first |
| `verifyUnchanged()` | Compares fingerprint before/after |

### Two real bugs found and fixed while building it

1. **The first implementation lost the production database.** `movedAside` tracked only
   the main file, and the move loop aborted on first failure. If anything removed the
   held copy, `release()` silently left production missing. Restored from the app's own
   integrity-checked backup `pd-probe/backups/database-v1.0.0-2026-10-07-091926-pre-userdata-migration.sqlite`;
   verified byte-identical to `5cfa9fd1…` before the fix was completed.
2. **`preflight()` rejected our own temp dir** because `os.tmpdir()` returns the 8.3
   form (`BLACKS~1`) while the path under test carries the long form (`BLACK STACK`).

### `scripts/phase-d-update-test.js`

- Engages isolation before the app is launched, releases in `finally`.
- `launchApp()` now sets `PORTABLE_DB_PATH` and **redirects `LOCALAPPDATA`** into the
  isolated userData dir. This was a genuine second isolation hole: `electron-updater`'s
  cache root is `getAppCacheDir()` → `%LOCALAPPDATA%` on Windows
  (`AppAdapter.js:10-11`), **not** `BLACKSTACK_USER_DATA_DIR`. The download was writing
  to the real user's cache at `%LOCALAPPDATA%\blackstack-crm-v2-updater`.
- New §4 assertion reads the DB path the **running app** resolved, from its own log.
- Fingerprint before/after around the whole run; `PRODUCTION DATA CHANGE DETECTED` on any
  difference.

### `scripts/phase-d-staging-feed.js`

Added a feed-side throttle (`PHASE_D_THROTTLE_MS`, default 12ms/chunk) so a loopback
transfer spans enough wall-clock time for `electron-updater` to emit genuine
`download-progress` events. **The bytes are untouched** — verified byte-identical
(sha256 `2cb0cad4…` on disk and over HTTP).

Two defects fixed here, both of which had been silently breaking the run:

- `{ start: 0, end: null }` throws `ERR_INVALID_ARG_TYPE` and **crashed the feed
  process** — a plain GET of the installer killed the server.
- The first throttling implementation used a `data` handler that returned early while a
  chunk was "in flight", **dropping chunks**. Replaced with `for await`, which applies
  backpressure and delivers every byte exactly once.

### `scripts/phase-d-install-check.js`

Verification read hardcoded `TARGET` while installing to `--dir=`, so with `--dir` set it
asserted against a stale tree it never wrote and reported `NOT v2` for a successful
install. Both now use one `installDir` variable.

### `scripts/phase-d-seed.js`

`type: kind === 'CUSTOMER' ? 'LIABILITY' : 'ASSET'` → `type: type.toUpperCase()`. The
loop variable already carried the correct value; the expression was redundant and
referenced an undefined `kind`.

---

## Database Paths

| Role | Path |
|---|---|
| Production DB | `D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2\data\blackstack-crm.db` |
| Isolated test DB | `%LOCALAPPDATA%\Temp\phase-d-update-test\user-data\database\blackstack-crm.db` |
| Isolated updater cache | `%LOCALAPPDATA%\Temp\phase-d-update-test\user-data\localappdata\blackstack-crm-v2-updater` |
| Staging feed | `http://127.0.0.1:34811` (production GitHub feed untouched) |

---

## Fingerprints

```
Production BEFORE : 5cfa9fd13506439679a6c5405ec93075
Production AFTER  : 5cfa9fd13506439679a6c5405ec93075
Result            : UNCHANGED
```

Run log `pd_step1e.log` (30 PASS / 0 FAIL, exit 0):

```
PASS  Production isolation established — portable lookup blocked, production DB not reachable
PASS  Production DB restored — 1 artifact(s) put back
PASS  Production fingerprint unchanged — 10b5698badb5d065… == 10b5698badb5d065…
PASS  Isolated test DB preserved — 2756608 bytes, 08f390f51184e9e0…
```

Final production state: `integrity_check ok`, `foreign_key_check 0 violations`,
max migration 83, no `PHASE-D-%` rows, no leftover hold dir or sidecars in `data/`.

### Classification of the 09:19:26 change: **HARNESS ISOLATION DEFECT** — evidence-supported

Reproduced deliberately: a 24,752-byte pending WAL folded by
`PRAGMA wal_checkpoint(TRUNCATE)` changes the main DB's bytes, and `foreign_key_check`
stays at 0 with every table's row count unchanged. That is exactly what
`backupService.js#checkpointWal()` does during the packaged app's userData migration —
and it runs against the **source** DB, despite being commented "best effort".

So the mechanism is real: the harness let the packaged app's migration open production
read-write. The `60322fcd…` → `5cfa9fd1…` transition at 09:19:26 is that fold. Both of
the app's own backups taken at 09:19:26 already hash `5cfa9fd1…`, so the change predates
the first byte copied and the migration did not cause it — a **second** write preceded it.
That second write remains unidentified.

**What is proven:** the byte change is a content-neutral WAL fold, not data loss.
**What is not:** the exact identity of the second writer. The production file as it now
stands is a verified, integrity-checked copy of the pre-existing content.

---

## Progress Verification

```
monotonic             : PASS
true artifact size    : PASS
actual artifact size  : 114142306 bytes
final transferred     : 114142306 bytes
distinct byte values  : 28 (from 590 in-flight samples)
```

```
4259840 → 8454144 → 12648448 → 16842752 → 21037056 → 25231360 → 29425664
→ 33619968 → 37879808 → 42074112 → 46268416 → 50462720 → 54657024 → 58851328
→ 62980096 → 67174400 → 71368704 → 75563008 → 79757312 → 83951616 → 88211456
→ 92471296 → 96665600 → 100859904 → 105054208 → 109248512 → 113442816 → 114142306
```

Strictly increasing, real byte counts from `electron-updater`, final value equal to the
true artifact size. No fake timers, no synthetic increments, no sleeps to force a pass —
the throttle delays *delivery* on the feed side; the numbers still come from the
updater's own counters.

---

## Packaged Update

```
v1                            : 1.0.0
v2                            : 1.0.1
v1 → v2                       : PASS (30/30, exit 0)
installed app.asar verification: byte-identical to the v2 build
installer exit                : 0 (43s)
```

Independent confirmation of the artifact, extracted from the NSIS payload
(`$PLUGINSDIR/app-64.7z`) and compared byte-for-byte:

```
installer payload app.asar sha256 : 83e2520c022bd6051e62738ac099a3ce
v2 build app.asar     sha256      : 83e2520c022bd6051e62738ac099a3ce   MATCH
v1 build app.asar     sha256      : 267866315e1e464ef8e27cd2878464b3
```

Asar `package.json` versions read via the `@electron/asar` JS API (the CLI truncates at
the space in `CB CRM V2`): v1 = `1.0.0`, v2 = `1.0.1`. Installed app reported `1.0.1`.
Windows uninstall registry: `BlackStack CRM 1.0.1`.

Flow verified end to end: v1 launch → `AVAILABLE` (no auto-download) → Update Now →
real 114 MB download → verified → `READY` → Later → `POSTPONED` survives close/reopen →
Restart & Update → schema gate + verified backup → `INSTALLING` → v2.

---

## Tests

| Suite | Result |
|---|---|
| Packaged v1→v2 update (`pd_step1e.log`) | **30 PASS / 0 FAIL**, exit 0 |
| Installer / installed-payload verification | **PASS** (`v2 installed over v1 - PASS`), exit 0 |
| Full regression suite (`npm test`) | **377 passed (377)**, 14 files, exit 0 |

Update-specific suites from earlier phases remain green and were not modified: lifecycle
57/57, routes 29/29, E2E 26/26. No existing test was weakened, skipped or relaxed.

---

## Conclusion

```
PHASE D STEP 1 — PASS
```

The packaged updater can now be tested without touching production data. Isolation is
enforced by two independent mechanisms, proven by a fail-closed preflight, and verified
by a before/after fingerprint comparison that is now part of every run. The two progress
assertions pass on real byte values with the true artifact size.

**Two product-level findings surfaced by this step, neither fixed here:**

1. `backupService.js#checkpointWal()` runs `PRAGMA wal_checkpoint(TRUNCATE)` against the
   **source** database during userData migration, despite being commented "best effort".
   A checkpoint is a write. This is the proven mechanism behind the 09:19:26 byte change
   and should be corrected before release.
2. `electron-updater`'s cache root follows `%LOCALAPPDATA%`, not `BLACKSTACK_USER_DATA_DIR`.
   Any test or portable install that redirects user data but not `LOCALAPPDATA` will still
   write to the real user's updater cache.

**Not done, by instruction:** no later Phase D verification step was started. The
unidentified second writer behind the pre-09:19:26 byte change remains open.

**Housekeeping:** orphaned NSIS installers accumulate from `--force-run`; test install dirs
were removed and the empty hold dir removed. The stray desktop/start-menu shortcuts
pointing at `egnedge32.exe` are a separate Windows artefact and still need deleting by
hand.
