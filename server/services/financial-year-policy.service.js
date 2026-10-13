/**
 * Shared financial-year lock policy.
 *
 * PHASE 3A — FY-1 / FY-2.
 *
 * WHY THIS EXISTS
 *   The financial-year lock was enforced inconsistently across the codebase:
 *
 *   * accounting-engine.service.js honoured the `accounting.override_locked`
 *     permission — but only `role_admin` holds it, and an admin session carries
 *     `['*']`, so `Authorizer.assertPermission` short-circuits and the override
 *     works there.
 *   * accounting.controller.js rejected a locked year UNCONDITIONALLY in ten
 *     places. It contained zero references to `override_locked`, so a user who
 *     legitimately held the documented override was still blocked on every
 *     controller path.
 *   * FinancialYearRepository.getActive()/getByDate() do not check is_locked at
 *     all, so every caller has to remember to.
 *
 *   That meant an administrator could not perform a deliberate, permitted
 *   override through the main UI, while the same action succeeded through the
 *   engine. This module gives one policy both can call.
 *
 * POLICY (single source of truth)
 *   1. A locked financial year blocks posting.
 *   2. A caller holding `accounting.override_locked` may proceed anyway. This is
 *      an explicit, audited permission — not a blanket bypass.
 *   3. Date-range validation is UNCHANGED and still enforced for everyone. An
 *      override does not let you post outside the year's period.
 *   4. Users without the permission are blocked exactly as before.
 *
 * Nothing about balance, account state, tenant scope, or period boundaries is
 * altered here.
 */
const { Authorizer } = require('../auth/authorizer');

const OVERRIDE_PERMISSION = 'accounting.override_locked';

/**
 * Does this request context hold the financial-year lock override?
 *
 * @param {object} context  the request `req`, or any object exposing
 *                          `permissions` (the session claim).
 * @returns {boolean}
 */
function hasFinancialYearOverride(context) {
  try {
    Authorizer.assertPermission(context, OVERRIDE_PERMISSION);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether posting into a financial year is permitted.
 *
 * @param {object} params
 * @param {object|null} params.fy            the financial_years row (may be null)
 * @param {object}        params.context      request `req` for permission checks
 * @returns {{blocked: boolean, overridden: boolean, reason: string|null}}
 */
function evaluateFinancialYearLock({ fy, context } = {}) {
  if (!fy) return { blocked: false, overridden: false, reason: null };
  const isLocked = fy.is_locked === 1 || fy.is_locked === true;
  if (!isLocked) return { blocked: false, overridden: false, reason: null };

  if (hasFinancialYearOverride(context)) {
    return {
      blocked: false,
      overridden: true,
      reason: `Financial year ${fy.id} is locked; posting permitted by ${OVERRIDE_PERMISSION}.`,
    };
  }
  return {
    blocked: true,
    overridden: false,
    reason: `Financial year is locked${fy.id ? ` (${fy.id})` : ''}.`,
  };
}

/**
 * Throw an FY_LOCKED AppError unless the caller may override.
 * Used by paths that throw rather than collect validation errors.
 */
function assertFinancialYearWritable({ fy, context, AppError }) {
  const verdict = evaluateFinancialYearLock({ fy, context });
  if (verdict.blocked) {
    const Err = AppError || require('../utils/errors').AppError;
    throw new Err(verdict.reason, 'FY_LOCKED', 400);
  }
  return verdict;
}

module.exports = {
  OVERRIDE_PERMISSION,
  hasFinancialYearOverride,
  evaluateFinancialYearLock,
  assertFinancialYearWritable,
};