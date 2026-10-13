#!/usr/bin/env node
/**
 * Phase D Step 3 — deterministic migration failure injector.
 *
 * Appends a TEMPORARY migration file into server/database/migrations/, runs the
 * application's REAL migration runner (server/database/migrate.js), then removes
 * the file again.
 *
 * The injected migration deliberately:
 *   1. opens a transaction (the runner already wraps each file in one),
 *   2. performs REAL, observable writes across several tables, then
 *   3. throws partway through.
 *
 * Because migrate.js runs `conn.transaction(() => { conn.exec(content); ... })`,
 * the throw must roll the whole thing back. That is exactly the property
 * Recovery Test C needs to prove — and it is proven against production code
 * that is NOT modified to hide the failure.
 *
 * Usage: node phase-d-fail-migration.js <dbFile>
 */
const fs = require('fs');
const path = require('path');

const dbFile = path.resolve(process.argv[2] || '');
if (!dbFile || !fs.existsSync(dbFile)) {
  console.error('usage: phase-d-fail-migration.js <dbFile>');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'server', 'database', 'migrations');
process.env.DB_PATH = dbFile;
process.env.BLACKSTACK_USER_DATA_DIR = path.join(path.dirname(path.dirname(dbFile)), 'userdata');
process.env.DEMO_MODE = 'true';

// Pick a version above every existing migration so the runner treats it as new.
function nextVersion() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const nums = files.map((f) => parseInt(f.split('_')[0], 10)).filter((n) => !Number.isNaN(n));
  return Math.max(...nums) + 1;
}

const version = nextVersion();
const fileName = `${version}_step3_injected_failure.sql`;
const filePath = path.join(MIGRATIONS_DIR, fileName);

// Real writes, then a hard failure. SELECT RAISE(ABORT) cannot be used inside a
// plain SQL script for this purpose, so we use a construct that fails at exec
// time after the earlier statements have already taken effect inside the
// transaction.
const content = `
-- Phase D Step 3 — TEMPORARY injected failure. Removed immediately after the run.
CREATE TABLE IF NOT EXISTS step3_fail_probe (id TEXT PRIMARY KEY, note TEXT);
INSERT INTO step3_fail_probe (id, note) VALUES ('probe-1', 'written before failure');
INSERT INTO step3_fail_probe (id, note) VALUES ('probe-2', 'also written before failure');
INSERT INTO step3_fail_probe (id, note) VALUES ('probe-2', 'DUPLICATE PRIMARY KEY -> abort');
`.trim();

fs.writeFileSync(filePath, content, 'utf8');
console.log(`[inject] wrote ${fileName} (version ${version}) into the REAL migrations dir`);
console.log('[inject] content will insert 2 rows then abort on a duplicate PK');

async function main() {
  const { migrate } = require('../server/database/migrate');
  let failed = false;
  try {
    await migrate();
    console.log('[inject] ERROR: migration did NOT fail — the injection is broken');
  } catch (e) {
    failed = true;
    console.log(`[inject] migration failed as intended: ${e.message.split('\n')[0].slice(0, 160)}`);
  } finally {
    // Always remove the temporary migration.
    try { fs.unlinkSync(filePath); console.log(`[inject] removed ${fileName}`); } catch { /* noop */ }
  }

  // Prove the transaction rolled back: the probe rows must NOT exist.
  const { DatabaseSync } = require('node:sqlite');
  let probeRows = -1, probeTable = false;
  const tmp = path.join(require('os').tmpdir(), `pd3-probe-${process.pid}-${Date.now()}.db`);
  try {
    for (const ext of ['', '-wal', '-shm']) {
      if (fs.existsSync(dbFile + ext)) fs.copyFileSync(dbFile + ext, tmp + ext);
    }
    const db = new DatabaseSync(tmp);
    try {
      const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='step3_fail_probe'").get();
      probeTable = !!t;
      if (t) probeRows = db.prepare('SELECT COUNT(*) c FROM step3_fail_probe').get().c;
    } catch (e) { probeRows = -1; }
    db.close();
  } finally {
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch {} }
  }
  console.log(`[inject] probe table exists after failure : ${probeTable}`);
  console.log(`[inject] probe rows persisted            : ${probeRows}  (0 = rolled back)`);

  process.exit(failed && probeRows === 0 ? 7 : 1);
}

main().catch((e) => { console.error('[inject] harness error:', e.message); try { fs.unlinkSync(filePath); } catch {} process.exit(1); });
