import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseConfig } from '../../src/config/validation.js';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

/**
 * All license-server tests must use a DISPOSABLE (temporary) database only.
 * The CRM database is NEVER opened by this test suite.
 */
function disposableDb() {
  const dir = require_('node:fs').mkdtempSync(require_('node:path').join((process.env.LICENSE_SERVER_TEST_TMPDIR || require_('node:os').tmpdir()), 'license-server-test-'));
  const dbPath = require_('node:path').join(dir, 'license.db');
  return { dbPath, dir, cleanup: () => require_('node:fs').rmSync(dir, { recursive: true, force: true }) };
}

describe('disposable-database tests (no CRM access)', () => {
  let db;
  let cleanup: () => void;
  let dbPath: string;

  beforeEach(() => {
    const d = disposableDb();
    dbPath = d.dbPath;
    db = new DatabaseSync(d.dbPath);
    db.exec(`CREATE TABLE licenses (
      id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, product_id TEXT NOT NULL,
      code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE',
      device_limit INTEGER NOT NULL DEFAULT 1, lease_days INTEGER NOT NULL DEFAULT 30,
      allocated INTEGER NOT NULL DEFAULT 0, allocated_at TEXT, expires_at TEXT,
      created_by TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );`);
    db.prepare(
      `INSERT INTO licenses (id, agency_id, product_id, code, device_limit, lease_days, allocated, expires_at)
       VALUES ('LIC-1', 'AG-1', 'PROD-1', 'LIC-1', 1, 30, 0, NULL)`,
    ).run();
    cleanup = d.cleanup;
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  it('reads license within quota', () => {
    const row = db.prepare('SELECT allocated FROM licenses WHERE id = ?').get('LIC-1') as any;
    expect(row.allocated).toBe(0);
  });

  it('uses config DB_PATH pointing to this disposable db only', () => {
    const cfg = parseConfig({
      PORT: '8443',
      DB_PATH: dbPath,
      TOKEN_AUDIENCE: 'license-server',
      JWT_SECRET: 'a'.repeat(64),
    });
    expect(cfg.dbPath).toBe(dbPath);
  });

  it('refuses a CRM-database DB_PATH (fail-closed)', () => {
    expect(() =>
      parseConfig({ PORT: '8443', DB_PATH: 'data/blackstack-crm.db', TOKEN_AUDIENCE: 'license-server', JWT_SECRET: 'a'.repeat(64) }),
    ).toThrow();
  });
});
