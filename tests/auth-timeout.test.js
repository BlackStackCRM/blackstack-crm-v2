/**
 * REGRESSION TESTS — Supabase request timeout (v1.2.5 auth reliability).
 *
 * Covers:
 *   1. createTimeoutFetch aborts a hung fetch after timeoutMs.
 *   2. createTimeoutFetch lets a fast fetch complete normally.
 *   3. getSupabaseClient returns a client when configured; throws when not.
 *   4. Client-side request() passes an AbortSignal to fetch.
 *   5. Client-side request() completes normally when fetch resolves quickly.
 *
 * Run: npx vitest run tests/auth-timeout.test.js
 * No real credentials, no network calls — fetch is stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTimeoutFetch, getSupabaseClient } from '../server/config/supabase';

const origFetch = globalThis.fetch;
const origEnvSnapshot = { ...process.env };
const envKeys = Object.keys(origEnvSnapshot);

beforeEach(() => {
  vi.restoreAllMocks();
  for (const key of envKeys) {
    process.env[key] = origEnvSnapshot[key];
  }
});

afterEach(() => {
  for (const key of envKeys) {
    process.env[key] = origEnvSnapshot[key];
  }
});

// ── 1 & 2: createTimeoutFetch ──
describe('createTimeoutFetch', () => {
  it('aborts a hung fetch after timeoutMs', async () => {
    let externalResolve;
    let externalReject;
    const hung = new Promise((res, rej) => { externalResolve = res; externalReject = rej; });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        externalResolve = resolve;
        externalReject = reject;
      });
    });

    const timeoutFetch = createTimeoutFetch(100);
    const promise = timeoutFetch('https://example.com');

    setTimeout(() => externalResolve(new Response('ok')), 500);

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('lets a fast fetch complete within timeoutMs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    const timeoutFetch = createTimeoutFetch(5000);
    const res = await timeoutFetch('https://example.com');
    expect(res.status).toBe(200);
  });
});

// ── 3: getSupabaseClient config guards ──
describe('getSupabaseClient config guards', () => {
  it('throws when Supabase is not configured', () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    expect(() => getSupabaseClient()).toThrow(/Supabase not configured/);
  });

  it('returns a client when configured', () => {
    process.env.SUPABASE_URL = 'https://qzxvcxywotqeqvwerofi.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'sb_publishable_TESTKEY_123';
    const client = getSupabaseClient(30000);
    expect(client).toBeDefined();
    expect(typeof client.auth.signInWithPassword).toBe('function');
  });
});

// ── 4 & 5: Client-side request() timeout ──
describe('Client API request timeout', () => {
  it('passes an AbortSignal to fetch', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const vm = await import('node:vm');

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ success: true, data: { ok: true } }),
    }));

    const source = fs.readFileSync(path.join(__dirname, '../public/js/api/client.js'), 'utf8');
    const context = {
      window: { location: { href: '', hash: '' }, dispatchEvent() {} },
      localStorage: { getItem: () => null, removeItem() {} },
      document: { cookie: '', querySelectorAll: () => [] },
      fetch: fetchMock,
      URLSearchParams,
      CustomEvent: class CustomEvent {},
      AbortController,
      setTimeout,
      clearTimeout,
      Toast: { error: vi.fn() },
      console: { warn: vi.fn() },
    };
    vm.runInNewContext(source, context, { filename: 'public/js/api/client.js' });

    await context.window.API.request('GET', '/test');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[1]).toBeDefined();
    expect(callArgs[1].signal).toBeDefined();
  });

  it('completes normally when fetch resolves quickly', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const vm = await import('node:vm');

    const source = fs.readFileSync(path.join(__dirname, '../public/js/api/client.js'), 'utf8');
    const context = {
      window: { location: { href: '', hash: '' }, dispatchEvent() {} },
      localStorage: { getItem: () => null, removeItem() {} },
      document: { cookie: '', querySelectorAll: () => [] },
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ success: true, data: { ok: true } }),
      })),
      URLSearchParams,
      CustomEvent: class CustomEvent {},
      AbortController,
      setTimeout,
      clearTimeout,
      Toast: { error: vi.fn() },
      console: { warn: vi.fn() },
    };
    vm.runInNewContext(source, context, { filename: 'public/js/api/client.js' });

    const result = await context.window.API.request('GET', '/test');
    expect(result.ok).toBe(true);
  });
});
