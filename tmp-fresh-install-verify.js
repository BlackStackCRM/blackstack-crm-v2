// Fresh-install smoke test: run migrations + demo seed against the freshly
// provisioned %APPDATA%\blackstack-crm-v2\data\blackstack-crm.db and verify
// the clean-slate admin/company exist.
process.env.DB_PATH = process.env.APPDATA + '\\blackstack-crm-v2\\data\\blackstack-crm.db';
process.env.MIGRATION_BACKUP = 'false';

const { runSafeMigrations } = require('./server/services/safeMigrationRunner');
const { seed } = require('./server/database/seed');
const { getConn } = require('./server/utils/db');

(async () => {
  const r = await runSafeMigrations({ backup: false, recoverStaleLock: true });
  console.log('migrate status:', r.status);
  if (r.status !== 'OK') process.exit(1);
  process.env.DEMO_MODE = 'true';
  await seed();
  const db = getConn();
  const u = db.get("SELECT email, role, status FROM users WHERE email='admin@blackstack.local'");
  console.log('seeded admin:', JSON.stringify(u));
  const c = db.get("SELECT id, name FROM companies WHERE id='default'");
  console.log('default company:', JSON.stringify(c));
  if (!u || !c) { console.error('FAIL: expected rows missing'); process.exit(1); }
  console.log('SUCCESS — migrations + seed on fresh DB');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
