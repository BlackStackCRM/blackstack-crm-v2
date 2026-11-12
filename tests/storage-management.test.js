import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';

import { StorageService } from '../server/services/storage.service';

function makeDb() {
  return {
    get(sql) {
      if (sql.includes('sqlite_master')) return { yes: 1 };
      if (sql.includes('COUNT(*)')) return { count: 0 };
      return null;
    },
    all() { return []; },
  };
}

describe('Storage Management metrics', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports the SQLite database and WAL as one total footprint', () => {
    vi.spyOn(fs, 'statSync').mockImplementation(file => ({
      size: String(file).endsWith('-wal') ? 253 * 1024 : 3 * 1024 * 1024,
    }));

    const metrics = new StorageService(makeDb()).sqliteMetrics();
    expect(metrics.databaseSizeBytes).toBe(3 * 1024 * 1024 + 253 * 1024);
    expect(metrics.walSizeBytes).toBe(253 * 1024);
  });

  it('verifies Supabase with a small agencies query and returns connected status', async () => {
    const builder = {
      select: vi.fn(),
      limit: vi.fn(),
      abortSignal: vi.fn().mockResolvedValue({ error: null }),
    };
    builder.select.mockReturnValue(builder);
    builder.limit.mockReturnValue(builder);
    const createClient=vi.fn(()=>({ from: vi.fn().mockReturnValue(builder) }));

    const result = await new StorageService(makeDb()).verifySupabase(createClient);
    expect(result).toMatchObject({ connected: true, message: 'Connected' });
    expect(result.checkedAt).toBeTruthy();
    expect(builder.select).toHaveBeenCalledWith('id');
    expect(builder.limit).toHaveBeenCalledWith(1);
  });

  it('reports a failed live Supabase check as disconnected', async () => {
    const builder = {
      select: vi.fn(),
      limit: vi.fn(),
      abortSignal: vi.fn().mockResolvedValue({ error: new Error('unavailable') }),
    };
    builder.select.mockReturnValue(builder);
    builder.limit.mockReturnValue(builder);
    const createClient=vi.fn(()=>({ from: vi.fn().mockReturnValue(builder) }));

    await expect(new StorageService(makeDb()).verifySupabase(createClient)).resolves.toMatchObject({
      connected: false,
      message: 'Supabase verification failed.',
    });
  });
});
