/**
 * READ-ONLY probe: is the legacy `invoices` API surface actually live?
 *
 * Phase 10 requires evidence, not inference, about whether `invoices` is an
 * active write path or dead code. This starts a server against a DISPOSABLE
 * copy of the database and calls the real endpoints.
 *
 * Nothing is written to the live database: the guard below refuses to run
 * unless the target filename is marked disposable.
 *
 *   node scripts/probe-invoices-legacy.js
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'data', 'invoices-probe-test');
// 'test' in the filename is what satisfies assertDisposableDb().
const DB = path.join(WORK, 'invoices-probe-test.db');

const { assertDisposableDb } = require(path.join(ROOT, 'scripts', 'assert-disposable-db'));
const safePath = assertDisposableDb(DB, { suite: 'probe-invoices-legacy.js' });

const PORT = 3477;

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), safePath);
  for (const s of ['-wal', '-shm']) {
    const p = safePath + s;
    if (fs.existsSync(p)) fs.copyFileSync(p, safePath + s);
  }

  const logFd = fs.openSync(path.join(WORK, 'server.log'), 'w');
  const server = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: safePath,
      BLACKSTACK_USER_DATA_DIR: path.join(WORK, 'user-data').replace(/\\/g, '/'),
      NODE_ENV: 'development',
    },
    stdio: ['ignore', logFd, logFd],
  });
  const stop = () => { try { server.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', stop);

  const base = `http://localhost:${PORT}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Wait for readiness. The health endpoint is mounted at /health (server/app.js:121),
  // NOT under /api — probing /api/health returns 404 forever.
  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) { up = true; break; }
    } catch (_) { /* not yet */ }
  }
  if (!up) {
    console.error('server did not become ready; see', path.join(WORK, 'server.log'));
    process.exit(2);
  }

  // Authenticate.
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@blackstack.local', password: 'admin123' }),
  });
  const lj = await login.json().catch(() => null);
  const token = lj?.data?.token || lj?.token || lj?.data?.access_token;
  if (!token) { console.error('login failed', JSON.stringify(lj).slice(0, 300)); process.exit(2); }
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const call = async (m, ep, body) => {
    const r = await fetch(`${base}${ep}`, {
      method: m, headers: H, body: body ? JSON.stringify(body) : undefined,
    });
    let d = null; try { d = await r.json(); } catch (_) {}
    return { status: r.status, body: d };
  };

  const out = {};

  // 1. GET list — is the read path live?
  out.list = await call('GET', '/api/invoices?limit=5');

  // 2. POST create — the decisive test. A live write path accepts this.
  //    The contact must be a REAL id: InvoiceService.create() runs
  //    assertTenantRef() and rejects a contact that does not exist, which would
  //    otherwise be mistaken for "the legacy path is dead".
  const { DatabaseSync: _DBSync } = require('node:sqlite');
  const _peek = new _DBSync(safePath, { readOnly: true });
  const realContact = _peek.prepare(
    `SELECT c.id FROM contacts c WHERE c.company_id = 'default' LIMIT 1`).get();
  _peek.close();
  const contactId = (realContact && realContact.id) || null;

  const create = await call('POST', '/api/invoices', {
    company_id: 'default',
    invoice_number: 'PROBE-LEGACY-001',
    contact_id: contactId,
    issue_date: new Date().toISOString().slice(0, 10),
    due_date: new Date().toISOString().slice(0, 10),
    subtotal: 100, tax: 0, discount: 0, total: 100,
    paid_amount: 0, balance: 100,
    currency: 'INR', status: 'DRAFT',
  });
  out.contactIdUsed = contactId;
  out.create = { status: create.status, body: create.body };
  const invoiceId = create.body?.data?.id || create.body?.data?.invoice?.id || create.body?.id;

  // 3. Confirm persistence by reading the row straight from the DB.
  const db = new _DBSync(safePath, { readOnly: true });
  out.rowsAfterCreate = db.prepare('SELECT COUNT(*) n FROM invoices').get().n;
  out.createdRow = invoiceId
    ? db.prepare('SELECT id, invoice_number, status, total FROM invoices WHERE id = ?').get(invoiceId)
    : null;

  // 4. UPDATE / STATUS / DELETE — full CRUD surface?
  if (invoiceId) {
    out.update = { status: (await call('PUT', `/api/invoices/${invoiceId}`, { notes: 'probe' })).status };
    out.setStatus = { status: (await call('PATCH', `/api/invoices/${invoiceId}/status`, { status: 'SENT' })).status };
    out.remove = { status: (await call('DELETE', `/api/invoices/${invoiceId}`)).status };
  }
  out.rowsAfterDelete = db.prepare('SELECT COUNT(*) n FROM invoices').get().n;
  db.close();

  console.log(JSON.stringify(out, null, 2));
  stop();
  await sleep(800);
  fs.rmSync(WORK, { recursive: true, force: true });
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
