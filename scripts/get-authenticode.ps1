# Reads the Authenticode signature of ONE file and prints three lines:
#   STATUS=<Get-AuthenticodeSignature .Status>   Valid | NotSigned | HashMismatch | UnknownError ...
#   SUBJECT=<SignerCertificate.Subject>          empty when unsigned
#   TS=<yes|no>                                  RFC-3161 timestamp present
#
# Exits 0 on success, non-zero on any failure, so a caller can never mistake
# "could not verify" for "unsigned but fine".
#
# WHY THE PATH ARRIVES IN AN ENVIRONMENT VARIABLE, NOT AN ARGUMENT
#   This repository lives under a path containing spaces ("CB CRM V2"), and the
#   build/test toolchain runs under an MSYS-style layer. Four different ways of
#   passing the path on the command line were tried and every one was WRONG:
#
#     1. `powershell -Command "... $args[0] ..." <path>`
#        -> $args arrives EMPTY under -Command.
#     2. Interpolating the path into the -Command string
#        -> breaks on any path containing a quote character.
#     3. `execFileSync(..., { shell:false })` from this process
#        -> the path arrived as `D:WorkProjects...v2distsetup.exe`: backslashes
#           were eaten and separators normalised, so the argument was mangled
#           BEFORE PowerShell saw it. windowsVerbatimArguments made it worse
#           (the arg then split into 3 fragments).
#     4. Manually quoting the argument
#        -> still mangled, same root cause.
#
#   In every one of those cases PowerShell reported a generic
#   "Illegal characters in path" or an empty argument, and — crucially — the
#   caller received NO STATUS line and silently treated the file as unsigned.
#   That is a verification step reporting success while verifying nothing.
#
#   An environment variable is passed through verbatim by every layer, so it is
#   the only reliable channel on this host. The variable name is unusual on
#   purpose to avoid colliding with anything else in the environment.
$ErrorActionPreference = 'Stop'

$path = $env:BSCRM_SIG_TARGET

if ([string]::IsNullOrWhiteSpace($path)) {
    Write-Error 'BSCRM_SIG_TARGET is not set; refusing to report a signature status.'
    exit 2
}

if (-not (Test-Path -LiteralPath $path)) {
    Write-Error ("file not found: " + $path)
    exit 3
}

$s = Get-AuthenticodeSignature -LiteralPath $path

$subject = ''
if ($null -ne $s.SignerCertificate) { $subject = $s.SignerCertificate.Subject }

$ts = 'no'
if ($null -ne $s.TimeStamperCertificate) { $ts = 'yes' }

Write-Output ("STATUS=" + $s.Status)
Write-Output ("SUBJECT=" + $subject)
Write-Output ("TS=" + $ts)
