#!/usr/bin/env node

/**
 * BlackStack CRM V2 — Setup Script
 *
 * Usage:
 *   node setup.js            # interactive setup
 *   node setup.js --dev      # development setup with demo data
 *   node setup.js --prod     # production setup (no demo data)
 *   node setup.js --reset    # reset database and re-run setup
 *
 * What this does:
 *   1. Checks Node.js version (>= 18)
 *   2. Installs npm dependencies
 *   3. Creates .env from .env.example (or prompts for values)
 *   4. Creates data/ directory
 *   5. Runs database migrations
 *   6. Seeds admin user and optional demo data
 *   7. Verifies the installation
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname);
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'blackstack-crm.db');

const isDev = process.argv.includes('--dev');
const isProd = process.argv.includes('--prod');
const isReset = process.argv.includes('--reset');

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function log(msg, color = 'reset') {
  console.log(`${COLORS[color]}${msg}${COLORS.reset}`);
}

function logStep(step, total, msg) {
  log(`\n[${step}/${total}] ${msg}`, 'cyan');
}

function checkNodeVersion() {
  const version = process.version;
  const major = parseInt(version.replace('v', '').split('.')[0], 10);
  if (major < 18) {
    log(`ERROR: Node.js >= 18 is required. You are running ${version}.`, 'red');
    process.exit(1);
  }
  log(`Node.js version: ${version} (OK)`, 'green');
}

function installDependencies() {
  log('Installing npm dependencies...', 'yellow');
  try {
    execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
    log('Dependencies installed successfully.', 'green');
  } catch (err) {
    log('ERROR: Failed to install dependencies.', 'red');
    process.exit(1);
  }
}

function createEnvFile() {
  if (fs.existsSync(ENV_FILE) && !isReset) {
    log('.env file already exists. Skipping.', 'yellow');
    return;
  }

  if (!fs.existsSync(ENV_EXAMPLE)) {
    log('ERROR: .env.example not found.', 'red');
    process.exit(1);
  }

  const example = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const envVars = {};

  for (const line of example.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, value] = trimmed.split('=');
    if (!key || value === undefined) continue;
    envVars[key.trim()] = value.trim();
  }

  if (isProd) {
    envVars.NODE_ENV = 'production';
    envVars.CORS_ORIGIN = '';
  } else {
    envVars.NODE_ENV = 'development';
    envVars.CORS_ORIGIN = '*';
  }

  const jwtSecret = generateSecret();
  envVars.JWT_SECRET = jwtSecret;

  if (isDev) {
    envVars.DEMO_MODE = 'true';
  }

  const content = Object.entries(envVars)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n';

  fs.writeFileSync(ENV_FILE, content, 'utf8');
  log('.env file created.', 'green');
  log(`JWT_SECRET generated: ${jwtSecret.substring(0, 16)}...`, 'yellow');
}

function generateSecret() {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
}

function createDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    log('data/ directory created.', 'green');
  } else {
    log('data/ directory already exists.', 'yellow');
  }
}

function runMigrations() {
  log('Running database migrations...', 'yellow');
  try {
    const { migrate } = require('./server/database/migrate');
    migrate();
    log('Migrations completed successfully.', 'green');
  } catch (err) {
    log(`ERROR: Migration failed: ${err.message}`, 'red');
    process.exit(1);
  }
}

function seedDatabase() {
  log('Seeding database...', 'yellow');
  try {
    process.env.DEMO_MODE = isDev ? 'true' : 'false';
    const { seed } = require('./server/database/seed');
    seed();
    log('Database seeded successfully.', 'green');
  } catch (err) {
    log(`ERROR: Seeding failed: ${err.message}`, 'red');
    process.exit(1);
  }
}

function verifyInstallation() {
  log('Verifying installation...', 'yellow');

  if (!fs.existsSync(ENV_FILE)) {
    log('ERROR: .env file not found.', 'red');
    process.exit(1);
  }

  if (!fs.existsSync(DB_PATH)) {
    log('ERROR: Database file not found at ' + DB_PATH, 'red');
    process.exit(1);
  }

  const dbSize = fs.statSync(DB_PATH).size;
  log(`Database file: ${DB_PATH} (${dbSize} bytes)`, 'green');

  const { DatabaseConnection } = require('./server/database/connection');
  const db = new DatabaseConnection();
  const conn = db.connect();

  try {
    const tables = conn.all(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    const tableNames = tables.map(t => t.name);
    log(`Tables created: ${tableNames.length}`, 'green');
    tableNames.forEach(name => {
      const count = conn.get(`SELECT COUNT(*) as c FROM ${name}`);
      log(`  - ${name}: ${count.c} rows`, 'reset');
    });
  } catch (err) {
    log(`ERROR: Verification failed: ${err.message}`, 'red');
    process.exit(1);
  } finally {
    db.close();
  }

  log('\nVerification complete.', 'green');
}

function printNextSteps() {
  log('\n========================================', 'bold');
  log('  BlackStack CRM V2 — Setup Complete', 'bold');
  log('========================================\n', 'bold');

  if (isDev) {
    log('Development setup complete!', 'green');
    log('\nNext steps:', 'cyan');
    log('  1. Start the server:  npm run dev', 'reset');
    log('  2. Open in browser:   http://localhost:3000', 'reset');
    log('  3. Login with:        sooryagenuspayyna183@gmail.com / admin123', 'reset');
    log('  4. Run tests:         npm test', 'reset');
  } else if (isProd) {
    log('Production setup complete!', 'green');
    log('\nNext steps:', 'cyan');
    log('  1. Review .env file and ensure JWT_SECRET is secure', 'reset');
    log('  2. Start the server:  npm start', 'reset');
    log('  3. Open in browser:   http://localhost:3000', 'reset');
    log('  4. Create admin user: node scripts/create-admin.js', 'reset');
  } else {
    log('Setup complete!', 'green');
    log('\nNext steps:', 'cyan');
    log('  1. Start the server:  npm start', 'reset');
    log('  2. Open in browser:   http://localhost:3000', 'reset');
    log('  3. Login with the admin credentials you set during seeding', 'reset');
    log('  4. Run tests:         npm test', 'reset');
  }

  log('\nFor more information, see README.md\n', 'yellow');
}

function main() {
  log('========================================', 'bold');
  log('  BlackStack CRM V2 — Setup', 'bold');
  log('========================================\n', 'bold');

  const steps = [
    { fn: checkNodeVersion, label: 'Check Node.js version' },
    { fn: installDependencies, label: 'Install dependencies' },
    { fn: createEnvFile, label: 'Create .env file' },
    { fn: createDataDir, label: 'Create data directory' },
    { fn: runMigrations, label: 'Run migrations' },
    { fn: seedDatabase, label: 'Seed database' },
    { fn: verifyInstallation, label: 'Verify installation' },
  ];

  const totalSteps = steps.length;
  for (let i = 0; i < totalSteps; i++) {
    log(`\n[${i + 1}/${totalSteps}] ${steps[i].label}`, 'cyan');
    steps[i].fn();
  }

  printNextSteps();
}

(async () => {
  try {
    await main();
  } catch (err) {
    log(`\nSetup failed: ${err.message}`, 'red');
    process.exit(1);
  }
})();
