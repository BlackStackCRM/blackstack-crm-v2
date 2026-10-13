/**
 * PHASE 2 TESTS — Electron desktop layer
 * Run: npx vitest run tests/electron-safety.test.js
 *
 * Covers:
 *  - Portable DB migration into userData (idempotent, backed up, verified)
 *  - Migration refuses to proceed without valid backup; never creates blank DB
 *  - UpdateService provider binding (Phase 1 abstraction)
 *  - Update logger
 *
 * No Electron runtime needed — these test the pure Node modules.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

let tmpRoot;
let prodDb;

const PROJ = path.resolve(__dirname, '..');
const ABS = {
  userDataPath: path.join(PROJ, 'server', 'config', 'userDataPath.js').replace(/\\/g, '/'),
  version: path.join(PROJ, 'server', 'version.js').replace(/\\/g, '/'),
};

function loadFresh() {
  // Copy modules to a temp dir (to bust require cache) and rewrite their
  // relative requires to absolute paths of the originals.
  const tmp = path.join(tmpRoot, 'modules');
  fs.mkdirSync(tmp, { recursive: true });
  const rels = {
    'userDataPath.js': 'server/config/userDataPath.js',
    'backupService.js': 'server/services/backupService.js',
    'db-migration.js': 'electron/db-migration.js',
  };
  for (const [name, rel] of Object.entries(rels)) {
    const srcPath = path.join(PROJ, rel);
    let code = fs.readFileSync(srcPath, 'utf8');
    code = code
      .replace(/require\('\.\.\/config\/userDataPath'\)/g, `require('${ABS.userDataPath}')`)
      .replace(/require\('\.\.\/version'\)/g, `require('${ABS.version}')`)
      .replace(/require\('\.\/version'\)/g, `require('${ABS.version}')`)
      .replace(/require\('\.\.\/server\/version'\)/g, `require('${ABS.version}')`)
      .replace(/require\('\.\.\/server\/config\/userDataPath'\)/g, `require('${ABS.userDataPath}')`)
      // db-migration.js dynamic requires
      .replace(/path\.join\(__dirname, '\.\.', 'server', 'config', 'userDataPath'\)/g, `'${path.join(PROJ, 'server', 'config', 'userDataPath.js').replace(/\\/g, '/')}'`)
      .replace(/path\.join\(__dirname, '\.\.', 'server', 'services', 'backupService'\)/g, `'${path.join(PROJ, 'server', 'services', 'backupService.js').replace(/\\/g, '/')}'`);
    fs.writeFileSync(path.join(tmp, name), code);
  }
  const userData = require_(path.join(tmp, 'userDataPath.js'));
  const backup = require_(path.join(tmp, 'backupService.js'));
  const migration = require_(path.join(tmp, 'db-migration.js'));
  return { ...userData, ...backup, ...migration };
}

function makeSourceDb(withData = true) {
  // Build a small fake "portable" database resembling the real schema.
  const src = path.join(tmpRoot, 'portable-data', 'blackstack-crm.db');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  const db = new DatabaseSync(src);
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, sha256 TEXT, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO schema_migrations (version, name, sha256) VALUES (1, 'test', 'abc');
    CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT);
  `);
  if (withData) {
    db.prepare('INSERT INTO contacts (id, name) VALUES (?, ?)').run('c1', 'Alice');
    db.prepare('INSERT INTO contacts (id, name) VALUES (?, ?)').run('c2', 'Bob');
    db.prepare('INSERT INTO products (id, name) VALUES (?, ?)').run('p1', 'Widget');
  }
  db.close();
  return src;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-electron-'));
  prodDb = path.join(tmpRoot, 'portable-data', 'blackstack-crm.db');
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

describe('Phase 2: Electron database migration', () => {
  it('migrates portable DB into userData with verified backup, idempotent', async () => {
    process.env.BLACKSTACK_USER_DATA_DIR = path.join(tmpRoot, 'userdata');
    process.env.PORTABLE_DB_PATH = makeSourceDb(true);
    const mods = loadFresh();
    const target = path.join(process.env.BLACKSTACK_USER_DATA_DIR, 'database', 'blackstack-crm.db');

    // First run: migration happens
    const r1 = mods.migratePortableDatabase({ targetPath: target, log: () => {} });
    expect(r1.status).toBe('migrated');
    expect(fs.existsSync(target)).toBe(true);
    expect(r1.backupFile).toBeTruthy();

    // Backup verified and data matches
    const check = mods.verifyBackup(r1.backupFile);
    expect(check.valid).toBe(true);

    // Target has the same data
    const db = new DatabaseSync(target);
    expect(db.prepare('SELECT COUNT(*) AS c FROM contacts').get().c).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS c FROM products').get().c).toBe(1);
    db.close();

    // Second run: idempotent — uses existing, no re-copy
    const r2 = mods.migratePortableDatabase({ targetPath: target, log: () => {} });
    expect(r2.status).toBe('existing');

    // Source still exists (never deleted)
    expect(fs.existsSync(process.env.PORTABLE_DB_PATH)).toBe(true);
  });

  it('does nothing destructive when no portable DB exists (fresh install)', async () => {
    process.env.BLACKSTACK_USER_DATA_DIR = path.join(tmpRoot, 'userdata');
    // Explicit "nothing there" — prevents the repo's own data/ from being picked up.
    process.env.PORTABLE_DB_PATH = path.join(tmpRoot, 'nonexistent', 'x.db');
    const mods = loadFresh();
    const target = path.join(process.env.BLACKSTACK_USER_DATA_DIR, 'database', 'blackstack-crm.db');
    const r = mods.migratePortableDatabase({ targetPath: target, log: () => {} });
    expect(r.status).toBe('fresh');
    expect(fs.existsSync(target)).toBe(false); // nothing created prematurely
  });

  it('refuses migration when source DB is corrupt (no blank DB created)', async () => {
    process.env.BLACKSTACK_USER_DATA_DIR = path.join(tmpRoot, 'userdata');
    const src = makeSourceDb(false);
    fs.writeFileSync(src, 'not a database at all');
    process.env.PORTABLE_DB_PATH = src;
    const mods = loadFresh();
    const target = path.join(process.env.BLACKSTACK_USER_DATA_DIR, 'database', 'blackstack-crm.db');
    const r = mods.migratePortableDatabase({ targetPath: target, log: () => {} });
    // Either it fails cleanly at backup/verify stage, or it never created target
    if (r.status === 'error') expect(fs.existsSync(target)).toBe(false);
    else expect(['fresh', 'existing']).toContain(r.status);
  });
});

describe('Phase 2: UpdateService provider binding', () => {
  it('unbound service stays DISABLED (Phase 1 web behavior unchanged)', async () => {
    const { UpdateService } = await import('../server/services/updateService.js?v=u' + Date.now());
    const status = await UpdateService.getUpdateStatus();
    expect(status.status).toBe('DISABLED');
    const version = await UpdateService.getCurrentVersion();
    expect(version.version).toBe('1.0.0');
  });

  it('bound provider is used and errors degrade gracefully', async () => {
    const { UpdateService } = await import('../server/services/updateService.js?v=p' + Date.now());
    UpdateService.bindProvider({
      checkForUpdate: async () => ({ status: 'AVAILABLE', version: '1.1.0' }),
      downloadUpdate: async () => ({ status: 'DOWNLOADING' }),
      installUpdate: async () => ({ ok: true }),
      getUpdateStatus: async () => ({ status: 'DOWNLOADED', version: '1.1.0' }),
    });
    expect((await UpdateService.checkForUpdate()).version).toBe('1.1.0');
    expect((await UpdateService.getUpdateStatus()).status).toBe('DOWNLOADED');
    expect((await UpdateService.installUpdate()).ok).toBe(true);
    UpdateService.bindProvider({
      checkForUpdate: async () => { throw new Error('network down'); },
      getUpdateStatus: async () => { throw new Error('x'); },
    });
    expect((await UpdateService.checkForUpdate()).status).toBe('ERROR');
    expect((await UpdateService.getUpdateStatus()).status).toBe('ERROR');
    UpdateService.bindProvider(null);
  });
});

describe('Phase 2: update logger', () => {
  it('appends structured events without blocking on errors', async () => {
    const { updateLogger } = await import('../electron/update-logger.js?v=l' + Date.now());
    const dir = path.join(tmpRoot, 'logs');
    updateLogger.init(dir);
    updateLogger.event('test-event', { from: '1.0.0', to: '1.1.0' });
    const lines = fs.readFileSync(path.join(dir, 'updates.log'), 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.event).toBe('test-event');
    expect(last.to).toBe('1.1.0');
    // Uninitialized logging must not throw
    updateLogger.state = null;
    expect(() => updateLogger.event('x', {})).not.toThrow();
  });
});
