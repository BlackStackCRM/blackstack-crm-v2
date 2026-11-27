/**
 * tests/services/testDbSetup.js
 *
 * Test-only fixture for tests/services/retry-worker.test.js.
 *
 * The retry-worker test suite points process.env.DB_PATH at a throwaway SQLite
 * file and then requires this module, which must ensure that file EXISTS and
 * carries the tables the retry worker reads (agencies + cloud_sync_status).
 * This module was referenced by commit 53088d1 but was never committed — the
 * six long-standing retry-worker failures are "Cannot find module
 * './testDbSetup'".
 *
 * SAFETY: this file only ever touches the path in process.env.DB_PATH. It
 * refuses to run against the production database (data/blackstack-crm.db), so
 * it can never mutate live data even if a caller forgets to set DB_PATH.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PROD_DB = path.resolve(__dirname, '..', '..', 'data', 'blackstack-crm.db');

function ensureTestDb() {
  const dbPath = process.env.DB_PATH;
  if (!dbPath) {
    throw new Error('[testDbSetup] DB_PATH is not set. Refusing to guess a database.');
  }
  const resolved = path.resolve(dbPath);
  if (resolved === PROD_DB) {
    throw new Error(
      `[testDbSetup] REFUSING TO RUN: DB_PATH points at the production database (${resolved}).` +
        ' Point DB_PATH at a throwaway file whose name contains a disposable marker.',
    );
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(resolved);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agencies (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      provider_company_id TEXT,
      agency_code TEXT,
      name TEXT,
      legal_name TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      country TEXT,
      pincode TEXT,
      status TEXT,
      is_active INTEGER,
      created_by TEXT,
      created_at DATETIME,
      updated_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS cloud_sync_status (
      id TEXT PRIMARY KEY,
      agency_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','SYNCED','FAILED')),
      attempts INTEGER NOT NULL DEFAULT 0,
      started_at DATETIME,
      finished_at DATETIME,
      error_message TEXT,
      updated_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS agency_administrators (
      id TEXT PRIMARY KEY,
      agency_id TEXT,
      email TEXT,
      full_name TEXT,
      phone TEXT,
      status TEXT,
      is_primary INTEGER,
      created_at DATETIME,
      updated_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS agency_status_history (
      id TEXT PRIMARY KEY,
      agency_id TEXT,
      old_status TEXT,
      new_status TEXT,
      reason TEXT,
      actor_id TEXT,
      created_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      company_id TEXT,
      user_id TEXT,
      action TEXT,
      entity_type TEXT,
      entity_id TEXT,
      details TEXT,
      created_at DATETIME
    );
  `);
  db.close();
  return resolved;
}

module.exports = ensureTestDb;

if (require.main === module) {
  try {
    console.log(`[testDbSetup] ensured test database at ${ensureTestDb()}`);
  } catch (e) {
    console.error(`[testDbSetup] FATAL: ${e.message}`);
    process.exit(1);
  }
}
