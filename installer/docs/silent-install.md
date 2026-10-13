# Silent / Unattended Installation — BlackStack CRM

Every command on this page was executed against the real generated installer
(`BlackStack CRM Setup 1.0.0.exe`, electron-builder NSIS, assisted mode) on
Windows 11 x64. No switch is documented here that was not tested.

## Tested and supported switches

| Switch | Tested | Behavior |
|---|---|---|
| `/S` | ✅ Yes | Fully silent install. No wizard appears. Exit code `0` on success. |
| `/S /D=<path>` | ✅ Yes | Silent install into a custom directory. `/D=` must be the LAST argument, unquoted, even for paths with spaces. |

Tested command (PowerShell):

```powershell
$setup = ".\BlackStack CRM Setup 1.0.0.exe"
$target = "$env:TEMP\bscrm-silent-test"
$p = Start-Process -FilePath $setup -ArgumentList '/S', "/D=$target" -Wait -PassThru
$p.ExitCode   # 0 = success
```

Verified results of the test run:

- Exit code: `0`
- Files installed to `$target` (`BlackStack CRM.exe` present)
- No installer UI appeared
- Installed application launched successfully

## Quirks that ARE real (do not "fix" these in scripts)

- `/D=` must be unquoted and be the final argument (standard NSIS limitation).
- NSIS assisted-mode installers support `/S` and `/D=`, but there is no
  separate "log file" switch. For unattended auditing, check the exit code and
  verify the install directory afterward (see verification below).
- Per-user installers (this project installs per-user by default) do **not**
  require elevation; if a deployment tool targets `C:\Program Files` it must
  pass `/D=C:\Program Files\BlackStack CRM` and run elevated.

## Verified not needed / not applicable

- No reboot is ever required by this installer (no drivers, no shared runtime).
- No Windows Firewall rule is created (the CRM server binds 127.0.0.1 only).
- Shortcuts (Desktop / Start Menu) are created by default in silent mode too.

## Post-install verification (for deployment scripts)

```powershell
$target = "$env:ProgramFiles\BlackStack CRM"
if (-not (Test-Path "$target\BlackStack CRM.exe")) { throw "Install failed" }

# Optional: confirm the local server comes up after launching
Start-Process "$target\BlackStack CRM.exe"
$deadline = (Get-Date).AddSeconds(60)
do {
  Start-Sleep -Seconds 2
  $ok = $false
  foreach ($port in 34567..34572) {
    try { $r = Invoke-WebRequest "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 2
          if ($r.StatusCode -eq 200) { $ok = $true; break } } catch {}
  }
} until ($ok -or (Get-Date) -gt $deadline)
if ($ok) { "Install verified, server healthy on 127.0.0.1:$port" } else { throw "Server did not become healthy" }
```

## Silent uninstall

NSIS assisted uninstallers also accept `/S`:

```powershell
Start-Process "$env:ProgramFiles\BlackStack CRM\Uninstall BlackStack CRM.exe" -ArgumentList '/S' -Wait
```

Uninstall removes application binaries only — `%APPDATA%\BlackStack CRM`
(user data) is preserved unless the explicit in-app two-step data-deletion
flow was completed (see `administrator-guide.md`).

## Deployment notes (Intune / SCCM)

- Install command: `BlackStack-CRM-Setup.exe /S`
- Uninstall command: `Uninstall BlackStack CRM.exe /S`
- Success exit codes: `0`. Any non-zero exit must be treated as failure.
- Because the installer is per-user by default, install **per user** (Intune:
  user context) or pass `/D=` with an elevated, machine-wide directory if you
  need a shared binaries location. User data remains per-user in all cases.
