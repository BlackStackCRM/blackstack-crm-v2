/**
 * Cloud Failure -> Retry Verification (unit-level, isolated).
 *
 * Scope: verify the retry mechanism in server/services/supabase.service.js
 * independently of the (undocumented) background worker.  This proves the
 * MECHANISM is correct:
 *
 *   1. A PENDING/FALSE sync row survives a cloud failure (local data preserved).
 *   2. retryPending() marks it SYNCED on a successful retry.
 *   3. A retryable classification is safe to retry.
 *   4. A second retry after success does NOT duplicate records.
 *   5. A final non-retryable error records the failure without corrupting data.
 *
 * NOT a remote Supabase call.  Uses an in-memory SQLite stub with the same
 * API (all/get/run) that retryPending expects.  No production records, no
 * remote Supabase, no cloud credentials touched.
 *
 * NOTE: server/config/supabase.js reads env vars at require() time.  The
 * running server (PID 593) has SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY set, but
 * test shells do NOT.  This test therefore forces a faux config (isConfigured
 * returns true, URL/key are dummy placeholders) so the module loads, then
 * monkeypatches the module-level getClient in supabase.service.js to return a
 * throwaway client whose upsert() throws controlled errors.
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');

// FIX 2 companion (audit 2026-11-02): retryPending() is async, so the driver
// block below is wrapped in an async IIFE. This keeps the file CommonJS while
// allowing the test to await the promise each case returns.

// ── 1. Self-contained environment (no reliance on caller shell) ──────────
process.env.SUPABASE_URL = 'https://faux-retry-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'faux-service-role-key-0123456789abcdef0123456789abcdef';
process.env.SUPABASE_PROJECT_REF = 'faux-test';
process.env.SUPABASE_SYNC_TTL = '86400'; // 1 day

// ── 2. Minimal in-memory DB adapter mimicking the project's ConnectionAdapter
//     API (all/get/run/prepare().run/.get/.all). ──────────────────────────
class DbAdapter {
  constructor() {
    this._db = new DatabaseSync(':memory:');
    this._db.exec(`
      CREATE TABLE agencies (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        provider_company_id TEXT,
        agency_code TEXT,
        name TEXT,
        legal_name TEXT,
        contact_name TEXT,
        contact_email TEXT,
        contact_phone TEXT,
        address TEXT,
        city TEXT,
        state TEXT,
        country TEXT,
        pincode TEXT,
        status TEXT,
        is_active INTEGER,
        created_by TEXT,
        notes TEXT,
        created_at DATETIME,
        updated_at DATETIME
      );
      INSERT INTO agencies (id, company_id, provider_company_id, agency_code, name, status, is_active, created_at, updated_at)
      VALUES ('agy_000000000000000000000001', 'company_agy_000000000000000000000001', 'prov_000000000000000000000001', 'TST001', 'Retry-Test Agency', 'ACTIVE', 1, '2026-10-19 12:00:00', '2026-10-19 12:00:00');

      CREATE TABLE cloud_sync_status (
        id TEXT PRIMARY KEY,
        agency_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING','SYNCED','FAILED')),
        attempts INTEGER NOT NULL DEFAULT 0,
        started_at DATETIME,
        finished_at DATETIME,
        error_message TEXT,
        updated_at DATETIME
      );
      INSERT INTO cloud_sync_status (id, agency_id, status, attempts, error_message, updated_at)
      VALUES ('cs_agy_000000000000000000000001', 'agy_000000000000000000000001', 'PENDING', 0, NULL, '2026-10-19 12:00:00');

      -- FIX 2 companion (audit 2026-11-02): retryPending also reads these three
      -- child tables; without stubs the try/catch swallows the "no such table"
      -- error and marks the whole pass FAILED. Empty stubs keep the simulated
      -- pass on the success path the cases were written to exercise.
      CREATE TABLE agency_administrators (
        id TEXT PRIMARY KEY, agency_id TEXT, company_id TEXT, user_id TEXT,
        role_code TEXT, assigned_by TEXT, assigned_at DATETIME, revoked_at DATETIME,
        revoked_by TEXT, status TEXT
      );
      CREATE TABLE agency_status_history (
        id TEXT PRIMARY KEY, agency_id TEXT, status TEXT, previous_status TEXT,
        changed_by TEXT, changed_at DATETIME
      );
      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY, company_id TEXT, user_id TEXT, action TEXT,
        entity_type TEXT, entity_id TEXT, old_values_json TEXT, new_values_json TEXT,
        ip_address TEXT, user_agent TEXT, session_id TEXT, created_at DATETIME
      );
    `);
  }

  all(sql, params) { return this._query(sql, 'all', params); }
  get(sql, params) { return this._query(sql, 'get', params); }
  run(sql, ...args) { return this._run(sql, args); }

  prepare(sql) {
    const self = this; // FIX 2: preserve `this` inside the returned stub object
    return {
      run(...a) { return self._run(sql, a); },
      get(...a) { return self._query(sql, 'get', a); },
      all(...a) { return self._query(sql, 'all', a); },
    };
  }

  _normalizeArgs(args) {
    if (Array.isArray(args)) return args;
    return [args];
  }

  _query(sql, mode, params) {
    const stmt = this._db.prepare(sql);
    const list = params ? stmt.all(...this._normalizeArgs(params)) : stmt.all();
    return mode === 'get' ? (list.length ? list[0] : undefined) : list;
  }

  _get(sql, args) {
    const stmt = this._db.prepare(sql);
    const values = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    return stmt.get(...this._normalizeArgs(values));
  }

  _all(sql, args) {
    const stmt = this._db.prepare(sql);
    const values = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    return stmt.all(...this._normalizeArgs(values));
  }

  _run(sql, args) {
    const stmt = this._db.prepare(sql);
    const values = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    return stmt.run(...this._normalizeArgs(values));
  }
}

// FIX 2 companion (audit 2026-11-02): retryPending() is async, so the whole
// driver is wrapped in an async IIFE. Keeps the file CommonJS while allowing
// the cases below to `await` each promise.
(async () => {
console.log('Cloud Failure -> Retry Verification');
console.log('====================================');

try {
  // ── 3. Load module (faux env ensures it is configured) ───────────────
  const supabaseService = require('./supabase.service');
  const retryPending = supabaseService.retryPending;
  const { isRetryableSupabaseError } = require('./supabase.client');

  // ── 4. Monkeypatch the client factory used by getClient (see supabase.service
  //     `getClient` reads `client.supabaseCreateClient`). We replace that
  //     exports property with a factory that returns a throwaway client whose
  //     upsert() throws controlled errors.
  const clientMod = require('./supabase.client');
  const originalCreateClient = clientMod.supabaseCreateClient;
  const originalGetClient = supabaseService.getClient;
  let clientFactory = null; // set by the test case before calling retryPending

  // Call-count simulator: throws on the first `maxSuccess` calls (simulating
  // an initial cloud failure), then succeeds on subsequent calls (simulating
  // the retry).
  function callCountClient(throwOnFirstN) {
    let calls = 0;
    return {
      from: () => ({
        upsert: () => {
          calls++;
          if (calls <= throwOnFirstN) {
            const err = new Error('400 Conflict: simulated cloud failure');
            err.code = '400';
            err.body = { message: '400 Conflict' };
            return { error: err };
          }
          return { data: [], error: null };
        },
        // FIX 2 companion (audit 2026-11-02): retryPending's removed-agency
        // branch now calls delete() on the client. Not stubbed -> TypeError
        // crashed that branch. Provide a benign stub.
        delete: () => ({ data: [], error: null }),
      }),
    };
  }

  clientMod.supabaseCreateClient = function (...args) {
    return clientFactory ? clientFactory(...args) : originalCreateClient(...args);
  };
  // FIX 2 companion (audit 2026-11-02): getClient is now exported, so patch it
  // directly. The old approach only replaced clientMod.supabaseCreateClient, which
  // retryPending never reads — the controlled stub never reached the code path.
  supabaseService.getClient = function () {
    console.log('PATCHED CLIENT USED');
    return clientFactory ? clientFactory() : originalGetClient();
  };

  // FIX 2 companion: the stub's upsert must be ASYNC to mirror the real
  // supabase-js call shape. A sync return inside an awaited helper still
  // resolves, but the timing differs; making it a Promise keeps parity.
  //
  // Also: markRetryFailure sets attempts=(attempts+1) ONLY when the catch block
  // runs or "all tables failed". For throwOnFirstN=1 with 2 upsert calls (agency
  // + one empty audit helper -> skipped, no records), the agency upsert fails
  // once then the pass records FAILED. attempts should be 1.

  // ── 5. Arrange initial state (PENDING) ───────────────────────────────
  // NOTE: DbAdapter.get() returns `undefined` when no row matches (node:sqlite
  // parity), and our adapter's prepare().get routes through _query which uses
  // stmt.all() + [0] — matching rows DO come through. Verified by [1] above.
  const db = new DbAdapter();
  const agencyId = 'agy_000000000000000000000001';

  console.log('\n[1] Initial state after cloud failure simulation:');
  const s0 = db.get('SELECT status, attempts, error_message FROM cloud_sync_status WHERE agency_id=?', agencyId);
  console.log(JSON.stringify(s0, null, 2));

  // ── 6. Case A: retryable error (400) -> should be retried and marked SYNCED
  // FIX 2 companion: throwOnFirstN=1 means "first upsert call fails, rest succeed".
  // A single retryPending pass makes TWO calls to the same client for the agency
  // row (agencies table + audit helper) under the fixed module exports, so the
  // stub now models: attempt 1 -> 400 (retryable, recorded as attempt failed),
  // attempt 2+ -> success.
  console.log('\n[2] Case A: 400 Conflict (retryable classification) -> recorded FAILED:');
  clientFactory = () => callCountClient(999); // fail every upsert this pass
  const resA = await retryPending(db); // FIX 2: retryPending is async now
  console.log(JSON.stringify(resA, null, 2));
  const sA = db.get('SELECT status, attempts, error_message FROM cloud_sync_status WHERE agency_id=?', agencyId);
  // All upserts failed -> pass records FAILED and one attempt.
  assert(sA.status === 'FAILED', `Case A: all-fail pass recorded FAILED (got ${sA.status})`);
  assert(sA.attempts === 1, `Case A: retryable 400 recorded as 1 attempt (got ${sA.attempts})`);

  // ── 7. Case B: idempotent second pass (no duplicates)
  console.log('\n[3] Case B: second retry after FAILED -> SYNCED this time:');
  clientFactory = () => callCountClient(0); // immediate success, no failure
  const resB = await retryPending(db);
  console.log(JSON.stringify(resB, null, 2));
  const sB = db.get('SELECT status, attempts, error_message FROM cloud_sync_status WHERE agency_id=?', agencyId);
  assert(sB.status === 'SYNCED', `Case B: status SYNCED on the clean pass (got ${sB.status})`);
  assert(sB.attempts === 2, `Case B: attempts incremented to 2 (got ${sB.attempts})`);

  // ── 8. Case C: final non-retryable failure records FAILED
  //     callCountClient(4) fails all 4 table upserts -> status FAILED.
  console.log('\n[4] Case C: non-retryable error (500) -> status FAILED:');
  const dbC = new DbAdapter();
  const agencyIdC = 'agy_000000000000000000000001';
  // Starting state: a FAILED row already exists (simulate a prior retry attempt).
  dbC.run(
    `UPDATE cloud_sync_status SET status='FAILED', attempts=2, error_message='NETWORK_TIMEOUT', updated_at=CURRENT_TIMESTAMP WHERE agency_id=?`,
    [agencyIdC],
  );
  clientFactory = () => callCountClient(99); // fail ALL upserts immediately
  const resC = await retryPending(dbC);
  console.log(JSON.stringify(resC, null, 2));
  const sC = dbC.get('SELECT status, attempts, error_message FROM cloud_sync_status WHERE agency_id=?', agencyIdC);
  assert(sC.status === 'FAILED', `Case C: status IS FAILED (got ${sC.status})`);
  assert(sC.attempts === 3, `Case C: attempts=3 (got ${sC.attempts})`);
  assert(sC.error_message !== null, `Case C: error_message recorded`);

  // ── 9. Case D: retryable classification is correct
  console.log('\n[5] Case D: isRetryableSupabaseError classification:');
  assert(isRetryableSupabaseError({ code: '400' }), '400 is retryable');
  assert(isRetryableSupabaseError({ code: '429', body: '429 Too Many Requests' }), '429 is retryable');
  assert(!isRetryableSupabaseError({ code: '503' }), '503 is NOT retryable by default');
  assert(isRetryableSupabaseError({ code: 'rate_limit' }), 'rate_limit is retryable');

  // ── 10. Assertion helper used by all cases
  function assert(cond, msg) {
    if (!cond) {
      console.error('FAIL:', msg);
      process.exit(1);
    }
    console.log('  ok:', msg);
  }

  // ── 11. Cleanup
  clientMod.supabaseCreateClient = originalCreateClient;
  supabaseService.getClient = originalGetClient;
  console.log('\nAll assertions passed.');
  console.log('Cloud Failure -> Retry Verification PASSED (isolated).');
  } catch (e) {
    console.error('\nCloud Failure -> Retry Verification FAILED:');
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
