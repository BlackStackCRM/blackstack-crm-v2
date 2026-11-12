-- Migration 095: keep the seeded System Administrator explicitly authorized
-- for Mother Company operations without extending those grants to every
-- tenant administrator that carries the shared role_admin wildcard.

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT 'role_mother_company', id
  FROM permissions
 WHERE module = 'mother_company'
    OR code LIKE 'mother_company.%';

INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT id, 'role_mother_company'
  FROM users
 WHERE lower(email) = 'admin@blackstack.local'
   AND upper(role) IN ('ADMIN', 'PLATFORM');
