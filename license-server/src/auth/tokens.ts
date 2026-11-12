/**
 * License-server service tokens.
 *
 * Two separate tokens, never crossed:
 *   - CRM JWT (HMAC or RS256, JWT_SECRET)      : the existing CRM only.
 *   - License Server token (HS256, this JWT_SECRET): the only credential the
 *     central license server accepts from the client.
 *
 * A CRM operator's ['*'] is NEVER a license-server credential. Every check
 * explicitly rejects '*' here.
 */
import jwt from 'jsonwebtoken';
import type { Config } from '../config/validation.js';

export interface ServiceTokenPayload {
  iss: string;
  aud: string;
  sub: string;
  scope: string[];
  jti: string;
  nbf: number;
  iat: number;
  exp: number;
  client_ver: string;
}

export interface ServiceTokenConfig {
  jwtSecret: string;
  jwtExpiry: string;
  tokenAudience: string;
}

export function generateServiceToken(
  payload: Omit<ServiceTokenPayload, 'iss' | 'nbf' | 'iat' | 'jti'>,
  cfg: Pick<Config, 'jwtSecret' | 'jwtExpiry' | 'tokenAudience'>,
) {
  const now = Math.floor(Date.now() / 1000);
  const jti = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  const signingKey = cfg.jwtSecret;
  if (!signingKey) throw new Error('[tokens] JWT_SECRET is not set');
  return jwt.sign(
    {
      iss: cfg.tokenAudience,
      aud: payload.aud,
      sub: payload.sub,
      scope: payload.scope,
      jti,
      nbf: now,
      iat: now,
      exp: now + Number(cfg.jwtExpiry.split('m')[0]) * 60,
      client_ver: payload.client_ver,
    },
    signingKey,
    { algorithm: 'HS256' },
  );
}

export function verifyServiceToken(token: string, cfg: Pick<Config, 'jwtSecret' | 'tokenAudience'>) {
  const { jwtSecret, tokenAudience } = cfg;
  if (!jwtSecret) throw new Error('[tokens] JWT_SECRET is not set');
  // Reject '*' — CRM wildcard never authenticates a license-server request.
  try {
    const decoded = jwt.verify(token, jwtSecret, {
      algorithms: ['HS256'],
      issuer: tokenAudience,
      audience: tokenAudience,
    }) as ServiceTokenPayload;
    if (decoded.scope.includes('*')) {
      console.error('[auth] service token contained wildcard scope; refusing');
      throw new Error('license-server: wildcard scope is not permitted');
    }
    return decoded;
  } catch (e: any) {
    if (e && e.name === 'TokenExpiredError') {
      throw new Error('license-server: service token expired');
    }
    if (e && e.name === 'JsonWebTokenError') {
      throw new Error('license-server: invalid service token');
    }
    throw e;
  }
}

export function generateAuthToken(email: string, password: string, cfg: Pick<Config, 'jwtSecret' | 'jwtExpiry'>) {
  // Operator login for the license server. Signed with the same HS256 key as
  // the service tokens. No CRM JWT is involved.
  const signingKey = cfg.jwtSecret;
  if (!signingKey) throw new Error('[auth] JWT_SECRET not set');
  const payload = { sub: email, scope: ['licenses:admin'], jti: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  const sec = Number(cfg.jwtExpiry.split('m')[0]) * 60;
  return jwt.sign(payload, signingKey, { algorithm: 'HS256', expiresIn: cfg.jwtExpiry, issuer: 'license-server' });
}
