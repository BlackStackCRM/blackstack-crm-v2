# Enterprise Deployment — BlackStack CRM

Tested facts only. Anything not tested is marked as such.

## Installer compatibility (tested)

- NSIS-based installer (`BlackStack CRM Setup <version>.exe`), x64.
- Silent install: **`/S`** — exit code 0, no UI, verified against the real
  generated installer.
- Custom directory: **`/S /D=C:\Path With Spaces`** — `/D=` must be the LAST
  argument and unquoted (NSIS convention). Verified.
- Exit codes: `0` = success; non-zero = failure (deployment tools should
  treat any non-zero as failed).
- Reinstall/upgrade over an existing install preserves all user data.
- Uninstall removes binaries only; `%APPDATA%\BlackStack CRM` is preserved.

## User data isolation (verified by tests)

- Per Windows user: `%APPDATA%\BlackStack CRM` (database, backups, uploads,
  preferences, logs). User A never sees User B's data.
- Optional override for managed environments: `BLACKSTACK_USER_DATA_DIR`
  (e.g. a departmental path per user). The app refuses overrides pointing
  inside the installation directory.

## Update behavior for IT

- Default channel: **stable**. Users can switch to Beta themselves (explicit
  opt-in only); Enterprise follows stable releases.
- An organization that wants to fully control updates should deploy via its
  own software catalog (repackaged or direct installer distribution) and can
  rely on the fact that updates never install without the user's explicit
  "Restart & Update" click, preceded by a verified database backup and a
  schema-compatibility check.
- `BLACKSTACK_UPDATE_*`-style central policy keys are NOT implemented yet
  (future work); currently the channel is a per-user preference.

## Endpoint management (Intune / SCCM / GPO)

Documented installer compatibility — NOT native integration:

- **Intune (Win32 app)**: wrap the installer; install command
  `BlackStack-CRM-Setup.exe /S`, uninstall command
  `"C:\Program Files\BlackStack CRM\Uninstall BlackStack CRM.exe" /S`,
  success code `0`. Install in **user context** (per-user app) or pass
  `/D=` with an elevated, machine-wide directory.
- **SCCM/MECM**: same commands as an Application; detection: existence of
  `BlackStack CRM.exe` plus version from the executable metadata.
- **GPO**: software installation (MSI) is NOT available (no MSI packaging is
  provided); script-based deployment via startup/logon above but has not been tested by us — verify in your
  environment.

## Security-relevant facts

- The local server binds **127.0.0.1 only**; no firewall rule is created.
- Code signing: production installers are signed when a certificate is
  available (see security.md); verify SHA-256 before distribution.
- No telemetry, no crash upload without opt-in.

## Not implemented (do not assume)

- MSI packaging, MSIX, registry-based update lockout, WSUS integration,
  pre-seeded licensing, and centralized logging.
