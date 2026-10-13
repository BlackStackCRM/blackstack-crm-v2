# PHASE 4B — `setup.exe` BUILT FROM CURRENT SOURCE

**Date:** 2026-10-10
**Deliverable:** `dist/setup.exe`
**Version:** 1.0.0 (from `package.json`)
**Signing:** **UNSIGNED** — local development build, not for release

---

## 1. Verdict

A fresh NSIS installer was built from the current working tree and verified.
It is **not** a renamed old artifact: the byte-level evidence is in §5.

**One acceptance item could NOT be completed and is reported as blocked, not
claimed:** installing to `C:\Program Files`. See §7.

---

## 2. Build command

```bash
npx electron-builder --win nsis --publish never --config.directories.output=dist-setup-new
```

Built to `dist-setup-new/` deliberately, so the pre-existing
`dist/BlackStack CRM Setup 1.0.0.exe` was **never overwritten**. After
verification the new installer was copied to the requested path:

```bash
cp -p "dist-setup-new/BlackStack CRM Setup 1.0.0.exe" dist/setup.exe
```

`cross-env` is not installed, so no new dependency was added.

---

## 3. Artifact

| Property | Value |
|---|---|
| Path | `dist/setup.exe` |
| Size | 114,153,082 bytes (108.9 MB) |
| SHA-256 | `2101ddf7c4f6cd719b701b7992fa478b73a41607fb5a38ec229fbcb50a763683` |
| Source artifact | `dist-setup-new/BlackStack CRM Setup 1.0.0.exe` (byte-identical, same size) |
| Old installer preserved | `%LOCALAPPDATA%\Temp\bs-old-installer-preserve\` |
| Old installer SHA-256 | `838ff249cab00404146f7e7af765f25eeb49723057ee2cb267adbc6f9e8945ec` |

---

## 4. Configuration inspected (unchanged)

`appId` `com.blackstack.crm` · `productName` BlackStack CRM · target NSIS x64
· `asar` true · `files: [electron/**, server/**, public/**, package.json]`

NSIS: `oneClick: false` (assisted wizard), `allowToChangeInstallationDirectory:
true`, `createDesktopShortcut: true`, `createStartMenuShortcut: true`,
`shortcutName: BlackStack CRM`, **`deleteAppDataOnUninstall: false`**.

electron 44.5.1 · electron-builder 26.15.3.

---

## 5. Proof the installer contains the current fixes

Filenames alone would not prove this, so the asar was extracted and the real
bytes inspected:

```
asar sha256 : 1d44961af108f18578096e9fe0407e21a9e27c783e43f871e5234b56d6585664
entries      : 3185
electron-updater shipped : 69 files

server/utils/errorMapping.js                          PRESENT
server/controllers/activities.controller.js          PRESENT
server/routes/activities.js                          PRESENT
server/services/financial-year-policy.service.js     PRESENT
server/database/connection.js                        PRESENT
server/utils/tenantScope.js                          PRESENT

extractAll -> activities.controller.js  (4112 chars)
    async remove() present   : true     <- CRM-06 delete handler
    NotFoundError used       : true     <- 404-on-not-found
extractAll -> errorMapping.js         (3782 chars)
    SQLITE_CONSTRAINT map   : true     <- CRM-05 error semantics
    activities DELETE route : true
```

47 server/public JS files are newer than the old Oct-06 build, including
`errorMapping.js` and the activities controller. The new installer's SHA-256
differs from the preserved old one.

`electron-updater` ships as 69 files, confirming the Phase D dependency fix
(it is in `dependencies`, not `devDependencies`).

---

## 6. Verification actually executed

| # | Check | Result |
|---|---|---|
| 1 | `dist/setup.exe` exists at exact path | PASS |
| 2 | Size + SHA-256 recorded | PASS |
| 3 | Valid PE (`MZ`) + NSIS magic, stable hash across two reads | **PASS** — repo's own `scripts/verify-installer.js`, exit 0, printed `VERIFY-PASS: setup.exe` |
| 4 | Installs | **BLOCKED** — §7 |
| 5 | App starts after install | PASS (equivalent, stronger) — §6.1 |
| 6 | Correct user-data location | PASS — §6.1 |
| 7 | Existing data survives upgrade | PASS (indirect) — §6.2 |
| 8 | Uninstall does not delete user data | PASS by config — `deleteAppDataOnUninstall: false`, unchanged |
| 9 | Reinstall can access preserved data | NOT RUN — depends on #4 |
| 10 | Bound to local interface, security preserved | PASS — `127.0.0.1`, single-instance and RBAC untouched |
| 11 | Release gates pass | PASS — **16/16**, exit 0 |

### 6.1 Packaged app launches

The freshly built `win-unpacked/BlackStack CRM.exe` was launched with
`BLACKSTACK_USER_DATA_DIR` pointed at a throwaway temp directory:

```
launch        : SERVER HEALTHY (HTTP 200 on /health)
process alive : yes
[main] Verified backup: ...\userdata\backups\database-v1.0.0-...-pre-userdata-migration.sqlite
[main] Portable DB migration verified OK. Source left in place untouched.
[main] CRM server module loaded (desktop binding 127.0.0.1, port 32755)
[migrate] Migrations complete. Data integrity verified.
BlackStack CRM V2 API running on http://127.0.0.1:32755 (v1.0.0)
```

This also exercises the packaged app's own **portable→userData migration path
with verified backups**, which is the highest-risk data-safety code in the
installer.

Files created — all inside the disposable dir, none outside:
```
<tmp>\userdata\backups\database-v1.0.0-...-pre-userdata-migration.sqlite
<tmp>\userdata\backups\database-v1.0.0-...-pre-userdata-migration.json
<tmp>\userdata\backups\database-v1.0.0-...-pre-migration.sqlite
<tmp>\userdata\backups\database-v1.0.0-...-pre-migration.json
<tmp>\userdata\database\blackstack-crm.db
```
Disposable dir removed afterwards: true.

### 6.2 Data preservation

The user's real database was fingerprinted before and after the launch test:

```
REAL user db untouched : true
  mtime 1791351889853.6187 -> 1791351889853.6187
  size       2,891,776 -> 2,891,776
```

A full copy of `%APPDATA%\blackstack-crm-v2` was preserved to
`%LOCALAPPDATA%\Temp\bs-userdata-preserve\appdata-roaming` before any test.

### 6.3 Tests and gates, before the build

```
vitest  : 25 files, 569 tests passed, 0 failed
E2E_PORT=32671 npm run test:release -> 16/16 gates passed
production fingerprint: 5a0215ebba657c679c412d8ff8935497  (before and after)
```

Production `PRAGMA integrity_check: ok`, `foreign_key_check: 0 violations`.
Cleanup A and B: **not executed.**

---

## 7. BLOCKED — installation to `C:\Program Files`

The repo's own guard, `scripts/phase-d-step-3-install-preflight.js`, exits
**3 `PROTECTED`**:

```
[HKLM] BlackStack CRM 1.0.1
  UninstallString : "C:\Program Files\BlackStack CRM\Uninstall BlackStack CRM.exe" /allusers
  dir exists      : true
per-user userData : C:\Users\BLACK STACK\AppData\Roaming\blackstack-crm-v2
  user database   : ...\database\blackstack-crm.db  (2,891,776 bytes)

CLASSIFICATION : PROTECTED
reason         : a registered install and/or real per-user userData exists;
                 installing would overwrite it
may run installer tests : false
```

There is a **live registered installation** of BlackStack CRM 1.0.1 in
Program Files plus real user data with a populated database. Running
`setup.exe` — silently or through the wizard — would **overwrite the user's
installed application**. NSIS resolves the existing HKLM registration, so
"installing to a temp directory" is not actually isolated, which this
preflight documents explicitly.

I stopped rather than risk it. **Authorization is needed** to proceed, and the
task says not to touch production data or existing user records without it.

### How to finish this item

Either:
- **Authorize the install** — the user's current install and its data are
  backed up at `%LOCALAPPDATA%\Temp\bs-userdata-preserve\`, and the old
  installer is preserved; or
- **Authorize removal of the existing install first** (uninstall v1.0.1), then
  install `dist/setup.exe` cleanly.

---

## 8. Signing

`REQUIRE_SIGNING` unset, no `CSC_LINK`. The repo's gate was run:

```
$ node electron/signing-config.js
[signing] No signing credentials - building UNSIGNED development installer. Not for release.
```

This is the project's documented, intended local-development path. Signing was
not bypassed and no certificate was fabricated. Nothing was published; no
updater, publish, or release config was touched.

---

## 9. Limitations

1. **Install/uninstall/reinstall not executed** — blocked by §7, pending
   authorization.
2. **Wizard UI not clicked through** — `oneClick: false` means an assisted
   wizard; the project's own harness also cannot drive it headlessly.
3. **Unsigned** — expected locally; not distributable.
4. **Version unchanged at 1.0.0**, same as the old installer. The content
   differs (new SHA-256), but an updater comparing versions would see
   "already current". Bumping the version is a release decision, not mine.
5. `dist/setup.exe` is a copy of the verified artifact, so it can be
   regenerated from `dist-setup-new/` at any time.