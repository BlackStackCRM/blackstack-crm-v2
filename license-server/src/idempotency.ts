/**
 * Idempotency persistence for the license server.
 *
 * Records live in the `idempotency` table of license.db, so they survive
 * server restarts and are shared across multiple server instances.
 */

import type { DbContext } from './connection.js';

export interface IdempotencyRecord {
  key: string;
  /** Fingerprint of the request payload (sorted-JSON canonical form). */
  fingerprint: string;
  status: number;
  /** JSON-serialized response body (verbatim, returned as-is on repeat). */
  body: unknown;
  /** License IDs created by the original successful request. */
  createdLicenseIds: string[];
  createdAt: string;
}

export interface IdempotencyTable {
  /** Open database handle (must already be migrated + initialized). */
  db: DbContext;
}

/** Schema: idempotency table for persistent idempotency records.
 *
 * NOTE: node:sqlite (built-in) rejects `datetime('now')` as a column DEFAULT
 * — it throws `ERR_SQLITE_ERROR: default value of column ... is not constant`.
 * Every DEFAULT in a CREATE TABLE executed by node:sqlite must use
 * `CURRENT_TIMESTAMP` instead. This is a hard requirement of the node:sqlite
 * API, not a style preference. */
export function createIdempotencyTable(db: DbContext): void {
  db.exec(`CREATE TABLE IF NOT EXISTS idempotency (
    key TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    status INTEGER NOT NULL,
    body_json TEXT NOT NULL,
    created_license_ids TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  );`);
}

/** Fingerprint of the normalized allocation payload. The fixed tuple order
 * is independent of object property order and JSON escaping prevents field
 * boundary collisions. */
export function computeFingerprint(payload: { agency_id: string; product_id: string; count: number }): string {
  // A JSON tuple preserves field order and escapes embedded delimiters, so
  // identifiers containing newlines cannot collide with adjacent fields.
  return JSON.stringify([payload.agency_id, payload.product_id, payload.count]);
}

export function getRecord(db: DbContext, key: string): IdempotencyRecord | undefined {
  const row = db.prepare('SELECT key, fingerprint, status, body_json, created_license_ids, created_at FROM idempotency WHERE key = ?').get(key) as
    | { key: string; fingerprint: string; status: number; body_json: string; created_license_ids: string; created_at: string }
    | undefined;
  if (!row) return undefined;
  return {
    key: row.key,
    fingerprint: row.fingerprint,
    status: row.status,
    body: JSON.parse(row.body_json),
    createdLicenseIds: JSON.parse(row.created_license_ids),
    createdAt: row.created_at,
  };
}

export function setRecord(db: DbContext, record: IdempotencyRecord): void {
  db.prepare(
    `INSERT INTO idempotency (key, fingerprint, status, body_json, created_license_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       fingerprint = excluded.fingerprint,
       status = excluded.status,
       body_json = excluded.body_json,
       created_license_ids = excluded.created_license_ids,
       created_at = excluded.created_at`,
  ).run(
    record.key,
    record.fingerprint,
    record.status,
    JSON.stringify(record.body),
    JSON.stringify(record.createdLicenseIds),
    record.createdAt,
  );
}

export function deleteRecord(db: DbContext, key: string): void {
  db.prepare('DELETE FROM idempotency WHERE key = ?').run(key);
}
