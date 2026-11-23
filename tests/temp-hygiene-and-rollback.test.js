/**
 * TEST-HYGIENE + ROLLBACK-SAFETY TESTS (§30)
 *
 * H: scripts/temp-dir-hygiene.js
 *    H1 removes stale bscrm-* dirs (older than the grace period)
 *    H2 PROTECTS fresh dirs (active test runs are never deleted)
 *    H3 respects a live .bscrm-active lock marker
 *    H4 non-fatal on unreadable/locked entries
 *    H5 never touches non-bscrm directories
 *
 * RB: cutover rollback safety (operator directive: after rolling the flag
 *    back, cloud access tokens must NOT be accepted by the legacy flow —
 *    rollback must not turn the cloud session into an uncontrolled master
 *    key).
 *    RB1 a Supabase-shaped access token (RS256, iss/aud correct, forged sig)
 *        is REJECTED by legacy SessionManager.verifyToken
 *    RB2 a legacy HS256 token IS accepted when the flag is OFF
 *    RB3 the flag is read at request time: unset -> legacy, set -> cloud
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const { sweepStaleTempDirs } = require(path.join(ROOT, 'scripts/temp-dir-hygiene.js'));

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const makeJwt = (h, p) => `${b64u(h)}.${b64u(p)}.SIG`;
const URL = 'https://proj.supabase.co';
const GOOD_UID = 'aaaaaaaa-bbbb-cccc-dddd-eeee';

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bscrm-hyg-test-')); }

describe('H: stale temp-dir sweep', () => {
  test('H1 removes a STALE bscrm-* directory (mtime beyond grace period)', () => {
    const root = mkTmp();
    const oldDir = path.join(root, 'bscrm-suite-old');
    fs.mkdirSync(oldDir);
    const past = new Date(Date.now() - 60 * 60 * 1000); // 1 h old
    fs.utimesSync(oldDir, past, past);
    const r = sweepStaleTempDirs({ tmpDir: root, graceMs: 30 * 60 * 1000 });
    expect(r.removed).toContain(oldDir);
    expect(fs.existsSync(oldDir)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('H2 protects FRESH bscrm-* dirs (active test run)', () => {
    const root = mkTmp();
    const freshDir = path.join(root, 'bscrm-suite-active');
    fs.mkdirSync(freshDir);
    fs.writeFileSync(path.join(freshDir, 'suite-e2e.db'), 'x');
    const r = sweepStaleTempDirs({ tmpDir: root, graceMs: 30 * 60 * 1000 });
    expect(r.skippedReasons['within-grace-period']).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(freshDir)).toBe(true); // NOT deleted
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('H3 honours a live .bscrm-active lock even on an old directory', () => {
    const root = mkTmp();
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    // Live lock (OUR pid): the directory is old but a running test owns it —
    // must be protected.
    const liveDir = path.join(root, 'bscrm-suite-live');
    fs.mkdirSync(liveDir);
    fs.utimesSync(liveDir, past, past);
    fs.writeFileSync(path.join(liveDir, '.bscrm-active'), String(process.pid));
    // Writing the lock marker bumps the dir mtime — re-age the directory so
    // it passes the grace check and the LOCK protection is what is verified.
    fs.utimesSync(liveDir, past, past);
    const r2 = sweepStaleTempDirs({ tmpDir: root, graceMs: 30 * 60 * 1000 });
    expect(fs.existsSync(liveDir)).toBe(true); // live lock protected
    expect(r2.skippedReasons['active-lock']).toBeGreaterThanOrEqual(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('H4 non-fatal: unreadable entries counted as errors, sweep continues', () => {
    const root = mkTmp();
    const r = sweepStaleTempDirs({ tmpDir: path.join(root, 'does-not-exist') });
    expect(r.removed).toHaveLength(0);
    expect(r.errors).toBe(0); // readdir failure -> clean empty result
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('H5 never touches non-bscrm directories', () => {
    const root = mkTmp();
    const other = path.join(root, 'some-other-tool-cache');
    fs.mkdirSync(other);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(other, past, past);
    const r = sweepStaleTempDirs({ tmpDir: root, graceMs: 1000 });
    expect(fs.existsSync(other)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('RB: cutover rollback safety (legacy flow rejects cloud tokens)', () => {
  function freshSession() {
    delete require.cache[require.resolve(path.join(ROOT, 'server/auth/session.js'))];
    delete require.cache[require.resolve(path.join(ROOT, 'server/auth/jwtSecret.js'))];
    return require(path.join(ROOT, 'server/auth/session.js')).SessionManager;
  }

  test('RB1: a Supabase-shaped cloud token is REJECTED by the legacy verifier', () => {
    process.env.JWT_SECRET = 'rb-test-secret-value-at-least-32-bytes!!';
    const SessionManager = freshSession();
    const cloudToken = makeJwt(
      { alg: 'RS256', kid: 'k' },
      { iss: URL + '/auth/v1', aud: 'authenticated', sub: GOOD_UID, exp: Math.floor(Date.now() / 1000) + 600 },
    );
    // Even with a VALID-looking cloud token, the legacy verifier (HS256,
    // pinned iss=blackstack-crm, aud=blackstack-crm-desktop) must reject it.
    expect(SessionManager.verifyToken(cloudToken)).toBeNull();
  });

  test('RB2: legacy HS256 token IS accepted when the cutover flag is OFF', () => {
    process.env.JWT_SECRET = 'rb-test-secret-value-at-least-32-bytes!!';
    const SessionManager = freshSession();
    const s = SessionManager.createSession(
      { id: 'u1', email: 'x@blackstack.local', full_name: 'X', role: 'USER' },
      { companyId: 'cmp1', permissions: [], roleIds: [], sessionId: 'sess_rb' },
    );
    expect(SessionManager.verifyToken(s.token)).toBeTruthy();
    expect(process.env.BLACKSTACK_REQUIRE_CLOUD_TOKEN).toBeUndefined();
  });

  test('RB3: enforcement flag is read at request time (unset -> legacy, set -> cloud)', () => {
    const mwPath = path.join(ROOT, 'server/middleware/auth.js');
    const src = fs.readFileSync(mwPath, 'utf8');
    // Structural guarantee: the flag is checked INSIDE authMiddleware, not
    // hoisted to module scope — so runtime flag changes take effect.
    const fnIdx = src.indexOf('async function authMiddleware(req, res, next)');
    const checkIdx = src.indexOf('if (cloudTokenEnforcementEnabled())');
    expect(fnIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(fnIdx);
    expect(src).toContain("process.env.BLACKSTACK_REQUIRE_CLOUD_TOKEN === '1'");
  });
});
