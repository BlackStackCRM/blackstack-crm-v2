# Update Guide — BlackStack CRM

Covers the implemented desktop update system (Phase 1 base + Phase 3 channels
and compatibility gate).

## How updates work

1. The app checks for updates in the background (15 s after start, then every
   4 hours). Startup is never blocked.
2. When an update is found it is downloaded automatically in the background.
   Progress is shown only from real updater events.
3. When downloaded, the Settings → Updates panel shows
   **"Update ready — Restart & Update"**. Nothing installs until you click it.
4. Clicking **Restart & Update** performs, in order:
   - **Schema compatibility gate** — if the new version cannot safely use the
     current database, the update is blocked with a clear message and your
     data is untouched.
   - **Verified backup** of the database (pre-update label). If the backup
     cannot be verified, the update is refused.
   - The app quits and the installer applies the update.
5. On next launch, safe migrations run automatically (verified backup →
   migration → integrity check → foreign-key check). Failure triggers
   automatic recovery from the verified backup.

## Update channels (Settings → Updates)

| Channel | Who | Behavior |
|---|---|---|
| **Stable** (default) | everyone | Production releases only. |
| **Beta** | opt-in | Early pre-releases; a confirmation dialog is required; never enabled automatically. |
| **Enterprise** | IT-managed | Follows stable releases; intended for controlled rollout environments (see enterprise-deployment.md). |

The channel is stored in user preferences (`update-channel.json`) and never
touches the database. Changing it takes effect on the next update check.

## Manual check

Settings → Updates → **Check for Updates** shows one of:
`Checking…` → `You're up to date` / `Update available` / `Unable to check for updates` / `Offline`.

## Offline behavior

All update failures are non-fatal: the CRM continues to work normally.
Update checks fail gracefully to OFFLINE and never affect the database.

## Data safety summary

- Update blocked if schema compatibility cannot be guaranteed.
- Update refused if the pre-update backup cannot be created/verified.
- Post-update migration failure → automatic restore from the verified backup
  (integrity + foreign-key verified before the app starts).
- The database is never reset, recreated or deleted by the update system.
