const { getConn } = require('../utils/db');
const { resolveCaller } = require('../services/rbac.service');

const BYPASS_PREFIXES = ['/auth/', '/wallet/'];

function isSubscriptionBypassPath(pathname = '') {
  const path = String(pathname).split('?')[0];
  return path === '/auth' || path === '/wallet'
    || path === '/payments/webhook' || path.startsWith('/payments/webhook/')
    || BYPASS_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function createCheckSubscriptionStatus(getDatabase = getConn) {
  return function checkSubscriptionStatus(req, res, next) {
    try {
      const db = getDatabase();
      // `req.user.role` is the legacy database role (often `ADMIN`), not the
      // normalized hierarchy role. Resolve it from SQLite so only a real
      // Mother Company/platform account bypasses tenant subscription gating.
      const caller = req.user && req.user.userId
        ? resolveCaller(db, { userId: req.user.userId })
        : null;
      if (caller && caller.role === 'platform') return next();

      const companyId = req.user && (req.user.companyId || req.user.company_id);
      if (!companyId) {
        return res.status(403).json({
          error: 'SUBSCRIPTION_INACTIVE', reason: 'NONE',
          message: 'Your subscription is not active. Please recharge your wallet immediately to continue using the software.',
        });
      }

      const latest = db.get(
        `SELECT status, COALESCE(end_date, expires_at) AS end_date
         FROM subscriptions WHERE company_id=?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        [companyId]
      );
      // Compare UTC timestamps in SQLite. end_date is stored as an ISO UTC
      // timestamp at 23:59:59Z for date-based plans.
      const active = latest && String(latest.status).toUpperCase() === 'ACTIVE'
        && latest.end_date
        && db.get("SELECT datetime(?) >= datetime('now') AS valid", [latest.end_date])?.valid === 1;
      if (active) return next();

      const expired = latest && (String(latest.status).toUpperCase() === 'EXPIRED'
        || (latest.end_date && db.get("SELECT datetime(?) < datetime('now') AS expired", [latest.end_date])?.expired === 1));
      return res.status(403).json({
        error: 'SUBSCRIPTION_INACTIVE',
        reason: expired ? 'EXPIRED' : 'NONE',
        message: 'Your subscription is not active. Please recharge your wallet immediately to continue using the software.',
      });
    } catch (error) {
      return next(error);
    }
  };
}

const checkSubscriptionStatus = createCheckSubscriptionStatus();
module.exports = { checkSubscriptionStatus, createCheckSubscriptionStatus, isSubscriptionBypassPath };
