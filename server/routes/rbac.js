/**
 * ROLE-BASED ACCESS ROUTES — /api/accounts + /api/auth/password
 *
 * CREATION (POST /api/accounts/create)
 *   Server validates the CALLER's role from the local users table (the
 *   authority), never from the request body. The creation matrix:
 *     agency          → sub_agency | customer_tenant (inside its subtree)
 *     sub_agency      → customer_tenant (under ITSELF only)
 *     customer_tenant → nothing (403)
 *
 * LOGIN (POST /api/auth/login already accepts username)
 *   resolves username → email server-side; failures are indistinguishable.
 *   The session additionally carries hierarchyRole + mustChangePassword.
 *
 * PASSWORD CHANGE (POST /api/auth/password/change)
 *   Required when must_change_password = 1; clears the flag atomically.
 */
const express = require('express');
const { body, param } = require('express-validator');
const { authMiddleware } = require('../middleware/auth');
const { getConn } = require('../utils/db');
const { successResponse } = require('../utils/response');
const { PasswordService } = require('../auth/password');
const { generateId } = require('../utils/generateId');
const { ValidationError, AuthorizationError, NotFoundError } = require('../utils/errors');
const rbac = require('../services/rbac.service');

const router = express.Router();

const db = () => getConn();

// ── POST /api/accounts/create ────────────────────────────────────────────────
router.post('/accounts/create',
  authMiddleware,
  [
    // FIX: an email used as username is 32+ chars — the 3-32 limit rejected
    // every email-format username with a bare 400. Emails are valid usernames
    // (Supabase Auth requires them); the real constraint is the email format,
    // validated by the service.
    body('username').optional({ values: 'falsy' }).isString().trim().isLength({ max: 254 }).withMessage('Username must be 254 characters or fewer.'),
    body('email').optional({ values: 'falsy' }).isString().trim().isLength({ max: 254 }).withMessage('Email must be 254 characters or fewer.'),
    body('role').isIn(['sub_agency', 'customer_tenant', 'agency']).withMessage('Invalid role.'),
    body('parentAgencyId').optional({ values: 'falsy' }).isString().trim(),
    body('password').optional({ values: 'falsy' }).isString().isLength({ min: 10 }).withMessage('Password must be at least 10 characters.'),
    body('displayName').optional({ values: 'falsy' }).isString().trim().isLength({ max: 200 }),
  ],
  async (req, res, next) => {
    try {
      const dbi = db();
      const body = req.body || {};
      // camelToSnake middleware may have rewritten parentAgencyId.
      const parentAgencyId = body.parentAgencyId || body.parent_agency_id || null;

      // Resolve the caller from the LOCAL users table — the authority. The
      // request body is never trusted for role/agency.
      const caller = rbac.resolveCaller(dbi, { userId: req.user.userId, supabaseUserId: req.user.supabaseUserId || null });
      if (!caller) throw new AuthorizationError('Authentication required.');

      const targetRole = body.role;
      const password = body.password || rbac.generatePassword();
      const displayName = (body.displayName || body.display_name || body.full_name || body.fullname
        || String(body.username || 'user').replace(/[._-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())).trim();

      const account = await rbac.createChildAccount(dbi, caller, {
        username: body.username,
        password,
        targetRole,
        parentAgencyId,
        displayName,
      });

      // Link the local user row so the hierarchy is visible locally too.
      // createChildAccount created the Supabase auth user + profiles mirror;
      // the local mirror keeps the local-first model working.
      const { DatabaseConnection } = require('../database/connection');
      const localDb = new DatabaseConnection().connect();
      const userId = generateId('usr');
      const hash = await PasswordService.hash(password);
      // FIX (FK): the user's tenant company must exist (users.company_id →
      // companies.id). Reuse the PARENT agency's own tenant company — the new
      // user lives in that tenant, exactly like agency admins created through
      // the MC flow. Do not synthesize a company_${id} that may not exist.
      // FIX (cloud-id parity): parentAgencyId may be a cloud UUID (the UI's
      // parent dropdown is populated from /mother-company/agencies). Resolve
      // cloud → local by agency_code, same pattern as every other route.
      let parentAgencyResolved = parentAgencyId || caller.localAgencyId;
      if (parentAgencyResolved && /^[0-9a-f]{8}-/i.test(parentAgencyResolved)) {
        const { getSupabaseClient } = require('../config/supabase');
        try {
          const sb2 = getSupabaseClient();
          const { data: cloudAg } = await sb2.from('agencies').select('agency_code').eq('id', parentAgencyResolved).maybeSingle();
          if (cloudAg && cloudAg.agency_code) {
            const localByCode = localDb.get('SELECT id FROM agencies WHERE agency_code = ?', [cloudAg.agency_code]);
            if (localByCode) parentAgencyResolved = localByCode.id;
          }
        } catch (e) { console.error('[rbac] parent cloud resolve failed:', e.message); }
      }
      const parentAgencyRow = localDb.get('SELECT company_id FROM agencies WHERE id = ?', [parentAgencyResolved]);
      const parentCompanyId = (parentAgencyRow && parentAgencyRow.company_id) || caller.localCompanyId;
      // A customer tenant must own a separate company row. Reusing the
      // parent's company_id would expose the agency's CRM data and make the
      // customer mapping point back at the agency itself.
      const tenantCompanyId = targetRole === 'customer_tenant' ? generateId('cmp') : parentCompanyId;
      localDb.transaction(() => {
        if (targetRole === 'customer_tenant') {
          localDb.run('INSERT INTO companies (id, name, status) VALUES (?,?,?)', [tenantCompanyId, displayName, 'ACTIVE']);
        }
        localDb.run(
          `INSERT INTO users (id, company_id, username, email, password_hash, full_name, role, status,
                              hierarchy_role, parent_user_id, must_change_password, supabase_user_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`,
          [userId, tenantCompanyId, account.username, account.email,
           hash, displayName,
           targetRole === 'agency' ? 'AGENCY' : (targetRole === 'sub_agency' ? 'AGENCY_ADMIN' : 'USER'),
           'ACTIVE', targetRole, caller.localUserId, account.supabaseUserId],
        );
      })();
      // FIX (acceptance gap): an 'agency'/'sub_agency' account MUST own an
      // agency row — the users row alone leaves resolveCaller() with nothing
      // to join (link → missing agency → empty visibility list). Create the
      // agency row + parent link + cloud mirror for agency-level accounts,
      // mirroring what the sub-agency creation flow does for its agency row.
      let agencyRowId = parentAgencyResolved;
      if (targetRole === 'agency' || targetRole === 'sub_agency') {
        // the account IS a new distribution agency (root for 'agency', sub for
        // 'sub_agency') and needs its OWN agency row: resolveCaller() joins
        // agency_administrators → agencies on it. Without it the account has
        // no tenant and every scoped list returns empty.
        agencyRowId = generateId('agy');
        // Hierarchy-aware code prefix: sub_agency accounts create SUB- rows
        // (the Agency Control list filters on SUB-%); root agency accounts get
        // AGY- rows (Mother Company territory).
        const code = (targetRole === 'sub_agency' ? 'SUB-' : 'AGY-') + agencyRowId.slice(-8).toUpperCase();
        const ownCompanyId = generateId('cmp');
        localDb.transaction(() => {
          localDb.run("INSERT OR IGNORE INTO companies (id, name, status) VALUES ('default','Default Provider','ACTIVE')");
          localDb.run('INSERT OR IGNORE INTO companies (id, name, status) VALUES (?,?,?)', [ownCompanyId, displayName, 'ACTIVE']);
          localDb.run(
            'INSERT INTO agencies (id, company_id, provider_company_id, name, agency_code, status) VALUES (?,?,?,?,?,?)',
            [agencyRowId, ownCompanyId, 'default', displayName, code, 'PENDING'],
          );
          // parent link: under the parent agency (null parent = root, MC-created)
          if (parentAgencyResolved) {
            localDb.run(
              'INSERT INTO agency_parent_relationships (child_agency_id, parent_agency_id, created_by) VALUES (?,?,?)',
              [agencyRowId, parentAgencyResolved, caller.localUserId],
            );
          }
          // Keep the account-to-agency association atomic with creation of the
          // agency row. Auth/profile and resolveCaller derive agencyId from
          // this canonical link; users intentionally has no duplicate
          // agency_id column.
          localDb.run(
            `INSERT INTO agency_administrators (id, agency_id, user_id, company_id, role_code, assigned_by, assigned_at, status)
             VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,'ACTIVE')`,
            [generateId('aad'), agencyRowId, userId, tenantCompanyId, 'AGENCY_ADMIN', caller.localUserId],
          );
        })();
        // cloud mirror (best-effort) — same pattern as createSubAgency P0/P1
        (async () => {
          try {
            const sb = require('../config/supabase').getSupabaseClient();
            const cloudId = require('../services/supabase.service').localIdToCloudUuid(agencyRowId);
            await sb.from('companies').upsert([{ id: ownCompanyId, name: displayName, status: 'ACTIVE' }], { onConflict: 'id' });
            await sb.from('agencies').upsert([{ id: cloudId, company_id: ownCompanyId, provider_company_id: 'default', name: displayName, agency_code: code, status: 'PENDING' }], { onConflict: 'id' });
            if (parentAgencyResolved) {
              const cloudParent = require('../services/supabase.service').localIdToCloudUuid(parentAgencyResolved);
              await sb.from('agency_parent_relationships').upsert([{ child_agency_id: cloudId, parent_agency_id: cloudParent }], { onConflict: 'child_agency_id' });
            }
          } catch (e) { console.error('[rbac] agency cloud mirror failed:', e.message); }
        })();
      }
      // Fail the request rather than return a sub-agency account that cannot
      // resolve its own agency from /auth/profile or /auth/me.
      if (targetRole !== 'customer_tenant') {
        const ownerLink = localDb.get(
          `SELECT agency_id FROM agency_administrators
           WHERE user_id=? AND status='ACTIVE' ORDER BY assigned_at DESC LIMIT 1`,
          [userId],
        );
        if (!ownerLink) throw new Error('Could not persist the new account agency association.');
        agencyRowId = ownerLink.agency_id;
      } else {
        // FIX (customer tenant list empty): a customer_tenant account has no
        // agency row / admin link — its tenancy is the customer_tenant_agencies
        // mapping (agency_id → the customer's tenant company). Without this
        // row listCustomers() (which reads exactly that table) returns an
        // empty list even though the account was created successfully, so the
        // My Hierarchy page showed "No customer tenants yet" forever.
        // parentAgencyResolved is the caller's own agency (already resolved to
        // a local id above), the ONLY scope a sub_agency may create under.
        if (parentAgencyResolved) {
          localDb.transaction(() => {
            localDb.run(
              `INSERT OR IGNORE INTO customer_tenant_agencies (company_id, agency_id, provider_company_id, assigned_by)
               VALUES (?,?,?,?)`,
              [tenantCompanyId, parentAgencyResolved, parentCompanyId, caller.localUserId],
            );
            localDb.run(
              `INSERT INTO customer_tenant_agency_history (id, company_id, old_agency_id, new_agency_id, changed_by)
               VALUES (?,?,?,?,?)`,
              [generateId('ctah'), tenantCompanyId, null, parentAgencyResolved, caller.localUserId],
            );
          })();
          // Cloud mirror (best-effort): company stub first (FK order), then the
          // mapping — same order createCustomer() uses.
          (async () => {
            try {
              const sb = require('../config/supabase').getSupabaseClient();
              const cloudAgency = /^[0-9a-f]{8}-/i.test(parentAgencyResolved)
                ? parentAgencyResolved
                : require('../services/supabase.service').localIdToCloudUuid(parentAgencyResolved);
              const custName = db().get('SELECT name FROM companies WHERE id = ?', [tenantCompanyId]);
              await sb.from('companies').upsert([{ id: tenantCompanyId, name: (custName && custName.name) || displayName, status: 'ACTIVE' }], { onConflict: 'id' });
              const { error: mapErr } = await sb.from('customer_tenant_agencies').upsert(
                [{ company_id: tenantCompanyId, agency_id: cloudAgency, provider_company_id: parentCompanyId, assigned_by: caller.localUserId }],
                { onConflict: 'company_id' },
              );
              if (mapErr) console.error('[rbac] customer mapping cloud sync failed:', mapErr.message || JSON.stringify(mapErr));
            } catch (e) { console.error('[rbac] customer mapping cloud sync threw:', e.message); }
          })();
        }
      }

      res.status(201).json(successResponse({
        account: {
          username: account.username,
          email: account.email,
          role: account.role,
          parentAgencyId: account.parentAgencyId,
          // For agency/sub_agency accounts: the id of the agency row THIS
          // account now administers (children must be created under THIS id,
          // not under the parent) — needed by parents to chain creation.
          agencyId: agencyRowId,
        },
        // one-time password — returned only to the creating parent, never logged
        oneTimePassword: password,
        mustChangePassword: true,
      }, 201));
    } catch (err) { next(err); }
  });

function username2Name(u) {
  return String(u || 'user')
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim() || 'New User';
}

// ── POST /api/auth/password/change ───────────────────────────────────────────
router.post('/auth/password/change',
  authMiddleware,
  [
    body('currentPassword').isString().notEmpty().withMessage('Current password is required.'),
    body('newPassword').isString().isLength({ min: 10 }).withMessage('New password must be at least 10 characters.'),
  ],
  async (req, res, next) => {
    try {
      const dbi = db();
      const b = req.body || {};
      // camelToSnake middleware rewrites currentPassword -> current_password
      // (and newPassword -> new_password); accept both conventions.
      const currentPassword = b.currentPassword || b.current_password;
      const newPassword = b.newPassword || b.new_password;
      const user = dbi.get('SELECT id, password_hash, must_change_password, email FROM users WHERE id = ?', [req.user.userId]);
      if (!user) throw new NotFoundError('User', req.user.userId);
      const ok = await PasswordService.verify(currentPassword, user.password_hash);
      if (!ok) throw new AuthorizationError('Current password is incorrect.');
      if (currentPassword === newPassword) {
        throw new ValidationError('Password change failed.', { newPassword: 'New password must differ from the current password.' });
      }
      const hash = await PasswordService.hash(newPassword);
      dbi.run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [hash, req.user.userId]);
      // keep the Supabase auth user in sync (best-effort; local is authority)
      try {
        const sb = require('../config/supabase').getSupabaseClient();
        const resolved = rbac.resolveCaller(dbi, { userId: req.user.userId });
        const supabaseUserId = (resolved && resolved.supabaseUserId) || null;
        // Local users created via accounts/create may have NO Supabase mirror
        // yet (the auth user lives in Supabase but its id is not stored
        // locally). updateUserById(undefined, …) throws 'Illegal arguments'.
        if (supabaseUserId) {
          await sb.auth.admin.updateUserById(supabaseUserId, { password: newPassword });
          await sb.from('profiles').update({ must_change_password: false }).eq('user_id', supabaseUserId);
        }
      } catch (e) { console.error('[rbac] cloud password mirror failed:', e.message); }
      res.json(successResponse({ changed: true, mustChangePassword: false }));
    } catch (err) { next(err); }
  });

module.exports = router;
