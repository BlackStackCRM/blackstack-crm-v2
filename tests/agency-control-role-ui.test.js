const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function renderAgencyControl(role, mode) {
  const user = { role, hierarchyRole: role, agencyId: 'own-agency', permissions: ['*'] };
  const values = new Map([['crm_user', JSON.stringify(user)]]);
  const host = { innerHTML: '' };
  const context = {
    window: {
      PageModules: {},
      AuthAPI: { getUser: () => user },
      API: { get: async () => ({ agencies: [], customers: [], parentAgency: { id: 'own-agency', name: 'My Agency', status: 'ACTIVE' } }) },
    },
    document: { getElementById: (id) => id === 'page-container' ? host : null },
    localStorage: { getItem: (key) => values.get(key) || null },
    console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/auth/role-permissions.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/pages/agency-control.js'), 'utf8'), context);
  await context.window.PageModules.agencyControl.init(mode);
  return host.innerHTML;
}

describe('Agency Control role UI', () => {
  it('denies sub-agencies the Agency Control page', async () => {
    const html = await renderAgencyControl('sub_agency');
    expect(html).toContain('Agency control access required');
    expect(html).not.toContain('Customer tenants');
  });

  it('renders a customer-only management page for sub-agencies', async () => {
    const html = await renderAgencyControl('sub_agency', 'customers-only');
    expect(html).toContain('Customer Tenants');
    expect(html).toContain('Customer tenants');
    expect(html).not.toContain('Sub-agencies');
    expect(html).not.toContain('ac-create-agency');
    expect(html).not.toContain('ac-bulk-remove');
  });

  it('denies customers the Customer Tenants page', async () => {
    const html = await renderAgencyControl('customer_tenant', 'customers-only');
    expect(html).toContain('Agency control access required');
  });

  it.each(['agency', 'platform'])('%s sees both agency and customer controls', async (role) => {
    const html = await renderAgencyControl(role);
    expect(html).toContain('Sub-agencies');
    expect(html).toContain('ac-create-agency');
    expect(html).toContain('Customer tenants');
  });
});
