/**
 * E-02 GUARD — CustomerBillService must stay CUSTOMER-scoped.
 *
 * This suite exists because audit finding E-02 ("bill type is ignored, a SUPPLIER
 * request creates a CUSTOMER bill") was investigated and found to be a FALSE
 * POSITIVE. Rather than delete the finding silently, this test pins the
 * behaviour that was actually correct, so a future "fix" cannot quietly turn
 * CustomerBillService into a mixed-type writer.
 *
 * THE FACTS AS VERIFIED ON 2026-10-10
 *   - bills.bill_type has CHECK (bill_type IN ('CUSTOMER','SUPPLIER')), so the
 *     column would accept SUPPLIER at the schema level.
 *   - BUT nothing in server/ ever writes SUPPLIER: 0 occurrences outside the
 *     CHECK constraint.
 *   - There is no purchase/supplier route, service or controller.
 *   - customer-bill.controller.js strips `bill_type` from update payloads
 *     (L435) and filters every read by bill_type='CUSTOMER'.
 *   - customer-bill.service.js rejects non-CUSTOMER bills in allocation (L863)
 *     and posting (L894).
 *
 * So the correct invariant is: this service can ONLY ever produce CUSTOMER
 * bills, regardless of what a client sends.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

const SERVICE = fs.readFileSync(
  path.join(ROOT, 'server', 'services', 'customer-bill.service.js'), 'utf8',
);
const CONTROLLER = fs.readFileSync(
  path.join(ROOT, 'server', 'controllers', 'customer-bill.controller.js'), 'utf8',
);
const ROUTE = fs.readFileSync(
  path.join(ROOT, 'server', 'routes', 'customer-bills.js'), 'utf8',
);

describe('E-02 guard — CustomerBillService only ever produces CUSTOMER bills', () => {
  test('createBill pins bill_type to CUSTOMER, ignoring any client value', () => {
    // Locate the createBill billData literal.
    const start = SERVICE.indexOf('createBill(data, userId)');
    expect(start).toBeGreaterThan(-1);
    const body = SERVICE.slice(start, start + 2000);
    expect(body).toMatch(/bill_type:\s*'CUSTOMER'/);
    // Critically: it must NOT read the value from the request.
    expect(body).not.toMatch(/bill_type:\s*data\.bill_type/);
    expect(body).not.toMatch(/bill_type:\s*data\.billType/);
  });

  test('the controller strips bill_type from update payloads', () => {
    expect(CONTROLLER).toMatch(/delete\s+updates\.bill_type\s*;/);
  });

  test('every read path in the controller is CUSTOMER-filtered', () => {
    const filters = CONTROLLER.match(/bill_type\s*=\s*'CUSTOMER'/g) || [];
    expect(filters.length,
      'reads must keep filtering on bill_type=CUSTOMER').toBeGreaterThanOrEqual(4);
  });

  test('allocation and posting refuse a non-CUSTOMER bill', () => {
    expect(SERVICE).toMatch(/if\s*\(allocBill\.bill_type\s*!==\s*'CUSTOMER'\)/);
    expect(SERVICE).toMatch(/if\s*\(bill\.bill_type\s*!==\s*'CUSTOMER'\)/);
  });

  test('the route exposes no client-controlled bill_type', () => {
    expect(ROUTE).not.toMatch(/bill_type/);
  });
});

describe('E-02 guard — no SUPPLIER writer exists anywhere', () => {
  test('server/ contains no code that creates a SUPPLIER bill', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) {
          const c = fs.readFileSync(p, 'utf8');
          // A write of SUPPLIER would be an assignment or an INSERT literal.
          if (/bill_type\s*[:=]\s*'SUPPLIER'/.test(c)
            || /INSERT\s+INTO\s+bills[\s\S]{0,400}?SUPPLIER/i.test(c)) {
            offenders.push(path.relative(ROOT, p));
          }
        }
      }
    };
    walk(path.join(ROOT, 'server'));
    expect(offenders, `SUPPLIER writers found: ${offenders.join(', ')}`).toEqual([]);
  });

  test('there is still no purchase/supplier module masquerading as one', () => {
    const dirs = ['server/routes', 'server/services', 'server/controllers'];
    const found = [];
    for (const d of dirs) {
      for (const f of fs.readdirSync(path.join(ROOT, d))) {
        if (/purchase|supplier/i.test(f)) found.push(f);
      }
    }
    expect(found, 'a purchase/supplier module would change the E-02 analysis').toEqual([]);
  });
});

describe('E-02 guard — the invariant holds against a live server', () => {
  test('POSTing bill_type=SUPPLIER cannot produce a SUPPLIER bill', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e02-'));
    const dbPath = path.join(tmp, 'suite-e2e.db');
    fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), dbPath);
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(path.join(ROOT, 'data', `blackstack-crm.db${ext}`))) {
        try { fs.copyFileSync(path.join(ROOT, 'data', `blackstack-crm.db${ext}`), dbPath + ext); } catch { /* optional */ }
      }
    }
    const port = 32881;
    const code = `
      const { DatabaseSync } = require('node:sqlite');
      const seed = new DatabaseSync(process.env.DB_PATH);
      seed.prepare('UPDATE financial_years SET is_locked = 0 WHERE company_id = ?').run('default');
      seed.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      seed.close();

      const { DatabaseConnection } = require('./server/database/connection.js');
      const { CustomerBillService } = require('./server/services/customer-bill.service.js');
      const conn = new DatabaseConnection().connect();
      const svc = new CustomerBillService(conn);

      // bills.contact_id is NOT NULL, so the probe needs a real contact.
      // Create one, then delete it — this suite cleans up only what it made.
      const contactId = 'cnt_e2e02_' + Date.now().toString(36);
      conn.run(
        'INSERT INTO contacts (id, company_id, first_name, last_name, email, created_at) '
        + "VALUES (?, 'default', 'E2E02', 'Probe', ?, datetime('now'))",
        [contactId, 'e2e02-' + Date.now() + '@example.invalid'],
      );

      // Attempt to force a SUPPLIER bill through the public service API.
      const bill = svc.createBill({
        company_id: 'default',
        bill_type: 'SUPPLIER',
        contact_id: contactId,
        total: 100,
        currency: 'INR',
        notes: 'e2e-02 probe',
      }, 'admin');

      const row = conn.get('SELECT bill_type, notes FROM bills WHERE id = ?', bill.id);
      // Clean up: only the rows this run created.
      conn.run('DELETE FROM bills WHERE id = ?', bill.id);
      conn.run('DELETE FROM contacts WHERE id = ?', contactId);
      console.log(JSON.stringify({ persisted: row.bill_type, note: row.notes }));
      conn.close();
    `;
    const r = spawnSync(process.execPath, ['-e', code], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 90000,
      env: {
        ...process.env,
        DB_PATH: dbPath,
        BLACKSTACK_USER_DATA_DIR: tmp,
        JWT_SECRET: 'e2e02-deterministic-secret-value-32bytes',
        NODE_ENV: 'test',
      },
    });
    fs.rmSync(tmp, { recursive: true, force: true });

    expect(r.status, r.stderr).toBe(0);
    const line = String(r.stdout).trim().split(/\r?\n/).reverse()
      .find((l) => l.trim().startsWith('{'));
    const out = JSON.parse(line);
    expect(out.persisted,
      'a client-supplied bill_type must never reach the database').toBe('CUSTOMER');
  });
});