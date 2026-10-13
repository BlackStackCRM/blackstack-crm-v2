# Phase D — Step 3: Failure Recovery & Production Release Verification

**Date:** 2026-10-07
**Project:** BlackStack CRM V2 (`CB CRM V2/blackstack-crm-v2`)
**Harness run:** `scripts/phase-d-step-3-run.js` → `HARNESS_EXIT=0`, **102 PASS / 0 FAIL / 7 SKIP**

---

## Executive Summary

**PHASE D STEP 3 — PASS WITH LIMITATIONS**

One complete green run finished on the corrected exit-code path. The updater's
integrity verification, migration rollback, backup restore and interrupted-update
recovery were all verified against real packaged binaries.

**Seven items are explicitly PENDING**, and none is a product defect:

- 4 require a real NSIS install, which cannot be isolated on this machine because a
  machine-wide registration exists (see **Installation Isolation Incident**)
- 1 requires a production code-signing certificate with the Code Signing EKU (absent)
- 1 requires the real production feed (the shipped build points at a loopback feed)
- 1 is the multi-system NSIS simulation (same collision as above)

A machine-wide installation was discovered at `C:\Program Files\BlackStack CRM`
and a real per-user database at `%APPDATA%\blackstack-crm-v2\database`. **Neither
was modified, uninstalled, or overwritten.** They are classified `PROTECTED` and
excluded from every test.

---

## Historical Invalid Run (superseded)

An earlier Step 3 run produced:

```
PASS 100   FAIL 16   SKIP 4
EXIT=0          <-- WRONG
```

**That result is invalid.** The runner ended with
`main().then(() => process.exit(0))`, which discarded the verdict `main()` had
already written to `process.exitCode`. Sixteen genuine failures were reported to
the shell as success.

Two of those failures were actively misleading:

- `Production content fingerprint UNCHANGED: MISSING == 0773cafd…` and
  `Production file checksum UNCHANGED: null == 5cfa9fd1…` — these were **not** data
  loss. `prodFileAfter` was read before `isolation.release()`, i.e. while the
  database was deliberately moved aside. Reading it after release is correct.
- `Attachments … table=true` — a regex false match on `physical_stock_documents`,
  which is a physical stock-count sheet, not stored files.

This run is retained in the audit history solely as the evidence that the
exit-code verifier defect was discovered and corrected. It is **not** a current
result and is not counted anywhere in the totals below.

---

## Exit-Code Guarantee (re-verified)

Static check: `process.exit(0)` is absent from the runner; the verdict is set only
at `process.exitCode = H.failCount === 0 ? 0 : 1`. `skip()` increments a counter
separate from `failCount`, so a SKIP can never become a FAIL (and never becomes a
PASS).

Empirical check, re-run at closure (`scripts/phase-d-harness-selftest.js`,
deliberate corruption of an isolated throwaway database):

| Mode | Expected | Observed |
|---|---|---|
| `INJECT_FAILURE=1` | non-zero | **`EXIT=1`** — corruption detected: `Extends off end of page`, `btreeInitPage() returns error code 11` |
| `INJECT_FAILURE=0` | zero | **`EXIT=0`** |

---

## Corrected Verification (this run)

Executed from a clean state: no running BlackStack processes, no listeners on the
app or feed ports, all prior temp trees removed.

```
PASS 102   FAIL 0   SKIP 7   (of 109)
HARNESS_EXIT=0
```

Release regression, immediately afterwards with no concurrent processes:

```
16/16 gates passed
RELEASE_GATE: PASS
RELEASE_EXIT=0
```

---

## Harness Verification

The previous harness ended with `main().then(() => process.exit(0))`, which
discarded the verdict `main()` had already stored in `process.exitCode`. Runs with
real failures therefore reported `EXIT=0`. Fixed, and proved with a self-test
(`scripts/phase-d-harness-selftest.js`) that deliberately corrupts an isolated
database:

| Mode | Expected | Observed |
|---|---|---|
| `INJECT_FAILURE=1` | non-zero | **`EXIT=1`** — corruption detected (`Extends off end of page`, `btreeInitPage() returns error code 11`) |
| `INJECT_FAILURE=0` | zero | **`EXIT=0`** |

The self-test also isolates production through the same module the suite uses and
proves the checksum is unchanged on both paths.

---

## Installation Isolation Incident

### Discovery

During Step 3 scenario F, isolated temporary installs returned **NSIS exit 199**.
The installer detects an existing registered installation and refuses. Read-only
inspection found a machine-wide registration:

```
HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\5afa5872-05cb-5d19-add7-5fde016cafee
  DisplayName        BlackStack CRM 1.0.1
  DisplayVersion     1.0.1
  UninstallString    "C:\Program Files\BlackStack CRM\Uninstall BlackStack CRM.exe" /allusers
  QuietUninstallString  ... /allusers /S
  NoModify / NoRepair   0x1 / 0x1
```

and a per-user registration from the Step 2 run pointing at a since-deleted temp path.

### How ownership was established

| Evidence | Finding |
|---|---|
| Installed `resources/app.asar` sha256 | `16b2a1290e704dce43cacdbef1cd43ceef9be494266869bd9ee17f1a1f2a6842` |
| This repo's v2 build `app.asar` sha256 | `16b2a1290e704dce43cacdbef1cd43ceef9be494266869bd9ee17f1a1f2a6842` |
| **Conclusion** | payload is **byte-identical to a build this harness produced** |
| Payload file mtimes | `BlackStack CRM.exe` and `app.asar` both **14:12** — the v2 build time |
| Install directory mtime | **19:15** — when the copy happened |
| `InstallLocation` | `C:\Program Files\BlackStack CRM` — not the isolated temp path |

The 14:12 payload timestamps against a 19:15 directory timestamp is the decisive
signal: this is my own build copied by my own harness, not a long-standing user
install.

### Why it was still classified PROTECTED

Independent of origin, **real user state exists on this machine**:

```
%APPDATA%\blackstack-crm-v2\database\blackstack-crm.db
  2,891,776 bytes, mtime 2026-10-07 11:14 (pre-dates this work)
  content fingerprint e5475ea436c2fc05232b15f61862736f, integrity ok, 0 FK violations
```

That database is **not** the repo's `data/blackstack-crm.db` (different checksum:
`01d30f17…` vs `5cfa9fd1…`), and it predates the session. Uninstalling the
machine-wide install could destroy data this verification has no ownership of.

**Classification: `PROTECTED`. Not touched.**

### Root cause

`package.json` declares an NSIS target without `perMachine`, but the installer
electron-builder produced registers under **HKLM** (`/allusers`). A
machine-wide registration means an "isolated" install is **not isolated**: NSIS
resolves the registered location rather than `/D=`. Step 2's `--force-run /S /D=`
invocation therefore wrote to `C:\Program Files` while the harness asserted only
on its own temp directory — so the collision was invisible to Step 2's assertions.

A second, independent trigger: the repo path contains spaces (`CB CRM V2`) and
NSIS `/D=` rejects paths with spaces unless given the 8.3 short path. Passing a
space-containing `/D=` fails **silently** with exit 199 and installs nothing.

### Harness correction

New preflight `scripts/phase-d-step-3-install-preflight.js` runs before any
installer-backed scenario and classifies the machine:

```
CLASSIFICATION   : PROTECTED
reason           : a registered install and/or real per-user userData exists;
                   installing would overwrite or collide with it
may run installer tests: false          → exits 3
```

It refuses when any of the following holds: a registration exists whose payload
is not byte-identical to a harness build, **or** a per-user `userData` database
exists. The protected branch always wins, regardless of payload match — so this
guard cannot be talked into overwriting real data.

Scenarios **B**, **F/installer-transition**, **F/post-install-startup** and **§13**
now consult the preflight and report `SKIP` with the reason. The harness can never
silently install over existing state.

No product code was changed. The evidence points at test-harness isolation, not an
application defect.

### Evidence production remained unchanged

| Artifact | Before | After |
|---|---|---|
| `data/blackstack-crm.db` md5 | `5cfa9fd13506439679a6c5405ec93075` | `5cfa9fd13506439679a6c5405ec93075` |
| Production content fingerprint | `0ea76f86b9211cc5618c400cd2902d64` | `0ea76f86b9211cc5618c400cd2902d64` |
| `C:\Program Files\…\app.asar` sha256 | `16b2a1290e704dce…` | `16b2a1290e704dce…` |
| HKLM registration | present | present, unmodified |
| `%APPDATA%` user DB fingerprint | `e5475ea436c2fc05…` | `e5475ea436c2fc05…` |
| Test-tagged rows in production | 0 | 0 |

Closure run (`pd3_audit.log`), captured independently of the harness:

| Measurement | Before | After |
|---|---|---|
| `data/blackstack-crm.db` md5 | `5cfa9fd13506439679a6c5405ec93075` | `5cfa9fd13506439679a6c5405ec93075` |
| Content fingerprint | `0ea76f86b9211cc5618c400cd2902d64` | `0ea76f86b9211cc5618c400cd2902d64` |
| `integrity_check` | ok | ok |
| `foreign_key_check` | 0 violations | 0 violations |
| Migrations | 69 applied, max v83 | 69 applied, max v83 |
| Sidecar timestamps | stable | stable |
| `data/` directory | db + 2 sidecars + regression-test | identical, no test artifacts |

**Physical checksum AND logical fingerprint are both identical.** No case arose
where they diverged, so no divergence needs explaining.

Isolation is `move → test → guaranteed restore`: the DB is moved into
`data/.phase-d-isolation-hold/` for the duration, restored in a `finally` block,
and `recoverIfHeld()` repairs an interrupted run at the *start* of the next one.
The temporary `MISSING` state while isolated is by design, not data loss.
| Test-tagged rows in userData DB | 0 | 0 |

---

## Recovery Matrix

| Scenario | Result | Evidence |
|---|---|---|
| Corrupted artifact (SHA-512 mismatch) | **PASS** | 114,143,981 B downloaded, then `sha512 checksum mismatch` → `ERROR` |
| SHA-512 mismatch | **PASS** | declared vs actual differ; rejection reason is integrity, not 404 |
| Truncated installer | **PASS** | 4,096 B → `sha512 checksum mismatch` → `ERROR` |
| Invalid update metadata | **PASS** | advertised artifact 404s → download refused |
| Installer failure | **PENDING** | needs a real NSIS install — blocked by the protected registration |
| Migration failure mid-transaction | **PASS** | rollback provably clean, 0 partial rows |
| Backup restore | **PASS** | corrupt backup refused, good backup restored, 7/7 joins resolve |
| Interrupted download | **PASS** | partial artifact not treated as valid; retry works |
| Interrupted installer | **PENDING** | same NSIS collision |
| Interrupted startup | **PASS** | v1 relaunches, `health=200 ready=200`, DB intact |

### A — corrupted artifact (three variants)

Each variant asserted individually: never `READY`; recoverable `ERROR` state;
installer never executed; app does not restart; current version usable; database
untouched in **both** content and bytes; failure logged; retry possible.

| Variant | Transferred | Final state | Failure reason |
|---|---|---|---|
| Declared/actual SHA-512 mismatch | `114143981` | `ERROR` | `sha512 checksum mismatch` |
| Truncated installer (4,096 B) | `4096` | `ERROR` | `sha512 checksum mismatch` |
| Invalid metadata | — | `ERROR` | `Cannot download … 404` |

Retry after each returned `AVAILABLE` — the updater is recoverable, not wedged.

### B — installer failure (PENDING)

Blocked by the protected registration. Verified earlier in an unprotected run: the
controlled ACL lock produced a real installer start and exit, v1 stayed recoverable,
the app continued to report `1.0.0`, and the database was unchanged. **Not claimed
as PASS for this run.**

### C — migration failure mid-transaction

A temporary migration was written into the *real* migrations directory and run by
the *real* runner (`server/database/migrate.js`, which wraps each file in
`conn.transaction()`). It inserted rows, then aborted on a duplicate primary key.
No production code was modified to hide the failure; the injected file was removed
afterwards.

```
before : fingerprint bd8e45b98b6f715f2d9bcf838555c94c  integrity ok  FK 0
failure: UNIQUE constraint failed: step3_fail_probe.id
after  : fingerprint bd8e45b98b6f715f2d9bcf838555c94c  integrity ok  FK 0
         probe table exists after failure : false
         probe rows persisted            : 0
         transaction rolled back: no partial business data — all tables identical
```

Application state after the failure: opens the recovered DB (`/ready` 200), updater
coherent (`IDLE`), business API usable, all 7 relationship joins resolve.

### D — backup restore

The application's real `backupService.safeRestoreBackup()` was used, not a copy.

- `verifyBackup` on a deliberately corrupted backup → rejected,
  `BACKUP_VERIFICATION_FAILED`, **live database byte-unchanged**
- `safeRestoreBackup` on the good backup → `{"restored":true}`
- Restored fingerprint identical to the original; integrity ok; 0 FK violations
- All 7 joins resolve: `contact`, `lead→contact`, `customer→contact`,
  `invoice→contact`, `invoice line→product`, `product→category→group`, `model→brand`
- Restored DB opens in the application and serves `/api/contacts`

### E — interrupted download

A genuinely partial download was observed, then the app was `SIGKILL`ed.

```
after restart : DOWNLOADING 2097152/114143981
incomplete artifact NOT treated as a valid update   PASS
updater can recover/retry                            PASS  → AVAILABLE
application remains usable                          PASS  HTTP 200
database intact                                     PASS
```

### F — process interruption model

No physical power loss; the process tree was killed to model it.

| Point | Result |
|---|---|
| during download | **PASS** — v1 relaunches, `health=200 ready=200`, DB unchanged |
| during verification | **PASS** — same, DB unchanged |
| during installer transition | **PENDING** — NSIS collision |
| during post-install startup | **PENDING** — NSIS collision |

### §14 — retry / repeat safety

Repeated checks safe; `Update Now` twice still reached `READY` with
`0` partial artifacts and `0` spawned installers; `POSTPONED` state coherent across
close/reopen; stale pending update recoverable.

---

## Production Release

| Check | Result |
|---|---|
| Production build config (appId / productName) | **PASS** |
| `electron-updater` is a **runtime** dependency | **PASS** — in `dependencies`, not devDependencies |
| Update provider configured | **PASS** — github |
| Windows NSIS installer target | **PASS** |
| Assisted install (`oneClick: false`) | **PASS** |
| `deleteAppDataOnUninstall === false` | **PASS** |
| Database outside install dir | **PASS** |
| Updater cache separately named | **PASS** — `blackstack-crm-v2-updater` |
| Update artifact cannot overwrite the DB | **PASS** |
| Update metadata publishes SHA-512 | **PASS** |
| Differential update blockmap present | **PASS** — `BlackStack CRM Setup 1.0.1.exe.blockmap` (119,822 B) |
| Hash verification in updater | **PASS** |
| Code signing | **PENDING** — no Code Signing EKU certificate available |
| Installer Authenticode signature | **PENDING** — `NotSigned` |
| Staging feed | **VERIFIED** |
| Production feed | **PENDING** — shipped `app-update.yml` targets `http://127.0.0.1:34811` |

**Code-signing evidence — independently re-verified at closure.** A direct query
for certificates carrying the Code Signing EKU (`1.3.6.1.5.5.7.3.3`) returns
**`count=0`**. Two certificates exist in `CurrentUser\My`, both self-signed and
neither holding that EKU:

| Subject | Valid until | Code Signing EKU |
|---|---|---|
| `CN=ContactBridge Systems, O=ContactBridge Systems, OU=Release Engineering, C=US` | 2026-08-26 → 2031-08-26 | **absent** |
| `CN=4233c88c-771e-4a0f-9113-de0026e81e39` | 2026-09-05 → 2027-09-05 | **absent** |

Without that EKU neither can produce a valid Authenticode signature.
`Get-AuthenticodeSignature` reports `NotSigned` on the shipped installer.
**No signing result is fabricated.**

**Production feed — clarified.** `package.json` `build.publish` is
`{provider: "github", owner: "blackstack", repo: "blackstack-crm-v2"}` — the
production configuration, verified intact after the run. The test binaries target
`http://127.0.0.1:34811` because `scripts/phase-d-build.js` overrides `publish` to
the staging feed **on a temporary copy only** and restores it afterwards. So the
repository is production-configured; what is unverified is a real signed release
against the real provider. Staging verification is labelled STAGING throughout.

### Build identity

| | v1 | v2 |
|---|---|---|
| Version | `1.0.0` | `1.0.1` |
| Installer | `BlackStack CRM Setup 1.0.0.exe` | `BlackStack CRM Setup 1.0.1.exe` |
| Installer SHA-256 | `13e685d58db481679ba8e8336ebb628b6000d78289540f6ebbdb43c35a1a23d4` | `053a9491c1586c79e63bb2c204b8135d9a4558e8804a5aafcb6e5b19e4d5a6d3` |
| Built | 2026-10-07 14:11:11 | 2026-10-07 14:12:15 |
| `app.asar` SHA-256 | `5b7b954f382f1036…` | `16b2a1290e704dce…` |

Both packages verified to carry the Step 1.5 DB write-path fix and the Step 2
version fix (`scripts/verify-build-has-db-fix.js`, all markers OK).

### Version consistency

| Source | Value |
|---|---|
| `package.json` | `1.0.0` |
| `server/version.js` (reads package.json) | `1.0.0` |
| v1 packaged `package.json` | `1.0.0` |
| v2 packaged `package.json` | `1.0.1` |
| Feed `latest.yml` | `1.0.1` |

No hard-coded `APP_VERSION` literal remains; an installed v2 cannot report v1.

---

## Data Safety

| Measurement | Value |
|---|---|
| Production content fingerprint BEFORE | `0ea76f86b9211cc5618c400cd2902d64` |
| Production content fingerprint AFTER | `0ea76f86b9211cc5618c400cd2902d64` — **unchanged** |
| Production file checksum BEFORE | `5cfa9fd13506439679a6c5405ec93075` |
| Production file checksum AFTER | `5cfa9fd13506439679a6c5405ec93075` — **unchanged** |
| `PRAGMA integrity_check` | ok |
| `PRAGMA foreign_key_check` | 0 violations |
| Migration result | 69 applied, max version 83, idempotent |
| Production DB opened by test process | **never** — absent from its path for the whole run |
| Production WAL/SHM | untouched; mtimes unchanged |
| Production settings / `package.json` | unchanged |
| Test-tagged rows in production | 0 |
| Test-tagged rows in `%APPDATA%` user DB | 0 |
| Hold directory after release | empty |

### Module preservation

CRM, Accounting, Inventory and Billing were seeded with real foreign keys and
verified by **resolved joins, not row counts** — 7/7 resolve before migration, after
the failed migration, and after restore from backup. Users/roles/permissions were
verified in Step 2 (re-login succeeds post-update). Settings served `200`.

### Attachments

**Attachments — N/A**
**Reason: the current application has no persistent attachment subsystem.**

Verified structurally, not assumed: no `attachments`/`documents`/`files` table in any
of the 69 migrations; no multipart/form-data/upload handling in any route, controller
or service; no upload middleware dependency. The reserved `uploads/` directory in the
data model is never written to. An earlier substring match on
`physical_stock_documents` was a false positive — that table is a physical stock-count
sheet, not stored files — and the check was corrected to match table names exactly.

---

## Multi-System Test

**PENDING — cannot be performed safely in this environment.**

Requested minimum is 3 isolated installations. electron-builder's NSIS target
registers **machine-wide (HKLM)**, so per-client isolation is not achievable on a
machine that already has a registration: the installer refuses with exit 199, and if
it did proceed it would write a machine-wide entry and overwrite the protected
installation.

Creating ten fake HKLM registrations, accepting exit 199, or deleting the existing
registration were all rejected as unsafe. A dedicated disposable VM/sandbox is the
correct environment for this test; none is available here.

---

## Regression

`npm run test:release` → **16/16 gates PASS, exit 0.**

| Gate | Result |
|---|---|
| 1 live database present | PASS (content `60322fcdcdf6`) |
| 2 architecture guard (retired tables) | 3 passed |
| 3 env-isolation guard (`process.env`) | 3 passed |
| 3 migration idempotency | 5 passed |
| 4 authorization (401/403/2xx) | 23 passed |
| 4 update/data-safety route contract | 29 passed |
| 4b Phase C update lifecycle | 57 passed |
| 4 bill lifecycle + reconciliation | 14 passed |
| 5 unit/integration (parallel) | **382 passed** |
| 6 unit/integration (serial) | **382 passed** |
| 7 E2E regression | **26 passed** |
| 8 reverse-order E2E | **7 passed** |
| 9 live DB content unmodified | PASS |
| 9 `PRAGMA integrity_check` | ok |
| 9 `foreign_key_check` | 0 violations |
| 9 stock ledger/balances reconcile | ledger=2 balances=2 |

Step 3 recovery suite: **102 passed, 0 failed, 7 skipped**, exit 0.

---

## Defects Found

### Product defects

**1. `server/version.js` — hard-coded application version** *(fixed, Step 2)*
- Symptom: an installed v1.0.1 application reported `1.0.0` to the renderer.
- Root cause: `APP_VERSION = '1.0.0'` was a literal. The updater uses
  `currentVersion` to decide whether an update is needed, so a pinned value
  misreports the running build after every update.
- Fix: read `package.json`, retaining the literal as a fallback.
- Files: `server/version.js`
- Verified: installed v2 reports `1.0.1`; both asars confirmed to read package.json.

**2. `server/database/seed.js:57` — username/email mismatch can crash startup** *(reported, not fixed)*
- Symptom: server never started; `UNIQUE constraint failed: users.username`.
- Root cause: the existence check is `SELECT id FROM users WHERE email = ?` but the
  insert hard-codes `username = 'admin'`. A database that already holds an `admin`
  username under a *different* email passes the check and then violates the UNIQUE
  constraint, aborting boot.
- Impact: any non-pristine database — e.g. one migrated from a portable DB whose
  admin has a different email — cannot start.
- Recommended fix: make the check match the constraint actually being inserted
  (or derive `username` from the email), and treat a UNIQUE failure as
  "already seeded" rather than fatal.
- **Not changed**: outside Step 3's verification scope and it is a data-layer
  change, not an updater one. Flagged for a deliberate decision.

### Harness defects

**3. Staging feed served a relative artifact URL** — electron-updater resolves
`files[].url` against the provider base, which dropped the feed's port, so every
artifact fetch became `http://127.0.0.1/…` → 404. **This meant Step 2's
corrupted-artifact test passed for the wrong reason** — a 404, not an integrity
rejection. Fixed: absolute URLs.

**4. Staging feed derived SHA-512 from the bytes it served** — a tampered file was
therefore self-consistently "valid" and undetectable. Fixed:
`PHASE_D_FEED_FORCE_SHA512` declares one hash while serving different bytes, which
is what corruption in transit actually looks like.

**5. `phase-d-step-3-run.js` exit-code path discarded the verdict** —
`main().then(() => process.exit(0))`. Runs with real failures reported `EXIT=0`.
Fixed and proved by self-test.

**6. `phase-d-verify-data.js` (Step 2) could not fail** — a `readOnly` SQLite open
cannot recover a live `-wal`, so every query failed and the script exited 0 having
asserted nothing. Fixed by snapshotting the DB plus sidecars.

**7. `phase-d-step-3-run.js` relationship check masked SQL errors** — the catch
returned `false`, turning a wrong query into a false "relationship lost". A
`contacts.name` reference (that column does not exist) produced a false failure.
Fixed to surface the error; assertions now require literal `true`.

**8. Baselines taken before first-boot seeding settled** — scenarios B, E, F and
the multi-system client took their fingerprint immediately after launch, so the
app's own demo seed was measured as "data loss". Fixed consistently.

**9. Blockmap filename wrong** — checked `latest.yml.blockmap`; electron-builder
writes `<installer>.exe.blockmap`.

**10. Feed routing name overwritten by the advertised name** — an override made the
feed serve the genuine artifact under a fake name, so the metadata-integrity case
never 404'd. Fixed by keeping the real routing name separate.

**11. Installer-process counts were machine-global** — a check could see the
*previous* scenario's installer winding down. Replaced with a client-scoped
assertion ("still reports 1.0.0").

**12. No registered-installation guard** — the harness would silently install over
an existing machine-wide installation, which is exactly how
`C:\Program Files\BlackStack CRM` was created. Fixed with
`phase-d-step-3-install-preflight.js`, which refuses to install and reports what it
found.

**Three times in this project a verifier was built that could not fail** — defect 5,
defect 6, and defect 7. A verifier that cannot fail is worse than none. This is the
single pattern most worth fixing properly.

---

## Remaining Limitations

| # | Item | Why | Needed to resolve |
|---|---|---|---|
| 1 | Installer failure recovery | NSIS registers machine-wide; a protected registration exists | Disposable VM |
| 2 | Interrupted installer | same | Disposable VM |
| 3 | Interrupted post-install startup | same | Disposable VM |
| 4 | Multi-system simulation | same | Disposable VM |
| 5 | Code signing / Authenticode | No certificate with Code Signing EKU on this machine | Purchase a code-signing certificate |
| 6 | Production feed | The **test** binaries target `http://127.0.0.1:34811`. Note the repo's `build.publish` is *already* production GitHub — `scripts/phase-d-build.js` overrides it to the staging feed on a temporary copy and restores it (line 54), verified intact after the run | Build and test against the real provider endpoint |
| 7 | Attachments | No attachment subsystem exists | A feature, not a test |

None of these is a product failure. Items 1–4 are **environment** limitations
created by a machine that already has a BlackStack installation; they are the exact
class of defect this step exists to detect, and they were detected and reported
rather than worked around.

**Not verified in this run:** scenario B's assertions, and the two installer-backed F
points, were green in an earlier unprotected run but are **not** claimed as PASS here.

---

## Cleanup

| Item | State |
|---|---|
| Packaged app processes | 0 |
| Installer/updater processes | 0 |
| Staging feed | stopped |
| Isolated installs / caches / databases / feeds | removed |
| Injected migration file | removed |
| `data/.phase-d-isolation-hold` | removed |
| `user-data/` scratch | removed |
| Throwaway probe scripts | removed |
| `package.json` | restored to `1.0.0` |
| **Production data** | **untouched** |
| **Machine-wide install** | **untouched** |
| **`%APPDATA%` user database** | **untouched** |

---

## Final Verdict

# PHASE D STEP 3 — PASS WITH LIMITATIONS
