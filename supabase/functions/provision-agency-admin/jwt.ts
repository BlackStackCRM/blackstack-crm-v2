export const ADMIN_ROLES = new Set(['platform', 'admin', 'mother_company', 'super_admin']);
export const APP_ISSUER = 'blackstack-crm';
export const APP_AUDIENCE = 'blackstack-crm-desktop';

function b64urlDecode(input) {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlDecodeString(input) {
  return new TextDecoder().decode(b64urlDecode(input));
}

export async function verifyAppJwt(jwt, secret) {
  try {
    const parts = String(jwt || '').split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    let header;
    try { header = JSON.parse(b64urlDecodeString(h)); } catch { return null; }
    if (!header || header.alg !== 'HS256') return null;
    let payload;
    try { payload = JSON.parse(b64urlDecodeString(p)); } catch { return null; }
    if (!payload || typeof payload.exp !== 'number') return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (payload.iss !== APP_ISSUER) return null;
    const audOk = payload.aud === APP_AUDIENCE
      || (Array.isArray(payload.aud) && payload.aud.includes(APP_AUDIENCE));
    if (!audOk) return null;
    let sig;
    try { sig = b64urlDecode(s); } catch { return null; }
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function authorizeCallerLive(admin, payload) {
  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) return { ok: false, code: 'UNAUTHORIZED' };

  let user = null;
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return { ok: false, code: 'SUPABASE_AUTH_LOOKUP_FAILED' };
    const users = (data && data.users) || [];
    user = users.find((u) => String(u.email || '').trim().toLowerCase() === email) || null;
    if (user || users.length < 1000) break;
  }
  if (!user) return { ok: false, code: 'UNAUTHORIZED' };
  if (user.disabled) return { ok: false, code: 'FORBIDDEN' };
  const bannedUntil = user.banned_until ? Date.parse(user.banned_until) : NaN;
  if (!Number.isNaN(bannedUntil) && bannedUntil > Date.now()) return { ok: false, code: 'FORBIDDEN' };

  let liveRole = String((user.app_metadata && user.app_metadata.role) || '').toLowerCase();
  const { data: prof, error: pErr } = await admin
    .from('profiles').select('role, is_active').eq('user_id', user.id).maybeSingle();
  if (pErr) return { ok: false, code: 'SUPABASE_AUTH_LOOKUP_FAILED' };
  if (prof) {
    if (prof.is_active === false) return { ok: false, code: 'FORBIDDEN' };
    if (!liveRole) liveRole = String(prof.role || '').toLowerCase();
  }

  if (!liveRole) return { ok: false, code: 'FORBIDDEN' };
  if (!ADMIN_ROLES.has(liveRole)) return { ok: false, code: 'FORBIDDEN' };
  return { ok: true, role: liveRole, live: true };
}