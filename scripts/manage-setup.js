#!/usr/bin/env node
/**
 * Setup state management CLI for BlackStack CRM V2.
 *
 * Usage:
 *   node scripts/manage-setup.js status            # print current setup state
 *   node scripts/manage-setup.js activate <key>    # run activation check
 *   node scripts/manage-setup.js admin <email>     # get/verify the first admin
 *   node scripts/manage-setup.js company           # get the initial company
 *   node scripts/manage-setup.js reset             # reset setup states (test only)
 *   node scripts/manage-setup.js init              # seed a fresh install (demo)
 *
 * SECURITY: the activation key is loaded from server/config/activation.json,
 * never from this script or any source file outside it. Never log it.
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// ── Paths ──────────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(ROOT, 'data', 'blackstack-crm.db');
const ACTIVATION_PATH = path.resolve(ROOT, 'server', 'config', 'activation.json');
const SETUP_STATE_KEY = 'initial_setup';
const VALID_STEPS = ['NOT_ACTIVATED', 'ACTIVATED', 'ADMIN_CREATED', 'COMPANY_CREATED', 'SETUP_COMPLETE'];

// ── Helpers ────────────────────────────────────────────────────────────────
function log(...args) {
  console.log('[manage-setup]', ...args);
}

function fail(msg) {
  console.error('[manage-setup] ERROR:', msg);
  process.exit(1);
}

function getConn() {
  return new DatabaseSync(DATA);
}

function resolveActivationKey() {
  try {
    const raw = fs.readFileSync(ACTIVATION_PATH, 'utf8').trim();
    return raw;
  } catch (err) {
    // Missing config file = no key configured. This is not an error here;
    // the server only needs this in an explicit 'activate' CLI check.
    return null;
  }
}

// ── Status ─────────────────────────────────────────────────────────────────
function status() {
  try {
    const db = getConn();
    const row = db.prepare(
      `SELECT
         s.key,
         s.step,
         s.active_at,
         s.admin_user_id,
         s.admin_email,
         s.admin_full_name,
         s.company_id,
         s.company_name,
         s.completed_at
       FROM setup_states s
       WHERE s.key = ? LIMIT 1`,
      [SETUP_STATE_KEY]
    ).get();
    db.close();
    if (!row) {
      log('No setup state record found.');
      log('  state: NOT_ACTIVATED (no record)');
      return;
    }
    const steps = ['NOT_ACTIVATED', 'ACTIVATED', 'ADMIN_CREATED', 'COMPANY_CREATED', 'SETUP_COMPLETE'];
    const idx = steps.indexOf(row.step);
    const completed = idx < 0 ? [] : steps.slice(0, idx + 1);
    const current = row.step;
    const total = steps.length;
    const bar = '█'.repeat(Math.min(idx + 1, total)) + '░'.repeat(Math.max(total - idx - 1, 0));
    log('Setup progress bar: [' + bar + ']  (' + completed.length + '/' + total + ')');
    log('  Current step : ' + current);
    log('  Completed    : ' + completed.join(' -> '));
    log('  Active at    : ' + (row.active_at || '-'));
    log('  Admin user ID: ' + (row.admin_user_id || '-'));
    log('  Admin email  : ' + (row.admin_email || '-'));
    log('  Admin name   : ' + (row.admin_full_name || '-'));
    log('  Company ID   : ' + (row.company_id || '-'));
    log('  Company name : ' + (row.company_name || '-'));
    log('  Completed at : ' + (row.completed_at || '-'));
  } catch (err) {
    fail('Failed to read setup state: ' + err.message);
  }
}

// ── Activate ───────────────────────────────────────────────────────────────
function activate(keyArg) {
  const configuredKey = resolveActivationKey();
  const entered = (keyArg || '').trim();
  if (configuredKey === null) {
    fail('No activation key configured. Create server/config/activation.json first.');
  }
  if (entered === '') {
    fail('Activation key is required.');
  }
  if (entered !== configuredKey) {
    fail('Invalid activation key.');
  }
  try {
    const db = getConn();
    const row = db.prepare(
      `SELECT
         id,
         key,
         step,
         active_at,
         company_id,
         company_name,
         admin_user_id,
         admin_email,
         admin_full_name,
         completed_at
       FROM setup_states
       WHERE key = ?
       ORDER BY id DESC
       LIMIT 1`
    ).get(SETUP_STATE_KEY);
    db.close();
    if (!row) {
      fail('No setup state found after activation. Run "manage-setup.js status" for details.');
    }
    log('Activation verified.');
    log('  State        : ' + row.step);
    log('  Active at    : ' + row.active_at);
    log('  Company      : ' + (row.company_name || '(none)'));
    log('  Admin email  : ' + (row.admin_email || '(none)'));
    return row;
  } catch (err) {
    fail('Activation check failed: ' + err.message);
  }
}

// ── Get Admin ──────────────────────────────────────────────────────────────
function getAdmin() {
  try {
    const db = getConn();
    const row = db.prepare(
      `SELECT
         s.id as state_id,
         s.step,
         u.id as admin_user_id,
         u.email,
         u.full_name,
         u.role,
         u.status,
         u.created_at,
         s.admin_user_id,
         s.admin_email,
         s.admin_full_name,
         c.id as company_id,
         c.name as company_name
       FROM setup_states s
       LEFT JOIN users u ON u.id = s.admin_user_id
       LEFT JOIN companies c ON c.id = s.company_id
       WHERE s.key = ?
       ORDER BY s.id DESC
       LIMIT 1`,
      [SETUP_STATE_KEY]
    ).get();
    db.close();
    if (!row) {
      log('No initial admin exists yet. Setup has not been started.');
      return null;
    }
    if (row.admin_user_id) {
      log('Initial admin:');
      log('  ID          : ' + row.admin_user_id);
      log('  Email       : ' + row.email);
      log('  Full name   : ' + row.full_name);
      log('  Role        : ' + row.role);
      log('  Status      : ' + row.status);
      log('  Created at  : ' + (row.created_at || '-'));
      log('  State       : ' + (row.state_id ? row.step : '-'));
      log('  Company     : ' + (row.company_id ? row.company_name : '-'));
      return row;
    }
    log('No admin account has been created. Admin creation has not completed.');
    return null;
  } catch (err) {
    fail('Failed to read admin: ' + err.message);
  }
}

// ── Get Company ────────────────────────────────────────────────────────────
function getCompany() {
  try {
    const db = getConn();
    const row = db.prepare(
      `SELECT
         s.id as state_id,
         s.step,
         c.id,
         c.name,
         c.status,
         c.created_at
       FROM setup_states s
       LEFT JOIN companies c ON c.id = s.company_id
       WHERE s.key = ?
       ORDER BY s.id DESC
       LIMIT 1`,
      [SETUP_STATE_KEY]
    ).get();
    db.close();
    if (!row) {
      log('No company exists yet for this installation.');
      return null;
    }
    log('Initial company:');
    log('  ID          : ' + row.id);
    log('  Name        : ' + row.name);
    log('  Status      : ' + row.status);
    log('  Created at  : ' + (row.created_at || '-'));
    log('  Current step: ' + (row.state_id ? row.step : '-'));
    return row;
  } catch (err) {
    fail('Failed to read company: ' + err.message);
  }
}

// ── Reset (test only) ──────────────────────────────────────────────────────
function reset() {
  try {
    const db = getConn();
    db.prepare(`DELETE FROM setup_states WHERE key = ?`).run(SETUP_STATE_KEY);
    db.close();
    log('Setup states cleared.');
  } catch (err) {
    fail('Failed to reset setup state: ' + err.message);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
const [node, script, ...args] = process.argv;
if (args.length === 0) {
  log('BlackStack CRM V2 - Setup State Management');
  log('Usage:');
  log('  node scripts/manage-setup.js status       # print current setup state');
  log('  node scripts/manage-setup.js activate <key>');
  log('  node scripts/manage-setup.js admin        # get/verify the first admin');
  log('  node scripts/manage-setup.js company      # get the initial company');
  log('  node scripts/manage-setup.js reset        # reset setup states (test only)');
  log('  node scripts/manage-setup.js init         # seed a fresh install (demo) - do NOT use');
  process.exit(0);
}

const action = args[0];
if (action === 'status') {
  status();
} else if (action === 'activate') {
  if (args.length < 2) fail('Usage: node scripts/manage-setup.js activate <key>');
  activate(args[1]);
} else if (action === 'admin') {
  getAdmin();
} else if (action === 'company') {
  getCompany();
} else if (action === 'reset') {
  reset();
} else if (action === 'init') {
  fail('init is intentionally blocked. This CLI never seeds data. Use DEMO_MODE seed only.');
} else {
  fail('Unknown action: ' + action);
}
