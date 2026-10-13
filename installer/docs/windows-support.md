# Windows Support Matrix — BlackStack CRM

Only platforms actually tested are claimed as supported. Untested platforms
are listed as "untested" and support is not promised (Master Prompt §52).

## Currently claimed (verify per release against §58 tests)

| Platform | Architecture | Status |
|---|---|---|
| Windows 10 (1809+) | x64 | Supported target — must pass the release checklist on at least one 19045+ machine per release |
| Windows 11 | x64 | Supported target — must pass the release checklist |
| Windows on ARM | ARM64 | **Not supported** (installer targets x64 only) |
| Windows Server 2019 | x64 | Untested — not claimed |
| Windows Server 2022 | x64 | Untested — not claimed |

## Installer facts (verified against the real generated installer)

- Target: NSIS, x64 only (`build.win.target.arch: ["x64"]`)
- App ID: `com.blackstack.crm`, product name "BlackStack CRM"
- Assisted installer (not one-click); installation directory changeable
- UAC elevation only when required (installing to `C:\Program Files`)
- `deleteAppDataOnUninstall: false` — uninstall preserves user data
- Silent install **tested**: `/S` (exit code 0) and `/S /D=<custom dir>`
  (verified files land in the custom dir) — see `silent-install.md`

## Multi-user Windows support

- Application binaries: shared, `C:\Program Files\BlackStack CRM`
- User data: `%APPDATA%\BlackStack CRM` — **fully isolated per Windows user**
  (database, backups, preferences, logs). Two Windows users on one machine
  never share CRM data unless a future explicitly designed shared-database
  architecture is introduced (none exists today).
- Single-instance lock is per-user; different Windows users can each run
  their own instance simultaneously.

## Known runtime facts

- The CRM backend runs in-process, bound to `127.0.0.1` (never network-exposed).
- Default port 34567 with fallback 34568–34572.
- Full offline operation (updates are the only network feature, and they are
  optional/background).
