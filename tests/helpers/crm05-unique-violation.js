/**
 * Helper for tests/crm-error-semantics.test.js.
 *
 * Lives in its own file so the embedded script is plain JavaScript rather than a
 * template literal inside the test — an inline literal made the suite impossible
 * for Vite to parse, and a same-line copy of the mapping logic would have tested
 * the copy rather than the real module.
 *
 * Forces a genuine UNIQUE violation against a disposable clone and returns the
 * real classifyError() verdict for it.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// tests/helpers/ -> project root is two levels up.
const ROOT = path.join(__dirname, '..', '..');

function realUniqueViolationVerdict() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm05-unique-'));
  const dbPath = path.join(tmp, 'unique-e2e.db');
  try {
    fs.copyFileSync(path.join(ROOT, 'data', 'blackstack-crm.db'), dbPath);
    process.env.DB_PATH = dbPath;
    process.env.BLACKSTACK_USER_DATA_DIR = tmp;

    const { DatabaseSync } = require('node:sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.prepare('UPDATE financial_years SET is_locked = 0 WHERE company_id = ?').run('default');
    seed.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    seed.close();

    const connMod = require(path.join(ROOT, 'server', 'database', 'connection.js'));
    const conn = new connMod.DatabaseConnection().connect();
    const { classifyError } = require(path.join(ROOT, 'server', 'utils', 'errorMapping.js'));

    const cust = conn.get('SELECT id FROM contacts LIMIT 1').id;
    const cols = 'id, company_id, bill_number, bill_type, contact_id, issue_date, due_date, '
      + 'subtotal, tax, total, status, currency';
    const placeholders = '?,?,?,?,?,?,?,?,?,?,?,?';
    const vals = (id) => [id, 'default', 'WIRED-DUP-1', 'CUSTOMER', cust, '2026-10-09',
      '2026-11-08', 0, 0, 0, 'DRAFT', 'INR'];

    // First insert succeeds; the second violates bills UNIQUE(company_id, bill_number).
    conn.run(`INSERT INTO bills (${cols}) VALUES (${placeholders})`, vals('w1'));
    try {
      conn.run(`INSERT INTO bills (${cols}) VALUES (${placeholders})`, vals('w2'));
      return { raised: false };
    } catch (e) {
      return { raised: true, rawCode: e.code, rawMessage: String(e.message), mapped: classifyError(e) };
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

module.exports = { realUniqueViolationVerdict };