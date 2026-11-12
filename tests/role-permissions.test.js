const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPermissions(role, hierarchyRole, grants = ['*']) {
  const values = new Map([['crm_user', JSON.stringify({ role, hierarchyRole, permissions: grants })]]);
  const context = {
    window: { AuthAPI: { getUser: () => JSON.parse(values.get('crm_user')) } },
    localStorage: { getItem: (key) => values.get(key) || null },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/auth/role-permissions.js'), 'utf8'), context);
  return { permissions: context.window.RolePermissions, values };
}

describe('central role capabilities', () => {
  it.each([
    ['ADMIN', 'platform', true, true, true, true, true],
    ['AGENCY', 'agency', false, true, true, true, true],
    ['AGENCY_ADMIN', 'sub_agency', false, false, true, false, false],
    ['USER', 'customer_tenant', false, false, false, false, false],
  ])('%s / %s receives only its hierarchy capabilities', (legacy, hierarchyRole, mother, sub, customer, agencyControl, users) => {
    const { permissions } = loadPermissions(legacy, hierarchyRole);
    expect(permissions.canViewMotherCompany()).toBe(mother);
    expect(permissions.canCreateSubAgency()).toBe(sub);
    expect(permissions.canCreateCustomer()).toBe(customer);
    expect(permissions.canViewAgencyControl()).toBe(agencyControl);
    expect(permissions.canViewUsers()).toBe(users);
    expect(permissions.canViewCustomerTenants()).toBe(hierarchyRole === 'sub_agency');
  });
});

describe('sidebar role restrictions', () => {
  it.each([
    ['platform', true, true, false, true],
    ['agency', false, true, false, true],
    ['sub_agency', false, false, false, false],
    ['customer_tenant', false, false, false, false],
  ])('%s sees only permitted hierarchy navigation', (role, mother, agencyControl, hierarchy, users) => {
    const user = { hierarchyRole: role, role: role === 'platform' ? 'ADMIN' : role, permissions: ['*'] };
    const context = {
      window: { location: { hash: '' }, RolePermissions: null },
      document: { getElementById: () => null },
      localStorage: {
        getItem: (key) => key === 'crm_user' ? JSON.stringify(user) : null,
        setItem() {}, removeItem() {},
      },
      AuthAPI: { getUser: () => user, getProfile: async () => user },
      CustomEvent: function CustomEvent() {},
    };
    context.window.AuthAPI = context.AuthAPI;
    context.window.RolePermissions = loadPermissions(user.role, role).permissions;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/components/Sidebar.js'), 'utf8'), context);
    const sidebar = new context.window.Sidebar('sidebar');
    const visible = sidebar.visibleItems().map((item) => item.path);
    expect(visible.includes('mother-company')).toBe(mother);
    expect(visible.includes('agency-control')).toBe(agencyControl);
    expect(visible.includes('hierarchy')).toBe(hierarchy);
    expect(visible.includes('users')).toBe(users);
    expect(visible.includes('customer-tenants')).toBe(role === 'sub_agency');
  });

  it.each(['agency', 'sub_agency', 'customer_tenant'])(
    '%s retains standard CRM navigation when no hierarchy grants are present',
    (role) => {
      const user = { hierarchyRole: role, role, permissions: [] };
      const context = {
        window: { location: { hash: '' }, RolePermissions: null },
        document: { getElementById: () => null },
        localStorage: {
          getItem: (key) => key === 'crm_user' ? JSON.stringify(user) : null,
          setItem() {}, removeItem() {},
        },
        AuthAPI: { getUser: () => user, getProfile: async () => user },
        CustomEvent: function CustomEvent() {},
      };
      context.window.AuthAPI = context.AuthAPI;
      context.window.RolePermissions = loadPermissions(role, role, []).permissions;
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/components/Sidebar.js'), 'utf8'), context);
      const visible = new context.window.Sidebar('sidebar').visibleItems().map((item) => item.path);
      for (const path of ['dashboard', 'leads', 'contacts', 'deals', 'tasks', 'customer-bills', 'accounting', 'products']) {
        expect(visible, `${role} should retain ${path}`).toContain(path);
      }
    },
  );
});
