/**
 * MOTHER COMPANY ACCESS CONTROL
 *
 * Phase 1 of the BlackStack Product Activation / Agency Management platform.
 *
 * WHY A SEPARATE MIDDLEWARE INSTEAD OF THE EXISTING requirePermission()
 * ---------------------------------------------------------------
 * `Authorizer.assertPermission()` treats a permissions array containing '*' as
 * "allow everything":
 *
 *     if (context.permissions.includes('*')) return;
 *
 * and `auth.service.js` grants '*' to ANY user holding the ADMIN role:
 *
 *     if (roles.some(r => r.code === 'ADMIN' || r.id === 'role_admin')) {
 *       permissions = ['*'];
 *     }
 *
 * That is correct for CRM modules, where a tenant administrator SHOULD have
 * full access. It is wrong for Mother Company controls. Mother Company is a
 * product-owner role that sits ABOVE every tenant, so if its permission codes
 * were ever folded into the '*' wildcard, then every customer company's
 * administrator — at any customer site — would silently become a Mother Company
 * operator with the ability to create and activate agencies.
 *
 * This middleware therefore requires an EXPLICIT, NAMED permission code and
 * deliberately ignores '*'. Only a user who was granted a specific
 * `mother_company.*` code through role_permissions can pass.
 *
 * Email address is never consulted. Access comes from a server-side role
 * assignment only; the account's address grants it nothing.
 */

const { AuthenticationError, AuthorizationError } = require('../utils/errors');
const { getConn } = require('../utils/db');
const { resolveCaller } = require('../services/rbac.service');

function isPlatformAccount(req) {
  const caller = req.user && resolveCaller(getConn(), { userId: req.user.userId });
  return !!caller && caller.role === 'platform';
}

/** Explicit Mother Company permission codes this module accepts. */
const MOTHER_COMPANY_PERMISSIONS = Object.freeze({
  DASHBOARD_VIEW: 'mother_company.view',
  AGENCIES_VIEW: 'mother_company.agencies.view',
  AGENCIES_CREATE: 'mother_company.agencies.create',
  AGENCIES_EDIT: 'mother_company.agencies.edit',
  AGENCIES_STATUS: 'mother_company.agencies.status',
  AGENCIES_ADMINS: 'mother_company.agencies.admins.manage',
  AUDIT_VIEW: 'mother_company.audit.view',
  WALLETS_VIEW: 'mother_company.wallets.view',
  WALLETS_CREDIT: 'mother_company.wallets.credit',
  SUBSCRIPTIONS_MANAGE: 'mother_company.subscriptions.manage',
});

const ALL_MOTHER_COMPANY_PERMISSIONS = Object.freeze(
  Object.values(MOTHER_COMPANY_PERMISSIONS),
);

/**
 * Does this session hold a specific Mother Company permission?
 *
 * The '*' wildcard is intentionally NOT honoured here. See the module header.
 */
function hasMotherCompanyPermission(user, permissionCode) {
  if (!user || !Array.isArray(user.permissions)) return false;
  return user.permissions.includes(permissionCode);
}

/**
 * True when the user holds ANY Mother Company permission. Used only to decide
 * whether to show navigation; the API guards still require a specific code.
 */
function isMotherCompanyUser(user) {
  if (!user || !Array.isArray(user.permissions)) return false;
  return ALL_MOTHER_COMPANY_PERMISSIONS.some((p) => user.permissions.includes(p));
}

/**
 * Route guard: requires authentication AND a specific Mother Company permission.
 *
 * Failure modes are deliberately distinct so the client can react correctly:
 *   401 — no valid session at all
 *   403 — valid session, but not a Mother Company operator
 *
 * A 403 is never downgraded to a 200-with-empty-list, because "you may not see
 * this" and "there is nothing here" must not look the same to a caller.
 */
function requireMotherCompany(permissionCode) {
  return (req, res, next) => {
    if (!req.user) {
      throw new AuthenticationError('Authentication required');
    }
    if (!isPlatformAccount(req) || !hasMotherCompanyPermission(req.user, permissionCode)) {
      // Deliberately does not echo the permission code back to the client: the
      // error should not become an oracle for which internal codes exist.
      throw new AuthorizationError('Mother Company access required');
    }
    next();
  };
}

/**
 * Guard for routes that only need "is a Mother Company operator" without a
 * specific action, e.g. the dashboard shell.
 */
function requireAnyMotherCompanyPermission() {
  return (req, res, next) => {
    if (!req.user) {
      throw new AuthenticationError('Authentication required');
    }
    if (!isPlatformAccount(req) || !isMotherCompanyUser(req.user)) {
      throw new AuthorizationError('Mother Company access required');
    }
    next();
  };
}

module.exports = {
  MOTHER_COMPANY_PERMISSIONS,
  ALL_MOTHER_COMPANY_PERMISSIONS,
  hasMotherCompanyPermission,
  isMotherCompanyUser,
  requireMotherCompany,
  requireAnyMotherCompanyPermission,
};
