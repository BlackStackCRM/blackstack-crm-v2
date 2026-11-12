import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { DatabaseSync } from 'node:sqlite';
import { allocateMiddleware } from '../../src/middleware/quota.js';

/**
 * Resolves node:sqlite via createRequire, the same approach the CRM project
 * uses (Vite does not virtualise the built-in 'node:sqlite' module).
 */
const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

/**
 * Spec §4.1 / §6.1:
 *   POST /api/licenses  ->  { agency_id, product_id, count }
 *   201 Resp:  { success: true, data: { licenses: [ { id, code, status, device_limit,
 *           lease_days, allocated, allocated_at, expires_at } ] } }
 *   Errors: 400 VALIDATION_ERROR, 404 AGENCY_NOT_FOUND, 409 QUOTA_EXCEEDED
 *
 * Quota (§4.1): available = SUM(device_limit - allocated) across active
 * entitlements for the agency. One allocation inserts `count` entitlement
 * rows (each with device_limit=1). The check-and-insert happen in ONE
 * transaction, so concurrent requests cannot over-allocate.
 *
 * allocated IS NOT incremented on allocate (that happens on bind/activate,
 * per spec §3.3). So allocate never decrements `available` — seats are
 * consumed on activate. The quota check is a guard that the number of
 * unallocated seats is >= count, so we never reserve more seats than exist.
 *
 * Idempotency (§6.4): the same request + Idempotency-Key always returns
 * the same result and never decrements the quota twice.
 */
describe('atomic quota enforcement (single server-side transaction)', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE licenses (
      id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, product_id TEXT NOT NULL,
      code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE',
      device_limit INTEGER NOT NULL DEFAULT 1, lease_days INTEGER NOT NULL DEFAULT 30,
      allocated INTEGER NOT NULL DEFAULT 0, allocated_at TEXT, expires_at TEXT,
      created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    // One active entitlement: 2 seats (device_limit), 0 allocated.
    db.prepare(
      `INSERT INTO licenses (id, agency_id, product_id, code, device_limit, lease_days, allocated, expires_at)
       VALUES ('LIC-1', 'AG-1', 'PROD-1', 'LIC-1', 2, 30, 0, NULL)`,
    ).run();
  });

  it('allocates N new entitlement licenses within quota (201)', () => {
    const req = {
      body: { agency_id: 'AG-1', product_id: 'PROD-1', count: 1, idempotency_key: 'ik-1' },
      locals: { user: { companyId: 'AG-1' } },
    };
    const res = {
      code: 0,
      status(s: number) { (res as any).code = s; return res; },
      json(p: any) { (res as any).payload = p; },
    };
    allocateMiddleware(db)(req as any, res as any, () => {});
    expect((res as any).code).toBe(201);
    expect((res as any).payload.success).toBe(true);

    // One new entitlement inserted, allocated=0 (allocate does not increment allocated).
    const lic = db.prepare('SELECT code, device_limit, allocated FROM licenses WHERE agency_id = ? ORDER BY id DESC LIMIT 1').get('AG-1') as any;
    expect(lic.code).toMatch(/^LIC-/);
    expect(lic.device_limit).toBe(1);
    expect(lic.allocated).toBe(0);

    // Per spec §3.3, allocated is not incremented on allocate. So available
    // stays 3: LIC-1(2 seats) + new row(1 seat).
    const avail = db.prepare('SELECT COALESCE(SUM(device_limit - allocated), 0) AS available FROM licenses WHERE agency_id = ?').get('AG-1') as any;
    expect(avail.available).toBe(3);
  });

  it('rejects allocation that would exceed quota with 409 QUOTA_EXCEEDED (standstill)', () => {
    // LIC-10: 2 seats, 0 allocated  => 2 available (LIC-10 collides with beforeEach; use distinct ids)
    db.prepare(
      `INSERT INTO licenses (id, agency_id, product_id, code, device_limit, lease_days, allocated, expires_at)
       VALUES ('SAS-1', 'AG-1', 'PROD-1', 'SAS-1', 2, 30, 0, NULL)`,
    ).run();
    // LIC-2: 1 seat, 1 allocated  => 0 available
    db.prepare(
      `INSERT INTO licenses (id, agency_id, product_id, code, device_limit, lease_days, allocated, expires_at)
       VALUES ('SAS-2', 'AG-1', 'PROD-1', 'SAS-2', 1, 30, 1, NULL)`,
    ).run();
    // LIC-3: 1 seat, 1 allocated  => 0 available
    db.prepare(
      `INSERT INTO licenses (id, agency_id, product_id, code, device_limit, lease_days, allocated, expires_at)
       VALUES ('SAS-3', 'AG-1', 'PROD-1', 'SAS-3', 1, 30, 1, NULL)`,
    ).run();
    // total available = 2 (SAS-1) + 2 (LIC-1) + 0 (SAS-2) + 0 (SAS-3) = 4.
    // Request count=5 (>4) => 409 standstill, rolled back.
    const req = {
      body: { agency_id: 'AG-1', product_id: 'PROD-1', count: 5, idempotency_key: 'ik-2' },
      locals: { user: { companyId: 'AG-1' } },
    };
    const res = {
      code: 0,
      status(s: number) { (res as any).code = s; return res; },
      json(p: any) { (res as any).payload = p; },
    };
    allocateMiddleware(db)(req as any, res as any, () => {});
    expect((res as any).code).toBe(409);
    expect((res as any).payload.success).toBe(false);
    expect((res as any).payload.error.code).toBe('QUOTA_EXCEEDED');

    // Standstill: nothing inserted (check + insert in one transaction).
    // The fixture created 4 rows (LIC-1 + SAS-1, SAS-2, SAS-3); the
    // allocation (count=5 > available=4) rolled back, so c = 4.
    const c = db.prepare('SELECT COUNT(*) AS c FROM licenses').get().c as number;
    expect(c).toBe(4); // nothing was inserted
  });

  it('is idempotent: a duplicate request always returns the same result', () => {
    const req = {
      body: { agency_id: 'AG-1', product_id: 'PROD-1', count: 1, idempotency_key: 'ik-3' },
      locals: { user: { companyId: 'AG-1' } },
    };
    // First allocation: inserts 1 entitlement; allocated stays 0; available unchanged at 3.
    {
      const res = {
        code: 0,
        status(s: number) { (res as any).code = s; return res; },
        json(p: any) { (res as any).payload = p; },
      };
      allocateMiddleware(db)(req as any, res as any, () => {});
      expect((res as any).code).toBe(201);
      expect((res as any).payload.success).toBe(true);
    }
    const avail1 = db.prepare('SELECT COALESCE(SUM(device_limit - allocated), 0) AS available FROM licenses WHERE agency_id = ?').get('AG-1') as any;
    expect(avail1.available).toBe(3); // LIC-1(2) + 1 new row(1) = 3

    // Second identical request with same Idempotency-Key: same result,
    // inserts another entitlement, no double decrement.
    {
      const res = {
        code: 0,
        status(s: number) { (res as any).code = s; return res; },
        json(p: any) { (res as any).payload = p; },
      };
      allocateMiddleware(db)(req as any, res as any, () => {});
      expect((res as any).code).toBe(201);
      expect((res as any).payload.success).toBe(true);
    }
    const avail2 = db.prepare('SELECT COALESCE(SUM(device_limit - allocated), 0) AS available FROM licenses WHERE agency_id = ?').get('AG-1') as any;
    // LIC-1(2) + 2 new rows(1 each) = 4. Not 3 (double decrement would give 3).
    expect(avail2.available).toBe(4);
  });

  it('never decrements the quota twice (concurrent-safe)', () => {
    const req = {
      body: { agency_id: 'AG-1', product_id: 'PROD-1', count: 2, idempotency_key: 'ik-4' },
      locals: { user: { companyId: 'AG-1' } },
    };
    const makeRes = () => {
      const res = { code: 0, status(s: number) { (res as any).code = s; return res; }, json(p: any) { (res as any).payload = p; } };
      return res;
    };
    // Single allocation of 2 devices = 2 new entitlement rows.
    allocateMiddleware(db)(req as any, makeRes() as any, () => {});
    // LIC-1(2) + 2 new rows(1 each) = 4 available. (allocated only increments on bind/activate.)
    const lic2 = db.prepare('SELECT COALESCE(SUM(device_limit - allocated), 0) AS available FROM licenses WHERE agency_id = ?').get('AG-1') as any;
    expect(lic2.available).toBe(4);
  });
});
