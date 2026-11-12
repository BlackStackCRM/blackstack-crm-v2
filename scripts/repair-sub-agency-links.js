/**
 * REPAIR: stranded agency / sub-agency operator accounts.
 *
 * Symptom: a sub-agency (e.g. grandhp@gmail.com) logs in but resolves no
 * agency (profile agencyId null → "Could not determine your agency…").
 * Root causes in the data (never hardcoded, always derived):
 *   1. the account has no ACTIVE agency_administrators link (purged/never
 *      created by an older flow), and
 *   2. its users.company_id tenant no longer matches any agencies row,
 *      because the parent agency was RE-CREATED by the Mother Company
 *      assignAdministrator flow (revokes the old operator row, links a NEW
 *      user + NEW agency row — same name/contact email, fresh ids).
 *
 * Resolution chain per stranded user (first match wins):
 *   A. an agencies row whose company_id = the user's tenant company
 *   B. the agency administered by the user's PARENT user (users.parent_user_id)
 *   C. the agency whose contact_email = the PARENT user's email (covers the
 *      re-created-agency case: the parent keeps its email, the new agency
 *      row carries it as contact_email)
 *
 * Idempotent: skips users that already have an ACTIVE link. Every insert is
 * logged. Run: node scripts/repair-sub-agency-links.js
 */
require('dotenv').config({ quiet: true });
const { DatabaseConnection } = require('../server/database/connection');
const { generateId } = require('../server/utils/generateId');

const db = new DatabaseConnection().connect();

const users = db.all(
  `SELECT id, email, company_id, role, hierarchy_role, parent_user_id
   FROM users
   WHERE hierarchy_role IN ('agency', 'sub_agency') AND status = 'ACTIVE'`,
);

let repaired = 0;
for (const u of users) {
  const existingAny = db.get('SELECT id, status, agency_id FROM agency_administrators WHERE user_id = ?', [u.id]);
  if (existingAny && existingAny.status === 'ACTIVE') continue;
  if (existingAny) {
    // UNIQUE(user_id) — the row must be revived, but a sub_agency must never
    // sit on the PARENT's agency row (that would expose siblings). If the
    // stale row points at the parent agency, re-revoke it and fall through
    // to the own-agency creation path below.
    const isParentRow = u.hierarchy_role === 'sub_agency' && (() => {
      // The stale row is over-wide when it points at the parent's agency:
      // check that the row's agency is the DIRECT PARENT of nothing (i.e. it
      // is a parent in agency_parent_relationships with children, or simply
      // that the account's email is not the row agency's admin identity).
      // Simplest robust check: is the row agency a ROOT/SUB-parent with other
      // administrators or children? Treat any agency row that OTHER users
      // also administer, or that has children, as the parent row.
      const shared = db.get(
        'SELECT COUNT(*) AS n FROM agency_administrators WHERE agency_id = ? AND user_id != ?',
        [existingAny.agency_id, u.id],
      );
      const hasChildren = db.get(
        'SELECT COUNT(*) AS n FROM agency_parent_relationships WHERE parent_agency_id = ?',
        [existingAny.agency_id],
      );
      return (shared && Number(shared.n) > 0) || (hasChildren && Number(hasChildren.n) > 0);
    })();
    if (!isParentRow) {
      db.run(
        "UPDATE agency_administrators SET status='ACTIVE', revoked_at=NULL, revoked_by=NULL, assigned_at=CURRENT_TIMESTAMP WHERE id=?",
        [existingAny.id],
      );
      repaired += 1;
      console.log(`REVIVED ${u.email} → agency ${existingAny.agency_id}`);
      continue;
    }
    db.run("UPDATE agency_administrators SET status='REVOKED' WHERE id=?", [existingAny.id]);
  }

  // A. agency row under the user's own tenant company
  let agency = db.get('SELECT id, name FROM agencies WHERE company_id = ? LIMIT 1', [u.company_id]);

  // B. the parent user's administered agency
  if (!agency && u.parent_user_id) {
    agency = db.get(
      `SELECT a.id, a.name FROM agency_administrators aa
       JOIN agencies a ON a.id = aa.agency_id
       WHERE aa.user_id = ? AND aa.status = 'ACTIVE' LIMIT 1`,
      [u.parent_user_id],
    );
  }

  // C. the agency whose contact_email matches the parent user's email
  //    (re-created agency keeps the original contact email).
  if (!agency && u.parent_user_id) {
    agency = db.get(
      `SELECT a.id, a.name FROM agencies a
       JOIN users pu ON LOWER(pu.email) = LOWER(a.contact_email)
       WHERE pu.id = ? LIMIT 1`,
      [u.parent_user_id],
    );
  }

  // For sub_agency accounts the model requires an agency row of ITS OWN under
  // the resolved parent — linking the account to the parent's agency row
  // directly would widen its visibility to the parent's whole subtree
  // (siblings included). Resolve the parent first, then materialize the own
  // row; for 'agency' accounts link directly.
  if (u.hierarchy_role === 'sub_agency') {
    // A parent for the OWN row: the parent user's administered agency, else
    // the agency whose contact_email matches the parent user's email.
    let parent = null;
    if (u.parent_user_id) {
      parent = db.get(
        `SELECT a.id, a.name FROM agency_administrators aa
         JOIN agencies a ON a.id = aa.agency_id
         WHERE aa.user_id = ? AND aa.status = 'ACTIVE' LIMIT 1`,
        [u.parent_user_id],
      );
      if (!parent) {
        parent = db.get(
          `SELECT a.id, a.name FROM agencies a
           JOIN users pu ON LOWER(pu.email) = LOWER(a.contact_email)
           WHERE pu.id = ? LIMIT 1`,
          [u.parent_user_id],
        );
      }
    }
    if (!parent) {
      console.log(`SKIP ${u.email} (sub_agency): no resolvable parent agency.`);
      continue;
    }
    const agyId = generateId('agy');
    const ownCompanyId = generateId('cmp');
    const name = (u.email.split('@')[0] || 'Sub-agency').slice(0, 60) + ' Sub';
    const code = 'SUB-' + agyId.slice(-8).toUpperCase();
    db.transaction(() => {
      db.run('INSERT OR IGNORE INTO companies (id, name, status) VALUES (?,?,\'ACTIVE\')', [ownCompanyId, name]);
      db.run(
        'INSERT INTO agencies (id, company_id, provider_company_id, name, agency_code, status) VALUES (?,?,?,?,?,\'PENDING\')',
        [agyId, ownCompanyId, 'default', name, code],
      );
      db.run(
        'INSERT INTO agency_parent_relationships (child_agency_id, parent_agency_id, created_by) VALUES (?,?,?)',
        [agyId, parent.id, 'repair-sub-agency-links'],
      );
    })();
    const id = generateId('aad');
    if (existingAny) {
      // UNIQUE(user_id): repoint the stale (revoked) row at the OWN agency.
      db.run(
        "UPDATE agency_administrators SET status='ACTIVE', agency_id=?, company_id=?, revoked_at=NULL, revoked_by=NULL, assigned_at=CURRENT_TIMESTAMP WHERE id=?",
        [agyId, ownCompanyId, existingAny.id],
      );
    } else {
      db.run(
        `INSERT INTO agency_administrators (id, agency_id, user_id, company_id, role_code, assigned_by, assigned_at, status)
         VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,'ACTIVE')`,
        [id, agyId, u.id, ownCompanyId, 'AGENCY_ADMIN', null],
      );
    }
    repaired += 1;
    console.log(`REPAIRED ${u.email} (sub_agency) → own agency ${agyId} (${code}) under ${parent.id} (${parent.name})`);
    continue;
  }

  // Stale REVOKED row surviving to here (agency-level account): UPDATE it —
  // UNIQUE(user_id) forbids a second row.
  if (existingAny) {
    db.run(
      "UPDATE agency_administrators SET status='ACTIVE', agency_id=?, revoked_at=NULL, revoked_by=NULL, assigned_at=CURRENT_TIMESTAMP WHERE id=?",
      [agency.id, existingAny.id],
    );
    repaired += 1;
    console.log(`REPAIRED (revive) ${u.email} (${u.hierarchy_role}) → agency ${agency.id} (${agency.name})`);
    continue;
  }

  if (!agency) {
    console.log(`SKIP ${u.email} (${u.hierarchy_role}): no resolvable agency.`);
    continue;
  }

  const id = generateId('aad');
  db.run(
    `INSERT INTO agency_administrators (id, agency_id, user_id, company_id, role_code, assigned_by, assigned_at, status)
     VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,'ACTIVE')`,
    [id, agency.id, u.id, u.company_id, 'AGENCY_ADMIN', null],
  );
  repaired += 1;
  console.log(`REPAIRED ${u.email} (${u.hierarchy_role}) → agency ${agency.id} (${agency.name})`);
}
console.log(`Done. ${repaired} link(s) inserted, ${users.length} account(s) inspected.`);
