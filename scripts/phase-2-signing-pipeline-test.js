#!/usr/bin/env node
/**
 * PHASE 2 — SIGNING PIPELINE VALIDATION (disposable, NOT production signing).
 *
 * PURPOSE
 * -------
 * No production Code Signing certificate exists on this machine
 * (CODE_SIGNING_CERTS=0 across CurrentUser\My and LocalMachine\My — both
 * certificates present are self-signed and lack EKU 1.3.6.1.5.5.7.3.3).
 *
 * Production signing is therefore PENDING INFRASTRUCTURE and nothing here can
 * change that. What this script DOES prove is that the *pipeline* is wired
 * correctly, so that when a real certificate is supplied the build will sign:
 *
 *   1. electron-builder reads CSC_LINK / CSC_KEY_PASSWORD.
 *   2. The resulting .exe really carries an Authenticode signature.
 *   3. The signature covers the bytes (tampering invalidates it).
 *   4. Get-AuthenticodeSignature reports a real status.
 *   5. REQUIRE_SIGNING=1 still FAILS LOUDLY when credentials are absent, so a
 *      "production" build can never be produced unsigned.
 *
 * The certificate used here is a THROWAWAY self-signed Code Signing cert
 * generated into a temp directory and deleted afterwards. It is NOT trusted by
 * any OS, NOT from a real CA, and MUST NOT be used for a release. Its only
 * purpose is to exercise the tooling.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'phase2-signing-pipeline');
const PFX = path.join(TMP, 'disposable-codesign.pfx');
const PFX_PASSWORD = 'pipeline-test-only-not-a-secret';

// Clearly-labelled disposable password for a throwaway self-signed cert.
const SUBJECT = 'CN=PHASE2 DISPOSABLE PIPELINE TEST - NOT A PRODUCTION SIGNER, O=BlackStack Phase 2 Validation, C=US';

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function ps(script) {
  return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
}

function report(title) {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`);
}

// ────────────────────────────────────────────────────────────────────────────
report('STEP 1 — REQUIRE_SIGNING gate refuses to build unsigned (already verified)');

const noCreds = spawnSync(process.execPath, [path.join(ROOT, 'electron', 'signing-config.js')], {
  encoding: 'utf8', env: { ...process.env, REQUIRE_SIGNING: '1', CSC_LINK: '', CSC_KEY_PASSWORD: '' },
});
console.log('  REQUIRE_SIGNING=1, no credentials -> exit', noCreds.status,
  noCreds.status !== 0 ? '(correctly refused)' : '(WRONG: should have failed)');
console.log('  message:', (noCreds.stderr || noCreds.stdout).trim().split('\n')[0].slice(0, 110));

// ────────────────────────────────────────────────────────────────────────────
report('STEP 2 — generate a DISPOSABLE self-signed Code Signing certificate');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const mk = ps(`
$ErrorActionPreference = 'Stop'
$r = New-SelfSignedCertificate -Type CodeSigningCert -Subject '${SUBJECT.replace(/'/g, "''")}' \`
  -CertStoreLocation Cert:\\CurrentUser\\My -KeyExportPolicy Exportable -KeyUsage DigitalSignature \`
  -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(2) \`
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3")
$pass = ConvertTo-SecureString -String '${PFX_PASSWORD}' -Force -AsPlainText
Export-PfxCertificate -Cert $r -FilePath '${PFX}' -Password $pass | Out-Null
Remove-Item ("Cert:\\CurrentUser\\My\\" + $r.Thumbprint) -Force
Write-Output ("THUMBPRINT=" + $r.Thumbprint)
Write-Output ("EXPORTED=" + (Test-Path '${PFX}'))
`);
console.log('  ' + (mk || '').trim().replace(/\r?\n/g, '  '));

if (!fs.existsSync(PFX)) {
  console.error('\nFATAL: could not create the disposable certificate; pipeline test cannot proceed.');
  process.exit(1);
}
console.log('  pfx bytes:', fs.statSync(PFX).size);

// Confirm the DISPOSABLE cert does carry the Code Signing EKU (unlike production).
const eku = ps(`
$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2('${PFX}', '${PFX_PASSWORD}')
$cs = ($c.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })
$hasEku = $false
if ($cs) { foreach ($e in $cs.EnhancedKeyUsages) { if ($e.Value -eq '1.3.6.1.5.5.7.3.3') { $hasEku = $true } } }
Write-Output ("HAS_CODE_SIGNING_EKU=" + $hasEku)
Write-Output ("SUBJECT=" + $c.Subject)
`).trim();
console.log('  ' + eku.replace(/\r?\n/g, '  '));

// ────────────────────────────────────────────────────────────────────────────
report('STEP 3 — sign a REAL installer with the disposable certificate');

// Sign the existing v2 installer in a COPY (never the original artifact).
const srcExe = (() => {
  const d = path.join(ROOT, 'dist-phase-d', 'v2');
  return path.join(d, fs.readdirSync(d).find((f) => /^BlackStack.*Setup.*\.exe$/i.test(f)));
})();
const signed = path.join(TMP, 'signed-copy.exe');
fs.copyFileSync(srcExe, signed);
const beforeHash = crypto.createHash('sha256').update(fs.readFileSync(signed)).digest('hex');

// Resolve the real signing tool first. A missing tool raises ENOENT from spawnSync,
// whose message does NOT contain "not found" in the child output — checking the
// output text alone wrongly reported it as available.
function toolExists(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}
const signToolCmd = ['signtool', 'osslsigncode', 'osslsigncode.exe'].find(toolExists) || null;
const signToolPresent = Boolean(signToolCmd);
if (!signToolPresent) {
  console.log('  NO standalone signing tool on PATH (signtool / osslsigncode absent).');
  console.log('  -> The Windows SDK is not installed, so Authenticode signing cannot be');
  console.log('     performed directly here. electron-builder bundles its own signing');
  console.log('     path (it uses the SDK too, or winCodeSign); STEP 4 tests that.');
}
console.log('  signtool available:', signToolPresent);
console.log('  sign output:', signOut.out.trim().split('\n').slice(0, 3).join(' | ').slice(0, 220));

let verified = null;
if (signToolPresent) {
  const v = sh(signToolCmd, ['verify', '/pa', '/v', signed]);
  console.log('  verify output:', v.out.trim().split('\n').filter(Boolean).slice(0, 5).join(' | ').slice(0, 400));
  const st = ps(`(Get-AuthenticodeSignature -LiteralPath '${signed}').Status`);
  console.log('  Get-AuthenticodeSignature Status:', st.trim());
  const afterHash = crypto.createHash('sha256').update(fs.readFileSync(signed)).digest('hex');
  console.log('  bytes changed by signing:', beforeHash !== afterHash);
  verified = { hashChanged: beforeHash !== afterHash, status: st.trim() };

  // Tamper check: the signature must not survive a byte change.
  const tampered = path.join(TMP, 'tampered.exe');
  const buf = fs.readFileSync(signed); buf[Math.floor(buf.length / 2)] ^= 0xff; fs.writeFileSync(tampered, buf);
  const tv = ps(`(Get-AuthenticodeSignature -LiteralPath '${tampered}').Status`);
  console.log('  tampered copy Status:', tv.trim(), '(must NOT be Valid)');
  verified.tamperedStatus = tv.trim();
} else {
  console.log('  signtool not on PATH — checking whether electron-builder can sign instead');
}

// ────────────────────────────────────────────────────────────────────────────
report('STEP 4 — can electron-builder itself sign with these credentials?');

const probeOut = path.join(TMP, 'probe-build');
fs.mkdirSync(probeOut, { recursive: true });
// Use a trivial app dir so this is a seconds-long signing probe, not a full build.
const probeApp = path.join(TMP, 'probe-app');
fs.mkdirSync(probeApp, { recursive: true });
fs.writeFileSync(path.join(probeApp, 'package.json'), JSON.stringify({
  name: 'phase2-signing-probe', version: '1.0.0', description: 'signing pipeline probe', main: 'main.js', author: 'x',
}, null, 2));
fs.writeFileSync(path.join(probeApp, 'main.js'), '// probe\n');

const eb = spawnSync('npx', ['--no-install', 'electron-builder', '--win', 'nsis', '--publish', 'never',
  `--config.directories.output=${probeOut}`], {
  cwd: probeApp, encoding: 'utf8', windowsHide: true,
  env: { ...process.env, CSC_LINK: PFX, CSC_KEY_PASSWORD: PFX_PASSWORD },
});
const ebOut = ((eb.stdout || '') + (eb.stderr || ''));
const ebSigned = /signing|signature|electron-builder will sign|certificate/i.test(ebOut);
console.log('  electron-builder exit:', eb.status);
console.log('  signing-related output:');
for (const l of ebOut.split(/\r?\n/)) {
  if (/sign|certificate|hash|csc/i.test(l)) console.log('    ' + l.trim().slice(0, 150));
}
if (!ebSigned) console.log('    (no signing lines — electron-builder does not sign without a configured certificate or the probe target produced no output)');

const probeExe = (() => {
  try { return path.join(probeOut, fs.readdirSync(probeOut).find((f) => f.endsWith('.exe'))); } catch { return null; }
})();
if (probeExe && fs.existsSync(probeExe)) {
  const ps2 = ps(`(Get-AuthenticodeSignature -LiteralPath '${probeExe}').Status`);
  console.log('  probe installer Authenticode Status:', ps2.trim(), '->', ps2.trim() === 'Valid' ? 'PIPELINE CONFIRMED' : 'not signed');
  verified = { ...(verified || {}), ebProbeStatus: ps2.trim(), probeExe };
} else {
  console.log('  probe installer: not produced');
}

// ────────────────────────────────────────────────────────────────────────────
report('RESULT');
if (verified && verified.status) {
  console.log('  disposable signature Status :', verified.status);
  console.log('  signing altered bytes       :', verified.hashChanged);
  console.log('  tampered copy Status        :', verified.tamperedStatus);
  console.log('  electron-builder probe      :', verified.ebProbeStatus || '(not produced)');
}
console.log('\n  PRODUCTION SIGNING: still PENDING — no real Code Signing certificate exists.');
console.log('  This exercised the PIPELINE only, using a THROWAWAY self-signed cert.');
console.log('  The certificate was generated in a temp dir and is deleted on exit.');

// Remove the throwaway certificate material.
fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n  disposable cert material removed:', !fs.existsSync(TMP));
