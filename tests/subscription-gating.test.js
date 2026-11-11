import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const { createCheckSubscriptionStatus, isSubscriptionBypassPath } = await import('../server/middleware/subscription.js');

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
  };
}

function clientHarness(fetchImpl, startHash = '#deals') {
  const elements = new Map();
  const appended = [];
  const window = {
    location: { hash: startHash, href: '' },
    dispatchEvent: vi.fn(),
  };
  const document = {
    body: { appendChild(node) { appended.push(node); elements.set(node.id, node); } },
    getElementById: (id) => elements.get(id) || null,
    createElement() {
      const button = { addEventListener: vi.fn((name, cb) => { button[name] = cb; }) };
      return {
        style: {}, id: '', innerHTML: '',
        setAttribute: vi.fn(),
        querySelector: () => button,
      };
    },
    cookie: '', querySelectorAll: () => [],
  };
  const consoleWarn = vi.fn();
  const context = {
    window, document, localStorage: { getItem: () => null, removeItem: vi.fn() },
    fetch: fetchImpl, URLSearchParams, CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    Toast: { error: vi.fn() }, console: { warn: consoleWarn, info: vi.fn() },
  };
  const source = fs.readFileSync(path.resolve('public/js/api/client.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'public/js/api/client.js' });
  // Browser globals are shared between window and the global scope; mirror
  // that behavior in Node's isolated VM context for the recovery helper.
  context.API = window.API;
  return { ...context, appended, consoleWarn, API: window.API, gate: window.SubscriptionGate };
}

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => payload };
}

describe('subscription gating and payment activation', () => {
  afterEach(() => vi.clearAllMocks());

  it('blocks a signed-in company with no subscription and identifies NONE', () => {
    const checkSubscriptionStatus = createCheckSubscriptionStatus(() => ({ get: vi.fn(() => null) }));
    const res = responseRecorder();
    const next = vi.fn();
    checkSubscriptionStatus({ user: { companyId: 'company-a' } }, res, next);
    expect(res.statusCode).toBe(403);
    expect(res.payload).toMatchObject({ error: 'SUBSCRIPTION_INACTIVE', reason: 'NONE' });
    expect(next).not.toHaveBeenCalled();
  });

  it('blocks an expired subscription and keeps only auth, wallet and webhook recovery paths open', () => {
    const checkSubscriptionStatus = createCheckSubscriptionStatus(() => ({
      get: vi.fn((sql) => sql.includes('FROM subscriptions')
        ? { status: 'EXPIRED', end_date: '2025-01-01T23:59:59.999Z' }
        : { expired: 1 }),
    }));
    const res = responseRecorder();
    checkSubscriptionStatus({ user: { companyId: 'company-a' } }, res, vi.fn());
    expect(res.statusCode).toBe(403);
    expect(res.payload.reason).toBe('EXPIRED');
    expect(isSubscriptionBypassPath('/auth/login')).toBe(true);
    expect(isSubscriptionBypassPath('/wallet/subscription')).toBe(true);
    expect(isSubscriptionBypassPath('/payments/webhook')).toBe(true);
    expect(isSubscriptionBypassPath('/payments')).toBe(false);
    expect(isSubscriptionBypassPath('/subscriptions')).toBe(false);
  });

  it('allows an ACTIVE subscription through when its UTC end date has not passed', () => {
    const next = vi.fn();
    const checkSubscriptionStatus = createCheckSubscriptionStatus(() => ({
      get: vi.fn((sql) => sql.includes('FROM subscriptions')
        ? { status: 'ACTIVE', end_date: '2099-12-31T23:59:59.999Z' }
        : { valid: 1 }),
    }));
    checkSubscriptionStatus({ user: { companyId: 'company-a' } }, responseRecorder(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('shows one blocking modal for simultaneous CRM failures and closes it after recovery', async () => {
    const responses = [
      jsonResponse(403, { error: 'SUBSCRIPTION_INACTIVE', reason: 'NONE', message: 'inactive' }),
      jsonResponse(403, { error: 'SUBSCRIPTION_INACTIVE', reason: 'NONE', message: 'inactive' }),
      jsonResponse(200, { success: true, data: { subscription: { status: 'ACTIVE', endDate: '2099-12-31T23:59:59.999Z' } } }),
    ];
    const client = clientHarness(async () => responses.shift());
    await Promise.all([
      expect(client.API.get('/deals')).rejects.toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' }),
      expect(client.API.get('/contacts')).rejects.toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' }),
    ]);
    expect(client.appended).toHaveLength(1);
    expect(client.appended[0].innerHTML).toContain('Go to Wallet');
    expect(client.gate.isOpen).toBe(true);
    const button = client.appended[0].querySelector();
    button.click();
    expect(client.window.location.hash).toBe('#wallet');
    const recovered = await client.gate.recover();
    expect(recovered, JSON.stringify(client.consoleWarn.mock.calls)).toBe(true);
    expect(client.gate.isOpen).toBe(false);
    expect(client.window.location.hash).toBe('#deals');
  });

  it('shows the blocking modal for an expired-subscription response too', async () => {
    const client = clientHarness(async () => jsonResponse(403, {
      error: 'SUBSCRIPTION_INACTIVE', reason: 'EXPIRED', message: 'inactive',
    }));
    await expect(client.API.get('/contacts')).rejects.toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' });
    expect(client.gate.isOpen).toBe(true);
    expect(client.appended).toHaveLength(1);
    expect(client.appended[0].innerHTML).toContain('Your subscription is not active.');
  });

});
