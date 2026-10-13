/**
 * Guard for browser E2E suites: refuse to run against production.
 *
 * WHY THIS EXISTS
 *   On 2026-10-08 the inventory E2E suite wrote 20 inventory vouchers, 3 journal
 *   entries, 3 stock-ledger rows and 27 USER_LOGIN audit rows into the LIVE
 *   production database, and the release gate's gate 9 caught it.
 *
 *   The suite already guarded its direct database access correctly — it calls
 *   assertDisposableDb(process.env.DB_PATH) and refused anything that was not a
 *   throwaway file. That guard was not enough, because the suite also navigates a
 *   BROWSER, and the browser is a second, independent path to the database:
 *
 *     const BASE_URL = 'http://localhost:3000';   // <-- bypassed baseURL entirely
 *     await page.goto(`${BASE_URL}/login.html`);
 *
 *   run-one-e2e.js started a correct isolated server on E2E_PORT with a copied
 *   suite-e2e.db, and playwright.e2e.config.js derived baseURL from E2E_PORT
 *   correctly — but the suite ignored both and talked to whatever was listening
 *   on :3000, which was an unrelated long-running process backed onto production.
 *
 *   So: a disposable-DB guard is necessary but NOT sufficient. The target HOST
 *   must be guarded too. This module does that.
 *
 * WHAT IT ENFORCES
 *   1. E2E_PORT must be set and must not be a production port.
 *   2. The port must be free BEFORE the browser starts (an occupied port means
 *      somebody else's server — exactly the failure that caused the incident).
 *   3. DB_PATH must resolve to a disposable file (delegates to assertDisposableDb).
 *   4. assertNotProductionUrl() rejects any absolute URL aimed at production.
 *
 * HOW A SUITE USES IT
 *   const { assertE2eIsolation } = require('../scripts/assert-e2e-isolation');
 *   const E2E = assertE2eIsolation({ suite: 'inventory.e2e' });   // throws on refusal
 *   const BASE_URL = E2E.baseURL;   // derived from E2E_PORT, never hardcoded
 *
 * It fails CLOSED: with nothing configured, it refuses rather than defaulting.
 */
const net = require('net');
const path = require('path');
const { assertDisposableDb } = require('./assert-disposable-db');

/** Ports a real BlackStack CRM install or dev server is expected to use. */
const PRODUCTION_PORTS = [3000, 3001, 8080, 3133, 4173, 5173];

/** Hostnames that mean "the real app". */
const PRODUCTION_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];

const DEFAULT_PORT = 3199;

function isProductionPort(port) {
  return PRODUCTION_PORTS.includes(Number(port));
}

/**
 * Reject an absolute URL that points at production.
 * @param {string} url
 * @param {string} [suite]
 * @throws {Error} if the URL targets a production host/port
 */
function assertNotProductionUrl(url, suite = 'this E2E suite') {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error(
      `REFUSING TO RUN: ${suite} was given a non-absolute or non-http URL: ${url}\n`
      + '  E2E must derive its target from E2E_PORT. Never hardcode a host in a test.',
    );
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`REFUSING TO RUN: ${suite} was given an unparseable URL: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));

  const problems = [];
  if (!PRODUCTION_HOSTS.includes(host)) {
    problems.push(`host "${host}" is not a recognised local E2E host`);
  }
  if (isProductionPort(port)) {
    problems.push(`port ${port} is a reserved PRODUCTION port`);
  }
  if (problems.length) {
    throw new Error(
      `REFUSING TO RUN: ${suite} targets production.\n`
      + `  url     : ${url}\n`
      + problems.map((p) => `  problem : ${p}\n`).join('')
      + `  E2E must never talk to a production server. Point it at the isolated\n`
      + `  harness port via E2E_PORT (e.g. ${DEFAULT_PORT}) and let baseURL be derived.`,
    );
  }
  return url;
}

/** Resolve true when something is already listening on the port. */
function isPortInUse(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { socket.destroy(); } catch { /* noop */ } resolve(v); } };
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

/**
 * Full isolation assertion. Call once at suite load, before launching a browser.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.suite]        suite name for error messages
 * @param {string}  [opts.requireFreePort] set false only if the caller has
 *                                        already reserved the port itself
 * @returns {Promise<{port:number, baseURL:string, dbPath:string}>}
 * @throws {Error} on any isolation violation — always fails closed
 */
async function assertE2eIsolation(opts = {}) {
  const { suite = 'this E2E suite', requireFreePort = true } = opts;
  const problems = [];

  // ── 1. Port must be explicitly configured and must not be production ──────
  const rawPort = process.env.E2E_PORT;
  if (!rawPort) {
    problems.push(
      `E2E_PORT is not set. The harness must choose an explicit test port `
      + `(e.g. ${DEFAULT_PORT}); it must never fall back to a production port.`,
    );
  }
  const port = Number(rawPort || DEFAULT_PORT);
  if (Number.isNaN(port)) {
    problems.push(`E2E_PORT is not a number: ${rawPort}`);
  } else if (isProductionPort(port)) {
    problems.push(
      `E2E_PORT=${port} is a RESERVED PRODUCTION port `
      + `(reserved: ${PRODUCTION_PORTS.join(', ')}).`,
    );
  }

  // ── 2. DB must be a disposable file (delegates to the existing allow-list) ─
  let dbPath = null;
  try {
    dbPath = assertDisposableDb(process.env.DB_PATH, {
      defaultTo: path.join(__dirname, '..', 'data', 'blackstack-crm.db'),
      suite,
    });
  } catch (e) {
    problems.push(e.message.split('\n').map((l) => `  ${l.trim()}`).join('\n'));
  }

  // ── 3. Port must be free: an occupied port means someone ELSE's server ────
  if (requireFreePort && !Number.isNaN(port) && !isProductionPort(port)) {
    if (await isPortInUse(port)) {
      problems.push(
        `port ${port} is already in use. That is another process's server — `
        + 'exactly the condition that let this suite reach production. '
        + 'Pick a free port; the harness will not reuse a busy one.',
      );
    }
  }

  if (problems.length) {
    throw new Error(
      `\n${'='.repeat(74)}\n`
      + `E2E ISOLATION REFUSED — ${suite}\n`
      + `${'='.repeat(74)}\n`
      + problems.map((p) => `  • ${p}\n`).join('')
      + `\n  This guard fails CLOSED on purpose. If a browser E2E suite cannot prove it\n`
      + '  is isolated, it must not run. See scripts/assert-e2e-isolation.js.\n',
    );
  }

  const baseURL = `http://localhost:${port}`;
  // The derived target must itself pass the URL guard (defence in depth).
  assertNotProductionUrl(baseURL, suite);
  return { port, baseURL, dbPath };
}

module.exports = {
  assertE2eIsolation,
  assertNotProductionUrl,
  isPortInUse,
  isProductionPort,
  PRODUCTION_PORTS,
  PRODUCTION_HOSTS,
  DEFAULT_PORT,
};
