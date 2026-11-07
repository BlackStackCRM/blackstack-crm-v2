const { AppError } = require('../utils/errors');

const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

async function findAuthUserByEmail(client, email) {
  const wanted = String(email || '').trim().toLowerCase();
  if (!wanted) return null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    if (error) {
      throw new AppError('Could not verify the Supabase Auth account.', 'SUPABASE_AUTH_LOOKUP_FAILED', 502);
    }
    const users = (data && data.users) || [];
    const match = users.find((user) => String(user.email || '').trim().toLowerCase() === wanted);
    if (match) return match;
    if (users.length < PAGE_SIZE) return null;
  }
  throw new AppError('Supabase Auth lookup reached its pagination safety limit.', 'SUPABASE_AUTH_LOOKUP_INCOMPLETE', 503);
}

async function ensureAgencyAuthUser(client, { email, password, agencyId, existingUser }) {
  let user = existingUser === undefined ? await findAuthUserByEmail(client, email) : existingUser;
  let created = false;
  const currentRole = String(user?.app_metadata?.role || '').toLowerCase();
  const currentAgency = user?.app_metadata?.agency_id;
  if (user && currentRole && !['agency', 'agency_admin'].includes(currentRole)) {
    throw new AppError('That Supabase account belongs to a different account type.', 'CONFLICT', 409);
  }
  if (user && currentAgency && currentAgency !== agencyId) {
    throw new AppError('That Supabase account is already assigned to another agency.', 'CONFLICT', 409);
  }

  if (!user) {
    const { data, error } = await client.auth.admin.createUser({
      email: String(email).trim().toLowerCase(),
      password,
      email_confirm: true,
      app_metadata: { role: 'agency', agency_id: agencyId },
    });
    if (error) {
      // A concurrent signup may win after our paginated lookup. Re-read the
      // Auth directory and link that identity instead of exposing a raw error.
      user = await findAuthUserByEmail(client, email);
      if (!user) throw new AppError('Could not create the Supabase Auth account.', 'SUPABASE_AUTH_CREATE_FAILED', 502);
    } else {
      user = data && data.user;
      created = true;
    }
  }
  if (!user?.id) throw new AppError('Supabase Auth returned no user identity.', 'SUPABASE_AUTH_INVALID_RESPONSE', 502);

  if (!created) {
    const { data, error } = await client.auth.admin.updateUserById(user.id, {
      password,
      app_metadata: { ...(user.app_metadata || {}), role: 'agency', agency_id: agencyId },
    });
    if (error) throw new AppError('Could not link the existing Supabase Auth account.', 'SUPABASE_AUTH_LINK_FAILED', 502);
    user = data && data.user ? data.user : user;
  }
  return { user, created };
}

module.exports = { findAuthUserByEmail, ensureAgencyAuthUser };
