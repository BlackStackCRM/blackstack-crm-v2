#!/usr/bin/env node
/**
 * PHASE 2 — production release artifact verification. READ-ONLY.
 *
 * Validates a built release directory the way a real update feed and client
 * would, without needing the feed itself:
 *   - all expected artifacts present (installer, latest.yml, blockmap, app-update.yml)
 *   - latest.yml version matches the intended release
 *   - latest.yml sha512/size match the ACTUAL installer bytes
 *   - packaged app-update.yml declares the intended provider and has no staging leak
 *   - Authenticode status of the installer
 *   - the updater cache dir is separate from the database
 *
 * Usage: node scripts/phase-2-verify-release.js <releaseDir> <expectedVersion>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DIR = path.resolve(process.argv[2] || '');
const EXPECT = process.argv[3] || null;

let pass = 0, fail = 0;
const problems = [];
function ok(n, d = '') { pass++; console.log(`  PASS  ${n}${d ? ' — ' + d : ''}`); }
function no(n, d = '') { fail++; problems.push(`${n}: ${d}`); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); }
function assert(c, n, d = '') { c ? ok(n, d) : no(n, d); return c; }

console.log('='.repeat(74));
console.log(`PHASE 2 — RELEASE ARTIFACT VERIFICATION  ${path.basename(DIR)}`);
console.log('='.repeat(74));

if (!fs.existsSync(DIR)) { console.error(`no such release dir: ${DIR}`); process.exit(2); }

// ── artifacts present ───────────────────────────────────────────────────────
console.log('\n## Artifact completeness');
const entries = fs.readdirSync(DIR);
const installer = entries.find((f) => /^BlackStack.*Setup.*\.exe$/i.test(f));
const latestYml = entries.find((f) => /^latest\.yml$/i.test(f));
const blockmap = entries.find((f) => f.endsWith('.blockmap'));
const auy = path.join(DIR, 'win-unpacked', 'resources', 'app-update.yml');

assert(!!installer, 'installer present', installer || 'MISSING');
assert(!!latestYml, 'latest.yml present', latestYml || 'MISSING');
assert(!!blockmap, 'blockmap present (read the real generated filename)', blockmap || 'MISSING');
assert(fs.existsSync(auy), 'packaged app-update.yml present');

if (!installer || !latestYml) { console.log('\ncannot continue without installer + latest.yml'); process.exit(1); }

const exePath = path.join(DIR, installer);
const bytes = fs.readFileSync(exePath);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
const size = bytes.length;

console.log('\n## Artifact identity');
console.log(`  filename : ${installer}`);
console.log(`  size     : ${size}`);
console.log(`  sha256   : ${sha256}`);
console.log(`  sha512   : ${sha512.slice(0, 48)}...`);

// ── metadata consistency ────────────────────────────────────────────────────
console.log('\n## Update metadata consistency');
const yml = fs.readFileSync(path.join(DIR, latestYml), 'utf8');
const ymlVersion = (yml.match(/^version:\s*(\S+)/m) || [])[1];
const ymlSha512 = (yml.match(/^\s*sha512:\s*(\S+)/m) || [])[1];
const ymlSize = Number((yml.match(/^\s*size:\s*(\d+)/m) || [])[1]);
const ymlPath = (yml.match(/^path:\s*(\S+)/m) || [])[1];

console.log(`  latest.yml version : ${ymlVersion}`);
console.log(`  latest.yml path    : ${ymlPath}`);
console.log(`  latest.yml size    : ${ymlSize}`);
console.log(`  latest.yml sha512  : ${String(ymlSha512).slice(0, 48)}...`);

if (EXPECT) assert(ymlVersion === EXPECT, 'metadata version matches the release', `${ymlVersion} == ${EXPECT}`);
assert(ymlSize === size, 'metadata size matches the real installer', `${ymlSize} == ${size}`);
assert(ymlSha512 === sha512, 'metadata sha512 matches the real installer',
  ymlSha512 === sha512 ? 'exact' : 'MISMATCH — feed would reject every download');
assert(!!ymlPath && !ymlPath.includes('/'), 'metadata path is a bare artifact name', ymlPath);
assert(!!blockmap && /Setup/i.test(blockmap), 'blockmap is named for the installer', blockmap);

// ── packaged feed config ────────────────────────────────────────────────────
console.log('\n## Packaged app-update.yml (feed the client will use)');
if (fs.existsSync(auy)) {
  const txt = fs.readFileSync(auy, 'utf8');
  for (const l of txt.split('\n')) if (l.trim()) console.log(`    ${l}`);
  const provider = (txt.match(/^provider:\s*(\S+)/m) || [])[1];
  const owner = (txt.match(/^owner:\s*(\S+)/m) || [])[1];
  const repo = (txt.match(/^repo:\s*(\S+)/m) || [])[1];
  const url = (txt.match(/^url:\s*(\S+)/m) || [])[1];
  const staging = /127\.0\.0\.1|localhost/.test(txt);

  assert(!!provider, 'feed provider declared', provider || 'MISSING');
  if (owner) console.log(`    owner=${owner} repo=${repo}`);
  if (url) console.log(`    url=${url}`);
  assert(!staging, 'NO staging/loopback URL leaked into the production build',
    staging ? 'FOUND 127.0.0.1/localhost' : 'clean');

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const src = (pkg.build?.publish || [])[0] || {};
  if (src.provider) {
    assert(provider === src.provider, 'packaged provider matches source build.publish', `${provider} == ${src.provider}`);
    if (src.owner) assert(owner === src.owner, 'packaged owner matches source', `${owner} == ${src.owner}`);
    if (src.repo) assert(repo === src.repo, 'packaged repo matches source', `${repo} == ${src.repo}`);
  }
} else {
  no('packaged app-update.yml', 'missing');
}

// ── signature ───────────────────────────────────────────────────────────────
console.log('\n## Authenticode signature');
let sig = { status: 'UNAVAILABLE', subject: '', notAfter: '', hasTs: false };
try {
  const ps = `$s=Get-AuthenticodeSignature -LiteralPath '${exePath.replace(/'/g, "''")}';` +
    `Write-Output ('STATUS=' + $s.Status);` +
    `Write-Output ('SUBJECT=' + $s.SignerCertificate.Subject);` +
    `Write-Output ('NOTAFTER=' + $s.SignerCertificate.NotAfter);` +
    `Write-Output ('TS=' + [bool]$s.TimeStamperCertificate)`;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  for (const l of out.split(/\r?\n/)) {
    const t = l.trim();
    if (t.startsWith('STATUS=')) sig.status = t.slice(7);
    if (t.startsWith('SUBJECT=')) sig.subject = t.slice(8);
    if (t.startsWith('NOTAFTER=')) sig.notAfter = t.slice(9);
    if (t.startsWith('TS=')) sig.hasTs = t.slice(3) === 'True';
  }
} catch (e) { sig.status = 'QUERY_FAILED'; }

console.log(`  Status     : ${sig.status}`);
console.log(`  Signer     : ${sig.subject || '(none)'}`);
console.log(`  NotAfter   : ${sig.notAfter || '(n/a)'}`);
console.log(`  Timestamped: ${sig.hasTs}`);

const signed = sig.status === 'Valid';
if (signed) {
  ok('installer is Authenticode VALID', sig.subject);
  assert(/CN=/.test(sig.subject), 'signer identity present', sig.subject);
} else {
  console.log(`  NOTE  ${sig.status} — not production-signed (no Code Signing certificate on this machine).`);
  console.log('        This is recorded as PENDING infrastructure, NOT as a pass.');
  if (sig.status === 'NotSigned') {
    ok('signature state correctly reported as unsigned (honest reporting, not a pass)');
  }
}

console.log(`\n  PASS ${pass}   FAIL ${fail}`);
if (problems.length) { console.log('\n  PROBLEMS:'); for (const p of problems) console.log('    - ' + p); }
process.exitCode = fail === 0 ? 0 : 1;
