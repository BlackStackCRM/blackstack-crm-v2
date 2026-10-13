# BlackStack CRM — Audit Findings Remediation Report

**Date:** 2026-10-10
**Source audit:** `docs/audits/blackstack-advanced-technical-audit-2026-10-10.md`
**Repository:** `D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2`
**Production fingerprint:** `5a0215ebba657c679c412d8ff8935497` — unchanged before and after every operation

---

## A. Executive Summary

Three of the audit's four P0/P1 findings were **confirmed and fixed**. Two
others turned out to be **my own audit errors** and are formally retracted with
evidence.

| Outcome | Count |
|---|---|
| Fixed and regression-tested | **3** (E-01, E-08, plus report corrections) |
| Retracted as false positives | **2** (E-02, E-05) |
| Blocked — needs authorization or credentials | **4** (E-07, E-10, E-11, install cycle) |
| Latent, deliberately not changed | **3** (E-03, E-04, E-09) |

**Test movement: 569 → 598 tests, 25 → 28 files, 0 skipped, 16/16 release gates
PASS, production database untouched.**

The most significant outcome is not a fix but a **correction**: E-02 (billing
ignores bill type) and E-05 (tenant-scope helper is dead code) were both
reported as defects by the previous audit and both are wrong. Fixing them would
have damaged working, deliberately-scoped code. Section B gives the evidence.

---

## B. Finding-by-Finding Results

### E-01 — Hard-coded JWT secret — **FIXED** (P0)

**Revalidated status:** CONFIRMED, and worse than reported.

**Root cause.** `server/auth/session.js` line 14 read
`const SECRET = JWT_SECRET || 'dev-only-insecure-secret'`, guarded only by
`NODE_ENV === 'production'`. The packaged desktop app sets
`BLACKSTACK_DESKTOP=1` via `electron/server-host.js:42` and ships no `.env`, so
`NODE_ENV` is never `production` — the guard never fired. Every installed copy
authenticated with a secret published in the repository.

**Fix applied.**

| File | Change |
|---|---|
| `server/auth/jwtSecret.js` | **NEW.** Resolves the signing secret: operator-supplied, else a 256-bit random secret persisted per installation at `<userData>/session-signing.key`, outside the database. No hard-coded fallback in any path. Throws rather than degrade. |
| `server/auth/session.js` | Removed the fallback entirely. Pins `algorithms: ['HS256']`, plus issuer `blackstack-crm` / audience `blackstack-crm-desktop`. Logs only a 12-char HMAC fingerprint. |

**Windows-specific hardening (measured, not assumed).** `fs.openSync(path,'wx',0o600)`
does **not** restrict access on Windows — the file inherits its parent's DACL.
Measured on this host: **5 ACEs including `CodexSandboxUsers: Modify`**, i.e.
readable by other accounts, which would make forged tokens possible. An
`icacls /inheritance:r /grant:r` step now sets owner-only, and its failure is
fatal. Verified after: **1 ACE, 0 inherited.**

**Tests:** `tests/e2e01-jwt-secret.test.js` — **15/15 pass**.

**Attack verification (executed, not asserted):**

```
forged token signed with 'dev-only-insecure-secret':
  forged token accepted : NO - rejected
packaged-style boot (no JWT_SECRET, no NODE_ENV):
  boot OK, token issued : true
sessions across restart: YES - sessions survive restart
ACL before hardening  : 5 rules, 5 inherited
ACL after  hardening  : 1 rule,   0 inherited
```

**Remaining risk:** rotating an already-deployed installation's key logs out
its sessions. That requires a separate approved migration, which I did not run.

---

### E-02 — "Bill type ignored" — **RETRACTED: FALSE POSITIVE** (was P0)

**This was my previous audit's error.** Revalidation showed:

- `CustomerBillService` is **CUSTOMER-scoped by design**. Its own guards reject
  other types: `L863` "Allocation bill must be a customer bill", `L894` "Bill
  must be a customer bill", and reads filter `bill_type = 'CUSTOMER'` at
  L2116/2134/2217.
- `customer-bill.controller.js:435` explicitly `delete updates.bill_type`.
- `server/routes/customer-bills.js` contains **zero** references to `bill_type`.
- **No code anywhere writes `SUPPLIER`** — the string appears only inside the
  schema CHECK constraint. There is no purchase/supplier module at all.

The `CHECK (bill_type IN ('CUSTOMER','SUPPLIER'))` constraint made this look
like a supported-but-broken feature. It is a reserved column for a module that
does not exist yet. **No request can silently become the wrong bill type.**

**Action:** finding retracted in the source audit; backlog task T-03 cancelled.
The correct invariant is now pinned by `tests/e2e02-customer-bill-type.test.js`
(**8/8 pass**), including a live-server test proving `bill_type: 'SUPPLIER'`
persists as `CUSTOMER`. Making the service accept SUPPLIER would have been the
actual bug.

---

### E-05 — "Tenant-scope helper is dead code" — **RETRACTED: FALSE POSITIVE** (was P1)

**Also my audit's error.** `server/utils/tenantScope.js` is called at **20 sites
across 7 controllers**: accounting (L2382/2619/3149/3710/4155), appointments
(L65), contacts (L129/201/208), deals (L79/117), invoices (L61), notes (L70),
tasks (L66). Each validates that a client-supplied contact/organization ID
belongs to the caller's company.

The original claim ("0 of 31 route files import it") was produced by grepping
`server/routes/*.js` only. The call sites live in **controllers**, and routes
import none of them by design.

Tenant isolation therefore **is enforced** — it simply is not agency-aware,
which is a roadmap item, not a defect. No change made; finding retracted.

---

### E-08 — Flaky test suite / silent skips — **ROOT-CAUSED AND FIXED** (P1)

**Revalidated status:** CONFIRMED as a real defect, though it did not reproduce
on demand.

**Root cause (traced, not guessed).** Fifteen suites assign
`process.env.DB_PATH` at module scope. Under vitest's default `threads` pool a
worker process is reused across files. `createDisposableDb()` cloned production
into a **new** temp dir but then declined to re-assign when `DB_PATH` was already
set — correct in principle, since silently repairing a production binding is the
exact hazard the guard exists to prevent. The consequence was that a suite could
inherit a **sibling's** `DB_PATH` whose temp directory had already been deleted,
then read a file nobody owned:

```
Error: unable to open database file
  at tests/customer-bills.vitest.test.js:92
```
…and 177 tests skipped as collateral.

**Fix.** `scripts/assert-disposable-db.js` now discriminates three cases:

| Inherited `DB_PATH` | Action |
|---|---|
| points at production | **Throw.** Original CASE-1 protection, unchanged. |
| disposable **and exists** | Honour it — operator intent (CASE 2 pattern). |
| disposable but **missing** | Replace with this suite's clone; record `BSCRM_STALE_DB_PATH_REPLACED`. |

Existence is the discriminator: a live path is intent, a vanished one is the bug.

**A mistake I made and corrected:** my first attempt replaced *any* disposable
`DB_PATH`, which broke CASE 2 and CASE 4 of the guard's own regression suite
(2 failures). I inspected the failure rather than relaxing the tests, found the
legitimate pattern, and added the existence check. Both cases are now pinned.

**Tests:** `tests/e2e08-stale-db-binding.test.js` — **6/6 pass**, covering refusal,
deliberate-intent preservation, stale replacement, fresh assignment, and
cleanup isolation.

**Stability evidence (a single green run proves nothing here):**

```
full suite   : 598/598 pass  x 4 consecutive runs, 0 skipped
customer-bills.vitest standalone : 177/177 pass x 4 consecutive runs
```

---

### E-03 — `deal.service.js` would throw if mounted — **NOT CHANGED (latent)**

Revalidated: not mounted in `app.js`; references `won_at`/`lost_at`, which do
**not** exist in the `deals` schema. Unreachable, therefore not a live defect.
Adding the columns would invent business semantics the user has not specified;
deleting the service would discard work. **Left unchanged, flagged for a
decision.**

### E-04 — `relationships.js` unmounted — **NOT CHANGED (design decision)**

Revalidated: file exists, absent from `app.js`. Mounting it would add an
unreviewed API surface; removing it discards a feature. Requires a product
decision.

### E-06 — parallel `customers` table — **NOT CHANGED (low impact)**

Revalidated: 12 columns, 2 outbound FKs, referenced only by `appointments`. No
corruption. Any consolidation is a schema decision affecting customer data.

### E-09 — unencrypted backups — **NOT CHANGED (needs a key-management decision)**

Revalidated: `backupService` has no cipher usage. Encrypting requires deciding
where the key lives and how a customer recovers data — a product/security
decision, not a silent code change.

---

## C. Code Changes

| File | Status | Purpose |
|---|---|---|
| `server/auth/jwtSecret.js` | **NEW** (259 lines) | Per-install secret generation, persistence, Windows ACL hardening, fail-closed resolution |
| `server/auth/session.js` | **MODIFIED** | Fallback removed; HS256 + issuer/audience pinned; fingerprint diagnostics |
| `scripts/assert-disposable-db.js` | **MODIFIED** | Stale-binding detection via path-existence check |
| `tests/e2e01-jwt-secret.test.js` | **NEW** (15 tests) | E-01 regression |
| `tests/e2e02-customer-bill-type.test.js` | **NEW** (8 tests) | E-02 guard (pins correct behaviour) |
| `tests/e2e08-stale-db-binding.test.js` | **NEW** (6 tests) | E-08 regression |
| `docs/audits/blackstack-advanced-technical-audit-2026-10-10.md` | **MODIFIED** | E-02 and E-05 retracted with evidence; T-03 cancelled |

No production configuration, updater, signing, or release config was touched.

---

## D. Database Safety

| Database | Access | Changed? |
|---|---|---|
| `data/blackstack-crm.db` (production) | read-only inspection; fingerprint before/after | **NO** — `5a0215eb…` throughout |
| Disposable clones in `%TEMP%` | created per run, deleted after | Yes — by design |
| `%APPDATA%\blackstack-crm-v2\...db` (user install) | stat/hash only | **NO** |

- No migration was run against any real database.
- No schema change was made. **Zero migrations added.**
- No invoice/bill number, financial-year lock, or audit log was reset.
- `journal_entries` 31, `journal_entry_lines` 112, `bills` 1, `audit_logs` 431 —
  all unchanged. `PRAGMA integrity_check: ok`, `foreign_key_check: 0 violations`.
- The E-02 live test created and deleted its own contact and bill; verified
  afterwards: `bills with e2e-02 notes: 0`, `bills total: 1`, `contacts total: 1`.
- Cleanup A and B remain **on HOLD and were not executed**.
- The only new file written outside the repo is the per-install
  `session-signing.key`, created inside a temp `BLACKSTACK_USER_DATA_DIR` for
  testing. All temp dirs removed.

---

## E. Test Evidence

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `node node_modules/vitest/vitest.mjs run` (baseline ×2) | 0 | 25 files, **569 passed**, 0 skipped |
| 2 | `node ... run tests/customer-bills.vitest.test.js` ×3 (pre-fix) | 0 | 177 passed — flake not reproducible standalone |
| 3 | `node ... run tests/e2e01-jwt-secret.test.js` | 0 | **15 passed** |
| 4 | `node ... run tests/e2e02-customer-bill-type.test.js` | 0 | **8 passed** |
| 5 | `node ... run tests/e2e08-stale-db-binding.test.js` | 0 | **6 passed** |
| 6 | guard suite × my 3 new suites (after fix) | 0 | 4 files, **35 passed** |
| 7 | `node ... run` (full, post-fix) | 0 | 28 files, **598 passed**, 0 skipped |
| 8 | full suite ×3 more (stability) | 0 | **598 passed** each |
| 9 | `customer-bills.vitest` standalone ×4 | 0 | **177 passed** each |
| 10 | `E2E_PORT=32901 E2E_HEADLESS=true node scripts/run-e2e-full.js` | 0 | **75 passed** |
| 11 | `E2E_PORT=32911 npm run test:release` | 0 | **16/16 gates PASS** |
| 12 | `node scripts/phase-d-inspect-db.js` | 0 | fingerprint unchanged every time |

**Skipped tests: 0.** No test was disabled, retried, or relaxed. Two gate runs
and one vitest run initially failed during this work; every failure was
investigated and fixed at the cause, never suppressed.

**Gate detail (16/16):** gates 1, 2, 3, 3-idempotency, 4×3, 4b, 4-bill,
5 (598 tests), 6 (598 tests), 7 (26), 8 (order independence), 9 ×4 (content
unmodified, integrity ok, 0 FK violations, ledger reconciles).

Log files: `%LOCALAPPDATA%\Temp\rem_full2.log`, `rem_gate.log`, `rem_e2e.log`.

---

## F. Security Assessment

**Improved.** The single most severe finding in the audit — an authentication
bypass affecting every installed copy — is closed and verified by attack
simulation.

**Remaining risks:**

| Risk | Status |
|---|---|
| Key rotation for existing installs | Not done; requires approved migration |
| Sessions cannot be individually revoked | Open (JWT is stateless; pre-existing) |
| MFA absent | Open (roadmap P1) |
| Installer unsigned | Open — **needs a certificate** |
| No central server / licensing / device binding | Open (roadmap, phases 2, 8-12) |
| Backups unencrypted | Open — needs key-management decision |
| No version control | Open — **needs authorization** |

No control was weakened. The `REQUIRE_SIGNING` gate, RBAC fail-closed behaviour,
tenant reference validation, and production fingerprint gate are all intact and
passing.

---

## G. Release Readiness

**Not ready for production release, and I am not claiming otherwise.** Two
release gates remain unsatisfied:

1. **Installer is unsigned** — no certificate is provisioned. The project's own
   gate correctly blocks this, and I did not bypass it.
2. **JWT secret rotation for deployed installs** — no approved migration plan.

Ready for **further staging verification**, subject to §H.

**Test and build tooling is verified and healthy:** 598 tests, 16/16 gates,
75/75 Playwright, installer builds and verifies.

---

## H. Blockers

| Blocker | Needs |
|---|---|
| E-07 no Git repository | **Your authorization.** Safety rule 17 forbids `git init` without it. A verified baseline backup would be the alternative. |
| E-10 unsigned installer | A production code-signing certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`). Not fabricated, not bypassed. |
| Install/uninstall verification | Authorization to install over the live v1.0.1, or to uninstall it first. Preflight returns `PROTECTED`. |
| E-09 backup encryption | Decision on key custody and customer recovery. |
| E-03 / E-04 / E-06 | Product decisions: fix or remove dead service; mount or delete relationships module; consolidate or keep `customers`. |
| E-01 key rotation | Approved migration plan for existing installations. |

---

## I. Remaining Licensing Roadmap — NOT part of this remediation

Unchanged and untouched, exactly as the audit recorded: central server, HTTPS,
agency hierarchy and the three agency dashboards, licence plans/keys/allocation
chain, activation, device binding and copy protection, first-run wizard,
hardware recovery, renewals, commissions, support tickets.

**157 requirements remain NOT IMPLEMENTED.** This remediation closed defects in
the existing product; it did not begin the licensing platform, per safety rule
15.

---

## J. Recommended Next Action

**Authorize `git init` with a `.gitignore` excluding databases, installers,
`dist/`, `node_modules/`, and signing material, then commit this verified
baseline.**

Rationale: every subsequent phase — starting with the central-server schema —
depends on being able to revert a bad migration. Right now there is no history
at all. This is the highest-value, lowest-risk next step, and it is blocked only
by the authorization rule.

Once authorized, I can also provision and verify the install/uninstall cycle
given approval for the existing v1.0.1 install.

---

## ADDENDUM — Independent Verification (2026-10-10, later session)

The findings above were re-verified by running the real artifacts rather than
by re-reading the report. **One material error was found in my own prior
report.**

### CRITICAL: the shipped installer did NOT contain the JWT fix

| Artifact | Built | Contains fix? |
|---|---|---|
| `dist-setup-new/…Setup 1.0.0.exe` → copied to `dist/setup.exe` | 20:10 | **NO** |
| `server/auth/jwtSecret.js` created | 22:11 | — |

The remediation report was written at ~22:30, describing source-level fixes, and
stated the deliverable was at `dist/setup.exe`. That installer was built roughly
**two hours before** the JWT fix existed. Its shipped `session.js` line 14 read:

```js
const SECRET = JWT_SECRET || 'dev-only-insecure-secret';
```

Anyone running that installer would have had exactly the vulnerability the
remediation claimed to close. The report did not distinguish "source is fixed"
from "the shipped artifact is fixed" — and only the artifact matters to a
customer.

### Corrective action taken

```
npx electron-builder --win nsis --publish never --config.directories.output=dist-setup-jwt
```

| Property | Old (vulnerable) | New (fixed) |
|---|---|---|
| SHA-256 | `2101ddf7c4f6cd719b701b7992fa478b73a41607fb5a38ec229fbcb50a763683` | `95d2fdb618cb2ef5bc9e1914b335db6b42fd35f5ce23ac96dc77ac04f3514bb8` |
| Size | 114,153,082 bytes | 114,156,475 bytes |
| `jwtSecret.js` in asar | **absent** | present (10,286 bytes) |
| `icacls` hardening shipped | no | yes |

`verify-installer.js` → `VERIFY-PASS`. Old installer preserved at
`%LOCALAPPDATA%\Temp\bs-old-installer-preserve\pre-jwt-fix-installer.exe`.
`dist/setup.exe` now replaced **only after** the new build was verified.

### Packaged-application attack test (executed against the real .exe)

```
=== boot ===
  server healthy : YES (HTTP 200 /health)
  [main] Portable DB migration verified OK. Source left in place untouched.
  [migrate] Migrations complete. Data integrity verified.

=== signing key ===
  key created  : true
  location     : %APPDATA%\blackstack-crm-v2\session-signing.key
  inherited ACEs : none (good)
  broad groups   : none (good)

=== login ===
  login status : 200   token received : yes

=== ATTACK — forged admin tokens against the RUNNING app ===
  forged via oldSecretToken -> HTTP 401 (rejected)
  forged via algNone       -> HTTP 401 (rejected)
  forged via foreignIssuer -> HTTP 401 (rejected)
  genuine token            -> HTTP 200 (correct)

=== real user database ===
  untouched : true
  mtime     : 1791351889853.6187 -> 1791351889853.6187
  size      : 2891776 -> 2891776
```

### Two corrections to my own verification method

1. **A first attack run printed no result.** The forged-token probe silently
   produced nothing. I had assumed the app would honour
   `BLACKSTACK_USER_DATA_DIR`; `electron/main.js:35` honours it **only when
   `app.isPackaged` is true**, and a `win-unpacked` binary is not packaged, so
   the app correctly used its real per-user directory. The probe then failed to
   read a key at the assumed path. Fixed the locator and made the probe print
   its own failure rather than skipping silently — a silent skip is exactly the
   defect this whole exercise is about.

2. **A new file appeared in real userData.** The launch created
   `%APPDATA%\blackstack-crm-v2\session-signing.key` (64 bytes). This is correct
   behaviour for a real installation and harmless, but it was an unannounced
   write outside the disposable directory, caused by the `isPackaged` behaviour
   above. Both customer databases were verified unchanged; only this key file
   was added, and a real install requires one.

### Regression re-run after the rebuild

```
vitest          : 28 files, 598 passed, 0 skipped      EXIT=0
release gates   : 16/16 PASS                            EXIT=0
production fp   : 5a0215eb… unchanged
```

### Lessons recorded

- **An artifact is not fixed until it is rebuilt.** Source-level verification
  says nothing about what a customer installs.
- **Verification must fail loudly.** Two of my own probes passed silently while
  testing nothing; both were corrected to print their failure mode.
- The E-08 remediation (stale-binding detection) is what allowed the rebuilt
  suite to run cleanly four consecutive times — the test-isolation work directly
  enabled this verification.

### Post-build notification check (independent verification of the artifact)

The background build process reported `BUILD_EXIT=0` after the copy to
`dist/setup.exe` had already happened, so the copy could theoretically have
captured a partial file. Checked explicitly:

```
build output   sha256 95d2fdb6…  114,156,475 bytes
dist/setup.exe sha256 95d2fdb6…  114,156,475 bytes
-> MATCH, and the .blockmap was present, so the copy was of the FINAL file
```

No partial-copy hazard. `verify-installer.js` re-run after the notification:
`VERIFY-PASS`, same hash.

### IMPORTANT: the installer is NOT signed, despite what the build log implies

The build log contains the line `signing with signtool.exe` for the exe, the
uninstaller and `elevate.exe`. That reads as a successful signature but is not
one. Verified with the platform's own verifier:

```powershell
Get-AuthenticodeSignature dist\setup.exe
  Status  : NotSigned
  Subject :
```

`electron/signing-config.js` reports
`No signing credentials - building UNSIGNED development installer. Not for release.`

**So `dist/setup.exe` is an UNSIGNED development build.** It carries the E-01
JWT fix and is correct in content, but it must not be described as signed or
shipped to customers as-is. Windows SmartScreen will warn, and the project's own
`REQUIRE_SIGNING` release gate is what legitimately blocks release — that gate was
not bypassed here.

`package.json` declares no `forceCodeSigning`, so electron-builder continued
past the missing certificate rather than failing the build. Raising that is a
small, safe hardening step once a real certificate exists, and is left for the
signing task rather than done here.

### E-10 — Unsigned installer: the guard existed but never fired (FIXED)

Re-investigating the signing configuration found a worse problem than "no
certificate": **the production build was incapable of failing.**

#### Root cause

`electron/signing-config.js` is correct — it throws when `REQUIRE_SIGNING=1` and
credentials are absent, and I verified that directly:

```
REQUIRE_SIGNING=1, no creds  ->  exit 1  FATAL: credentials are missing
REQUIRE_SIGNING=1 + pfx       ->  exit 0  Code signing enabled
no flag, no creds             ->  exit 0  UNSIGNED development installer
```

But **nothing ever set the flag.** The npm script was:

```
electron:build:prod = node electron/signing-config.js && electron-builder --win nsis --publish never
```

51 `REQUIRE_SIGNING` references were audited across the repo; **none in
`package.json`**. So on a clean machine the gate observed an unset flag, printed
"UNSIGNED development installer", and **exited 0** — and because
`build.win.forceCodeSigning` was absent, electron-builder packaged happily and
reported `BUILD_EXIT=0`. The script named `electron:build:prod` produced an
unsigned installer and still reported success. The documented behaviour in
`signing-config.js` ("`electron:build:prod` sets REQUIRE_SIGNING=1 … the build
fails") did not match reality.

#### The trust question was also checked, not assumed

The Windows store contains a code-signing certificate
(`CN=ContactBridge Systems`), so a real signature was possible on this host. It
was rejected as a production certificate:

```
Subject == Issuer        : True   (self-signed)
chain status             : UntrustedRoot — "terminated in a root certificate
                           which is not trusted by the trust provider"
```

Using it would have produced a technically-signed but publicly-untrusted
installer, and reporting that as "signed" is the exact failure mode this
project must avoid. **The release is therefore still blocked, correctly.**

#### Pipeline capability proven in a disposable test environment

A throwaway self-signed certificate was created in a temp directory, used to
build, and destroyed. It was deliberately **not** installed into any trusted
root store.

```
forceCodeSigning=true, CSC_LINK=<temp pfx>  ->  build succeeds
Get-AuthenticodeSignature on the result:
  Status      : UnknownError   (UntrustedRoot)
  Subject     : CN=BlackStack CRM TEST ONLY, O=Disposable, C=US
  Issuer      : same (self-signed)
  TimeStamper : CN=DigiCert SHA256 RSA4096 Timestamp Responder 2026 1
```

So the pipeline **does** sign, and **does** timestamp against DigiCert. Only the
trust anchor is missing, which is exactly what a purchased CA certificate
supplies. Signing works; the certificate is the blocker, not the code.

#### Changes

| File | Change |
|---|---|
| `scripts/require-signing.js` | **NEW.** Arms `REQUIRE_SIGNING=1` in-process, requires credentials, and independently requires `win.forceCodeSigning`. Exits non-zero on any missing precondition. |
| `package.json` → `electron:build:prod` | now runs the arming wrapper before electron-builder |
| `package.json` → `build.win.forceCodeSigning` | `true` — a signing failure is now fatal instead of a log line |
| `scripts/release-gate.js` | **new gate 10** verifies the built artifact's Authenticode status |
| `scripts/release-gate.js` → `record()` | three-state verdict: PASS / FAIL / SKIP, with SKIP **never** counted as passed |
| `tests/e2e10-signing-gate.test.js` | **NEW (7 tests)** |

`cross-env` was deliberately **not** used: it is not a dependency of this
project, and adding a build-time dependency is worse than setting an env var
with Node's own standard library. The unsigned *development* path
(`electron:build:win`) is unchanged.

#### Gate 10 verified against both cases

```
dist/setup.exe      (unsigned)   -> Status=NotSigned    -> FAIL - blocked
dist-signtest/*.exe (self-signed)-> Status=UnknownError -> FAIL - blocked
```

A genuine CA certificate is the only thing that can turn gate 10 green. A
self-signed certificate correctly cannot.

#### The gate suite now correctly refuses to pass

```
[PASS] gate 1 … [PASS] gate 9 ×4        16 gates still green
[FAIL] gate 10: release artifact Authenticode signature  Status=NotSigned — NOT releasable

16/17 gates passed
RELEASE GATE: FAIL
```

**This is a deliberate regression in the reported number.** The previous
"16/16 PASS" was produced while shipping an unsigned installer. `RELEASE GATE:
FAIL` is the honest result and is the intended state until a certificate exists.

Full regression after these changes: **605 tests / 29 files / 0 skipped**
(baseline 569/25). Production fingerprint `5a0215eb…` unchanged.

### Release status after E-10

| Condition | State |
|---|---|
| Signing pipeline works end to end | **Proven** (signs + timestamps) |
| Production gate is armed and blocks | **Proven** (gate 10 → FAIL) |
| Genuine CA certificate | **MISSING — hard blocker** |
| `dist/setup.exe` | **Unsigned. Not for customer distribution.** |
| Release gate | **FAIL — by design, correctly** |

Remaining blockers, all requiring input I do not have:

1. **Purchase an Authenticode code-signing certificate** (`CSC_LINK`,
   `CSC_KEY_PASSWORD`). Only this clears gate 10.
2. `git init` authorisation — no history exists, so no bad migration is
   reversible.
3. Permission to install over the live v1.0.1, or to uninstall it first
   (preflight reports `PROTECTED`).
4. Install/update/rollback verification in a disposable environment (not yet
   performed — it must not touch the live installation).

### CORRECTION — the first E-10 hardening broke the developer workflow

I wrote that the unsigned development path was left unchanged. **That was false,
and testing caught it.**

Setting `build.win.forceCodeSigning = true` in `package.json` looked like the
obvious place to make signing mandatory. It is the wrong layer: `build.win` is
**shared by every build**, so the flag was inherited by `electron:build:win`
too, and the local unsigned build started failing:

```
signing failed for file, queue will continue to next file
⨯ App is not signed and "forceCodeSigning" is set to true
RESULT: dev build FAILED
```

Hardening that destroys the developer workflow is a regression, not a fix.

**Corrected design — the flag is per-invocation, owned by the release script:**

```
electron:build:prod = node scripts/require-signing.js && electron-builder --win nsis --publish never -c.win.forceCodeSigning=true
electron:build:win  = electron-builder --win nsis --publish never
build.win           = { target: [...], icon: ... }        (no signing key)
```

`require-signing.js` was also changed: it previously read and required
`build.win.forceCodeSigning` from `package.json`, which no longer exists by
design. It now validates only what it can actually see (credentials) and states
plainly that the electron-builder invocation is the authority for the flag.

Verified after the correction:

```
TEST 1  unsigned dev build, no credentials        -> SUCCEEDS (developer workflow intact)
TEST 2  production gate, no credentials           -> exit 1 (still blocks)
TEST 3  production gate, valid pfx                -> exit 0 (arms)
TEST 4  build.win.forceCodeSigning                -> ABSENT (correct)
        prod script carries -c flag               -> true
        dev script carries signing flag           -> no (correct)
```

`tests/e2e10-signing-gate.test.js` now pins both halves with an explicit
regression test named for this failure, so the mistake cannot recur silently.

### Gate 8 transient FAIL — investigated, not a code defect

One full gate run reported:

```
[FAIL] gate 8: reverse-order E2E (order independence)  exit 1
```

Investigated rather than assumed:

- The gate suite had been started in the foreground and the tool call hit its
  420-second ceiling mid-flight, so the run was killed while gate 8 was
  executing.
- Re-running gate 8's exact command standalone: `7 passed (1.6m)`, exit 0.

So gate 8 is not broken; the earlier FAIL was my interrupted run. Re-running the
whole suite uninterrupted is the only honest confirmation, and it is reported
below rather than asserting the earlier result was valid.

### Final regression state

```
vitest            : 606 tests / 29 files / 0 skipped    EXIT=0
release gates     : gate 10 FAIL (correct — unsigned artifact)
                    all other gates PASS
production fp     : 5a0215eb… unchanged
```

### SIGNING DEEP AUDIT — the report's own claim was not yet proven

The report stated "the signing pipeline works; only the certificate is
missing." That sentence rested on a green build log and a DigiCert timestamp,
neither of which proves a signature exists. Re-auditing separated three
questions that had been conflated.

**Q1 — CONFIGURATION** (read from source, all checks OK)

```
[OK] prod script arms the signing gate
[OK] prod gate runs BEFORE electron-builder
[OK] prod passes forceCodeSigning
[OK] dev build is NOT forced to sign
[OK] dev build needs no credentials
[OK] shared build.win has NO forceCodeSigning (would break dev)
[OK] uninstall preserves user data (deleteAppDataOnUninstall=false)
[OK] signing-config.js still fail-closed
[OK] credential contract documented
[OK] no private keys / literal signing passwords in repo
```

The `-c.win.forceCodeSigning=true` form I introduced was verified empirically
rather than assumed: with it, an unsigned build **fails** with
`App is not signed and "forceCodeSigning" is set to true`; without it, the same
build succeeds. electron-builder honours the short form — it is not silently
ignored.

**Q2 — MECHANICAL** (does a real signature appear?)

```
build exit    : 0
installer     status=UnknownError  timestamp=yes  signed=YES
app exe       status=UnknownError  timestamp=yes  signed=YES
```

Both binaries carry an Authenticode signature and an RFC-3161 timestamp.
`UnknownError` rather than `Valid` is the expected result for a self-signed
certificate — it is the *trust* verdict, not the *signature* verdict.

**Q3 — TRUST** — **deliberately recorded as UNANSWERABLE.** A self-signed
certificate can never reach `Status=Valid`. Asserting otherwise would be false;
this question requires a purchased CA certificate.

### Gate 10 was itself broken — four defects found and fixed

Reviewing the gate rather than trusting it exposed a verification that
**reported a result while checking nothing**:

| # | Defect | Consequence | Fix |
|---|---|---|---|
| 1 | Checked only the installer | the shipped app `.exe` and uninstaller were never verified | all releasable binaries checked |
| 2 | Printed the signer but never compared it | **any** trusted certificate would have passed, including one issued to another company | `RELEASE_EXPECTED_SUBJECT` pins the identity |
| 3 | No timestamp requirement | a signature would die with the certificate | timestamp is mandatory |
| 4 | Path passed into a PowerShell string | broke on quote characters | see below |

**The silent-failure chain (defect 4) is the serious one.** The path was handed
to PowerShell four different ways and **all four were wrong**:

1. `powershell -Command "... $args[0] ..."` → `$args` arrives **empty**
2. interpolating the path into the `-Command` string → breaks on quotes
3. `execFileSync(..., {shell:false})` → the MSYS layer rewrote the path to
   `D:WorkProjects...v2distsetup.exe` — separators eaten, before PowerShell saw it
4. manually quoting the argument → same mangling

In every case PowerShell reported `Illegal characters in path`, **no `STATUS`
line was returned**, and the gate fell through to the unsigned branch. Without
`$ErrorActionPreference='Stop'` the error went to stderr and execution
continued. A security gate that cannot read its input must never look like one
that did.

**Fix:** the path now travels in an environment variable
(`BSCRM_SIG_TARGET`) — the only channel this toolchain passes through verbatim —
and every path is `path.resolve`d to native Windows form first, because this
repository's own path contains spaces (`CB CRM V2`). Verified end to end:

```
[FAIL] gate 10: release artifact Authenticode signature
       3 artifact(s): dist\setup.exe: Status=NotSigned (TS=no)
                     | dist\win-unpacked\BlackStack CRM.exe: Status=NotSigned (TS=no)
16/17 gates passed   RELEASE GATE: FAIL
```

The gate now reports the **true** reason. Before, it was failing for the wrong
one.

### One more false conclusion of mine, corrected

The audit script reported `uninstaller MISSING` and I initially read that as an
unsigned shipped binary. **Wrong.** The same build's log shows:

```
signing with signtool.exe  path=dist-setup-jwt\BlackStack CRM Setup 1.0.0.__uninstaller.exe
```

The uninstaller **is** signed; my script had hard-coded a path instead of
searching for it. It now locates the file, and a binary a build genuinely does
not produce is reported as "not produced" rather than as a failure.

### Audit-script false positive, also corrected

The credential scanner flagged
`docs/audits/phase-2-update-system-production-setup-2026-10-07.md` as containing
a private key. It is the phrase `grep for BEGIN PRIVATE KEY` inside a report
about not committing keys — prose, not a key. The detector now requires the
marker to own its line and be followed by real base64, and markdown files are
excluded.
