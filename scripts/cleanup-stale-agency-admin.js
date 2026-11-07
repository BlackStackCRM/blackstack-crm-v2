#!/usr/bin/env node
/*
 * One-time removal of the stale jinu123@gmail.com identity from local SQLite.
 * Dry-run by default. Run with --apply to back up and delete. This script is
 * intentionally pinned to both the observed id and normalized email.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const TARGET_ID = 'usr_01M6NQ86RX3MRG0PGW5QWN96M7';
const TARGET_EMAIL = 'jinu123@gmail.com';
const dbPath = path.resolve(process.env.DB_PATH || path.join(__dirname, '../data/blackstack-crm.db'));
const apply = process.argv.includes('--apply');
const quote = (v) => `"${String(v).replace(/"/g, '""')}"`;

const db = new DatabaseSync(dbPath);
try {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;');
  const user = db.prepare('SELECT id, email, status, supabase_user_id FROM users WHERE id = ?').get(TARGET_ID);
  if (!user || String(user.email).trim().toLowerCase() !== TARGET_EMAIL) {
    throw new Error('Pinned target id/email did not match; refusing cleanup.');
  }

  const refs = [];
  const deletableLinkTables = new Set(['agency_administrators', 'user_roles']);
  for (const { name: table } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    if (table.startsWith('sqlite_')) continue;
    const tableName = quote(table);
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    for (const column of columns) {
      const looksLikeUserRef = /(^|_)(user|owner|assignee|assigned|actor|created_by|updated_by|parent_user)(_|$)|^(created_by|updated_by|assigned_by|revoked_by)$/i.test(column.name);
      if (!looksLikeUserRef) continue;
      let count = 0;
      try {
        count = db.prepare(`SELECT COUNT(*) AS n FROM ${tableName} WHERE ${quote(column.name)} = ?`).get(TARGET_ID).n;
      } catch { continue; }
      if (count && !deletableLinkTables.has(table)) refs.push({ table, column: column.name, count });
    }
  }
  if (refs.length) {
    throw new Error(`Dependencies found; deletion refused: ${JSON.stringify(refs)}`);
  }

  const authLink = user.supabase_user_id || null;
  if (authLink) {
    throw new Error('User has a Supabase Auth link. Remove/verify that Auth identity through the managed hard-delete flow first.');
  }

  const summary = {
    database: dbPath,
    targetId: user.id,
    email: user.email,
    status: user.status,
    agencyAdministratorLinks: db.prepare('SELECT COUNT(*) AS n FROM agency_administrators WHERE user_id = ?').get(TARGET_ID).n,
    roleLinks: db.prepare('SELECT COUNT(*) AS n FROM user_roles WHERE user_id = ?').get(TARGET_ID).n,
    dependencies: refs,
    mode: apply ? 'APPLY' : 'DRY_RUN',
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!apply) {
    console.log('Dry run only. Re-run with --apply after reviewing this report.');
    process.exitCode = 0;
  } else {
    const backupPath = `${dbPath}.pre-jinu-cleanup-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.backup`;
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM agency_administrators WHERE user_id = ?').run(TARGET_ID);
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(TARGET_ID);
      db.prepare('DELETE FROM users WHERE id = ? AND lower(trim(email)) = lower(?)').run(TARGET_ID, TARGET_EMAIL);
      const remaining = db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(TARGET_ID).n;
      if (remaining !== 0) throw new Error('Target row still exists after delete transaction.');
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
      throw error;
    }
    console.log(JSON.stringify({ deleted: true, backupPath }));
  }
} finally {
  db.close();
}
