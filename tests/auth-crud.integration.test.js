/**
 * Integration tests — real HTTP server + real SQLite (no mocks).
 * Path under test: HTTP -> routes -> middleware/auth -> controllers ->
 * services -> repositories -> SQLite.
 */
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Unique temp DB per test run.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bscrm-test-'));
const DB_PATH = path.join(TMP_DIR, 'test.db');

// PHASE 3A — DEFENCE IN DEPTH.
//
// This suite mints its own temp path and passes DB_PATH to every child process
// it spawns, which is correct. But it runs inside a shared vitest worker: if a
// sibling suite opened a database first, the connection path is already frozen
// and this file's DB_PATH would be ignored. Assert the file in use is the
// throwaway one before anything connects. Non-creating and cheap.
const { assertDisposableDb } = require('../scripts/assert-disposable-db.js');
assertDisposableDb(DB_PATH, { suite: 'auth-crud.integration', defaultTo: DB_PATH });
const PORT = 3100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;

let serverProc;

function api(method, url, { token, body } = {}) {
  return fetch(`${BASE}/api${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

async function waitReady(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Server on ${BASE} did not become ready within ${timeoutMs}ms`);
}

async function dbQuery(sql, params = []) {
  const script = `
    const { DatabaseConnection } = require('${ROOT.replace(/\\/g, '/')}/server/database/connection');
    const db = new DatabaseConnection();
    const conn = db.connect();
    console.log(JSON.stringify(conn.all(${JSON.stringify(sql)}, ${JSON.stringify(params)})));
    conn.close();
  `;
  const out = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, DB_PATH }
  });
  if (out.status !== 0) throw new Error('DB helper failed: ' + out.stderr);
  return JSON.parse(out.stdout.trim().split('\n').pop());
}

beforeAll(async () => {
  const migrate = spawnSync(process.execPath, [path.join(ROOT, 'server', 'database', 'migrate.js')], {
    encoding: 'utf8',
    env: { ...process.env, DB_PATH },
    timeout: 60000
  });
  if (migrate.status !== 0) {
    throw new Error('Migrate failed:\n' + migrate.stdout + '\n' + migrate.stderr);
  }

  const seed = spawnSync(process.execPath, [path.join(ROOT, 'server', 'database', 'seed.js')], {
    encoding: 'utf8',
    env: { ...process.env, DB_PATH, DEMO_MODE: 'true' },
    timeout: 60000
  });
  if (seed.status !== 0) {
    throw new Error('Seed failed:\n' + seed.stdout + '\n' + seed.stderr);
  }

  // Start the real server as a child process on the temp DB.
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server', 'app.js')], {
    env: { ...process.env, DB_PATH, PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stderr.on('data', d => process.stderr.write('[server] ' + d));
  await waitReady();
}, 90000);

afterAll(() => {
  if (serverProc) serverProc.kill();
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* WAL lock */ }
});

describe('Authentication', () => {
  test('valid login returns JWT and user with permissions', async () => {
    const res = await api('POST', '/auth/login', {
      body: { email: 'admin@blackstack.local', password: 'admin123' }
    });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.token).toBeTruthy();
    expect(data.user.email).toBe('admin@blackstack.local');
    expect(Array.isArray(data.user.permissions)).toBe(true);
    expect(data.user.permissions.length).toBeGreaterThan(0);
  });

  test('invalid password -> 401', async () => {
    const res = await api('POST', '/auth/login', {
      body: { email: 'admin@blackstack.local', password: 'wrong' }
    });
    expect(res.status).toBe(401);
  });

  test('unknown user -> 401', async () => {
    const res = await api('POST', '/auth/login', {
      body: { email: 'nobody@x.io', password: 'whatever' }
    });
    expect(res.status).toBe(401);
  });

  test('protected route without token -> 401', async () => {
    const res = await api('GET', '/contacts');
    expect(res.status).toBe(401);
  });

  test('garbage token -> 401', async () => {
    const res = await api('GET', '/contacts', { token: 'not.a.jwt' });
    expect(res.status).toBe(401);
  });
});
