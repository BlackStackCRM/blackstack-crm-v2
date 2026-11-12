# BlackStack CRM V2 — Manual Cloud Migration Instructions

> **IMPORTANT** — No application code or SQL execution has been performed by the
> engineering agent. You perform these steps yourself in the Supabase Dashboard.
> Project reference is redacted as `<project-ref>`.

---

## Prerequisites

- A Supabase project exists with project ref `<project-ref>`
  (e.g. `your-project-ref.supabase.co`). Do not type the full URL or key.
- `server/.env` contains:
  - `SUPABASE_URL=https://<project-ref>.supabase.co`
  - `SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>` (used by the app, not by you)
- You are logged into the Supabase Dashboard as a project owner.

---

## Step 1 — Open the Supabase SQL Editor

1. Go to https://supabase.com/dashboard
2. Sign in with your Supabase account.
3. Select project `<project-ref>` from the project switcher (top-left).
4. In the left-hand navigation, click **SQL Editor** (icon resembles a `>_` or `SQL`).
5. Create a new query tab (usually a `+` button next to the query list).

---

## Step 2 — Apply the cloud migration (single transaction)

1. Open the file `supabase/manual_apply_all.sql` from this repo.
2. Copy the **entire** contents of `manual_apply_all.sql` (the header comment,
   `BEGIN;`, all 6 migration blocks, and `COMMIT;`).
3. Paste it into the SQL Editor query tab.
4. **Do not** add a semicolon after `COMMIT;` — the file already ends with `COMMIT;`.
5. Click the **Run** button (play icon) in the SQL Editor toolbar.

> The whole file is one transaction (`BEGIN;` ... `COMMIT;`). If **any** statement
> fails, the transaction rolls back and **no** tables, extensions, or indexes are
> created on the cloud project.

### What to expect on success

- The SQL Editor shows green check marks for each `CREATE EXTENSION`, `CREATE TABLE`,
  and `CREATE INDEX` statement.
- The last line shows `COMMIT` and the transaction completes.
- No error panel is shown. If the panel is red, scroll through it to find the
  first failing statement and read the error message.

### If a statement fails

1. **Do not re-run** `manual_apply_all.sql`. It is wrapped in `BEGIN ... COMMIT`;
   a re-run will fail on `CREATE EXTENSION IF NOT EXISTS pgcrypto` (already done)
   **or** on `CREATE TABLE IF NOT EXISTS agencies` (already done).
2. Note the failing statement (Supabase shows you the exact line).
3. Decide whether to fix the error in the source SQL files (requires a new Phase)
   or to investigate the cloud-side state manually.
4. If you need to start over cleanly, use the **Reset database** / **Restore
   from backup** option in the Dashboard — this is the only safe way to get a
   clean slate after a failed `manual_apply_all.sql`.

---

## Step 3 — Verify the cloud schema

1. Open a **new** query tab in SQL Editor.
2. Open `supabase/verify_cloud.sql` and paste its contents into the tab.
3. Click **Run**.

### Expected output

| check_name | enabled/row_count |
|---|---|
| pgcrypto | 1 |
| companies | 0 |
| agencies | 0 |
| agency_administrators | 0 |
| agency_status_history | 0 |
| agency_audit_entries | 0 |

The FK check should list 5 foreign keys:
- `fk_agencies_company`
- `fk_agencies_provider_company`
- `fk_agency_administrators_agency`
- `fk_agency_administrators_company`
- `fk_agency_status_history_agency`
- `fk_agency_audit_entries_agency`

(6 FKs total across the 5 tables.)

The index check should list 7 indexes:
- `idx_agencies_code`, `idx_agencies_company`, `idx_agencies_provider`,
  `idx_agencies_status`
- `idx_agency_administrators_agency`
- `idx_agency_status_history_agency`
- `idx_agency_audit_entries_agency`

---

## Step 4 — Confirm success

After Step 2 and Step 3 both succeed:

1. The cloud schema contains `companies`, `agencies`, `agency_administrators`,
   `agency_status_history`, and `agency_audit_entries`.
2. All FK constraints and indexes exist as expected.
3. All tables are empty (0 rows) — the seed data is imported separately by the
   application in a later phase.

The cloud project is now ready. The application's `supabase.service.js` can use
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` to read/write these tables.

---

## Troubleshooting (summary)

| Symptom | Cause | Action |
|---|---|---|
| `CREATE EXTENSION ... denied` | Wrong project selected / wrong role | Re-select `<project-ref>` at top-left, re-run |
| `relation "companies" already exists` | `manual_apply_all.sql` ran twice | The file is idempotent-safe (`IF NOT EXISTS`). Do not re-run in a new transaction. |
| Any statement fails | Typo, wrong SQL, or DB is not empty | Read the error; fix the source file and request a new Phase. Do not manually patch the cloud DB. |
| `SELECT count(*)` shows rows | Seed data was applied prematurely | Expected to be 0. Stop and confirm you did not run a seed script. |

---

## Notes on file structure

```
supabase/
├── manual_apply_all.sql   # Single-transaction combined migration (for you to paste)
├── verify_cloud.sql       # Post-apply verification (for you to run)
└── migrations/            # Source files the package concatenates (not for direct paste)
    ├── 001_pgcrypto.sql
    ├── 002_companies.sql
    ├── 003_agencies.sql
    ├── 004_agency_administrators.sql
    ├── 005_agency_status_history.sql
    └── 006_agency_audit_entries.sql
```

`MANUAL_APPLY.md` + `manual_apply_all.sql` + `verify_cloud.sql` are the ONLY files
the agent created for Phase 16. No migration was executed against Supabase by the
agent — this is a manual execution package for you to run.
