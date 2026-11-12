/**
 * Node:sqlite transaction helper.
 *
 * Mirrors the CRM project's connection.js pattern exactly:
 *
 *   const wrapped = this.db.transaction(fn);   // wrapped = transaction(fn)
 *   return wrapped(cb);                        // wrapped(cb) opens + runs + COMMIT
 *
 * So in the CRM:
 *   this.db.transaction(() => { ... });        // fn is executed inside a transaction
 *
 * The license-server has no .transaction() on DatabaseSync, so this module
 * provides it with the same semantics. The outer function takes the callback
 * and returns a wrapper; the wrapper is NOT re-invoked by the caller — the
 * caller passes the callback directly to the returned function.
 *
 * This keeps the license-server's and the CRM's database boundary
 * identical (both use BEGIN IMMEDIATE / COMMIT / ROLLBACK).
 *
 * The body callback is synchronous only (no awaits inside this block). This
 * is the same requirement the CRM's agency.service.js carries for its
 * transaction wrapper.
 */
import { DatabaseSync } from 'node:sqlite';

export interface DbContext {
  prepare: (sql: string) => any;
  run: (sql: string, ...params: any[]) => any;
}

export function transaction(db: DatabaseSync) {
  return function wrappedTransaction(fn: () => void) {
    // Synchronous execution only — no awaits inside this block.
    // The CRM supports nesting via SAVEPOINTs; replicate that.
    let _txDepth = 0;

    const open = () => {
      if (_txDepth === 0) {
        db.exec('BEGIN IMMEDIATE');
      } else {
        db.exec(`SAVEPOINT sp_${_txDepth}`);
      }
      _txDepth++;
    };

    const close = () => {
      _txDepth--;
      if (_txDepth === 0) {
        db.exec('COMMIT');
      } else {
        db.exec(`RELEASE SAVEPOINT sp_${_txDepth}`);
      }
    };

    open();
    try {
      const result = fn();
      close();
      return result;
    } catch (err) {
      close();
      throw err;
    }
  };
}
