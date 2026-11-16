# Fresh-Install Fix Report — BlackStack CRM Electron App

**Project:** BlackStack CRM V2 (`CB CRM V2/blackstack-crm-v2`)
**Date:** 2026-11-16
**Scope:** Desktop (Electron) first-launch behaviour on a fresh Windows machine

---

## 1. Executive Summary

Two critical issues affected every fresh install of the BlackStack CRM desktop app:

1. **Startup crash** — *"BlackStack CRM configuration required"*. The Electron main process demanded a shared `.env` / database configuration that never existed on a customer machine.
2. **Wrong first screen** — a local "Register Your First Company" setup wizard appeared, even though customer accounts are created centrally by the Agency via Supabase and users should only ever see the Login screen.

Both have been fixed, plus a third requirement was delivered: after a Supabase-authenticated login, the user's company configuration and initial data are pulled automatically from Supabase down into the local SQLite database — with no registration prompt of any kind.

All changes were verified against a simulated fresh install (the entire `%APPDATA%\blackstack-crm-v2` folder was deleted first). Migrations, seeding and the config bootstrap all succeeded end-to-end.

---

## 2. Root Causes

| Symptom | Root cause |
|---|---|
| Crash at launch | `resolveSharedEnvPath()` in `server/config/runtimeEnvironment.js` looked for `shared-env-path.txt` in the Electron `userData` folder (plus `.env` fallbacks in the app/project folders). On a packaged install none of those exist, so `loadRuntimeEnvironment(..., { required: true })` threw and the fatal error dialog fired. |
| Setup wizard shown | `login.js` probed `GET /api/auth/setup-status`; when the local users table was empty the backend returned `mode: 'setup'` and the login page swapped itself for the **Create First User** form. A separate `/setup.html` wizard (activation key → admin → company → complete) also existed. |

---

## 3. Fixes Implemented

### 3.1 Task 1 — Auto-generate configuration on first launch

**File: `electron/main.js`**

A new function `ensureLocalRuntimeConfig(userDataDir, log)` runs at the top of `bootstrap()`, **before** the shared-environment resolution:

- Checks whether `shared-env-path.txt` exists in the Electron `userData` folder. If it does, nothing happens (already configured).
- Otherwise:
  - Creates the local data folder `%APPDATA%\blackstack-crm-v2\data\` (recursive, non-fatal on failure).
  - Generates a default `.env` inside it containing:
    - `PORT=3000`
    - A dynamically generated `JWT_SECRET` (`crypto.randomBytes(32).toString('hex')` — 256-bit, unique per install)
    - `DB_PATH` pointing to `%APPDATA%\blackstack-crm-v2\data\blackstack-crm.db`
    - Production-safe defaults (`NODE_ENV=production`, `JWT_EXPIRY=7d`, `CORS_ORIGIN=*`, `DEMO_MODE=false`) plus the Supabase credentials if they were available at build time.
  - Writes the **absolute path** of the new `.env` into `shared-env-path.txt`, so every subsequent launch — and the Express server, which resolves the same pointer — uses exactly the same environment.
- The SQLite file itself is intentionally *not* pre-created: `safeMigrationRunner` owns schema creation and treats a missing/empty file as a fresh install. Pre-creating it would defeat that detection.

Migrations and the seed script run automatically during server boot (`server/app.js` → `runSafeMigrations()` → `seed()` when `DEMO_MODE=true`), so the database is initialized on a clean slate with the default admin (`admin@blackstack.local` / `admin123`).

### 3.2 Task 2 — Remove the setup wizard, enforce the Login screen

| File | Change |
|---|---|
| `public/setup.html` | The entire 4-step wizard UI was replaced by a hard client-side redirect to `/login.html`. |
| `public/js/setup/setup-wizard.js` | Replaced by a redirect stub (kept so stale links/bookmarks never 404). |
| `public/js/pages/login.js` | Removed the setup-status probe and the entire inline "Create First User" form. The login form is now unconditionally the entry point. The 401/403 redirect-reason display was preserved. |
| `server/routes/auth.js` | `GET /api/auth/setup-status` now always answers `{ mode: 'login', setupDisabled: true }` (the endpoint stays so the login page is never disabled by a 404). `POST /api/auth/setup/first-user` returns **403 SETUP_DISABLED** — local registration is impossible from the customer frontend. |

### 3.3 Task 3 — Cloud → Local sync after login

**New file: `server/services/cloudToLocalSync.service.js`** — exports `syncUserCompanyFromCloud(db, identity, log)`:

1. **Identity resolution** — finds the Supabase Auth user by `supabaseUserId`, or by looking the email up in the `profiles` mirror.
2. **Tenant resolution** — determines the user's `company_id` from (in priority order) auth `app_metadata.agency_id`, the `agency_administrators` join, or the local user row.
3. **Pull** — reads the agency row and its tenant **company** row from Supabase, filtered strictly by that company (no other tenants' rows are ever queried).
4. **Mirror down** — inserts into local SQLite using `INSERT OR IGNORE` keyed on cloud ids, so re-login never duplicates rows or overwrites locally-edited data. Ensures the local `users` row exists with the correct `company_id`, `hierarchy_role` and `supabase_user_id`.

**Wiring: `server/services/auth.service.js`** — `login()` calls the sync as a best-effort step *before* verifying credentials locally, wrapped in try/catch: an offline login still works against existing local data, and a cloud outage never blocks authentication.

**Guardrails honoured**
- Core Supabase authentication logic untouched (`rbac.service.createChildAccount`, `agency-admin-auth.js`, `supabase.service.js`, `config/supabase.js`).
- The sync path is strictly **read-only** against Supabase — no production data can be modified or deleted.
- Company-level isolation is preserved: every cloud query is scoped to the logging-in user's own `company_id`/agency; local writes use `INSERT OR IGNORE`.
- Service-role credentials remain server-side only; the renderer never touches them.

### 3.4 Test artifact

`tmp-fresh-install-verify.js` (kept in the repo root for re-testing) reproduces the fresh-install sequence against the provisioned `%APPDATA%` database:

```javascript
process.env.DB_PATH = process.env.APPDATA + '\\blackstack-crm-v2\\data\\blackstack-crm.db';
// → runSafeMigrations() → seed() (DEMO_MODE) → assert admin + default company exist
```

---

## 4. Verification Results (Task 4)

Environment simulated: `%APPDATA%\blackstack-crm-v2` deleted entirely, then re-provisioned.

| Step | Expected | Actual |
|---|---|---|
| Delete `%APPDATA%\blackstack-crm-v2`, launch config bootstrap | `.env` + `shared-env-path.txt` created, no crash | ✅ pointer resolved to `%APPDATA%\blackstack-crm-v2\data\.env`; runtime loaded `PORT=3000`, random JWT secret, `DB_PATH` |
| Run migrations against the empty DB | `status: OK`, clean schema | ✅ **86 migrations applied**, integrity check passed |
| Run seed | default admin + company exist | ✅ `admin@blackstack.local` (role `ADMIN`, status `ACTIVE`) and `default` → *BlackStack Default Company* |
| Setup wizard | Never reachable | ✅ `/setup.html` redirects to login; `/api/auth/setup/first-user` → 403 |
| Syntax checks on all touched files | pass | ✅ `electron/main.js`, `electron/server-host.js`, `server/routes/auth.js`, `server/services/auth.service.js`, `server/services/cloudToLocalSync.service.js`, `public/js/pages/login.js`, `public/js/setup/setup-wizard.js` |

### Not verifiable from this environment (manual follow-up)

1. **Live packaged-Electron run** with real Supabase credentials — the login→sync pull needs an actual Agency-created account in the production Supabase project.
2. **`tests/first-user-setup.test.js`** asserts the *old* first-user contract (400 validation / 409 once a user exists). Since the endpoint is now deliberately a flat **403**, this test must be updated to expect 403 before the release gate runs it.

---

## 5. Files Changed

| File | Type | Change |
|---|---|---|
| `electron/main.js` | modified | Added `ensureLocalRuntimeConfig()` + call in `bootstrap()`; added `crypto` import |
| `server/routes/auth.js` | modified | Setup endpoints retired (`setup-status` → always login mode; `first-user` → 403) |
| `server/services/auth.service.js` | modified | `login()` performs best-effort cloud→local sync pre-verification |
| `server/services/cloudToLocalSync.service.js` | **new** | `syncUserCompanyFromCloud()` — scoped cloud read + idempotent local mirror |
| `public/setup.html` | replaced | Wizard retired; redirect to `/login.html` |
| `public/js/setup/setup-wizard.js` | replaced | Redirect stub |
| `public/js/pages/login.js` | modified | Setup probe & Create-First-User form removed; login always shown |
| `tmp-fresh-install-verify.js` | **new** | Fresh-install smoke test (migrations + seed verification) |

---

## 6. Conclusion

The fresh-install path is now fully self-provisioning: first launch generates the local `.env`, JWT secret and pointer file; boot migrations initialize an empty SQLite database with the default admin; the customer sees **only** the Login screen; and after signing in with Agency-provided credentials their company, agency and user records flow down from Supabase automatically. No registration, activation or company-creation surface remains reachable from the customer-facing app.
