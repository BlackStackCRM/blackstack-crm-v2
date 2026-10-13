#!/usr/bin/env node
/**
 * PHASE 2 — production release baseline capture. READ-ONLY.
 *
 * Records the exact configuration a production release depends on, so any later
 * change is provably scoped. Prints secrets only as PRESENT/ABSENT — never values.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const b = pkg.build || {};

console.log('='.repeat(74));
console.log('PHASE 2 — PRODUCTION RELEASE BASELINE (read-only)');
console.log('='.repeat(74));

console.log('\n## VERSION');
console.log('  package.json version :', pkg.version);
const versionJs = fs.readFileSync(path.join(ROOT, 'server', 'version.js'), 'utf8');
console.log('  server/version.js    :', /package\.json/.test(versionJs) ? 'reads package.json' : 'HARDCODED');
console.log('  hard-coded literal   :', /APP_VERSION\s*=\s*'/.test(versionJs) ? 'YES (bad)' : 'none');

console.log('\n## PUBLISH (production feed configuration in source)');
console.log('  ' + JSON.stringify(b.publish || null));
for (const p of b.publish || []) {
  console.log(`    provider : ${p.provider}`);
  if (p.owner) console.log(`    owner    : ${p.owner}`);
  if (p.repo) console.log(`    repo     : ${p.repo}`);
  if (p.channel) console.log(`    channel  : ${p.channel}`);
  if (p.url) console.log(`    url      : ${p.url}`);
  if (p.private) console.log(`    private  : ${p.private}`);
}

console.log('\n## WIN / NSIS');
console.log('  win.target  :', JSON.stringify(b.win?.target || null));
const nsis = b.nsis || {};
for (const k of ['oneClick', 'perMachine', 'allowToChangeInstallationDirectory', 'createDesktopShortcut',
  'createStartMenuShortcut', 'deleteAppDataOnUninstall', 'allowElevation', 'differentialPackage',
  'artifactName', 'shortcutName']) {
  if (k in nsis) console.log(`  nsis.${k.padEnd(34)}:`, JSON.stringify(nsis[k]));
}

console.log('\n## FILES / EXTRA RESOURCES');
console.log('  files    :', JSON.stringify(b.files || []));
console.log('  extraResources:', JSON.stringify(b.extraResources || null));
console.log('  asar     :', b.asar === undefined ? '(default)' : JSON.stringify(b.asar));

console.log('\n## SIGNING — environment presence only (never values)');
for (const v of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'CSC_IDENTITY_AUTO_DISCOVERY',
  'BLACKSTACK_TSA_URL', 'GH_TOKEN', 'GITHUB_TOKEN', 'ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES']) {
  const val = process.env[v];
  console.log(`  ${v.padEnd(46)}: ${val === undefined ? 'absent' : 'PRESENT (' + String(val).length + ' chars)'}`);
}

console.log('\n## SIGNING — certificates available to the build');
function regQuery(key) {
  try { return execFileSync('reg', ['query', key, '/s'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}
let certCount = 0;
try {
  const ps = `
$c = Get-ChildItem Cert:\\\\CurrentUser\\\\My
Write-Output ("total=" + $c.Count)
foreach ($x in $c) {
  $cs = ($x.EnhancedKeyUsageList | Where-Object { $_.ObjectId.Value -eq '1.3.6.1.5.5.7.3.3' })
  $fp = $x.HasPrivateKey
  Write-Output ("CERT|" + $x.Subject + "|" + $x.Issuer + "|" + $x.NotBefore.ToString('yyyy-MM-dd') + "|" + $x.NotAfter.ToString('yyyy-MM-dd') + "|privkey=" + $fp + "|codesigning=" + [bool]$cs)
}`;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('total=')) { console.log('  ' + t); continue; }
    if (t.startsWith('CERT|')) {
      certCount++;
      const [, subj, iss, nb, na, pk, cs] = t.split('|');
      console.log(`  - ${subj}`);
      console.log(`      issuer=${iss}`);
      console.log(`      valid=${nb} .. ${na}`);
      console.log(`      privateKey=${pk.replace('privkey=', '')}  codeSigningEKU=${cs.replace('codesigning=', '')}`);
    }
  }
} catch (e) { console.log('  cert query failed:', e.message.slice(0, 80)); }

console.log('\n## EXISTING BUILD ARTIFACTS');
for (const tag of ['v1', 'v2']) {
  const dir = path.join(ROOT, 'dist-phase-d', tag);
  if (!fs.existsSync(dir)) { console.log(`  ${tag}: (absent)`); continue; }
  const exe = fs.readdirSync(dir).find((f) => /^BlackStack.*Setup.*\.exe$/i.test(f));
  const asar = path.join(dir, 'win-unpacked', 'resources', 'app.asar');
  console.log(`  ${tag}:`);
  if (exe) {
    const p = path.join(dir, exe);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    console.log(`    installer : ${exe}`);
    console.log(`    size      : ${fs.statSync(p).size}`);
    console.log(`    sha256    : ${sha}`);
  }
  const meta = path.join(dir, 'latest.yml');
  if (fs.existsSync(meta)) {
    console.log(`    latest.yml: ${fs.readFileSync(meta, 'utf8').split('\n').filter(l => l.trim()).slice(0, 4).join(' | ')}`);
  }
  const auy = path.join(dir, 'win-unpacked', 'resources', 'app-update.yml');
  if (fs.existsSync(auy)) {
    console.log(`    app-update.yml (PACKAGED):`);
    for (const l of fs.readFileSync(auy, 'utf8').split('\n')) console.log(`      ${l}`);
  }
  if (fs.existsSync(asar)) {
    console.log(`    asar sha256: ${crypto.createHash('sha256').update(fs.readFileSync(asar)).digest('hex').slice(0, 32)}...`);
  }
}

console.log('\n## PACKAGED app-update.yml — MUST NOT LEAK STAGING INTO PRODUCTION');
for (const tag of ['v1', 'v2']) {
  const auy = path.join(ROOT, 'dist-phase-d', tag, 'win-unpacked', 'resources', 'app-update.yml');
  if (!fs.existsSync(auy)) continue;
  const txt = fs.readFileSync(auy, 'utf8');
  const loopback = /127\.0\.0\.1|localhost/.test(txt);
  console.log(`  ${tag}: ${loopback ? 'STAGING/LOOPBACK  <-- test build, not production' : 'production-looking'}`);
}

console.log('\n## .gitignore credential protection');
const gi = path.join(ROOT, '.gitignore');
if (fs.existsSync(gi)) {
  const lines = fs.readFileSync(gi, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  const prot = lines.filter(l => /\.env|pfx|p12|pem|keystore|cert|secret|credential|token/i.test(l));
  console.log('  credential-related entries:', prot.length ? prot.join(', ') : '(none found)');
} else console.log('  no .gitignore');

console.log('\n## npm scripts (release-relevant)');
for (const [k, v] of Object.entries(pkg.scripts || {})) {
  if (/release|build|seed|sign|publish|dist/i.test(k)) console.log(`  ${k.padEnd(22)}: ${String(v).slice(0, 90)}`);
}
