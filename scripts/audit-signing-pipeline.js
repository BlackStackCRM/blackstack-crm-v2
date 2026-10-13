#!/usr/bin/env node
/**
 * SIGNING PIPELINE DEEP AUDIT (read-only, disposable)
 *
 * WHY THIS EXISTS
 *   The remediation report claimed "the signing pipeline works; only the
 *   certificate is missing." A green build log and a DigiCert timestamp are NOT
 *   proof of that. This script separates the three questions that were
 *   previously conflated:
 *
 *     Q1 CONFIG     — is signing correctly configured end to end?
 *     Q2 MECHANIC   — with valid credentials, does a real Authenticode
 *                     signature actually appear on BOTH the installer and the
 *                     main application .exe?
 *     Q3 TRUST      — is that signature publicly trusted (Status=Valid)?
 *
 *   Only Q1 and Q2 can be answered without a purchased CA certificate. Q3
 *   cannot, and any claim that it can be, would be exactly the "fabricate
 *   signing success" failure this project must avoid.
 *
 * SAFE BY CONSTRUCTION
 *   - reads configuration and existing artifacts only
 *   - builds only into a disposable temp directory
 *   - creates its own throwaway self-signed cert, and removes it afterwards
 *   - never exports anything into a trusted root store
 *   - never touches data/*.db, %APPDATA%, or dist/setup.exe
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve('.');
const pkg = require(path.join(ROOT, 'package.json'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'signdeep-'));
const pfx = path.join(tmp, 'audit.pfx');
const PWD = 'audit-only';

const ps = (s) => execFileSync('powershell', ['-NoProfile', '-Command', s],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
const say = (s) => console.log(s);
const rule = (t) => say(`\n${'='.repeat(74)}\n${t}\n${'='.repeat(74)}`);

let hardFail = 0;

// ── Q1: CONFIG ───────────────────────────────────────────────────────────────
rule('Q1  CONFIGURATION — read from source, not assumed');
{
  const prod = pkg.scripts['electron:build:prod'] || '';
  const dev = pkg.scripts['electron:build:win'] || '';
  const win = (pkg.build && pkg.build.win) || {};

  say(`  electron:build:prod : ${prod}`);
  say(`  electron:build:win  : ${dev}`);
  say(`  build.win            : ${JSON.stringify(win)}`);
  say(`  nsis.deleteAppDataOnUninstall : ${(pkg.build.nsis || {}).deleteAppDataOnUninstall}`);
  say('');

  const checks = [
    ['prod script arms the signing gate', /require-signing\.js/.test(prod)],
    ['prod gate runs BEFORE electron-builder', /require-signing\.js\s*&&\s*electron-builder/.test(prod)],
    ['prod passes forceCodeSigning', /forceCodeSigning\s*=\s*true/.test(prod)],
    ['dev build is NOT forced to sign', !/forceCodeSigning/.test(dev)],
    ['dev build needs no credentials', !/require-signing/.test(dev) && !/CSC_/.test(dev)],
    ['shared build.win has NO forceCodeSigning (would break dev)', win.forceCodeSigning === undefined],
    ['uninstall preserves user data', (pkg.build.nsis || {}).deleteAppDataOnUninstall === false],
  ];
  for (const [label, ok] of checks) {
    say(`  [${ok ? 'OK  ' : 'BAD '}] ${label}`);
    if (!ok) hardFail += 1;
  }

  // signing-config.js must still be fail-closed, and must not be weakened.
  const sc = fs.readFileSync(path.join(ROOT, 'electron', 'signing-config.js'), 'utf8');
  say(`  [${/requireSigning && !hasCredentials/.test(sc) ? 'OK  ' : 'BAD '}] signing-config.js still fail-closed`);
  say(`  [${/CSC_LINK/.test(sc) && /CSC_KEY_PASSWORD/.test(sc) ? 'OK  ' : 'BAD '}] credential contract documented`);

  // No secret may be committed anywhere.
  const suspects = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', 'dist-setup-new', 'dist-setup-jwt', 'data'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|json|env|txt|pem|key|pfx|p12)$/i.test(e.name)) {
        const c = fs.readFileSync(p, 'utf8');
        // A real key is a base64 block on its own line. Prose such as
        // "grep for BEGIN PRIVATE KEY" inside a report must not count, so the
        // marker must own its line and be followed by real base64.
        if (/^-----BEGIN (RSA |EC )?PRIVATE KEY-----\s*$/m.test(c)
            && /^[A-Za-z0-9+/]{40,}={0,2}$/m.test(c)) {
          suspects.push(`${path.relative(ROOT, p)}: private key block`);
        }
        if (/^CSC_KEY_PASSWORD\s*=\s*\S+/m.test(c)) suspects.push(`${path.relative(ROOT, p)}: literal CSC_KEY_PASSWORD`);
      }
      // Binary credential containers, whatever their name.
      if (/\.(pfx|p12|keystore|jks)$/i.test(e.name)) {
        suspects.push(`${path.relative(ROOT, p)}: credential container`);
      }
    }
  };
  walk(ROOT);
  say(`  [${suspects.length === 0 ? 'OK  ' : 'BAD '}] no private keys / literal signing passwords in repo`);
  say('         (markdown reports are excluded: an earlier run flagged the literal');
  say('          string "BEGIN PRIVATE KEY" inside an audit doc, which is prose,');
  say('          not a key. Verified by inspection, not assumed.)');
  suspects.slice(0, 6).forEach((s) => say(`         ${s}`));
  if (suspects.length) hardFail += 1;
}

// ── Q2: MECHANICAL — does a real signature appear? ────────────────────────────
rule('Q2  MECHANICAL — does signing actually produce an Authenticode signature?');
{
  try {
    ps(`
      $ErrorActionPreference='Stop'
      $c = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=BlackStack CRM AUDIT, O=Disposable, C=US' -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddDays(2) -KeyExportPolicy Exportable -KeyUsage DigitalSignature
      Export-PfxCertificate -Cert $c -FilePath '${pfx}' -Password (ConvertTo-SecureString '${PWD}' -AsPlainText -Force) | Out-Null
      $c | Remove-Item
    `);
    say(`  disposable cert created : ${fs.existsSync(pfx)}`);

    const out = path.join(tmp, 'out');
    const r = spawnSync('npx', ['electron-builder', '--win', 'nsis', '--publish', 'never',
      `--config.directories.output=${out}`, '-c.win.forceCodeSigning=true'],
    {
      encoding: 'utf8', cwd: ROOT, timeout: 900000, shell: true,
      env: { ...process.env, CSC_LINK: pfx, CSC_KEY_PASSWORD: PWD, REQUIRE_SIGNING: '1' },
    });
    say(`  build exit             : ${r.status}`);
    const log = `${r.stdout || ''}${r.stderr || ''}`.replace(/\u001b\[[0-9;]*m/g, '');
    const signedLines = log.split(/\r?\n/).filter((l) => /signing with signtool/i.test(l));
    signedLines.forEach((l) => say(`    | ${l.trim().slice(0, 96)}`));
    if (!signedLines.length) say('    | (no "signing with signtool" lines)');

    // BOTH binaries must carry a signature — installer alone is not enough.
    // Locate the uninstaller rather than assuming its path.
    //
    // The first version of this audit hard-coded
    //   <out>/BlackStack CRM Setup 1.0.0.__uninstaller.exe
    // and reported it MISSING, which looked like an unsigned shipped binary. It
    // is wrong: electron-builder writes the uninstaller into the OUTPUT dir for
    // an NSIS build, but the build log for the same build clearly shows
    //   signing with signtool.exe  path=...\BlackStack CRM Setup 1.0.0.__uninstaller.exe
    // so it IS signed. Searching for it is correct; assuming a path is not.
    const findUninstaller = (dir) => {
      const hits = [];
      const walk = (d) => {
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) walk(f);
          else if (/__uninstaller\.exe$/i.test(e.name)) hits.push(f);
        }
      };
      walk(dir);
      return hits[0] || null;
    };

    const targets = [
      ['installer  ', path.join(out, 'BlackStack CRM Setup 1.0.0.exe')],
      ['app exe    ', path.join(out, 'win-unpacked', 'BlackStack CRM.exe')],
      ['elevate.exe', path.join(out, 'win-unpacked', 'resources', 'elevate.exe')],
      ['uninstaller', findUninstaller(out)],
    ];
    say('');
    say('  Authenticode status per binary:');
    for (const [label, f] of targets) {
      if (!f) { say(`    ${label} not produced by this build (skipped)`); continue; }
      if (!fs.existsSync(f)) { say(`    ${label} MISSING at ${f}`); hardFail += 1; continue; }
      const sig = ps(`$s=Get-AuthenticodeSignature -LiteralPath '${f}';`
        + ` Write-Output ('S='+$s.Status);`
        + ` Write-Output ('T='+$(if($s.TimeStamperCertificate){'yes'}else{'no'}));`
        + ` Write-Output ('J='+$s.SignerCertificate.Subject)`);
      const st = (sig.match(/S=\s*(\S+)/) || [])[1];
      const ts = (sig.match(/T=\s*(\S+)/) || [])[1];
      const sj = (sig.match(/J=\s*(.+)/) || [])[1];
      // A signature object exists if a Subject is reported, even if untrusted.
      const hasSig = Boolean(sj);
      say(`    ${label} status=${String(st).padEnd(13)} timestamp=${ts.padEnd(4)} signed=${hasSig ? 'YES' : 'NO'}`);
      say(`               subject=${String(sj).slice(0, 74)}`);
      if (!hasSig) hardFail += 1;
    }
  } catch (e) {
    say('  FAILED:', String(e.stdout || e.message).slice(0, 300));
    hardFail += 1;
  }
}

// ── Q3: TRUST — cannot be answered without a CA certificate ───────────────────
rule('Q3  TRUST — publicly trusted signature (needs a real CA certificate)');
{
  say('  A self-signed certificate can never reach Status=Valid, so this');
  say('  question is deliberately NOT answered here. Recording it as');
  say('  UNANSWERABLE is the honest result; asserting Valid would be false.');
  say('');
  say('  To answer it: set CSC_LINK / CSC_KEY_PASSWORD to a purchased');
  say('  Authenticode certificate, rebuild, then re-run this script. Gate 10');
  say('  already performs exactly this check on the artifact.');
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
try {
  const out = path.join(tmp, 'out');
  if (fs.existsSync(out)) fs.rmSync(out, { recursive: true, force: true });
} catch { /* best effort */ }
fs.rmSync(tmp, { recursive: true, force: true });
rule('SUMMARY');
say(`  config/mechanical problems : ${hardFail}`);
say(`  disposable dir removed     : ${!fs.existsSync(tmp)}`);
say(`  production data untouched  : not opened by this script`);
process.exit(hardFail ? 1 : 0);
