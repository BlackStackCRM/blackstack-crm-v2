const fs = require('fs');
const path = require('path');

// ── SUPABASE CREDENTIAL SYNCHRONIZATION ───────────────────────────────────────
//
// Synchronizes SUPABASE_URL and SUPABASE_ANON_KEY from the packaged
// blackstack.env into an existing runtime .env file. Packaged values are
// authoritative for these two keys. A valid runtime value is never replaced
// with an empty packaged value. Unrelated runtime variables are preserved.
//
// Returns { patched: string, changed: boolean }.
function syncSupabaseCredentialsIntoEnv(text, packagedSource) {
  let packagedUrl = '';
  let packagedKey = '';
  if (packagedSource) {
    for (const line of fs.readFileSync(packagedSource, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      if (m[1] === 'SUPABASE_URL') packagedUrl = m[2].trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
      if (m[1] === 'SUPABASE_ANON_KEY') packagedKey = m[2].trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
    }
  }

  const readVar = (name) => {
    const m = text.match(new RegExp('^\\s*' + name + '\\s*=\\s*(.*)\\s*$', 'm'));
    return m ? m[1].trim().replace(/^"|"$/g, '').replace(/^'|'$/g) : '';
  };

  const runtimeUrl = readVar('SUPABASE_URL');
  const runtimeKey = readVar('SUPABASE_ANON_KEY');
  const needsSync = !runtimeUrl || !runtimeKey || runtimeUrl !== packagedUrl || runtimeKey !== packagedKey;

  if (!needsSync || !packagedSource) {
    return { patched: text, changed: false };
  }

  let patched = text;
  let changed = false;
  // Never replace a valid runtime value with an empty packaged value.
  if (packagedUrl && packagedUrl !== runtimeUrl) {
    if (new RegExp('^\\s*SUPABASE_URL\\s*=', 'm').test(patched)) {
      patched = patched.replace(new RegExp('^\\s*SUPABASE_URL\\s*=\\s*.*$', 'm'), `SUPABASE_URL=${packagedUrl}`);
    } else {
      patched += `\nSUPABASE_URL=${packagedUrl}`;
    }
    changed = true;
  }
  if (packagedKey && packagedKey !== runtimeKey) {
    if (new RegExp('^\\s*SUPABASE_ANON_KEY\\s*=', 'm').test(patched)) {
      patched = patched.replace(new RegExp('^\\s*SUPABASE_ANON_KEY\\s*=\\s*.*$', 'm'), `SUPABASE_ANON_KEY=${packagedKey}`);
    } else {
      patched += `\nSUPABASE_ANON_KEY=${packagedKey}`;
    }
    changed = true;
  }
  return { patched, changed };
}

module.exports = { syncSupabaseCredentialsIntoEnv };
