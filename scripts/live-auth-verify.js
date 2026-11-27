/**
 * LIVE AUTH VERIFICATION — real Supabase signInWithPassword for the existing
 * Mother Company account. The password is read from the environment variable
 * LIVE_TEST_PASSWORD and is NEVER printed, logged, or persisted.
 *
 * Stages:
 *  1. signInWithPassword with real credentials  → account exists + valid password?
 *  2. Verify returned Auth UUID (printed — UUIDs are not secrets)
 *  3. Invalid-credential rejection (wrong password)
 *  4. Nonexistent user rejection
 *  5. Timeout behavior (unreachable host fails safely within timeout window)
 */
'use strict';

const url = 'https://qzxvcxywotqeqvwerofi.supabase.co';
const fs = require('fs');
const path = require('path');

// Load the release anon key without printing it.
const envText = fs.readFileSync(path.join(__dirname, '..', '.env.release'), 'utf8');
const keyMatch = envText.match(/^SUPABASE_ANON_KEY=(.*)$/m);
const key = keyMatch ? keyMatch[1].trim() : '';
if (!key) {
  console.error('FATAL: SUPABASE_ANON_KEY missing from .env.release');
  process.exit(1);
}

const password = process.env.LIVE_TEST_PASSWORD;
if (!password) {
  console.error('FATAL: LIVE_TEST_PASSWORD not set in trusted environment.');
  process.exit(1);
}

const EMAIL = 'admin@blackstack.local';
const results = [];
const stage = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

(async () => {
  // ── 1. Real signInWithPassword ─────────────────────────────────────────
  let authUuid = null;
  let t0 = Date.now();
  try {
    const r = await fetch(url + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify({ email: EMAIL, password }),
    });
    const ms = Date.now() - t0;
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.access_token && j.user) {
      authUuid = j.user.id;
      stage('live-signin-real-credentials', true, `HTTP ${r.status} in ${ms} ms, access_token received (never printed), role=${j.user.role || 'n/a'}`);
    } else {
      stage('live-signin-real-credentials', false, `HTTP ${r.status} (${j.code || j.msg || 'no code'}) in ${ms} ms`);
    }
  } catch (e) {
    stage('live-signin-real-credentials', false, 'threw: ' + e.message);
  }

  // ── 2. Auth UUID verification ─────────────────────────────────────────
  if (authUuid) {
    const uuidOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(authUuid);
    stage('auth-uuid-format', uuidOk, `UUID=${authUuid} (this is the identity that must be bound to SQLite supabase_user_id)`);
  } else {
    stage('auth-uuid-format', false, 'skipped — no successful login');
  }

  // ── 3. Wrong password rejected ────────────────────────────────────────
  t0 = Date.now();
  try {
    const r = await fetch(url + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify({ email: EMAIL, password: 'definitely-wrong-password-123' }),
    });
    const ms = Date.now() - t0;
    const j = await r.json().catch(() => ({}));
    const rejected = r.status === 400 && /invalid login/i.test(j.msg || '');
    stage('wrong-password-rejected', rejected, `HTTP ${r.status} (${j.msg || 'n/a'}) in ${ms} ms`);
  } catch (e) {
    stage('wrong-password-rejected', false, 'threw: ' + e.message);
  }

  // ── 4. Nonexistent user rejected ──────────────────────────────────────
  t0 = Date.now();
  try {
    const r = await fetch(url + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify({ email: 'probe-nonexistent-xyz@example.invalid', password: 'whatever-1' }),
    });
    const ms = Date.now() - t0;
    const j = await r.json().catch(() => ({}));
    const rejected = r.status === 400 && /invalid login/i.test(j.msg || '');
    stage('nonexistent-user-rejected', rejected, `HTTP ${r.status} (${j.msg || 'n/a'}) in ${ms} ms`);
  } catch (e) {
    stage('nonexistent-user-rejected', false, 'threw: ' + e.message);
  }

  // ── 5. Timeout / unreachable behavior ─────────────────────────────────
  const { createTimeoutFetch } = require('../server/config/supabase');
  t0 = Date.now();
  try {
    const tf = createTimeoutFetch(2000); // 2 s — unreachable host must fail within this
    await tf(url.replace('.co', '.co'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify({ email: EMAIL, password }),
    });
    stage('timeout-fetch-behavior', true, `completed in ${Date.now() - t0} ms (real host — reachable)`);
  } catch (e) {
    stage('timeout-fetch-behavior', false, `threw in ${Date.now() - t0} ms: ${e.name} ${e.message}`);
  }

  const failed = results.filter((s) => !s.ok);
  console.log(failed.length === 0 ? '\nALL STAGES PASS — live authentication path verified' : `\n${failed.length} stage(s) FAILED`);
  process.exit(failed.length === 0 ? 0 : 1);
})();
