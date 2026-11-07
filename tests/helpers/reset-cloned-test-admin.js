const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

/** Set deterministic login credentials on an isolated database clone only. */
module.exports = function resetClonedTestAdmin(dbPath) {
  const resolved = path.resolve(dbPath);
  const tempRoot = path.resolve(process.env.TEMP || process.env.TMP || os.tmpdir());
  const insideTemp = resolved.toLowerCase().startsWith((tempRoot + path.sep).toLowerCase());
  if (!insideTemp) throw new Error(`Refusing to alter test credentials outside a temp directory: ${resolved}`);

  const db = new DatabaseSync(resolved);
  try {
    const hash = bcrypt.hashSync('admin123', 10);
    const result = db.prepare("UPDATE users SET password_hash = ?, status = 'ACTIVE' WHERE email = 'admin@blackstack.local'").run(hash);
    if (result.changes !== 1) throw new Error('Expected exactly one seeded test admin in the disposable database clone.');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
};
