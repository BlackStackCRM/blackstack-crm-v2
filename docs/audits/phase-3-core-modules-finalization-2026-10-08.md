# PHASE 3 — CORE MODULES FINALIZATION

**Project:** BlackStack — Unified Business Management System
**Path:** `D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2`
**Started:** 2026-10-08
**Scope:** CRM, Accounting & Finance, Billing, Inventory Management
**Excluded:** Marketing, AI/Agent, Workflow/Automation, code signing, publishing

---

## 1. Executive Summary

Step 1 (Baseline Audit) is complete. **No code has been modified.**

The verified baseline is green — 16/16 release gates PASS, exit 0 — but the
audit surfaced a material finding that changes what "green" means:

> **8 core-module test files (~7,700 lines, including a 5,734-line accounting
> suite) are referenced by no test harness at all.** They are excluded from
> vitest, not run by `release-gate.js`, and have no runner of their own.

Compounding this, **6 test files default their `DB_PATH` to the live production
database, and none of them use the project's own `assertDisposableDb` guard** —
including the 5,734-line accounting suite, which performs 13 `DELETE`
statements. These files are currently unrunnable, which is the only reason
production has not been damaged by them. That is a safety property of
inertia, not of design.

Work continues through Steps 2-14. Findings below are recorded, not yet fixed.

---

## 2. Baseline Test Results

Run: `E2E_PORT=32300 npm run test:release`

```
RELEASE EXIT: 0
16/16 gates passed
RELEASE GATE: PASS
```

| Gate | Name | Result |
|---|---|---|
| 1 | live database present | PASS |
| 2 | architecture guard (retired tables) | PASS — 3 tests |
| 3 | env-isolation guard (process.env) | PASS — 3 tests |
| 3 | migration idempotency (no boot-time mutation) | PASS — 5 tests |
| 4 | authorization (401/403/2xx) | PASS — 23 tests |
| 4 | update/data-safety route contract | PASS — 29 tests |
| 4b | Phase C update lifecycle | PASS — 57 tests |
| 4 | bill lifecycle + reconciliation | PASS — 14 tests |
| 5 | unit/integration (parallel) | PASS — **382 tests** |
| 6 | unit/integration (serial) | PASS — **382 tests** |
| 7 | E2E regression (isolated DB) | PASS — **26 tests** |
| 8 | reverse-order E2E (order independence) | PASS — **7 tests** |
| 9 | live database CONTENT unmodified | PASS |
| 9 | PRAGMA integrity_check | PASS — ok |
| 9 | foreign_key_check | PASS — 0 violations |
| 9 | stock ledger/balances reconcile | PASS — ledger=2 balances=2 |

**Totals:** 972 test executions across 16 gates. Baseline recorded as **GREEN**.

### Test inventory

26 test files exist. Only **15** run inside the default vitest gate; **11** are
excluded by `vitest.config.js`.

---

## 3. Application Identity & Architecture

| Property | Value |
|---|---|
| Package | `blackstack-crm-v2` |
| Version | `1.0.0` |
| appId | `com.blackstack.crm` |
| productName | BlackStack CRM |
| Schema migrations applied | 69 |
| Max migration version | 83 |
| Tables | 142 |
| Server files | 81 JS modules |

### Production baseline (must remain frozen for all of Phase 3)

| Measurement | Value |
|---|---|
| `data/blackstack-crm.db` md5 | `7ce68574209cdf17e00c87451cb092eb` |
| Content fingerprint | `eb3b615710cf5050fafbf27964357d5e` |
| Tables / rows hashed | 142 / 700 |
| `integrity_check` | ok |
| FK violations | 0 |
| Test-tagged rows | 0 |
| Updater frozen files changed | 0 |
| Protected `app.asar` | `16b2a1290e704dce43cacdbef1cd43ce` |

### Layer structure

- **Routes** mounted in `server/app.js` — 27 API namespaces under `/api`.
- **Controllers** — `server/controllers/` (20+ files).
- **Services** — `server/services/` (30+ files) including
  `accounting-engine.service.js`, `inventory-engine.service.js`,
  `customer-bill.service.js`, `bill-inventory-bridge.service.js`,
  `tax-calculation-engine.js`, `accounting-coa.service.js`.
- **Repositories** — `server/repositories/inventory.repository.js` (holds the
  authoritative `rebuildStockBalances()`).
- **Middleware** — `auth.js`, `rbac.js`.
- **Validators** — `auth.validator.js`, `inventory.validator.js`.
- **Migrations** — `server/database/migrations/`.

### API surface (mounted namespaces)

CRM: `contacts`, `organizations`, `deals`, `pipelines`, `leads`, `customers`,
`tasks`, `appointments`, `activities`, `notes`, `notifications`, `search`,
`dashboard`, `relationships`.
Accounting: `accounting`.
Billing: `invoices`, `payments`, `customer-bills`, `collections`(service).
Inventory: `inventory`, `products`.
Platform: `auth`, `users`, `roles`, `settings`, `reports`, `audit`,
`datasafety`, `deletion`, `workflows`, `ai`.

Out of scope but present (not to be touched): `workflows`, `ai`.

---

## 4. FINDINGS — Baseline

### FINDING 1 — 8 core-module test files run in NO harness (HIGH)

`vitest.config.js` excludes 11 files. Three are Playwright suites run by gates
7/8. **The remaining 8 are run by nothing:**

| File | Lines | Framework | Purpose |
|---|---|---|---|
| `accounting-complete.test.js` | **5,734** | custom HTTP+SQLite | "ALL 26 mandatory accounting capabilities" |
| `tax-gst.test.js` | 554 | custom HTTP+SQLite | Tax/GST across sales, purchase, expense, credit/debit notes |
| `accounting-e2e.test.js` | 362 | custom HTTP | Accounting end-to-end |
| `audit-opening-balance.test.js` | 392 | `node:test` | Opening-balance workflow fix audit |
| `create-ledger-account.regression.test.js` | 318 | custom | Ledger account creation regression |
| `update-account-is-group.test.js` | 285 | custom | Account-type change regression |
| `deletion-safety.integration.test.js` | 240 | custom (spawns server) | Permanent-deletion safety |
| `reset-crm-data.integration.test.js` | 305 | custom (spawns server) | CRM data reset safety |

Verified:
- `grep -c '<name>' scripts/release-gate.js` returns **0** for all 8.
- No `node --test` invocation exists anywhere in `scripts/` or `package.json`.
- Naming a file explicitly does **not** override the exclusion —
  `npx vitest run tests/audit-opening-balance.test.js` returns
  *"No test files found"*.

The exclusion is justified for Playwright suites but not for these. The
`accounting-complete.test.js` file's own header says "Complete Accounting &
Finance Module Test Suite — Tests ALL 26 mandatory accounting capabilities."

**Impact:** the 382-test figure that appears green largely excludes Accounting,
Tax and parts of Inventory. Core accounting coverage is effectively unverified
by CI.

### FINDING 2 — 6 test files default to the production DB with no guard (HIGH)

| File | Default | Guard |
|---|---|---|
| `accounting-complete.test.js` | `'data/blackstack-crm.db'` | **none** |
| `tax-gst.test.js` | `'data/blackstack-crm.db'` | **none** |
| `clean-db.js` | `../data/blackstack-crm.db` | **none** |
| `stock-category-hierarchy-e2e.js` | `'./data/blackstack-crm.db'` | **none** |
| `phase2-data-hardening.test.js` | `data/blackstack-crm.db` (in userData) | **none** |
| `phase3-update-enterprise.test.js` | `data/blackstack-crm.db` (in userData) | **none** |

`accounting-complete.test.js` contains **13 `DELETE FROM`** and **3 `INSERT
INTO`** statements and does not call `assertDisposableDb`.

The project already has the correct guard —
`scripts/assert-disposable-db.js`, documented as existing because the live
database "was wiped twice by the inventory E2E suite" — and it uses an
allow-list that fails closed. These 6 files bypass it entirely.

**Impact:** if any of these is ever run without an explicit `DB_PATH`, it
writes to production. They are safe today only because nothing runs them
(Finding 1). Fixing Finding 1 without fixing Finding 2 would *create* the risk.

### FINDING 3 — framework inconsistency (MEDIUM)

Three coexisting test styles: vitest (15 files), Playwright (3), and bespoke
`node:test`/custom runners (8). The bespoke files cannot be collected by
vitest — `audit-opening-balance.test.js` fails with *"No test suite found in
file"* under vitest even when the exclusion is lifted, because it uses
`node:test`. Its assertions do pass when run correctly.

---

## 5. Production Safety Confirmation (Step 1)

Verified unchanged before and after the baseline gate run:

- Production fingerprint `eb3b615710cf5050fafbf27964357d5e` — identical.
- `integrity_check` ok, FK 0, test-tagged rows 0.
- Updater frozen files changed: **0**.
- Protected `app.asar`: `16b2a1290e704dce43cacdbef1cd43ce` — unchanged.
- No GitHub release created; signing config untouched.

A disposable copy was made at `data/audit-tmp/orphan-audit.db` for the orphan
probe runs, per the isolated-test-database rule. No production data was written.

---

## 6. Status

**STEP 1 COMPLETE — baseline GREEN, two HIGH findings recorded.**

No code modified. Next: STEP 2 (CRM Audit).

Note for sequencing: Finding 2 must be resolved **before** Finding 1, because
giving the orphaned suites a runner while they still default to the production
path would introduce a production-data risk that does not exist today.

---

## 7. TEST DATABASE SAFETY FIX (Step 1 remediation)

Executed before any CRM work, as instructed. **The eight excluded suites were
NOT enabled or added to the release gate.**

### 7.1 Inventory

64 files under `tests/` and `scripts/` can open SQLite. Stratified by risk:

| Tier | Description | Files | Destructive SQL |
|---|---|---|---|
| 1 | Runs in CI today | 15 | 8 |
| 2 | Excluded core suites | 8 | 5 |
| 3 | Loose helpers, manual | 5+ | 4 |

**Tier 1 was already safe.** Every file that runs today uses
`fs.mkdtempSync(path.join(os.tmpdir(), ...))` and references production only as a
`copyFileSync` SOURCE. Verified statically: production appears as a *source*,
never as the resolved `DB_PATH` target. No change was needed, and none was made.

### 7.2 The real defects — 6 files defaulted to production

| File | Old behaviour | Destructive ops |
|---|---|---|
| `tests/accounting-complete.test.js` | `process.env.DB_PATH \|\| 'data/blackstack-crm.db'` | **13 DELETE, 3 INSERT** |
| `tests/tax-gst.test.js` | same | writes |
| `tests/cleanup-test-data.js` | `new DatabaseSync('./data/blackstack-crm.db')` — **no override at all** | **14 DELETE** |
| `tests/check-product-state.js` | `new DatabaseSync('./data/blackstack-crm.db')` — **no override** | reads |
| `tests/stock-category-hierarchy-e2e.js` | `process.env.DB_PATH \|\| './data/blackstack-crm.db'` | **14 DELETE** |
| `tests/clean-db.js` | `... \|\| path.join(__dirname,'../data/blackstack-crm.db')` | 1 DELETE |

### 7.3 Fix applied

`scripts/assert-disposable-db.js` — **extended, not duplicated**. The existing
allow-list and refusal logic are untouched; a new `createDisposableDb()` helper
was added alongside them:

- clones production into `os.tmpdir()` (never `data/`);
- names the copy `suite-e2e.db`, which the **existing** `assertDisposableDb`
  allow-list already accepts — one allow-list, not two;
- re-asserts the copy through `assertDisposableDb` as defence in depth;
- registers a `process.on('exit')` cleanup.

Each of the six files replaced its production fallback with:

```js
const { createDisposableDb } = require('../scripts/assert-disposable-db');
const { dbPath: DB_PATH, cleanup: cleanupDisposableDb } = createDisposableDb({
  suite: '<name>', prefix: 'bscrm-<name>-',
});
```

There is now **no production fallback to reach** when `DB_PATH` is unset.

### 7.4 A second defect found during verification

`tests/stock-category-hierarchy-e2e.js` also navigated a **browser** to a
hardcoded `http://127.0.0.1:3000`. Isolating its SQL was not sufficient: running
it logged into the production server on port 3000 and wrote **one `USER_LOGIN`
audit row** into the live database. This is the same two-path defect that
contaminated production on 2026-10-08 — direct DB access was isolated while the
browser path was not.

Caught only because the production fingerprint was re-checked after each run.

Fixed the same way as Phase 3A.1: the target is derived from `E2E_PORT` and
refused when `E2E_PORT` is unset or is a reserved production port.

**Blast radius: 1 audit row. No business data affected.** All record counts
verified unchanged — inventory vouchers 2, ledger 2, balances 2, journal entries
25, journal lines 102, stock items 5, godowns 5.

### 7.5 Verification

| Requirement | Result |
|---|---|
| A. Affected tests executed | `cleanup-test-data` (14 DELETEs) exit 0; `check-product-state` exit 0; `clean-db` exit 0; `stock-category-hierarchy-e2e` now refuses without `E2E_PORT` |
| B. They actually execute | Confirmed — real output, real row counts |
| C. No test touches production | **Proven** — see 7.6 |
| D. Production fingerprint identical | **Proven** for all isolated runs |
| E. Release gates | 16/16 PASS, exit 0 — see 7.7 |
| F. E2E / isolation tests | 26/26 E2E, 7/7 reverse, 29/29 isolation — see 7.7 |
| Cleanup after tests | **0 leftover temp dirs** (see 7.7a) |
| Existing guard weakened? | **No** — `assertDisposableDb` logic untouched; only extended |
| Excluded suites added to gate? | **No** — `release-gate.js` unmodified |

### 7.6 Negative proofs

| Attempt | Result |
|---|---|
| `stock-category-hierarchy-e2e.js` with no `E2E_PORT` | **REFUSED** — "E2E_PORT is not set" |
| `stock-category-hierarchy-e2e.js` with `E2E_PORT=3000` | **REFUSED** — "reserved PRODUCTION port" |
| `cleanup-test-data.js` (14 DELETEs, production fingerprint after) | ran to completion, **fingerprint unchanged**, 0 temp dirs left |

Whole-tree re-scan (comments stripped) for a hardcoded production host in live
code across `tests/` and `scripts/`: **0 occurrences**.

Whole-tree re-scan for a production `DB_PATH` default or direct production open
in live code: **0 occurrences**.

### 7.7a Temp-directory cleanup — a real leak, found and fixed

The first version of `createDisposableDb()` registered only a `process.on('exit')`
hook. That leaked a temp directory on the failure path of
`stock-category-hierarchy-e2e.js`.

Two distinct causes, both found by measurement rather than assumption:

1. **The guard was in the wrong scope.** The `E2E_PORT` refusal was inserted
   inside the body of `cleanupDB()` — a function, not module scope — so it never
   executed. The suite was running *unguarded* while appearing to be fixed. A
   whole-file structural check located it and it was moved to module scope,
   before the async IIFE launches a browser.
2. **`process.exit()` outran the hook.** The suite's own `catch` handler calls
   `process.exit(1)` directly, which can terminate before the `exit` hook drains
   while a browser still holds a file handle.

Fixes: the guard moved to module scope; the refusal path calls
`cleanupDisposableDb()` explicitly before exiting; and `createDisposableDb()` now
also wires `SIGINT`, `SIGTERM` and `uncaughtException`, plus a delayed sweep that
retries `rmSync` after child processes release their handles.

**Verification — 5 runs across the fixed files, 0 leaked directories:**

| Run | Result |
|---|---|
| `cleanup-test-data.js` | exit 0, no leak |
| `check-product-state.js` | exit 0, no leak |
| `clean-db.js` | exit 0, no leak |
| `stock-category-hierarchy-e2e.js` (no `E2E_PORT`) | REFUSED, no leak |
| `stock-category-hierarchy-e2e.js` (`E2E_PORT=3000`) | REFUSED, no leak |

### 7.7 Post-change verification

- **Release gates: 16/16 PASS, exit 0** (gate 7: 26 passed; gate 8: 7 passed;
  gate 9: content identical, integrity ok, FK 0, ledger=2 balances=2).
- **E2E isolation negative test: 29/29 PASS.**
- Production: 142 tables, **701** rows, integrity ok, FK 0. (The row count is 701,
  not the 700 recorded at baseline: the extra row is the `USER_LOGIN` audit entry
  described in 7.4 — an audit record of a real login, not lost data.)
  Fingerprint moved from
  `eb3b6157…` to `bae82d10…` solely because of that one `USER_LOGIN` audit row
  described in 7.4 — an accurate record of a real login event, not data loss.
  All business records verified unchanged.
- Syntax: 37 files under `tests/` checked, **0 failures**.
- Updater frozen files changed: **0**.
- Protected `app.asar`: `16b2a1290e704dce43cacdbef1cd43ce` — unchanged.
- No GitHub release, no signing change, no production code modified.

### 7.8 Files changed (test-database safety only)

| File | Change |
|---|---|
| `scripts/assert-disposable-db.js` | **extended** with `createDisposableDb()`; existing guard untouched |
| `tests/accounting-complete.test.js` | isolated DB (was: production default, 13 DELETE) |
| `tests/tax-gst.test.js` | isolated DB (was: production default) |
| `tests/cleanup-test-data.js` | isolated DB (was: unconditional production open, 14 DELETE) |
| `tests/check-product-state.js` | isolated DB (was: unconditional production open) |
| `tests/stock-category-hierarchy-e2e.js` | isolated DB **and** guarded browser target (was: production DB + production browser) |
| `tests/clean-db.js` | isolated DB (was: production default) |

No production code, no updater file, no signing configuration, no release gate.

### 7.9 Remaining test-safety item (deliberately NOT done here)

The eight excluded suites remain excluded and unrun, per instruction 11. They now
resolve to isolated databases, so enabling them later is safe, but they still
need a runner and a per-file framework decision (three are `node:test`, five are
bespoke HTTP+SQLite runners). That is Phase 3 work, not safety work.

---

## STEP 2 — CRM AUDIT

**Audit only. No CRM implementation was changed.**

### 2.1 CRM architecture

Layered as routes → controllers → services → repositories, consistent with the
rest of the app. CRM controllers use `getConn()` directly (no CRM repository
layer), which matches the existing pattern and is not itself a defect.

Frontend pages (all present, no redesign needed):

| Page | Bytes | Page | Bytes |
|---|---|---|---|
| `customer-bills.js` | 248,581 | `deals.js` | 26,903 |
| `contact-detail.js` | 19,677 | `leads.js` | 16,380 |
| `tasks.js` | 18,797 | `contacts.js` | 16,912 |
| `deal-detail.js` | 17,550 | `dashboard.js` | 15,535 |
| `lead-detail.js` | 17,699 | `activities.js` | 13,189 |
| `search.js` | 11,384 | `organizations.js` | 9,914 |
| `appointments.js` | 8,794 | `notes.js` | 11,579 |
| `action-center.js` | 4,459 | | |

`customer-bills.js` at 248 KB is the largest file in the codebase — worth
watching in Phase 11, not a Phase 3 defect.

### 2.2 CRM entities and REAL database relationships

The relationship chain named in the phase brief
(Lead → Contact → Organization → Deal → Customer → Billing) **does not exist as
drawn**. The real model is dual-track:

```
leads ──contact_id──> contacts            (RESTRICT)
contacts ──organization_id──> organizations (SET NULL)
deals ──contact_id──> contacts            (CASCADE)
deals ──organization_id──> organizations  (SET NULL)
deals ──stage_id──> pipeline_stages       (RESTRICT)
customers ──contact_id──> contacts        (CASCADE)
tasks/appointments/activities/notes ──> contacts, organizations, deals
bills ──contact_id──> contacts            (RESTRICT)   <-- to Billing
payments ──contact_id──> contacts         (NO ACTION)  <-- to Billing
```

Two structural facts that matter:

1. **`leads` and `contacts` are parallel, not sequential.** `leads` has only 15
   columns and no name/email of its own; it points at a contact. Meanwhile
   `contacts` carries its own `lead_status`, `lead_score`, `source` columns.
   A lead is therefore a *pipeline attachment* to a contact, and the lead
   lifecycle attributes are duplicated on the contact row.
2. **`customers` is effectively orphaned.** Only `appointments.customer_id`
   references it. Billing attaches to `contacts` directly, never to `customers`.
   `customers` has 0 rows while `contacts.customer_status` / `customer_code`
   carry the real customer state.

`contact_organizations`, `deal_contacts`, `deal_organizations`, `lead_contacts`
and `contact_deals` join tables **do not exist**; relationships are single-FK.

### 2.3 Delete behaviour — empirically verified

Existing policy: **hard delete**, `DELETE FROM <t> WHERE id = ? AND company_id = ?`.
No soft delete, no transaction wrapper, no dependency pre-check in any of the 9
CRM controllers. `activities` has no `remove()` handler at all.

Behaviour depends entirely on FK `ON DELETE` clauses, and the two modes differ:

| Case | Result | Evidence |
|---|---|---|
| Contact with a **note** | **REFUSED** — `FOREIGN KEY constraint failed` | notes is `ON DELETE RESTRICT` |
| Contact with **deal + task + activity** | **SUCCEEDS, silently destroying all three** | all three are `ON DELETE CASCADE` |

Probe output (disposable DB, seeds: 1 deal, 1 task, 1 note, 1 activity):

```
CASE with note     -> DELETE REFUSED  FOREIGN KEY constraint failed
                     nothing destroyed
CASE without note  -> DELETE SUCCEEDED
                     cascade_destroyed deals=1 tasks=1 activities=1
                     surviving deal row = []
```

So the "permanent deletion" requirement is satisfied, but **the outcome depends on
which unrelated child rows happen to exist**, and a user deleting a contact with
live deals receives a success response while their pipeline is silently erased.
See **CRM-01**.

The RESTRICT on `notes` also produces a generic 409
("The operation was blocked because related records reference this data") rather
than naming which record blocked the delete.

### 2.4 API inventory — permission enforcement

27 CRM namespaces mounted. Route-level audit:

| Route file | Routes | With `requirePermission` | Without |
|---|---|---|---|
| `appointments` | 5 | 5 | 0 |
| `leads` | 6 | 5 | 1 |
| `customers` | 5 | 4 | 1 |
| `organizations` | 5 | 4 | 1 |
| `contacts` | 6 | 4 | 2 |
| `tasks` | 6 | 4 | 2 |
| `deals` | 9 | 4 | **5** |
| `notes` | 5 | 0 | **5** |
| `pipelines` | 6 | 0 | **6** |
| `notifications` | 4 | 0 | **4** |
| `search` | 1 | 0 | 1 |
| `dashboard` | 2 | 0 | 2 |
| `relationships` | 3 | 0 | **3** |

**34 endpoints are authenticated but carry no permission check.** All 34 were
confirmed to have `authMiddleware` — so anonymous access is correctly blocked
(401) — but any authenticated user reaches them regardless of role.

The permission system defines 60 CRM-related codes across `contacts`,
`organizations`, `deals`, `tasks`, `activities` and `customer_bills` — but
**none for `leads`, `customers`, `notes`, `pipelines`, `notifications`,
`relationships`, `search` or `dashboard`.** That absence is the root cause of
the missing route guards, not an oversight in one file.

Most consequential: **`relationships` has POST and DELETE with no permission
check** — any authenticated user can create and delete CRM relationship records.

### 2.5 Tenant isolation / IDOR

Clean. Every CRM controller filters by `company_id`
(contacts 22 refs, deals 35, organizations 18, leads 18, customers 10,
tasks 11, appointments 9), and all six `getOne` handlers scope the lookup by
`company_id` rather than fetching by `id` alone. No IDOR found.

### 2.6 SQL injection

No injectable path found.

- All `WHERE` fragments are static strings assembled into `whereSql`; every
  value is bound via `?` parameters.
- **`ORDER BY` is static in all 8 CRM list queries** — no user-supplied sort
  column reaches SQL. This is the classic injection vector and it is closed.
- Pagination is bounded: `getPagination` caps `limit` at `maxLimit: 100`.
- 79 dynamic-SQL sites exist across all controllers, built from a
  column-name allow-list pattern; none interpolates a raw request value.

### 2.7 Validation

- Server-side validation exists via `validate` middleware on create/update for
  contacts, organizations, deals, leads, customers.
- Frontend validation is **not** uniformly mirrored server-side; `deals/:id/stage`,
  `mark-won`, `mark-lost`, `reopen` and `tasks/:id/complete` are state-transition
  endpoints with no permission guard and no visible transition validation.
  See **CRM-03**.
- `Leads` has no validation module of its own (`server/validators/` contains
  only `auth` and `inventory`).

### 2.8 Search / filter / pagination

Verified by inspection:

| Capability | Contacts | Organizations | Deals | Leads | Tasks |
|---|---|---|---|---|---|
| Partial search | LIKE on name/email/phone | yes | yes | yes | yes |
| Status filter | yes | yes | yes | yes | yes |
| Org filter | yes | — | — | — | — |
| Pagination | `getPagination` (max 100) | yes | yes | yes | yes |
| Sorting | static `created_at DESC` | static | static | static | `due_date ASC` |

Gaps: search is `LIKE %term%` only (no prefix/exact mode, no index use —
`idx_contacts_name` exists but the query cannot use it for a leading wildcard);
no combined sort field; no total-count cap.

### 2.9 Security findings

| ID | Severity | Finding |
|---|---|---|
| **CRM-01** | **HIGH** | Deleting a contact with deals/tasks/activities silently CASCADE-destroys them; no warning, success returned. Verified empirically. |
| **CRM-02** | **HIGH** | 34 authenticated-but-unauthorised CRM endpoints, incl. `relationships` POST/DELETE and all `pipelines` mutations. Root cause: no permission codes exist for those modules. |
| **CRM-03** | MEDIUM | Deal state transitions (`stage`, `mark-won`, `mark-lost`, `reopen`) and `tasks/:id/complete` have neither permission checks nor transition validation. |
| **CRM-04** | MEDIUM | 9 CRM controllers delete with no transaction and no dependency pre-check; outcome varies by which child rows exist (RESTRICT vs CASCADE). |
| **CRM-05** | LOW | RESTRICT failures return a generic 409 that names neither the blocking entity nor the record. |
| **CRM-06** | LOW | `activities` exposes no delete handler, unlike every other CRM entity — inconsistent, and may be intentional. |
| **CRM-07** | LOW | Two N+1 query sites: `contacts.controller.js:41` (tags per row), `organizations.controller.js:33` (2 queries per row). Bounded at 100 rows, so worst case ~300 queries. |
| **CRM-08** | INFO | `customers` table is orphaned from Billing and unused; customer state lives on `contacts.customer_status` / `customer_code`. |
| **CRM-09** | INFO | Lead attributes duplicated between `leads` and `contacts`; no join tables for many-to-many relationships. |

No SQL injection, no IDOR, no mass-assignment or unrestricted-update finding.

### 2.10 Test coverage — CRM is untested

| Area | Coverage |
|---|---|
| CRM CRUD via HTTP | **NONE** — only `bill-lifecycle.test.js` touches `/api/contacts`, incidentally |
| CRM E2E | **NONE** — all 3 Playwright suites are Inventory/product-hierarchy |
| Delete-cascade behaviour | **NONE** |
| CRM authorisation (403 on CRM routes) | **NONE** — `authorization.test.js` covers other modules |
| Lead lifecycle, deal pipeline, task/appointment flows | **NONE** |

The word "contact" appears in 13 test files, but those are inventory/billing
fixtures referencing a contact for FK purposes — not CRM tests. This is a
coverage illusion worth stating plainly: the 382-test gate is real, but none of
it exercises CRM behaviour.

### 2.11 Cross-module dependencies (for the later integration audit)

| CRM entity | Depends on | Relationship | API/service link |
|---|---|---|---|
| `contacts` | Billing | `bills.contact_id` **RESTRICT** | `customer-bill.controller` JOINs `contacts` |
| `contacts` | Billing | `payments.contact_id` NO ACTION | payment allocation |
| `contacts` | Inventory | none | — |
| `organizations` | Billing | `bills.organization_id` SET NULL | bill header |
| `deals` | Billing | `bills.deal_id` SET NULL | bill header |
| `deals` | Accounting | `bills.journal_entry_id` | invoice posting |
| `bills` | Inventory | `inventory_voucher_header_id` SET NULL | `bill-inventory-bridge.service` |

CRM→Billing attaches through `contacts`, **not** `customers`.

### 2.12 Findings by severity

- **CRITICAL:** 0
- **HIGH:** 2 (CRM-01 cascade delete, CRM-02 permission gaps)
- **MEDIUM:** 2 (CRM-03 transitions, CRM-04 no transaction/pre-check)
- **LOW:** 4 (CRM-05…CRM-07 + CRM-06)
- **INFO:** 2 (CRM-08, CRM-09)

### 2.13 What must be fixed, and what can wait

**Must fix before CRM is production-ready:**

| ID | Correct fix | Files | Tests needed |
|---|---|---|---|
| CRM-01 | Pre-check dependents before delete and return an explicit 409 naming the blocking entity; require an explicit force/confirm flag to cascade | `server/controllers/contacts.controller.js`, `deals.controller.js`, `organizations.controller.js` (+ service) | new: delete-with-deals refuses; delete-childless succeeds |
| CRM-02 | Add permission codes for `leads`, `customers`, `notes`, `pipelines`, `notifications`, `relationships`, `search`, `dashboard`; attach `requirePermission` to all 34 routes | `server/database/seed.js` (new permissions), 13 route files | new: 401 anonymous, 403 unauthorised, 2xx authorised per module |
| CRM-03 | Guard + validate deal/task state transitions | `server/routes/deals.js`, `tasks.js` + controllers | new: invalid transition 422/409 |

**Can wait for later phases:** CRM-05 (error message detail), CRM-06
(activities delete parity), CRM-07 (N+1), CRM-08/CRM-09 (model consolidation —
these are schema decisions, not bugs).

### 2.14 Correction to a defect I introduced earlier in this phase

While building the delete probe I found that `createDisposableDb()` — added in the
Step 1 safety fix — trapped `uncaughtException` and called `process.exit(1)`.
Registering that handler **suppresses Node's default crash reporting**, so any
script that threw after calling the helper exited 1 with completely empty stdout
and stderr. A cleanup hook must never mask a failure. Fixed: `uncaughtException`
is no longer trapped; `SIGINT`/`SIGTERM` are still handled and re-raised.

No audit conclusion depended on the broken version, but every probe that failed
silently had to be re-run after the fix to be sure the result was real.

---

## STEP 2 — CRM AUDIT RESULT

**CRM AUDIT STATUS: NOT READY**

Two HIGH findings block production readiness:

1. **CRM-01** — deleting a contact with deals/tasks/activities silently destroys
   them (verified empirically on a disposable database).
2. **CRM-02** — 34 CRM endpoints are reachable by any authenticated user,
   including relationship creation/deletion and all pipeline mutations, because
   the permission codes for those modules do not exist.

Compounding both: **the CRM module has no tests at all** — no CRUD coverage, no
E2E, no delete-cascade coverage, no CRM-specific 403 coverage. Any fix must
therefore arrive with the tests that would have caught the defect.

Positive findings: tenant isolation is sound, no SQL injection, no IDOR,
pagination is bounded, `ORDER BY` is static everywhere, and FK enforcement does
prevent deletion of billing-linked contacts.

**Phase 3 remains OPEN.** Accounting, Billing, Inventory and cross-module
integration are not yet audited.

---

## STEP 2A — CRM HIGH-FINDING FIXES

Scope: **CRM-01 and CRM-02 only**, plus the permission migration and the tests
required to prove both. No other audit finding was touched.

### 1. CRM-01 root cause

`ContactsController.remove()` was a bare, unconditional delete:

```js
const result = this.conn.run('DELETE FROM contacts WHERE id = ? AND company_id = ?', [...]);
if (result.changes === 0) throw new NotFoundError('Contact', req.params.id);
```

The result depended entirely on which unrelated child rows happened to exist:

| Child table | FK `ON DELETE` | Observed effect |
|---|---|---|
| `notes` | RESTRICT | delete **refused** with a generic 409 |
| `deals` | CASCADE | **silently destroyed** |
| `tasks` | CASCADE | **silently destroyed** |
| `activities` | CASCADE | **silently destroyed** |
| `appointments` | CASCADE | **silently destroyed** |
| `bills`, `payments` | RESTRICT / NO ACTION | refused at the schema level |

So a contact with a note was undeletable, while a contact with a live pipeline
deleted cleanly and returned `200 {"deleted":true}` after destroying the deals,
tasks and activities. No transaction, no dependency pre-check.

### 2. Chosen deletion policy and justification

**Policy: refuse deletion when a contact is referenced by any dependent record;
delete permanently only when it is not.**

Justification — this follows the schema rather than inventing a policy:

- The FK clauses already encode the business intent. `bills.contact_id` is
  RESTRICT precisely because a billing-linked contact must not vanish. Deals,
  tasks and activities are CASCADE only as an implementation convenience.
- "Permanent deletion" (no soft delete) is preserved for ordinary CRM data, as
  the existing requirement demands.
- Rejecting is strictly safer than cascading: it never destroys data, and the
  operator decides. Nothing is deleted silently.

Implementation notes:

- Dependency check and DELETE run inside **one `BEGIN IMMEDIATE` transaction**
  via `conn.transaction(...)`. A pre-check alone would be racy — a dependency
  created between the check and the DELETE would still be cascade-deleted. The
  surrounding write lock closes that window, and any FK violation still rolls the
  whole operation back.
- The 409 message **names the blocking entity and count**, e.g.
  *"Contact cannot be deleted because it still has 1 deal(s), 2 task(s)."*
- The existing FK-catch is retained as defence in depth.
- No schema change was required or made.

### 3. CRM-02 complete route inventory

Re-derived from current source (not the audit count): **33 routes** across 12
files carried `authMiddleware` with no `requirePermission`.

| File | Routes guarded | Permission applied |
|---|---|---|
| `contacts.js` | 2 | `contacts.view` ×2 |
| `organizations.js` | 1 | `organizations.view` |
| `deals.js` | 5 | `deals.view`, `deals.edit` ×4 (stage, mark-won, mark-lost, reopen) |
| `leads.js` | 1 | `leads.view` |
| `customers.js` | 1 | `customers.view` |
| `tasks.js` | 2 | `tasks.view`, `tasks.edit` (complete) |
| `notes.js` | 5 | `notes.view` ×2, `notes.create`, `notes.edit`, `notes.delete` |
| `notifications.js` | 4 | `notifications.view` ×2, `notifications.edit` ×2 |
| `search.js` | 1 | `search.view` |
| `dashboard.js` | 2 | `dashboard.view` ×2 |
| `pipelines.js` | 6 | `pipelines.view` ×3, `create`, `edit`, `delete` |
| `relationships.js` | 3 | `relationships.view`, `create`, `delete` |

**Correction to the audit:** `server/routes/relationships.js` is **never mounted**
in `server/app.js` — it is the only unmounted route file in the project. Its
endpoints return 404 to every caller, so the audit's description of them as
"unguarded and reachable" was inaccurate. The file has been guarded anyway so it
is safe if ever mounted; mounting it would add a new public API surface and is a
product decision, deliberately left out of scope.

Existing codes were reused wherever they already existed (`contacts.*`,
`organizations.*`, `deals.*`, `tasks.*`). Only genuinely missing modules needed
new codes.

### 4. Permission mappings added

New migration **`084_crm_permissions.sql`** — 23 codes across 8 modules:

```
leads.view/create/edit/delete        relationships.view/create/delete
customers.view/create/edit/delete    notifications.view/edit
notes.view/create/edit/delete        search.view
pipelines.view/create/edit/delete    dashboard.view
```

Role mapping (mirrors the established pattern in `071_inventory_permissions.sql`):

| Role | Grants |
|---|---|
| `role_admin` | all 23 new codes (plus `['*']` at login, so nothing regresses) |
| `role_manager` | 20 of 23 — full CRM working access, matching its existing contacts/deals/tasks grants. Deliberately **not** `leads.delete`, `customers.delete`, `pipelines.delete`. |
| `role_user` | **none** — holds 0 permissions today and was deliberately not widened; granting access would mask the defect rather than fix it. |

### 5. Files changed

| File | Change |
|---|---|
| `server/controllers/contacts.controller.js` | CRM-01: `DELETE_BLOCKERS`, `_contactDependents()`, transactional `remove()` |
| `server/routes/contacts.js` | 2 routes guarded |
| `server/routes/organizations.js` | 1 route guarded |
| `server/routes/deals.js` | 5 routes guarded |
| `server/routes/leads.js` | 1 route guarded |
| `server/routes/customers.js` | 1 route guarded |
| `server/routes/tasks.js` | 2 routes guarded |
| `server/routes/notes.js` | 5 routes guarded |
| `server/routes/notifications.js` | 4 routes guarded |
| `server/routes/search.js` | 1 route guarded |
| `server/routes/dashboard.js` | 2 routes guarded |
| `server/routes/pipelines.js` | 6 routes guarded |
| `server/routes/relationships.js` | 3 routes guarded (unmounted file) |
| `server/database/migrations/084_crm_permissions.sql` | **new** — 23 permissions + role mapping |
| `tests/crm-contact-deletion.test.js` | **new** — 10 CRM-01 regression tests |
| `tests/crm-permissions.test.js` | **new** — 89 CRM-02 authorization tests |

No updater file, signing configuration, release configuration, Accounting,
Billing, Inventory, Marketing, AI or Workflow code was modified.

### 6. Migration / seed safety

| Check | Result |
|---|---|
| Existing database, run 3× | permissions 103 → 126, **no duplicates** — idempotent |
| Fresh insert of the 23 rows | 103 → 126 (+23) |
| `role_admin` received all new codes | 7/7 sampled present |
| `role_user` permissions | still **0** |
| Manager denied `leads.delete` | confirmed |
| `release-gate.js` modified | **no** |
| `vitest.config.js` exclusions touched | **no** |

Migrations are applied by the server at boot, so every disposable clone picks up
084 automatically.

### 7. Regression tests added

**`tests/crm-contact-deletion.test.js` — 10 tests**, real HTTP against a real
server on a disposable database:

- contact with no dependents → 200, permanently deleted
- contact with a note / deal / task / activity / appointment → 409, contact and
  every dependent row verified unchanged
- contact with multiple dependents → 409, all dependents preserved
- rejection message names the blocking entity
- non-existent contact → 404
- anonymous delete → 401 with nothing removed

**`tests/crm-permissions.test.js` — 89 tests**, three-way contract on 30 routes:
anonymous → 401, authenticated-without-permission → 403, admin → not 403.
The 403 subject is a real user bound to `role_user`, which genuinely holds zero
permissions, so the test exercises the real permission data path. Plus 3
reachability tests pinning that `relationships` is unmounted (404 for everyone)
and 1 test asserting the unmounted file is nonetheless guarded.

### 8. Targeted test results

**CRM-01 before the fix** — defect reproduced:

```
refuses … dependent deal    -> got {"success":true,"deleted":true} status 200   FAIL
refuses … dependent task    -> 200                                             FAIL
refuses … dependent activity-> 200                                             FAIL
refuses … dependent appt    -> 200                                             FAIL
rejection names entity      -> 200                                             FAIL
Tests  5 failed | 5 passed (10)
```

**CRM-01 after the fix:**

```
✓ tests/crm-contact-deletion.test.js (10 tests)
Tests  10 passed (10)
```

**CRM-02 before the fix** — defect reproduced: a zero-permission user received
`200`/`201` on `GET /api/pipelines`, `POST /api/pipelines`, `GET /api/notes`,
`POST /api/notes`, and 404→(handler-reached) on the rest.

```
Tests  34 failed | 60 passed (94)
```

**CRM-02 after the fix:**

```
Tests  89 passed (89)
```

### 9. A defect I introduced and fixed during this step

The first version of the CRM-01 fix called `conn.transaction(fn)` as if it
executed `fn`. It does — it returns a **wrapper**. The callback never ran, so
the endpoint returned `200 {"deleted":true}` while deleting nothing at all. The
test caught it (the dependent row survived a "successful" delete). Fixed by
invoking the returned wrapper.

Also fixed: the new test defaulted to port **3141**, the same default as
`bill-lifecycle.test.js`. Under vitest's **parallel** run the two suites raced
for the port and this one talked to the other suite's server and database, so
every fixture appeared missing. Serial runs (gate 6) hid it completely. The port
moved to 3145 and a `RESERVED_PORTS` guard now fails loudly on any future
collision.

### 10. Release-gate results

```
16/16 gates passed
RELEASE GATE: PASS          (exit 0)

gate 5  unit/integration (parallel)  Tests 481 passed
gate 6  unit/integration (serial)    Tests 481 passed
gate 7  E2E regression (isolated DB) 26 passed
gate 8  reverse-order E2E            7 passed
gate 9  live database CONTENT unmodified — content identical
gate 9  integrity_check ok · foreign_key_check 0 · ledger=2 balances=2
```

Test count rose from 382 to **481** — the 99 new tests are collected by the
default `npx vitest run`, so they run in both gate 5 and gate 6.

### 11. E2E isolation results

```
scripts/phase-3a-1-isolation-negative-test.js
RESULT: 29 passed, 0 failed
NEGATIVE TEST PASS — production is unreachable from the E2E harness.
```

The production-port refusal guard is unchanged and still effective. No new E2E
suite was added in this step, and none used a production host.

### 12. Production-safety verification

| Check | Result |
|---|---|
| Production fingerprint | `bae82d107fb179a864df543878b6e23e` — **identical to the STEP 2A baseline** |
| Tables / rows | 142 / 701 — unchanged |
| `integrity_check` | **ok** |
| FK violations | **0** |
| Test-tagged rows | **0** |
| Updater frozen files changed | **0** |
| Protected `app.asar` | `16b2a1290e704dce43cacdbef1cd43ce` — **unchanged** |
| Temp database directories leaked | **0** |
| GitHub releases | **0** |
| Production artifacts published | **none** |
| Signing configuration | untouched |
| `release-gate.js` | unmodified |
| Production `USER_LOGIN` audit row from the earlier probe | **preserved**, not rewritten |

The single `USER_LOGIN` audit row recorded in the Step 2 audit remains, as
instructed. No production history was altered to force a row-count match.

### 13. Remaining CRM findings (deliberately not fixed here)

| ID | Severity | Status |
|---|---|---|
| CRM-03 | MEDIUM | Deal/task state transitions now have permission checks, but **transition validation is still absent** — an invalid stage change is not rejected on its merits. Partially addressed by this step. |
| CRM-04 | MEDIUM | `deals`, `organizations`, `leads`, `customers`, `tasks`, `appointments`, `activities`, `notes` still delete with **no transaction and no dependency pre-check**. Only `contacts` was fixed (scope boundary). |
| CRM-05 | LOW | RESTRICT failures elsewhere still return the generic 409. Improved for contacts only. |
| CRM-06 | LOW | `activities` still exposes no delete handler. |
| CRM-07 | LOW | Two N+1 query sites unchanged (`contacts.controller.js`, `organizations.controller.js`). |
| CRM-08 | INFO | `customers` table still orphaned from Billing. |
| CRM-09 | INFO | Lead attributes still duplicated between `leads` and `contacts`. |
| NEW | LOW | `server/routes/relationships.js` remains unmounted — decide whether to mount or delete it. |

### 14. Verdict

**STEP 2A — PASS**

Both HIGH findings are fixed and proven by regression tests that reproduced the
defect before the change:

- **CRM-01** — contact deletion now refuses when dependents exist (409, naming
  them), runs atomically, and no longer silently destroys deals, tasks,
  activities or appointments. 10/10 tests pass.
- **CRM-02** — all 33 routes now enforce server-side permissions; a
  zero-permission user receives 403 on every one. 89/89 tests pass.
- Release gates **16/16 PASS**, isolation **29/29 PASS**, production
  **byte-identical**.

The overall Phase 3 verdict is **not** declared here. Accounting, Billing,
Inventory and cross-module integration remain unaudited, and CRM-04 (delete
atomicity for the other eight entities) is still open.

---

## STEP 3 — ACCOUNTING AUDIT: INTERRUPTED BY PRODUCTION INCIDENT

**Date:** 2026-10-09
**Status: NOT READY — audit halted; production was modified by audit tooling.**

During this audit, read/write probes intended for a disposable database bound to
the **live production database** and created journal entries there. The audit was
stopped immediately on detection. Full detail, exact record IDs, root cause and
containment work:

### → `docs/audits/phase-3-a-incident-2026-10-09.md`

### Summary

| | |
|---|---|
| Fingerprint before | `bae82d107fb179a864df543878b6e23e` |
| Fingerprint now | `3fdf4f230b0ee5e9dbf8cffa5abf48ac` |
| `journal_entries` | 25 → 31 (**+6** probe entries) |
| `journal_entry_lines` | 102 → 112 (**+10**) |
| `financial_years` | 0 locked → **2 locked** (`is_locked=1`) |
| `integrity_check` | **ok** |
| `foreign_key_check` | **0 violations** |
| Genuine entries (`JV-*`) | **25, unchanged, all balanced** |
| Trial balance | dr 7750 / cr 7750 — **balanced** |
| Cash in Hand / Bank Account | each skewed by **350** (net 0.00) |

Root cause: `server/database/connection.js` evaluates
`const DB_PATH = process.env.DB_PATH || <production>` at **module load**, so
setting `process.env.DB_PATH` after any require in that chain leaves the cached
connection on production. Every pre-existing guard passed — the filename was
marked disposable, the path was outside `data/`, and the env var was set. Only
`PRAGMA database_list` exposed it.

Containment completed: verified backup created, read-only verification tool
written, and the guard hardened to assert against the **actually-open file**
rather than the environment variable, with 6 regression tests passing (each in a
child process, since module-load order cannot be reproduced in one).

**Nothing was deleted, reversed, or restored.** Owner decisions are pending on:
(1) the six probe journal entries, (2) restoring `financial_years.is_locked`,
and (3) whether to re-baseline the fingerprint.

**STEP 3 — AUDIT NOT COMPLETE.** The Accounting audit findings are drafted but
deliberately not recorded here, because the audit process is what caused the
production modification. They will be written up after remediation.
