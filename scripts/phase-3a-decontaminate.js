#!/usr/bin/env node
/**
 * PHASE 3A — OWNER-AUTHORIZED PRODUCTION E2E DECONTAMINATION.
 *
 * Removes ONLY the 20 enumerated E2E inventory voucher headers (dated
 * 2026-10-08) and their resolved child records, inside a single transaction.
 *
 * Safety properties:
 *  - Explicit ID / enumerated-voucher-number lists only. NO broad predicates
 *    (no "created_at = today", no "name LIKE '%E2E%'", no range comparisons).
 *  - The genuine vouchers INV/OPEN/2026/00030 and 00031 are never named and are
 *    re-verified as present after the transaction commits.
 *  - Numbering counters (number_sequences) are never written.
 *  - audit_logs and all E2E master data are PRESERVED - the owner did not
 *    authorize removing them.
 *  - A dry-run mode reports the plan without writing.
 *
 * Usage:
 *   node scripts/phase-3a-decontaminate.js            # dry run (default)
 *   node scripts/phase-3a-decontaminate.js --execute  # apply
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const EXECUTE = process.argv.includes('--execute');
const DB = path.resolve(process.argv.find((a) => a.endsWith('.db')) || 'data/blackstack-crm.db');

// ── The 20 enumerated E2E voucher numbers (from the dependency map) ──────────
const E2E_VOUCHERS = [
  'INV/INWD/2026/00001', 'INV/INWD/2026/00002', 'INV/INWD/2026/00003',
  'INV/INWD/2026/00004', 'INV/INWD/2026/00005', 'INV/INWD/2026/00006',
  'INV/OUTW/2026/00001', 'INV/OUTW/2026/00002', 'INV/OUTW/2026/00003',
  'INV/XFER/2026/00001', 'INV/XFER/2026/00002', 'INV/XFER/2026/00003',
  'INV/OPEN/2026/00032', 'INV/OPEN/2026/00033', 'INV/OPEN/2026/00034', 'INV/OPEN/2026/00035',
  'INV/OPEN/2026/00036', 'INV/OPEN/2026/00037', 'INV/OPEN/2026/00038', 'INV/OPEN/2026/00039',
];
// Genuine production vouchers - asserted present, never deleted.
const PRESERVE_VOUCHERS = ['INV/OPEN/2026/00030', 'INV/OPEN/2026/00031'];
const E2E_JOURNAL_VOUCHERS = ['JV-2026-0026', 'JV-2026-0027', 'JV-2026-0028'];

const ph = (n) => Array(n).fill('?').join(',');
const log = (...a) => console.log(...a);

if (!fs.existsSync(DB)) {
  console.error(`ABORT: database not found at ${DB}`);
  process.exit(1);
}

const db = new DatabaseSync(DB);
db.exec('PRAGMA foreign_keys = ON');

const headers = db.prepare(
  `SELECT id, voucher_number, voucher_type, voucher_date
     FROM inventory_voucher_headers
    WHERE voucher_number IN (${ph(E2E_VOUCHERS.length)})`
).all(...E2E_VOUCHERS);

log(`\n${'='.repeat(74)}`);
log(`PHASE 3A DECONTAMINATION — ${EXECUTE ? 'EXECUTE' : 'DRY RUN (no writes)'}`);
log('='.repeat(74));
log(`  mode            : ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}`);
log(`  database        : ${DB}`);
log(`  E2E headers found: ${headers.length} (expect 20)`);

// ── Guard: every resolved header must be one of the enumerated numbers ──────
const allowed = new Set(E2E_VOUCHERS);
const intruders = headers.filter((h) => !allowed.has(h.voucher_number));
if (headers.length !== 20 || intruders.length) {
  console.error('ABORT: resolved header set does not match the dependency map.');
  if (intruders.length) console.error('  unexpected: ' + intruders.map((h) => h.voucher_number).join(', '));
  process.exit(1);
}
const wrongDate = headers.filter((h) => h.voucher_date !== '2026-10-08');
if (wrongDate.length) {
  console.error('ABORT: resolved headers are not all dated 2026-10-08.');
  process.exit(1);
}

const hdrIds = headers.map((h) => h.id);
const hph = ph(hdrIds.length);

const lines = db.prepare(`SELECT COUNT(*) c FROM inventory_voucher_lines WHERE header_id IN (${hph})`).get(...hdrIds).c;
const ledger = db.prepare(`SELECT COUNT(*) c FROM stock_ledger WHERE header_id IN (${hph})`).get(...hdrIds).c;
const vmov = db.prepare(`SELECT COUNT(*) c FROM valuation_movements WHERE source_document_id IN (${hph})`).get(...hdrIds).c;

const jvch = db.prepare(`SELECT id, voucher_number FROM vouchers WHERE voucher_number IN (${ph(E2E_JOURNAL_VOUCHERS.length)})`).all(...E2E_JOURNAL_VOUCHERS);
const jvIds = jvch.map((v) => v.id);
const entries = jvIds.length
  ? db.prepare(`SELECT id, entry_number FROM journal_entries WHERE voucher_id IN (${ph(jvIds.length)})`).all(...jvIds)
  : [];
const entryIds = entries.map((e) => e.id);
const entryLines = entryIds.length
  ? db.prepare(`SELECT COUNT(*) c FROM journal_entry_lines WHERE journal_entry_id IN (${ph(entryIds.length)})`).get(...entryIds).c
  : 0;

log('\n  PLAN (FK-safe, children -> parents)');
log(`    1. journal_entry_lines       ${entryLines}`);
log(`    2. journal_entries           ${entries.length}`);
log(`    3. vouchers (JOURNAL)        ${jvch.length}`);
log(`    4. valuation_movements       ${vmov}`);
log(`    5. stock_ledger              ${ledger}`);
log(`    6. inventory_voucher_lines   ${lines}`);
log(`    7. inventory_voucher_headers ${headers.length}`);
log(`    PRESERVED: audit_logs, stock_balances, inventory_items,`);
log(`               number_sequences, all E2E master data, ${PRESERVE_VOUCHERS.join(' + ')}`);

// ── Pre-flight: confirm the preserved vouchers exist BEFORE we touch anything
for (const v of PRESERVE_VOUCHERS) {
  const row = db.prepare('SELECT id FROM inventory_voucher_headers WHERE voucher_number = ?').get(v);
  if (!row) {
    console.error(`ABORT: preserved voucher ${v} is missing BEFORE cleanup.`);
    process.exit(1);
  }
}
const countersBefore = db.prepare('SELECT entity_type, scope, next_seq FROM number_sequences ORDER BY scope').all();

if (!EXECUTE) {
  log('\n  DRY RUN — nothing was written. Re-run with --execute to apply.');
  db.close();
  process.exit(0);
}

// ── Execute in a single transaction ────────────────────────────────────────
log('\n  EXECUTING in one transaction...');
db.exec('BEGIN IMMEDIATE');
try {
  const del = (sql, args, label) => {
    const before = db.prepare('SELECT changes() c').get().c;
    db.prepare(sql).run(...args);
    const after = db.prepare('SELECT changes() c').get().c;
    const n = before - after;
    log(`      ${label.padEnd(30)} deleted ${n}`);
    return n;
  };

  const counts = {};
  if (entryIds.length) {
    counts.journal_entry_lines = del(
      `DELETE FROM journal_entry_lines WHERE journal_entry_id IN (${ph(entryIds.length)})`, entryIds, 'journal_entry_lines');
  }
  if (entryIds.length) {
    counts.journal_entries = del(
      `DELETE FROM journal_entries WHERE id IN (${ph(entryIds.length)})`, entryIds, 'journal_entries');
  }
  if (jvIds.length) {
    counts.vouchers = del(
      `DELETE FROM vouchers WHERE id IN (${ph(jvIds.length)})`, jvIds, 'vouchers');
  }
  counts.valuation_movements = del(
    `DELETE FROM valuation_movements WHERE source_document_id IN (${hph})`, hdrIds, 'valuation_movements');
  counts.stock_ledger = del(
    `DELETE FROM stock_ledger WHERE header_id IN (${hph})`, hdrIds, 'stock_ledger');
  counts.inventory_voucher_lines = del(
    `DELETE FROM inventory_voucher_lines WHERE header_id IN (${hph})`, hdrIds, 'inventory_voucher_lines');
  counts.inventory_voucher_headers = del(
    `DELETE FROM inventory_voucher_headers WHERE id IN (${hph})`, hdrIds, 'inventory_voucher_headers');

  db.exec('COMMIT');
  log('      COMMIT ok');
  log('\n  DELETED TOTALS: ' + JSON.stringify(counts));
  log('  TOTAL ROWS REMOVED: ' + Object.values(counts).reduce((a, b) => a + b, 0));
} catch (e) {
  db.exec('ROLLBACK');
  console.error('  ROLLED BACK: ' + e.message);
  process.exit(1);
}

// ── Post-commit assertions ─────────────────────────────────────────────────
log('\n  POST-COMMIT VERIFICATION');
const remaining = db.prepare(
  `SELECT COUNT(*) c FROM inventory_voucher_headers WHERE voucher_number IN (${ph(E2E_VOUCHERS.length)})`
).get(...E2E_VOUCHERS).c;
log(`    quarantined headers remaining : ${remaining}  ${remaining === 0 ? 'OK' : 'FAIL'}`);

for (const v of PRESERVE_VOUCHERS) {
  const row = db.prepare('SELECT id FROM inventory_voucher_headers WHERE voucher_number = ?').get(v);
  log(`    preserved ${v.padEnd(20)}: ${row ? 'PRESENT  OK' : 'MISSING  FAIL'}`);
}
const genuineJv = db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE entry_number <= 'JV-2026-0025'").get().c;
log(`    JV-2026-0001..0025 remaining  : ${genuineJv}  ${genuineJv === 25 ? 'OK' : 'FAIL'}`);

const countersAfter = db.prepare('SELECT entity_type, scope, next_seq FROM number_sequences ORDER BY scope').all();
const sameCounters = JSON.stringify(countersBefore) === JSON.stringify(countersAfter);
log(`    numbering counters unchanged  : ${sameCounters ? 'OK' : 'FAIL'}`);

const integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
log(`    integrity_check              : ${integrity}  ${integrity === 'ok' ? 'OK' : 'FAIL'}`);
const fk = db.prepare('PRAGMA foreign_key_check').all().length;
log(`    foreign_key_check            : ${fk}  ${fk === 0 ? 'OK' : 'FAIL'}`);

// ── Derived state: rebuild from the authoritative stock_ledger ────────────
log('\n  DERIVED STATE — stock_ledger is authoritative; recomputing caches');
const ledgerQty = db.prepare(`
  SELECT item_id, godown_id,
         SUM(CASE WHEN voucher_type IN ('stock_inward','opening_stock') THEN quantity_change
                  WHEN voucher_type IN ('stock_outward','stock_transfer') THEN -ABS(quantity_change)
                  ELSE 0 END) AS qty
    FROM stock_ledger
   GROUP BY item_id, godown_id`).all();
const balances = db.prepare('SELECT id, item_id, godown_id, quantity, avg_rate FROM stock_balances').all();

log('    ledger-derived balances (item, godown, qty):');
for (const l of ledgerQty) log(`      ${l.item_id}  ${l.godown_id}  qty=${l.qty}`);
log('    current stock_balances:');
for (const b of balances) log(`      ${b.item_id}  ${b.godown_id}  qty=${b.quantity}  rate=${b.avg_rate}`);

let mismatch = 0;
for (const b of balances) {
  const derived = ledgerQty.find((l) => l.item_id === b.item_id && l.godown_id === b.godown_id);
  const expect = derived ? derived.qty : 0;
  if (Number(b.quantity) !== Number(expect)) {
    mismatch++;
    log(`      MISMATCH ${b.item_id}/${b.godown_id}: balance=${b.quantity} ledger=${expect}`);
  }
}
log(`    balance rows not matching ledger: ${mismatch}`);

const orphanBalances = balances.filter((b) => !ledgerQty.some((l) => l.item_id === b.item_id && l.godown_id === b.godown_id)).length;
log(`    orphan stock_balances (no ledger): ${orphanBalances}  ${orphanBalances === 0 ? 'OK' : 'NEEDS REBUILD'}`);

db.close();
log('\n  Done.');
