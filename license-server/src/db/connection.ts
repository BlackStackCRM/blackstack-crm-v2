/**
 * Connection adapter over node:sqlite (built-in; no native compilation).
 * Preserves the database handle API the application was written against
 * (.run/.get/.all/pragma/transaction), mirroring the CRM's
 * server/database/connection.js exactly.
 *
 * node:sqlite's DatabaseSync exposes only: exec(), prepare(), close(),
 * isOpen(), isTransaction(), limits(). It has NO pragma() method, so the
 * adapter maps pragma() -> db.exec(`PRAGMA ${source}`).
 */
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface DbContext {
  prepare: (sql: string) => any;
  run: (sql: string, ...params: any[]) => any;
  get: (sql: string, ...params: any[]) => any;
  all: (sql: string, ...params: any[]) => any;
  pragma: (source: string) => void;
  transaction: (fn: () => void) => () => void;
  close: () => void;
}

export interface ConnectionRecord {
  db: DbContext;
  resolvedPath: string;
}

const _OPEN_CONNECTIONS: ConnectionRecord[] = [];
const _LIVE = new Set<ConnectionRecord>();

function wrapStatement(stmt) {
  return {
    run(...args) {
      return stmt.run(...args);
    },
    get(...args) {
      return stmt.get(...args);
    },
    all(...args) {
      return stmt.all(...args);
    },
  };
}

function normalizeArgs(args) {
  let list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  return list.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'function') return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    return v;
  });
}

export class ConnectionAdapter implements DbContext {
  private _db: DatabaseSync;
  private _txDepth = 0;

  constructor(db: DatabaseSync) {
    this._db = db;
  }

  prepare(sql: string) {
    return wrapStatement(this._db.prepare(sql));
  }

  exec(sql: string): void {
    return this._db.exec(sql);
  }

  run(sql: string, ...args: any[]) {
    return this._db.prepare(sql).run(...normalizeArgs(args));
  }

  get(sql: string, ...args: any[]): any {
    return this._db.prepare(sql).get(...normalizeArgs(args));
  }

  all(sql: string, ...args: any[]): any[] {
    return this._db.prepare(sql).all(...normalizeArgs(args));
  }

  pragma(source: string): void {
    return this._db.exec(`PRAGMA ${source}`);
  }

  transaction(fn: () => void) {
    const wrapped = () => {
      if (this._txDepth === 0) {
        this._db.exec('BEGIN IMMEDIATE');
      } else {
        this._db.exec(`SAVEPOINT sp_${this._txDepth}`);
      }
      this._txDepth++;
      try {
        const result = fn();
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

  close(): void {
    return this._db.close();
  }
}

export function connect(dbPath: string): DbContext {
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new ConnectionAdapter(new DatabaseSync(dbPath));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const rec = { db, resolvedPath: path.resolve(dbPath) };
  _OPEN_CONNECTIONS.push(rec);
  _LIVE.add(rec);
  return db;
}

export function close(ctx: DbContext): void {
  if (ctx) {
    const rec = _OPEN_CONNECTIONS.find((r) => r.db === ctx);
    if (rec) {
      _LIVE.delete(rec);
      rec.db.close();
    }
  }
}
