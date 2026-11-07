/**
 * Unit tests for server/utils/helpers.js — pagination + request helpers.
 *
 * Covers:
 *  - getPagination limit clamping (maxLimit enforced, negatives rejected)
 *  - page/offset fallbacks (page -> offset, explicit offset wins)
 *  - NaN / non-numeric handling (falls back to defaults, never NaN in SQL)
 *  - asyncHandler forwarding rejections to next()
 */
import { describe, it, expect, vi } from 'vitest';
import { asyncHandler, getPagination, getUserId } from '../server/utils/helpers.js';

/** Build a fake Express request with the given query params. */
function reqWith(query) {
  return { query, user: { userId: 'u_123' } };
}

describe('getPagination — limit clamping', () => {
  it('uses the default limit when no query params are present', () => {
    const { limit, offset, page } = getPagination(reqWith({}));
    expect(limit).toBe(20);
    expect(page).toBe(1);
    expect(offset).toBe(0);
  });

  it('uses the default limit when only page is supplied', () => {
    const { limit, offset } = getPagination(reqWith({ page: '3' }));
    expect(limit).toBe(20);
    // page 3 with default limit 20 -> offset 40
    expect(offset).toBe(40);
    expect(offset).toBe((3 - 1) * 20);
  });

  it('honors a limit within bounds', () => {
    expect(getPagination(reqWith({ limit: '50' })).limit).toBe(50);
    expect(getPagination(reqWith({ pageSize: '10' })).limit).toBe(10);
  });

  it('clamps limit to maxLimit', () => {
    const { limit } = getPagination(reqWith({ limit: '500' }), { limit: 20, maxLimit: 100 });
    expect(limit).toBe(100);
  });

  it('uses the custom default and maxLimit from the defaults argument', () => {
    const { limit } = getPagination(reqWith({ limit: '999' }), { limit: 5, maxLimit: 10 });
    expect(limit).toBe(10);
  });

  it('defaults maxLimit to 100 when defaults omit it', () => {
    const { limit } = getPagination(reqWith({ limit: '250' }), { limit: 20 });
    expect(limit).toBe(100);
  });

  it('rejects a negative limit', () => {
    const { limit } = getPagination(reqWith({ limit: '-5' }));
    expect(limit).toBe(1);
  });

  it('clamps a negative limit to the positive range when explicit', () => {
    const { limit } = getPagination(reqWith({ limit: '-5' }), { limit: 20, maxLimit: 100 });
    expect(limit).toBe(1);
  });

  it('never returns a zero limit', () => {
    // parseInt('0') is falsy, so it falls through to the default rather than 0.
    const { limit } = getPagination(reqWith({ limit: '0' }));
    expect(limit).toBe(20);
    expect(limit).toBeGreaterThan(0);
  });
});

describe('getPagination — page/offset fallbacks', () => {
  it('derives offset from page when offset is not supplied', () => {
    const { offset } = getPagination(reqWith({ page: '5', limit: '25' }));
    expect(offset).toBe((5 - 1) * 25);
    expect(offset).toBe(100);
  });

  it('an explicit offset wins over the page-derived offset', () => {
    const { offset } = getPagination(reqWith({ page: '5', offset: '7' }));
    expect(offset).toBe(7);
  });

  it('treats page 0 as page 1', () => {
    const { page, offset } = getPagination(reqWith({ page: '0' }));
    expect(page).toBe(1);
    expect(offset).toBe(0);
  });

  it('treats a negative page as page 1', () => {
    const { page, offset } = getPagination(reqWith({ page: '-2' }));
    expect(page).toBe(1);
    expect(offset).toBe(0);
  });

  it('treats a negative offset as 0 (page-derived)', () => {
    const { offset } = getPagination(reqWith({ offset: '-10' }));
    expect(offset).toBe(0);
  });
});

describe('getPagination — NaN / garbage handling', () => {
  it('falls back to defaults on non-numeric limit', () => {
    const { limit } = getPagination(reqWith({ limit: 'abc' }));
    expect(limit).toBe(20);
    expect(Number.isFinite(limit)).toBe(true);
  });

  it('falls back to page 1 on non-numeric page', () => {
    const { page, offset } = getPagination(reqWith({ page: 'not-a-page' }));
    expect(page).toBe(1);
    expect(offset).toBe(0);
  });

  it('falls back on empty-string params', () => {
    const { limit, page, offset } = getPagination(reqWith({ limit: '', page: '', offset: '' }));
    expect(limit).toBe(20);
    expect(page).toBe(1);
    expect(offset).toBe(0);
  });

  it('never emits NaN in any pagination field across garbage input', () => {
    const result = getPagination(reqWith({ limit: 'x', page: 'y', offset: 'z' }));
    for (const value of [result.limit, result.page, result.offset]) {
      expect(Number.isNaN(value)).toBe(false);
    }
  });

  it('handles garbage plus maxLimit clamp together', () => {
    const result = getPagination(reqWith({ limit: 'abc' }), { limit: 20, maxLimit: 100 });
    expect(result.limit).toBe(20);
    expect(Number.isNaN(result.offset)).toBe(false);
  });
});

describe('asyncHandler', () => {
  it('resolves normally and does not call next', async () => {
    const next = vi.fn();
    const handler = asyncHandler(async () => 'ok');
    await handler({}, {}, next);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards a rejected promise to next(err)', async () => {
    const next = vi.fn();
    const err = new Error('boom');
    const handler = asyncHandler(async () => { throw err; });
    await handler({}, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(err);
  });

  it('passes req/res through to the wrapped function', async () => {
    const seen = {};
    const handler = asyncHandler(async (req) => { seen.req = req; });
    const fakeReq = { query: {} };
    await handler(fakeReq, {}, vi.fn());
    expect(seen.req).toBe(fakeReq);
  });
});

describe('getUserId', () => {
  it('returns userId from req.user', () => {
    expect(getUserId({ user: { userId: 'u_1' } })).toBe('u_1');
  });

  it('returns undefined when req.user is missing', () => {
    expect(getUserId({})).toBeUndefined();
  });
});
