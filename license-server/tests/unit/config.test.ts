import { describe, it, expect } from 'vitest';
import { parseConfig, configSchema } from '../../src/config/validation.js';

describe('config validation (fail-closed)', () => {
  it('accepts a valid license-server config', () => {
    const c = parseConfig({ PORT: '8443', DB_PATH: '/tmp/license.db', TOKEN_AUDIENCE: 'license-server', JWT_SECRET: 'a'.repeat(64) });
    expect(c.port).toBe(8443);
    expect(c.dbPath).toBe('/tmp/license.db');
  });

  it('rejects JWT_SECRET weaker than 64 hex chars', () => {
    expect(() =>
      configSchema.parse({ PORT: '8443', DB_PATH: '/tmp/license.db', TOKEN_AUDIENCE: 'license-server', JWT_SECRET: 'short' }),
    ).toThrow();
  });

  it('rejects DB_PATH that resolves to the CRM database', () => {
    expect(() =>
      configSchema.parse({ PORT: '8443', DB_PATH: 'data/blackstack-crm.db', TOKEN_AUDIENCE: 'license-server', JWT_SECRET: 'a'.repeat(64) }),
    ).toThrow();
    expect(() =>
      configSchema.parse({ PORT: '8443', DB_PATH: '../data/blackstack-crm.db', TOKEN_AUDIENCE: 'license-server', JWT_SECRET: 'a'.repeat(64) }),
    ).toThrow();
  });

  it('rejects empty JWT_SECRET', () => {
    expect(() =>
      configSchema.parse({ PORT: '8443', DB_PATH: '/tmp/license.db', TOKEN_AUDIENCE: 'license-server', JWT_SECRET: '' }),
    ).toThrow();
  });

  it('rejects JWT_SECRET that is a CRM personal secret', () => {
    expect(() =>
      configSchema.parse({ PORT: '8443', DB_PATH: '/tmp/license.db', TOKEN_AUDIENCE: 'license-server', JWT_SECRET: '1234' }),
    ).toThrow();
  });
});
