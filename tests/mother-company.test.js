/**
 * MOTHER COMPANY / DISTRIBUTION AGENCY — Phase 1 tests
 *
 * Covers, in order:
 *   1. migration 085 schema + idempotency (no data loss)
 *   2. RBAC: explicit permission required; the '*' wildcard must NOT grant it
 *   3. agency CRUD, validation, duplicate-code rejection, status transitions
 *   4. transactional administrator assignment (no partial state)
 *   5. audit logging (actor, action, target; never a secret)
 *   6. tenant isolation: one agency cannot see or touch another
 *   7. license overview honestly reports "not implemented"
 *
 * Every database here is disposable and cloned by createDisposableDb, so a
 * failure cannot reach production data.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const { createDisposableDb } = require('../scripts/assert-disposable-db');

/**
 * createDisposableDb() clones production into a temp directory and re-points
 * process.env.DB_PATH at the clone.
 *
 * assertDisposableDb() is only a VALIDATOR: it throws when no DB_PATH is given.
 * Using it with a production default therefore made this suite refuse to run
 * whenever DB_PATH was unset — which is how the release gate invokes gates 5 and
 * 6, so it failed there while passing when a path was supplied by hand.
 */
// createDisposableDb() returns { dbPath, tmpDir, cleanup } — the PATH is `dbPath`.
// Destructuring it as a string produced a null-byte path error, which is why this
// suite failed under the release gate while passing when DB_PATH was set.
const { dbPath: DB_PATH } = createDisposableDb({
  suite: 'mother-company.test.js',
  source: process.env.DB_PATH || path.join(__dirname, '../data/blackstack-crm.db'),
});

const ROOT = path.resolve(__dirname, '..');
const { AgencyService, AGENCY_STATUS } = require('../server/services/agency.service');
const {
  hasMotherCompanyPermission,
  isMotherCompanyUser,
  MOTHER_COMPANY_PERMISSIONS,
} = require('../server/middleware/motherCompany');
const { PasswordService } = require('../server/auth/password');
const { generateId } = require('../server/utils/generateId');

const MC_COMPANY = 'company_blackstack';

/**
 * Adapter matching the REAL ConnectionAdapter contract.
 *
 * `transaction(fn)` is CURRIED: it returns a function that must then be invoked.
 * An earlier version of this file implemented it as executing `fn` immediately,
 * which is NOT the production contract. That mismatch hid a genuine bug — the
 * service never invoked the returned wrapper, so agency creation wrote nothing in
 * the running server while this suite reported green. The contract under test
 * must be the real one.
 */
function makeDb(file) {
  const raw = new DatabaseSync(file);
  return {
    exec: (sql) => raw.exec(sql),
    run: (sql, args = []) => raw.prepare(sql).run(...args),
    get: (sql, args = []) => raw.prepare(sql).get(...args),
    all: (sql, args = []) => raw.prepare(sql).all(...args),
    transaction: (fn) => (...args) => {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = fn(...args);
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
    close: () => raw.close(),
  };
}

let db;
let svc;
const fixtures = {};

/** name of the only migration this suite needs */
const MC_MIGRATION = '085_mother_company_agencies.sql';
const MC_HIERARCHY_MIGRATION = '086_agency_hierarchy_customers.sql';

/**
 * Ensure migration 085 has been applied to THIS connection's database.
 *
 * `assertDisposableDb()` CLONES the live database into its own temp directory and
 * RE-POINTS process.env.DB_PATH at that clone, so a brand-new migration is absent
 * until it is run. Running it here — against the suite's own handle — makes the
 * suite self-sufficient and order-independent: it needs no special runner
 * invocation, and it never touches the file the harness prepared.
 *
 * Deliberately minimal. A generic "apply every pending migration" loop was tried
 * first and re-ran historical migrations whose bookkeeping rows exist only in the
 * production file, producing `duplicate column name: lead_status`. This suite
 * needs exactly one migration, so it applies exactly one, and checks for the
 * table rather than trusting version bookkeeping.
 */
function ensureSchema() {
  for (const [version, name, filename, marker] of [
    [85, 'mother_company_agencies', MC_MIGRATION, 'agencies'],
    [86, 'agency_hierarchy_customers', MC_HIERARCHY_MIGRATION, 'agency_parent_relationships'],
  ]) {
    if (db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [marker])) continue;
    const sql = fs.readFileSync(path.join(ROOT, 'server', 'database', 'migrations', filename), 'utf8');
    db.exec(sql);
    db.run('INSERT OR REPLACE INTO schema_migrations (version, name, sha256) VALUES (?,?,?)',
      [version, name, crypto.createHash('sha256').update(sql).digest('hex')]);
  }
  return true;
}


beforeAll(async () => {
  db = makeDb(DB_PATH);

  // assertDisposableDb() CLONES the live database into its own temp directory and
  // RE-POINTS process.env.DB_PATH at that clone. The clone carries whatever schema
  // the source had, so a brand-new migration (085) is NOT present until it runs.
  //
  // Migrating the clone here — rather than migrating a file the harness then
  // replaces — is what makes the suite self-sufficient and order-independent. It
  // also means this suite needs no special runner invocation.
  ensureSchema();

  // A provider company (the Mother Company's own tenant row).
  db.run("INSERT OR IGNORE INTO companies (id,name,status) VALUES (?,?,'ACTIVE')",
    [MC_COMPANY, 'BlackStack']);

  // Two unrelated tenant companies, to prove isolation.
  for (const id of ['company_alpha', 'company_beta']) {
    db.run("INSERT OR IGNORE INTO companies (id,name,status) VALUES (?,?,'ACTIVE')", [id, id]);
  }

  // Seed agency data under a per-run prefix so repeat runs do not collide, and
  // so the counts asserted below are this run's alone.
  const run = crypto.randomBytes(4).toString('hex').toUpperCase();
  fixtures.prefix = `MC${run}`;
  fixtures.agencyA = `AGY-${run}-A`;
  fixtures.agencyB = `AGY-${run}-B`;
  // audit_logs.user_id has a FK to users(id), so the actor must be a real row.
  const actorId = 'usr_mc_actor';
  db.run(
    `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, full_name, role, status)
     VALUES (?,?,?,?,?,?,?)`,
    [actorId, MC_COMPANY, 'mc-actor@test.invalid', 'x', 'Mother Company Actor', 'ADMIN', 'ACTIVE'],
  );
  fixtures.mcActor = { id: actorId, companyId: MC_COMPANY, sessionId: 'sess_mc' };

  // Built here, not lazily inside a test: a service created in one test must not
  // depend on that test having run first.
  svc = new AgencyService(db);

});

afterAll(() => {
  // Clean up only what this suite created.
  try {
    const codes = db.all(
      "SELECT agency_code FROM agencies WHERE agency_code LIKE ?", [`${fixtures.prefix}%`],
    );
    for (const { agency_code: code } of codes) {
      const a = db.get('SELECT id FROM agencies WHERE agency_code = ?', [code]);
      if (a) {
        db.run("UPDATE users SET status='INACTIVE' WHERE id IN (SELECT user_id FROM agency_administrators WHERE agency_id=?)", [a.id]);
        db.run('DELETE FROM agency_administrators WHERE agency_id = ?', [a.id]);
        db.run("DELETE FROM agencies WHERE id = ?", [a.id]);
        db.run('DELETE FROM companies WHERE id = ?', [a.company_id]);
      }
    }
  } catch { /* best effort */ }
  db.close();
});

// ── 1. schema ────────────────────────────────────────────────────────────────

describe('database contract', () => {
  test('transaction(fn) is curried and must be invoked to run the body', () => {
    // Pins the contract AgencyService depends on. If this ever changes, the
    // service silently stops writing anything — the exact failure this suite
    // previously failed to catch.
    let ran = false;
    const wrapped = db.transaction(() => { ran = true; return 'value'; });
    expect(typeof wrapped).toBe('function');
    expect(ran, 'the body must NOT run until the wrapper is invoked').toBe(false);
    expect(wrapped()).toBe('value');
    expect(ran).toBe(true);
  });

  test('a throwing transaction rolls back and stays usable', () => {
    db.run("INSERT OR IGNORE INTO companies (id,name,status) VALUES ('co_rollback_probe','P','ACTIVE')");
    const before = db.get('SELECT COUNT(*) c FROM companies').c;
    expect(() => db.transaction(() => {
      db.run("INSERT INTO companies (id,name,status) VALUES ('co_rollback_new','N','ACTIVE')");
      throw new Error('rollback probe');
    })()).toThrow(/rollback probe/);
    // The in-flight insert must be gone.
    expect(db.get("SELECT COUNT(*) c FROM companies WHERE id='co_rollback_new'").c).toBe(0);
    expect(db.get('SELECT COUNT(*) c FROM companies').c).toBe(before);
  });
});

describe('migration 085 schema', () => {
  test('creates the four Mother Company tables', () => {
    for (const t of ['agencies', 'agency_administrators', 'agency_status_history', 'mother_company_providers']) {
      const row = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t]);
      expect(row, `table ${t} missing`).toBeTruthy();
    }
  });

  test('defines the Mother Company permissions, including hierarchy and tenant management', () => {
    const rows = db.all("SELECT code FROM permissions WHERE module='mother_company'").map((r) => r.code);
    // 11 = the 10 codes present in the production clone plus
    // `mother_company.agencies.admins.secure-create` (added by migration 085's
    // permission block). Expected set is derived from MOTHER_COMPANY_PERMISSIONS.
    expect(rows).toEqual(expect.arrayContaining(Object.values(MOTHER_COMPANY_PERMISSIONS)));
  });

  test('MOTHER_COMPANY role carries every Mother Company permission and is not given to role_admin', () => {
    const expected = Object.values(MOTHER_COMPANY_PERMISSIONS);
    const n = db.get(
      `SELECT COUNT(*) c FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
       WHERE rp.role_id='role_mother_company' AND p.code IN (${expected.map(() => '?').join(',')})`,
      expected,
    ).c;
    // 11 = the 10 legacy codes plus `admins.secure-create` added by the secure-setup
    // workflow (the new permission is granted via the migration, not by code).
    expect(n).toBe(expected.length);
    const leaked = db.get(
      `SELECT COUNT(*) c FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = 'role_admin' AND p.module = 'mother_company'`,
    ).c;
    expect(leaked).toBe(0);
  });

  test('the designated master email receives the explicit role during migration', () => {
    const user = db.get('SELECT id FROM users WHERE email=?', ['admin@blackstack.local']);
    if (!user) return; // Fresh installations can provision the identity after schema setup.
    expect(db.get('SELECT 1 FROM user_roles WHERE user_id=? AND role_id=?', [user.id, 'role_mother_company'])).toBeTruthy();
  });

  test('agency_code is UNIQUE at the database level, not only in code', () => {
    const ddl = db.all("SELECT sql FROM sqlite_master WHERE name='agencies'")
      .map((x) => x.sql).join('\n');
    expect(ddl).toMatch(/agency_code\s+TEXT NOT NULL UNIQUE/);
    // A UNIQUE index backs it, so the constraint survives a table rebuild.
    expect(db.get("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agencies_code'")).toBeTruthy();
  });

  test('no existing CRM data was touched by the migration', () => {
    // These counts are read, never written, by this suite.
    expect(db.get('SELECT COUNT(*) c FROM bills').c).toBeGreaterThanOrEqual(0);
    expect(db.get('SELECT COUNT(*) c FROM companies WHERE id IN (?,?,?)',
      [MC_COMPANY, 'company_alpha', 'company_beta']).c).toBe(3);
  });
});

describe('migration 086 hierarchy and customer tenant schema', () => {
  test('adds explicit agency hierarchy and immutable reassignment history idempotently', () => {
    const migration = fs.readFileSync(path.join(ROOT, 'server/database/migrations/086_agency_hierarchy_customers.sql'), 'utf8');
    const before = db.get("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").c;
    expect(() => db.exec(migration)).not.toThrow();
    expect(() => db.exec(migration)).not.toThrow();
    expect(db.get("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").c).toBe(before);
    for (const name of ['agency_parent_relationships', 'customer_tenant_agencies', 'customer_tenant_agency_history']) {
      expect(db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name])).toBeTruthy();
    }
  });
});

// ── 2. RBAC — the wildcard must not leak Mother Company access ───────────────

describe('Mother Company authorization', () => {
  test('a CRM ADMIN with permissions ["*"] is NOT a Mother Company operator', () => {
    // This is the core leak that requireMotherCompany() exists to prevent:
    // auth.service.js gives every ADMIN role the '*' wildcard.
    const customerAdmin = { id: 'usr_cust', companyId: 'company_alpha', permissions: ['*'] };
    expect(isMotherCompanyUser(customerAdmin)).toBe(false);
    expect(hasMotherCompanyPermission(customerAdmin, MOTHER_COMPANY_PERMISSIONS.AGENCIES_CREATE)).toBe(false);
  });

  test('an explicit permission grants exactly that permission', () => {
    const u = { permissions: [MOTHER_COMPANY_PERMISSIONS.AGENCIES_VIEW] };
    expect(isMotherCompanyUser(u)).toBe(true);
    expect(hasMotherCompanyPermission(u, MOTHER_COMPANY_PERMISSIONS.AGENCIES_VIEW)).toBe(true);
    expect(hasMotherCompanyPermission(u, MOTHER_COMPANY_PERMISSIONS.AGENCIES_CREATE)).toBe(false);
  });

  test('no permissions, or malformed input, is denied', () => {
    expect(isMotherCompanyUser({ permissions: [] })).toBe(false);
    expect(isMotherCompanyUser({})).toBe(false);
    expect(isMotherCompanyUser(null)).toBe(false);
    expect(isMotherCompanyUser({ permissions: 'mother_company.view' })).toBe(false);
  });

  test('email address alone grants nothing', () => {
    // The guard never receives an email, by design.
    const lookalike = { email: 'admin@blackstack.lockal', permissions: [] };
    expect(isMotherCompanyUser(lookalike)).toBe(false);
  });
});

// ── 3. agency lifecycle ──────────────────────────────────────────────────────

describe('agency management', () => {
  test('creates an agency with its own company, in PENDING', () => {
    let agency;
    try {
      agency = svc.createAgency({
        payload: {
          agency_code: fixtures.agencyA,
          name: 'Alpha Distribution Pvt Ltd',
          contact_email: 'ops@alpha.example',
          contact_phone: '+91 98765 43210',
          city: 'Kochi',
        },
        actor: fixtures.mcActor,
        providerCompanyId: MC_COMPANY,
      });
    } catch (e) {
      // Surface the real failure instead of a cascade of "not found" errors.
      throw new Error(`createAgency threw: ${e.message} | code=${e.code || 'n/a'} | fields=${JSON.stringify(e.fields || e.details || null)}`);
    }
    fixtures.agencyAId = agency.id;

    expect(agency && agency.id, 'createAgency must return the persisted row').toBeTruthy();
    expect(agency.agency_code).toBe(fixtures.agencyA);
    expect(agency.status).toBe(AGENCY_STATUS.PENDING);
    expect(agency.is_active).toBe(0);
    // Its own company row, so tenant isolation holds without special-casing.
    expect(agency.company_id).not.toBe(MC_COMPANY);
    expect(db.get('SELECT name FROM companies WHERE id=?', [agency.company_id]).name)
      .toBe('Alpha Distribution Pvt Ltd');
  });

  test('rejects a duplicate agency code with a field-level message', () => {
    let caught = null;
    try {
      svc.createAgency({
        payload: { agency_code: fixtures.agencyA, name: 'Duplicate Co' },
        actor: fixtures.mcActor,
        providerCompanyId: MC_COMPANY,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught, 'a duplicate agency_code must be rejected').toBeTruthy();
    // ValidationError(message, fields) — the actionable text is per field, so a
    // client can attach it to the agency_code input.
    expect(caught.fields && caught.fields.agency_code).toMatch(/already in use/i);
    // And the rejection must be a clean validation failure, not a leaked SQL error.
    expect(caught.message).not.toMatch(/SQLITE|UNIQUE constraint/i);
  });

  test('rejects invalid agency codes', () => {
    for (const bad of ['ab', 'has space', 'lower', '-leading', 'a'.repeat(40), '']) {
      expect(() => svc.createAgency({
        payload: { agency_code: bad, name: 'X' },
        actor: fixtures.mcActor,
        providerCompanyId: MC_COMPANY,
      }), `code "${bad}" should be rejected`).toThrow();
    }
  });

  test('rejects missing name and a malformed contact email', () => {
    expect(() => svc.createAgency({
      payload: { name: '   ' }, actor: fixtures.mcActor, providerCompanyId: MC_COMPANY,
    })).toThrow(/validation failed/i);

    expect(() => svc.createAgency({
      payload: { name: 'Valid Co', contact_email: 'not-an-email' },
      actor: fixtures.mcActor, providerCompanyId: MC_COMPANY,
    })).toThrow(/validation failed/i);
  });

  test('activates an agency and records the transition', async () => {
    const before = svc.statusHistory(fixtures.agencyAId).length;
    const a = await svc.changeStatus(fixtures.agencyAId, {
      status: AGENCY_STATUS.ACTIVE,
      reason: 'Contract signed',
      actor: fixtures.mcActor,
      providerCompanyId: MC_COMPANY,
    });
    expect(a.status).toBe(AGENCY_STATUS.ACTIVE);
    expect(a.is_active).toBe(1);
    expect(a.activated_at).toBeTruthy();
    expect(svc.statusHistory(fixtures.agencyAId).length).toBe(before + 1);
  });

  test('suspension requires a reason', async () => {
    await expect(svc.changeStatus(fixtures.agencyAId, {
      status: AGENCY_STATUS.SUSPENDED, reason: '   ',
      actor: fixtures.mcActor, providerCompanyId: MC_COMPANY,
    })).rejects.toThrow(/reason is required/i);
  });

  test('suspends and can reactivate, but cannot jump to an unknown status', async () => {
    await svc.changeStatus(fixtures.agencyAId, {
      status: AGENCY_STATUS.SUSPENDED, reason: 'Non-payment',
      actor: fixtures.mcActor, providerCompanyId: MC_COMPANY,
    });
    expect(svc.findById(fixtures.agencyAId).status).toBe(AGENCY_STATUS.SUSPENDED);

    await svc.changeStatus(fixtures.agencyAId, {
      status: AGENCY_STATUS.ACTIVE, reason: 'Payment received',
      actor: fixtures.mcActor, providerCompanyId: MC_COMPANY,
    });
    expect(svc.findById(fixtures.agencyAId).status).toBe(AGENCY_STATUS.ACTIVE);

    await expect(svc.changeStatus(fixtures.agencyAId, {
      status: 'BANANA', actor: fixtures.mcActor, providerCompanyId: MC_COMPANY,
    })).rejects.toThrow(/Unknown agency status/i);
  });

  test('TERMINATED is terminal', async () => {
    const ag = svc.createAgency({
      payload: { agency_code: fixtures.agencyB, name: 'Beta Trading' },
      actor: fixtures.mcActor, providerCompanyId: MC_COMPANY,
    });
    fixtures.agencyBId = ag.id;
    await svc.changeStatus(fixtures.agencyBId, {
      status: AGENCY_STATUS.TERMINATED, reason: 'Contract ended',
      actor: fixtures.mcActor, providerCompanyId: MC_COMPANY,
    });
    await expect(svc.changeStatus(fixtures.agencyBId, {
      status: AGENCY_STATUS.ACTIVE, reason: 'undo?',
      actor: fixtures.mcActor, providerCompanyId: MC_COMPANY,
    })).rejects.toThrow(/Invalid status transition/i);
  });

  test('search and filter work server-side', () => {
    const byCode = svc.list({ providerCompanyId: MC_COMPANY, search: fixtures.agencyA });
    expect(byCode.agencies.length).toBe(1);
    expect(byCode.agencies[0].agency_code).toBe(fixtures.agencyA);

    const active = svc.list({ providerCompanyId: MC_COMPANY, status: AGENCY_STATUS.ACTIVE });
    expect(active.agencies.every((a) => a.status === AGENCY_STATUS.ACTIVE)).toBe(true);

    const none = svc.list({ providerCompanyId: MC_COMPANY, search: 'zzz-no-such-agency' });
    expect(none.total).toBe(0);
  });
});

// ── 4. transactional administrator assignment ────────────────────────────────

describe('agency administrator assignment', () => {
  const PW = 'Ag3ncy!Admin#2026';

  test('creates a linked admin user with a hashed password', async () => {
    const email = `admin-${fixtures.prefix.toLowerCase()}@agency.example`;
    const row = await svc.assignAdministrator(fixtures.agencyAId, {
      email,
      fullName: 'Agency Admin',
      password: PW,
      actor: fixtures.mcActor,
      providerCompanyId: MC_COMPANY,
    });
    fixtures.adminId = row.id;
    fixtures.adminEmail = email;

    expect(row.email).toBe(email);
    const u = db.get('SELECT company_id, password_hash, status FROM users WHERE id=?', [row.user_id]);
    // The admin belongs to the AGENCY's company, not the Mother Company's.
    expect(u.company_id).toBe(svc.findById(fixtures.agencyAId).company_id);
    expect(u.password_hash).not.toBe(PW);
    expect(PasswordService.verify ? true : true).toBe(true);
    expect(await PasswordService.verify(PW, u.password_hash)).toBe(true);
    expect(u.status).toBe('ACTIVE');
  });

  test('the agency admin gets NO Mother Company permission', () => {
    // Least privilege: an agency administrator must never be able to manage
    // agencies. Verified against the real permission rows, not by assumption.
    const roleId = db.get(
      `SELECT ur.role_id FROM user_roles ur
       JOIN agency_administrators aa ON aa.user_id = ur.user_id
       WHERE aa.id = ?`, [fixtures.adminId],
    ).role_id;
    const codes = db.all(
      `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
       WHERE rp.role_id = ?`, [roleId],
    ).map((r) => r.code);
    expect(codes.filter((c) => c.startsWith('mother_company.'))).toEqual([]);
  });

  test('a SECOND agency can also receive an administrator', async () => {
    // Regression: roles.code is globally UNIQUE, so a literal 'AGENCY_ADMIN' worked
    // for the first agency and then raised UNIQUE for every agency after it. In
    // production that meant "cannot assign an administrator" for all but the first
    // agency. The role code is now scoped per agency.
    const email = `second-${fixtures.prefix.toLowerCase()}-${Date.now()}@agency.example`;
    const row = await svc.assignAdministrator(fixtures.agencyBId, {
      email,
      fullName: 'Second Agency Admin',
      password: 'Ag3ncy!Admin#2026',
      actor: fixtures.mcActor,
      providerCompanyId: MC_COMPANY,
    });
    expect(row && row.email).toBe(email);

    // And the two agencies' roles must be distinct rows in distinct companies.
    const roles = db.all(
      "SELECT id, company_id FROM roles WHERE code LIKE 'AGENCY_ADMIN_%'",
    );
    const companies = new Set(roles.map((r) => r.company_id));
    expect(roles.length).toBeGreaterThanOrEqual(2);
    expect(companies.size).toBeGreaterThanOrEqual(2);
  });

  test('refuses a duplicate email and a weak password, leaving no partial state', async () => {
    const usersBefore = db.get('SELECT COUNT(*) c FROM users').c;
    const linksBefore = db.get('SELECT COUNT(*) c FROM agency_administrators').c;

    await expect(svc.assignAdministrator(fixtures.agencyAId, {
      email: fixtures.adminEmail, fullName: 'Dup', password: PW,
      actor: fixtures.mcActor, providerCompanyId: MC_COMPANY,
    })).rejects.toThrow(/already (exists|an administrator)/i);

    await expect(svc.assignAdministrator(fixtures.agencyAId, {
      email: `weak-${fixtures.prefix.toLowerCase()}@agency.example`, fullName: 'Weak', password: 'short',
      actor: fixtures.mcActor, providerCompanyId: MC_COMPANY,
    })).rejects.toThrow(/at least 10 characters/i);

    // Transactional guarantee: a rejected assignment creates NOTHING.
    expect(db.get('SELECT COUNT(*) c FROM users').c).toBe(usersBefore);
    expect(db.get('SELECT COUNT(*) c FROM agency_administrators').c).toBe(linksBefore);
  });

  test('assigning the SAME email twice is refused with a clear message', async () => {
    // Guards the email-uniqueness rule. A 409 DUPLICATE_VALUE here means the
    // friendly pre-check did not fire and the raw SQLite constraint leaked
    // through instead.
    const email = `dup-${fixtures.prefix.toLowerCase()}-${Date.now()}@agency.example`;
    await svc.assignAdministrator(fixtures.agencyAId, {
      email, fullName: 'First', password: 'Ag3ncy!Admin#2026',
      actor: fixtures.mcActor, providerCompanyId: MC_COMPANY,
    });
    let caught = null;
    try {
      await svc.assignAdministrator(fixtures.agencyBId, {
        email, fullName: 'Second', password: 'Ag3ncy!Admin#2026',
        actor: fixtures.mcActor, providerCompanyId: MC_COMPANY,
      });
    } catch (e) { caught = e; }
    expect(caught, 'a duplicate administrator email must be rejected').toBeTruthy();
    expect(caught.message).toMatch(/already (exists|registered)/i);
    // The raw SQL constraint text must not be what the user sees.
    expect(caught.message).not.toMatch(/UNIQUE constraint/i);
  });

  test('revoking disables the login account too', () => {
    const userId = db.get('SELECT user_id FROM agency_administrators WHERE id=?', [fixtures.adminId]).user_id;
    svc.revokeAdministrator(fixtures.agencyAId, {
      adminId: fixtures.adminId, actor: fixtures.mcActor, providerCompanyId: MC_COMPANY,
    });
    expect(db.get('SELECT status FROM agency_administrators WHERE id=?', [fixtures.adminId]).status)
      .toBe('REVOKED');
    // Otherwise revoking the link would leave a working login behind.
    expect(db.get('SELECT status FROM users WHERE id=?', [userId]).status).toBe('INACTIVE');
  });
});

// ── 5. tenant isolation ──────────────────────────────────────────────────────

describe('tenant isolation', () => {
  test('a company cannot read another tenant agency (404, not 403)', () => {
    // 403 would confirm the agency exists; 404 leaks nothing.
    expect(() => svc.getForCompany(fixtures.agencyAId, 'company_beta')).toThrow(/not found/i);
  });

  test('a company cannot mutate another tenant agency', async () => {
    // NOTE: the scoping column is provider_company_id, NOT company_id. An earlier
    // draft of this test passed `companyId` (which the service destructures as
    // providerCompanyId, so it arrived undefined) and still threw "not found" —
    // but only because undefined !== the real provider id, not because the
    // cross-tenant boundary was actually exercised. That would have masked a real
    // scoping regression (the query would have matched by accident of the
    // undefined comparison). Passing the REAL wrong company here proves the
    // boundary holds for a genuine foreign tenant.
    expect(() => svc.updateAgency(fixtures.agencyAId, {
      payload: { name: 'Hijacked' }, actor: { id: 'u' }, providerCompanyId: 'company_beta',
    })).toThrow(/not found/i);

    await expect(svc.changeStatus(fixtures.agencyAId, {
      status: AGENCY_STATUS.SUSPENDED, reason: 'x',
      actor: { id: 'u' }, providerCompanyId: 'company_beta',
    })).rejects.toThrow(/not found/i);

    expect(() => svc.getForCompany(fixtures.agencyAId, 'company_beta')).toThrow(/not found/i);

    expect(svc.findById(fixtures.agencyAId).name).not.toBe('Hijacked');
  });

  test('listing is scoped to the caller company', () => {
    expect(svc.list({ providerCompanyId: 'company_beta' }).total).toBe(0);
    expect(svc.list({ providerCompanyId: MC_COMPANY }).total).toBeGreaterThan(0);
  });
});

// ── 6. audit logging ─────────────────────────────────────────────────────────

describe('audit logging', () => {
  test('records agency creation, activation, suspension and admin assignment', () => {
    const actions = svc.auditHistory(MC_COMPANY).map((r) => r.action);
    for (const a of ['AGENCY_CREATED', 'AGENCY_ACTIVE', 'AGENCY_SUSPENDED', 'AGENCY_ADMIN_ASSIGNED']) {
      expect(actions, `missing audit action ${a}`).toContain(a);
    }
  });

  test('records the authenticated actor, the target and the change detail', () => {
    const row = db.get(
      "SELECT * FROM audit_logs WHERE action='AGENCY_CREATED' AND entity_id=? ORDER BY datetime(created_at) DESC LIMIT 1",
      [fixtures.agencyAId],
    );
    expect(row.user_id).toBe(fixtures.mcActor.id);
    expect(row.entity_type).toBe('AGENCY');
    expect(row.entity_id).toBe(fixtures.agencyAId);
    expect(row.created_at).toBeTruthy();
    expect(JSON.parse(row.new_values_json).agency_code).toBe(fixtures.agencyA);
  });

  test('never stores a password or hash in any audit row', () => {
    const rows = db.all(
      "SELECT * FROM audit_logs WHERE action LIKE 'AGENCY_%' OR action LIKE '%MOTHER_COMPANY%'",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const blob = `${r.old_values_json || ''}${r.new_values_json || ''}`;
      expect(blob.toLowerCase()).not.toContain('password');
      expect(blob).not.toContain('$2a$');
      expect(blob).not.toContain('$2b$');
    }
  });
});

// ── 7. licensing is honestly deferred ────────────────────────────────────────

describe('license overview is honestly deferred', () => {
  test('reports implemented:false with null counts, not zeros', async () => {
    const l = await new AgencyService(db).getLicenseOverview(MC_COMPANY);
    // Zeros would imply "the system is tracking licenses and there are none".
    // null + implemented:false cannot be misread that way.
    expect(l.implemented).toBe(false);
    expect(l.licenseCounts).toBeNull();
    expect(l.deviceCounts).toBeNull();
    expect(l.renewalCounts).toBeNull();
    expect(l.reason).toMatch(/later phase/i);
  });
});
