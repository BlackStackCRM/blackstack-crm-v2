#!/usr/bin/env node
/*
 * Repair legacy sub-agency users that have a matching SUB- agency row but no
 * agency_administrators link. Dry-run by default; pass --apply to write.
 * Matches only a unique case-insensitive exact name and unique user/agency pair.
 */
require('dotenv').config();
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(process.env.DB_PATH || path.join(__dirname, '../data/blackstack-crm.db'));
const apply = process.argv.includes('--apply');
const explicitEmail = process.env.BACKFILL_SUBAGENCY_EMAIL || null;
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout=5000');

try {
  const users = db.prepare(`
    SELECT u.id, u.email, u.full_name, u.company_id, u.parent_user_id
    FROM users u
    WHERE u.hierarchy_role='sub_agency' AND upper(u.status)='ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM agency_administrators aa WHERE aa.user_id=u.id AND aa.status='ACTIVE')
      AND lower(u.email)=lower(coalesce(?, u.email))
    ORDER BY u.created_at
  `).all(explicitEmail);

  const plan = [];
  for (const user of users) {
    const candidates = db.prepare(`
      SELECT a.id, a.company_id, a.agency_code, a.name
      FROM agencies a
      WHERE a.agency_code LIKE 'SUB-%'
        AND upper(a.status)='ACTIVE'
        AND lower(trim(a.name))=lower(trim(?))
    `).all(user.full_name);
    if (candidates.length === 1) {
      const matchingUsers = db.prepare(`
        SELECT COUNT(*) AS n FROM users u
        WHERE u.hierarchy_role='sub_agency' AND upper(u.status)='ACTIVE'
          AND lower(trim(u.full_name))=lower(trim(?))
          AND NOT EXISTS (SELECT 1 FROM agency_administrators aa WHERE aa.user_id=u.id AND aa.status='ACTIVE')
      `).get(user.full_name).n;
      if (matchingUsers === 1 || explicitEmail) plan.push({ user, agency: candidates[0], sameNameUsers: matchingUsers });
      else plan.push({ user, skipped: 'ambiguous matching sub-agency users', matches: matchingUsers });
    }
    else plan.push({ user, skipped: candidates.length ? 'ambiguous matching SUB- agency' : 'no unique matching active SUB- agency', matches: candidates.length });
  }

  console.log(JSON.stringify({ database: dbPath, mode: apply ? 'APPLY' : 'DRY_RUN', plan: plan.map((row) => row.skipped
    ? { email: row.user.email, userId: row.user.id, skipped: row.skipped, matches: row.matches }
    : {
      email: row.user.email, userId: row.user.id, agencyId: row.agency.id,
      agencyCode: row.agency.agency_code, agencyName: row.agency.name,
      ...(row.sameNameUsers > 1 ? { warning: `${row.sameNameUsers} unlinked sub-agency users share this name; explicit email selector is being used.` } : {}),
    }) }, null, 2));

  if (apply) {
    const insert = db.prepare(`
      INSERT INTO agency_administrators
        (id, agency_id, user_id, company_id, role_code, assigned_by, status)
      SELECT ?, ?, ?, ?, 'AGENCY_ADMIN', ?, 'ACTIVE'
      WHERE NOT EXISTS (SELECT 1 FROM agency_administrators WHERE user_id=? AND status='ACTIVE')
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of plan) {
        if (row.skipped) continue;
        insert.run(
          `aad_backfill_${row.user.id}`, row.agency.id, row.user.id,
          row.user.company_id, row.user.parent_user_id || null,
          row.user.id,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    console.log('Backfill complete. Only uniquely matched SUB- agencies were linked.');
  }
} finally {
  db.close();
}
