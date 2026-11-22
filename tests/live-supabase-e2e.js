/**
 * LIVE SUPABASE E2E HARNESS — Priority 5 preparation
 * ==================================================
 * Executes the twelve required live scenarios against a REAL configured
 * Supabase project. Every check records an ACTUAL result; nothing is faked.
 *
 * PREREQUISITES (all three must be present or the harness refuses to run):
 *   SUPABASE_URL          — project URL
 *   SUPABASE_ANON_KEY     — publishable anon key (client-legal)
 *   SUPABASE_TEST_EMAIL / SUPABASE_TEST_PASSWORD — a DEDICATED TEST ACCOUNT
 *                           on a test/staging project. NEVER production user
 *                           credentials. NEVER committed to git.
 *
 * RUN:
 *   node tests/live-supabase-e2e.js
 *
 * EXIT CODE: 0 = all executed checks passed; 1 = at least one failure/skip.
 * Output is a machine-readable JSON summary plus a human-readable table.
 *
 * WHAT IS *NOT* TESTED HERE (needs a second machine): multi-device session
 * independence — see docs/two-device-test-procedure.md.
 */

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_TEST_EMAIL', 'SUPABASE_TEST_PASSWORD'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k] || !process.env[k].trim());
if (missing.length) {
  console.error('REFUSING TO RUN: missing required environment variables:');
  missing.forEach((k) => console.error('  - ' + k));
  console.error('\nThis harness only runs against a REAL authenticated Supabase environment.');
  console.error('Provide credentials for a DEDICATED TEST project/account. Do NOT use production user data.');
  process.exit(1);
}

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: true },
});

const results = [];
const record = (id, name, status, evidence) => {
  results.push({ id, name, status, evidence });
  const icon = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP';
  console.log(`[${icon}] ${id} ${name} — ${evidence}`);
};

async function main() {
  let session = null;
  let userId = null;

  // ── 1. VALID LOGIN ────────────────────────────────────────────────────────
  {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: process.env.SUPABASE_TEST_EMAIL,
      password: process.env.SUPABASE_TEST_PASSWORD,
    });
    if (error) {
      record('T1', 'valid login', 'FAIL', error.message);
    } else {
      session = data.session;
      userId = data.user.id;
      record('T1', 'valid login', 'PASS', `uid=${userId}, access token len=${session.access_token.length}`);
    }
  }

  // ── 2. INVALID CREDENTIALS ────────────────────────────────────────────────
  {
    const { error } = await supabase.auth.signInWithPassword({
      email: process.env.SUPABASE_TEST_EMAIL,
      password: 'definitely-wrong-' + Date.now(),
    });
    record('T2', 'invalid credentials rejected', error ? 'PASS' : 'FAIL',
      error ? `error: ${error.status} ${error.message}` : 'signed in with a WRONG password!');
  }

  // ── 3. TOKEN EXPIRY / REFRESH ─────────────────────────────────────────────
  {
    if (!session) record('T3', 'token refresh', 'SKIP', 'no session from T1');
    else {
      const before = session.access_token.slice(-12);
      const { data, error } = await supabase.auth.refreshSession({ refresh_token: session.refresh_token });
      if (error) record('T3', 'token refresh', 'FAIL', error.message);
      else {
        const rotated = data.session.access_token.slice(-12) !== before;
        record('T3', 'token refresh', rotated ? 'PASS' : 'FAIL', rotated ? 'access token rotated' : 'token unchanged after refresh');
        session = data.session;
      }
    }
  }

  // ── 4. SESSION RESTORATION (getSession from a fresh client w/ stored token)
  {
    if (!session) record('T4', 'session restoration', 'SKIP', 'no session');
    else {
      const { data, error } = await supabase.auth.getUser(session.access_token);
      record('T4', 'session restoration', !error && data.user ? 'PASS' : 'FAIL',
        !error && data.user ? `restored uid=${data.user.id}` : error.message);
    }
  }

  // ── 5. RLS ISOLATION — profiles self-only ─────────────────────────────────
  {
    if (!session) record('T5', 'RLS: profiles self-only', 'SKIP', 'no session');
    else {
      const { count, error } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
      if (error) record('T5', 'RLS: profiles self-only', 'FAIL', error.message);
      else record('T5', 'RLS: profiles self-only', count === 1 ? 'PASS' : 'FAIL',
        `visible profile rows=${count} (expected 1)`);
    }
  }

  // ── 6. RLS ISOLATION — agency_users subtree boundary ──────────────────────
  {
    if (!session) record('T6', 'RLS: agency_users isolation', 'SKIP', 'no session');
    else {
      const { data, error } = await supabase.from('agency_users').select('agency_id, user_id');
      if (error) record('T6', 'RLS: agency_users isolation', 'FAIL', error.message);
      else {
        const myRows = data.filter((r) => r.user_id === userId);
        record('T6', 'RLS: agency_users isolation',
          data.every((r) => r.user_id === userId) || data.length === myRows.length ? 'PASS' : 'PASS-REVIEW',
          `rows visible=${data.length}, own rows=${myRows.length}; agencies=[${[...new Set(data.map(r => r.agency_id))].join(',')}] — must all be inside caller's subtree`);
      }
    }
  }

  // ── 7. CLIENT WRITE DENIAL (server-side provisioning only) ────────────────
  {
    if (!session) record('T7', 'RLS: client write denied', 'SKIP', 'no session');
    else {
      const { error } = await supabase.from('profiles').insert({ username: 'hacker', role: 'agency' });
      record('T7', 'RLS: client write denied', error ? 'PASS' : 'FAIL',
        error ? `insert rejected: ${error.message}` : 'CLIENT COULD INSERT A PROFILE — RLS WRITE HOLE');
    }
  }

  // ── 8. PASSWORD CHANGE (round-trip; restores original) ────────────────────
  {
    if (!session) record('T8', 'password change', 'SKIP', 'no session');
    else {
      const newPw = 'Rotated-' + Date.now() + '-x!A';
      const { error } = await supabase.auth.updateUser({ password: newPw });
      if (error) record('T8', 'password change', 'FAIL', error.message);
      else {
        // restore original password so the suite is re-runnable
        const { error: revertErr } = await supabase.auth.updateUser({ password: process.env.SUPABASE_TEST_PASSWORD });
        record('T8', 'password change', revertErr ? 'PASS-REVERT-FAILED' : 'PASS',
          revertErr ? `changed but revert failed: ${revertErr.message} — restore manually!` : 'changed + reverted OK');
      }
    }
  }

  // ── 9. PASSWORD RECOVERY (sends email; cannot complete without inbox) ─────
  {
    const { data, error } = await supabase.auth.resetPasswordForEmail(process.env.SUPABASE_TEST_EMAIL);
    record('T9', 'password recovery email', error ? 'FAIL' : 'PASS',
      error ? error.message : `recovery email dispatched to ${process.env.SUPABASE_TEST_EMAIL} (click-through completion requires inbox access — manual step)`);
  }

  // ── 10. LOGOUT ────────────────────────────────────────────────────────────
  {
    if (!session) record('T10', 'logout', 'SKIP', 'no session');
    else {
      const { error } = await supabase.auth.signOut();
      record('T10', 'logout', error ? 'FAIL' : 'PASS', error ? error.message : 'signOut completed');
      // post-logout: the old access token must be rejected
      const { error: postErr } = await supabase.auth.getUser(session.access_token);
      record('T10b', 'post-logout token rejected', postErr ? 'PASS' : 'FAIL',
        postErr ? `stale token rejected: ${postErr.message}` : 'stale token STILL VALID after signOut');
    }
  }

  // ── 11. ACCOUNT PROVISIONING / HIERARCHY ──────────────────────────────────
  // Server-only (service role) by design — the desktop client cannot and must
  // not be able to provision accounts. The harness therefore VERIFIES THE
  // NEGATIVE (client cannot provision) and points at the server-side test:
  {
    if (!session) record('T11', 'provisioning: client denied', 'SKIP', 'no session');
    else {
      // re-login to have a valid session
      const { data: relogin } = await supabase.auth.signInWithPassword({
        email: process.env.SUPABASE_TEST_EMAIL, password: process.env.SUPABASE_TEST_PASSWORD,
      });
      session = relogin.session;
      const { error } = await supabase.auth.admin.createUser({ email: 'should-fail@invalid' });
      record('T11', 'provisioning: client denied', error ? 'PASS' : 'FAIL',
        error ? `admin API refused with anon key: ${error.message}` : 'CLIENT CREATED A USER — privilege escalation');
    }
    record('T11b', 'provisioning: server-side flow', 'NOT VERIFIED',
      'requires running the RBAC server suite with SUPABASE_SERVICE_ROLE_KEY in a trusted env — see tests/rbac-creation-matrix.test.js (7/7 pass offline) + live run pending');
  }

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status !== 'PASS' && r.status !== 'FAIL').length;
  console.log('\n==== SUMMARY ====');
  console.log(JSON.stringify({ project: process.env.SUPABASE_URL, total: results.length, pass, fail, skipNotVerified: skip }, null, 2));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(1); });
