/**
 * E-10 REGRESSION — the production signing gate must actually be armed.
 *
 * THE DEFECT THIS LOCKS DOWN
 *   electron/signing-config.js correctly throws when REQUIRE_SIGNING=1 and
 *   credentials are missing. But nothing set that flag. The npm script read
 *
 *     node electron/signing-config.js && electron-builder --win nsis
 *
 *   so on a clean machine the gate saw an unset flag, printed "UNSIGNED
 *   development installer" and exited 0. Combined with an absent
 *   win.forceCodeSigning, electron-builder packaged happily and reported
 *   BUILD_EXIT=0. The script named `electron:build:prod` produced an unsigned
 *   artifact and still exited 0 — the guard existed but never fired.
 *
 * These assertions run the real entry points as child processes, because the
 * bug was entirely about runtime environment, not source text.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

const run = (script, env) => spawnSync(process.execPath, [path.join(ROOT, script)], {
  encoding: 'utf8',
  cwd: ROOT,
  timeout: 60000,
  env: { ...process.env, CSC_LINK: '', CSC_KEY_PASSWORD: '', ...env },
});
const combined = (r) => `${r.stdout || ''}${r.stderr || ''}`;

describe('E-10: production signing gate', () => {
  test('electron:build:prod routes through the arming wrapper', () => {
    expect(pkg.scripts['electron:build:prod']).toContain('scripts/require-signing.js');
    // The wrapper must run BEFORE electron-builder, or it gates nothing.
    expect(pkg.scripts['electron:build:prod']).toMatch(/require-signing\.js\s*&&\s*electron-builder/);
  });

  test('require-signing.js BLOCKS when credentials are missing', () => {
    const r = run('scripts/require-signing.js');
    expect(r.status).toBe(1);
    expect(combined(r)).toMatch(/FATAL/i);
    // It must never claim success while unsigned.
    expect(combined(r)).not.toMatch(/ARMED/i);
  });

  test('the failure message names the actual missing variables', () => {
    const r = run('scripts/require-signing.js');
    const out = combined(r);
    expect(out).toMatch(/CSC_LINK/);
    expect(out).toMatch(/CSC_KEY_PASSWORD/);
  });

  test('forceCodeSigning is armed for RELEASE builds only, not globally', () => {
    // Regression guard. Setting build.win.forceCodeSigning = true in shared
    // config looked like hardening but silently broke the documented unsigned
    // developer workflow: it lives in build.win, which every build inherits, so
    // `electron:build:win` started failing with
    //   App is not signed and "forceCodeSigning" is set to true
    // That is why the flag must be passed per-invocation by the release script.
    expect(pkg.build.win && pkg.build.win.forceCodeSigning).toBeUndefined();
    expect(pkg.scripts['electron:build:prod']).toMatch(/forceCodeSigning\s*=\s*true/);
    expect(pkg.scripts['electron:build:win']).not.toMatch(/forceCodeSigning/);
  });

  test('the unsigned development build is still buildable', () => {
    // The dev script must not require credentials or carry a signing flag.
    expect(pkg.scripts['electron:build:win']).not.toMatch(/require-signing/);
    expect(pkg.scripts['electron:build:win']).not.toMatch(/CSC_/);
  });

  test('the unsigned DEVELOPMENT path is still permitted', () => {
    // Local/dev builds must keep working unsigned — only releases are gated.
    const r = run('electron/signing-config.js');
    expect(r.status).toBe(0);
    expect(combined(r)).toMatch(/UNSIGNED development installer/i);
  });

  test('the original signing-config.js was not weakened', () => {
    const src = require('node:fs').readFileSync(path.join(ROOT, 'electron', 'signing-config.js'), 'utf8');
    // The fail-closed throw must still exist verbatim.
    expect(src).toMatch(/REQUIRE_SIGNING=1 but signing credentials are missing/);
    expect(src).toMatch(/requireSigning && !hasCredentials/);
  });

  test('no secret is ever printed by the gate', () => {
    const secret = 'SUPERSECRET-do-not-log-1234';
    const r = run('scripts/require-signing.js', { CSC_LINK: '/nonexistent.pfx', CSC_KEY_PASSWORD: secret });
    const out = combined(r);
    expect(out).not.toContain(secret);
  });
});
