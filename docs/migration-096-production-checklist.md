# MIGRATION 096 REV 2 — PRODUCTION EXECUTION CHECKLIST

Target file: `supabase/migrations/096_profiles_agency_users_rls_isolation.sql`
Status: STATICALLY VERIFIED (see handover report §7 / §16.2). NOT yet applied —
requires Supabase project access and owner authorization.

> **AUTHORIZATION GATE**: do not run any step below without the project
> owner's explicit go-ahead. Record who authorized, when, and in which
> environment (production vs staging) at the bottom of this document.

---

## STEP 0 — Pre-flight (read-only, ~5 min)

Run each query in the **Supabase SQL Editor** connected to the target project.
Every step states the expected result. STOP and investigate if any check fails.

### 0.1 Confirm you are on the intended project
```sql
SELECT current_database(), version();
```
Expected: the production (or staging) Supabase Postgres, version ≥ 15.

### 0.2 Confirm migration history — 090 and 095 applied, 096 NOT yet applied
```sql
-- If the project tracks applied migrations in a table:
SELECT * FROM supabase_migrations.schema_migrations
 WHERE name LIKE '09%' ORDER BY name;
```
Expected rows: `090_role_based_access`, `095_agency_users_rls` (and any 091–094
if the purge migrations were applied). **096 must be absent.**
If your project does not use the migrations table, verify by policy names
instead (0.4/0.5 below).

### 0.3 Confirm `profiles.is_active` exists (required by current_agency_id)
```sql
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'profiles'
 ORDER BY ordinal_position;
```
Expected: a row `is_active | boolean` (per migration 090 line 37:
`boolean NOT NULL DEFAULT true`). If missing → **STOP**. Either 090 was never
applied (apply it first, it is additive) or the schema was altered manually —
resolve before continuing.

### 0.4 Confirm the 090 helper functions exist with the expected signatures
```sql
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('current_agency_id','visible_agency_ids','current_role_name','in_my_subtree');
```
Expected: `current_agency_id()` returns uuid; `visible_agency_ids()` returns
SETOF uuid. Both `SECURITY DEFINER`.

### 0.5 Inspect the EXISTING RLS policies that 096 will replace
```sql
SELECT tablename, policyname, cmd, roles, qual
  FROM pg_policies
 WHERE tablename IN ('profiles','agency_users')
 ORDER BY tablename, policyname;
```
Expected (pre-096 state):
- `profiles`: `profiles_self_read` (SELECT, user_id = auth.uid()) — from 090.
- `agency_users`: `agency_users_subtree_read` (SELECT, scoped to
  `current_agency_id()` only — the narrower 095 form).
- No client-write policies on `agency_users` yet.

### 0.6 Confirm RLS is already enabled (096 re-enables idempotently)
```sql
SELECT relname, relrowsecurity
  FROM pg_class
 WHERE relname IN ('profiles','agency_users');
```
Expected: `relrowsecurity = true` for both (090/095 enabled them). If false
the tables were created without 090/095 → STOP and backfill those migrations.

### 0.7 Confirm 087-era TEXT keys on agency_users (096 casts ::text)
```sql
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema='public' AND table_name='agency_users'
   AND column_name IN ('user_id','agency_id');
```
Expected: both `text`. (096's USING clause casts `auth.uid()::text` — a uuid
column here would still work but the expectation should match the docs.)

### 0.8 Confirm no destructive statements exist in the file (belt & braces)
Open `096_profiles_agency_users_rls_isolation.sql` and confirm it contains
NONE of: `DROP TABLE`, `DROP COLUMN`, `DELETE FROM`, `TRUNCATE`, `ALTER TYPE`,
`DROP FUNCTION` (it only uses `DROP POLICY IF EXISTS` + `CREATE POLICY` +
`CREATE OR REPLACE FUNCTION` + `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`).

---

## STEP 1 — Backup point

Supabase keeps PITR on paid plans; regardless, capture a logical snapshot of
the two affected tables (they are small mapping/identity tables):
```sql
CREATE TABLE IF NOT EXISTS _backup_2026_11_22_profiles AS
  SELECT * FROM profiles;
CREATE TABLE IF NOT EXISTS _backup_2026_11_22_agency_users AS
  SELECT * FROM agency_users;
```
(If the project forbids creating tables in production, export CSV via the
Supabase dashboard Table editor instead. Delete the backup tables after the
post-apply verification window.)

---

## STEP 2 — Apply (transactional)

Paste the ENTIRE contents of
`supabase/migrations/096_profiles_agency_users_rls_isolation.sql`
(lines 20–98: the `BEGIN; … COMMIT;` block; the trailing comment block is
documentation and harmless) into the SQL Editor and run.

- The script is idempotent — a second run is a no-op.
- On ANY error the transaction rolls back; nothing is half-applied.
- Expected output: `CREATE FUNCTION` ×2, `ALTER TABLE` ×2,
  `DROP POLICY`/`CREATE POLICY` per policy block, `COMMIT`.

---

## STEP 3 — Post-apply verification (run ALL of these)

### 3.1 Policies present and correct
```sql
SELECT tablename, policyname, cmd FROM pg_policies
 WHERE tablename IN ('profiles','agency_users') ORDER BY 1,2;
```
Expected exactly:
| table | policy | cmd |
|---|---|---|
| agency_users | agency_users_subtree_read | SELECT |
| agency_users | agency_users_no_client_write | INSERT |
| agency_users | agency_users_no_client_update | UPDATE |
| agency_users | agency_users_no_client_delete | DELETE |
| profiles | profiles_self_read | SELECT |
| profiles | profiles_self_update | UPDATE |
| profiles | profiles_no_client_insert | INSERT |
| profiles | profiles_no_client_delete | DELETE |

### 3.2 RLS still enabled
```sql
SELECT relname, relrowsecurity FROM pg_class
 WHERE relname IN ('profiles','agency_users');
```
Expected: `true` ×2.

### 3.3 Helpers still resolve (no recursion / type errors)
```sql
SELECT current_agency_id();          -- as any logged-in user via the API, or
SELECT count(*) FROM visible_agency_ids();  -- in SQL editor this uses the
                                             -- invoker; may be NULL/0 — the
                                             -- point is NO SQL error.
```

### 3.4 Client-level isolation smoke tests (authenticated JWT required)
Using any authenticated user's anon-key JWT (Supabase dashboard → API →
or the app itself):
```sql
-- 1. profile exposure is SELF-ONLY (must be 1, not the whole user base):
SELECT count(*) FROM profiles;
-- 2. no cross-tenant mapping rows:
SELECT count(*) FROM agency_users
 WHERE agency_id NOT IN (SELECT visible_agency_ids()::text)
   AND user_id <> auth.uid()::text;   -- must be 0
```
Expected: `1` and `0`. Repeat for a user in a DIFFERENT agency to prove the
boundary.

### 3.5 Server-side (service role) access unchanged
The Node server must still be able to provision (it bypasses RLS). Trigger a
harmless authenticated server action (e.g. login sync) and confirm it succeeds.

### 3.6 Regression watch
Watch application logs / user reports for 24 h. The two behavioural changes
are (a) `profiles` reads tighten to self-only (any UI that relied on reading
other users' profiles via anon key will start returning 0 rows — server paths
are unaffected) and (b) `agency_users` reads WIDEN to the full subtree.

---

## STEP 4 — Rollback plan

096 is policy DDL; the pre-096 state is restored by re-running the relevant
090/095 policy definitions (both are idempotent and retained in
`supabase/migrations/`). Data backup tables from STEP 1 cover the
theoretically-impossible data-loss case.

---

## EXECUTION LOG (fill in at run time)

| Field | Value |
|---|---|
| Environment (staging/production) | |
| Authorized by | |
| Executed by / when | |
| STEP 0 checks | all PASS? Y/N |
| STEP 2 result | |
| STEP 3.1–3.5 results | |
| Backup tables removed | |
