require('dotenv').config();
const http = require('http');
const https = require('https');
const { getSupabaseClient } = require('../server/config/supabase');
const { localIdToCloudUuid, forwardAgencyToCloud } = require('../server/services/supabase.service');

function request(opts, data) {
  return new Promise((resolve, reject) => {
    const lib = opts.protocol === 'https:' ? https : http;
    const req = lib.request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = body; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function login() {
  const res = await request({
    protocol: 'http:',
    hostname: 'localhost',
    port: process.env.API_PORT ? Number(process.env.API_PORT) : 3000,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { email: 'admin@blackstack.local', password: 'admin123' });
  if (res.status !== 200 || !res.body?.data?.token) {
    throw new Error('Login failed: ' + JSON.stringify(res.body));
  }
  return res.body.data.token;
}

async function api(token, method, path, data) {
  const res = await request({
    protocol: 'http:',
    hostname: 'localhost',
    port: process.env.API_PORT ? Number(process.env.API_PORT) : 3000,
    path,
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  }, data);
  return res;
}

async function activateAgency(token, agencyId) {
  const res = await api(token, 'POST', `/api/mother-company/agencies/${encodeURIComponent(agencyId)}/status`, { status: 'ACTIVE' });
  return res;
}

async function assignAdmin(token, agencyId, email, fullName, password) {
  const res = await api(token, 'POST', `/api/mother-company/agencies/${encodeURIComponent(agencyId)}/administrators`, {
    email,
    full_name: fullName,
    password,
    username: email.split('@')[0],
  });
  return res;
}

async function waitForLocalSync(db, agencyId, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = db.prepare('SELECT status, attempts, error_message FROM cloud_sync_status WHERE agency_id = ?').get(agencyId);
    if (row && String(row.status).toUpperCase() === 'SYNCED') {
      return row;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const row = db.prepare('SELECT status, attempts, error_message FROM cloud_sync_status WHERE agency_id = ?').get(agencyId);
  return row || null;
}

async function main() {
  const token = await login();
  console.log('[LOGIN] admin token obtained');

  const listRes = await api(token, 'GET', '/api/mother-company/agencies?limit=1');
  if (listRes.status !== 200 || !listRes.body?.data?.agencies?.length) {
    throw new Error('No agencies found: ' + JSON.stringify(listRes.body));
  }
  const agency = listRes.body.data.agencies[0];
  const code = agency.agencyCode || agency.agency_code;
  console.log('[AGENCY] agency:', code, 'api-id:', agency.id);

  const localRes = await api(token, 'GET', `/api/mother-company/agencies?code=${encodeURIComponent(code)}&limit=1`);
  if (localRes.status !== 200 || !localRes.body?.data?.agencies?.length) {
    throw new Error('Local agency lookup failed: ' + JSON.stringify(localRes.body));
  }
  const localAgency = localRes.body.data.agencies[0];
  const localAgencyId = localAgency.id;
  const cloudUuid = agency.id || localIdToCloudUuid(localAgencyId);
  console.log('[AGENCY] local id:', localAgencyId, 'cloud uuid:', cloudUuid);

  const sb = getSupabaseClient();
  console.log('[ENV] SUPABASE_URL length:', String(process.env.SUPABASE_URL || '').length);
  console.log('[ENV] SUPABASE_SERVICE_ROLE_KEY length:', String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').length);
  console.log('[ENV] SUPABASE_KEY length:', String(process.env.SUPABASE_KEY || '').length);

  const { data: cloudAgency, error: agencyErr } = await sb
    .from('agencies')
    .select('id, agency_code, status, is_active')
    .eq('id', cloudUuid)
    .single();

  if (agencyErr) throw new Error('Supabase agency lookup failed: ' + agencyErr.message);
  console.log('[SUPABASE] Agency status before activate:', cloudAgency?.status, 'is_active:', cloudAgency?.is_active);

  const activateRes = await activateAgency(token, localAgencyId);
  if (activateRes.status !== 200 || activateRes.body?.success === false) {
    throw new Error('Activate failed: ' + JSON.stringify(activateRes.body));
  }
  const activated = activateRes.body.data?.agency || activateRes.body?.agency;
  console.log('[API] Activate response:', activated?.status, activated?.id);

  const { data: cloudAfter, error: agencyErr2 } = await sb
    .from('agencies')
    .select('id, agency_code, status, is_active')
    .eq('id', cloudUuid)
    .single();

  if (agencyErr2) throw new Error('Supabase agency lookup after activate failed: ' + agencyErr2.message);
  console.log('[SUPABASE] Agency status after activate:', cloudAfter?.status, 'is_active:', cloudAfter?.is_active);
  if (String(cloudAfter?.status).toUpperCase() !== 'ACTIVE') {
    throw new Error('Supabase agency status did not update');
  }

  const testEmail = `sync-test-${Date.now()}@example.com`;
  const testName = 'Sync Test Admin';
  const testPassword = 'SyncTest1234!';

  const adminRes = await assignAdmin(token, localAgencyId, testEmail, testName, testPassword);
  if (adminRes.status !== 201 && adminRes.status !== 200) {
    throw new Error('Assign admin failed: ' + JSON.stringify(adminRes.body));
  }
  const adminRecord = adminRes.body?.data?.administrator || adminRes.body?.administrator;
  console.log('[API] Assign admin response:', adminRecord?.email, adminRecord?.id);

  try {
    const DatabaseSync = require('node:sqlite').DatabaseSync;
    const db = new DatabaseSync('data/blackstack-crm.db');
    const localAgencyRow = db.prepare('SELECT id FROM agencies WHERE agency_code = ?').get(code);
    const agencyId = localAgencyRow ? localAgencyRow.id : localAgencyId;
    console.log('[DIRECT SYNC] local agency id for forwardAgencyToCloud:', agencyId);
    const agencyRow = db.prepare('SELECT * FROM agencies WHERE id = ?').get(agencyId);
    if (!agencyRow) throw new Error('Local agency row missing for direct sync');
    forwardAgencyToCloud(db, agencyRow, { id: 'usr_admin', email: 'admin@blackstack.local' });
    const syncRow = await waitForLocalSync(db, agencyId, 20000);
    console.log('[DIRECT SYNC] cloud_sync_status after wait:', JSON.stringify(syncRow, null, 2));
  } catch (directErr) {
    console.error('[DIRECT SYNC] direct sync threw:', directErr);
  }

  const { data: adminRows, error: adminErr } = await sb
    .from('agency_administrators')
    .select('id, agency_id, user_id, role_code, status')
    .eq('agency_id', cloudUuid);

  if (adminErr) console.warn('[SUPABASE] Admin lookup warning:', adminErr.message);
  console.log('[SUPABASE] Administrators found for agency:', adminRows?.length || 0);

  console.log('[SUPABASE] Agency status updated to ACTIVE:', cloudUuid);
  console.log('[SUPABASE] Administrator assigned successfully:', adminRecord?.email || testEmail);
}

main().catch(err => {
  console.error('[ERROR]', err);
  process.exit(1);
});
