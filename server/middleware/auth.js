const { SessionManager } = require('../auth/session');
const { AuthenticationError } = require('../utils/errors');
const { getConn } = require('../utils/db');

// Verify the identity in the token still exists, is active, and the tenant
// context is still valid. Never trust token claims about account state alone.
function assertUserStillValid(session) {
  const db = getConn();
  const user = db.get(
    `SELECT u.id, u.company_id, u.status, c.status as company_status
     FROM users u LEFT JOIN companies c ON c.id = u.company_id
     WHERE u.id = ?`,
    [session.userId]
  );
  if (!user) throw new AuthenticationError('User account no longer exists');
  // Status is stored as 'ACTIVE'/'INACTIVE' (uppercase) in the schema and seeds,
  // so compare case-insensitively instead of hard-coding one casing.
  if (String(user.status).toLowerCase() !== 'active') throw new AuthenticationError('User account is not active');
  if (user.company_status && String(user.company_status).toLowerCase() !== 'active') {
    throw new AuthenticationError('Company account is not active');
  }
  // Tenant claim in the token must match the DB record (guards against
  // stale tokens issued before a user was moved between companies).
  if (session.companyId && user.company_id !== session.companyId) {
    throw new AuthenticationError('Session company context is no longer valid');
  }
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AuthenticationError('Missing or invalid authorization header');
  }

  const token = authHeader.split(' ')[1];
  const session = SessionManager.verifyToken(token);

  if (!session) {
    throw new AuthenticationError('Invalid or expired token');
  }

  assertUserStillValid(session);

  req.user = session;
  next();
}

module.exports = { authMiddleware };
