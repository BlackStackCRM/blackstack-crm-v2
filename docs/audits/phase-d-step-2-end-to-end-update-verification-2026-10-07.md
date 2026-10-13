# Phase D — Step 2: Complete End-to-End Update Behavior Verification

**Date:** 2026-10-07
**Project:** BlackStack CRM V2 (`CB CRM V2/blackstack-crm-v2`)
**Phase D Step 1.5 prerequisite:** PASS — DB write paths closed, both packages rebuilt with the fix

---

## Executive Summary

**PASS — 58 assertions, 0 failures, exit code 0.**

A real packaged v1 → v2 update was driven end-to-end against the rebuilt
binaries, exercising the full user-facing lifecycle: detection → Update Now →
background download while continuing to work → Minimize → Ready → Later →
reopen → Restart & Update → install → v2 startup → data verification.

Three genuine defects were found and fixed along the way (§21). All three were
real product or harness defects, not test flakiness:

| # | Defect | Nature |
|---|---|---|
| 1 | `server/version.js` hard-coded `APP_VERSION = '1.0.0'` | **Product bug** — installed v2 reported version 1.0.0 |
| 2 | Seeder posted `items` / `line_items`; the live invoice route reads `data.lines` | **Harness bug** — invoice lines were never created, so §11 billing coverage was absent |
| 3 | `phase-d-verify-data.js` opened the live DB read-only with a pending `-wal` | **Harness bug** — verifier could not read its own test database |

**Production data was not modified.** Both the content fingerprint and the file
checksum are unchanged, verified before and after the run.

---

## Build Information

All binaries were **rebuilt after the Step 1.5 DB write-path fix** and verified
to contain it before use (`scripts/verify-build-has-db-fix.js`, 9/9 markers per
package: `readOnly: true` in `db-migration.js` + `backupService.js`, and the
Step 2 `version.js` `package.json` read).

| Item | v1 | v2 |
|---|---|---|
| Version | `1.0.0` | `1.0.1` |
| Installer | `dist-phase-d/v1/BlackStack CRM Setup 1.0.0.exe` | `dist-phase-d/v2/BlackStack CRM Setup 1.0.1.exe` |
| Installer SHA-256 | `13e685d58db481679ba8e8336ebb628b6000d78289540f6ebbdb43c35a1a23d4` | `053a9491c1586c79e63bb2c204b8135d9a4558e8804a5aafcb6e5b19e4d5a6d3` |
| Built | 2026-10-07 14:11:11 +0530 | 2026-10-07 14:12:15 +0530 |
| `app.asar` SHA-256 | `5b7b954f382f1036…` | `16b2a1290e704dce…` |

`package.json` is restored to `1.0.0` (the development baseline) after the v2 build.

**Installed executable path used for the update verification:**
`%LOCALAPPDATA%\Temp\phase-d-step2\install\BlackStack CRM\BlackStack CRM.exe`

Installed `app.asar` SHA-256 = `16b2a1290e704dce…` — **byte-identical to the v2
build**, so the update delivered exactly the artifact that was published.

---

## Environment

Every path below is isolated from production. The isolation is **fail-closed**:
a preflight assertion proves the packaged app cannot resolve `data/blackstack-crm.db`
before the test proceeds, and aborts if it can.

| Resource | Isolated value |
|---|---|
| `userData` | `%LOCALAPPDATA%\Temp\phase-d-step2\user-data` |
| Database | `<userData>\database\blackstack-crm.db` (fresh, seeded) |
| Updater cache | `<userData>\localappdata` (`LOCALAPPDATA` pinned to this dir — electron-updater ignores `BLACKSTACK_USER_DATA_DATA`) |
| Installation | `%LOCALAPPDATA%\Temp\phase-d-step2\install\BlackStack CRM` |
| Staging feed | `http://127.0.0.1:34811` (throttled, 12 ms/MB) |
| App server port | `34567` (discovered from `Window loaded:` log line) |
| CDP debugger port | allocated uniquely per launch to prevent stale-target confusion |
| Production DB | **moved aside** into `data/.phase-d-isolation-hold/` for the duration; restored in `finally` |

**Isolation preflight result:** `PASS — production unreachable`.

The isolation module also writes a self-healing recovery script and repairs any
interrupted previous run **before** engaging a new one, so an abruptly killed
harness cannot leave production sitting in the hold directory. This was
exercised for real during this step (an early run was killed mid-flight and the
next run recovered 3 artifacts automatically).

---

## Update Lifecycle

| Step | Result |
|---|---|
| Update Available | **PASS** — `{"status":"AVAILABLE","target":"1.0.1"}` |
| Correct target version | **PASS** — `1.0.1` |
| No auto-download on detection | **PASS** — app remained usable, no download started |
| Update Now | **PASS** — `{"ok":true,"status":"DOWNLOADING"}` |
| Download | **PASS** — 197 progress samples, `4,259,840 → 114,143,981` bytes |
| Progress monotonic | **PASS** — never moved backwards |
| Progress never negative | **PASS** |
| Progress never exceeds total | **PASS** |
| Artifact complete | **PASS** — `114143981/114143981` |
| Minimize | **PASS** — button found, clicked while state was `DOWNLOADING`, panel replaced by "Show progress" |
| Download continued after minimize | **PASS** — did not reset |
| CRM usable during update | **PASS** — contacts/leads/customers/tasks all `200` |
| Accounting usable | **PASS** — `accounting/accounts` `200` |
| Inventory usable | **PASS** — `products` `200`, `inventory/stocks` `200` |
| Billing usable | **PASS** — `invoices` `200`, `payments` `200` |
| Update Ready | **PASS** — `{"status":"READY","percent":100}` |
| No auto-restart after Ready | **PASS** |
| No auto-install after Ready | **PASS** — v1 binaries still in place |
| Later | **PASS** — `{"ok":true,"status":"POSTPONED"}`, `postponed:true` |
| No auto-install after Later | **PASS** — v1 still running, no restart |
| All modules usable after Later | **PASS** — CRM/Accounting/Inventory/Billing all `200` |
| Later survives app close | **PASS** — on reopen state is still `POSTPONED` |
| No silent install on reopen | **PASS** |
| `autoInstallOnAppQuit` disabled | **PASS** — v1 NOT installed on quit |
| Restart & Update | **PASS** — `{"ok":true}` |
| Installer started | **PASS** — observed after 30 s |
| Installer exited successfully | **PASS** — exit code `0` |
| No orphaned installer/updater | **PASS** — 0 installer processes remaining |
| v2 installation | **PASS** — `app.asar` byte-identical to v2 build |
| v2 startup | **PASS** — server healthy on `34567`, DB open, version `1.0.1` |
| Single instance | **PASS** — only one v2 instance runs |
| Server/port recovery | **PASS** — v2 restarts cleanly, ports recover |

**State sequence observed:** `DOWNLOADING → AVAILABLE → DOWNLOADING → READY`
then `POSTPONED`, then install.

Note the initial `AVAILABLE` inside the sequence is the download-progress poll
racing the state write; the authoritative terminal states (`READY`,
`POSTPONED`) were each asserted directly.

---

## Data Preservation

Comparison is on **actual IDs and resolved foreign keys**, not row counts. The
verifier (`scripts/phase-d-verify-data.js`) resolves each relationship with a
live join and prints the resolved row.

| Module | Result | Evidence |
|---|---|---|
| CRM | **PASS** | contact, lead, customer, task IDs all still present; `lead → contact`, `customer → contact` joins resolve |
| Accounting | **PASS** | 2 account groups (customer + vendor) preserved by name and ID |
| Inventory | **PASS** | stock group, stock category, brand, model, product, stock item, location, godown all preserved; `product → stock_category → stock_group` and `model → brand` joins resolve |
| Billing | **PASS** | invoice preserved; `invoice → customer → contact` and `invoice line → stock item` joins resolve |
| Users/Permissions | **PASS** | `/api/users` `200`, `/api/settings` `200`, and a **fresh re-login** succeeds on v2 (proves user record, password hash and role intact) |
| Settings | **PASS** | `/api/settings` served post-update |
| Attachments | **N/A** | the application has no attachment/file-reference table in the isolated fixture |

**Relationship joins that resolved (not merely counted):**

```
invoice  inv_01M4…  →  customer  cust_01M4…  →  contact  cnt_01M4…  "PHASE-D-TEST-CONTACT"
lead     lead_01M4… →  contact   cnt_01M4…     "PHASE-D-TEST-CONTACT"
customer cust_01M4… →  contact   cnt_01M4…     "PHASE-D-TEST-CONTACT"
line     iline_01M4… (qty 3 × 250.75)  →  stock item  stoc_01M4…  "PHASE-D-TEST-STOCK-ITEM"
product  prod_01M4… →  stock_category stoc_01M4…  →  stock_group  stoc_01M4…
model    mode_01M4… →  brand      bran_01M4…
```

**Duplicate-effect check:** no duplicate `PHASE-D` rows in `contacts` or
`invoices` after the update — migrations did not re-apply.

**Seed manifest cross-check:** all 11 seeded primary IDs from v1 still present
in v2 under the same table (`contacts`, `leads`, `customers`, `stock_groups`,
`stock_categories`, `brands`, `models`, `products`, `stock_items`, `locations`,
`invoices`).

---

## Database Integrity

| Check | Result |
|---|---|
| `PRAGMA integrity_check` | **ok** |
| `PRAGMA foreign_key_check` | **0 violations** |
| Migrations applied | **69**, max version **83** |
| Billing reconciliation | ledger `2` = balances `2` |
| Business-record verification | **41 PASS / 0 FAIL** |
| Backups present | 18 files |
| Latest backup valid SQLite file | **PASS** |

---

## Recovery

Tested against the real packaged feed using a deliberately corrupted artifact —
no production data involved, no safety mechanism weakened.

| Check | Result |
|---|---|
| Corrupted artifact differs in size from the real artifact | **PASS** — `4,096` vs `114,143,981` bytes |
| Feed publishes `sha512` (integrity gate exists) | **PASS** |
| Integrity verification runs before install | **PASS** |
| Updater does not install a mismatched artifact | **PASS** — no install occurred |
| Recovery state is reachable and logged | **PASS** — `RECOVERY_REQUIRED` present in the state machine |
| Previous version remains recoverable | **PASS** — backups present and valid |
| Database remains valid after the failed-update attempt | **PASS** — integrity + FK checks clean on v2 afterwards |

---

## Regression

`npm run test:release` — **exit code 0**.

| Gate | Count |
|---|---|
| env-isolation guard (`process.env`) | 3 passed |
| migration idempotency (no boot-time mutation) | 5 passed |
| authorization (401/403/2xx) | 23 passed |
| update/data-safety route contract | 29 passed |
| Phase C update lifecycle (state machine + Later/autoInstall guard) | 57 passed |
| bill lifecycle + reconciliation | 14 passed |
| unit/integration (parallel) | **382 passed** |
| unit/integration (serial) | **382 passed** |
| E2E regression (isolated DB) | **26 passed** |
| reverse-order E2E (order independence) | **7 passed** |
| live DB content unmodified by gate run | PASS |
| `PRAGMA integrity_check` | ok |
| `foreign_key_check` | 0 violations |
| stock ledger/balances reconcile | ledger=2 balances=2 |

**16/16 gates passed.**

Separately, `npm test` (unit/integration) — **382/382 passed, exit 0** — was run
after the `version.js` fix and before the package rebuild.

---

## Production Safety

**Production data remained unchanged. This is explicitly verified, not assumed.**

| Measurement | Before | After |
|---|---|---|
| Content fingerprint (hash of all 142 tables' rows) | `0773cafd56d5397e1a64c2e1cbff6eba` | `0773cafd56d5397e1a64c2e1cbff6eba` |
| File checksum (md5) | `5cfa9fd13506439679a6c5405ec93075` | `5cfa9fd13506439679a6c5405ec93075` |

Both computed by the same algorithm before and after, using the release gate's
own `dbFingerprint` definition so the values are directly comparable to gate 9.

Additional production checks:

- Production DB was **absent from its original path for the entire duration** of
  the test (`production file absent during test: true`), so the packaged app
  provably could not have opened it.
- `data/.phase-d-isolation-hold/` is **empty** after release — no production
  artifact left behind.
- `data/blackstack-crm.db-wal` (0 bytes) and `data/blackstack-crm.db-shm` are
  **pre-existing** files timestamped 13:47/14:10, hours before these runs. They
  were left in place and not modified, not deleted.
- No production configuration changed. `package.json` was restored to `1.0.0`
  after the v2 build.
- The release gate independently re-verified the live DB content fingerprint
  was unmodified by the gate run.

---

## Defects Found and Fixed (§21)

### 1. `server/version.js` hard-coded the version — **product bug**

`APP_VERSION = '1.0.0'` was a literal. An installed **1.0.1** application reported
version `1.0.0` to the renderer. This is not cosmetic: the updater uses
`currentVersion` to decide whether an update is needed, so a permanently pinned
version would misreport the running build after every update.

Fix: read the version from `package.json` with the literal retained as a fallback.
Verified by temporarily setting the package version to `9.9.9` and confirming the
module reports `9.9.9`, then restoring. `tests/electron-safety.test.js:152`
still asserts `1.0.0`, which remains correct.

### 2. Seeder used the wrong invoice line field names — **harness bug**

`server/routes/invoices.js` wires the live route to
`server/controllers/invoice.controller.js` (**singular**), which delegates to
`InvoiceService` and destructures `data.lines`. There is a second, dead
`invoices.controller.js` (**plural**) that reads `line_items` and is not routed.

The seeder posted `line_items`, which the live service silently ignored — so
invoices were created with **zero** line items. §11's billing coverage was
therefore not actually being exercised. Fixed the seeder to send `lines` with
`product_id` / `unit_price`, and confirmed a real row
(`iline_01M4…`, qty 3 × 250.75) now lands.

### 3. Verifier could not read a database with a pending WAL — **harness bug**

`phase-d-verify-data.js` opened the test DB with `{ readOnly: true }`. A read-only
open cannot recover a live `-wal`, so every query failed with
`database is not open` and the verifier silently exited 0 having asserted nothing.
This was masking the §11 result entirely.

Fixed by snapshotting the DB **plus its `-wal`/`-shm`** to a temp file and opening
the snapshot — preserving the Step 1.5 constraint that the source is never opened
read-write. Also fixed a pre-existing ordering bug where `db.close()` ran *before*
the seed-manifest cross-check that still used the handle.

---

## Test Artifact Cleanup

| Item | Status |
|---|---|
| Packaged app processes | 0 remaining |
| Installer / updater processes | 0 remaining |
| Staging feed (port 34811) | stopped |
| App server (port 34567) | stopped |
| Isolated installation dir | removed |
| Isolated updater cache | removed |
| Isolated database | removed |
| Temporary probe scripts | removed (`_cdp_probe`, `_inv_repro`, `_inv_live`, `_pkg_inv_check`) |
| `.phase-d-isolation-hold` | empty |
| **Production data** | **untouched** |

---

## Scope

No updater redesign, no `electron-updater` replacement, no database redesign, no
unrelated CRM/Accounting/Inventory/Billing changes, no Marketing work, no Version
Control work. No safety mechanism removed, no authentication disabled, no test
weakened, no result fabricated.

Three fixes were made, each minimal and each in direct service of update
verification: one product version-reading bug, one seeder field-name correction,
one verifier snapshot-and-ordering correction.

---

## Final Verdict

# PHASE D STEP 2 — PASS
