# PRODUCTION SUPABASE CONFIGURATION INJECTION — OPERATOR PROCEDURE

Purpose: get real Supabase credentials into a production installer WITHOUT
ever committing credentials to Git. The build machine only; never in CI logs;
never in the repo.

## What ships with the desktop client (and what must NEVER ship)

| Variable | Ships? | Why |
|---|---|---|
| `SUPABASE_URL` | YES | project URL, public by design |
| `SUPABASE_ANON_KEY` (a.k.a. publishable key) | YES | RLS-governed public client key; every row it can read is bounded by RLS policy; every privileged operation (auth.admin, service-role writes) refuses it |
| `SUPABASE_SERVICE_ROLE_KEY` | **NEVER** | bypasses RLS entirely — a leaked service role key is a full database compromise |
| `JWT_SECRET` | **NEVER** | each install generates its own 256-bit secret (`server/auth/jwtSecret.js`) |
| `PAYMENT_WEBHOOK_SECRET` | **NEVER** | webhook HMAC verification is a trusted-server-only operation |

`docs/migration-096-production-checklist.md` and `docs/two-device-test-procedure.md`
describe the operational checks that depend on these values.

## Procedure — build-machine injection (recommended)

1. **On a trusted build machine** (NOT a shared CI runner without secret
   protection), create the file `.env.release` — it is already `.gitignore`d
   (verified: `.gitignore` line 11). If a stale copy exists from testing,
   start from the template in the repo (`git show HEAD:.env.release` does NOT
   exist — the file was never committed; construct it from the spec below).

2. Fill `.env.release` with EXACTLY this shape — nothing more:

   ```
   NODE_ENV=production
   PORT=3000
   DB_PATH=./data/blackstack-crm.db
   JWT_EXPIRY=7d
   CORS_ORIGIN=*
   RATE_LIMIT_WINDOW_MS=900000
   RATE_LIMIT_MAX_REQUESTS=100
   DEMO_MODE=false
   SUPABASE_URL=https://<your-project-ref>.supabase.co
   SUPABASE_ANON_KEY=<real anon/publishable key from the Supabase dashboard>
   ```

   Get both values from the Supabase Dashboard → Project Settings → API.
   Use the **anon / publishable** key, NOT the service role key.
   Do NOT add JWT_SECRET, PAYMENT_WEBHOOK_SECRET, or any SERVICE_ROLE key.

3. **Pre-build secret gate** (run before every release build):

   ```powershell
   # .env.release must contain NO privileged variables
   Select-String -Path .env.release -Pattern 'JWT_SECRET|PAYMENT_WEBHOOK_SECRET|SERVICE_ROLE'
   # Expected: NO output. Any hit → STOP, fix the file.

   # Confirm the file is git-ignored so credentials cannot be committed:
   git check-ignore .env.release   # Expected: .env.release
   git status --short .env.release # Expected: (empty — never staged)
   ```

4. Build:
   ```
   npx electron-builder --win nsis --publish never
   ```

5. **Post-build artifact scan** (mandatory before distribution):

   ```powershell
   $bin = 'dist\win-unpacked\resources\blackstack.env'
   Select-String -Path $bin -Pattern 'JWT_SECRET|PAYMENT_WEBHOOK_SECRET|SERVICE_ROLE'
   # Expected: NO output.
   Get-Content $bin  # Verify SUPABASE_ANON_KEY=<real key>, everything else matches step 2.
   ```

   Also scan the installer exe and app.asar byte-wise for the literal anon key
   value appearing OUTSIDE the intended file (it is a public key, but it must
   only be in `blackstack.env`):

   ```powershell
   $key = (Select-String -Path $bin -Pattern '^SUPABASE_ANON_KEY=(.+)$').Matches[0].Groups[1].Value
   $asar = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes('dist\win-unpacked\resources\app.asar'))
   $exe  = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes('dist\<setup>.exe'))
   "asar contains key: $($asar.Contains($key))"  # informational: false = ideal, true = only-in-comments/fixture context — inspect
   "exe contains key:  $($exe.Contains($key))"   # false = ideal
   ```

6. Record the build in the handover report (version, sha256 of installer,
   scan results) and store the installer in a distribution channel — the
   `.env.release` file itself stays on the build machine only.

## Alternative — CI injection (if a CI build is used later)

- Store `SUPABASE_URL` and `SUPABASE_ANON_KEY` in the CI secret store
  (GitHub Actions **Environment secrets**, scoped to a protected environment).
- Generate `.env.release` at build time from secrets; never `git add` it:
  ```yaml
  - run: |
      cat > .env.release <<EOF
      NODE_ENV=production
      PORT=3000
      DB_PATH=./data/blackstack-crm.db
      JWT_EXPIRY=7d
      CORS_ORIGIN=*
      RATE_LIMIT_WINDOW_MS=900000
      RATE_LIMIT_MAX_REQUESTS=100
      DEMO_MODE=false
      SUPABASE_URL=${{ secrets.SUPABASE_URL }}
      SUPABASE_ANON_KEY=${{ secrets.SUPABASE_ANON_KEY }}
      EOF
  ```
- Add the same pre/post-build secret gates above as CI steps; fail the job on
  any hit.
- NEVER print the file or `$env:SUPABASE_ANON_KEY` in CI logs.

## Runtime behavior to verify after install (documents the safe failure mode)

| Condition | Expected behavior |
|---|---|
| Anon key empty (this build, until injected) | Login returns "authentication service is unreachable" — login FAILS, never silently falls back to local credentials |
| Wrong project URL | Same refusal (HTTP failure → 'unavailable' → 401 to user) |
| Wrong/rotated anon key | Supabase returns 401 "Invalid API key" → login refused with the same clear connectivity error |
| Valid anon key + valid user | Login succeeds via `signInWithPassword`; RLS scopes every cloud read |
| Valid anon key + wrong password | "Invalid credentials" — no local hash check is attempted |

All five behaviors are pinned by `tests/authorization.test.js` /
`tests/mother-company-auth.test.js` (skip cleanly without credentials) and by
the code path `server/services/auth.service.js: _verifyAgainstSupabase()` —
`'unavailable'` ALWAYS results in a login refusal; there is no offline
fallback anywhere in the auth flow.
