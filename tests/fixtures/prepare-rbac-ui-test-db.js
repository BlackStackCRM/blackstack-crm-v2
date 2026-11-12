// Take a consistent SQLite backup into the OS temp directory, then seed only
// that disposable clone with the deterministic accounts used by rbac-ui.spec.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

async function main() {
  if (process.env.DB_PATH) throw new Error('Unset DB_PATH before preparing the RBAC UI test database.');
  const root = path.resolve(os.tmpdir(), `bscrm-rbac-ui-${Date.now()}-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const sourcePath = path.resolve(__dirname, '../../data/blackstack-crm.db');
  const testDbPath = path.join(root, 'suite-e2e.db');
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, testDbPath);
  } finally {
    source.close();
  }
  process.env.DB_PATH = testDbPath;
  require('./seed-rbac-ui-users');
  console.log(`RBAC_UI_TEST_DB=${testDbPath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
