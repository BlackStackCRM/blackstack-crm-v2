/* Data-preservation evidence: counts core tables, prints counts only. */
const path = require('path');
const { loadRuntimeEnvironment } = require(path.join(__dirname, '..', 'server', 'config', 'runtimeEnvironment'));
loadRuntimeEnvironment({ envPath: process.env.APPDATA + '\\blackstack-crm-v2\\data\\.env' });
const { getConn } = require(path.join(__dirname, '..', 'server', 'utils', 'db'));
const db = getConn();

const core = ['users', 'companies', 'contacts', 'deals', 'invoices', 'payments',
  'subscriptions', 'auth_sessions', 'schema_migrations', 'roles', 'permissions'];
for (const t of core) {
  const exists = db.get("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?", [t]);
  if (!exists || exists.n === 0) { console.log(`${t}: (absent)`); continue; }
  const row = db.get(`SELECT COUNT(*) n FROM ${t}`);
  console.log(`${t}: ${row.n}`);
}
const tables = db.get("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'");
console.log('total tables:', tables.n);
const jm = db.get('PRAGMA journal_mode');
console.log('journal_mode:', JSON.stringify(jm));
const ic = db.get('PRAGMA integrity_check');
console.log('integrity_check:', JSON.stringify(ic));
process.exit(0);
