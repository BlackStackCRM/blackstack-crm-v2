/**
 * E-10 REGRESSION — gate 10 must verify real signatures, not assume them.
 *
 * WHY THIS SUITE EXISTS
 *   The first version of gate 10 was a security check that reported a result
 *   while checking nothing. Three independent defects, all found by review:
 *
 *     1. It inspected only the installer, never the shipped app .exe.
 *     2. It printed the signer subject but never compared it, so ANY trusted
 *        certificate would have passed — including one issued to a different
 *        company.
 *     3. It passed the file path into a PowerShell `-Command` string. The
 *        repo lives at "...\CB CRM V2\..." — a path with spaces — and the MSYS
 *        layer in this toolchain rewrites separators, so PowerShell received a
 *        mangled path, printed no STATUS line, and the gate fell through to the
 *        unsigned branch. Without `$ErrorActionPreference='Stop'` the error went
 *        to stderr and execution continued, so nothing surfaced.
 *
 *   A verification that cannot read its input must never look like one that
 *   did. These tests pin the helper and the gate's decision logic.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HELPER = path.join(ROOT, 'scripts', 'get-authenticode.ps1');
const gateSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'release-gate.js'), 'utf8');

const runHelper = (target) => {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER],
    {
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      // The path MUST travel as a native Windows path via env var; passing it as
      // an argument is what broke the original gate.
      env: { ...process.env, BSCRM_SIG_TARGET: target },
    },
  );
  const get = (k) => (out.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
  return { status: get('STATUS'), subject: get('SUBJECT'), ts: get('TS') };
};

describe('E-10 gate 10: signature verification helper', () => {
  test('helper script exists and is invoked with -File, not -Command', () => {
    expect(fs.existsSync(HELPER)).toBe(true);
    expect(gateSrc).toMatch(/'-File',\s*SIG_HELPER/);
    expect(gateSrc).not.toMatch(/-Command['"]?,\s*`?\$/);
  });

  test('path travels through an env var, never an interpolated command string', () => {
    // The original bug: `-Command "... LiteralPath '${path}' ..."`.
    expect(gateSrc).toMatch(/BSCRM_SIG_TARGET/);
    expect(gateSrc).not.toMatch(/LiteralPath\s*'\$\{/);
  });

  test('every path handed to PowerShell is normalised to native Windows form', () => {
    // Mandatory here: the repo path contains spaces ("CB CRM V2") and MSYS
    // rewrites separators, which produced `D:WorkProjects...` truncation.
    expect(gateSrc).toMatch(/path\.resolve/);
  });

  test('helper sets $ErrorActionPreference so failures cannot pass silently', () => {
    const src = fs.readFileSync(HELPER, 'utf8');
    expect(src).toMatch(/\$ErrorActionPreference\s*=\s*'Stop'/);
  });

  test('helper exits non-zero when it cannot identify its input', () => {
    expect(() => runHelper('')).toThrow();
    expect(() => runHelper(path.join(os.tmpdir(), 'definitely-missing-xyz.exe'))).toThrow();
  });

  test('reads a real signature status for an existing file', () => {
    // Any file will do; the point is that a status is actually returned rather
    // than an exception or an empty result.
    const target = path.join(ROOT, 'package.json');
    const r = runHelper(target);
    expect(r.status).toBeTruthy();
    expect(['Valid', 'NotSigned', 'HashMismatch', 'UnknownError']).toContain(r.status);
    expect(['yes', 'no']).toContain(r.ts);
  });

  test('gate 10 checks the installer AND the shipped application exe', () => {
    expect(gateSrc).toMatch(/win-unpacked/);
    expect(gateSrc).toMatch(/BlackStack CRM\.exe/);
  });

  test('gate 10 can pin the expected signer identity', () => {
    // Without this, a certificate issued to any company would satisfy the gate.
    expect(gateSrc).toMatch(/RELEASE_EXPECTED_SUBJECT/);
    expect(gateSrc).toMatch(/is not\s+"/);
  });

  test('gate 10 requires a timestamp so signatures outlive the certificate', () => {
    expect(gateSrc).toMatch(/NOT timestamped/);
  });

  test('a skip is never recorded as a pass', () => {
    expect(gateSrc).toMatch(/ok === 'skip'/);
    // And the summary must not fold skips into the passed count.
    expect(gateSrc).toMatch(/results\.length - skipped\.length/);
  });
});
