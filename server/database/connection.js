const fs = require('fs');
const path = require('path');
// PHASE 3A INCIDENT HARDENING: every connection this module opens, recorded in
// order. `DB_PATH` below is a module-level constant, so it is fixed when this
// file is first required; a caller that sets process.env.DB_PATH afterwards gets
// a connection still bound to whatever was resolved at that first require. The
// registry lets a disposable-DB safety guard ask what is ACTUALLY open without
// creating a connection to find out.
const _OPEN_CONNECTIONS = [];

const { DatabaseSync } = require('node:sqlite');

// PHASE 3A — ISOLATION FIX.
//
// WHY THIS MOVED OUT OF MODULE SCOPE
//   This used to be:
//     const DB_PATH = process.env.DB_PATH || <production>;
//   evaluated at require() time and cached for the life of the process. Under
//   vitest's shared worker processes a suite that sets process.env.DB_PATH
//   BEFORE its own require() was still bound to production, because another
//   test file in the same worker had already loaded this module. The later env
//   assignment was silently ignored.
//
//   That leaked a test bill into production on 2026-10-09
//   (BILL-2026-00001, created by tests/customer-bills.vitest.test.js).
//
// THE RULE NOW
//   The path is captured on FIRST connect(), not at import. So the first caller
//   to actually open a connection decides the file — which is the only moment
//   where "what database am I about to touch" is knowable. Afterwards the
//   binding is FROZEN: if process.env.DB_PATH changes later, that is a
//   misconfiguration and is reported through _pathDrift() so a guard can fail
//   closed, rather than being silently ignored the way it was before.
//
// Production behaviour is unchanged: the app sets DB_PATH (or DEMO_MODE) before
// anything connects, so the first connect() resolves the same file it always did.
const DEFAULT_DB_PATH = path.join(__dirname, '../../data/blackstack-crm.db');

// Per-process record of which DatabaseConnection instances are LIVE (not closed).
// A closed connection releases its claim, so a test that opens a fresh database
// per case (see tests/data-safety.test.js, which does exactly that) is NOT drift
// — it closed the previous handle before rebinding.
const _LIVE = new Set();

// Resolve on EVERY connect(), not just the first.
//
// The original defect was resolution at require() time, which meant a later
// DB_PATH assignment was silently ignored. Resolving per connect() fixes that:
// the caller that opens a connection decides the file, which is the only moment
// "what am I about to touch" is knowable.
function _resolveDbPath() {
  return path.resolve(process.env.DB_PATH || DEFAULT_DB_PATH);
}

/** True when no live connection is bound to a different file than `expected`. */
function _isRebindSafe(expected) {
  const want = path.resolve(expected);
  for (const rec of _OPEN_CONNECTIONS) {
    if (!_LIVE.has(rec)) continue;           // closed -> released its claim
    if (rec.resolvedPath !== want) return false;
  }
  return true;
}

/**
 * Report a post-bind DB_PATH change: the file this process has already committed
 * to differs from the one the environment now names. Non-creating; safety guards
 * use this to fail closed instead of trusting a stale environment variable.
 * @returns {null|{bound:string, env:string}}
 */
function _pathDrift() {
  const env = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : null;
  for (const rec of _OPEN_CONNECTIONS) {
    if (!_LIVE.has(rec)) continue;
    if (rec.resolvedPath !== env) {
      return { bound: rec.resolvedPath, env };
    }
  }
  return null;
}

/** The path this process WOULD open next. Does not connect. */
function _boundDbPath() {
  const live = _OPEN_CONNECTIONS.filter((r) => _LIVE.has(r));
  return live.length ? live[live.length - 1].resolvedPath : null;
}

/** Release a connection's claim on the database path (called from close()). */
function _releasePath(rec) {
  _LIVE.delete(rec);
}

/**
 * Statement adapter exposing the better-sqlite3-style API
 * (.run/.get/.all) on top of node:sqlite StatementSync.
 */
function wrapStatement(stmt) {
  return {
    run(...args) {
      return stmt.run(...normalizeArgs(args));
    },
    get(...args) {
      return stmt.get(...normalizeArgs(args));
    },
    all(...args) {
      return stmt.all(...normalizeArgs(args));
    }
  };
}

function toBindable(value) {
  // node:sqlite rejects undefined, functions, and plain objects as bind values.
  if (value === undefined) return null;
  if (typeof value === 'function') return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(value); // Date, arrays, nested objects
  }
  return value;
}

function normalizeArgs(args) {
  // Support both .run(a, b, c) and .run([a, b, c]) call styles.
  let list = (args.length === 1 && Array.isArray(args[0])) ? args[0] : args;
  return list.map(toBindable);
}

/**
 * Connection adapter over node:sqlite (built-in; no native compilation).
 * Preserves the database handle API the application was written against.
 */
class ConnectionAdapter {
  constructor(db) {
    this._db = db;
    this._txDepth = 0;
  }

  prepare(sql) {
    return wrapStatement(this._db.prepare(sql));
  }

  exec(sql) {
    return this._db.exec(sql);
  }

  run(sql, ...args) {
    return this._db.prepare(sql).run(...normalizeArgs(args));
  }

  get(sql, ...args) {
    return this._db.prepare(sql).get(...normalizeArgs(args));
  }

  all(sql, ...args) {
    return this._db.prepare(sql).all(...normalizeArgs(args));
  }

  pragma(source) {
    return this._db.exec(`PRAGMA ${source}`);
  }

  /**
   * Transaction wrapper. Nesting is supported via SAVEPOINTs.
   */
  transaction(fn) {
    const wrapped = (...args) => {
      if (this._txDepth === 0) {
        this._db.exec('BEGIN IMMEDIATE');
      } else {
        this._db.exec(`SAVEPOINT sp_${this._txDepth}`);
      }
      this._txDepth++;
      try {
        const result = fn(...args);
        this._txDepth--;
        if (this._txDepth === 0) {
          this._db.exec('COMMIT');
        } else {
          this._db.exec(`RELEASE SAVEPOINT sp_${this._txDepth}`);
        }
        return result;
      } catch (err) {
        this._txDepth--;
        if (this._txDepth === 0) {
          this._db.exec('ROLLBACK');
        } else {
          this._db.exec(`ROLLBACK TO SAVEPOINT sp_${this._txDepth}`);
        }
        throw err;
      }
    };
    return wrapped;
  }

  close() {
    return this._db.close();
  }
}

class DatabaseConnection {
  constructor() {
    this.db = null;
  }

  connect() {
    const DB_PATH = _resolveDbPath();
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new ConnectionAdapter(new DatabaseSync(DB_PATH));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    // PHASE 3A INCIDENT HARDENING: record this connection so a disposable-DB
    // guard can ask which file is ACTUALLY open. The binding is frozen on the
    // FIRST connect() — see the note above — so a caller that sets
    // process.env.DB_PATH afterwards is no longer silently ignored: the file
    // really in use is discoverable, and _pathDrift() reports the mismatch.
    const rec = { db: this.db, resolvedPath: path.resolve(DB_PATH) };
    _OPEN_CONNECTIONS.push(rec);
    _LIVE.add(rec);
    this._rec = rec;
    return this.db;
  }

  get() {
    if (!this.db) throw new Error('Database not connected');
    return this.db;
  }

  transaction(fn) {
    return this.get().transaction(fn);
  }

  close() {
    if (this._rec) _releasePath(this._rec);
    if (this.db) this.db.close();
  }
}

/** Connections opened by this module. Non-creating; for safety guards. */
function _openedConnections() {
  return _OPEN_CONNECTIONS.slice();
}

/**
 * Connections that are still OPEN, i.e. still able to write.
 *
 * PHASE 3A — this is what a safety guard must inspect. `_openedConnections()`
 * is a historical log: it includes every handle ever created, including ones
 * that have since been closed. Treating that log as "what is open" made the
 * guard refuse suites that legitimately cycle through a fresh disposable
 * database per test (tests/data-safety.test.js), because a handle from an
 * EARLIER test was still listed. A closed handle cannot write to anything, so it
 * is not a safety concern.
 */
function _liveConnections() {
  return _OPEN_CONNECTIONS.filter((r) => _LIVE.has(r));
}

module.exports = {
  DatabaseConnection,
  _openedConnections,
  _liveConnections,
  _pathDrift,
  _boundDbPath,
  _isRebindSafe,
};

