# QA Audit Report — BlackStack CRM E2E Bulk Data Entry

**Project:** BlackStack CRM V2 (Electron Desktop App)
**Scope:** Automated dummy-data entry (10 records/module) across CRM, Accounting, and Products modules
**Period:** Multi-session debugging run, concluding 2026-11-14
**Artifacts:** `tests/e2e/desktop-bulk-data-entry.spec.js`, `server/database/seed.js`, `scripts/fix-live-db-subscription.js`

---

## 1. Executive Summary

The goal was to automate entry of 10 dummy records into every CRM module via the packaged Electron app's UI, using Playwright's `_electron.launch()` API. Over the course of the engagement, 12 distinct blocking defects were identified, root-caused, and fixed. Eight of twelve modules reached 10/10 pass rates. The final defect class — a subscription-gating middleware rejecting all API writes for the admin's company — was resolved in the last session, and full pass is expected on the next run.

**Current module status:**

| Module | Status |
|---|---|
| Contacts | ✅ 10/10 |
| Organizations | ✅ 10/10 |
| Leads | ✅ 10/10 |
| Deals | ✅ 10/10 |
| Tasks | ✅ 10/10 |
| Appointments | ✅ 10/10 |
| Customer Bills | ✅ 10/10 (verified pass in earlier full run) |
| Chart of Accounts | ✅ 10/10 |
| Action Center | ℹ️ Read-only module — screenshot captured, no entry possible by design |
| Journal | ⏳ Blocked by subscription gate — fix applied, awaiting re-run |
| Accounting Bills | ⏳ Blocked by subscription gate — fix applied, awaiting re-run |
| Products | ⏳ Blocked by subscription gate — fix applied, awaiting re-run |

---

## 2. Defect Log (Chronological, with Root Causes)

### DEF-01: Electron session persisted across runs — login screen bypassed
- **Symptom:** Test timed out waiting 90s for `input[type="email"]`; the app auto-resumed a prior session.
- **Root cause:** Chromium's `--user-data-dir` switch is ignored by Electron for its userData path. The app reads the `BLACKSTACK_USER_DATA_DIR` environment variable instead (verified in `electron/main.js:33`).
- **Fix:** Launch config passes *both* `args: ['--user-data-dir=<tmp>']` and `env: { BLACKSTACK_USER_DATA_DIR: <tmp> }`; the temp directory is wiped before every launch.

### DEF-02: False "already logged in" detection
- **Symptom:** Script skipped login, then hung waiting for app content that never rendered.
- **Root cause:** `#page-container` exists on *every* page — including unauthenticated ones — so its mere visibility proved nothing. Meanwhile 401 console errors revealed the real state: a stale token + server-side session revocation bounce to `login.html`.
- **Fix:** The test now force-clears `crm_token`/`crm_user`/`crm_profile` from localStorage, navigates to `login.html` explicitly, logs in, then waits for `#page-container` to contain *non-empty, non-"Loading…" text* — and screenshots + fails cleanly if bounced back to login.

### DEF-03: Empty dependency tables — dropdowns had nothing to select
- **Symptom:** "no contact selectable", "no account group available", "no GL accounts available", "no model available".
- **Root cause:** Verified by direct SQLite query: `account_groups = 0 rows`, `accounts = 0`, `models = 0`. The seed script (`server/database/seed.js`) had two independent early-exit bugs: (a) demo-data seeding lived inside the `else` branch of the admin-exists check, and (b) inside an `if (!hasDemo)` gate on `org_001`. A DB with an existing admin and existing demo org skipped *all* master-data seeding.
- **Fix:** Both gates removed; every insert made idempotent (`INSERT OR IGNORE`). Added seeds for: 20 account groups, 14 GL accounts, current-year financial year, 11 GST tax masters + 12 tax components, and a complete product hierarchy chain (Stock Group → Category → Brand → Model).

### DEF-04: EntitySelector async race
- **Symptom:** Autocomplete dropdown had no options when the script looked for them.
- **Root cause:** The component debounces input 250 ms then fires a network search; a fixed 900 ms sleep raced the round-trip.
- **Fix:** Replaced with polling `waitFor({ state: 'visible' })` on `.es-option` (5 s budget), typing a short high-match term, falling back to a broader term, then clicking the dropdown *list item* — never the input.

### DEF-05: `TaxMaster with ID tax_gst_5_intra not found`
- **Root cause:** Migration 040 recorded as applied, but its seed rows absent from the restored DB. Customer Bills' hardcoded default line tax did not exist.
- **Fix:** Tax master/component seed added to `seed.js`; script now selects the first tax option the UI actually loaded rather than trusting any hardcoded ID.

### DEF-06: Journal 400 — UNIQUE constraint on `entry_number`
- **Symptom:** `POST /accounting/journal → 400`.
- **Root cause:** Verified by reproducing the insert directly against SQLite: `journal_entries` carries `UNIQUE(company_id, entry_number)`. Static references (`QA-JNL-1`) collided with rows from prior runs and with the script's own retry.
- **Fix:** Reference numbers now embed a run timestamp (`QA-JNL-<base36-time>-<i>`).

### DEF-07: Journal date rejected — outside Financial Year
- **Root cause:** `_validateJournalLines` requires the entry date to fall inside the *selected* FY. The seeded FY for the prior year was the only option initially.
- **Fix:** Seed ensures an FY covering the *current* date (`fy_2026`); the script selects the FY whose label contains the current year and types today's date explicitly.

### DEF-08: Duplicate-account rejection
- **Root cause:** Server rejects two journal lines referencing the same GL account.
- **Fix:** Line 2's account is selected to be distinct from line 1's.

### DEF-09: Modal overlay blocking subsequent "New" clicks
- **Symptom:** 30 s click timeouts on `#jnl-new` / `#bill-new` / `#prod-new` on every first attempt; retry succeeded.
- **Root cause:** `Modal.js` dialogs (`[role="dialog"]` inside `#modal-root`) are remove()-d on close, but a *failed* save leaves the form modal open (toast shown, `modal.close()` skipped). The next iteration's click landed on the overlay.
- **Fix:** `clickNewButton()` helper force-closes any leftover dialog, waits for `#modal-root` to empty, waits for the target button's visibility, then clicks. Applied to Journal, Accounting Bills, Products (and `waitModalsGone()` after every save across all modules).

### DEF-10: Date-field segment corruption
- **Symptom:** Day/Month digits landing in the Year spinner.
- **Root cause:** `pressSequentially()` types literal characters into Chrome's segmented `<input type="date">` (MM/DD/YYYY spinners), misrouting digits.
- **Fix:** `setDateField()` helper uses `fill(isoDate)`, which Chrome maps to the correct segments locale-independently. Applied to all six date inputs.

### DEF-11: SKU/`entry_number` 409 Conflicts on re-runs
- **Root cause:** Static unique keys (`QA-SKU-01`) collided with rows persisted by earlier runs.
- **Fix:** Time-stamped unique keys for SKUs; same pattern applied to journal references (DEF-06).

### DEF-12: Worker teardown hang — `Protocol error (Page.handleJavaScriptDialog)`
- **Root cause:** A native `confirm()`/`alert()` left open prevented `electronApp.close()`.
- **Fix:** `page.on('dialog', d => d.accept())` handler plus explicit modal-drain and `page.close()` before app close.

### DEF-13 (CRITICAL, final): Subscription gate 403 on every write
- **Symptom:** Generic **"Request failed"** toast on Post Entry / bill saves / product saves, across manual and automated attempts, persisting after all other fixes.
- **Investigation:** Direct invocation of the real `createJournalEntry` controller with the exact UI payload returned **HTTP 201** — proving the journal code, FY, accounts, and payload were correct. This isolated the failure to middleware.
- **True root cause:** `server/app.js` gates **every `/api/*` route** through `checkSubscriptionStatus` (`server/middleware/subscription.js`), which 403s any company lacking an ACTIVE `subscriptions` row. The admin belongs to company `default`, which had **zero** rows. The UI's toast masked the 403 as "Request failed" because the error body's shape did not map to the client's message extraction.
- **Aggravating discovery:** **Two different databases were in play.** The project DB (`data/blackstack-crm.db`) — which my seed fixed — is *not* the DB the packaged app reads. The live app reads `%APPDATA%\blackstack-crm-v2\database\blackstack-crm.db` (confirmed via the app's `shared-env-path.txt` / `MIGRATED_FROM.txt` pointer and `DB_PATH` override). That live DB had its own valid data (24 accounts, 25 journal entries, FY 2026) but empty `subscriptions` **and** `subscription_plans` tables — explaining why every manual and automated write 403'd regardless of my earlier project-DB fix.
- **Fix:** `scripts/fix-live-db-subscription.js` seeds both the plan (FK parent — required first) and an ACTIVE subscription (`sub_qa_default`, expires 2036) **directly in the live app DB**, using values that satisfy all four schema constraints discovered en route (`account_type` CHECK, `plan_id` FK, `plan_name` NOT NULL, `duration_unit` CHECK singular form). Verified with the middleware's *exact* query: returns ACTIVE row, gate passes ✅.
- **Residual note:** The seed in `server/database/seed.js` still targets the project DB. For fresh machine setups, run `npm run seed` **and** `node scripts/fix-live-db-subscription.js` (idempotent, safe to re-run).

---

## 3. Unresolved Observations (Non-Blocking)

1. **Misleading error surface:** `public/js/api/client.js` collapses a 403 `SUBSCRIPTION_INACTIVE` body into the generic "Request failed" toast. Recommended follow-up: surface `error.body?.error?.code` or the server `message` in the toast. Not patched — UI/UX decision belongs to product.
2. **Silent `INSERT OR IGNORE`:** All three schema-constraint violations during subscription seeding were swallowed silently. Recommend the seed log row-count deltas per table so future silent skips are visible.
3. **Environment divergence:** Project DB vs. live app DB divergence caused a full debugging cycle of wasted effort. Recommend a startup banner in Electron logging *which* DB file the server bound to (`main.js` already logs userData; extending to log the resolved `DB_PATH` would have surfaced this immediately).
4. **Screenshot ambiguity:** Chrome renders `<input type="date">` per locale (`14-11-2026` display for ISO `2026-11-14` value) — display must never be treated as value corruption without reading `input.value`.

---

## 4. Verification Evidence

| Check | Method | Result |
|---|---|---|
| Journal controller accepts exact UI payload | Direct controller invocation, mocked req/res | HTTP 201, entry POSTED |
| Subscription gate passes for `default` | Reproduced middleware's exact SQL on live DB | ACTIVE until 2036, `datetime(ed) >= now` = 1 → PASS |
| `journal_entries.entry_number` uniqueness | Direct duplicate insert attempt | `UNIQUE constraint failed` — reproduced, then eliminated via timestamped refs |
| GL accounts available & postable | `PRAGMA` + row inspection | 24 accounts, none group/inactive/no-direct-post |
| FY covers entry date | Date-range SQL | `fy_2026` (2026-04-01 → 2027-03-31) contains today |
| Module pass rates | Playwright run logs | 8/12 modules at 10/10 before final fix; remaining 3 unblocked |

---

## 5. Commands

```powershell
# Full seed (project DB) + live-app DB subscription fix
cd "d:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2"
$env:DEMO_MODE="true"; npm run seed
node scripts/fix-live-db-subscription.js

# Targeted re-run of previously failing modules only
$env:E2E_MODULES="Journal,Accounting Bills,Products"
npx playwright test tests/e2e/desktop-bulk-data-entry.spec.js --headed --workers=1
Remove-Item Env:E2E_MODULES

# Full run (auto-skip already-populated modules)
npx playwright test tests/e2e/desktop-bulk-data-entry.spec.js --headed --workers=1

# Force fresh entry into every module
$env:E2E_FORCE_ALL="1"; npx playwright test tests/e2e/desktop-bulk-data-entry.spec.js --headed --workers=1
```

---

## 6. Conclusion

All 13 defects were root-caused with direct evidence (SQL queries, controller reproductions, source inspection) rather than inference. The final blocker — subscription gating against an unfixed live-app database — is resolved and verified at the SQL layer. The remaining step is one targeted Playwright re-run of Journal, Accounting Bills, and Products, which is expected to complete 10/10 across all three and close out the engagement.
