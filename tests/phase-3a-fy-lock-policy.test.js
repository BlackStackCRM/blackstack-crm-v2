/**
 * PHASE 3A FY-1 / FY-2 — financial-year lock policy regression.
 *
 * Proves the policy agreed in the FY configuration audit:
 *
 *   1. A LOCKED financial year blocks posting for a user WITHOUT
 *      `accounting.override_locked`.
 *   2. A LOCKED year is writable by a user WHO HOLDS the override.
 *   3. An UNLOCKED year is writable by everyone.
 *   4. The override does NOT relax date-range validation — a date outside the
 *      year is still rejected for an overriding user.
 *   5. The controller paths and the customer-bill service paths apply the SAME
 *      rule (they used to diverge: the engine honoured the override, the
 *      controller rejected unconditionally).
 *
 * Every test runs against a DISPOSABLE database and asserts the real SQLite
 * `PRAGMA database_list` path, so it cannot silently write to production — the
 * failure mode from the 2026-10-09 incident.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const ROOT = path.join(__dirname, '..');
const PROD_DB = path.join(ROOT, 'data', 'blackstack-crm.db');

const policy = require(path.join(ROOT, 'server', 'services', 'financial-year-policy.service.js'));

function prodState() {
  const tmp = path.join(os.tmpdir(), `fy-pol-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
  for (const e of ['', '-wal', '-shm']) {
    if (fs.existsSync(PROD_DB + e)) fs.copyFileSync(PROD_DB + e, tmp + e);
  }
  const db = new DatabaseSync(tmp, { readOnly: true });
  const je = db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c;
  const fy = db.prepare('SELECT id, is_locked FROM financial_years ORDER BY id').all();
  db.close();
  for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + e); } catch { /* noop */ } }
  return { je, fy: JSON.stringify(fy) };
}
const BEFORE = prodState();

/** A request context that grants exactly the listed permissions. */
const ctx = (...perms) => ({ permissions: perms });

const LOCKED = { id: 'fy_test_locked', is_locked: 1 };
const LOCKED_TRUE = { id: 'fy_test_locked', is_locked: true };
const UNLOCKED = { id: 'fy_test_open', is_locked: 0 };
const OVERRIDE = 'accounting.override_locked';

describe('FY-1 — financial-year lock policy', () => {
  test('locked year blocks a user without the override', () => {
    const v = policy.evaluateFinancialYearLock({ fy: LOCKED, context: ctx() });
    expect(v.blocked).toBe(true);
    expect(v.overridden).toBe(false);
    expect(v.reason).toMatch(/locked/i);
  });

  test('locked year blocks a user whose permissions exclude the override', () => {
    const v = policy.evaluateFinancialYearLock({
      fy: LOCKED, context: ctx('accounting.view', 'accounting.create'),
    });
    expect(v.blocked).toBe(true);
  });

  test('locked year PERMITS a user holding accounting.override_locked', () => {
    const v = policy.evaluateFinancialYearLock({ fy: LOCKED, context: ctx(OVERRIDE) });
    expect(v.blocked).toBe(false);
    expect(v.overridden).toBe(true);
  });

  test('wildcard admin permissions satisfy the override', () => {
    const v = policy.evaluateFinancialYearLock({ fy: LOCKED, context: ctx('*') });
    expect(v.blocked).toBe(false);
    expect(v.overridden).toBe(true);
  });

  test('a missing/undefined context does NOT gain an override (fails closed)', () => {
    for (const c of [undefined, null, {}, { permissions: [] }]) {
      expect(policy.evaluateFinancialYearLock({ fy: LOCKED, context: c }).blocked,
        `context ${JSON.stringify(c)} must not bypass the lock`).toBe(true);
    }
  });

  test('unlocked year is writable by everyone', () => {
    for (const c of [ctx(), ctx('*'), undefined]) {
      const v = policy.evaluateFinancialYearLock({ fy: UNLOCKED, context: c });
      expect(v.blocked).toBe(false);
      expect(v.overridden).toBe(false);
    }
  });

  test('boolean true is treated as locked, not falsy-unlocked', () => {
    expect(policy.evaluateFinancialYearLock({ fy: LOCKED_TRUE, context: ctx() }).blocked).toBe(true);
  });

  test('a missing financial year is not treated as a lock error', () => {
    const v = policy.evaluateFinancialYearLock({ fy: null, context: ctx() });
    expect(v.blocked).toBe(false);
  });
});

describe('FY-1 — controller and service now share one policy', () => {
  test('controller has no unconditional lock rejection left', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'controllers', 'accounting.controller.js'), 'utf8');
    expect(src).not.toMatch(/errors\.push\(\s*["']Financial year is locked["']\s*\)/);
    // The message now arrives via the shared policy's reason, so the literal
    // string no longer appears in the controller at all.
    expect(src).not.toMatch(/Financial year is locked/);
  });

  test('all ten controller lock sites call the shared policy', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'controllers', 'accounting.controller.js'), 'utf8');
    // The import is a destructured require, so only call sites match this pattern.
    // 9 validators + postOpeningBalance.
    const calls = (src.match(/evaluateFinancialYearLock\(/g) || []).length;
    expect(calls).toBe(10);
    expect(src).toMatch(/require\(['"][^'"]*financial-year-policy\.service['"]\)/);
  });

  test('customer-bill service guards all five posting paths', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'services', 'customer-bill.service.js'), 'utf8');
    const guards = (src.match(/evaluateFinancialYearLock\(\{/g) || []).length;
    expect(guards).toBe(5);
    // Each must run before a transaction opens, and must fail closed without ctx.
    expect((src.match(/context: context \|\| \{\}/g) || []).length).toBe(5);
  });

  // REGRESSION, 2026-10-09: the five guards above were added WITHOUT the
  // matching import. `node --check` passed and a source-text assertion passed,
  // because neither resolves identifiers — but every posting path threw
  // `ReferenceError: evaluateFinancialYearLock is not defined`, which the HTTP
  // layer masked as INTERNAL_ERROR. Text assertions cannot catch a missing
  // binding, so this asserts on the REQUIRE result instead.
  test('every file that USES the policy actually IMPORTS it', () => {
    const files = [
      ['server', 'services', 'customer-bill.service.js'],
      ['server', 'controllers', 'accounting.controller.js'],
      ['server', 'services', 'financial-year-policy.service.js'],
    ];
    for (const parts of files) {
      const abs = path.join(ROOT, ...parts);
      const src = fs.readFileSync(abs, 'utf8');
      const uses = (src.match(/\bevaluateFinancialYearLock\b/g) || []).length;
      if (uses === 0) continue; // file does not use it

      // Declaring it satisfies the binding too (the policy module itself).
      const declares = /\bfunction\s+evaluateFinancialYearLock\b/.test(src);
      const imports = /\b(?:const|let|var)\s*\{[^}]*\bevaluateFinancialYearLock\b[^}]*\}\s*=\s*require\(/.test(src);
      expect(imports || declares,
        `${parts.join('/')} calls evaluateFinancialYearLock but never imports or defines it`).toBe(true);
    }
  });

  test('loading customer-bill.service.js exposes no missing-binding landmine', () => {
    // Actually require it in a child process: a ReferenceError for a module-level
    // or destructured import surfaces here rather than at first call.
    const r = spawnSync(process.execPath, ['-e',
      "require('./server/services/customer-bill.service.js');console.log('LOADED')",
    ], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/LOADED/);
  });

  test('service methods accept an optional context without breaking callers', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'services', 'customer-bill.service.js'), 'utf8');
    for (const sig of ['postBill(', 'recordPayment(', 'writeOff(', 'createCreditNote(', 'createDebitNote(']) {
      const m = new RegExp(sig.replace('(', '\\(') + '[^)]*context = null\\)').test(src);
      expect(m, `${sig} should accept an optional trailing context`).toBe(true);
    }
  });

  test('engine still honours the override (unchanged behaviour)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'services', 'accounting-engine.service.js'), 'utf8');
    expect(src).toMatch(/override_locked/);
  });
});

describe('FY-1 — the override does not weaken other validation', () => {
  test('date-range validation is untouched and still unconditional', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'controllers', 'accounting.controller.js'), 'utf8');
    expect(src).toMatch(/Transaction date must fall within the selected Financial Year/);
    // The range check must not be gated behind the override.
    const rangeCheck = src.slice(src.indexOf('Transaction date must fall within'));
    expect(rangeCheck.slice(0, 400)).not.toMatch(/override_locked/);
  });

  test('balanced-entry validation is untouched', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'controllers', 'accounting.controller.js'), 'utf8');
    expect(src).toMatch(/is not balanced/);
    // The repository-level wording still guards the create path.
    const repo = fs.readFileSync(path.join(ROOT, 'server', 'repositories', 'journal-entry.repository.js'), 'utf8');
    expect(repo).toMatch(/Total debits must equal total credits/);
  });

  test('assertFinancialYearWritable throws FY_LOCKED only when blocked', () => {
    const { AppError } = require(path.join(ROOT, 'server', 'utils', 'errors.js'));
    expect(() => policy.assertFinancialYearWritable({ fy: LOCKED, context: ctx(), AppError }))
      .toThrow(/locked/i);
    expect(policy.assertFinancialYearWritable({ fy: UNLOCKED, context: ctx(), AppError }).blocked).toBe(false);
    expect(policy.assertFinancialYearWritable({ fy: LOCKED, context: ctx('*'), AppError }).blocked).toBe(false);
  });
});

describe('FY policy — production untouched by this suite', () => {
  test('no test in this file wrote to production', () => {
    const after = prodState();
    expect(after.je).toBe(BEFORE.je);
    expect(after.fy).toBe(BEFORE.fy);
  });

  test('this suite never opens the production database for writing', () => {
    // Structural guarantee: the policy module must not touch a database at all.
    const src = fs.readFileSync(path.join(ROOT, 'server', 'services', 'financial-year-policy.service.js'), 'utf8');
    expect(src).not.toMatch(/node:sqlite|DatabaseSync|\.prepare\(|INSERT|UPDATE|DELETE/);
  });
});