/**
 * REGRESSION TESTS — Supabase auth failure diagnosis (second-PC incident).
 *
 * Covers:
 *   1. env-sync: empty runtime keys get restored from packaged env.
 *   2. env-sync: valid runtime keys are preserved / matched (idempotent).
 *   3. env-sync: never writes an empty packaged value over a valid runtime one.
 *   4. auth.service: UNCONFIGURED Supabase yields the "missing configuration"
 *      message (NOT the misleading "unreachable" network message) and throws
 *      before any network request.
 *   5. auth.service: configured-but-unreachable keeps the network message.
 *
 * Run: node tests/auth-failure-diagnosis.test.js
 * No real credentials, no network calls in tests 1-4 (supabase client is
 * stubbed), no secrets printed.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { syncSupabaseCredentialsIntoEnv } = require('../electron/env-sync');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failures.push(name); console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

const PACKAGED = 'SUPABASE_URL=https://qzxvcxywotqeqvwerofi.supabase.co\nSUPABASE_ANON_KEY=sb_publishable_TESTKEY_123\n';

(async () => {
await test('env-sync restores EMPTY runtime keys from packaged env', () => {
  const runtime = 'NODE_ENV=production\nPORT=3000\nSUPABASE_URL=\nSUPABASE_ANON_KEY=\n';
  const r = syncSupabaseCredentialsIntoEnv(runtime, null);
  assert.strictEqual(r.changed, false, 'no packaged source -> no change');

  const tmp = path.join(os.tmpdir(), `bs-test-packaged-${Date.now()}.env`);
  fs.writeFileSync(tmp, PACKAGED);
  try {
    const r2 = syncSupabaseCredentialsIntoEnv(runtime, tmp);
    assert.strictEqual(r2.changed, true);
    assert.match(r2.patched, /^SUPABASE_URL=https:\/\/qzxvcxywotqeqvwerofi\.supabase\.co$/m);
    assert.match(r2.patched, /^SUPABASE_ANON_KEY=sb_publishable_TESTKEY_123$/m);
    assert.match(r2.patched, /^PORT=3000$/m, 'unrelated vars preserved');
  } finally { fs.unlinkSync(tmp); }
});

await test('env-sync is idempotent when runtime already matches packaged', () => {
  const tmp = path.join(os.tmpdir(), `bs-test-packaged-${Date.now()}.env`);
  fs.writeFileSync(tmp, PACKAGED);
  try {
    const r = syncSupabaseCredentialsIntoEnv(PACKAGED, tmp);
    assert.strictEqual(r.changed, false);
  } finally { fs.unlinkSync(tmp); }
});

await test('env-sync never replaces a valid runtime value with an empty packaged value', () => {
  const tmp = path.join(os.tmpdir(), `bs-test-packaged-${Date.now()}.env`);
  fs.writeFileSync(tmp, 'SUPABASE_URL=\nSUPABASE_ANON_KEY=\n');
  try {
    const runtime = 'SUPABASE_URL=https://qzxvcxywotqeqvwerofi.supabase.co\nSUPABASE_ANON_KEY=sb_publishable_KEEPME\n';
    const r = syncSupabaseCredentialsIntoEnv(runtime, tmp);
    assert.strictEqual(r.changed, false, 'empty packaged values must not overwrite');
    assert.match(r.patched, /sb_publishable_KEEPME/);
  } finally { fs.unlinkSync(tmp); }
});

await test('auth.service: missing Supabase config -> "missing configuration" message, no network call', async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_ANON_KEY;
  const savedEnvPath = process.env.BLACKSTACK_ENV_PATH;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.BLACKSTACK_ENV_PATH;
  try {
    const { AuthService } = require('../server/services/auth.service');
    const svc = new AuthService({ get: () => null });
    await assert.rejects(
      svc.login('probe@example.invalid', 'wrongpass'),
      (e) => {
        assert.ok(/missing its Supabase configuration/i.test(e.message),
          `expected config message, got: ${e.message}`);
        assert.ok(!/unreachable/i.test(e.message), 'must NOT claim a network failure');
        return true;
      },
    );
  } finally {
    if (savedUrl) process.env.SUPABASE_URL = savedUrl;
    if (savedKey) process.env.SUPABASE_ANON_KEY = savedKey;
    if (savedEnvPath) process.env.BLACKSTACK_ENV_PATH = savedEnvPath;
  }
});

await test('auth.service: configured but unreachable keeps the network message', async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_ANON_KEY;
  const savedEnvPath = process.env.BLACKSTACK_ENV_PATH;
  delete process.env.BLACKSTACK_ENV_PATH;
  process.env.SUPABASE_URL = 'https://qzxvcxywotqeqvwerofi.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'sb_publishable_TESTKEY_123';
  try {
    const { AuthService } = require('../server/services/auth.service');
    const svc = new AuthService({ get: () => null });
    // Stub _verifyAgainstSupabase to return 'unavailable' without network.
    svc._verifyAgainstSupabase = async () => 'unavailable';
    await assert.rejects(
      svc.login('probe@example.invalid', 'wrongpass'),
      (e) => {
        assert.ok(/authentication service is unreachable/i.test(e.message),
          `expected network message, got: ${e.message}`);
        return true;
      },
    );
  } finally {
    if (savedUrl) process.env.SUPABASE_URL = savedUrl; else delete process.env.SUPABASE_URL;
    if (savedKey) process.env.SUPABASE_ANON_KEY = savedKey; else delete process.env.SUPABASE_ANON_KEY;
    if (savedEnvPath) process.env.BLACKSTACK_ENV_PATH = savedEnvPath;
  }
});

console.log(`\n${passed} test(s) passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
process.exit(failures.length ? 1 : 0);
})();
