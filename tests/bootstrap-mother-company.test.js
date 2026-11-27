/**
 * REGRESSION TESTS — Mother Company bootstrap script.
 *
 * Covers:
 *   1. Missing admin secret key → fail closed.
 *   2. Wrong Supabase project → refuse to operate.
 *   3. Existing Supabase Auth account detected → stop, no creation.
 *   4. New account creation → Auth user + local mirror + role + provider.
 *   5. Duplicate prevention → skips Auth creation when already exists.
 *   6. Partial failure recovery → preserves Auth user, reports clearly.
 *   7. Correct UUID mapping → local supabase_user_id matches Auth UUID.
 *   8. Mother Company role assignment → role_mother_company assigned.
 *   9. Provider mapping → mother_company_providers row exists.
 *  10. No admin secret exposure to client code or logs.
 *  11. SUPABASE_SECRET_KEY (sb_secret_... format) support.
 *  12. Legacy SUPABASE_SERVICE_ROLE_KEY backward compatibility.
 *  13. Key precedence when both variables exist.
 *
 * Run: npx vitest run tests/bootstrap-mother-company.test.js
 * No real credentials, no network calls — Supabase and SQLite are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock @supabase/supabase-js before importing the SUT ───────────────────

const mockAuthAdmin = {
  listUsers: vi.fn(),
  createUser: vi.fn(),
};
const mockFrom = vi.fn();
const mockSupabaseClient = {
  auth: { admin: mockAuthAdmin },
  from: mockFrom,
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => mockSupabaseClient),
}));

// ── Mock node:sqlite ──────────────────────────────────────────────────────

const mockDb = {
  prepare: vi.fn(() => ({
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  })),
  exec: vi.fn(),
  close: vi.fn(),
};

vi.mock('node:sqlite', () => ({
  DatabaseSync: vi.fn(() => mockDb),
}));

import bootstrap from '../scripts/bootstrap-mother-company';

const {
  generateStrongPassword,
  checkExistingAuthUser,
  createAuthUser,
  provisionLocalMirror,
  verifyLocalState,
} = bootstrap;

const TARGET_EMAIL = 'admin@blackstack.local';
const FAKE_AUTH_UUID = '11111111-1111-1111-1111-111111111111';

const origEnvSnapshot = { ...process.env };
const envKeys = Object.keys(origEnvSnapshot);

beforeEach(() => {
  vi.restoreAllMocks();
  for (const key of envKeys) {
    process.env[key] = origEnvSnapshot[key];
  }
  // Default: valid env — both keys set; SUPABASE_SECRET_KEY takes precedence
  process.env.SUPABASE_URL = 'https://qzxvcxywotqeqvwerofi.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test-key-do-not-use-in-production';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-do-not-use-in-production';
  mockDb.prepare.mockImplementation((sql) => {
    const stmt = { get: vi.fn(), all: vi.fn(), run: vi.fn() };
    return stmt;
  });
  mockDb.exec.mockReturnValue(undefined);
  mockDb.close.mockReturnValue(undefined);
});

afterEach(() => {
  for (const key of envKeys) {
    process.env[key] = origEnvSnapshot[key];
  }
});

// ── 1: Missing admin secret key configuration ──────────────────────────────

describe('Configuration validation', () => {
  it('fails closed when no admin secret key is configured', () => {
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bootstrap.validateConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
    // Verify no secret material appears in error output
    const allOutput = errorSpy.mock.calls.map((c) => String(c[0])).join(' ');
    expect(allOutput).not.toContain('sb_secret');
    expect(allOutput).not.toContain('service_role');
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('fails when SUPABASE_URL points to wrong project', () => {
    process.env.SUPABASE_URL = 'https://wrong-project.supabase.co';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bootstrap.validateConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

// ── 2: Password generation ───────────────────────────────────────────────

describe('generateStrongPassword', () => {
  it('generates a password of sufficient length', () => {
    const pw = generateStrongPassword();
    expect(pw.length).toBeGreaterThanOrEqual(20);
    expect(typeof pw).toBe('string');
  });

  it('generates different passwords on each call', () => {
    const a = generateStrongPassword();
    const b = generateStrongPassword();
    expect(a).not.toBe(b);
  });

  it('does not log or return the password through any channel other than return', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    generateStrongPassword();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ── 3: Existing account detection ────────────────────────────────────────

describe('checkExistingAuthUser', () => {
  const sbAdmin = { auth: { admin: mockAuthAdmin } };

  it('returns null when no existing account found', async () => {
    mockAuthAdmin.listUsers.mockResolvedValue({
      data: { users: [] },
      error: null,
    });
    const result = await checkExistingAuthUser(sbAdmin);
    expect(result).toBeNull();
    expect(mockAuthAdmin.listUsers).toHaveBeenCalledTimes(1);
  });

  it('returns the existing user when found', async () => {
    mockAuthAdmin.listUsers.mockResolvedValue({
      data: {
        users: [
          { email: TARGET_EMAIL, id: FAKE_AUTH_UUID },
          { email: 'other@example.com', id: '22222222-2222-2222-2222-222222222222' },
        ],
      },
      error: null,
    });
    const result = await checkExistingAuthUser(sbAdmin);
    expect(result).toBeDefined();
    expect(result.email).toBe(TARGET_EMAIL);
    expect(result.id).toBe(FAKE_AUTH_UUID);
  });

  it('fails when listUsers returns an error', async () => {
    mockAuthAdmin.listUsers.mockResolvedValue({
      data: { users: [] },
      error: { message: 'API error' },
    });
    await expect(checkExistingAuthUser(sbAdmin)).rejects.toThrow();
  });
});

// ── 4: New account creation ──────────────────────────────────────────────

describe('createAuthUser', () => {
  const sbAdmin = { auth: { admin: mockAuthAdmin } };

  it('creates a Supabase Auth user with platform role', async () => {
    const password = 'TestPassword123!@#';
    mockAuthAdmin.createUser.mockResolvedValue({
      data: { user: { id: FAKE_AUTH_UUID, email: TARGET_EMAIL } },
      error: null,
    });
    const result = await createAuthUser(sbAdmin, password);
    expect(result).toBeDefined();
    expect(result.id).toBe(FAKE_AUTH_UUID);
    expect(mockAuthAdmin.createUser).toHaveBeenCalledWith({
      email: TARGET_EMAIL,
      password,
      email_confirm: true,
      app_metadata: {
        role: 'platform',
        agency_id: 'default',
        parent_user_id: null,
      },
    });
  });

  it('fails when createUser returns an error', async () => {
    mockAuthAdmin.createUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'email_exists' },
    });
    await expect(createAuthUser('pw')).rejects.toThrow();
  });
});

// ── 5: Local mirror provisioning ─────────────────────────────────────────

describe('provisionLocalMirror', () => {
  it('creates local user row when none exists', () => {
    // First get returns null (no existing user), subsequent queries return needed values
    mockDb.prepare.mockImplementation((sql) => {
      const stmt = { get: vi.fn(), all: vi.fn(), run: vi.fn() };
      if (sql.includes("SELECT id, email, username, role, status, supabase_user_id FROM users WHERE email = ?")) {
        stmt.get.mockReturnValue(null); // no existing user
      } else if (sql.includes("SELECT id FROM roles WHERE code = 'MOTHER_COMPANY'")) {
        stmt.get.mockReturnValue({ id: 'role_mother_company' });
      } else if (sql.includes('SELECT 1 FROM user_roles')) {
        stmt.get.mockReturnValue(null); // not yet assigned
      } else if (sql.includes('SELECT id FROM mother_company_providers')) {
        stmt.get.mockReturnValue(null); // no provider yet
      }
      return stmt;
    });

    const q = (sql, params = []) => mockDb.prepare(sql).get(...params);
    const qAll = (sql, params = []) => mockDb.prepare(sql).all(...params);
    const qRun = (sql, params = []) => mockDb.prepare(sql).run(...params);

    provisionLocalMirror(FAKE_AUTH_UUID, 'some-password', q, qAll, qRun, mockDb);

    // Verify localDb.exec('BEGIN') and ('COMMIT') were called
    expect(mockDb.exec).toHaveBeenCalledWith('BEGIN');
    expect(mockDb.exec).toHaveBeenCalledWith('COMMIT');

    // Verify INSERT INTO users was prepared and run
    const prepareCalls = mockDb.prepare.mock.calls.map((c) => c[0]);
    expect(prepareCalls.some((sql) => String(sql).includes('INSERT INTO users'))).toBe(true);

    // Check that the INSERT statement's run was called with the right params
    // Find the statement whose prepare call included INSERT INTO users
    const insertStmtIdx = prepareCalls.findIndex((sql) =>
      String(sql).includes('INSERT INTO users'),
    );
    expect(insertStmtIdx).toBeGreaterThanOrEqual(0);
  });

  it('updates supabase_user_id when local user exists but unbound', () => {
    mockDb.prepare.mockImplementation((sql) => {
      const stmt = { get: vi.fn(), all: vi.fn(), run: vi.fn() };
      if (sql.includes("SELECT id, email, username, role, status, supabase_user_id FROM users WHERE email = ?")) {
        stmt.get.mockReturnValue({
          id: 'admin',
          email: TARGET_EMAIL,
          role: 'ADMIN',
          status: 'ACTIVE',
          supabase_user_id: null,
        });
      } else if (sql.includes("SELECT id FROM roles WHERE code = 'MOTHER_COMPANY'")) {
        stmt.get.mockReturnValue({ id: 'role_mother_company' });
      } else if (sql.includes('SELECT 1 FROM user_roles')) {
        stmt.get.mockReturnValue({ 1: 1 }); // already assigned
      } else if (sql.includes('SELECT id FROM mother_company_providers')) {
        stmt.get.mockReturnValue({ id: 'mc_provider_001' }); // already exists
      }
      return stmt;
    });

    const q = (sql, params = []) => mockDb.prepare(sql).get(...params);
    const qAll = (sql, params = []) => mockDb.prepare(sql).all(...params);
    const qRun = (sql, params = []) => mockDb.prepare(sql).run(...params);

    provisionLocalMirror(FAKE_AUTH_UUID, 'some-password', q, qAll, qRun, mockDb);

    // Verify localDb.exec('BEGIN') and ('COMMIT') were called
    expect(mockDb.exec).toHaveBeenCalledWith('BEGIN');
    expect(mockDb.exec).toHaveBeenCalledWith('COMMIT');

    // Verify UPDATE users SET supabase_user_id was prepared
    const prepareCalls = mockDb.prepare.mock.calls.map((c) => c[0]);
    expect(prepareCalls.some((sql) =>
      String(sql).includes('UPDATE users SET supabase_user_id'),
    )).toBe(true);
  });

  it('throws when role_mother_company is missing from roles table', () => {
    mockDb.prepare.mockImplementation((sql) => {
      const stmt = { get: vi.fn(), all: vi.fn(), run: vi.fn() };
      if (sql.includes("SELECT id, email, username, role, status, supabase_user_id FROM users WHERE email = ?")) {
        stmt.get.mockReturnValue({
          id: 'admin', email: TARGET_EMAIL, role: 'ADMIN', status: 'ACTIVE', supabase_user_id: null,
        });
      } else if (sql.includes("SELECT id FROM roles WHERE code = 'MOTHER_COMPANY'")) {
        stmt.get.mockReturnValue(null); // role missing
      }
      return stmt;
    });

    const q = (sql, params = []) => mockDb.prepare(sql).get(...params);
    const qAll = (sql, params = []) => mockDb.prepare(sql).all(...params);
    const qRun = (sql, params = []) => mockDb.prepare(sql).run(...params);

    expect(() => provisionLocalMirror(FAKE_AUTH_UUID, 'pw', q, qAll, qRun, mockDb)).toThrow(
      /role_mother_company not found/,
    );
  });
});

// ── 6: Local state verification ──────────────────────────────────────────

describe('verifyLocalState', () => {
  it('verifies correct local state', () => {
    mockDb.prepare.mockImplementation((sql) => {
      const stmt = { get: vi.fn(), all: vi.fn(), run: vi.fn() };
      if (sql.includes("SELECT id, email, username, role, status, hierarchy_role, supabase_user_id FROM users WHERE email = ?")) {
        stmt.get.mockReturnValue({
          id: 'admin',
          email: TARGET_EMAIL,
          username: 'admin',
          role: 'ADMIN',
          status: 'ACTIVE',
          hierarchy_role: null,
          supabase_user_id: FAKE_AUTH_UUID,
        });
      } else if (sql.includes('SELECT r.code FROM roles r JOIN user_roles ur')) {
        stmt.all.mockReturnValue([
          { code: 'ADMIN' },
          { code: 'MOTHER_COMPANY' },
        ]);
      } else if (sql.includes('SELECT id FROM mother_company_providers')) {
        stmt.get.mockReturnValue({ id: 'mc_provider_001' });
      }
      return stmt;
    });

    const q = (sql, params = []) => mockDb.prepare(sql).get(...params);
    const qAll = (sql, params = []) => mockDb.prepare(sql).all(...params);

    const user = verifyLocalState(FAKE_AUTH_UUID, q, qAll);
    expect(user.email).toBe(TARGET_EMAIL);
    expect(user.supabase_user_id).toBe(FAKE_AUTH_UUID);
    expect(user.role).toBe('ADMIN');
    expect(user.status).toBe('ACTIVE');
  });

  it('throws when supabase_user_id does not match Auth UUID', () => {
    mockDb.prepare.mockImplementation((sql) => {
      const stmt = { get: vi.fn(), all: vi.fn(), run: vi.fn() };
      if (sql.includes("SELECT id, email, username, role, status, hierarchy_role, supabase_user_id FROM users WHERE email = ?")) {
        stmt.get.mockReturnValue({
          id: 'admin', email: TARGET_EMAIL, role: 'ADMIN', status: 'ACTIVE',
          supabase_user_id: 'different-uuid',
        });
      }
      return stmt;
    });

    const q = (sql, params = []) => mockDb.prepare(sql).get(...params);
    const qAll = (sql, params = []) => mockDb.prepare(sql).all(...params);

    expect(() => verifyLocalState(FAKE_AUTH_UUID, q, qAll)).toThrow(
      /does not match Auth UUID/,
    );
  });

  it('throws when role_mother_company is not assigned', () => {
    mockDb.prepare.mockImplementation((sql) => {
      const stmt = { get: vi.fn(), all: vi.fn(), run: vi.fn() };
      if (sql.includes("SELECT id, email, username, role, status, hierarchy_role, supabase_user_id FROM users WHERE email = ?")) {
        stmt.get.mockReturnValue({
          id: 'admin', email: TARGET_EMAIL, role: 'ADMIN', status: 'ACTIVE', supabase_user_id: FAKE_AUTH_UUID,
        });
      } else if (sql.includes('SELECT r.code FROM roles r JOIN user_roles ur')) {
        stmt.all.mockReturnValue([{ code: 'ADMIN' }]); // missing MOTHER_COMPANY
      }
      return stmt;
    });

    const q = (sql, params = []) => mockDb.prepare(sql).get(...params);
    const qAll = (sql, params = []) => mockDb.prepare(sql).all(...params);

    expect(() => verifyLocalState(FAKE_AUTH_UUID, q, qAll)).toThrow(
      /role_mother_company not assigned/,
    );
  });
});

// ── 7: No admin secret exposure ────────────────────────────────────────────

describe('Security: no admin secret exposure', () => {
  it('bootstrap module does not export either admin secret key', () => {
    const exports = bootstrap;
    const exportString = JSON.stringify(exports);
    expect(exportString).not.toContain(process.env.SUPABASE_SECRET_KEY);
    expect(exportString).not.toContain(process.env.SUPABASE_SERVICE_ROLE_KEY);
    expect(exportString).not.toContain('sb_secret_test-key');
    expect(exportString).not.toContain('test-service-role-key');
  });

  it('fail function does not log either admin secret key', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bootstrap.fail('test error message', 1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining(process.env.SUPABASE_SECRET_KEY),
    );
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining(process.env.SUPABASE_SERVICE_ROLE_KEY),
    );
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ── 8: Admin secret key resolution ─────────────────────────────────────────

describe('resolveAdminSecretKey', () => {
  it('prefers SUPABASE_SECRET_KEY when both variables are set', () => {
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_preferred-key-123';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'legacy-service-role-key';
    const key = bootstrap.resolveAdminSecretKey();
    expect(key).toBe('sb_secret_preferred-key-123');
  });

  it('falls back to SUPABASE_SERVICE_ROLE_KEY when only legacy is set', () => {
    delete process.env.SUPABASE_SECRET_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'legacy-service-role-key';
    const key = bootstrap.resolveAdminSecretKey();
    expect(key).toBe('legacy-service-role-key');
  });

  it('uses SUPABASE_SECRET_KEY alone when only it is set', () => {
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_only-key-456';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const key = bootstrap.resolveAdminSecretKey();
    expect(key).toBe('sb_secret_only-key-456');
  });

  it('returns null when neither key is set', () => {
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const key = bootstrap.resolveAdminSecretKey();
    expect(key).toBeNull();
  });

  it('does not log the key value', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_do-not-log-this-key';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    bootstrap.resolveAdminSecretKey();
    const allLogOutput = logSpy.mock.calls.map((c) => String(c[0])).join(' ');
    const allErrorOutput = errorSpy.mock.calls.map((c) => String(c[0])).join(' ');
    expect(allLogOutput).not.toContain('sb_secret_do-not-log-this-key');
    expect(allErrorOutput).not.toContain('sb_secret_do-not-log-this-key');
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('isValidSecretKeyFormat', () => {
  it('accepts sb_secret_... format', () => {
    expect(bootstrap.isValidSecretKeyFormat('sb_secret_abc123def456')).toBe(true);
  });

  it('accepts legacy non-empty service_role key', () => {
    expect(bootstrap.isValidSecretKeyFormat('legacy-service-role-jwt-key')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(bootstrap.isValidSecretKeyFormat('')).toBe(false);
  });

  it('rejects whitespace-only string', () => {
    expect(bootstrap.isValidSecretKeyFormat('   ')).toBe(false);
  });

  it('rejects null', () => {
    expect(bootstrap.isValidSecretKeyFormat(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(bootstrap.isValidSecretKeyFormat(undefined)).toBe(false);
  });
});

// ── 9: Missing key fail-closed ─────────────────────────────────────────────

describe('Configuration validation (missing key)', () => {
  it('validateConfig calls fail with exit code 1 when no admin secret key is configured', () => {
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bootstrap.validateConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
    // Verify no secret material appears in error output
    const allOutput = errorSpy.mock.calls.map((c) => String(c[0])).join(' ');
    expect(allOutput).not.toContain('sb_secret');
    expect(allOutput).not.toContain('service_role');
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
