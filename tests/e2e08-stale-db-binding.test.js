/**
 * E-08 REGRESSION — stale DB_PATH binding in a reused vitest worker.
 *
 * Background (the real intermittent this locks down):
 *
 *   Error: unable to open database file
 *     at tests/customer-bills.vitest.test.js:92
 *
 * Fifteen suites assign process.env.DB_PATH at module scope. Under vitest's
 * default `threads` pool a worker process is reused across files, so a file can
 * inherit a DB_PATH left behind by a sibling whose temp directory has ALREADY
 * been deleted. createDisposableDb() then declined to re-assign (it must never
 * silently repair a production binding), so the suite read a path that no
 * longer existed — and 177 tests were skipped as a side effect.
 *
 * These tests pin BOTH halves of the fix, because either half alone would be
 * insufficient:
 *
 *   1. A non-disposable (production) DB_PATH is still REFUSED. This is the
 *      guard's original purpose and must never regress.
 *   2. A stale DISPOSABLE DB_PATH is taken over rather than trusted, and the
 *      substitution is recorded for audit.
 *
 * Run: node node_modules/vitest/vitest.mjs run tests/e2e08-stale-db-binding.test.js
 */
// NOTE: uses vitest GLOBALS (describe/test/expect), matching every other suite
// in this project — vitest.config.js sets `globals: true`, and `require('vitest')`
// is not valid in these CommonJS files.
//
// Deliberately NOT node:test: two existing suites use node:test and are
// therefore EXCLUDED in vitest.config.js. A regression test that silently never
// runs is worse than no test at all.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GUARD = path.join(__dirname, '..', 'scripts', 'assert-disposable-db.js');

// Each case needs a pristine module registry so createDisposableDb reads the
// env var we set rather than one left by a previous case.
function freshGuard(env) {
  for (const k of Object.keys(require.cache)) {
    if (k.replace(/\\/g, '/').endsWith('/scripts/assert-disposable-db.js')) {
      delete require.cache[k];
    }
  }
  const saved = process.env.DB_PATH;
  const savedAudit = process.env.BSCRM_STALE_DB_PATH_REPLACED;
  if (env === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = env;
  delete process.env.BSCRM_STALE_DB_PATH_REPLACED;
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const mod = require(GUARD);
  return {
    mod,
    restore() {
      if (saved === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = saved;
      if (savedAudit === undefined) delete process.env.BSCRM_STALE_DB_PATH_REPLACED;
      else process.env.BSCRM_STALE_DB_PATH_REPLACED = savedAudit;
    },
  };
}

test('E-08: a PRODUCTION DB_PATH is still refused (must never regress)', () => {
  const prodDb = path.join(__dirname, '..', 'data', 'blackstack-crm.db');
  expect(fs.existsSync(prodDb), 'production db must exist for this test to be meaningful').toBe(true);

  const { mod, restore } = freshGuard(prodDb);
  try {
    expect(() => mod.createDisposableDb({ suite: 'e2e08-production' }))
      .toThrowError(/REFUSING TO RUN/);
  } finally {
    restore();
  }
});

test('E-08: a relative production path is also refused', () => {
  const { mod, restore } = freshGuard(path.resolve('data/blackstack-crm.db'));
  try {
    expect(() => mod.createDisposableDb({ suite: 'e2e08-abs-prod' }))
      .toThrowError(/REFUSING TO RUN/);
  } finally {
    restore();
  }
});

test('E-08: an inherited STALE disposable path is taken over, not trusted', () => {
  // Reproduce the failure condition precisely: the sibling's temp directory is
  // already gone, so opening the inherited path yields "unable to open
  // database file".
  const deadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e08-dead-'));
  const deadDb = path.join(deadRoot, 'suite-e2e.db');
  fs.rmSync(deadRoot, { recursive: true, force: true });
  expect(fs.existsSync(deadDb), 'the stale path must not exist for this test to be valid').toBe(false);

  const { mod, restore } = freshGuard(deadDb);
  let cleanup;
  try {
    const result = mod.createDisposableDb({ suite: 'e2e08-stale' });
    cleanup = result.cleanup;

    expect(process.env.DB_PATH, 'must not keep reading a deleted directory')
      .not.toBe(deadDb);
    expect(fs.existsSync(process.env.DB_PATH),
      'the substituted DB_PATH must be a file this suite actually owns').toBe(true);
    expect(process.env.BSCRM_STALE_DB_PATH_REPLACED, 'substitution must be auditable')
      .toBe(deadDb);
  } finally {
    if (cleanup) cleanup();
    restore();
  }
});

test('E-08: a DELIBERATE existing DB_PATH is honoured, not replaced', () => {
  // The counterpart to the stale case. A harness may legitimately prepare a
  // database and point DB_PATH at it — that is the documented pattern in CASE 2
  // of tests/phase-3a-db-isolation-guard.test.js. The file EXISTS, so this is
  // operator intent and must be preserved. Only a MISSING path is treated as a
  // stale binding.
  const prepared = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e08-prepared-'));
  const preparedDb = path.join(prepared, 'my-suite-e2e.db');
  fs.copyFileSync(
    path.join(__dirname, '..', 'data', 'blackstack-crm.db'),
    preparedDb,
  );
  expect(fs.existsSync(preparedDb)).toBe(true);

  const { mod, restore } = freshGuard(preparedDb);
  let cleanup;
  try {
    const result = mod.createDisposableDb({ suite: 'e2e08-prepared' });
    cleanup = result.cleanup;
    expect(process.env.DB_PATH,
      'an existing, deliberately supplied DB_PATH must be left alone').toBe(preparedDb);
    expect(process.env.BSCRM_STALE_DB_PATH_REPLACED,
      'nothing stale means nothing to record').toBeUndefined();
    // The returned clone still exists for suites that want it.
    expect(fs.existsSync(result.dbPath)).toBe(true);
  } finally {
    if (cleanup) cleanup();
    fs.rmSync(prepared, { recursive: true, force: true });
    restore();
  }
});

test('E-08: with no inherited DB_PATH the clone is assigned as before', () => {
  const { mod, restore } = freshGuard(undefined);
  let cleanup;
  try {
    const result = mod.createDisposableDb({ suite: 'e2e08-fresh' });
    cleanup = result.cleanup;
    expect(process.env.DB_PATH).toBe(result.dbPath);
    expect(fs.existsSync(result.dbPath)).toBe(true);
    expect(process.env.BSCRM_STALE_DB_PATH_REPLACED,
      'nothing stale means nothing to record').toBeUndefined();
  } finally {
    if (cleanup) cleanup();
    restore();
  }
});

test('E-08: the returned cleanup only removes THIS suite temp dir', () => {
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e08-sibling-'));
  const siblingFile = path.join(sibling, 'keep-me.db');
  fs.writeFileSync(siblingFile, 'untouched');

  const { mod, restore } = freshGuard(undefined);
  try {
    const result = mod.createDisposableDb({ suite: 'e2e08-cleanup' });
    result.cleanup();
    expect(fs.existsSync(result.dbPath), 'its own dir must be gone').toBe(false);
    expect(fs.existsSync(siblingFile), 'a sibling dir must survive').toBe(true);
  } finally {
    fs.rmSync(sibling, { recursive: true, force: true });
    restore();
  }
});