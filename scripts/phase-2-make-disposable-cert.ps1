# PHASE 2 — generate a THROWAWAY self-signed Code Signing certificate.
# DISPOSABLE TEST MATERIAL ONLY. Not a production signer, not from a real CA.
# Deleted by phase-2-signing-pipeline-test.js after use.
param(
  [string]$OutPath = "$env:LOCALAPPDATA\Temp\p2-sign\disposable-codesign.pfx",
  [string]$Password = 'pipeline-test-only-not-a-secret'
)
$ErrorActionPreference = 'Stop'

$dir = Split-Path -Parent $OutPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$subject = 'CN=PHASE2 DISPOSABLE PIPELINE TEST - NOT A PRODUCTION SIGNER, O=BlackStack Phase 2 Validation, C=US'
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject `
  -CertStoreLocation Cert:\CurrentUser\My `
  -KeyExportPolicy Exportable -KeyUsage DigitalSignature `
  -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddDays(2)

$secure = ConvertTo-SecureString -String $Password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $OutPath -Password $secure | Out-Null

# Remove it from the user store immediately — the exported .pfx is all we keep.
Remove-Item ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -Force

Write-Output ("THUMBPRINT=" + $cert.Thumbprint)
Write-Output ("PFX=" + $OutPath)
Write-Output ("PFX_EXISTS=" + (Test-Path $OutPath))
Write-Output ("PFX_BYTES=" + (Get-Item $OutPath).Length)
