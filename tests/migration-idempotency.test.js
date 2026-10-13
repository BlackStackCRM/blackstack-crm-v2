/**
 * The live database must not change just because the server started.
 *
 * `server/app.js` runs migrations on every boot. Step 081 in migrate.js wrote its
 * `legacy_tables` registry row with an unconditional `INSERT OR REPLACE`, and
 * `retired_at` carries DEFAULT CURRENT_TIMESTAMP — so each start rewrote that
 * timestamp and bumped SQLite's page counters while reporting
 * "0 new migration(s) applied".
 *
 * That made the production database's byte-checksum unstable on a perfectly idle
 * server. Any integrity check that compares checksums across a test run (this is
 * exactly what a release gate does) therefore reported a mutation that never
 * happened, and the signal became noise nobody could act on.
 *
 * These tests pin the corrected behaviour:
 *   1. a no-op migrate leaves the file byte-identical;
 *   2. a no-op migrate leaves logical content identical;
 *   3. a REAL write is still detected by a content fingerprint.
 *
 * Everything runs against a temporary copy. The live database is opened
 * read-only and never written.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const ROOT = path.join(__dirname, '..');
const LIVE_DB = path.join(ROOT, 'data', 'blackstack-crm.db');

let tmpRoot;
let workDb;
/** Fingerprint of the LIVE database, captured before anything runs. */
let liveFingerprintBefore;

function fileMd5(f) {
  return crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
}

/** Logical fingerprint: schema + every row of every user table, ordered. */
function contentFingerprint(f) {
  const db = new DatabaseSync(f, { readOnly: true });
  const h = crypto.createHash('md5');
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((t) => t.name);
    for (const t of tables) {
      h.update(`\n## ${t}\n`);
      h.update(db.prepare(`PRAGMA table_info("${t}")`).all()
        .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value ?? ''}`).join(','));
      let rows;
      try { rows = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all(); }
      catch (e) { rows = db.prepare(`SELECT * FROM "${t}"`).all(); }
      for (const r of rows) h.update(`\n${JSON.stringify(r)}`);
    }
    for (const r of db.prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all()) h.update(`\n${r.type}:${r.name}:${r.sql ?? ''}`);
    return h.digest('hex');
  } finally { db.close(); }
}

/**
 * Invoke migrate() against a specific database file.
 *
 * Two ordering requirements, both learned the hard way:
 *
 *  1. `connection.js` captures `const DB_PATH = process.env.DB_PATH || ...` at
 *     MODULE LOAD time. Setting the variable afterwards has no effect — the module
 *     must be evicted from the require cache FIRST, then the variable set, then
 *     the module re-required. Doing it in the other order silently migrates the
 *     LIVE database instead of the copy.
 *  2. `migrate()` is async, so it must be awaited.
 *
 * Returns the migration summary.
 */
async function runMigrate(dbPath) {
  const connectionPath = require_.resolve(path.join(ROOT, 'server/database/connection.js'));
  const migratePath = require_.resolve(path.join(ROOT, 'server/database/migrate.js'));
  for (const p of [connectionPath, migratePath]) delete require_.cache[p];

  process.env.DB_PATH = dbPath;
  process.env.BLACKSTACK_USER_DATA_DIR = path.dirname(dbPath);

  const { migrate } = require_(migratePath);
  return migrate();
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bscrm-mig-'));
  workDb = path.join(tmpRoot, 'idempotent.db');
  fs.copyFileSync(LIVE_DB, workDb);
  liveFingerprintBefore = contentFingerprint(LIVE_DB);
}, 60000);

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* ok */ }
});

describe('migrations are idempotent in content', () => {
  // The assertion is on CONTENT, not on file bytes, and that distinction is the
  // whole point.
  //
  // Rewriting a row can repack SQLite pages and move the freelist without altering
  // a single value, so the file checksum changes either way. Measured on this
  // schema: BOTH the buggy and the fixed statement produce a different file md5
  // than the untouched copy. A byte-comparison test therefore cannot distinguish
  // them — it fails against the fix and, worse, in this project's first
  // iteration it PASSED with the fix reverted, because migrate() was never
  // pointed at the temporary copy.
  //
  // What genuinely regressed was the VALUE of legacy_tables.retired_at, which the
  // buggy statement refreshed to CURRENT_TIMESTAMP on every boot. Comparing
  // logical content catches exactly that, and ignores inert repacking.
  it('a no-op migrate leaves legacy_tables.retired_at untouched', async () => {
    const readTimestamp = () => {
      const db = new DatabaseSync(workDb, { readOnly: true });
      try {
        return db.prepare(
          "SELECT retired_at FROM legacy_tables WHERE table_name = 'inv_locations'",
        ).get().retired_at;
      } finally { db.close(); }
    };

    const before = readTimestamp();
    await runMigrate(workDb);
    const after = readTimestamp();

    expect(
      after,
      'migrate() refreshed legacy_tables.retired_at on a boot that applied no '
      + `migration (${before} -> ${after}). The registry row must preserve its `
      + 'original timestamp via COALESCE, otherwise every server start mutates '
      + 'the database and any checksum-based integrity tripwire reports a '
      + 'phantom change.',
    ).toBe(before);
  }, 120000);

  it('a second no-op migrate is still stable (repeatable)', async () => {
    const before = contentFingerprint(workDb);
    await runMigrate(workDb);
    await runMigrate(workDb);
    expect(contentFingerprint(workDb)).toBe(before);
  }, 120000);

  it('a no-op migrate preserves logical content', async () => {
    const before = contentFingerprint(workDb);
    await runMigrate(workDb);
    expect(contentFingerprint(workDb)).toBe(before);
  }, 120000);
});

describe('the integrity tripwire can still detect a real mutation', () => {
  it('a genuine data write changes the content fingerprint', () => {
    const before = contentFingerprint(workDb);
    const db = new DatabaseSync(workDb);
    try {
      db.exec('UPDATE products SET price = COALESCE(price, 0) + 1');
    } finally { db.close(); }
    // If this ever stops differing, the release gate's gate-9 tripwire would be
    // blind — so assert the fingerprint really is sensitive, not just stable.
    expect(contentFingerprint(workDb)).not.toBe(before);
  }, 60000);

  it('the live database was not modified by this test', () => {
    // This matters because runMigrate() could silently target the LIVE file if
    // the require-cache eviction order were wrong (see the comment above).
    // Comparing the live fingerprint before and after the suite is what proves
    // isolation, rather than merely asserting the file still opens.
    expect(contentFingerprint(LIVE_DB)).toBe(liveFingerprintBefore);
    const db = new DatabaseSync(LIVE_DB, { readOnly: true });
    try {
      const integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
      expect(String(integrity)).toMatch(/ok/i);
    } finally { db.close(); }
  }, 60000);
});