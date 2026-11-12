import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
import { verifyServiceToken, generateServiceToken } from '../../src/auth/tokens.js';

describe('service-token auth (no CRM JWT)', () => {
  const cfg = {
    jwtSecret: 'a'.repeat(64),
    jwtExpiry: '15m',
    tokenAudience: 'license-server',
  };

  it('accepts a valid HS256 service token', () => {
    const token = generateServiceToken(
      { sub: 'agency-1', aud: 'license-server', client_ver: '1.0', scope: ['licenses:admin'] },
      cfg,
    );
    const p = verifyServiceToken(token, cfg);
    expect(p.sub).toBe('agency-1');
    expect(p.scope).toContain('licenses:admin');
    expect(p.scope).not.toContain('*');
  });

  it('rejects CRM JWT signed with a different key', () => {
    // A token signed with a DIFFERENT signing key must be rejected by
    // HS256 verify — this proves the CRM JWT is never accepted as a
    // license-server credential.
    const wrong = 'b'.repeat(64);
    const t = require_('jsonwebtoken').sign({ sub: 'agency-1', aud: 'CRM', client_ver: '1.0', scope: ['*'] }, wrong, { algorithm: 'HS256' });
    expect(() => verifyServiceToken(t, cfg)).toThrow(/invalid service token/);
  });

  it('rejects a token with wildcard scope', () => {
    const bad = { sub: 'agency-1', aud: 'license-server', client_ver: '1.0', scope: ['*'] };
    const t = generateServiceToken(bad, cfg);
    expect(() => verifyServiceToken(t, cfg)).toThrow(/wildcard/);
  });

  it('rejects a token with a mismatched audience', () => {
    const token = generateServiceToken({ sub: 'agency-1', aud: 'license-server', client_ver: '1.0', scope: ['licenses:admin'] }, cfg);
    // A token meant for 'CRM' must be rejected here.
    expect(() => verifyServiceToken(token, { jwtSecret: cfg.jwtSecret, tokenAudience: 'CRM' })).toThrow();
  });
});
