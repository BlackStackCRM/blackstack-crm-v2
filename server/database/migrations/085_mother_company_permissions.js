#!/usr/bin/env node
/**
 * MIGRATION: Seed role_mother_company with all mother_company.* permissions
 *
 * Ensures the `role_mother_company` role holds every mother_company.* permission
 * in the role_permissions table. The admin@blackstack.local user is already
 * assigned to this role (see verification below).
 *
 * Run: node migrations/085_mother_company_permissions.js
 *
 * GUARDRAIL: This only touches module = 'mother_company' permissions. It never
 * grants mother_company.* to customer_tenant or sub_agency roles.
 */
'use strict';

const { getConn } = require('./server/utils/db');

const REQUIRED_PERMISSIONS = [
  'mother_company.view',
  'mother_company.agencies.view',
  'mother_company.agencies.create',
  'mother_company.agencies.edit',
  'mother_company.agencies.status',
  'mother_company.agencies.admins.manage',
  'mother_company.audit.view',
  'mother_company.wallets.view',
  'mother_company.wallets.credit',
  'mother_company.subscriptions.manage',
];

async function migrate() {
  const db = getConn();
  const tx = db.transaction(() => {
    // 1. Seed each missing mother_company.* permission
    for (const code of REQUIRED_PERMISSIONS) {
      const existing = db.get(
        'SELECT id FROM permissions WHERE module = ? AND code = ?',
        ['mother_company', code],
      );
      if (!existing) {
        // Destination company for system-level permissions
        const dest = db.get('SELECT id FROM companies WHERE id = ?', ['default']);
        const companyId = dest ? dest.id : 'default';
        db.run(
          `INSERT INTO permissions (id, company_id, code, module, name, description)
           VALUES (?, ?, ?, 'mother_company', ?, ?)`,
          [
            code.replace(/[^a-zA-Z0-9_]/g, '_'),
            companyId,
            code,
            code.replace(/^mother_company\./, 'Mother Company - '),
            'Mother Company control-plane permission',
          ],
        );
      }
    }

    // 2. Link ALL mother_company.* permissions to role_mother_company
    const role = db.get('SELECT id FROM roles WHERE code = ?', 'MOTHER_COMPANY');
    if (!role) throw new Error('role_mother_company not found in roles table');
    const permIds = db.all(
      "SELECT id FROM permissions WHERE module = 'mother_company' ORDER BY code",
    );
    for (const p of permIds) {
      const exists = db.get(
        'SELECT 1 FROM role_permissions WHERE role_id = ? AND permission_id = ?',
        [role.id, p.id],
      );
      if (!exists) {
        db.run(
          'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
          [role.id, p.id],
        );
      }
    }

    // 3. Ensure admin@blackstack.local is assigned role_mother_company
    const admin = db.get("SELECT id FROM users WHERE email = 'admin@blackstack.local'");
    if (admin) {
      const assigned = db.get(
        'SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ?',
        [admin.id, role.id],
      );
      if (!assigned) {
        db.run(
          'INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)',
          [admin.id, role.id],
        );
      }
    }

    // 4. Hard guardrail: never grant mother_company.* to customer_tenant or
    //    sub_agency roles.
    const forbiddenRoles = ['CUSTOMER_TENANT', 'SUB_AGENCY'];
    const forbidden = db.all("SELECT id FROM roles WHERE code IN (?, ?)", [
      'CUSTOMER_TENANT',
      'SUB_AGENCY',
    ]);
    for (const f of forbidden) {
      const grant = db.all(
        `SELECT rp.role_id, p.code
         FROM role_permissions rp
         JOIN permissions p ON rp.permission_id = p.id
         WHERE p.module = 'mother_company'`,
      );
      for (const g of grant) {
        if (g.role_id === f.id) {
          db.run('DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?', [
            g.role_id,
            g.permission_id,
          ]);
          console.log(`[migrated] removed mother_company.* from role ${f.code} (id ${g.role_id})`);
        }
      }
    }
  });
  tx();
  console.log('[migrated] role_mother_company seeded with all mother_company.* permissions');
  console.log('[migrated] admin@blackstack.local assigned role_mother_company');
}

migrate().catch((err) => {
  console.error('[migrated] FATAL:', err.message);
  process.exit(1);
});
