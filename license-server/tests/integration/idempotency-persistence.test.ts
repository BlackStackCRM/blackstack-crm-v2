import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const trackedServers = new Set();

async function getFreePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', (err) => err ? reject(err) : resolve()));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  return port;
}

// Resolve the actual tsx CLI entrypoint via Node's module resolution.
const CLI_PKG_DIR = require_('path').dirname(require_('path').dirname(require_.resolve('tsx')));
const TSX_CLI = require_('path').join(CLI_PKG_DIR, 'dist', 'cli.mjs');

const FIXTURE_SQL = `
  CREATE TABLE IF NOT EXISTS licenses (
    id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, product_id TEXT NOT NULL,
    code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', device_limit INTEGER NOT NULL DEFAULT 1, lease_days INTEGER NOT NULL DEFAULT 30,
    allocated INTEGER NOT NULL DEFAULT 0, allocated_at TEXT, expires_at TEXT, created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  );`;

function makeServiceToken(jwtSecret, sub, tokenAudience = 'license-server') {
  const now = Math.floor(Date.now() / 1000);
  const jti = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  return require_('jsonwebtoken').sign(
    { iss: tokenAudience, aud: tokenAudience, sub, scope: ['licenses:admin'], jti, nbf: now, iat: now, exp: now + 900 },
    jwtSecret,
    { algorithm: 'HS256' },
  );
}

function makeHeaders(token, key) {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + token,
    'Idempotency-Key': key,
  };
}

interface Server {
  port: number;
  dbPath: string;
  child: ReturnType<typeof spawn>;
  JWT_SECRET: string;
}

async function startServer(dbPath, port) {
  const db = new DatabaseSync(dbPath);
  db.exec(FIXTURE_SQL);
  db.prepare(
    `INSERT OR IGNORE INTO licenses (id, agency_id, product_id, code, status, device_limit, lease_days, allocated, expires_at, created_by)
     VALUES ('LIC-1', 'AG-1', 'PROD-1', 'LIC-1', 'ACTIVE', 2, 30, 0, NULL, 'AG-1')`,
  ).run();
  db.close();

  const JWT_SECRET = crypto.randomBytes(32).toString('hex');
  const env = {
    ...process.env,
    DB_PATH: dbPath,
    PORT: String(port),
    JWT_SECRET: JWT_SECRET,
    TOKEN_AUDIENCE: 'license-server',
    NODE_ENV: 'development',
  };

  const child = spawn(process.execPath, [TSX_CLI, 'src/index.ts'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const server = { port, dbPath, child, JWT_SECRET, output: '' };
  trackedServers.add(server);
  child.stdout.setEncoding('utf8').on('data', (chunk) => { server.output += `[stdout] ${chunk}`; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { server.output += `[stderr] ${chunk}`; });

  const deadline = Date.now() + 30000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) { healthy = true; break; }
    } catch {}
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!healthy) {
    await stopServer(server);
    throw new Error(`server failed to become healthy on port ${port}\n${server.output}`);
  }
  return server;
}

async function stopServer(s) {
  const child = s.child;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGINT');
    let timer;
    await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000); })]);
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  trackedServers.delete(s);
}

describe('Idempotency — file-based persistence (integration)', () => {
  let s1;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.env.LICENSE_SERVER_TEST_TMPDIR || tmpdir(), 'tmp-idem-'));
  });

  afterEach(async () => {
    try {
      for (const server of [...trackedServers]) await stopServer(server);
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      s1 = undefined;
      tmpDir = undefined;
    }
  });

  it('5.1 bootstrap: idempotency table created safely on fresh license.db', async () => {
    const dbPath = path.join(tmpDir, 'bootstrap.db');
    const port = await getFreePort();
    const s1_first = await startServer(dbPath, port);
    const JWT_SECRET = s1_first.JWT_SECRET;

    const db = new DatabaseSync(dbPath);
    const has = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='idempotency'`,
    ).get();
    expect(has).not.toBeNull();
    db.close();

    const db2 = new DatabaseSync(dbPath);
    db2.exec("INSERT INTO idempotency (key, fingerprint, status, body_json, created_license_ids) VALUES ('ik-boot-1', 'fp', 201, '{}', '[]')");
    db2.close();

    await stopServer(s1_first);
    s1 = await startServer(dbPath, port);
    const db3 = new DatabaseSync(dbPath);
    const row = db3.prepare('SELECT COUNT(*) AS c FROM idempotency WHERE key = ?').get('ik-boot-1');
    expect(row.c).toBe(1);
    db3.close();
  });

  it('5.2 restart: idempotency record survives server restart', async () => {
    const dbPath = path.join(tmpDir, 'restart.db');
    const port = await getFreePort();
    const s1_first = await startServer(dbPath, port);
    const JWT_SECRET = s1_first.JWT_SECRET;

    const token = makeServiceToken(JWT_SECRET, 'AG-1');
    const key = 'ik-restart-1';

    const r1 = await fetch(`http://127.0.0.1:${port}/api/licenses/allocate`, {
      method: 'POST',
      headers: makeHeaders(token, key),
      body: JSON.stringify({ agency_id: 'AG-1', product_id: 'PROD-1', count: 1 }),
    });
    expect(r1.status).toBe(201);
    const b1 = await r1.json();
    expect(b1.data.licenses).toHaveLength(1);

    // Stop the first server and wait for it to checkpoint the WAL
    // (db.pragma('wal_checkpoint(TRUNCATE)') runs in the SIGINT handler).
    s1 = s1_first;
    await stopServer(s1);

    s1 = await startServer(dbPath, port);
    const token2 = makeServiceToken(s1.JWT_SECRET, 'AG-1');
    const r2 = await fetch(`http://127.0.0.1:${port}/api/licenses/allocate`, {
      method: 'POST',
      headers: makeHeaders(token2, key),
      body: JSON.stringify({ agency_id: 'AG-1', product_id: 'PROD-1', count: 1 }),
    });
    // Idempotency repeat with same key + same payload must return the
    // stored result verbatim (201), not a new allocation.
    expect(r2.status).toBe(201);
    expect(await r2.json()).toEqual(b1);
    const verifyDb = new DatabaseSync(dbPath);
    const licensesAfter = verifyDb.prepare('SELECT COUNT(*) AS c FROM licenses').get().c;
    verifyDb.close();
    expect(licensesAfter).toBe(2); // LIC-1 + 1, no duplicate
  });

  it('5.3 multi-instance: two instances with same key produce a single allocation', async () => {
    const dbPath = path.join(tmpDir, 'multi.db');
    const port1 = await getFreePort();
    const port2 = await getFreePort();
    const s1_ = await startServer(dbPath, port1);
    const s2_ = await startServer(dbPath, port2);
    const s1 = s1_;
    const s2 = s2_;

    const token1 = makeServiceToken(s1.JWT_SECRET, 'AG-1');
    const token2 = makeServiceToken(s2.JWT_SECRET, 'AG-1');
    const key = 'ik-multi-1';

    const p1 = fetch(`http://127.0.0.1:${port1}/api/licenses/allocate`, {
      method: 'POST',
      headers: makeHeaders(token1, key),
      body: JSON.stringify({ agency_id: 'AG-1', product_id: 'PROD-1', count: 1 }),
    });
    const p2 = fetch(`http://127.0.0.1:${port2}/api/licenses/allocate`, {
      method: 'POST',
      headers: makeHeaders(token2, key),
      body: JSON.stringify({ agency_id: 'AG-1', product_id: 'PROD-1', count: 1 }),
    });
    // Both servers share the same DB. One request allocates; the other
    // returns the stored 201 response for the same key and payload.
    // Exactly one allocation is persisted.
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(await r1.json()).toEqual(await r2.json());

    const verifyDb = new DatabaseSync(dbPath);
    const licenses = verifyDb.prepare('SELECT COUNT(*) AS c FROM licenses').get().c;
    verifyDb.close();
    expect(licenses).toBe(2); // LIC-1 + 1, never 3
  });

  it('5.4 concurrency: distinct keys never exceed quota', async () => {
    const dbPath = path.join(tmpDir, 'conc.db');
    const port = await getFreePort();
    const s1 = await startServer(dbPath, port);
    const token = makeServiceToken(s1.JWT_SECRET, 'AG-1');
    const keys = ['ik-conc-1', 'ik-conc-2', 'ik-conc-3'];

    const promises = keys.map((k) =>
      fetch(`http://127.0.0.1:${port}/api/licenses/allocate`, {
        method: 'POST',
        headers: makeHeaders(token, k),
        body: JSON.stringify({ agency_id: 'AG-1', product_id: 'PROD-1', count: 1 }),
      }),
    );
    const responses = await Promise.all(promises);

    // LIC-1 has device_limit=2, allocated=0. Each request needs 1 seat.
    // Request 1: available=2 >= 1 → 201 (allocated becomes 1)
    // Request 2: available=1 >= 1 → 201 (allocated becomes 2)
    // Request 3: available=0 < 1 → 409 QUOTA_EXCEEDED
    const ok = responses.filter((r) => r.status === 201).length;
    const verifyDb = new DatabaseSync(dbPath);
    const licenses = verifyDb.prepare('SELECT COUNT(*) AS c FROM licenses').get().c;
    const avail = verifyDb.prepare(
      `SELECT COALESCE(SUM(device_limit - allocated), 0) AS a FROM licenses WHERE agency_id = ?`,
    ).get('AG-1').a;
    verifyDb.close();

    expect(ok).toBe(2); // Requires an authoritative agency-quota fixture.
    expect(licenses).toBe(3);
    expect(avail).toBe(0);
  });

  it('5.5 atomicity: allocation + idempotency record in one transaction', async () => {
    const dbPath = path.join(tmpDir, 'atomic.db');
    const port = await getFreePort();
    const s1_ = await startServer(dbPath, port);
    const s1 = s1_;

    const token = makeServiceToken(s1.JWT_SECRET, 'AG-1');
    const key = 'ik-atomic-1';

    const r = await fetch(`http://127.0.0.1:${port}/api/licenses/allocate`, {
      method: 'POST',
      headers: makeHeaders(token, key),
      body: JSON.stringify({ agency_id: 'AG-1', product_id: 'PROD-1', count: 1 }),
    });
    expect(r.status).toBe(201);
    const responseBody = await r.json();

    const db = new DatabaseSync(dbPath);
    try {
    const lic = db.prepare('SELECT COUNT(*) AS c FROM licenses WHERE agency_id = ?').get('AG-1').c;
    const idem = db.prepare('SELECT key, fingerprint, status, body_json, created_license_ids, created_at FROM idempotency WHERE key = ?').get(key) as
      | { key: string; fingerprint: string; status: number; body_json: string; created_license_ids: string; created_at: string }
      | undefined;
    expect(lic).toBe(2);
    expect(idem).not.toBeNull();
    expect(idem!.status).toBe(201);
    const persistedIds = JSON.parse(idem!.created_license_ids);
    const responseIds = responseBody.data.licenses.map((license) => license.id);
    expect(persistedIds).toEqual(responseIds);
    expect(persistedIds).not.toContain('LIC-1');
    for (const id of persistedIds) {
      expect(db.prepare('SELECT product_id FROM licenses WHERE id = ?').get(id).product_id).toBe('PROD-1');
    }
    expect(JSON.parse(idem!.body_json)).toEqual(responseBody);

    const r2 = await fetch(`http://127.0.0.1:${port}/api/licenses/allocate`, {
      method: 'POST',
      headers: makeHeaders(token, key),
      body: JSON.stringify({ agency_id: 'AG-1', product_id: 'PROD-1', count: 2 }),
    });
    expect(r2.status).toBe(409);
    const idem2 = db.prepare('SELECT COUNT(*) AS c FROM idempotency WHERE key = ?').get(key);
    expect(idem2!.c).toBe(1); // no new record, no new allocation
    } finally {
      db.close();
    }
  });
});
