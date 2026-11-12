import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { DatabaseSync } from 'node:sqlite';
const require_ = createRequire(import.meta.url);
const { DatabaseSync: RealDatabaseSync } = require_('node:sqlite');
import { allocateMiddleware } from '../../src/middleware/quota.js';
import {
  getRecord,
  setRecord,
  deleteRecord,
  computeFingerprint,
  createIdempotencyTable,
} from '../../src/idempotency.js';

/** Lightweight in-memory DB wrapper so tests can assert on record contents
 *  without touching any file. */
class RecordDb {
  public db: DatabaseSync;
  constructor() {
    this.db = new RealDatabaseSync(':memory:');
  }
  public exec(sql: string): void {
    this.db.exec(sql);
  }
}

const licensesTable = `
  CREATE TABLE licenses (
    id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, product_id TEXT NOT NULL,
    code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE',
    device_limit INTEGER NOT NULL DEFAULT 1, lease_days INTEGER NOT NULL DEFAULT 30,
    allocated INTEGER NOT NULL DEFAULT 0, allocated_at TEXT, expires_at TEXT,
    created_by TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  );`;

describe('Idempotency key (§6.4) — persisted', () => {
  let resetDb: RecordDb;

  beforeEach(() => {
    resetDb = new RecordDb();
    createIdempotencyTable(resetDb.db);
    deleteRecord(resetDb.db, 'ik-any'); // reset in-memory store between tests
  });

  it('returns the stored result verbatim on repeat with the same key + payload (no duplicate rows)', () => {
    const db = new RecordDb();
    db.exec(licensesTable);
    createIdempotencyTable(db.db);
    db.db.prepare(
      `INSERT INTO licenses (id, agency_id, product_id, code, device_limit, lease_days, allocated, expires_at)
       VALUES ('LIC-1', 'AG-1', 'PROD-1', 'LIC-1', 2, 30, 0, NULL)`,
    ).run();

    const req = {
      headers: { 'idempotency-key': 'ik-5' },
      body: { agency_id: 'AG-1', product_id: 'PROD-1', count: 1 },
      locals: { user: { companyId: 'AG-1' } },
    };
    const res = {
      code: 0,
      status(s: number) { (res as any).code = s; return res; },
      json(p: any) { (res as any).payload = p; },
    };

    // First request: allocate 1, store record.
    allocateMiddleware(db.db)(req as any, res as any, () => {});
    expect((res as any).code).toBe(201);
    expect((res as any).payload.success).toBe(true);
    expect(db.db.prepare('SELECT COUNT(*) AS c FROM licenses').get().c).toBe(2); // LIC-1 + 1 new = 2

    // Second request: same key + same payload → returns stored 201 verbatim,
    // no new row, no quota re-check.
    allocateMiddleware(db.db)(req as any, res as any, () => {});
    expect((res as any).code).toBe(201);
    expect((res as any).payload.success).toBe(true);
    expect(db.db.prepare('SELECT COUNT(*) AS c FROM licenses').get().c).toBe(2); // no duplicate
  });

  it('returns 409 IDEMPOTENCY_KEY_REUSED on same key + different payload', () => {
    const db = new RecordDb();
    db.exec(licensesTable);
    createIdempotencyTable(db.db);
    db.db.prepare(
      `INSERT INTO licenses (id, agency_id, product_id, code, device_limit, lease_days, allocated, expires_at)
       VALUES ('LIC-1', 'AG-1', 'PROD-1', 'LIC-1', 2, 30, 0, NULL)`,
    ).run();

    const req1 = {
      headers: { 'idempotency-key': 'ik-6' },
      body: { agency_id: 'AG-1', product_id: 'PROD-1', count: 1 },
      locals: { user: { companyId: 'AG-1' } },
    };
    const res1 = { code: 0, status(s: number) { (res1 as any).code = s; return res1; }, json(p: any) { (res1 as any).payload = p; } };
    allocateMiddleware(db.db)(req1 as any, res1 as any, () => {});
    expect((res1 as any).code).toBe(201);

    // Same key, different payload → 409, no new allocation.
    const req2 = {
      headers: { 'idempotency-key': 'ik-6' },
      body: { agency_id: 'AG-1', product_id: 'PROD-1', count: 2 }, // different count
      locals: { user: { companyId: 'AG-1' } },
    };
    const res2 = { code: 0, status(s: number) { (res2 as any).code = s; return res2; }, json(p: any) { (res2 as any).payload = p; } };
    allocateMiddleware(db.db)(req2 as any, res2 as any, () => {});
    expect((res2 as any).code).toBe(409);
    expect((res2 as any).payload.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // No new allocation: count stays at 2 (LIC-1 pre-existing + 1 allocated).
    expect(db.db.prepare('SELECT COUNT(*) AS c FROM licenses').get().c).toBe(2);
  });

  it('is idempotent: duplicate request returns same result, same status, same body', () => {
    const db = new RecordDb();
    db.exec(licensesTable);
    createIdempotencyTable(db.db);
    db.db.prepare(
      `INSERT INTO licenses (id, agency_id, product_id, code, device_limit, lease_days, allocated, expires_at)
       VALUES ('LIC-1', 'AG-1', 'PROD-1', 'LIC-1', 2, 30, 0, NULL)`,
    ).run();

    const req = {
      headers: { 'idempotency-key': 'ik-7' },
      body: { agency_id: 'AG-1', product_id: 'PROD-1', count: 1 },
      locals: { user: { companyId: 'AG-1' } },
    };

    const first = { code: 0, status(s: number) { (first as any).code = s; return first; }, json(p: any) { (first as any).payload = p; } };
    allocateMiddleware(db.db)(req as any, first as any, () => {});
    expect((first as any).code).toBe(201);

    const second = { code: 0, status(s: number) { (second as any).code = s; return second; }, json(p: any) { (second as any).payload = p; } };
    allocateMiddleware(db.db)(req as any, second as any, () => {});
    expect((second as any).code).toBe(201);

    // Stored response is returned verbatim — same body, exact deep-equal.
    expect((second as any).payload).toEqual((first as any).payload);
  });

  it('rolls back the license insert if idempotency persistence fails', () => {
    const db = new RecordDb();
    db.exec(licensesTable);
    createIdempotencyTable(db.db);
    db.db.prepare(
      `INSERT INTO licenses (id, agency_id, product_id, code, device_limit, lease_days, allocated, expires_at)
       VALUES ('LIC-1', 'AG-1', 'PROD-1', 'LIC-1', 2, 30, 0, NULL)`,
    ).run();
    db.db.exec(`CREATE TRIGGER fail_idempotency BEFORE INSERT ON idempotency
      BEGIN SELECT RAISE(ABORT, 'forced idempotency failure'); END;`);

    const req = {
      headers: { 'idempotency-key': 'ik-rollback' },
      body: { agency_id: 'AG-1', product_id: 'PROD-1', count: 1 },
      locals: { user: { companyId: 'AG-1' } },
    };
    const res = {
      code: 0,
      status(s: number) { (res as any).code = s; return res; },
      json(p: any) { (res as any).payload = p; },
    };

    expect(() => allocateMiddleware(db.db)(req as any, res as any, () => {})).toThrow('forced idempotency failure');
    expect(db.db.prepare('SELECT COUNT(*) AS c FROM licenses').get().c).toBe(1);
    expect(getRecord(db.db, 'ik-rollback')).toBeUndefined();
    db.db.close();
  });

  it('returns 409 when a request fails inside the transaction (no partial record)', () => {
    const db = new RecordDb();
    db.exec(licensesTable);
    createIdempotencyTable(db.db);
    db.db.prepare(
      `INSERT INTO licenses (id, agency_id, product_id, code, device_limit, lease_days, allocated, expires_at)
       VALUES ('SAS-1', 'AG-1', 'PROD-1', 'SAS-1', 1, 30, 0, NULL)`,
    ).run();
    // Available = 1 (SAS-1), request count=2 → 409, rolled back, no record written.
    const req = {
      headers: { 'idempotency-key': 'ik-8' },
      body: { agency_id: 'AG-1', product_id: 'PROD-1', count: 2 },
      locals: { user: { companyId: 'AG-1' } },
    };
    const res = {
      code: 0,
      status(s: number) { (res as any).code = s; return res; },
      json(p: any) { (res as any).payload = p; },
    };
    allocateMiddleware(db.db)(req as any, res as any, () => {});
    expect((res as any).code).toBe(409);
    expect((res as any).payload.error.code).toBe('QUOTA_EXCEEDED');
    // No idempotency record written on a quota failure (retry is safe).
    expect(getRecord(db.db, 'ik-8')).toBeUndefined();
  });
});

describe('Idempotency store (src/idempotency.ts)', () => {
  it('computeFingerprint: equivalent payloads produce the same fingerprint', () => {
    const a = { agency_id: 'AG-1', product_id: 'PROD-1', count: 1 };
    const b = { agency_id: 'AG-1', product_id: 'PROD-1', count: 1 };
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
    expect(typeof computeFingerprint(a)).toBe('string');
    expect(computeFingerprint(a).length).toBeGreaterThan(0);
  });

  it('normalizes field order and distinguishes identifiers containing newlines', () => {
    const a = { agency_id: 'A\nB', product_id: 'C', count: 1 };
    const b = { product_id: 'C', count: 1, agency_id: 'A\nB' };
    const collision = { agency_id: 'A', product_id: 'B\nC', count: 1 };
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
    expect(computeFingerprint(a)).not.toBe(computeFingerprint(collision));
  });

  it('getRecord / setRecord / deleteRecord: lifecycle of a record', () => {
    const db = new RecordDb();
    createIdempotencyTable(db.db);
    const rec = { key: 'ik-lifecycle', fingerprint: 'fp', status: 201, body: {}, createdLicenseIds: [], createdAt: 'now' };
    expect(getRecord(db.db, 'ik-lifecycle')).toBeUndefined();
    setRecord(db.db, rec);
    expect(getRecord(db.db, 'ik-lifecycle')).toEqual(rec);
    deleteRecord(db.db, 'ik-lifecycle');
    expect(getRecord(db.db, 'ik-lifecycle')).toBeUndefined();
  });
});
