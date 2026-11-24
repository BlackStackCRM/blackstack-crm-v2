/**
 * REPAIR: re-run the exact env-sync logic the packaged app runs at startup,
 * restoring SUPABASE_URL / SUPABASE_ANON_KEY from the packaged blackstack.env
 * into the runtime .env. Dry-run by default; pass --apply to write.
 * Prints only lengths/booleans, never key values.
 */
const fs = require('fs');
const path = require('path');
const { syncSupabaseCredentialsIntoEnv } = require('../electron/env-sync');

const envPath = path.join(process.env.APPDATA, 'blackstack-crm-v2', 'data', '.env');
const packagedPath = process.argv[3]
  || 'C:\\Program Files\\BlackStack CRM\\resources\\blackstack.env';

if (!fs.existsSync(packagedPath)) {
  console.error('Packaged env not found at', packagedPath);
  process.exit(1);
}

const text = fs.readFileSync(envPath, 'utf8');
const before = {
  url: (text.match(/^SUPABASE_URL=(.*)$/m) || [])[1] || '',
  key: (text.match(/^SUPABASE_ANON_KEY=(.*)$/m) || [])[1] || '',
};
const result = syncSupabaseCredentialsIntoEnv(text, packagedPath);
const after = {
  url: (result.patched.match(/^SUPABASE_URL=(.*)$/m) || [])[1] || '',
  key: (result.patched.match(/^SUPABASE_ANON_KEY=(.*)$/m) || [])[1] || '',
};

const describe = (v) => (v && v.trim() ? `set (${v.trim().length} chars)` : 'EMPTY');
console.log('runtime SUPABASE_URL      before:', describe(before.url), '→ after:', describe(after.url));
console.log('runtime SUPABASE_ANON_KEY before:', describe(before.key), '→ after:', describe(after.key));
console.log('would change:', result.changed);

if (process.argv[2] === '--apply') {
  if (result.changed) {
    fs.writeFileSync(envPath, result.patched, 'utf8');
    console.log('APPLIED — runtime .env updated.');
  } else {
    console.log('Nothing to apply.');
  }
} else {
  console.log('(dry run — pass --apply to write)');
}
