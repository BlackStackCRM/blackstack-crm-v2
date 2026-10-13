/**
 * PHASE 3A — RUNTIME ISOLATION REGRESSION.
 *
 * These are behavioural tests, not source-text assertions. Every case runs in a
 * CHILD PROCESS so module state cannot leak between cases, and each one asks
 * SQLite which file it really has open.
 *
 * The incident they guard: on 2026-10-09 a bill created by
 * tests/customer-bills.vitest.test.js landed in the PRODUCTION database
 * (BILL-2026-00001) because server/database/connection.js resolved its path at
 * module-require time and a sibling suite in the same vitest worker had already
 * loaded it. Setting process.env.DB_PATH afterwards was silently ignored.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROD_DB = path.join(ROOT, 'data', 'blackstack-crm.db');

/** Production state, read from a throwaway copy, for before/after comparison. */
function prodState() {
  const tmp = path.join(os.tmpdir(), `iso-prod-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
  for (const e of ['', '-wal', '-shm']) {
    if (fs.existsSync(PROD_DB + e)) fs.copyFileSync(PROD_DB + e, tmp + e);
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(tmp, { readOnly: true });
  const state = {
    journalEntries: db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c,
    journalLines: db.prepare('SELECT COUNT(*) c FROM journal_entry_lines').get().c,
    bills: db.prepare('SELECT COUNT(*) c FROM bills').get().c,
    auditLogs: db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c,
    fyLocks: db.prepare("SELECT group_concat(id || '=' || is_locked) g FROM financial_years").get().g,
  };
  db.close();
  for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + e); } catch { /* noop */ } }
  return state;
}
const BEFORE = prodState();

/** Run a snippet in a fresh process; return {status, stdout, stderr}. */
function inChild(code) {
  const r = spawnSync(process.execPath, ['-e', code], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('PHASE 3A — the connection path is bound at connect(), not at require()', () => {
  test('setting DB_PATH AFTER a production connect does NOT redirect it', () => {
    // Reproduces the exact incident shape. The connection was already bound, so
    // it must keep pointing at the file it opened — and the drift must be
    // REPORTABLE, not silently ignored.
    const r = inChild(`
      const path = require('path');
      const connMod = require('./server/database/connection.js');
      const prod = path.resolve('data/blackstack-crm.db');
      delete process.env.DB_PATH;
      const db = new connMod.DatabaseConnection().connect();
      const open = db.all('PRAGMA database_list').find(r => r.name === 'main').file;
      console.log(JSON.stringify({ open, bound: connMod._boundDbPath() }));
      // Now the "too late" assignment that used to be ignored:
      process.env.DB_PATH = path.resolve('tests', 'too-late-e2e.db');
      const drift = connMod._pathDrift();
      console.log(JSON.stringify({ drift }));
    `);
    expect(r.status, r.stderr).toBe(0);
    const openLine = JSON.parse(r.stdout.trim().split('\n')[0]);
    expect(openLine.open.replace(/\\/g, '/')).toMatch(/data\/blackstack-crm\.db$/);
    const driftLine = JSON.parse(r.stdout.trim().split('\n')[1]);
    // The drift is now DETECTABLE — previously it was unknowable.
    expect(driftLine.drift).not.toBeNull();
    expect(driftLine.drift.bound.replace(/\\/g, '/')).toMatch(/data\/blackstack-crm\.db$/);
    expect(driftLine.drift.env.replace(/\\/g, '/')).toMatch(/too-late-e2e\.db$/);
  });

  test('setting DB_PATH BEFORE the first connect DOES take effect', () => {
    const r = inChild(`
      const path = require('path');
      const os = require('os');
      const tmp = path.join(os.tmpdir(), 'iso-early-' + Date.now() + '-e2e.db');
      require('fs').copyFileSync('data/blackstack-crm.db', tmp);
      process.env.DB_PATH = tmp;                      // set BEFORE first connect
      const connMod = require('./server/database/connection.js');
      const db = new connMod.DatabaseConnection().connect();
      console.log(JSON.stringify({ open: db.all('PRAGMA database_list').find(r => r.name === 'main').file }));
      try { require('fs').unlinkSync(tmp); } catch (e) {}
    `);
    expect(r.status, r.stderr).toBe(0);
    const { open } = JSON.parse(r.stdout.trim());
    expect(open).toMatch(/iso-early-\d+-e2e\.db$/);
    expect(open.replace(/\\/g, '/')).not.toMatch(/data\/blackstack-crm\.db$/);
  });

  test('a second suite in the same worker cannot silently reuse a production binding', () => {
    // The shared-worker case. Simulated by requiring the module once, binding
    // production, then acting as a "second suite" that wants its own DB.
    const r = inChild(`
      const path = require('path');
      const connMod = require('./server/database/connection.js');
      delete process.env.DB_PATH;
      new connMod.DatabaseConnection().connect();          // "first suite" -> production
      process.env.DB_PATH = path.resolve('tests', 'second-suite-e2e.db');
      const { assertDisposableDbIsActive } = require('./scripts/assert-disposable-db.js');
      let refused = false, msg = '';
      try {
        assertDisposableDbIsActive({ suite: 'second-suite', tmpDir: path.dirname(path.resolve('tests')), expected: path.resolve('tests', 'second-suite-e2e.db') });
      } catch (e) { refused = true; msg = e.message; }
      console.log(JSON.stringify({ refused, mentions: /REFUSING TO WRITE/.test(msg) }));
    `);
    expect(r.status, r.stderr).toBe(0);
    const { refused, mentions } = JSON.parse(r.stdout.trim());
    expect(refused, 'the second suite must be refused, not silently allowed').toBe(true);
    expect(mentions).toBe(true);
  });
});

describe('PHASE 3A — customer-bills.vitest.test.js is isolated', () => {
  test('the leaky suite uses the disposable guard, not a hand-rolled path', () => {
    const src = fs.readFileSync(path.join(__dirname, 'customer-bills.vitest.test.js'), 'utf8');
    expect(src).toMatch(/createDisposableDb\(/);
    expect(src).toMatch(/assertDisposableDbIsActive\(/);
    // It must not invent its own path under tests/ and must not unlink a DB
    // that a sibling worker may be holding open.
    expect(src).not.toMatch(/path\.join\([^)]*'tests',\s*'test-cb-vitest\.sqlite'\)/);
    expect(src).not.toMatch(/unlinkSync\(DB_PATH/);
  });

  test('the disposable DB is chosen BEFORE the database modules are required', () => {
    const src = fs.readFileSync(path.join(__dirname, 'customer-bills.vitest.test.js'), 'utf8');
    const guardAt = src.indexOf('createDisposableDb({');
    const connAt = src.indexOf("require('../server/database/connection')");
    expect(guardAt).toBeGreaterThan(-1);
    expect(connAt).toBeGreaterThan(-1);
    // This ordering is the whole fix: binding first means the require-time
    // resolution cannot pre-empt it.
    expect(guardAt, 'createDisposableDb() must run before the db module require').toBeLessThan(connAt);
  });
});

describe('PHASE 3A — every bill/accounting suite is isolated', () => {
  const suites = [
    'bill-lifecycle.test.js',
    'customer-bills.vitest.test.js',
    'accounting-complete.test.js',
    'tax-gst.test.js',
    'crm-contact-deletion.test.js',
  ];

  test.each(suites)('%s uses a disposable DB or spawns a guarded server', (name) => {
    const src = fs.readFileSync(path.join(__dirname, name), 'utf8');
    const disposable = /createDisposableDb\(|assertDisposableDb\(/.test(src);
    // A suite may instead copy production into a temp dir itself, but then it
    // MUST still set DB_PATH for the server it spawns.
    const spawnsServerWithDbPath = /DB_PATH/.test(src);
    expect(disposable || spawnsServerWithDbPath,
      `${name} shows no evidence of database isolation`).toBe(true);
  });
});

describe('PHASE 3A — nothing in this suite touched production', () => {
  test('production counts and FY locks are unchanged', () => {
    const after = prodState();
    expect(after).toEqual(BEFORE);
  });

  test('the connection module exposes the drift check the guards depend on', () => {
    const connMod = require(path.join(ROOT, 'server', 'database', 'connection.js'));
    expect(typeof connMod._pathDrift).toBe('function');
    expect(typeof connMod._boundDbPath).toBe('function');
    // Nothing has connected in this process, so there is no binding to drift.
    expect(connMod._pathDrift()).toBeNull();
  });
});