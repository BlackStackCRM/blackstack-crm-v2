#!/usr/bin/env node
/**
 * HARNESS SELF-TEST — proves the Step 3 runner can actually FAIL.
 *
 * This exists because phase-d-step-3-run.js previously ended with
 *   main().then(() => process.exit(0))
 * which discarded the verdict main() had already stored in process.exitCode.
 * A run with real failures therefore reported EXIT=0.
 *
 * Two controlled runs are performed against an ISOLATED throwaway database.
 * Nothing here touches production: the production DB is moved aside by the same
 * isolation module and restored in a finally block, exactly as the real suite
 * does, so this also exercises the restore path.
 *
 *   1. INJECT_FAILURE=1  -> expects a non-zero exit
 *   2. INJECT_FAILURE=0  -> expects exit 0
 *
 * The shell MUST observe both exit codes correctly.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const PROD_DB = path.join(ROOT, 'data', 'blackstack-crm.db');
const isolation = require('./phase-d-isolation');

const INJECT = process.env.INJECT_FAILURE === '1';
const BASE = path.join(process.env.LOCALAPPDATA, 'Temp', 'pd3-selftest');

// A minimal fingerprint, deliberately distinct from the suite's, so this test
// cannot accidentally pass by reusing a real result.
function fp(file) {
  const tmp = path.join(os.tmpdir(), `pd3-self-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
  for (const e of ['', '-wal', '-shm']) if (fs.existsSync(file + e)) fs.copyFileSync(file + e, tmp + e);
  let db;
  try {
    db = new DatabaseSync(tmp);
  } catch (e) {
    for (const e2 of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + e2); } catch { /* noop */ } }
    return `UNREADABLE:${e.code || e.message.slice(0, 40)}`;
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => t.name);
  const h = crypto.createHash('md5');
  try {
    for (const t of tables) {
      h.update(`\n## ${t}\n`);
      for (const r of db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()) h.update(JSON.stringify(r));
    }
  } catch (e) {
    // Reading damaged pages is the corruption signal.
    try { db.close(); } catch { /* noop */ }
    for (const e2 of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + e2); } catch { /* noop */ } }
    return `CORRUPT:${e.errstr || e.message.slice(0, 40)}`;
  }
  try { db.close(); } catch { /* noop */ }
  for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + e); } catch { /* noop */ } }
  return h.digest('hex');
}

let passCount = 0, failCount = 0;
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ } };

const assert = (c, n, d = '') => { c ? (passCount++, console.log(`  PASS  ${n}${d ? ' — ' + d : ''}`)) : (failCount++, console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`)); };

console.log('='.repeat(72));
console.log(`HARNESS SELF-TEST — mode: ${INJECT ? 'DELIBERATE FAILURE' : 'DELIBERATE SUCCESS'}`);
console.log('='.repeat(72));

rmrf(BASE);
fs.mkdirSync(BASE, { recursive: true });

// Isolated database under test.
const dbFile = path.join(BASE, 'selftest.db');
{
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE business (id TEXT PRIMARY KEY, amount REAL)');
  db.prepare('INSERT INTO business (id, amount) VALUES (?, ?)').run('row-1', 100);
  db.close();
}

const before = fp(dbFile);
console.log(`  isolated db fingerprint BEFORE: ${before}`);

// Isolate production exactly as the real suite does, so a false PASS here would
// mean a false PASS there.
const prodBefore = crypto.createHash('md5').update(fs.readFileSync(PROD_DB)).digest('hex');
const rec = isolation.recoverIfHeld();
if (rec.ran) console.log(`  recovered ${rec.recovered} artifact(s) first`);
const eng = isolation.engage();
const pre = isolation.preflight();
console.log(`  isolation engaged=${eng.productionMoved} preflight.ok=${pre.ok}`);
assert(pre.ok === true, 'Self-test isolation preflight clean', JSON.stringify(pre.problems || []));

let verdict;
try {
  if (INJECT) {
    // Deliberately corrupt the isolated DB. Clobbering bytes in the middle of
    // the file damages interior pages, which is what integrity_check detects —
    // a schema-only edit is either rejected outright or leaves the file valid.
    {
      const raw = fs.readFileSync(dbFile);
      const from = Math.floor(raw.length / 2);
      for (let i = from; i < Math.min(raw.length, from + 8192); i++) raw[i] ^= 0xff;
      fs.writeFileSync(dbFile, raw);
      console.log(`  corrupted bytes ${from}..${Math.min(raw.length, from + 8192)} of ${raw.length}`);
    }

    const after = fp(dbFile);
    console.log(`  isolated db fingerprint AFTER : ${after}`);
    assert(after !== before, 'Deliberate corruption changed the fingerprint', `${before.slice(0, 12)} -> ${after.slice(0, 12)}`);

    // If the file cannot even be opened, that is itself proof of corruption.
    let integrity;
    const tmp = path.join(os.tmpdir(), `pd3-selfq-${Date.now()}.db`);
    try {
      fs.copyFileSync(dbFile, tmp);
      const q = new DatabaseSync(tmp);
      try { integrity = Object.values(q.prepare('PRAGMA integrity_check').get())[0]; }
      catch (e) { integrity = `FAILED: ${e.errstr || e.message.slice(0, 50)}`; }
      q.close();
    } catch (e) { integrity = `UNREADABLE: ${e.errstr || e.message.slice(0, 50)}`; }
    finally { try { fs.unlinkSync(tmp); } catch { /* noop */ } }
    console.log(`  integrity_check after corruption: ${integrity}`);

    // This is the assertion that MUST fail.
    assert(integrity === 'ok', 'Integrity check still reports ok', `got: ${integrity}`);
    verdict = 'expect-non-zero';
  } else {
    const after = fp(dbFile);
    console.log(`  isolated db fingerprint AFTER : ${after}`);
    assert(after === before, 'Unmodified database fingerprint is stable', `${before.slice(0, 12)} == ${after.slice(0, 12)}`);

    let integrity;
    const tmp = path.join(os.tmpdir(), `pd3-selfq-${Date.now()}.db`);
    try {
      fs.copyFileSync(dbFile, tmp);
      const q = new DatabaseSync(tmp);
      integrity = Object.values(q.prepare('PRAGMA integrity_check').get())[0];
      q.close();
    } catch (e) { integrity = `UNREADABLE: ${e.errstr || e.message.slice(0, 50)}`; }
    finally { try { fs.unlinkSync(tmp); } catch { /* noop */ } }
    assert(integrity === 'ok', 'Integrity check reports ok', String(integrity));
    verdict = 'expect-zero';
  }
} finally {
  const rel = isolation.release();
  console.log(`  production restored=${rel.restored} artifacts=${rel.moved}`);
  const prodAfter = crypto.createHash('md5').update(fs.readFileSync(PROD_DB)).digest('hex');
  console.log(`  production checksum BEFORE=${prodBefore}`);
  console.log(`  production checksum AFTER =${prodAfter}`);
  assert(prodAfter === prodBefore, 'Production unchanged by the self-test', `${prodBefore.slice(0, 12)} == ${prodAfter.slice(0, 12)}`);
  rmrf(BASE);
}

console.log(`\n  PASS ${passCount}   FAIL ${failCount}`);
console.log(`  expected shell exit for this mode: ${verdict}`);

// THE POINT OF THIS EXERCISE: the verdict must reach the shell.
process.exitCode = failCount === 0 ? 0 : 1;
