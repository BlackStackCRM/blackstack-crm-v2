/**
 * Unit tests for server/utils/tenantScope.js.
 *
 * assertTenantRefs previously dereferenced `refs.contact_id` without a guard,
 * so a route calling it before body validation threw a bare TypeError. It now
 * defaults the parameter to {} and tolerates null/non-object input.
 */
import { describe, it, expect, vi } from 'vitest';

const { assertTenantRef, assertTenantRefs } = await import('../server/utils/tenantScope.js');

/** Fake sqlite connection: contact C1 and org O1 belong to company K1. */
function fakeConn() {
  const rows = {
    'contacts|C1|K1': { id: 'C1' },
    'organizations|O1|K1': { id: 'O1' },
  };
  return {
    get: vi.fn((sql, params) => {
      const [id, companyId] = params;
      return rows[`${sql.includes('contacts') ? 'contacts' : 'organizations'}|${id}|${companyId}`] || undefined;
    }),
  };
}

describe('assertTenantRef', () => {
  it('passes silently for a ref that exists in the tenant', () => {
    const conn = fakeConn();
    expect(() => assertTenantRef(conn, 'K1', 'contacts', 'C1')).not.toThrow();
    expect(conn.get).toHaveBeenCalledTimes(1);
  });

  it('throws ValidationError (code VALIDATION_ERROR) for a ref owned by another tenant', () => {
    const conn = fakeConn();
    let err;
    try { assertTenantRef(conn, 'K2', 'contacts', 'C1'); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/does not exist in your company/);
  });

  it('allows null / undefined / empty-string ids without querying', () => {
    const conn = fakeConn();
    for (const id of [null, undefined, '']) {
      expect(() => assertTenantRef(conn, 'K1', 'contacts', id)).not.toThrow();
    }
    expect(conn.get).not.toHaveBeenCalled();
  });

  it('rejects an unknown table name with a plain Error', () => {
    const conn = fakeConn();
    expect(() => assertTenantRef(conn, 'K1', 'deals', 'D1')).toThrow(/Unknown table deals/);
  });
});

describe('assertTenantRefs', () => {
  it('validates both contact and organization refs', () => {
    const conn = fakeConn();
    expect(() => assertTenantRefs(conn, 'K1', { contact_id: 'C1', organization_id: 'O1' })).not.toThrow();
    expect(conn.get).toHaveBeenCalledTimes(2);
  });

  it('does not throw when refs is undefined (default parameter)', () => {
    const conn = fakeConn();
    expect(() => assertTenantRefs(conn, 'K1')).not.toThrow();
    expect(conn.get).not.toHaveBeenCalled();
  });

  it('does not throw when refs is null', () => {
    const conn = fakeConn();
    expect(() => assertTenantRefs(conn, 'K1', null)).not.toThrow();
  });

  it('does not throw when refs is a non-object primitive', () => {
    const conn = fakeConn();
    expect(() => assertTenantRefs(conn, 'K1', 'garbage')).not.toThrow();
  });

  it('treats missing keys as absent refs rather than crashing', () => {
    const conn = fakeConn();
    expect(() => assertTenantRefs(conn, 'K1', {})).not.toThrow();
  });

  it('still rejects a cross-tenant contact supplied in a valid refs object', () => {
    const conn = fakeConn();
    let err;
    try { assertTenantRefs(conn, 'K2', { contact_id: 'C1' }); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).toBe('VALIDATION_ERROR');
  });
});
