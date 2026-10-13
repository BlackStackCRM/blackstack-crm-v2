#!/usr/bin/env node
/**
 * PREFLIGHT — refuse to operate on the production database without saying so.
 *
 * WHY THIS EXISTS
 *   server/database/connection.js resolves the database as
 *     process.env.DB_PATH || <production default>
 *   and migrate() runs on boot. So any process started WITHOUT DB_PATH opens the
 *   live database and writes to it. That is not hypothetical: during the Mother
 *   Company phase an ad-hoc diagnostic read a misspelled variable, received
 *   undefined, and auto-applied migration 085 to production. It happened to be
 *   additive and lossless, but the next one might not be.
 *
 *   Every helper that starts a server or touches a database should call this
 *   first. It is deliberately cheap and has no side effects.
 *
 * USAGE
 *   node scripts/require-disposable-db.js            # exits 1 if DB_PATH is unset
 *   node scripts/require-disposable-db.js --allow-production
 *
 * EXIT CODES
 *   0 — DB_PATH is set to a recognisably disposable file, or production was
 *       explicitly allowed
 *   1 — DB_PATH is unset, or points at the live database without permission
 */
'use strict';

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROD = path.resolve(ROOT, 'data', 'blackstack-crm.db');
const MARKERS = ['test', 'e2e', 'debug', 'tmp', 'temp', 'scratch', 'acceptance', 'disposable', 'isolated', 'clone'];

const allowProduction = process.argv.includes('--allow-production');
const raw = process.env.DB_PATH;

function fail(msg) {
  console.error(`[db-safety] REFUSING: ${msg}`);
  console.error(`[db-safety]   DB_PATH = ${raw === undefined ? '(unset)' : raw}`);
  console.error('[db-safety]   The app falls back to the production database when DB_PATH is');
  console.error('[db-safety]   unset, and migrates it on boot. Point DB_PATH at a disposable copy:');
  console.error('[db-safety]     DB_PATH="$PWD/data/e2etest/suite-e2e.db"');
  process.exit(1);
}

if (raw === undefined || raw === '') {
  fail('DB_PATH is not set.');
}

const resolved = path.resolve(raw);
if (resolved === PROD) {
  if (allowProduction) {
    console.warn('[db-safety] WARNING: operating on the PRODUCTION database (explicitly allowed).');
    process.exit(0);
  }
  fail('DB_PATH points at the live database.');
}

const base = path.basename(resolved).toLowerCase();
if (!MARKERS.some((m) => base.includes(m))) {
  fail(`filename "${base}" carries no disposable marker (looked for: ${MARKERS.join(', ')}).`);
}

console.log(`[db-safety] OK — ${resolved}`);
