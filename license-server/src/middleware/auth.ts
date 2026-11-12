/**
 * Service-token authentication middleware.
 *
 * Verifies the License Server token (HS256) and rejects '*' scope.
 * The CRM JWT is never accepted here.
 */
import { Request, Response, NextFunction } from 'express';
import { verifyServiceToken } from '../auth/tokens.js';

export function serviceTokenMiddleware(cfg: { jwtSecret: string; tokenAudience: string }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: { code: 'AUTHENTICATION_ERROR', message: 'missing authorization header' },
      });
      return;
    }
    const token = header.slice(7);
    if (!token) {
      res.status(401).json({ success: false, error: { code: 'AUTHENTICATION_ERROR', message: 'empty bearer token' } });
      return;
    }
    // Verify against the license server's own signing key and audience only.
    let payload: any;
    try {
      payload = verifyServiceToken(token, cfg);
    } catch (e: any) {
      res.status(401).json({
        success: false,
        error: { code: 'AUTHENTICATION_ERROR', message: e.message || 'invalid service token' },
      });
      return;
    }
    req.locals = { user: { companyId: payload.sub, scopes: payload.scope } };
    next();
  };
}
