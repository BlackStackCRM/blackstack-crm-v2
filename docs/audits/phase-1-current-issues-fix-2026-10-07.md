# Phase 1 — Current Issues Fix: `seed.js` Username/Email Mismatch

**Date:** 2026-10-07
**Project:** BlackStack CRM V2 (`CB CRM V2/blackstack-crm-v2`)
**Scope:** targeted data-layer bug fix only. Updater frozen.

---

## 1. Problem

### Original error (captured, not described)

```
D:\...\blackstack-crm-v2\server\database\connection.js:14
      return stmt.run(...normalizeArgs(args));
                  ^
Error: UNIQUE constraint failed: users.username
    at Object.run (.../server/database/connection.js:14:19)
    at .../server/database/seed.js:59:10
    at wrapped (.../server/database/connection.js:88:24)
    at Object.seed (.../server/database/seed.js:62:7) {
  code: 'ERR_SQLITE_ERROR', errcode: 2067, errstr: 'constraint failed'
}
```

Exit code `1`. This was first observed during Phase D Step 3 as
`Failed to seed: Error: UNIQUE constraint failed: users.username`, with the
packaged app never reaching a listening state.

### Reproduction steps

```
1. Any database containing a user row with  username = 'admin'  (or id = 'admin')
   whose email is NOT the email you are about to seed with.
2. Run seed() in DEMO_MODE with BOOTSTRAP_ADMIN_EMAIL set to a different address.
3. seed() throws UNIQUE constraint failed: users.username and exits 1.
```

Reproduced deterministically in this task. Pre-state used:

```json
[{"id":"admin","username":"admin","email":"admin@blackstack.local"}]
```

seeding with `BOOTSTRAP_ADMIN_EMAIL=phase-d-admin@blackstack.local` → **exit 1**.

### Scope determination

| Question | Answer |
|---|---|
| Which process runs `seed.js` | `server/app.js:305` → `seed().then(startServer)`; also `setup.js:151`, `npm run seed`, `tests/customer-bills.vitest.test.js:62` |
| Which table | `users` |
| Which columns | `username TEXT UNIQUE`, `email TEXT UNIQUE NOT NULL`, `id TEXT PRIMARY KEY` |
| Only seeding, or startup too? | **Startup.** `app.js` chains `seed().then(startServer)`, so a throw prevents the server from ever binding a port |
| Fresh database affected? | **No** — first seed succeeds |
| Existing database affected? | **Yes**, whenever `admin` identity exists under a different email |
| Production affected? | **No** — seeding runs only when `DEMO_MODE=true` (`app.js:304`) or via explicit `npm run seed` |

Confirmed empirically across four configurations:

| Configuration | Before fix |
|---|---|
| Fresh DB, default demo admin | exit 0 |
| Existing admin, **same** email | exit 0 |
| Existing admin, **different** email | **exit 1 — crash** |
| Non-demo, no bootstrap credentials | exit 0 (refuses cleanly) |

---

## 2. Root Cause

`users` declares **three independent unique constraints**:

```sql
id       TEXT PRIMARY KEY,
username TEXT UNIQUE,
email    TEXT UNIQUE NOT NULL,
```

The insert in `seed.js` hard-coded **two** of those three values as the literal
`'admin'` — both `id` and `username` — while `email` came from configuration:

```js
const adminExists = conn.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
...
INSERT INTO users (id, company_id, username, email, ...)
VALUES (?, ?, 'admin', ?, ...)
```

The existence check therefore inspected **only one** of the three constraints it
was about to violate. A database already holding `username='admin'` under a
different email passes the email check and then aborts on the username UNIQUE
index.

The check and the insert disagreed about what identifies the admin. That is the
whole defect: **a partial uniqueness guard in front of a multi-column unique
insert.**

### Data contract (traced, not assumed)

```
Schema   users(id PK, username UNIQUE, email UNIQUE NOT NULL, password_hash, role, status)
   ↓
Seed     hard-codes id='admin', username='admin'; email from BOOTSTRAP_ADMIN_EMAIL
   ↓
Auth     server/services/auth.service.js:21  ->  userRepo.findByIdentifier(identifier)
   ↓
         server/repositories/user.repository.js:17
         'WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE LIMIT 1'
```

**Both `email` and `username` are live login identifiers.** The fix therefore had
to preserve both as valid identities — it could not resolve the collision by
dropping or renaming either field.

---

## 3. Fix

**One file changed: `server/database/seed.js`.**

The existence guard now matches every constraint the insert can violate:

```js
const ADMIN_ID = 'admin';
const ADMIN_USERNAME = 'admin';

const adminExists = conn.prepare(
  'SELECT id FROM users WHERE email = ? OR username = ? COLLATE NOCASE OR id = ? LIMIT 1'
).get(adminEmail, ADMIN_USERNAME, ADMIN_ID);
```

The insert now binds those constants instead of repeating literals, so the guard
and the insert can no longer drift apart.

### Why this is the smallest correct fix

- **No schema change** — no column added, renamed, or duplicated.
- **No authentication change** — both identifiers remain valid.
- **No permission change** — `role='ADMIN'` and the `role_admin` grant are untouched.
- **No data mutation** — the guard only widens a `SELECT`; an existing admin is
  left byte-for-byte intact.
- **No updater, packaging, installer or backup change.**

Behaviour when a collision exists is "admin already exists, skipping" — the same
intent the original code already had for the email case. No second mechanism was
invented.

### Root cause is not in the updater

The defect lives entirely in the seed/data layer. The updater merely *surfaced*
it, because a packaged app booting in demo mode runs `seed()` before listening.
No updater file was modified (§9).

---

## 4. Fresh Database Test

**PASS**

```
migrations: 69 applied, max version 83, 142 tables
seed run 1  : exit 0  DEMO admin created
seed run 2  : exit 0  Admin user already exists. Skipping.
seed run 3  : exit 0  Admin user already exists. Skipping.
```

Final state — exactly one user, no duplicates:

```json
{"users":[{"id":"admin","username":"admin","email":"admin@blackstack.local",
           "role":"ADMIN","status":"ACTIVE"}],
 "userCount":1,
 "roles":[{"user_id":"admin","role_id":"role_admin"}],
 "permissions":103, "role_permissions":122,
 "integrity":"ok", "fk":0}
```

---

## 5. Existing Database Test

**PASS**

Tested on a disposable copy of the **real** per-user database
(`%APPDATA%\blackstack-crm-v2`, 2,891,776 bytes), with `-wal`/`-shm` copied
alongside — a read-only open cannot recover a pending WAL.

Seeding an existing DB that already holds an admin:

```
exit 0  |  [seed] Admin user already exists. Skipping.
```

Before/after comparison on identical copies:

| Dimension | Identical |
|---|---|
| `users` rows | **yes** |
| `user_roles` | **yes** |
| key counts (contacts, accounts, invoices, products, stock_items, permissions, role_permissions, schema_migrations) | **yes** |
| total rows | **yes** |
| table count | **yes** |
| `integrity_check` | **yes** (`ok`) |
| `foreign_key_check` | **yes** (0 violations) |

Concrete values preserved: contacts 2, accounts 24, products 3, stock_items 3,
permissions 103, role_permissions 122, schema_migrations 69, total rows 1024.

The existing user's `id`, `username`, `email`, `role` and `status` were **not
modified**, even when the seed was offered a different email.

### The original crash, verified gone at startup level

Booting the **real** `server/app.js` in demo mode against a DB containing an
`admin` with a different email — the exact Step D Step 3 condition:

```
SERVER LISTENS after the previously-crashing seed: True
existing admin can still authenticate: True | role ADMIN
```

---

## 6. Authentication Test

Real HTTP against the real server (`server/app.js`, port 34991), seeded fresh DB:

| Case | Identifier | Password | HTTP | success | role |
|---|---|---|---|---|---|
| Valid by email | `admin@blackstack.local` | `admin123` | 200 | true | ADMIN |
| Valid by username | `admin` | `admin123` | 200 | true | ADMIN |
| Wrong password | `admin` | `wrong-password` | **401** | false | — |
| Unknown user | `nobody@example.com` | `admin123` | **401** | false | — |
| Empty identifier | `` | `admin123` | **400** | false | — |

Both identifier forms work; the ADMIN role is resolved; invalid credentials are
rejected normally. **Authentication was not weakened.**

---

## 7. Seed Re-run Test

**PASS**

Fresh DB seeded three times consecutively (§4): exactly **1** user, no duplicate
email, no duplicate username, no duplicate id, no unexpected mutation,
`integrity ok`, exit 0 on every run.

Existing DB re-seeded: skipped cleanly, all data identical.

The existing design is idempotent-by-guard, and that behaviour is unchanged.

---

## 8. Regression

### Targeted

```
npx vitest run tests/customer-bills.vitest.test.js tests/electron-safety.test.js
  Test Files  2 passed (2)
  Tests       183 passed (183)
  exit 0
```

`customer-bills.vitest.test.js` calls `seed()` directly (line 62), so this
exercises the changed code path.

### Full release suite

```
npm run test:release
  16/16 gates passed
  RELEASE GATE: PASS
  RELEASE_EXIT=0
```

| Gate | Result |
|---|---|
| 1 live database present | PASS (content `60322fcdcdf6`) |
| 2 architecture guard (retired tables) | 3 passed |
| 3 env-isolation guard | 3 passed |
| 3 migration idempotency | 5 passed |
| 4 authorization | 23 passed |
| 4 update/data-safety route contract | 29 passed |
| 4b Phase C update lifecycle | 57 passed |
| 4 bill lifecycle + reconciliation | 14 passed |
| 5 unit/integration (parallel) | **382 passed** |
| 6 unit/integration (serial) | **382 passed** |
| 7 E2E regression | **26 passed** |
| 8 reverse-order E2E | **7 passed** |
| 9 live DB content unmodified | PASS |
| 9 `integrity_check` | ok |
| 9 `foreign_key_check` | 0 violations |
| 9 stock ledger/balances reconcile | ledger=2 balances=2 |

No test was weakened or modified.

---

## 9. Updater Integrity

**Updater implementation UNCHANGED — verified byte-for-byte.**

`scripts/phase-d-frozen-check.js` compares each updater file's bytes in the
Phase-D-verified v2 package against the working tree:

| File | Result |
|---|---|
| `server/services/updateState.js` | **SAME** |
| `server/services/updateService.js` | **SAME** |
| `server/services/backupService.js` | **SAME** |
| `electron/main.js` | **SAME** |
| `electron/preload.js` | **SAME** |
| `electron/db-migration.js` | **SAME** |
| `public/js/pages/settings.js` | **SAME** |
| `server/database/seed.js` | **DIFFERS — the intended fix** |

```
frozen files changed : 0   (must be 0)
expected changes seen: 1 / 1
exit 0
```

No installer, packaging, or backup/recovery behaviour was altered.

---

## 10. Production Safety

**Production data UNCHANGED.**

All mutation testing used disposable databases under `%LOCALAPPDATA%\Temp\`.
The real user database was copied (read-only) and never written.

| Database | Measurement | Before | After |
|---|---|---|---|
| `data/blackstack-crm.db` | md5 | `5cfa9fd13506439679a6c5405ec93075` | **identical** |
| `data/blackstack-crm.db` | content fingerprint | `0ea76f86b9211cc5618c400cd2902d64` | **identical** |
| `data/blackstack-crm.db` | `integrity_check` | ok | ok |
| `data/blackstack-crm.db` | `foreign_key_check` | 0 | 0 |
| `data/blackstack-crm.db` | test-tagged rows | 0 | 0 |
| `%APPDATA%\…\blackstack-crm.db` | content fingerprint | `e5475ea436c2fc05232b15f61862736f` | **identical** |

Production `data/` contains only the database, its two sidecars and
`regression-test`. No test artefacts were left behind. All disposable
directories removed; no test processes remain.

---

## 11. Remaining Issues

Discovered during this task and **not** fixed, per scope:

1. **`setup.js:151` calls `seed()` without awaiting it.**
   ```js
   const { seed } = require('./server/database/seed');
   seed();
   ```
   A rejected promise would be an unhandled rejection rather than a clean
   failure. Not the cause of this bug and not modified. Recorded for a future
   data-layer task.

2. **`migrate.js:65` error message is misleading.**
   On migration failure it reports *"Halting — partial state preserved in
   schema_migrations for diagnosis"*, but the per-file transaction rolls back
   cleanly (verified in Phase D Step 3: no probe rows, max version unchanged).
   Behaviour is correct; only the wording misleads a future operator. Not
   modified — it is a migration-layer string, outside this task.

No updater defects were found. No other site has the same partial-guard pattern:
`server/repositories/user.repository.js:13` queries `username` against a bound
parameter, so it carries no equivalent risk.

---

## Final Verdict

# PHASE 1 — PASS
