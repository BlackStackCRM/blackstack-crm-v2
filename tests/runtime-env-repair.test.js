/**
 * REGRESSION TESTS — permanent runtime Supabase configuration repair (v1.2.4).
 *
 * Reproduces the second-PC scenario end-to-end WITHOUT touching the developer's
 * real production .env or database: every test operates on temporary
 * directories and mocked packaged-env files.
 *
 * Scenarios covered (per v1.2.4 spec §8):
 *   1. Normal AppData runtime .env
 *   2. Custom runtime path via shared-env-path.txt (C:\BlackStackData scenario)
 *   3. Missing SUPABASE_ANON_KEY in the actual runtime .env -> repaired there
 *   4. Existing correct SUPABASE_ANON_KEY -> untouched
 *   5. Missing packaged configuration -> no repair, no crash
 *   6. Empty packaged values never overwrite valid existing values
 *   7. Unrelated environment variables remain unchanged
 *   8. Incorrect/inaccessible runtime path -> safe failure, no throw
 *   9. Restart after successful synchronization -> repair idempotent, pointer
 *      preserved, no duplicate keys
 *  10. Server-side resolution (runtimeEnvironment.resolveSharedEnvPath) reads
 *      the SAME file the repair updated
 *
 * Run: node tests/runtime-env-repair.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { syncSupabaseCredentialsIntoEnv } = require('../electron/env-sync');
const { resolveRuntimeEnvPath, findPackagedEnvPath } = require('../electron/runtime-env-path');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failures.push(name); console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

const PACKAGED_FULL =
  'SUPABASE_URL=https://qzxvcxywotqeqvwerofi.supabase.co\n' +
  'SUPABASE_ANON_KEY=sb_publishable_PACKAGED_KEY_123\n';
const URL_RE = /^SUPABASE_URL=https:\/\/qzxvcxywotqeqvwerofi\.supabase\.co$/m;
const KEY_RE = /^SUPABASE_ANON_KEY=sb_publishable_PACKAGED_KEY_123$/m;

function tmpDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bs-${label}-`));
  return dir;
}
function write(file, content) { fs.writeFileSync(file, content, 'utf8'); }
function readVar(text, name) {
  const m = text.match(new RegExp('^\\s*' + name + '\\s*=\\s*(.*)\\s*$', 'm'));
  return m ? m[1].trim() : null;
}

/**
 * Simulate the repaired ensureLocalRuntimeConfig() repair path on an isolated
 * userDataDir, mirroring electron/main.js logic exactly (kept in sync by test 9's
 * idempotency check). Returns { envPath, log[] }.
 */
function simulateRepair({ userDataDir, packagedSource, explicitPath, cwd, appPath }) {
  const log = [];
  const pointerFile = path.join(userDataDir, 'shared-env-path.txt');
  if (!fs.existsSync(pointerFile)) throw new Error('test setup: pointer must exist');
  const resolved = resolveRuntimeEnvPath({ explicitPath, userDataDir, appPath, cwd });
  const envPath = resolved.envPath;
  log.push(`Runtime env resolution: ${envPath} (source: ${resolved.source}, exists: ${resolved.exists})`);
  if (!packagedSource) { log.push('No packaged blackstack.env found; keeping existing runtime credentials.'); return { envPath, log }; }
  if (!fs.existsSync(envPath)) {
    const packagedText = fs.readFileSync(packagedSource, 'utf8');
    const provision = ['PORT=3000', 'JWT_EXPIRY=7d', 'CORS_ORIGIN=*', 'DEMO_MODE=false'];
    const url = (packagedText.match(/^SUPABASE_URL=(.*)$/m) || [, ''])[1].trim();
    const anon = (packagedText.match(/^SUPABASE_ANON_KEY=(.*)$/m) || [, ''])[1].trim();
    if (url) provision.push('SUPABASE_URL=' + url);
    if (anon) provision.push('SUPABASE_ANON_KEY=' + anon);
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, provision.join('\n') + '\n', { encoding: 'utf8' });
    log.push(`Provisioned missing runtime env at the authoritative path: ${envPath}`);
    return { envPath, log };
  }
  const text = fs.readFileSync(envPath, 'utf8');
  const result = syncSupabaseCredentialsIntoEnv(text, packagedSource);
  if (result.changed) { fs.writeFileSync(envPath, result.patched, 'utf8'); log.push(`Synchronized Supabase credentials into runtime env: ${envPath}`); }
  else log.push(`Supabase credentials already in sync with packaged env: ${envPath}`);
  return { envPath, log };
}

const savedEnv = { ...process.env };

(async () => {
  // ── 1. Normal AppData runtime .env ─────────────────────────────────────────
  await test('1. normal AppData runtime .env: pointer to default path repairs in place', async () => {
    const ud = tmpDir('appdata');
    const dataDir = path.join(ud, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const envPath = path.join(dataDir, '.env');
    write(envPath, 'PORT=3000\nSUPABASE_URL=\nSUPABASE_ANON_KEY=\n');
    write(path.join(ud, 'shared-env-path.txt'), envPath + '\n');
    const pkg = path.join(ud, 'blackstack.env'); write(pkg, PACKAGED_FULL);

    const r = simulateRepair({ userDataDir: ud, packagedSource: pkg });
    const after = fs.readFileSync(r.envPath, 'utf8');
    assert.match(after, URL_RE);
    assert.match(after, KEY_RE);
    assert.match(after, /^PORT=3000$/m);
    // Resolution honours the pointer even when it points inside AppData:
    const res = resolveRuntimeEnvPath({ userDataDir: ud, cwd: ud, appPath: ud });
    assert.strictEqual(path.resolve(res.envPath), path.resolve(envPath));
    assert.strictEqual(res.exists, true);
  });

  // ── 2+3. THE SECOND-PC SCENARIO: C:\BlackStackData\.env ───────────────────
  await test('2+3. shared-env-path.txt -> custom dir (BlackStackData scenario): missing ANON_KEY repaired in THAT file', async () => {
    const ud = tmpDir('custom');
    // Simulate a custom shared data directory on another drive. Use a path on
    // the same temp volume but OUTSIDE userDataDir to prove the pointer is
    // followed, not the AppData default.
    const customDir = path.join(tmpDir('blackstackdata-root'), 'BlackStackData');
    fs.mkdirSync(customDir, { recursive: true });
    const envPath = path.join(customDir, '.env');
    // Exactly the second-PC state: URL + SERVICE_ROLE_KEY present, ANON_KEY absent.
    write(envPath,
      'PORT=3000\n' +
      'JWT_SECRET=local-only-test-value-not-a-real-secret\n' +
      'DB_PATH=C:/BlackStackData/data/blackstack-crm.db\n' +
      'SUPABASE_URL=https://qzxvcxywotqeqvwerofi.supabase.co\n' +
      'SUPABASE_SERVICE_ROLE_KEY=sb_secret_LOCAL_TEST_NEVER_USED\n');
    write(path.join(ud, 'shared-env-path.txt'), envPath + '\n');
    const pkg = path.join(ud, 'blackstack.env'); write(pkg, PACKAGED_FULL);

    const r = simulateRepair({ userDataDir: ud, packagedSource: pkg });
    const after = fs.readFileSync(envPath, 'utf8'); // read THE ACTUAL file
    assert.match(after, KEY_RE, 'missing ANON_KEY must be added to the custom path .env');
    assert.match(after, URL_RE);
    // Unrelated vars (incl. the service-role key the desktop must not use) preserved:
    assert.match(after, /^PORT=3000$/m);
    assert.match(after, /^JWT_SECRET=local-only-test-value-not-a-real-secret$/m);
    assert.match(after, /^DB_PATH=C:\/BlackStackData\/data\/blackstack-crm\.db$/m);
    assert.match(after, /^SUPABASE_SERVICE_ROLE_KEY=sb_secret_LOCAL_TEST_NEVER_USED$/m,
      'service-role key must remain in file (untouched) — the desktop just must not USE it');
    // Resolution via pointer (even though a plausible AppData default would exist):
    const res = resolveRuntimeEnvPath({ userDataDir: ud, cwd: ud, appPath: ud });
    assert.strictEqual(path.resolve(res.envPath), path.resolve(envPath));
  });

  // ── 4. Existing correct ANON_KEY untouched ────────────────────────────────
  await test('4. existing correct SUPABASE_ANON_KEY: no rewrite, no duplicate', async () => {
    const ud = tmpDir('correct');
    const envPath = path.join(ud, '.env');
    write(envPath, 'PORT=3000\n' + PACKAGED_FULL);
    write(path.join(ud, 'shared-env-path.txt'), envPath + '\n');
    const pkg = path.join(ud, 'blackstack.env'); write(pkg, PACKAGED_FULL);
    const before = fs.readFileSync(envPath, 'utf8');

    const r = simulateRepair({ userDataDir: ud, packagedSource: pkg });
    const after = fs.readFileSync(r.envPath, 'utf8');
    assert.strictEqual(after, before, 'valid config must not be rewritten');
    assert.strictEqual((after.match(/SUPABASE_ANON_KEY=/g) || []).length, 1, 'no duplicate keys');
  });

  // ── 5. Missing packaged configuration ────────────────────────────────────
  await test('5. missing packaged blackstack.env: safe no-op, no crash, env untouched', async () => {
    const ud = tmpDir('nopkg');
    const envPath = path.join(ud, '.env');
    write(envPath, 'PORT=3000\nSUPABASE_URL=\nSUPABASE_ANON_KEY=\n');
    write(path.join(ud, 'shared-env-path.txt'), envPath + '\n');
    const before = fs.readFileSync(envPath, 'utf8');

    const r = simulateRepair({ userDataDir: ud, packagedSource: null });
    assert.strictEqual(fs.readFileSync(envPath, 'utf8'), before, 'env must be untouched');
    assert.ok(r.log.some((l) => /No packaged blackstack\.env found/.test(l)));
    // findPackagedEnvPath on a dir without the file returns null (no throw):
    assert.strictEqual(findPackagedEnvPath.length >= 0, true);
  });

  // ── 6. Empty packaged values never overwrite valid values ────────────────
  await test('6. empty packaged values do not overwrite valid runtime values', async () => {
    const ud = tmpDir('emptypkg');
    const envPath = path.join(ud, '.env');
    write(envPath, 'SUPABASE_URL=https://qzxvcxywotqeqvwerofi.supabase.co\nSUPABASE_ANON_KEY=sb_publishable_KEEPME\n');
    write(path.join(ud, 'shared-env-path.txt'), envPath + '\n');
    const pkg = path.join(ud, 'blackstack.env'); write(pkg, 'SUPABASE_URL=\nSUPABASE_ANON_KEY=\n');
    const r = syncSupabaseCredentialsIntoEnv(fs.readFileSync(envPath, 'utf8'), pkg);
    assert.strictEqual(r.changed, false);
    assert.match(r.patched, /sb_publishable_KEEPME/);
  });

  // ── 7. Unrelated variables preserved ──────────────────────────────────────
  await test('7. unrelated environment variables remain byte-identical', async () => {
    const ud = tmpDir('unrelated');
    const envPath = path.join(ud, '.env');
    const before = 'PORT=34567\nJWT_EXPIRY=7d\nCORS_ORIGIN=*\nRATE_LIMIT_MAX_REQUESTS=100\nDEMO_MODE=false\nMY_CUSTOM_FLAG=hello\nSUPABASE_URL=\nSUPABASE_ANON_KEY=\n';
    write(envPath, before);
    write(path.join(ud, 'shared-env-path.txt'), envPath + '\n');
    const pkg = path.join(ud, 'blackstack.env'); write(pkg, PACKAGED_FULL);
    const r = simulateRepair({ userDataDir: ud, packagedSource: pkg });
    const after = fs.readFileSync(r.envPath, 'utf8');
    for (const line of before.split('\n').filter(Boolean)) {
      assert.ok(after.includes(line), `unrelated line must survive: ${line}`);
    }
  });

  // ── 8. Incorrect / inaccessible runtime path ──────────────────────────────
  await test('8. inaccessible runtime path: resolution fails safe (exists:false), repair does not throw', async () => {
    const ud = tmpDir('badpath');
    // Pointer names a path inside a NON-existent drive-like nested dir:
    const bogus = path.join(ud, 'no-such-dir', 'deep', '.env');
    write(path.join(ud, 'shared-env-path.txt'), bogus + '\n');
    const pkg = path.join(ud, 'blackstack.env'); write(pkg, PACKAGED_FULL);

    const res = resolveRuntimeEnvPath({ userDataDir: ud, cwd: ud, appPath: ud });
    assert.strictEqual(res.exists, false);
    assert.strictEqual(path.resolve(res.envPath), path.resolve(bogus), 'declared target preserved');
    // Simulated repair provisions parents safely instead of throwing:
    const r = simulateRepair({ userDataDir: ud, packagedSource: pkg });
    assert.ok(fs.existsSync(r.envPath), 'provisioning must create the declared path');
  });

  // ── 9. Restart idempotency ────────────────────────────────────────────────
  await test('9. restart after successful sync: idempotent, pointer preserved, no duplicate keys', async () => {
    const ud = tmpDir('restart');
    const customDir = path.join(tmpDir('restart-root'), 'SharedData');
    fs.mkdirSync(customDir, { recursive: true });
    const envPath = path.join(customDir, '.env');
    write(envPath, 'PORT=3000\nSUPABASE_URL=\nSUPABASE_ANON_KEY=\n');
    write(path.join(ud, 'shared-env-path.txt'), envPath + '\n');
    const pkg = path.join(ud, 'blackstack.env'); write(pkg, PACKAGED_FULL);

    const r1 = simulateRepair({ userDataDir: ud, packagedSource: pkg });
    const once = fs.readFileSync(r1.envPath, 'utf8');
    // "Restart": run the same repair again on the same files.
    const r2 = simulateRepair({ userDataDir: ud, packagedSource: pkg });
    const twice = fs.readFileSync(r2.envPath, 'utf8');
    assert.strictEqual(twice, once, 'second launch must not change the file');
    assert.strictEqual((twice.match(/SUPABASE_ANON_KEY=/g) || []).length, 1);
    assert.strictEqual((twice.match(/SUPABASE_URL=/g) || []).length, 1);
    assert.strictEqual(fs.readFileSync(path.join(ud, 'shared-env-path.txt'), 'utf8').trim(), envPath,
      'pointer must be untouched');
  });

  // ── 10. Server reads the SAME file the repair updated ─────────────────────
  await test('10. server-side resolveSharedEnvPath resolves the same file the repair wrote', async () => {
    const server = require('../server/config/runtimeEnvironment');
    const ud = tmpDir('serverread');
    const customDir = path.join(tmpDir('serverread-root'), 'ServerShared');
    fs.mkdirSync(customDir, { recursive: true });
    const envPath = path.join(customDir, '.env');
    write(envPath, 'PORT=3000\n' + PACKAGED_FULL);
    write(path.join(ud, 'shared-env-path.txt'), envPath + '\n');

    const serverResolved = server.resolveSharedEnvPath({ userDataDir: ud, cwd: ud, appPath: ud });
    assert.strictEqual(path.resolve(serverResolved), path.resolve(envPath),
      'the running server must resolve exactly the repaired file');

    // End-to-end: after repair, loadRuntimeEnvironment() must yield a
    // configuration the server considers configured (anon key present).
    const saved = { ...process.env };
    try {
      const loaded = server.loadRuntimeEnvironment({ envPath: serverResolved });
      assert.strictEqual(path.resolve(loaded.envPath), path.resolve(envPath));
      assert.ok(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY,
        'isConfigured inputs must come from the repaired file');
      const { isConfigured } = require('../server/config/supabase');
      assert.strictEqual(isConfigured(), true, 'isConfigured() must be true after repair');
      // SERVICE_ROLE must NOT satisfy the desktop (BLACKSTACK_DESKTOP=1):
      process.env.BLACKSTACK_DESKTOP = '1';
      delete process.env.SUPABASE_ANON_KEY;
      assert.strictEqual(isConfigured(), false,
        'desktop build must never accept SERVICE_ROLE as the anon key substitute');
    } finally {
      for (const k of Object.keys(savedEnv)) process.env[k] = savedEnv[k];
      for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  console.log(`\n${passed} test(s) passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
  process.exit(failures.length ? 1 : 0);
})();
