// Supabase Edge Function: provision-agency-admin
// ----------------------------------------------------------------------------
// TRUSTED SERVER-SIDE provisioning for Mother Company "Assign Agency
// Administrator". The Supabase SERVICE ROLE key lives ONLY here (as a function
// secret) and is never shipped in the desktop app.
//
// Flow:
//   Desktop (anon key + caller JWT) -> this function -> Supabase Auth Admin
//   -> returns the real Auth user id -> desktop writes the local mirror.
//
// Auth: the caller's JWT is verified with the service client; the caller must be
// a Mother Company / platform administrator. Agency existence is re-checked
// server-side. No privileged credential is ever returned to the client.
//
// Deploy (operator, requires the service-role secret):
//   supabase link --project-ref <ref>
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
//   supabase functions deploy provision-agency-admin
//   supabase secrets set SUPABASE_ANON_KEY=<anon-key>   # optional, for CORS apikey
// Config the desktop with: SUPABASE_PROVISION_URL (this function's URL).
// ----------------------------------------------------------------------------

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

const ADMIN_ROLES = new Set(['platform', 'admin', 'mother_company', 'super_admin']);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    return json({ error: { code: 'PROVISION_NOT_CONFIGURED', message: 'Provisioning is not configured on the server.' } }, 503);
  }

  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json({ error: { code: 'UNAUTHORIZED', message: 'Missing caller token.' } }, 401);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // 1. Verify the caller and enforce Mother Company authorization.
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return json({ error: { code: 'UNAUTHORIZED', message: 'Invalid caller token.' } }, 401);
  }
  const callerRole = String(userData.user.app_metadata?.role || '').toLowerCase();
  if (!ADMIN_ROLES.has(callerRole)) {
    return json({ error: { code: 'FORBIDDEN', message: 'Only a Mother Company administrator may assign administrators.' } }, 403);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body.' } }, 400); }

  // Rollback action: used by the desktop if the LOCAL mirror write fails after a
  // new Auth identity was created, so no orphaned Auth user is left behind.
  if (body.action === 'rollback') {
    const uid = String(body.userId || '').trim();
    if (!uid) return json({ error: { code: 'BAD_REQUEST', message: 'userId is required for rollback.' } }, 400);
    const { error } = await admin.auth.admin.deleteUser(uid);
    if (error && error.code !== 'user_not_found') {
      return json({ error: { code: 'SUPABASE_AUTH_ROLLBACK_FAILED', message: 'Could not roll back the Auth identity.' } }, 502);
    }
    return json({ ok: true });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const agencyId = String(body.agencyId || '').trim();
  if (!email || !password || !agencyId) {
    return json({ error: { code: 'VALIDATION_ERROR', message: 'email, password and agencyId are required.' } }, 400);
  }
  if (password.length < 10) {
    return json({ error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 10 characters.' } }, 400);
  }

  // 2. Re-check the agency exists (server-side authority).
  const { data: agency, error: agencyErr } = await admin
    .from('agencies').select('id, agency_code').eq('id', agencyId).maybeSingle();
  if (agencyErr) return json({ error: { code: 'AGENCY_LOOKUP_FAILED', message: 'Could not verify the agency.' } }, 502);
  if (!agency) return json({ error: { code: 'NOT_FOUND', message: 'Agency not found.' } }, 404);

  // 3. Find or create the Auth identity (service role).
  const wanted = email;
  let user = null;
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return json({ error: { code: 'SUPABASE_AUTH_LOOKUP_FAILED', message: 'Could not verify the Supabase Auth account.' } }, 502);
    const users = (data && data.users) || [];
    user = users.find((u) => String(u.email || '').trim().toLowerCase() === wanted) || null;
    if (user || users.length < 1000) break;
  }

  let created = false;
  const currentRole = String(user?.app_metadata?.role || '').toLowerCase();
  const currentAgency = user?.app_metadata?.agency_id;
  if (user && currentRole && !['agency', 'agency_admin'].includes(currentRole)) {
    return json({ error: { code: 'CONFLICT', message: 'That Supabase account belongs to a different account type.' } }, 409);
  }
  if (user && currentAgency && currentAgency !== agencyId) {
    return json({ error: { code: 'CONFLICT', message: 'That Supabase account is already assigned to another agency.' } }, 409);
  }

  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
      app_metadata: { role: 'agency', agency_id: agencyId },
    });
    if (error) {
      // Concurrent signup may have won; re-read and link.
      const { data: again } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      user = ((again && again.users) || []).find((u) => String(u.email || '').trim().toLowerCase() === wanted) || null;
      if (!user) return json({ error: { code: 'SUPABASE_AUTH_CREATE_FAILED', message: 'Could not create the Supabase Auth account.' } }, 502);
    } else {
      user = data && data.user;
      created = true;
    }
  }
  if (!user?.id) return json({ error: { code: 'SUPABASE_AUTH_INVALID_RESPONSE', message: 'Supabase Auth returned no user identity.' } }, 502);

  if (!created) {
    const { error } = await admin.auth.admin.updateUserById(user.id, {
      password,
      app_metadata: { ...(user.app_metadata || {}), role: 'agency', agency_id: agencyId },
    });
    if (error) return json({ error: { code: 'SUPABASE_AUTH_LINK_FAILED', message: 'Could not link the existing Supabase Auth account.' } }, 502);
  }

  return json({ user: { id: user.id, email: user.email }, created });
});