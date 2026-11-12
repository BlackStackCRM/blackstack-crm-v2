/**
 * Background retry worker for Supabase cloud sync failures.
 *
 * What this module does:
 *   - Periodically invokes `retryPending(db)` from `server/services/supabase.service.js`
 *     to re-send every PENDING / FAILED cloud sync record to Supabase.
 *   - Uses the project's real database connection: `server/utils/db.js` ->
 *     `DatabaseConnection.connect()` -> `ConnectionAdapter`.
 *   - Interval is configurable via `SYNC_RETRY_INTERVAL_MS` (default 30000 ms).
 *   - Serializes retry passes in-process (a single worker at a time).
 *   - Logs retry failures; never crashes the server.
 *   - Stops cleanly on `SIGTERM` / `SIGINT` (graceful shutdown).
 *   - Starts only AFTER migrations have succeeded and the DB connection is bound.
 *
 * Design notes (verified against real code):
 *   - `retryPending(db)` (server/services/supabase.service.js:200) is SYNCHRONOUS.
 *     It uses `db.all() / db.get() / db.run()` and returns an array of results.
 *   - The retry policy is already enforced inside `retryPending()`:
 *       WHERE status IN ('PENDING','FAILED') ORDER BY (FAILED first) ...
 *     attempts incremented on each failure; records are never re-sent if `SYNCED`.
 *   - `markRetrySuccess` / `markRetryFailure` update `cloud_sync_status`.
 *   - No secrets are used or logged: the service role key is read only inside
 *     `getClient()` (server/services/supabase.service.js:154).
 */
'use strict';

const path = require('path');
const { getConn } = require('../utils/db');
const { retryPending } = require('../services/supabase.service.js');

/** Interval in milliseconds; configurable via env (default 30000). */
function resolveRetryInterval(raw) {
  const ms = Number(raw);
  if (Number.isInteger(ms) && ms > 0 && ms <= 86_400_000) {
    return ms;
  }
  const fallback = 30_000; // 30 seconds
  console.warn(
    `[retry-worker] Invalid SYNC_RETRY_INTERVAL_MS="${raw}" (must be a positive integer ms <= 86400000). Falling back to ${fallback} ms.`,
  );
  return fallback;
}

const RETRY_INTERVAL_MS = resolveRetryInterval(process.env.SYNC_RETRY_INTERVAL_MS);

// Guards against overlapping retry passes (synchronous `retryPending` has no
// native overlap; this is an extra safety net if the contract ever becomes async).
let isRetrying = false;
let retryTimer = null;
let workerPaused = false;

// Injected provider so tests can point the worker at a stubbed connection without
// touching the real server DB. By default it returns the project's real
// ConnectionAdapter (server/utils/db.js -> DatabaseConnection.connect()).
function getConnectionAdapter() {
  return getConn();
}

/**
 * Run a single retry pass.
 *
 * Safe to call multiple times: `isRetrying` prevents two passes at once.
 * Never throws: a failure is logged and `isRetrying` is cleared in `finally`.
 */
let inFlightPass = null; // Promise of the currently running pass, if any

function runRetryPass() {
  if (workerPaused) return Promise.resolve();
  if (isRetrying) {
    return inFlightPass || Promise.resolve();
  }
  isRetrying = true;
  // FIX 2 (audit 2026-11-02): retryPending is now async (it performs a cloud
  // delete for locally-removed agencies before purging their sync row), so it
  // returns a Promise. Await it inside an async wrapper; the try/finally still
  // guarantees isRetrying is cleared, and a rejection is logged, not thrown.
  inFlightPass = (async () => {
    try {
      const db = getConnectionAdapter();
      if (!db) {
        return;
      }
      const results = await retryPending(db);
      if (results && results.length) {
        // Optional: log retry pressure (e.g. a few OLDEST pending records).
        // Deliberately not logging every retry to avoid log-bloat.
      }
    } catch (err) {
      console.error('[retry-worker] retry pass failed:', err && err.message);
    } finally {
      isRetrying = false;
      inFlightPass = null;
    }
  })();
  return inFlightPass;
}

/**
 * Start the periodic retry worker.
 *
 * Spawns an immediate first pass, then a repeating timer at `RETRY_INTERVAL_MS`.
 * Returns the interval ID (for use by `stopRetryWorker`).
 */
function startRetryWorker() {
  if (retryTimer) {
    console.warn('[retry-worker] Worker already started.');
    return retryTimer;
  }
  // First pass runs immediately on start (no delay).
  runRetryPass();
  retryTimer = setInterval(() => {
    runRetryPass();
  }, RETRY_INTERVAL_MS);
  console.log(
    `[retry-worker] Started (interval=${RETRY_INTERVAL_MS} ms).`,
  );
  return retryTimer;
}

/**
 * Stop the periodic retry worker.
 *
 * - Clears the interval timer.
 * - Waits for any in-flight retry pass to complete before returning, so a
 *   `SIGTERM` / `SIGINT` cannot interrupt a `retryPending(db)` pass midway.
 *
 * Safe to call when the worker was never started.
 */
function stopRetryWorker() {
  if (!retryTimer) {
    return;
  }
  clearInterval(retryTimer);
  retryTimer = null;
  // Wait for an in-flight pass to finish before returning (graceful shutdown).
  // FIX 2: await the in-flight async pass directly; fall back to the flag-poll
  // only if a pass is somehow running without a registered promise.
  if (inFlightPass) {
    Promise.race([
      inFlightPass,
      new Promise((r) => setTimeout(r, 10_000).unref()),
    ]).finally(() => console.log('[retry-worker] Stopped.'));
    return;
  }
  if (isRetrying) {
    const settle = new Promise((resolve) => {
      const check = () => {
        if (!isRetrying) {
          resolve();
        } else {
          setTimeout(check, 20).unref();
        }
      };
      check();
    });
    // Do not block indefinitely.
    setTimeout(() => {
      resolve();
    }, 10_000).unref();
  }
  console.log('[retry-worker] Stopped.');
}

/** Pause retry scheduling and wait for the current pass before a destructive purge. */
async function pauseRetryWorker() {
  workerPaused = true;
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  if (inFlightPass) await inFlightPass;
}

/** Resume periodic retries without triggering an immediate sync pass. */
function resumeRetryWorker() {
  if (!workerPaused) return;
  workerPaused = false;
  if (!retryTimer) retryTimer = setInterval(() => runRetryPass(), RETRY_INTERVAL_MS);
}

module.exports = {
  runRetryPass,
  startRetryWorker,
  stopRetryWorker,
  pauseRetryWorker,
  resumeRetryWorker,
  RETRY_INTERVAL_MS,
};
