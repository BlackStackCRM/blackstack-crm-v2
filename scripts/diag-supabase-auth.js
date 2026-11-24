/**
 * END-TO-END LOGIN PROBE — what the second PC experiences.
 * Uses only a NON-EXISTENT test identity. Prints status codes and durations,
 * never tokens/keys/passwords. Verifies every stage of the Supabase-only login:
 *   1. runtime env resolves SUPABASE_URL/ANON_KEY (presence only)
 *   2. DNS + TLS reach the auth host
 *   3. /auth/v1/health responds
 *   4. signInWithPassword settles with a definitive status
 *   5. JWKS endpoint reachable (used by BLACKSTACK_REQUIRE_CLOUD_TOKEN=1)
 */
const path = require('path');
const { loadRuntimeEnvironment } = require(path.join(__dirname, '..', 'server', 'config', 'runtimeEnvironment'));

const result = { stages: [] };
const stage = (name, ok, detail) => {
  result.stages.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

(async () => {
  loadRuntimeEnvironment({ envPath: process.env.APPDATA + '\\blackstack-crm-v2\\data\\.env' });

  // 1. config present?
  // NOTE: the project uses a modern Supabase publishable key ("sb_...", one
  // segment), NOT a legacy JWT-shaped anon key — so a JWT-shape assertion here
  // would false-fail. Presence + non-empty is the only safe local check.
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || '';
  stage('runtime-supabase-config', !!url && key.length > 0 && key.startsWith('sb_'),
    url ? `url=${url}, key=present(${key.length} chars, publishable 'sb_' format)` : 'SUPABASE_URL missing');

  // 2. DNS
  let dnsMs;
  try {
    const dns = require('dns').promises;
    const t0 = Date.now();
    await dns.lookup(new URL(url).hostname);
    dnsMs = Date.now() - t0;
    stage('dns-resolution', true, `${dnsMs} ms`);
  } catch (e) { stage('dns-resolution', false, e.code || e.message); }

  // 3. auth health
  try {
    const t0 = Date.now();
    const r = await fetch(url + '/auth/v1/health', { headers: { apikey: key } });
    stage('auth-health', r.ok, `HTTP ${r.status} in ${Date.now() - t0} ms`);
  } catch (e) { stage('auth-health', false, e.message + (e.cause ? ' / ' + (e.cause.code || e.cause.message) : '')); }

  // 4. signInWithPassword with a deliberately wrong account
  const { isConfigured, getSupabaseClient } = require(path.join(__dirname, '..', 'server', 'config', 'supabase'));
  if (!isConfigured()) {
    stage('signinwithpassword', false, 'not configured');
  } else {
    const sb = getSupabaseClient();
    const t0 = Date.now();
    try {
      const { error } = await sb.auth.signInWithPassword({ email: 'probe-nonexistent@example.invalid', password: 'definitely-wrong' });
      const ms = Date.now() - t0;
      if (error) {
        // A definitive 400 invalid-credentials response proves the full
        // network + auth pipeline works (Supabase rejected the fake user).
        stage('signinwithpassword', error.status === 400, `HTTP ${error.status} (${error.code || 'n/a'}) in ${ms} ms`);
      } else {
        stage('signinwithpassword', false, 'unexpected success for fake account');
      }
    } catch (e) {
      stage('signinwithpassword', false, `threw in ${Date.now() - t0} ms: ${e.message}`);
    }
  }

  // 5. JWKS (only needed when BLACKSTACK_REQUIRE_CLOUD_TOKEN=1)
  try {
    const t0 = Date.now();
    const r = await fetch(url + '/auth/v1/.well-known/jwks.json');
    stage('jwks-endpoint', r.ok, `HTTP ${r.status} in ${Date.now() - t0} ms`);
  } catch (e) { stage('jwks-endpoint', false, e.message); }

  const failed = result.stages.filter((s) => !s.ok);
  console.log(failed.length === 0 ? '\nALL STAGES PASS — auth path fully reachable' : `\n${failed.length} stage(s) FAILED`);
  process.exit(failed.length === 0 ? 0 : 1);
})();
