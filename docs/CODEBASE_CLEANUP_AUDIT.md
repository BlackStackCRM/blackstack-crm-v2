# Codebase Cleanup Audit — Phase 1 (Discovery Only)
## Black Stack CRM V2
**Project path:** `D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2`
**Audit date:** 2026-09-20
**Mode:** DISCOVERY ONLY — NO files deleted, moved, renamed, modified, or refactored.

---

## 1. Executive Summary

**Total files scanned (main project, excluding `node_modules`):** 475
**Total cleanup candidates identified:** ~170 distinct items across categories

> The broader `D:\Work\Projects\blackstack` root also contains a backup directory (`blackstack-crm-v2_BACKUP_pre_electron_2026-02-14`, 321 files), an old HTML-only CRM (`blackstack-crm`, 10 files), and root-level `serverui/` (12 files). These are audited in their own sections.

### Classification Breakdown

| Classification | Count | Description |
|---|---|---|
| **SAFE TO REMOVE** (HIGH conf.) | ~45 | No references anywhere, clearly temporary/obsolete |
| **REVIEW** | ~35 | Potentially removable but needs human verification |
| **DUPLICATE** | ~28 | Functionality exists elsewhere; both retained pending review |
| **LEGACY** | ~35 | Old implementations superseded by newer ones |
| **DEAD CODE** | ~30 items | Unreachable methods/functions/constants |
| **KEEP** | ~200 | Active production code |
| **KEEP — HISTORICAL** | ~55 | Migrations, backup databases, audit docs |
| **UNKNOWN** | ~5 | Insufficient evidence to classify |

---

## 2. File Cleanup Candidates

### 2.1 Root-Level Temporary / Debug Files

| Path | Classification | Reason | Evidence | Confidence |
|---|---|---|---|---|
| `.tmp_create_page_method.js` (64 KB) | **REVIEW** | Development scratch file for customer-bills page creation UI | Only referenced by `.tmp_fix.py` and `.tmp_insert.py`; NOT referenced by `app.js`, `vitest.config.js`, or any route | MEDIUM |
| `.tmp_syntax_check.js` (64 KB) | **SAFE TO REMOVE** | Appears to be a copy of `.tmp_create_page_method.js` for syntax checking | No references found by any code, config, or test; 64,440 bytes vs 64,391 bytes in source file | HIGH |
| `.tmp_fix.py` | **REVIEW** | Python script for fixing `.tmp_create_page_method.js` | References `.tmp_create_page_method.js`; not run by any package script; not part of build/test pipeline | MEDIUM |
| `.tmp_fix_commas.py` | **REVIEW** | Python script for fixing commas in `.tmp_create_page_method.js` | References `.tmp_create_page_method.js`; not run by any package script | MEDIUM |
| `.tmp_insert.py` | **REVIEW** | Python script for inserting code into `.tmp_create_page_method.js` | References `.tmp_create_page_method.js`; not run by any package script | MEDIUM |
| `persist_audit_final.py` | **REVIEW** | Standalone audit script (not a test) | References `_token.txt` for auth; standalone HTTP-based audit; not in `vitest.config.js` include; not in package scripts | MEDIUM |
| `phase2_audit.py` | **REVIEW** | Standalone audit Python script | Same pattern as `persist_audit_final.py`; not in test config or package scripts | MEDIUM |
| `test_calc.cjs` | **REVIEW** | Standalone calculation test for customer-bill totals | Standalone Node script; not in package scripts; not in vitest config; tests `CustomerBillService.calculateTotals()` directly | MEDIUM |
| `tmp_seed.cjs` | **REVIEW** | Temporary seed script for role permissions | Standalone; seeds role_permissions for role_manager and role_user; `seed.js` is the official seed script | MEDIUM |
| `tmp-check.js` | **REVIEW** | Temporary DB connectivity check | Checks counts for contacts, organizations, deals, tasks, invoices, activities; standalone, not in package scripts | MEDIUM |

### 2.2 Root-Level Log Files

All log files at project root are gitignored (`*.log` pattern in `.gitignore`):

| Path | Classification | Reason | Evidence | Confidence |
|---|---|---|---|---|
| `crm-run.log` (2 MB) | **REVIEW** | Large runtime log | Not referenced by code; runtime log output; gitignored | MEDIUM |
| `crm-run.err.log` | **REVIEW** | Error log | Not referenced; gitignored | MEDIUM |
| `server.log` (269 KB) | **REVIEW** | Server runtime log | Not referenced; gitignored | MEDIUM |
| `server.err.log` | **REVIEW** | Server error log | Not referenced; gitignored | MEDIUM |
| `debug.log` | **REVIEW** | Debug log | Not referenced; gitignored | MEDIUM |
| `launcher.log` | **REVIEW** | Launcher log | Not referenced; gitignored | MEDIUM |
| `test-run.log` | **REVIEW** | Test run log | Not referenced; gitignored | MEDIUM |
| `ui-result.log` | **REVIEW** | UI test result log | Not referenced; gitignored | MEDIUM |
| `probe-out.log` | **REVIEW** | Probe script output | Not referenced; gitignored | MEDIUM |
| `probe2-out.log` | **REVIEW** | Probe script output | Not referenced; gitignored | MEDIUM |

### 2.3 Root-Level QA/MJS Scripts

| Path | Classification | Reason | Evidence | Confidence |
|---|---|---|---|---|
| `qa-coa.mjs` | **REVIEW** | QA script for Chart of Accounts (uses puppeteer) | Not in package scripts; not in vitest config; standalone script | MEDIUM |
| `qa-run-step6-final.mjs` | **REVIEW** | QA script for Step 6 (final run) | Not in package scripts; standalone | MEDIUM |
| `qa-step6.mjs` | **REVIEW** | QA script for Step 6 | Not in package scripts; standalone | MEDIUM |
| `qa-step6b.mjs` | **REVIEW** | QA script for Step 6 (variant b) | Not in package scripts; standalone | MEDIUM |
| `qa-step6d.mjs` | **REVIEW** | QA script for Step 6 (variant d) | Not in package scripts; standalone | MEDIUM |
| `qa-step6-final.mjs` | **REVIEW** | QA script for Step 6 (final) | Not in package scripts; standalone | MEDIUM |

### 2.4 Root-Level Miscellaneous Files

| Path | Classification | Reason | Evidence | Confidence |
|---|---|---|---|---|
| `_token.txt` (411 bytes) | **REVIEW** | JWT token for API testing | Referenced by `persist_audit_final.py` (via `get_token()` function); NOT referenced by any production code; contains live auth token | MEDIUM |
| `coa-after.png` | **KEEP — HISTORICAL** | Screenshot of Chart of Accounts after implementation | Referenced in `IMPLEMENTATION_REPORT.md` (audit docs); 140 KB | LOW (keep as historical evidence) |
| `coa-after2.png` | **KEEP — HISTORICAL** | Screenshot variant | Same as above; audit documentation | LOW |
| `reset-modal.png` | **KEEP — HISTORICAL** | Screenshot of reset confirmation modal | UI audit evidence | LOW |
| `ui-contact-form.png` | **KEEP — HISTORICAL** | Screenshot of contact form UI | UI audit evidence | LOW |
| `ui-deal-form.png` | **KEEP — HISTORICAL** | Screenshot of deal form UI | UI audit evidence | LOW |
| `ui-lead-form.png` | **KEEP — HISTORICAL** | Screenshot of lead form UI | UI audit evidence | LOW |
| `test-out.txt` | **REVIEW** | Test output text file | Not in package scripts; standalone output | MEDIUM |
| `.step17_progress.md` | **REVIEW** | Progress notes for step 17 | Not referenced by code; internal notes; could be moved to docs/ or archived | MEDIUM |

### 2.5 Test Debug/Temporary Scripts (in `tests/`)

Files prefixed with `_` in `tests/` are clearly temporary debugging/investigation scripts:

| Path | Classification | Reason | Evidence | Confidence |
|---|---|---|---|---|
| `tests/_bs_clean.js` | **REVIEW** | Balance sheet debug script | Not matched by `tests/**/*.test.js` vitest include pattern; standalone | MEDIUM |
| `tests/_bs_detail.js` | **REVIEW** | Balance sheet detail debug | Not a vitest test; standalone | MEDIUM |
| `tests/_bs_diag.js` | **REVIEW** | Balance sheet diagnostic | Not a vitest test; standalone | MEDIUM |
| `tests/_bs_e2e.js` | **REVIEW** | Balance sheet E2E debug | Not a vitest test; standalone | MEDIUM |
| `tests/_bs_exact.js` | **REVIEW** | Balance sheet exact match debug | Not a vitest test; standalone | MEDIUM |
| `tests/_bs_repo_direct.js` | **REVIEW** | Balance sheet repo direct debug | Not a vitest test; standalone | MEDIUM |
| `tests/_bs_with_jes.js` | **REVIEW** | Balance sheet with jest debug | Not a vitest test; standalone | MEDIUM |
| `tests/_check.js` | **REVIEW** | Debug check script | Not a vitest test; standalone | MEDIUM |
| `tests/_check_db.js` | **REVIEW** | DB check debug | Not a vitest test; standalone | MEDIUM |
| `tests/_check_fk.js` | **REVIEW** | Foreign key check debug | Not a vitest test; standalone | MEDIUM |
| `tests/_check_je.js` | **REVIEW** | Journal entry check debug | Not a vitest test; standalone | MEDIUM |
| `tests/_check_je2.js` | **REVIEW** | Journal entry check debug (v2) | Not a vitest test; standalone | MEDIUM |
| `tests/_check_ob.js` | **REVIEW** | Opening balance check | Not a vitest test; standalone | MEDIUM |
| `tests/_check_refs.js` | **REVIEW** | References check | Not a vitest test; standalone | MEDIUM |
| `tests/_check_seed.js` | **REVIEW** | Seed check | Not a vitest test; standalone | MEDIUM |
| `tests/_check_tax_maps.js` | **REVIEW** | Tax maps check | Not a vitest test; standalone | MEDIUM |
| `tests/_cleanup_db.js` | **REVIEW** | DB cleanup debug | Not a vitest test; standalone | MEDIUM |
| `tests/_cleanup_db2.js` | **REVIEW** | DB cleanup debug (v2) | Not a vitest test; standalone | MEDIUM |
| `tests/_cleanup_test.js` | **REVIEW** | Test cleanup debug | Not a vitest test; standalone | MEDIUM |
| `tests/_cols.js` | **REVIEW** | Column inspection debug | Not a vitest test; standalone | MEDIUM |
| `tests/_debug_calc.js` | **REVIEW** | Calculation debug | Not a vitest test; standalone | MEDIUM |
| `tests/_drycheck.js` | **REVIEW** | Dry run check | Not a vitest test; standalone | MEDIUM |
| `tests/_drycheck2.js` | **REVIEW** | Dry run check (v2) | Not a vitest test; standalone | MEDIUM |
| `tests/_find_fks.js` | **REVIEW** | Find foreign keys debug | Not a vitest test; standalone | MEDIUM |
| `tests/_find_refs.js` | **REVIEW** | Find references debug | Not a vitest test; standalone | MEDIUM |
| `tests/_fks3.js` | **REVIEW** | Foreign key check (v3) | Not a vitest test; standalone | MEDIUM |
| `tests/_fix_balance_sheet.py` | **REVIEW** | Fix balance sheet (Python) | Not a vitest test; standalone; uses sqlite3 to fix DB directly | MEDIUM |
| `tests/_fix_bs2.py` | **REVIEW** | Fix balance sheet (v2) | Not a vitest test; standalone | MEDIUM |
| `tests/_fix_bs3.py` | **REVIEW** | Fix balance sheet (v3) | Not a vitest test; standalone | MEDIUM |
| `tests/debug_bs.js` | **REVIEW** | Balance sheet debug | Not a vitest test; standalone | MEDIUM |
| `tests/debug_bs2.js` | **REVIEW** | Balance sheet debug (v2) | Not a vitest test; standalone | MEDIUM |
| `tests/debug_bs3.js` | **REVIEW** | Balance sheet debug (v3) | Not a vitest test; standalone | MEDIUM |
| `tests/debug_contact.js` | **REVIEW** | Contact debug | Not a vitest test; standalone | MEDIUM |
| `tests/debug_fy.js` | **REVIEW** | Financial year debug | Not a vitest test; standalone | MEDIUM |
| `tests/debug_getbill.js` | **REVIEW** | Get bill debug | Not a vitest test; standalone | MEDIUM |
| `tests/debug_tax_persist.js` | **REVIEW** | Tax persistence debug | Not a vitest test; standalone | MEDIUM |
| `tests/debug_token.js` | **REVIEW** | Token debug | Not a vitest test; standalone | MEDIUM |
| `tests/verify_bill_db.js` | **REVIEW** | Bill DB verification | Not a vitest test; standalone | MEDIUM |
| `tests/verify_bill_tax.js` | **REVIEW** | Bill tax verification | Not a vitest test; standalone | MEDIUM |
| `tests/verify_bills_e2e.js` | **REVIEW** | Bill E2E verification | Not a vitest test; standalone | MEDIUM |
| `tests/verify_gst.js` | **REVIEW** | GST verification | Not a vitest test; standalone | MEDIUM |
| `tests/verify_gst2.js` | **REVIEW** | GST verification (v2) | Not a vitest test; standalone | MEDIUM |
| `tests/verify_je.js` | **REVIEW** | Journal entry verification | Not a vitest test; standalone | MEDIUM |
| `tests/verify_lifecycle.js` | **REVIEW** | Lifecycle verification | Not a vitest test; standalone | MEDIUM |
| `tests/verify_lifecycle2.js` | **REVIEW** | Lifecycle verification (v2) | Not a vitest test; standalone | MEDIUM |
| `tests/verify_payment.js` | **REVIEW** | Payment verification | Not a vitest test; standalone | MEDIUM |
| `tests/audit-journal-correction.js` | **REVIEW** | Journal entry correction debug | Not a vitest test; standalone | MEDIUM |
| `tests/audit-journal-investigation.js` | **REVIEW** | Journal entry investigation | Not a vitest test; standalone | MEDIUM |
| `tests/integration-customer-bills.js` | **REVIEW** | Customer bills integration debug | Not a vitest test; standalone | MEDIUM |
| `tests/contact-centric.e2e.js` | **REVIEW** | Contact-centric E2E | Not a vitest test; standalone | MEDIUM |
| `tests/reset-crm-data.integration.test.js` | **KEEP** | Vitest test (but excluded) | Matches `tests/**/*.test.js` but EXCLUDED in vitest.config.js; however it is a legitimate test file that tests DB reset | HIGH (keep — legitimate test) |
| `tests/persistence.e2e.js` | **REVIEW** | E2E persistence test | Not matched by vitest include pattern (`tests/**/*.test.js`); standalone script | MEDIUM |

### 2.6 Root-Level Test Databases (Temporary)

| Path | Classification | Reason | Evidence | Confidence |
|---|---|---|---|---|
| `test-cb-*.sqlite` (8 files × 3) = 24 files | **REVIEW** | Temporary test databases from test runs | Named with epoch timestamp pattern; not referenced by any code; 8 sets of .sqlite/.sqlite-shm/.sqlite-wal files | MEDIUM |
| `tests/test-debug3.sqlite` + shm/wal | **REVIEW** | Debug database (3 files) | Not referenced in test code; gitignored pattern | MEDIUM |
| `tests/test-debug4.sqlite` + shm/wal | **REVIEW** | Debug database (3 files) | Not referenced in test code; gitignored pattern | MEDIUM |
| `data/blackstack-crm.db` | **KEEP** | Main application database | Actively used by app via DB_PATH | HIGH |
| `data/blackstack-crm-v2.db` | **REVIEW** | Second database file | 1532 KB; may be a stale or alternate DB; not in .env default path | MEDIUM |
| `data/blackstack-crm.db.DIRTY-BACKUP-1789882394` | **KEEP — HISTORICAL** | Pre-cleanup backup of DB | Named as backup; 7.4 MB; 7484 KB | HIGH |
| `data/blackstack-crm.db.PRE-AUDIT-BACKUP-1789215213` | **KEEP — HISTORICAL** | Pre-audit backup | 1.4 MB | HIGH |
| `data/blackstack-crm.db.bak.1789214252` (+shm, -wal) | **KEEP — HISTORICAL** | Timestamped backup | 1.4 MB + 32 KB + 0 KB | HIGH |
| `server/database/dev.db` (0 KB) | **REVIEW** | Empty development database | 0 bytes; may be a stale artifact; not referenced by .env (DB_PATH=./data/blackstack-crm.db) | MEDIUM |

### 2.7 Server UI (serverui/) Directory

The `serverui/` directory is loaded as a separate Electron secondary process. It has its own `package.json` and `control-server.js`.

| Path | Classification | Reason | Evidence | Confidence |
|---|---|---|---|---|
| `serverui/` (entire directory) | **REVIEW** | Electron control server UI | Not referenced by root `package.json` scripts; not imported from `server/app.js`; separate Electron secondary window; may be an abandoned parallel implementation | MEDIUM |
| `serverui/control-server.js` | **REVIEW** | Control server IPC handler (47 KB) | Not referenced from root `app.js`; not loaded by Electron main; see full directory assessment above | MEDIUM |
| `serverui/package.json` | **REVIEW** | Server UI package manifest | Not referenced by root `package.json` or `app.js` | MEDIUM |

### 2.8 Scripts Directory

| Path | Classification | Reason | Evidence | Confidence |
|---|---|---|---|---|
| `scripts/check_dn.js` | **REVIEW** | Debit/credit note check script | Not in package.json scripts; standalone | MEDIUM |
| `scripts/check_migration.js` | **REVIEW** | Migration check script | Not in package.json scripts; standalone | MEDIUM |
| `scripts/clean-test-data.js` | **REVIEW** | Test data cleanup | Not in package.json scripts; not in vitest config; standalone | MEDIUM |
| `scripts/clean-test-data-and-restore.js` | **REVIEW** | Test data cleanup + restore | Not in package.json scripts; standalone | MEDIUM |
| `scripts/db-audit.js` | **REVIEW** | DB audit script | Not in package.json scripts; standalone | MEDIUM |
| `scripts/restore-coA.js` | **REVIEW** | Chart of Accounts restore | Not in package.json scripts; standalone | MEDIUM |
| `scripts/smoke_deletion_service.cjs` | **REVIEW** | Smoke test for deletion service | Not in package.json scripts; standalone | MEDIUM |
| `scripts/smoke_http.cjs` | **REVIEW** | HTTP smoke test | Not in package.json scripts; standalone | MEDIUM |
| `scripts/verify_delete_safety_migration.cjs` | **REVIEW** | Migration verification | Not in package.json scripts; standalone | MEDIUM |

### 2.9 Bridge Directory

| Path | Classification | Reason | Evidence | Confidence |
|---|---|---|---|---|
| `bridge/` (entire directory, empty) | **KEEP** | Empty directory | 0 files; may be an empty placeholder | LOW |

### 2.10 Setup File Directory

| Path | Classification | Reason | Evidence | Confidence |
|---|---|---|---|---|
| `setup file/` (entire directory) | **REVIEW** | Legacy setup/installation files | Separate from main `setup/` directory; contains `setup.bat`, `setup.js`, `setup.nsi`, `setup.iss`, `build-setup.bat`, `build-portable.bat`, `README.md`; NOT the same as root-level `setup.bat`/`setup.js` | MEDIUM |

### 2.11 Root-Level Setup/Batch Files

| Path | Classification | Reason | Evidence | Confidence |
|---|---|---|---|---|
| `setup.bat` | **KEEP** | Setup script (root level) | Referenced in README.md Quick Start (`npm run migrate` is the modern way, but setup.bat is the Windows installer script) | HIGH |
| `setup.js` | **KEEP** | Setup script (root level) | Referenced in `setup.bat`; runs migrations, seeds DB, verifies install | HIGH |
| `start-launcher.bat` | **REVIEW** | Launcher startup script | Not referenced in README.md; not in package.json scripts; the launcher may be the Electron main process | MEDIUM |
| `launcher/app.js` | **REVIEW** | Launcher server entry point | Referenced by package.json `launcher` script; but the actual server entry is `server/app.js`; unclear if launcher is still used | MEDIUM |

### 2.12 Images Directory

| Path | Classification | Reason | Evidence | Confidence |
|---|---|---|---|---|
| `public/images/` | **KEEP — HISTORICAL** | Static images | Referenced by HTML/CSS; check for unused assets | MEDIUM |

### 2.13 Root-Level `.hermes/plans/`

| Path | Classification | Reason | Evidence | Confidence |
|---|---|---|---|---|
| `.hermes/plans/customer-bills-implementation.md` | **KEEP** | Implementation plan | Hermes plan file; not code; internal tool state | HIGH |

---

## 3. Dead / Unused Methods

### 3.1 Orphaned Singular Controllers (Backend)

The following singular controllers exist but are NOT referenced by any route file or any other file in the project. They are superseded by their plural counterparts.

| File | Module | Classification | References | Replacement | Confidence |
|---|---|---|---|---|---|
| `server/controllers/activity.controller.js` | `ActivityController` | **DEAD CODE** | Only in `.md` audit docs | `activities.controller.js` | HIGH |
| `server/controllers/contact.controller.js` | `ContactController` | **DEAD CODE** | None | `contacts.controller.js` | HIGH |
| `server/controllers/deal.controller.js` | `DealController` | **DEAD CODE** | Only in `.md` audit docs | `deals.controller.js` | HIGH |
| `server/controllers/note.controller.js` | `NoteController` | **DEAD CODE** | None | `notes.controller.js` | HIGH |
| `server/controllers/organization.controller.js` | `OrganizationController` | **DEAD CODE** | None | `organizations.controller.js` | HIGH |
| `server/controllers/pipeline.controller.js` | `PipelineController` | **DEAD CODE** | None | `pipelines.controller.js` | HIGH |
| `server/controllers/product.controller.js` | `ProductController` | **DEAD CODE** | None | `products.controller.js` | HIGH |
| `server/controllers/task.controller.js` | `TaskController` | **DEAD CODE** | None | `tasks.controller.js` | HIGH |
| `server/controllers/user.controller.js` | `UserController` | **DEAD CODE** | None | `users.controller.js` | HIGH |
| `server/controllers/workflow.controller.js` | `WorkflowController` | **DEAD CODE** | None | `workflows.controller.js` | HIGH |
| `server/controllers/relationship.controller.js` | `RelationshipController` | **DEAD CODE** | None | `relationships.controller.js` | HIGH |
| `server/controllers/report.controller.js` | `ReportController` | **DEAD CODE** | None | `reports.controller.js` | HIGH |

> **Note:** `invoice.controller.js` and `payment.controller.js` (singular) ARE actively used — `invoices.js` route requires `invoice.controller` and `payments.js` route requires `payment.controller`. These are NOT orphaned.

### 3.2 Orphaned Singular Services (Backend)

The following singular services exist but are NOT referenced by any controller, route, test, or other service (outside their own directory).

| File | Module | Classification | References | Replacement | Confidence |
|---|---|---|---|---|---|
| `server/services/activity.service.js` | `ActivityService` | **DEAD CODE** | None | None (replaced by inline logic in `activities.controller.js`) | HIGH |
| `server/services/audit.service.js` | `AuditService` | **DEAD CODE** | None | `audit.repository.js` (used directly by `accounting-coa.service.js`) | MEDIUM |
| `server/services/contact.service.js` | `ContactService` | **DEAD CODE** | Only referenced within `search.service.js` | `contacts.controller.js` (uses `contact.repository.js` directly) | MEDIUM |
| `server/services/dashboard.service.js` | `DashboardService` | **DEAD CODE** | Only referenced within itself | `dashboard.controller.js` (uses repositories directly) | MEDIUM |
| `server/services/note.service.js` | `NoteService` | **DEAD CODE** | Only referenced within `note.repository.js` | `notes.controller.js` (uses `note.repository.js` directly) | MEDIUM |
| `server/services/pipeline.service.js` | `PipelineService` | **DEAD CODE** | Only referenced within `pipeline.repository.js` | `pipelines.controller.js` (uses `pipeline.repository.js` directly) | MEDIUM |
| `server/services/product.service.js` | `ProductService` | **DEAD CODE** | Only referenced within `product.repository.js` and `search.service.js` | `products.controller.js` (uses `product.repository.js` directly) | MEDIUM |
| `server/services/relationship.service.js` | `RelationshipService` | **DEAD CODE** | Only referenced within `relationship.repository.js` | `relationships.controller.js` (uses `relationship.repository.js` directly) | MEDIUM |
| `server/services/report.service.js` | `ReportService` | **DEAD CODE** | None | `reports.controller.js` (uses `reporting.repository.js` directly) | MEDIUM |
| `server/services/settings.service.js` | `SettingsService` | **DEAD CODE** | None | `settings.controller.js` (uses `user.repository.js` directly) | HIGH |
| `server/services/task.service.js` | `TaskService` | **DEAD CODE** | None | `tasks.controller.js` (uses `task.repository.js` directly) | MEDIUM |
| `server/services/user.service.js` | `UserService` | **DEAD CODE** | None | `users.controller.js` (uses `user.repository.js` directly) | MEDIUM |
| `server/services/workflow.service.js` | `WorkflowService` | **DEAD CODE** | None | `workflows.controller.js` (uses `workflow.repository.js` directly) | MEDIUM |

### 3.3 Orphaned Accounting Services

| File | Module | Classification | References | Replacement | Confidence |
|---|---|---|---|---|---|
| `server/services/accounting-extended.service.js` | `AccountingExtendedService` | **LEGACY** | Only in docs (`STEP_13_IMPLEMENTATION_REPORT.md`); requires `accounting-engine.service` but is not on the active call path | Functionality appears in `accounting.controller.js` (which uses `account-group.service` directly) | HIGH |
| `server/services/accounting-main.service.js` | Facade aggregating `accounting-engine`, `accounting-coa`, `receivable-payable`, `accounting-masters`, `accounting-reports` | **LEGACY** | Only referenced by `accounting-coa.service.js` (internal chain); NOT required by `accounting.controller.js` | `accounting.controller.js` uses individual services directly | HIGH |
| `server/services/tax-calculation-engine.js` | Tax calculation engine | **KEEP** (active) | Referenced by `accounting.controller.js` AND `customer-bill.controller.js` | Active on both call paths | HIGH |

### 3.4 Unreferenced Repositories

| File | Classification | References | Confidence |
|---|---|---|---|
| `server/repositories/base.repository.js` | **DEAD CODE** | Not referenced by any file | HIGH |
| `server/repositories/customer.repository.js` | **DEAD CODE** | Not referenced by any file (but `customers.controller.js` exists and is used) | MEDIUM — check if `customers.controller.js` uses it |
| `server/repositories/financial-year.repository.js` | **DEAD CODE** | Not referenced by any file | MEDIUM |
| `server/repositories/appointment.repository.js` | **DEAD CODE** | Not referenced by any file (but `appointments.controller.js` exists and is used) | MEDIUM |
| `server/repositories/payable.repository.js` | **DEAD CODE** | Only referenced in docs | MEDIUM |
| `server/repositories/lead.repository.js` | **DEAD CODE** | Not referenced by any file | MEDIUM |

### 3.5 Frontend: Orphaned Page Modules

| File | Module | Classification | References | Confidence |
|---|---|---|---|---|
| `public/js/pages/pipeline.js` | `PageModules.pipeline` | **DEAD CODE** | Loaded in `index.html` but NOT in app.js route table; NOT in Sidebar nav; 3,951 lines | HIGH |
| `public/js/pages/reports.js` | `PageModules.reports` | **DEAD CODE** | Loaded in `index.html` AFTER `accounting-reports.js`; overrides `accounting-reports.js`'s `PageModules.reports` registration; the route `#reports` dispatches to `PageModules.reports` which is this file | MEDIUM — potential conflict; `accounting-reports.js` is the intended accounting reports page |
| `public/js/pages/accounting-reports.js` | `PageModules.reports` (overridden) | **DEAD CODE** | Registers `PageModules.reports` BUT is overridden by `reports.js` which loads later in `index.html`; accounting.js dispatch targets `'accounting-reports'` module name, but accounting-reports.js registers as `'reports'` (not `'accounting-reports'`) | HIGH |
| `public/js/pages/invoices.js` | `PageModules.invoices` | **DEAD CODE** | Legacy compatibility shim; redirects to `#accounting/bills`; loaded in index.html but route `#invoices` maps to module `'accounting'` (not `'invoices'`) | MEDIUM |
| `public/js/pages/payments.js` | `PageModules.payments` | **DEAD CODE** | Legacy compatibility shim; redirects to `#accounting/receivables`; route `#payments` maps to module `'accounting'` | MEDIUM |

> **Note:** `invoices.js` and `payments.js` ARE loaded in `index.html` and their redirect shims may be reached via bookmarked `#invoices` or `#payments` hashes. They are **LEGACY compatibility shims**, not true dead code. Keep until confirmed no users have bookmarked these hashes.

### 3.6 Frontend: Unused Component / Asset Files

To be investigated further in the detailed frontend audit (see Section 7).

---

## 4. Duplicate Implementations

| Current | Suspected Duplicate | Evidence | Recommendation |
|---|---|---|---|
| `server/controllers/contacts.controller.js` | `server/controllers/contact.controller.js` | Routes use `contacts.controller`; singular has 0 route references | **DEAD CODE** |
| `server/controllers/deals.controller.js` | `server/controllers/deal.controller.js` | Routes use `deals.controller`; singular has 0 route references | **DEAD CODE** |
| `server/controllers/notes.controller.js` | `server/controllers/note.controller.js` | Routes use `notes.controller`; singular has 0 route references | **DEAD CODE** |
| `server/controllers/organizations.controller.js` | `server/controllers/organization.controller.js` | Routes use `organizations.controller`; singular has 0 route references | **DEAD CODE** |
| `server/controllers/pipelines.controller.js` | `server/controllers/pipeline.controller.js` | Routes use `pipelines.controller`; singular has 0 route references | **DEAD CODE** |
| `server/controllers/products.controller.js` | `server/controllers/product.controller.js` | Routes use `products.controller`; singular has 0 route references | **DEAD CODE** |
| `server/controllers/tasks.controller.js` | `server/controllers/task.controller.js` | Routes use `tasks.controller`; singular has 0 route references | **DEAD CODE** |
| `server/controllers/users.controller.js` | `server/controllers/user.controller.js` | Routes use `users.controller`; singular has 0 route references | **DEAD CODE** |
| `server/controllers/workflows.controller.js` | `server/controllers/workflow.controller.js` | Routes use `workflows.controller`; singular has 0 route references | **DEAD CODE** |
| `server/controllers/reports.controller.js` | `server/controllers/report.controller.js` | Routes use `reports.controller`; singular has 0 route references | **DEAD CODE** |
| `server/controllers/relationships.controller.js` | `server/controllers/relationship.controller.js` | Routes use `relationships.controller`; singular has 0 route references | **DEAD CODE** |
| `server/controllers/activities.controller.js` | `server/controllers/activity.controller.js` | Routes use `activities.controller`; singular has 0 route references | **DEAD CODE** |
| `server/services/accounting-extended.service.js` | Accounting logic in `accounting.controller.js` + `account-group.service.js` | `accounting-extended` requires `accounting-engine` but is not on active call path; controller uses `account-group.service` directly | **LEGACY** |
| `server/services/accounting-main.service.js` | Direct service imports in `accounting.controller.js` | `accounting-main` is a facade that is only used by `accounting-coa.service.js`; not used by controller | **LEGACY** |
| `server/services/accounting-masters.service.js` | Direct repository access in `accounting.controller.js` | `accounting-masters` is only used by `accounting-main.service.js` (which is itself legacy); controller uses repositories directly | **LEGACY** |
| `server/services/accounting-reports.service.js` | Direct repository access in `accounting.controller.js` | Same pattern — only used by `accounting-main.service.js`; controller accesses `journal-entry.repository.js` directly | **LEGACY** |
| `server/services/receivable-payable.service.js` | Direct repository access in `customer-bill.controller.js` + `accounting.controller.js` | `receivable-payable.service` is only used by `accounting-main.service.js` (legacy facade); active code path uses `customer-bill.service.js` and direct repo access in `accounting.controller.js` | **LEGACY** |
| `public/js/pages/reports.js` | `public/js/pages/accounting-reports.js` | Both register `PageModules.reports`; `reports.js` loads last and overrides `accounting-reports.js`; accounting.js expects module name `'accounting-reports'` but neither file registers that name | **DEAD CODE** (reports.js) / **BROKEN** (accounting-reports.js) |
| `public/index.html` | `serverui/public/dashboard.html` | Main project has full SPA index.html (11,251 chars); serverui has a 223-byte stub dashboard | **DUPLICATE** |
| `public/js/app.js` | `serverui/control-server.js` (47,483 chars) | Both contain Electron/CRM coordination logic; serverui is separate Electron process | **REVIEW** — separate process, may be intentional |
| `data/blackstack-crm.db` | `data/blackstack-crm-v2.db` | Two database files; `.env` uses `blackstack-crm.db` | **REVIEW** — check if v2.db is actively used |
| `setup.bat` (root) | `setup file/setup.bat` | Both are setup scripts at different locations | **DUPLICATE** — `setup file/` appears to be a distributable copy |

---

## 5. Legacy Implementations

| Legacy Path | Current Replacement | Evidence | Confidence |
|---|---|---|---|
| `public/js/pages/invoices.js` | `public/js/pages/accounting.js` (with `bills` dispatch) | Contains explicit "LEGACY COMPATIBILITY SHIM" comment; redirects `#invoices` → `#accounting/bills`; route `#invoices` maps to module `'accounting'` in app.js | HIGH |
| `public/js/pages/payments.js` | `public/js/pages/accounting.js` (with `receivables` dispatch) | Contains "LEGACY COMPATIBILITY SHIM" comment; redirects `#payments` → `#accounting/receivables`; route `#payments` maps to module `'accounting'` | HIGH |
| `public/js/pages/pipeline.js` | `public/js/pages/deals.js` | 3,951 lines; registers `PageModules.pipeline` but no route dispatches to it; not in Sidebar nav; Pipeline functionality is likely in `deals.js` | HIGH |
| `server/controllers/invoice.controller.js` | `server/controllers/customer-bill.controller.js` | Singular `invoice.controller.js` is used by `invoices.js` route, but the accounting migration (migration 025) migrated invoice data to accounting schema; newer customer-bill flows use `customer-bill.controller.js` | MEDIUM — both are active but for different workflows |
| `server/controllers/payment.controller.js` | Accounting payment flows via `accounting.controller.js` | `payment.controller.js` used by `payments.js` route but invoices/payments are increasingly routed through accounting; migration 025, 032, 033 show accounting-based payment recording | MEDIUM — both active |
| `server/services/accounting-extended.service.js` | `server/services/account-group.service.js` + `server/services/tax-calculation-engine.js` | `accounting-extended` not on active controller call path; only referenced in docs; controller uses `account-group.service` and `tax-calculation-engine` directly | HIGH |
| `server/services/accounting-main.service.js` | `server/controllers/accounting.controller.js` (direct service usage) | `accounting-main` is a facade not required by the controller; only used internally by `accounting-coa.service.js` | HIGH |
| `server/services/accounting-coa.service.js` | `server/services/account-group.service.js` | `accounting-coa` is only used by `accounting-main.service.js` (itself legacy); the active path goes through `account-group.service` | HIGH |
| `server/services/accounting-masters.service.js` | Direct repository access in `accounting.controller.js` | Only used by `accounting-main.service.js`; controller uses repositories directly | HIGH |
| `server/services/accounting-reports.service.js` | Direct repository access in `accounting.controller.js` | Only used by `accounting-main.service.js`; controller uses repositories directly | HIGH |
| `server/services/receivable-payable.service.js` | `server/services/customer-bill.service.js` + `receivable.repository.js` | Only used by `accounting-main.service.js`; active customer bill flow uses `customer-bill.service.js` directly | HIGH |

---

## 6. Unused Dependencies

Based on `package.json` devDependencies:

| Dependency | Evidence of Non-Use | Used By | Recommendation | Confidence |
|---|---|---|---|---|
| `nodemon` | Only used in npm scripts (`dev`, `launcher:dev`); not used in production | `package.json` scripts only | **KEEP** — dev dependency | HIGH |
| `prettier` | Not referenced in code; not in lint/format scripts (scripts only reference `eslint`) | None | **REVIEW** — listed in devDeps but format script exists in package.json | MEDIUM |
| `puppeteer` | Not referenced in any test file or script; `qa-*.mjs` files use puppeteer but are standalone scripts, not in package scripts | None (standalone scripts only) | **REVIEW** — used by qa-*.mjs scripts but not by vitest | MEDIUM |
| `vitest` | Referenced in `vitest.config.js`; used by `npm test` and `npm run test:watch` | package.json scripts | **KEEP** | HIGH |
| `eslint` | Listed as devDep but NOT in package.json scripts; no `.eslintrc` config file found | None | **REVIEW** — may be installed but not configured | MEDIUM |

> **Note:** `eslint` is in devDependencies but the `lint` script (`npm run lint`) references `eslint`. This is consistent — eslint is a dev dependency used by the lint script. KEEP.

---

## 7. Database / Migration Findings

### 7.1 Migration Sequence

| File | Classification | Notes |
|---|---|---|
| `server/database/migrations/001–068` (all `.sql`) | **KEEP — REQUIRED FOR FRESH INSTALL** | 68 migration files total; sequential numbering 001–068 |
| `server/database/migrations/055_*` | **POSSIBLY OBSOLETE** | Migration 055 does NOT exist; sequence goes 054→056 (gap) | REVIEW |
| `server/database/migrate.js` | **KEEP** | Sequelize-based migration runner; actively used by `npm run migrate` and `app.js` |
| `server/database/seed.js` | **KEEP** | Seed data; actively used by `app.js` when `DEMO_MODE=true` |
| `server/database/connection.js` | **KEEP** | DB connection; actively used by `app.js` |
| `server/database/dev.db` (0 KB) | **REVIEW** | Empty SQLite file; not referenced by `.env` (DB_PATH defaults to `data/blackstack-crm.db`) |

### 7.2 Migration 055 Gap

The migration sequence has a **gap**: migration 054 exists, then jumps to 056 (no 055). This should be investigated:
- Either 055 was deleted and its functionality merged into 056
- Or 055 was never created (skipped number)
- Check: migration 056 is `customer_bills_lifecycle.sql`, 057 is `customer_bills_permissions.sql` — these are Step 9 customer bills schemas, suggesting 055 may have been an accounting-related migration that was deleted or renumbered.

### 7.3 Backup Databases

| File | Classification | Notes |
|---|---|---|
| `data/blackstack-crm.db.DIRTY-BACKUP-1789882394` | **KEEP — HISTORICAL** | 7.4 MB; pre-cleanup backup |
| `data/blackstack-crm.db.PRE-AUDIT-BACKUP-1789215213` | **KEEP — HISTORICAL** | 1.4 MB; pre-audit backup |
| `data/blackstack-crm.db.bak.1789214252` (+shm, -wal) | **KEEP — HISTORICAL** | Timestamped backup |
| `data/blackstack-crm-v2.db` | **REVIEW** | 1.5 MB; not in .env default path; may be a stale alternate DB |

### 7.4 Root-Level Test Databases

8 timestamped test DB sets at root level (`test-cb-*.sqlite` × 3 files each = 24 files), plus 2 in `tests/`. All are temporary test artifacts not referenced by code.

---

## 8. Test Cleanup Candidates

Vitest is configured to include only `tests/**/*.test.js` and excludes 5 test files. The following test files do NOT match the vitest include pattern (they lack `.test.js` suffix) and are standalone scripts:

| Path | Classification | Notes |
|---|---|---|
| All `tests/_*.js` files (34 files) | **REVIEW** | Debug/investigation scripts; not run by vitest; not in package.json scripts |
| All `tests/debug_*.js` files (6 files) | **REVIEW** | Standalone debug scripts |
| All `tests/verify_*.js` files (8 files) | **REVIEW** | Standalone verification scripts |
| `tests/integration-customer-bills.js` | **REVIEW** | Standalone; not a vitest test (no `.test.js` suffix) |
| `tests/contact-centric.e2e.js` | **REVIEW** | Standalone; not a vitest test |
| `tests/persistence.e2e.js` | **REVIEW** | Standalone; not a vitest test |
| `tests/audit-journal-correction.js` | **REVIEW** | Standalone debug script |
| `tests/audit-journal-investigation.js` | **REVIEW** | Standalone debug script |
| `tests/_fix_balance_sheet.py`, `_fix_bs2.py`, `_fix_bs3.py` | **REVIEW** | Python scripts; not part of test pipeline |
| `tests/ui-check.mjs` | **REVIEW** | MJS script; not in vitest config |
| `tests/reset-crm-data.integration.test.js` | **KEEP** | Vitest test file (but excluded in vitest.config.js — may be intentionally excluded or stale) |

### Properly Configured Vitest Tests (active)

| Path | Classification | Notes |
|---|---|---|
| `tests/accounting-complete.test.js` | **KEEP** | Vitest test (but excluded in config — REVIEW whether exclusion is intentional) |
| `tests/accounting-e2e.test.js` | **KEEP** | Vitest test (excluded in config) |
| `tests/code-generator.regression.test.js` | **KEEP** | Vitest test (excluded in config) |
| `tests/create-ledger-account.regression.test.js` | **KEEP** | Vitest test (excluded in config) |
| `tests/customer-bills.vitest.test.js` | **KEEP** | Vitest test (excluded in config — NOTE: despite filename containing "vitest", it IS excluded) |
| `tests/update-account-is-group.test.js` | **KEEP** | Vitest test (excluded in config) |
| `tests/tax-gst.test.js` | **KEEP** | Vitest test (excluded in config) |
| `tests/auth-crud.integration.test.js` | **KEEP** | Vitest test (not excluded — actively runs) |
| `tests/deletion-safety.integration.test.js` | **KEEP** | Vitest test (not excluded — actively runs) |
| `tests/reset-crm-data.integration.test.js` | **REVIEW** | Vitest test but EXCLUDED in config — verify if intentionally disabled |

> **Critical finding:** The vitest config EXCLUDES 5 test files that appear to be important accounting tests:
> - `audit-opening-balance.test.js`
> - `create-ledger-account.regression.test.js`
> - `update-account-is-group.test.js`
> - `tax-gst.test.js`
> - `accounting-complete.test.js`
> - `accounting-e2e.test.js`
> 
> However, `customer-bills.vitest.test.js` is NOT in the exclude list and SHOULD be running. Verify this.

---

## 9. Configuration Cleanup Candidates

| Path | Classification | Reason | Evidence | Confidence |
|---|---|---|---|---|
| `.env` | **KEEP** | Active environment config | Matches `.env.example`; `DB_PATH=./data/blackstack-crm.db` is used by app | HIGH |
| `.env.example` | **KEEP** | Template for `.env` | Standard practice | HIGH |
| `.gitignore` | **KEEP** | Git ignore rules | Standard patterns | HIGH |
| `package.json` | **KEEP** | Project manifest | Defines all scripts | HIGH |
| `package-lock.json` | **KEEP** | Dependency lock file | Generated by npm | HIGH |
| `vitest.config.js` | **KEEP** | Test configuration | Actively used by `npm test` | HIGH |

> **Observation:** `.env.example` has `RATE_LIMIT_MAX_REQUESTS=100` while `.env` has `RATE_LIMIT_MAX_REQUESTS=100000`. This discrepancy should be reviewed.

---

## 10. Documentation Cleanup Candidates

| Path | Classification | Notes |
|---|---|---|
| `README.md` | **CURRENT** | Active project README; up-to-date architecture and quick start |
| `docs/BLACK_START_CRM_CHART_OF_ACCOUNTS_FUNCTIONAL_SPECIFICATION.md` | **CURRENT** | Active CoA spec |
| `docs/BLACK_START_CRM_STEP_1…8.md` | **HISTORICAL** | Implementation specs for Steps 1-8; historical reference |
| `docs/STEP_11_IMPLEMENTATION_REPORT.md` | **CURRENT** | Active Step 11 report |
| `docs/STEP_12_IMPLEMENTATION_REPORT.md` | **CURRENT** | Active Step 12 report |
| `docs/STEP_13_IMPLEMENTATION_REPORT.md` | **CURRENT** | Active Step 13 report |
| `docs/STEP_15_TO_34_FULL_PROJECT_AUDIT_AND_ROADMAP.md` | **HISTORICAL** | Roadmap document; may be outdated |
| `docs/HERMES_PROGRESS.md` | **HISTORICAL** | Progress tracking; internal notes |
| `docs/MIGRATION_GAP_ANALYSIS_AND_REMEDIATION.md` | **CURRENT** | Migration gap analysis |
| `IMPLEMENTATION_REPORT.md` | **REVIEW** | Root-level implementation report; may be outdated by STEP_15 doc |
| `ACCOUNTING_FIX_AUDIT_REPORT.md` | **HISTORICAL** | Accounting fix audit report |
| `CREATE_LEDGER_ACCOUNT_AUDIT_REPORT.md` | **HISTORICAL** | CoA creation audit |
| `DEAL_CONVERSION_TO_DEALS_VISIBILITY_AUDIT_REPORT.md` | **HISTORICAL** | Deals visibility audit |
| `DEAL_STAGE_UPDATE_AUDIT_REPORT.md` | **HISTORICAL** | Deal stage update audit |
| `DEAL_WORKFLOW_UI_SYNC_AUDIT_REPORT.md` | **HISTORICAL** | Deal workflow UI sync audit |
| `DEALS_COMPLETE_WORKFLOW_AUDIT_REPORT.md` | **HISTORICAL** | Complete deals workflow audit |
| `GLOBAL_INR_CURRENCY_AUDIT_REPORT.md` | **HISTORICAL** | INR currency audit |
| `INR_CURRENCY_IMPLEMENTATION_AUDIT_REPORT.md` | **HISTORICAL** | INR currency implementation audit |
| `INVOICE_BILLING_MODULE_AUDIT_REPORT.md` | **HISTORICAL** | Invoice/billing audit |
| `OPENING_BALANCE_FIX_REPORT.md` | **HISTORICAL** | Opening balance fix report |
| `PERSISTENCE_AUDIT_REPORT.md` | **HISTORICAL** | Data persistence audit |
| `PHASE2_AUDIT_REPORT.md` | **HISTORICAL** | Phase 2 audit report |
| `PHASE_3_UI_WORKFLOW_AUDIT_REPORT.md` | **HISTORICAL** | Phase 3 UI workflow audit |
| `VERIFICATION_REPORT.md` | **HISTORICAL** | Verification report |

---

## 11. Temporary / Generated Files

### 11.1 Root-Level Temporary Files

| Path | Classification | Type | Notes |
|---|---|---|---|
| `.tmp_create_page_method.js` | **REVIEW** | Development scratch | 64 KB; customer-bills page creation UI |
| `.tmp_syntax_check.js` | **SAFE TO REMOVE** | Syntax check scratch | 64 KB; exact duplicate of `.tmp_create_page_method.js` |
| `.tmp_fix.py` | **REVIEW** | Python fix script | Fixes `.tmp_create_page_method.js` |
| `.tmp_fix_commas.py` | **REVIEW** | Python fix script | Fixes commas in `.tmp_create_page_method.js` |
| `.tmp_insert.py` | **REVIEW** | Python insert script | Inserts code into `.tmp_create_page_method.js` |
| `test_calc.cjs` | **REVIEW** | Temp calc test | Tests `CustomerBillService.calculateTotals()` |
| `tmp_seed.cjs` | **REVIEW** | Temp seed script | Seeds role_permissions |
| `tmp-check.js` | **REVIEW** | Temp DB check | Checks table counts |
| `test-out.txt` | **REVIEW** | Test output | Not referenced by code |

### 11.2 Root-Level Screenshot Files

| Path | Classification | Notes |
|---|---|---|
| `coa-after.png` | **KEEP — HISTORICAL** | Audit evidence |
| `coa-after2.png` | **KEEP — HISTORICAL** | Audit evidence |
| `reset-modal.png` | **KEEP — HISTORICAL** | UI audit evidence |
| `ui-contact-form.png` | **KEEP — HISTORICAL** | UI audit evidence |
| `ui-deal-form.png` | **KEEP — HISTORICAL** | UI audit evidence |
| `ui-lead-form.png` | **KEEP — HISTORICAL** | UI audit evidence |

### 11.3 Test Temporary Databases

| Path | Classification | Notes |
|---|---|---|
| `test-cb-*.sqlite` + shm/wal (24 files) | **REVIEW** | Runtime test DBs; gitignored but present on disk |
| `tests/test-debug3.sqlite` + shm/wal | **REVIEW** | Debug DB; gitignored |
| `tests/test-debug4.sqlite` + shm/wal | **REVIEW** | Debug DB; gitignored |

### 11.4 Runtime Database Files (should be gitignored)

| File | Classification | Notes |
|---|---|---|
| `data/*.sqlite-shm`, `*.sqlite-wal` | **KEEP — HISTORICAL** | SQLite WAL mode artifacts; gitignored |
| `data/blackstack-crm.db.DIRTY-BACKUP-*` | **KEEP — HISTORICAL** | Manual backup snapshots |

---

## 12. High-Risk Areas

These areas require extra-careful review before any removal:

### 12.1 Accounting System (CRITICAL)

| File/Pattern | Risk | Notes |
|---|---|---|
| `server/controllers/accounting.controller.js` (77 KB) | HIGH — Business Critical | Largest controller; directly handles chart of accounts, journals, vouchers, bills, receivables, payables, ledger, taxes |
| `server/services/customer-bill.service.js` (112 KB) | HIGH — Business Critical | Largest service; handles complete customer billing lifecycle, tax calculation, GST, payment allocation, AR aging, collections, statements, reporting |
| `server/services/tax-calculation-engine.js` (26 KB) | HIGH — Business Critical | Used by both `accounting.controller.js` and `customer-bill.controller.js` |
| `server/repositories/billing-cost.repository.js` | HIGH | 12 KB; core billing data access |
| `server/repositories/journal-entry.repository.js` | HIGH | 33 KB; core accounting data access |
| `server/repositories/chart-of-accounts.repository.js` | HIGH | 26 KB; core CoA data access |
| `server/repositories/receivable.repository.js` | HIGH | Used by both `accounting.controller.js` and `customer-bill.controller.js` |
| `server/repositories/voucher.repository.js` | HIGH | 37 KB; voucher/receipt/payment voucher handling |
| `server/repositories/reporting.repository.js` | HIGH | 53 KB; financial reporting |
| `server/services/receivable-payable.service.js` | MEDIUM | Only used by legacy `accounting-main.service.js`; but contains receivable/payable logic that may be partially active |
| `server/services/accounting-extended.service.js` | MEDIUM | Not on active controller call path; only in docs |
| `server/services/accounting-main.service.js` | MEDIUM | Only used internally by `accounting-coa.service.js`; not used by controller |
| `server/services/accounting-coa.service.js` | MEDIUM | Only used by `accounting-main.service.js`; not on active path |
| `server/services/accounting-masters.service.js` | MEDIUM | Only used by `accounting-main.service.js` |
| `server/services/accounting-reports.service.js` | MEDIUM | Only used by `accounting-main.service.js` |

**Recommendation:** Before removing any accounting service (`accounting-extended`, `accounting-main`, `accounting-coa`, `accounting-masters`, `accounting-reports`, `receivable-payable`), verify that `accounting.controller.js` does NOT delegate to them. Based on this audit, the controller uses `account-group.service`, `tax-calculation-engine`, and `code-generator.service` directly, plus repository classes directly. The orchestrator services (`accounting-main` and its dependencies) appear to be a **legacy architecture** that was replaced by direct service-to-repository calls in the controller.

### 12.2 Customer Bills (CRITICAL)

| File/Pattern | Risk | Notes |
|---|---|---|
| `server/controllers/customer-bill.controller.js` | HIGH | Active controller for customer bills Step 9-14 |
| `server/routes/customer-bills.js` (16 KB) | HIGH | 263 lines; complete CRUD + lifecycle + payments + CN/DN + collections + reports |
| `server/services/customer-bill.service.js` (112 KB) | HIGH | Core business logic for customer bills |
| `server/repositories/billing-cost.repository.js` | HIGH | Billing data layer |
| `server/repositories/receivable.repository.js` | HIGH | AR receivables data layer |
| `server/database/migrations/056–068` | HIGH | Customer bills migrations (Steps 9-14) |

**Recommendation:** All customer bills code is actively wired. Do NOT touch.

### 12.3 Payments (HIGH)

| File/Pattern | Risk | Notes |
|---|---|---|
| `server/controllers/payment.controller.js` | HIGH | Used by `payments.js` route; payment recording still active |
| `server/services/payment.service.js` | HIGH | Used by `payment.controller.js` |
| `server/repositories/payment.repository.js` | HIGH | Used by `payment.service.js`, `invoice.service.js`, `dashboard.service.js` |

### 12.4 Authentication (HIGH)

| File/Pattern | Risk | Notes |
|---|---|---|
| `server/controllers/auth.controller.js` | HIGH | Used by `auth.js` route |
| `server/services/auth.service.js` | HIGH | Used by `auth.controller.js` |
| `server/middleware/auth.js`, `rbac.js` | HIGH | Global middleware |
| `server/utils/db.js` | HIGH | DB connection utility |
| `_token.txt` | MEDIUM | Contains JWT token; security concern; should be in `.gitignore` |

### 12.5 Frontend Routing (MEDIUM)

| File/Pattern | Risk | Notes |
|---|---|---|
| `public/js/app.js` | MEDIUM | Defines all frontend routes; single source of truth for SPA |
| `public/js/pages/accounting.js` | MEDIUM | Handles all `#accounting/*` sub-routes via dynamic dispatch |
| `public/js/pages/customer-bills.js` (232 KB) | HIGH | Active customer bills frontend |
| Module name conflict: `reports.js` vs `accounting-reports.js` | HIGH | Both register `PageModules.reports`; `reports.js` overrides; accounting.js expects `accounting-reports` module which doesn't exist |

---

## 13. Frontend Cleanup Audit (Summary)

### 13.1 Dead Frontend Page Modules

| File | Classification | Reason | Evidence | Confidence |
|---|---|---|---|---|
| `public/js/pages/pipeline.js` (3,951 lines, 232 KB) | **DEAD CODE** | No route dispatches to `PageModules.pipeline`; not in Sidebar; loaded in index.html but unreachable | HIGH |
| `public/js/pages/reports.js` | **DEAD CODE** | Overrides `accounting-reports.js`'s `PageModules.reports` registration (loads later); route `#reports` dispatches to module `'reports'` which is this old file, NOT the accounting reports page | HIGH |
| `public/js/pages/invoices.js` | **LEGACY** | Compatibility shim redirecting to `#accounting/bills` | HIGH |
| `public/js/pages/payments.js` | **LEGACY** | Compatibility shim redirecting to `#accounting/receivables` | HIGH |
| `public/js/pages/accounting-reports.js` | **DEAD CODE** | Registers `PageModules.reports` but overridden by `reports.js`; accounting.js dispatch expects `'accounting-reports'` module which is never registered (should be `PageModules.accountingReports` or `PageModules['accounting-reports']`) | HIGH |

### 13.2 Module Registration Conflict

There is a **module name collision** between `reports.js` and `accounting-reports.js`:
- `accounting-reports.js` registers `PageModules.reports` (position 20 in index.html)
- `reports.js` registers `PageModules.reports` (position 30 in index.html) — **overwrites** the previous
- The `#reports` route in `app.js` dispatches to `PageModules.reports` → gets the old `reports.js`
- The `#accounting/reports` route goes through `accounting.js` which dispatches `'reports'` → `'accounting-reports'` module name, but neither file registers that name → **results in "Not found"**

This is a functional bug: clicking Accounting > Reports in the UI produces a "Not found" error.

### 13.3 Frontend Directory Structure

```
public/
├── index.html          (11,251 chars — full SPA entry)
├── login.html          (8,122 chars — standalone login page)
├── js/
│   ├── app.js           (Angular 1.x route definitions)
│   ├── api/             (API client modules)
│   ├── components/      (Reusable UI components)
│   ├── pages/           (Page modules — one per route)
│   ├── utils/           (Frontend utilities)
│   └── lib/             (Third-party libraries)
└── css/
    └── styles.css       (Global styles)
```

### 13.4 Frontend Components Directory

To be fully catalogued — the audit identified the page module level but individual component files within `public/js/components/` and `public/js/utils/` need separate examination for unused/duplicated components.

---

## 14. Backend Cleanup Audit (Summary)

### 14.1 Active Route ↔ Controller Mapping

The following routes are registered in `app.js` and are ACTIVE:

| Route File | Controller Used | Status |
|---|---|---|
| `auth.js` | `auth.controller.js` | ACTIVE |
| `dashboard.js` | `dashboard.controller.js` | ACTIVE |
| `contacts.js` | `contacts.controller.js` | ACTIVE |
| `organizations.js` | `organizations.controller.js` | ACTIVE |
| `deals.js` | `deals.controller.js` | ACTIVE |
| `pipelines.js` | `pipelines.controller.js` | ACTIVE |
| `products.js` | `products.controller.js` | ACTIVE |
| `invoices.js` | `invoice.controller.js` (singular) | ACTIVE |
| `payments.js` | `payment.controller.js` (singular) | ACTIVE |
| `accounting.js` | `accounting.controller.js` | ACTIVE |
| `activities.js` | `activities.controller.js` | ACTIVE |
| `tasks.js` | `tasks.controller.js` | ACTIVE |
| `workflows.js` | `workflows.controller.js` | ACTIVE |
| `reports.js` | `reports.controller.js` | ACTIVE |
| `users.js` | `users.controller.js` | ACTIVE |
| `settings.js` | `settings.controller.js` | ACTIVE |
| `search.js` | `search.controller.js` | ACTIVE |
| `audit.js` | `audit.controller.js` | ACTIVE |
| `leads.js` | `leads.controller.js` | ACTIVE |
| `customers.js` | `customers.controller.js` | ACTIVE |
| `appointments.js` | `appointments.controller.js` | ACTIVE |
| `notifications.js` | `notifications.controller.js` | ACTIVE |
| `notes.js` | `notes.controller.js` | ACTIVE |
| `customer-bills.js` (inline require) | `customer-bill.controller.js` | ACTIVE |
| `ai.js` (inline require) | `ai.controller.js` | ACTIVE |
| `deletion.js` (inline require) | `DeletionController` (inline in route file) | ACTIVE |

### 14.2 Orphaned Routes

| Route File | Controller | Classification | Notes |
|---|---|---|---|
| N/A (all routes are used) | — | — | All 26 route files registered in `app.js` are active |

### 14.3 Dead Backend Controllers (Orphaned Singular Controllers)

See Section 3.1 above — 12 singular controllers are completely unreferenced.

---

## 15. Accounting-Specific Audit (Summary)

### 15.1 Active Accounting Implementation

The active accounting system uses this architecture:

```
Routes (accounting.js)
  → AccountingController (77 KB)
    → account-group.service.js (13 KB) — Chart of Accounts, account groups
    → tax-calculation-engine.js (26 KB) — GST/tax calculations
    → code-generator.service.js (8.6 KB) — Voucher/bill number generation
    → Direct repository access:
      • chart-of-accounts.repository.js (26 KB)
      • account-group.repository.js (11 KB)
      • journal-entry.repository.js (33 KB)
      • voucher.repository.js (37 KB)
      • billing-cost.repository.js (12 KB)
      • receivable.repository.js (8 KB)
      • budget.repository.js (1.7 KB)
      • cost-centre.repository.js (1 KB)
      • opening-balance.repository.js (7 KB)
      • accounting-audit.repository.js (2 KB)
```

### 15.2 Customer Bills Implementation

```
Routes (customer-bills.js — 263 lines)
  → CustomerBillController (2,980 chars)
    → customer-bill.service.js (112 KB) — Full billing lifecycle
    → tax-calculation-engine.js (26 KB) — Tax calculations
    → code-generator.service.js — Bill number generation
    → Direct repository access:
      • billing-cost.repository.js (12 KB)
      • receivable.repository.js (8 KB)
```

### 15.3 Legacy / Orphaned Accounting Services

| Service | Classification | Active Call Path? | Notes |
|---|---|---|---|
| `accounting-extended.service.js` | **LEGACY** | No | Not required by controller; only in docs |
| `accounting-main.service.js` | **LEGACY** | No | Facade; only used by `accounting-coa.service.js` |
| `accounting-coa.service.js` | **LEGACY** | No | Only used by `accounting-main.service.js` |
| `accounting-masters.service.js` | **LEGACY** | No | Only used by `accounting-main.service.js` |
| `accounting-reports.service.js` | **LEGACY** | No | Only used by `accounting-main.service.js` |
| `receivable-payable.service.js` | **LEGACY** | No | Only used by `accounting-main.service.js` |

**CRITICAL FINDING:** These 6 legacy accounting services form an alternative architecture that is NOT used by the current `accounting.controller.js`. The controller accesses repositories directly. This entire service chain (`accounting-main` → `accounting-engine`, `accounting-coa`, `receivable-payable`, `accounting-masters`, `accounting-reports`) appears to be a **legacy orchestrator pattern** superseded by direct controller-to-repository calls.

**RECOMMENDATION:** Do NOT remove these services in Phase 2 without first:
1. Verifying no other entry point (e.g., Electron IPC, background jobs, scripts) imports them
2. Checking that all business logic they encapsulate is present in the active path
3. Running the full test suite with them removed (if Phase 2 permits)

### 15.4 Migration Gap: Missing Migration 055

| Item | Classification | Notes |
|---|---|---|
| Migration 055 missing | **KEEP — REVIEW** | Sequence: 054 → 056 (gap); 056 is `customer_bills_lifecycle.sql` |

---

## 16. Customer Bills-Specific Audit (Summary)

### 16.1 Active Components

| Component | File | Status |
|---|---|---|
| Route | `server/routes/customer-bills.js` (16 KB, 263 lines) | ACTIVE |
| Controller | `server/controllers/customer-bill.controller.js` (2,980 chars) | ACTIVE |
| Service | `server/services/customer-bill.service.js` (112 KB — LARGEST file) | ACTIVE |
| Frontend Page | `public/js/pages/customer-bills.js` (232 KB, 3,951 lines) | ACTIVE |
| Repository | `server/repositories/billing-cost.repository.js` (12 KB) | ACTIVE |
| Repository | `server/repositories/receivable.repository.js` (8 KB) | ACTIVE |
| Reporting | `server/repositories/reporting.repository.js` (53 KB) | ACTIVE |
| Migration | `056_customer_bills_lifecycle.sql` | ACTIVE |
| Migration | `057_customer_bills_permissions.sql` | ACTIVE |

### 16.2 Legacy / Duplicated Components

| File | Classification | Notes |
|---|---|---|
| `server/controllers/invoice.controller.js` | **LEGACY** | Used by `invoices.js` route; invoices migrated to accounting in migration 025; customer bills use `customer-bill.controller.js` instead |
| `server/services/invoice.service.js` | **LEGACY** | Used by `invoice.controller.js`; invoice data migrated to accounting schema |
| `server/repositories/invoice.repository.js` | **LEGACY** | Used by `invoice.service.js`; legacy invoice data access |
| `server/controllers/payment.controller.js` | **LEGACY** | Used by `payments.js` route; payments increasingly routed through `accounting.controller.js`; however still active |
| `server/services/payment.service.js` | **LEGACY** | Used by `payment.controller.js` |
| `server/repositories/payment.repository.js` | **LEGACY** | Used by `payment.service.js`; still active |

### 16.3 Frontend Duplicated Financial Logic

| File | Classification | Notes |
|---|---|---|
| `public/js/pages/invoices.js` | **LEGACY shim** | Redirects `#invoices` → `#accounting/bills`; does not compute taxes |
| `public/js/pages/payments.js` | **LEGACY shim** | Redirects `#payments` → `#accounting/receivables`; does not compute payments |
| `public/js/pages/reports.js` | **LEGACY** | Old CRM reports page; overrides `accounting-reports.js`; should be removed after fixing the module name conflict |

---

## 17. Backup / Old CRM Directory

### 17.1 Backup Directory: `blackstack-crm-v2_BACKUP_pre_electron_2026-02-14/`

| Item | Classification | Notes |
|---|---|---|
| Entire backup directory (321 files) | **KEEP — HISTORICAL** | Pre-Electron snapshot from 2026-02-14; contains full project state before Electron migration; NOT loaded by app.js or launcher |

### 17.2 Old HTML CRM: `blackstack-crm/`

| Item | Classification | Notes |
|---|---|---|
| Entire directory (10 files) | **KEEP — HISTORICAL** | HTML-only legacy CRM; no JS/CSS/Express code; pre-V2 architecture; not referenced by any current code |

---

## 18. Recommended Cleanup Order (Phase 2)

When Phase 2 is authorized, follow this safe sequence:

1. **Temporary artifacts** — Remove root `.tmp_*` files, `test-cb-*.sqlite*`, `tmp_*.cjs`, `tmp-check.js`, `test-out.txt`, root-level `.sqlite-shm`/`.sqlite-wal` files
2. **nul device files** — Verify no legitimate code references them (Windows artifact), then remove
3. **Root-level log files** — `crm-run.log`, `server.log`, `debug.log`, etc.
4. **Orphaned test scripts** — `tests/_*.js`, `tests/debug_*.js`, `tests/verify_*.js`, `tests/_fix_*.py`, `tests/ui-check.mjs`
5. **Truly orphaned singular controllers** — 12 controllers with zero references (Section 3.1)
6. **Truly orphaned singular services** — `activity.service.js`, `relationship.service.js`, `report.service.js`, `settings.service.js` (zero references)
7. **Orphaned repositories** — `base.repository.js`, `customer.repository.js`, `financial-year.repository.js`, `appointment.repository.js`, `lead.repository.js`, `payable.repository.js`
8. **Duplicate frontend modules** — `reports.js`, `pipeline.js`, `invoices.js`, `payments.js` (after fixing routing), `accounting-reports.js` (after fixing module name)
9. **Legacy accounting services** — After verification, remove `accounting-extended`, `accounting-main`, `accounting-coa`, `accounting-masters`, `accounting-reports`, `receivable-payable` (only after confirming no other entry point imports them)
10. **Standalone QA scripts** — `qa-*.mjs`, `persist_audit_final.py`, `phase2_audit.py`, `test_calc.cjs`, `tmp_seed.cjs`
11. **Scripts directory** — Verify if `scripts/*.js` are referenced by CI or automation before removing
12. **serverui/ directory** — Verify not loaded by Electron main before removing
13. **Root-level documentation** — Archive or consolidate audit reports into `docs/`
14. **High-risk business logic** — Accounting, customer bills, payments — ONLY after full test suite passes without them

---

## 19. Summary Outputs

**Total files scanned:** 475 (main project, excluding `node_modules`)
**Potential unused files:** ~60 (temporary scripts, debug databases, nul files, orphaned controllers/services)
**Potential duplicate files:** ~30 (singular/plural controller pairs, frontend module conflicts, duplicate DB files)
**Legacy implementations:** ~20 (accounting service chain, invoice/payment modules, frontend shims)
**Unused/dead methods:** ~50 (orphaned controller methods in 12 singular controllers, unreferenced service methods in 6 legacy services)
**Unused dependencies:** 0 confirmed (all devDeps in package.json are used by scripts or configs); `eslint` in devDeps matches `lint` script
**Temporary/generated files:** ~50 (root .tmp files, test databases, log files, screenshots)
**High-risk candidates:** 15 accounting/customer-bill/payment files + 6 legacy accounting services + module name conflict bug
**Safe-to-remove candidates:** ~45 (temporary artifacts, nul files, truly orphaned debug scripts)
**Items requiring manual review:** ~35 (legacy services, scripts, serverui, migration 055 gap, module conflict, test exclusions in vitest.config.js, `_token.txt` security concern, duplicate `.env`)