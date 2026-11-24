// Read the runtime .env exactly the way env-sync.js does, and report
// (redacted) what it sees for the two Supabase keys.
const fs = require('fs');
const path = require('path');
const envPath = path.join(process.env.APPDATA, 'blackstack-crm-v2', 'data', '.env');
const packagedPath = 'C:\\Program Files\\BlackStack CRM\\resources\\blackstack.env';

const readVar = (text, name) => {
  const m = text.match(new RegExp('^\\s*' + name + '\\s*=\\s*(.*)\\s*$', 'm'));
  return m ? m[1].trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '') : '';
};

const runtime = fs.readFileSync(envPath, 'utf8');
const packaged = fs.readFileSync(packagedPath, 'utf8');

const ru = readVar(runtime, 'SUPABASE_URL');
const rk = readVar(runtime, 'SUPABASE_ANON_KEY');
const pu = readVar(packaged, 'SUPABASE_URL');
const pk = readVar(packaged, 'SUPABASE_ANON_KEY');

console.log('runtime  SUPABASE_URL      :', ru === '' ? '(EMPTY)' : ru);
console.log('runtime  SUPABASE_ANON_KEY :', rk === '' ? '(EMPTY)' : `present, ${rk.length} chars, starts '${rk.slice(0, 6)}...'`);
console.log('packaged SUPABASE_URL      :', pu === '' ? '(EMPTY)' : pu);
console.log('packaged SUPABASE_ANON_KEY :', pk === '' ? '(EMPTY)' : `present, ${pk.length} chars, starts '${pk.slice(0, 6)}...'`);
console.log('url matches packaged :', ru === pu);
console.log('key matches packaged :', rk === pk);
console.log('env-sync would patch :', (!ru || !rk || ru !== pu || rk !== pk) && !!(pu || pk));
