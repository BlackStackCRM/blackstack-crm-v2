# BLACKSTACK CRM
## FINAL RELEASE READINESS

**Date:** 2026-10-06
**Project:** `D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2`

---

## Test Results

### Vitest parallel (4 consecutive runs)

| Run | Result |
|---|---|
| 1 | **291 passed / 0 failed** |
| 2 | **291 passed / 0 failed** |
| 3 | **291 passed / 0 failed** |
| 4 | **291 passed / 0 failed** |

Zero unhandled rejections. The only stderr line in any run is the known
dev-mode notice `[auth] WARNING: JWT_SECRET not set`, which is expected.

### Vitest serial

```
npx vitest run --no-file-parallelism
  Test Files  11 passed (11)
  Tests       291 passed (291)
```

Both execution modes pass on the same code. Parallelism was **not** disabled to
achieve this.

### E2E

```
node scripts/run-one-e2e.js "Test"
  26 passed (3.7m)
```

### Reverse-order E2E (order independence)

```
node scripts/run-one-e2e.js "Test (25|24|23|21|11|9|7):"
  7 passed
```

Four consecutive clean runs from a freshly wiped database.

### Architecture Guard

```
tests/architecture-retired-tables.test.js   3 passed
inv_locations              0
inventory_movements        0
batch_wise_stock           0
uoms                       0
stock_adjustment_reasons   0
```

### Authorization

```
tests/authorization.test.js                23 passed
anonymous                     -> 401
authenticated, no permission  -> 403   (real role_manager: 20 permissions, no settings.manage)
authorized admin              -> 2xx
```

Covers `/backups`, `/backups/rotate`, `/backups/restore`, `/support-bundle`,
`/data-deletion/token`, `/maintenance/vacuum`, `/storage`.

### Backup / Restore

```
tests/phase2-data-hardening.test.js           20 passed
tests/phase3-update-enterprise.test.js        17 passed
tests/migration-idempotency.test.js           5 passed
tests/process-env-isolation.test.js           3 passed
```

Backup creation, validation, safe restore, corrupt-backup rejection, foreign-key
validation and stale-lock handling all pass.

### Transaction / Rollback

Bill lifecycle verified end to end through the real HTTP API
(`tests/bill-lifecycle.test.js`, 14 passed):

```
opening stock            100
bill posted (qty 10)     90
second bill (qty 10)     80
cancel first bill        90      stock restored
cancel again             90      refused (400) — no double restore
ledger                   reversal APPENDED, originals preserved
reconciliation           ledger == balances, 0 mismatches
DRAFT -> POSTED          refused (INVALID_STATE) — state machine enforced
auto-created product     is_inventory_managed = 1
```

---

## Database

```
FK violations:            0
Stock mismatches:         0
Production DB modified:   NO

Content fingerprint BEFORE : 60322fcdcdf64cb7371def4e7e31f5ec
Content fingerprint AFTER  : 60322fcdcdf64cb7371def4e7e31f5ec
File checksum BEFORE       : 06a84c283c816289e0e389365b2eb1be
File checksum AFTER        : 06a84c283c816289e0e389365b2eb1be
```

Table consistency (11 checks, all 0 violations): orphan `inventory_items`,
`stock_items` without products, godowns without locations, balances/ledger rows
pointing at missing items, journal lines without headers, duplicate location
codes, duplicate godown codes, negative balances, and both directions of the
`is_inventory_managed` flag mismatch.

---

## Bugs Fixed

### Production bugs

**1. `dataSafety` router had no authentication** *(carried forward from the
production-readiness audit — verified intact, not changed here)*

**2. Auto-created products were not flagged inventory-managed** *(carried
forward — verified intact, not changed here)*

**3. `legacy_tables.retired_at` was rewritten on every server start** *(new)*

- **Bug:** `server/app.js` runs migrations on every boot. Step 081 in
  `migrate.js` wrote its `legacy_tables` registry row with an unconditional
  `INSERT OR REPLACE`, and `retired_at` carries `DEFAULT CURRENT_TIMESTAMP`, so
  the timestamp advanced on each start.
- **Root cause:** the statement re-stamped the row unconditionally instead of
  preserving its original value.
- **File:** `server/database/migrate.js`
- **Fix:** pass `retired_at` explicitly as
  `COALESCE((SELECT retired_at FROM legacy_tables WHERE table_name = 'inv_locations'), CURRENT_TIMESTAMP)`,
  so the value is preserved once written and the statement becomes idempotent.
- **Why safe:** first insert still gets `CURRENT_TIMESTAMP` (nothing to preserve);
  subsequent runs write identical values. Only a metadata timestamp is affected —
  no business row, id, or schema changed.
- **Verification:** `tests/migration-idempotency.test.js` (5 assertions).
  Ground truth established by `scripts/verify-idempotency-guard.js`, which runs
  both variants against disposable copies:

  ```
  FIXED    : 2026-10-06 16:24:37 -> 2026-10-06 16:24:37   changed=false
  REVERTED : 2026-10-06 16:24:37 -> 2026-10-06 16:37:02   changed=true
  fix is load-bearing: YES
  ```

### Test-infrastructure bugs

**4. `tests/phase3-update-enterprise.test.js` replaced `process.env` wholesale**
*(the reported flake)*

- **Bug:** `setup()` did `prevEnv = { ...process.env }` and `teardown()` did
  `process.env = prevEnv`.
- **Root cause — two independent faults:**
  1. Restoring the whole object discards variables other tests changed while this
     suite ran, including ones it never touched.
  2. On Windows it destroys `process.env` itself. Node's real `process.env` is a
     *case-insensitive proxy* over the OS environment; assigning a plain object
     replaces that proxy, after which every differently-cased lookup returns
     `undefined` (`PATH`/`Path`, `TEMP`/`Temp`, `APPDATA`) for the life of the
     worker. Verified directly:

     ```
     process.env.PathLikeProbe='x'; process.env.PATHLIKEPROBE   -> 'x'
     process.env = { ...process.env };
     process.env.PathLikeProbe2='y'; process.env.PATHLIKEPROBE2 -> undefined
     ```
- **Fix:** snapshot and restore only `DB_PATH` and `BLACKSTACK_USER_DATA_DIR`,
  deleting a key when it was not previously present. `process.env`'s identity is
  never replaced.
- **Verification:** suite passes standalone; repo-wide grep finds no remaining
  wholesale assignment in executable code.

**5. `tests/phase2-data-hardening.test.js` had the identical defect**

Same `process.env = prevEnv` pattern, plus a third mutated key
(`BLACKSTACK_BACKUP_RETENTION`) that the wholesale restore happened to cover.
Fixed identically with all three keys managed explicitly.

**6. The flake was partly an artifact of my own methodology, and the test that
"caught" it initially could not fail at all**

Three stacked flaws produced convincing but wrong answers, each found by demanding
the test fail when the fix was reverted:

- **Byte comparison cannot detect this class of bug.** SQLite repacks pages on any
  row rewrite, so both the buggy and fixed statements change the file md5.
  `expect(md5).toBe(before)` therefore tells you nothing about correctness. The
  test now asserts on **content** and on the specific field that can differ.
- **A swallowed exception looks exactly like "nothing happened".** A revert that
  left a dangling `?` produced a SQL syntax error inside
  `catch (e) { /* legacy_tables absent on very old databases */ }`, so nothing was
  written and the test passed. Temporarily logging the caught error revealed it.
- **The first version of the test pointed at the wrong database.** `migrate()`
  takes no path; `connection.js` captures `process.env.DB_PATH` at *module load*.
  The test set the variable after requiring, so it migrated the live database. The
  correct order is: evict the cache → set the variable → require → `await`.

**7. The release gate initially reported false failures**

- Vitest colours its summary, so ANSI escapes sit between the label and the
  count: `Tests \x1b[1m\x1b[32m3 passed`. A regex written against the visible text
  never matched the raw stream, so every gate reported FAIL. Fixed by stripping
  ANSI before matching.
- On Windows `npx` needs a shell, and the shell then *interpreted* the reverse-order
  E2E grep: `Test (25|24|...)` — cmd.exe read the `|` as a pipe and the run died
  with exit 255. Fixed by quoting arguments containing shell metacharacters.

**8. E2E voucher tests depended on Test 11 having created the stock item**

Exposed by the stricter `optionCount` guard: when Test 11 failed for an unrelated
reason (a transient fetch error while the server was under load), Tests 12-16 all
failed on `select[name="item_id"] has no options`. The item_id select is populated
from real `stock_items` rows, and `beforeAll` wipes the database — so those tests
only ever worked because Test 11 happened to run first.

- **Fix:** added `ensureStockItem()`; Tests 12, 13, 14 and 15 now establish their
  own stock item, and Test 15 also creates its destination godown. Verified by
  running Tests 12-15 alone against a clean database: 4/4 pass.

**9. `optionCount <= 1` wrongly rejected a valid single-option select**

The guard added in the previous phase counted options rather than checking whether
any were selectable. When the company has exactly one godown — precisely the one the
test needs — the select holds one *real* option and was rejected as "unpopulated".
Ten tests went red. Both `createMaster` and `createVoucher` now test for a
non-empty option `value` instead of counting. On a genuinely empty select the error
now includes a diagnostic probing the masters endpoints, because the page wraps its
list fetches in `catch { /* skip */ }` — so "no options" means either *the master is
absent* or *the fetch failed*, and those need distinguishing.

**10. Toast diagnostics collapsed to the word "error"**

`querySelector('#toast, .toast, [role=alert], [role=status]')` matches an outer
container whose `textContent` is just `"error"`, hiding the message that names the
offending field. Now collects every toast-like node.

### Test-quality improvements

| Item | Detail |
|---|---|
| `tests/process-env-isolation.test.js` | New guard (3 assertions) rejecting any wholesale `process.env` assignment. Strips comments and string literals so documented "never do this" examples are not false positives, and self-checks that the regex still matches a known-bad sample. |
| `tests/migration-idempotency.test.js` | New guard (5 assertions) pinning migration idempotency and proving the content fingerprint still detects a genuine write. |
| `scripts/verify-idempotency-guard.js` | Proves the idempotency guard detects its own regression by running both variants. |
| `scripts/release-gate.js` | The release gate itself (Phase 15). |
| `scripts/check-port.js` | Port probe, so a stray server is reported as "port in use" rather than as a product failure. |
| `tests/inventory.e2e.test.js` | `ensureStockItem()` added; select-population guards corrected to test for selectable values rather than counts; toast diagnostics widened. |

Phase 14 scan results: **0** `⚠️ SKIP`, **0** `optionCount > 1`, **0** wholesale
`process.env` assignments in executable code. All 18 remaining empty catches are
teardown-only (`close()`, `unlinkSync`, `rmSync`) — verified none wrap an
assertion.

---

## Release Gate

`npm run test:release` → `node scripts/release-gate.js`

Fourteen gates across nine groups, any failure exits non-zero:

1. live-database fingerprint (tripwire)
2. architecture guard (retired tables)
3. env-isolation guard + migration idempotency
4. authorization (401/403/2xx) + bill lifecycle
5. unit/integration, parallel
6. unit/integration, serial
7. E2E regression (isolated DB)
8. reverse-order E2E
9. database integrity: fingerprint unchanged, `integrity_check`, `foreign_key_check`, ledger/balance reconciliation

The gate checks the live database *content* (schema + every row of every table),
not file bytes — see Remaining Issues for why that distinction matters. It prints
the file checksum too, and explicitly notes when bytes moved while content did
not, so a real mutation can never hide behind an expected one.

---

## Remaining Issues

1. **`legacy_tables` is rewritten by every migration run on a legacy schema.**
   The fix makes the timestamp stable, but the `INSERT OR REPLACE` still executes
   on each boot, so SQLite repacks pages and the file checksum can move. Content is
   provably unchanged. A stricter form would skip the write when the row already
   matches, but that changes migration behaviour for no user-visible benefit.

2. ~~**`scripts/run-e2e-isolated.js` still ignores `--grep`.**~~
   **RESOLVED after the release decision (2026-10-06).** The script now delegates
   to `scripts/run-one-e2e.js`, which invokes the Playwright CLI entry directly
   with no shell, and normalises `--grep "PATTERN"` into the runner's positional
   form so both invocation styles work. Verified through the wrapper:
   `--grep "Test 23:"` → 1 test, and `--grep "Test (23|21):"` → 2 tests (the
   alternation that previously died when cmd.exe read `|` as a pipe). One tested
   runner instead of two, one of which silently ignored its arguments.

3. **E2E suites contend for port 3000.** Running two at once makes the second abort
   by design. This produced two false "flake" readings during this work before it
   was identified. The release gate now checks the port first and reports the real
   cause.

4. **Phase 6 fault injection is not separately exercised.** Rollback is verified
   structurally (lifecycle steps inside `conn.transaction`) and behaviourally (each
   partial step's observable outcome checked), but no test forces a mid-transaction
   failure to observe the unwind. A fault-injection hook would do it properly; the
   audit rules correctly forbid faking it with direct SQL.

5. **No low-privilege account exists in the seeded database.** `role_manager` and
   `role_user` are defined in `roles`, but only `role_admin` has a `users` row, so
   the 403 path is proven by seeding a manager into a disposable copy rather than
   by an existing account.

6. **Schema version reporting.** `schema_migrations` max is 83 while programmatic
   Steps 081/082/084 exist in `migrate.js`. The Steps are applied in code and are
   not rows in the table, so the two numbering schemes do not correspond. Harmless
   today, confusing later.

---

```
BLACKSTACK CRM — FINAL RELEASE GATE

STATUS: PASS   (npm run test:release -> 14/14 gates, exit 0)

Unit Tests:              291 PASS / 0 FAIL (4 consecutive parallel runs)
Parallel Stability:      4/4 runs green, 0 unhandled rejections
Serial Tests:            291 PASS / 0 FAIL
E2E:                     26 PASS / 0 FAIL
Reverse E2E:             7 PASS / 0 FAIL (4 consecutive clean runs)
Authorization:           PASS — 401 anonymous / 403 unauthorized role / 2xx admin
Architecture Guard:      PASS — 0 retired-table references
Backup/Restore:          PASS — 37 assertions across phase2/phase3 suites
Inventory:               PASS — ledger/balances reconcile, no negatives, no orphans
Accounting:              PASS — journal lines/headers consistent, 0 FK violations
Batch:                   PASS — 21/21 suite green, unchanged
Serial:                  PASS — 21/21 suite green, unchanged

FK Violations:           0
Stock Mismatches:        0
HTTP 500:                0
JS Exceptions:           0
Retired References:      0

Production DB Modified:  NO
  content fingerprint 60322fcdcdf64cb7371def4e7e31f5ec (before = after)
  file checksum moves on boot (migrations run at startup); content unchanged

Remaining Blockers:
1. None. Every gate in the Phase 16 checklist passes.
2. Non-blocking: E2E suites contend for port 3000 when launched concurrently (the
   gate checks the port first and reports the real cause); Phase 6 fault injection
   is verified structurally and behaviourally rather than by injected failure.
   (run-e2e-isolated.js --grep was resolved after the release decision.)
```