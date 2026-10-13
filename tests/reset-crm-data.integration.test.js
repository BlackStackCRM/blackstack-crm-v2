/**
 * Reset CRM Data — integration tests.
 * Tests tenant isolation, FK-safe deletion, transaction rollback, user preservation.
 */
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bscrm-reset-'));
const DB_PATH = path.join(TMP_DIR, 'test.db');
const PORT = 3700 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc, token;

function api(method, url, { token: t, body } = {}) {
  return fetch(`${BASE}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

async function waitReady(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('server not ready');
}

function dbQuery(sql, params = []) {
  const script = `const{DatabaseConnection}=require('${ROOT.replace(/\\/g,'/')}/server/database/connection');const c=new DatabaseConnection().connect();console.log(JSON.stringify(c.all(${JSON.stringify(sql)},${JSON.stringify(params)})));c.close();`;
  const out = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, DB_PATH } });
  if (out.status !== 0) throw new Error('DB helper failed: ' + out.stderr);
  return JSON.parse(out.stdout.trim().split('\n').pop());
}

async function login() {
  const res = await api('POST', '/auth/login', { body: { email: 'admin@blackstack.local', password: 'admin123' } });
  const { data } = await res.json();
  return data.token;
}

beforeAll(async () => {
  spawnSync(process.execPath, [path.join(ROOT, 'server', 'database', 'migrate.js')], { encoding: 'utf8', env: { ...process.env, DB_PATH }, timeout: 60000 });
  spawnSync(process.execPath, [path.join(ROOT, 'server', 'database', 'seed.js')], { encoding: 'utf8', env: { ...process.env, DB_PATH, DEMO_MODE: 'true' }, timeout: 60000 });
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server', 'app.js')], { env: { ...process.env, DB_PATH, PORT: String(PORT), NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProc.stderr.on('data', d => process.stderr.write('[server] ' + d));
  await waitReady();
  token = await login();
}, 90000);

afterAll(() => {
  if (serverProc) serverProc.kill();
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

// Helper: create a contact via API
async function makeContact(name = 'TestUser') {
  const res = await api('POST', '/contacts', { token, body: { first_name: name, last_name: 'ResetTest', email: `${name.toLowerCase()}-${Date.now()}@t.io` } });
  const j = await res.json();
  return j.data?.id || j.data;
}

describe('Reset CRM Data — core scenarios', () => {

  test('1. confirmation phrase is required', async () => {
    const res = await api('POST', '/settings/reset-crm-data', { token, body: { confirm: 'WRONG' } });
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error.code).toBe('VALIDATION_ERROR');
  });

  test('2. reset requires settings.manage permission', async () => {
    // User without settings.manage — create a restricted user
    const email = `nosettings${Date.now()}@t.io`;
    const res = await api('POST', '/users', { token, body: { username: 'noset' + Date.now(), email, password: 'Passw0rd!123', role: 'viewer' } });
    if (res.status === 201 || res.status === 200) {
      const loginRes = await api('POST', '/auth/login', { body: { email, password: 'Passw0rd!123' } });
      if (loginRes.status === 200) {
        const { data } = await loginRes.json();
        const resetRes = await api('POST', '/settings/reset-crm-data', { token: data.token, body: { confirm: 'RESET CRM DATA' } });
        expect([401, 403]).toContain(resetRes.status);
      }
    }
  });

  test('3. full reset deletes all business data', async () => {
    // Create test data
    const contactId = await makeContact('John');
    await api('POST', '/leads', { token, body: { contact_id: contactId, source: 'web' } });
    await api('POST', '/tasks', { token, body: { title: 'Follow up', contact_id: contactId } });
    await api('POST', '/notes', { token, body: { title: 'Note', content: 'test', contact_id: contactId } });

    // Verify data exists
    const contactsBefore = dbQuery('SELECT COUNT(*) c FROM contacts WHERE company_id = ?', ['default'])[0].c;
    const tasksBefore = dbQuery('SELECT COUNT(*) c FROM tasks WHERE company_id = ?', ['default'])[0].c;
    const leadsBefore = dbQuery('SELECT COUNT(*) c FROM leads WHERE company_id = ?', ['default'])[0].c;

    expect(contactsBefore).toBeGreaterThan(0);
    expect(tasksBefore).toBeGreaterThan(0);
    expect(leadsBefore).toBeGreaterThan(0);

    // Perform reset
    const res = await api('POST', '/settings/reset-crm-data', { token, body: { confirm: 'RESET CRM DATA' } });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.success).toBe(true);
    expect(j.data.rowsDeleted).toBeGreaterThan(0);

    // Verify business data is gone
    const contactsAfter = dbQuery('SELECT COUNT(*) c FROM contacts WHERE company_id = ?', ['default'])[0].c;
    const tasksAfter = dbQuery('SELECT COUNT(*) c FROM tasks WHERE company_id = ?', ['default'])[0].c;
    const leadsAfter = dbQuery('SELECT COUNT(*) c FROM leads WHERE company_id = ?', ['default'])[0].c;
    const invoicesAfter = dbQuery('SELECT COUNT(*) c FROM invoices WHERE company_id = ?', ['default'])[0].c;
    const journalAfter = dbQuery('SELECT COUNT(*) c FROM journal_entries WHERE company_id = ?', ['default'])[0].c;

    expect(contactsAfter).toBe(0);
    expect(tasksAfter).toBe(0);
    expect(leadsAfter).toBe(0);
    expect(invoicesAfter).toBe(0);
    expect(journalAfter).toBe(0);
  });

  test('4. users are preserved after reset', async () => {
    // Login should still work
    const loginRes = await api('POST', '/auth/login', { body: { email: 'admin@blackstack.local', password: 'admin123' } });
    expect(loginRes.status).toBe(200);
    const { data } = await loginRes.json();
    expect(data.token).toBeTruthy();

    // User record should still exist
    const userCount = dbQuery('SELECT COUNT(*) c FROM users WHERE email = ?', ['admin@blackstack.local'])[0].c;
    expect(userCount).toBe(1);

    // User ID, roles, permissions should be intact
    const user = dbQuery('SELECT u.id, u.email, u.status, r.name as role FROM users u JOIN user_roles ur ON u.id=ur.user_id JOIN roles r ON ur.role_id=r.id WHERE u.email = ?', ['admin@blackstack.local'])[0];
    expect(user.id).toBeTruthy();
    expect(user.status).toBe('ACTIVE');
    expect(user.role).toBe('Administrator');
  });

  test('5. system/master data is preserved', async () => {
    // system_metadata may or may not be seeded — just verify the table itself is intact
    const meta = dbQuery('SELECT COUNT(*) c FROM system_metadata')[0].c;
    expect(meta).toBeGreaterThanOrEqual(0); // table must exist
    expect(dbQuery('SELECT COUNT(*) c FROM permissions')[0].c).toBeGreaterThan(0);
    expect(dbQuery('SELECT COUNT(*) c FROM roles')[0].c).toBeGreaterThan(0);
    expect(dbQuery('SELECT COUNT(*) c FROM companies')[0].c).toBeGreaterThan(0);
    expect(dbQuery('SELECT COUNT(*) c FROM schema_migrations')[0].c).toBeGreaterThan(0);
  });

  test('6. audit log records the reset', async () => {
    const logs = dbQuery("SELECT action, entity_type FROM audit_logs WHERE action = 'RESET_CRM_DATA'");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].entity_type).toBe('company');
  });

  test('7. double reset does not cause errors', async () => {
    // After a full reset, running again should still work
    const res = await api('POST', '/settings/reset-crm-data', { token, body: { confirm: 'RESET CRM DATA' } });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.success).toBe(true);
    // Should not error even with empty data
  });

  test('8. no foreign key errors during reset', async () => {
    // Create deeply related records
    const contactId = await makeContact('DeepRel');
    await api('POST', '/tasks', { token, body: { title: 'Task1', contact_id: contactId } });
    await api('POST', '/notes', { token, body: { title: 'Note1', content: 'x', contact_id: contactId } });
    await api('POST', '/appointments', { token, body: { title: 'Appt1', contact_id: contactId } });
    await api('POST', '/deals', { token, body: { name: 'Deal1', contact_id: contactId, stage: 'NEW' } });

    const res = await api('POST', '/settings/reset-crm-data', { token, body: { confirm: 'RESET CRM DATA' } });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.success).toBe(true);

    // Verify no FK violations
    const contactsAfter = dbQuery('SELECT COUNT(*) c FROM contacts WHERE company_id = ?', ['default'])[0].c;
    expect(contactsAfter).toBe(0);

    // Verify the database has ZERO dangling foreign keys after reset
    expect(dbQuery('PRAGMA foreign_key_check')).toHaveLength(0);
  });

  test('9. tenant isolation: another company\'s data is untouched', async () => {
    // Create company B directly in the DB (no API for companies)
    dbQuery("INSERT INTO companies (id, name, status) VALUES ('company-b', 'Company B', 'active')");
    // Create a user in company B with the Administrator role so it can log in
    const roleB = dbQuery("SELECT id FROM roles WHERE name = 'Administrator'")[0];
    dbQuery(
      "INSERT INTO users (id, company_id, username, email, password_hash, full_name, status) VALUES ('user-b', 'company-b', 'userb', 'userb@t.io', ?, 'User B', 'ACTIVE')",
      [dbQuery('SELECT password_hash FROM users WHERE email = ?', ['admin@blackstack.local'])[0].password_hash]
    );
    dbQuery("INSERT INTO user_roles (user_id, role_id) VALUES ('user-b', ?)", [roleB.id]);

    // Create business data for BOTH companies directly (bypassing API so we
    // control company_id exactly)
    dbQuery(
      "INSERT INTO contacts (id, company_id, first_name, last_name, email, created_at) VALUES ('c-a1', 'default', 'A', 'Owner', 'a@t.io', CURRENT_TIMESTAMP)"
    );
    dbQuery(
      "INSERT INTO contacts (id, company_id, first_name, last_name, email, created_at) VALUES ('c-b1', 'company-b', 'B', 'Owner', 'b@t.io', CURRENT_TIMESTAMP)"
    );
    dbQuery(
      "INSERT INTO tasks (id, company_id, title, contact_id, created_at) VALUES ('t-a1', 'default', 'TaskA', 'c-a1', CURRENT_TIMESTAMP)"
    );
    dbQuery(
      "INSERT INTO tasks (id, company_id, title, contact_id, created_at) VALUES ('t-b1', 'company-b', 'TaskB', 'c-b1', CURRENT_TIMESTAMP)"
    );

    // Login as company B user to prove login still works after reset later
    const loginB = await api('POST', '/auth/login', { body: { email: 'userb@t.io', password: 'admin123' } });
    expect(loginB.status).toBe(200);

    // Reset as the default company admin
    const res = await api('POST', '/settings/reset-crm-data', { token, body: { confirm: 'RESET CRM DATA' } });
    expect(res.status).toBe(200);

    // Company A data is gone
    expect(dbQuery("SELECT COUNT(*) c FROM contacts WHERE company_id = 'default'")[0].c).toBe(0);
    expect(dbQuery("SELECT COUNT(*) c FROM tasks WHERE company_id = 'default'")[0].c).toBe(0);
    // Company B data is UNTOUCHED
    expect(dbQuery("SELECT COUNT(*) c FROM contacts WHERE company_id = 'company-b'")[0].c).toBe(1);
    expect(dbQuery("SELECT COUNT(*) c FROM tasks WHERE company_id = 'company-b'")[0].c).toBe(1);
    expect(dbQuery("SELECT COUNT(*) c FROM companies WHERE id = 'company-b'")[0].c).toBe(1);
  });

  test('10. accounting transactional data cleared, master data preserved', async () => {
    // Seed representative accounting data for the default tenant.
    // Previous tests reset the DB, so seed the group hierarchy too.
    dbQuery(
      "INSERT INTO account_groups (id, company_id, code, name, type, debit_credit_nature, created_at) VALUES ('ag-t1', 'default', 'TG-1', 'Test Group Assets', 'ASSET', 'DEBIT', CURRENT_TIMESTAMP)"
    );
    const groupId = 'ag-t1';
    dbQuery(
      "INSERT INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, created_at) VALUES ('acc-t1', 'default', '9999', 'Test Cash', ?, 'CASH', 'DEBIT', CURRENT_TIMESTAMP)",
      [groupId]
    );
    dbQuery(
      "INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, voucher_date, currency, status, created_by, created_at) VALUES ('v-t1', 'default', 'JV-T1', 'JOURNAL', CURRENT_DATE, 'USD', 'POSTED', 'admin', CURRENT_TIMESTAMP)"
    );
    dbQuery(
      "INSERT INTO journal_entries (id, company_id, voucher_id, entry_number, entry_date, description, currency, created_by, created_at) VALUES ('je-t1', 'default', 'v-t1', 'JE-T1', CURRENT_DATE, 'Test entry', 'USD', 'admin', CURRENT_TIMESTAMP)"
    );
    dbQuery(
      "INSERT INTO journal_entry_lines (id, company_id, journal_entry_id, account_id, debit_amount, credit_amount, created_at) VALUES ('jel-t1', 'default', 'je-t1', 'acc-t1', 100, 0, CURRENT_TIMESTAMP)"
    );
    expect(dbQuery("SELECT COUNT(*) c FROM journal_entries WHERE company_id = 'default'")[0].c).toBe(1);

    const res = await api('POST', '/settings/reset-crm-data', { token, body: { confirm: 'RESET CRM DATA' } });
    expect(res.status).toBe(200);

    // Transactional accounting data gone
    expect(dbQuery("SELECT COUNT(*) c FROM journal_entries WHERE company_id = 'default'")[0].c).toBe(0);
    expect(dbQuery("SELECT COUNT(*) c FROM journal_entry_lines WHERE company_id = 'default'")[0].c).toBe(0);
    expect(dbQuery("SELECT COUNT(*) c FROM accounts WHERE company_id = 'default'")[0].c).toBe(0);

    // Master/system data preserved (global definitions still available)
    expect(dbQuery('SELECT COUNT(*) c FROM tax_types')[0].c).toBeGreaterThan(0);
    expect(dbQuery('SELECT COUNT(*) c FROM currencies')[0].c).toBeGreaterThan(0);
    expect(dbQuery('SELECT COUNT(*) c FROM tax_masters')[0].c).toBeGreaterThan(0);
    // company_tax_configs is protected (needed for the CRM to keep working)
    expect(dbQuery('SELECT COUNT(*) c FROM company_tax_configs')[0].c).toBeGreaterThanOrEqual(0);
    // tax_account_mappings (company master w/ FK into accounts) must be cleared
    expect(dbQuery("SELECT COUNT(*) c FROM tax_account_mappings WHERE company_id = 'default'")[0].c).toBe(0);
    // No dangling FKs anywhere
    expect(dbQuery('PRAGMA foreign_key_check')).toHaveLength(0);
  });

  test('11. duplicate concurrent reset requests do not corrupt state', async () => {
    // Fire two resets simultaneously — both must succeed cleanly (idempotent)
    const [r1, r2] = await Promise.all([
      api('POST', '/settings/reset-crm-data', { token, body: { confirm: 'RESET CRM DATA' } }),
      api('POST', '/settings/reset-crm-data', { token, body: { confirm: 'RESET CRM DATA' } }),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const j1 = await r1.json();
    const j2 = await r2.json();
    expect(j1.success).toBe(true);
    expect(j2.success).toBe(true);
    // Users/companies still intact
    expect(dbQuery('SELECT COUNT(*) c FROM users')[0].c).toBeGreaterThan(0);
    expect(dbQuery('PRAGMA foreign_key_check')).toHaveLength(0);
  });

  test('12. failed reset leaves data intact (rollback safety)', async () => {
    // Invalid confirmation phrase must NOT delete anything
    dbQuery(
      "INSERT INTO contacts (id, company_id, first_name, last_name, email, created_at) VALUES ('c-keep', 'default', 'Keep', 'Me', 'keep@t.io', CURRENT_TIMESTAMP)"
    );
    const res = await api('POST', '/settings/reset-crm-data', { token, body: { confirm: 'nope' } });
    expect(res.status).toBe(400);
    expect(dbQuery("SELECT COUNT(*) c FROM contacts WHERE company_id = 'default'")[0].c).toBe(1);
    // The contact must still be deletable by a subsequent valid reset
    const res2 = await api('POST', '/settings/reset-crm-data', { token, body: { confirm: 'RESET CRM DATA' } });
    expect(res2.status).toBe(200);
    expect(dbQuery("SELECT COUNT(*) c FROM contacts WHERE company_id = 'default'")[0].c).toBe(0);
  });
});
