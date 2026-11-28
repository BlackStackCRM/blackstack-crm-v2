process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'anon';

const state = { eqCalls: [], agencies: [], admins: null, profile: null, error: null };

function makeClient() {
  return {
    from(table) {
      let head = false;
      const builder = {
        select(_cols, opts) { if (opts && opts.head) head = true; return builder; },
        eq(col, val) { state.eqCalls.push([table, col, val]); return builder; },
        order() { return builder; },
        range() { return builder; },
        or() { return builder; },
        limit() { return builder; },
        maybeSingle() {
          if (table === 'profiles') return Promise.resolve({ data: state.profile, error: state.error });
          return Promise.resolve({ data: null, error: null });
        },
        then(res, rej) {
          let out;
          if (table === 'agencies') out = head ? { count: state.admins } : { data: state.agencies, error: state.error };
          else if (table === 'agency_administrators') out = { count: state.admins, error: state.error };
          else out = { data: [], error: null };
          return Promise.resolve(out).then(res, rej);
        },
      };
      return builder;
    },
  };
}

const cfg = require('../server/config/supabase');
const clientMod = require('../server/services/supabase.client');
cfg.isConfigured = () => true;
cfg.getSupabaseClient = () => makeClient();
clientMod.supabaseCreateClient = () => makeClient();

const { AgencyService } = require('../server/services/agency.service');
const supa = require('../server/services/supabase.service');

beforeEach(() => {
  state.eqCalls = [];
  state.agencies = [];
  state.admins = null;
  state.profile = null;
  state.error = null;
});

describe('architecture fixes', () => {
  it('exports supabaseAgencyIdForUser', () => {
    expect(typeof supa.supabaseAgencyIdForUser).toBe('function');
  });

  it('supabaseAgencyIdForUser returns the mapped agency id', async () => {
    state.profile = { agency_id: 'agy-cloud-1' };
    await expect(supa.supabaseAgencyIdForUser('uid-1')).resolves.toBe('agy-cloud-1');
  });

  it('supabaseAgencyIdForUser returns null when unmapped', async () => {
    state.profile = null;
    await expect(supa.supabaseAgencyIdForUser('uid-1')).resolves.toBeNull();
  });

  it('supabaseAgencyIdForUser throws on query error (fail closed)', async () => {
    state.error = { message: 'boom' };
    await expect(supa.supabaseAgencyIdForUser('uid-1')).rejects.toThrow(/boom/);
  });

  it('statsFromSupabase maps the local company slug to a cloud UUID', async () => {
    state.agencies = [{ status: 'ACTIVE' }, { status: 'PENDING' }];
    state.admins = 2;
    const svc = new AgencyService({});
    const stats = await svc.statsFromSupabase('default');
    expect(stats.totalAgencies).toBe(2);
    expect(stats.activeAgencies).toBe(1);
    expect(stats.pendingAgencies).toBe(1);
    const uuid = supa.localIdToCloudUuid('default');
    expect(state.eqCalls).toContainEqual(['agencies', 'provider_company_id', uuid]);
    expect(state.eqCalls).not.toContainEqual(['agencies', 'provider_company_id', 'default']);
  });

  it('statsFromSupabase throws when the query errors', async () => {
    state.error = { message: 'nope' };
    const svc = new AgencyService({});
    await expect(svc.statsFromSupabase('default')).rejects.toThrow(/nope/);
  });

  it('listFromSupabase queries by cloud UUID, never the raw slug', async () => {
    state.agencies = [];
    const svc = new AgencyService({});
    await svc.listFromSupabase({ providerCompanyId: 'default' });
    const uuid = supa.localIdToCloudUuid('default');
    expect(state.eqCalls).toContainEqual(['agencies', 'provider_company_id', uuid]);
    expect(state.eqCalls).not.toContainEqual(['agencies', 'provider_company_id', 'default']);
  });

  it('rbac route loads with PasswordService imported', () => {
    const route = require('../server/routes/rbac');
    expect(route).toBeTruthy();
  });
});