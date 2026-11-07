/**
 * Connection cache lifecycle tests (audit fix #7).
 *
 * Covers server/utils/db.js:
 *   - getConn() lazily creates and caches a connection bound to DB_PATH at call time
 *   - _peekCachedConnection() returns the cache WITHOUT creating one
 *   - _closeCachedConnection() closes and resets the cache so the next getConn()
 *     re-creates it against the CURRENT DB_PATH
 *
 * Uses the module singleton directly (no require-cache surgery — vitest's CJS
 * interop makes per-test instance swapping unreliable). The cache is reset
 * between tests via _closeCachedConnection(), the same path backup/restore uses.
 *
 * Runs against disposable temp databases — never the production file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const dbUtils = require('../server/utils/db.js');

let tmpDir;
let dbPathA;
let dbPathB;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-cache-'));
  dbPathA = path.join(tmpDir, 'db-a.db');
  dbPathB = path.join(tmpDir, 'db-b.db');
});

afterAll(() => {
  dbUtils._closeCachedConnection();
  for (const f of [dbPathA, dbPathB]) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(f + suffix); } catch { /* absent */ }
    }
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
});

describe('connection cache lifecycle (server/utils/db.js)', () => {
  it('getConn() creates and caches a connection to DB_PATH', () => {
    process.env.DB_PATH = dbPathA;
    const conn = dbUtils.getConn();
    expect(conn).toBeTruthy();
    expect(typeof conn.prepare).toBe('function');
    // Second call returns the SAME cached instance.
    expect(dbUtils.getConn()).toBe(conn);
    dbUtils._closeCachedConnection();
  });

  it('_peekCachedConnection() returns null after the cache was closed', () => {
    // The previous test left the cache reset; peek must NOT create a connection.
    expect(dbUtils._peekCachedConnection()).toBeNull();
  });

  it('_peekCachedConnection() returns the cache without creating one', () => {
    process.env.DB_PATH = dbPathA;
    const conn = dbUtils.getConn();
    expect(dbUtils._peekCachedConnection()).toBe(conn);
    // Peeking repeatedly must not open additional connections.
    expect(dbUtils._peekCachedConnection()).toBe(conn);
    dbUtils._closeCachedConnection();
  });

  it('_closeCachedConnection() closes the handle and resets the cache', () => {
    process.env.DB_PATH = dbPathA;
    const conn = dbUtils.getConn();
    expect(dbUtils._peekCachedConnection()).toBe(conn);

    dbUtils._closeCachedConnection();
    expect(dbUtils._peekCachedConnection()).toBeNull();

    // The underlying sqlite handle is really closed: using it fails.
    let closedErr = null;
    try { conn.prepare('SELECT 1').all(); } catch (e) { closedErr = e; }
    expect(closedErr).toBeTruthy();
  });

  it('_closeCachedConnection() is a no-op when nothing is cached', () => {
    expect(dbUtils._peekCachedConnection()).toBeNull();
    expect(() => dbUtils._closeCachedConnection()).not.toThrow();
    expect(dbUtils._peekCachedConnection()).toBeNull();
  });

  it('after close, getConn() reconnects against the CURRENT DB_PATH', () => {
    process.env.DB_PATH = dbPathA;
    const first = dbUtils.getConn();
    first.run('CREATE TABLE t (id INTEGER)');
    first.run('INSERT INTO t (id) VALUES (1)');

    dbUtils._closeCachedConnection();

    // Rebind to a different disposable file; the cache was reset, so the new
    // getConn() must open the file DB_PATH names NOW.
    process.env.DB_PATH = dbPathB;
    const second = dbUtils.getConn();
    expect(dbUtils._peekCachedConnection()).toBe(second);

    // New file is empty: the table created in db-a does not exist in db-b.
    let queryErr = null;
    try { second.prepare('SELECT * FROM t').all(); } catch (e) { queryErr = e; }
    expect(queryErr, 'table from db-a must not exist in db-b').toBeTruthy();

    // And db-b genuinely writes/reads.
    second.run('CREATE TABLE t (id INTEGER)');
    second.run('INSERT INTO t (id) VALUES (42)');
    expect(second.prepare('SELECT id FROM t').all()).toEqual([{ id: 42 }]);

    dbUtils._closeCachedConnection();
    expect(dbUtils._peekCachedConnection()).toBeNull();
  });
});
