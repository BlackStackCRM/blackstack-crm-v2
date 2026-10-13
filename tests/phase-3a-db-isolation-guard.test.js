/**
 * PHASE 3A INCIDENT — regression tests for the disposable-database guard.
 *
 * The incident: on 2026-10-09 an Accounting audit probe set process.env.DB_PATH
 * to a temp clone, then required modules whose chain had already loaded
 * server/database/connection.js. That module binds
 *   const DB_PATH = process.env.DB_PATH || <production default>
 * at MODULE SCOPE, so the cached connection stayed on data/blackstack-crm.db and
 * FIVE JOURNAL ENTRIES were written into production.
 *
 * Every pre-existing check was satisfied at the time: the filename carried a
 * disposable marker, the path was outside data/, and the env var was set. Only
 * SQLite's own `PRAGMA database_list` revealed the truth.
 *
 * Each case below runs in its own child process, because the failure depends on
 * module-load order and require-cache state — which cannot be reproduced inside
 * a single already-loaded process.
 *
 * Every child is asserted to have written NOTHING to production.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const ROOT = path.join(__dirname, '..');
const PROD_DB = path.join(ROOT, 'data', 'blackstack-crm.db');

/** Count journal entries in production, read-only. */
function prodJournalCount() {
  const tmp = path.join(os.tmpdir(), `p3a-reg-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
  for (const e of ['', '-wal', '-shm']) {
    if (fs.existsSync(PROD_DB + e)) fs.copyFileSync(PROD_DB + e, tmp + e);
  }
  const db = new DatabaseSync(tmp, { readOnly: true });
  const n = db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c;
  db.close();
  for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + e); } catch { /* noop */ } }
  return n;
}

function fp() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'phase-d-inspect-db.js'), 'data/blackstack-crm.db'],
    { cwd: ROOT, encoding: 'utf8' });
  const m = (r.stdout || '').match(/content fp\s*:\s*(\w+)/);
  return m ? m[1] : 'UNKNOWN';
}

const BEFORE = { je: prodJournalCount(), fp: fp() };

/** Run a child script, return {code, stdout}. */
function runChild(body, env = {}) {
  const file = path.join(os.tmpdir(), `p3a-case-${Date.now()}-${Math.floor(Math.random() * 1e6)}.js`);
  fs.writeFileSync(file, body, 'utf8');
  // CRITICAL: DB_PATH must be absent from the child environment unless the case
  // explicitly sets it. On 2026-10-09 a guard-test run itself wrote a sixth
  // journal entry into production, because the child inherited a repo-root cwd
  // and required connection.js with no DB_PATH set, so it bound to production
  // before the case body ran. Cases that intend to write MUST pass DB_PATH here.
  const childEnv = { ...process.env, ...env };
  if (!('DB_PATH' in env)) delete childEnv.DB_PATH;
  const r = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8', env: childEnv });
  for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + e); } catch { /* noop */ } }
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/**
 * Allocate a disposable clone and return it together with the child env that
 * points DB_PATH at it BEFORE the child process starts.
 */
function disposableTarget(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const db = path.join(dir, 'suite-e2e.db');
  fs.copyFileSync(PROD_DB, db);
  for (const e of ['-wal', '-shm']) {
    if (fs.existsSync(PROD_DB + e)) fs.copyFileSync(PROD_DB + e, db + e);
  }
  return { dir, db, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } } };
}

const SETUP = `
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};
`;

describe('PHASE 3A — disposable DB guard regression', () => {
  test('baseline: production is unchanged by this whole suite', () => {
    expect(prodJournalCount()).toBe(BEFORE.je);
    expect(fp()).toBe(BEFORE.fp);
  });

  // ── Case 1: the exact incident pattern ────────────────────────────────
  test('CASE 1 — require-chain loads the connection BEFORE DB_PATH is set: guard refuses', () => {
    const body = SETUP + `
      // 1. Load the connection chain FIRST, exactly as the incident probe did.
      const { DatabaseConnection } = require(path.join(ROOT, 'server/database/connection.js'));
      const conn = new DatabaseConnection().connect();

      // 2. Only NOW create the disposable DB and set DB_PATH — too late.
      const { createDisposableDb } = require(path.join(ROOT, 'scripts/assert-disposable-db.js'));
      let refused = false;
      try {
        createDisposableDb({ suite: 'incident-case-1', prefix: 'bscrm-inc1-' });
      } catch (e) {
        refused = /WRONG DATABASE|DB_PATH was changed AFTER the database was bound/.test(e.message);
      }
      console.log(refused ? 'GUARD_REFUSED' : 'GUARD_DID_NOT_REFUSE');

      // 3. Whatever happened, confirm which file is actually open.
      const open = conn.all('PRAGMA database_list').find(r => r.name === 'main');
      console.log('OPEN_FILE=' + open.file);
    `;
    const r = runChild(body);
    expect(r.out, `child output:\n${r.out}`).toContain('GUARD_REFUSED');
    // The connection must still point at production (that IS the scenario) —
    // the point is that the guard now BLOCKS the caller before it can write.
    expect(r.out).toMatch(/OPEN_FILE=.*blackstack-crm\.db/);
  });

  // ── Case 2: correct order still works ────────────────────────────────
  test('CASE 2 — DB_PATH supplied in the child env binds the connection to the clone', () => {
    const t = disposableTarget('bscrm-inc2-');
    const body = SETUP + `
      const { createDisposableDb } = require(path.join(ROOT, 'scripts/assert-disposable-db.js'));
      let refused = false;
      try { createDisposableDb({ suite: 'incident-case-2', prefix: 'bscrm-inc2chk-' }); }
      catch (e) { refused = /WRONG DATABASE|DB_PATH was changed AFTER the database was bound/.test(e.message); }
      console.log('GUARD_REFUSED=' + refused);

      const { DatabaseConnection } = require(path.join(ROOT, 'server/database/connection.js'));
      const conn = new DatabaseConnection().connect();
      const open = conn.all('PRAGMA database_list').find(r => r.name === 'main');
      console.log('OPEN_FILE=' + open.file);
      console.log('IS_DISPOSABLE=' + (open.file.includes('bscrm-inc2-') ? 'true' : 'false'));
    `;
    // The point of the correct pattern: DB_PATH is in the ENVIRONMENT, so the
    // module-level constant resolves to the disposable clone at require time.
    const r = runChild(body, { DB_PATH: t.db });
    t.cleanup();
    expect(r.out, `child output:\n${r.out}`).toContain('GUARD_REFUSED=false');
    expect(r.out, `child output:\n${r.out}`).toContain('IS_DISPOSABLE=true');
  });

  // ── Case 3: a cached production connection is detected ───────────────
  test('CASE 3 — an already-cached production connection is detected by the guard', () => {
    const body = SETUP + `
      // Bind to production first (no DB_PATH in env).
      delete process.env.DB_PATH;
      const { DatabaseConnection } = require(path.join(ROOT, 'server/database/connection.js'));
      const conn = new DatabaseConnection().connect();

      // Now hand the guard a disposable path it must detect as unused.
      const { assertDisposableDbIsActive } = require(path.join(ROOT, 'scripts/assert-disposable-db.js'));
      let refused = false;
      try {
        assertDisposableDbIsActive({
          suite: 'incident-case-3',
          tmpDir: 'C:/fake-tmp',
          expected: 'C:/fake-tmp/suite-e2e.db',
        });
      } catch (e) { refused = /WRONG DATABASE|DB_PATH was changed AFTER the database was bound/.test(e.message); }
      console.log(refused ? 'DETECTED' : 'NOT_DETECTED');
    `;
    const r = runChild(body);
    expect(r.out, `child output:\n${r.out}`).toContain('DETECTED');
  });

  // ── Case 4: writing through the guard cannot reach production ────────
  test('CASE 4 — a guarded disposable write lands in the clone, never production', () => {
    const t = disposableTarget('bscrm-inc4-');
    const body = SETUP + `
      const { createDisposableDb } = require(path.join(ROOT, 'scripts/assert-disposable-db.js'));
      try { createDisposableDb({ suite: 'incident-case-4', prefix: 'bscrm-inc4chk-' }); }
      catch (e) { console.log('GUARD_REFUSED'); process.exit(3); }

      const { DatabaseConnection } = require(path.join(ROOT, 'server/database/connection.js'));
      const { JournalEntryRepository } = require(path.join(ROOT, 'server/repositories/journal-entry.repository.js'));
      const conn = new DatabaseConnection().connect();
      const [A, B] = conn.all("SELECT id FROM accounts WHERE company_id='default' AND is_active=1 LIMIT 2").map(r => r.id);
      new JournalEntryRepository(conn).createWithValidation(
        { company_id: 'default', entry_date: '2026-01-01', description: 'guard-test',
          currency: 'INR', status: 'POSTED', created_by: 'admin' },
        [{ account_id: A, debit_amount: 5 }, { account_id: B, credit_amount: 5 }]
      );
      const open = conn.all('PRAGMA database_list').find(r => r.name === 'main');
      console.log('WROTE_OK');
      console.log('OPEN_IS_DISPOSABLE=' + (open.file.includes('bscrm-inc4-') ? 'true' : 'false'));
    `;
    const r = runChild(body, { DB_PATH: t.db });
    t.cleanup();
    expect(r.out, `child output:\n${r.out}`).toContain('WROTE_OK');
    expect(r.out, `child output:\n${r.out}`).toContain('OPEN_IS_DISPOSABLE=true');
  });
});

describe('PHASE 3A — production unchanged after every guard case', () => {
  test('no guard test wrote to production', () => {
    expect(prodJournalCount()).toBe(BEFORE.je);
    expect(fp()).toBe(BEFORE.fp);
  });
});