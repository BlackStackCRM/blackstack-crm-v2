# BlackStack CRM — Security Documentation

## Application security posture (Electron)

| Control | Value |
|---|---|
| `contextIsolation` | `true` |
| `nodeIntegration` | `false` |
| Renderer API surface | Minimal `window.desktop` bridge (app info, update check/install, update status events) only. No `fs`, `process`, `require` or arbitrary IPC exposed. |
| Server binding | `127.0.0.1` only in desktop mode (`BLACKSTACK_DESKTOP=1`). Never `0.0.0.0`. |
| Windows Firewall | No inbound rule created (server is local-only). |
| Secrets | JWT secret generated per install; never logged, never in renderer or localStorage. |
| Single instance | Electron `requestSingleInstanceLock()` (authoritative) + diagnostic lock file. |

## Data safety guarantees

- User data lives in `%APPDATA%\BlackStack CRM` (per-Windows-user), never in
  `Program Files`, the asar, or temp extraction directories.
- Every schema migration: verify DB → verified backup → migrate → integrity
  check → FK check → commit. On failure: stop; restore the verified backup
  when policy requires; never create a blank replacement database.
- Updates create and verify a database backup before installation begins.
- Uninstall never deletes user data. Complete deletion requires two explicit
  confirmations (including typing `DELETE`) and a final verified backup.

## Code signing

### Configuration (implemented)

Signing is configured in `electron/signing-config.js` and enforced by the
`npm run electron:build:prod` script. The credential contract:

- **Certificate source:** one PKCS#12/PFX file, provided out-of-band (never
  committed to git). Locally: a path outside the repository. CI/CD: a
  base64-encoded secret (e.g. GitHub secret `WINDOWS_PFX_BASE64`) decoded to
  a temp file by the workflow before the build.
- **Environment variables:**
  - `CSC_LINK` — path or https URL of the `.pfx` certificate (electron-builder
    reads this natively).
  - `CSC_KEY_PASSWORD` — the PFX private-key password.
  - `BLACKSTACK_TSA_URL` — RFC-3161 timestamp authority (default:
    `http://timestamp.digicert.com`).
  - `REQUIRE_SIGNING=1` — production gate: the build **fails** with a clear
    error if credentials are missing.
- **Local development builds** run `npm run electron:build:win` (no gate) and
  produce an UNSIGNED installer. This is expected; unsigned builds must never
  be published.
- **Production builds** run `npm run electron:build:prod`. Verified behavior:
  without credentials and with `REQUIRE_SIGNING=1` the build aborts before
  packaging with `FATAL: REQUIRE_SIGNING=1 but signing credentials are missing`.

### Verification procedure (release)

After creating a signed release build, verify on Windows:

```powershell
$sig = Get-AuthenticodeSignature ".\BlackStack-CRM-Setup.exe"
$sig.Status             # must be: Valid
$sig.SignerCertificate  # must show the BlackStack organization certificate
$sig.StatusMessage
```

A **valid** result means: `Status -eq 'Valid'`, a SignerCertificate is
present, and its chain terminates at a trusted root. `HashMismatch` means the
file was modified after signing — do not distribute.

**Final signature verification requires release credentials.** No signing
certificate is available in the development environment, so the current
development installer is unsigned — this is stated honestly rather than
fabricating a pass.

- Signatures are timestamped via a trusted timestamp authority (e.g. DigiCert
  TSA), so signatures remain valid after the certificate expires.
- Signing credentials come exclusively from secure CI/CD secrets — never from
  source control.
- **Honesty note:** code signing does not completely eliminate Windows
  SmartScreen warnings. SmartScreen reputation depends on Microsoft's systems
  and accumulated download reputation. A signed installer may still show
  "More info → Run anyway" for early builds.

## Verifying the installer (SHA-256)

Every public release publishes the SHA-256 hash of the exact distributed
`BlackStack CRM Setup <version>.exe` on the official release page. The hash
is produced by `npm run release:hash` (`scripts/release-hash.js`) from the
final binary — never from an intermediate build.

To verify before running:

```powershell
Get-FileHash .\BlackStack-CRM-Setup-<version>.exe -Algorithm SHA256
```

Compare the output with the hash published in the release notes. If they do
not match, **do not run the installer** and report it to support.

Also verify the digital signature:

```powershell
Get-AuthenticodeSignature .\BlackStack-CRM-Setup-<version>.exe | Format-List
```

Status should be `Valid` signed by the BlackStack organization certificate.

## What is stored locally and where

- Everything user-owned lives in `%APPDATA%\BlackStack CRM` (per-Windows-user):
  database, backups, uploads, preferences, logs, locks. Never in Program Files,
  the asar, or temp extraction dirs.
- **Multi-user isolation:** each Windows user resolves their own
  `%APPDATA%\BlackStack CRM`; two Windows accounts on one machine cannot see
  each other's CRM data (verified by isolated-path tests).
- The local server binds **127.0.0.1 only**; no firewall rule is created.

## Backups & deletion behavior

- Backups are verified (integrity + schema check) before they count as
  recovery points; rotation keeps a configurable number (default 5) of newest
  verified backups and never removes the only valid recovery point.
- Uninstall never deletes user data. Full deletion exists as an explicit,
  double-confirmed flow (type `DELETE`), refuses to run if the final verified
  backup cannot be created, and writes an audit record outside the deleted
  scope. See `administrator-guide.md` §7.

## Logging & log redaction

- Logs never contain passwords, tokens, API keys, or license secrets. Every
  line written through the log manager is scrubbed (Bearer tokens,
  `Authorization` headers, `password=`/`token=`/`secret=` assignments, private
  key blocks, connection strings, long base64 blobs).
- Rotation: 10 MB per file, 5 rotated files per category, 30-day cleanup —
  the active log file is never deleted by rotation.

## Support bundles

Generated only on explicit user action (`POST /api/datasafety/support-bundle`).
Contents: versions, schema/migration history, backup/storage/update status,
recent logs — all redacted copies, never originals. NEVER included: CRM
records, the database file, uploads, secrets. Temp files are cleaned after
packaging; nothing is uploaded automatically. Review before sharing.

## Antivirus / Windows Defender

- BlackStack CRM never disables Windows Defender, never creates hidden
  antivirus exclusions, and never modifies security settings.
- False positives: if your antivirus flags the installer, first verify the
  SHA-256 hash and signature (above). If both are valid, submit the file to
  your antivirus vendor as a false positive and contact support.

## What is never collected / logged

Passwords, API keys, tokens, license secrets, and CRM records are never
written to logs or crash reports. Crash reporting is opt-in; local crash logs
are stored in `%APPDATA%\BlackStack CRM\logs\crashes\` regardless.

## Future enhancements (not yet implemented — do not assume)

- Database encryption at rest (SQLCipher or equivalent) — future security
  enhancement; will use Windows Credential Manager for key storage, encrypted
  backups, and documented key rotation.
- License key management with secure (non-plaintext) storage.
