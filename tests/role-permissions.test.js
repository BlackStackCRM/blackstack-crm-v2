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

  // The fixture used to pass `permissions: []`, modelling a hierarchy account
  // with no grants at all. That state cannot occur: auth.js grants the
  // dashboard baseline to every hierarchy role on each request, auth.service.js
  // grants the same at login, and migration 100 grants role_customer_tenant a
  // broad read-only CRM set. With an empty array every `item.permission` gate
  // in visibleItems() failed, so this block asserted an almost-empty nav and
  // passed for the wrong reason.
  //
  // The grants below are the REAL sets (read from the seeded roles and
  // migrations), and the expectations are what the sidebar must show for them.
  // This still guards the property that matters: standard CRM routes are never
  // role-filtered, so every route the server granted appears here.
  const HIERARCHY_GRANTS = {
    agency: [
      'dashboard.view', 'notifications.view',
      'leads.view', 'contacts.view', 'organizations.view', 'deals.view', 'tasks.view',
      'agency_control.subagencies.view', 'agency_control.subagencies.create',
      'agency_control.agencies.manage', 'agency_control.customers.manage',
    ],
    sub_agency: [
      'dashboard.view', 'notifications.view',
      'agency_control.customers.manage',
    ],
    customer_tenant: [
      'dashboard.view', 'notifications.view',
      'leads.view', 'contacts.view', 'organizations.view', 'deals.view',
      'tasks.view', 'products.view', 'customer_bills.view', 'accounting.view',
      'workflows.view', 'reports.view', 'appointments.view', 'inventory.view',
      'settings.view', 'settings.manage',
    ],
  };

  it.each(['agency', 'sub_agency', 'customer_tenant'])(
    '%s sees exactly the CRM routes its server-granted permissions allow',
    (role) => {
      const user = { hierarchyRole: role, role, permissions: HIERARCHY_GRANTS[role] };
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
      context.window.RolePermissions = loadPermissions(role, role, HIERARCHY_GRANTS[role]).permissions;
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/components/Sidebar.js'), 'utf8'), context);
      const visible = new context.window.Sidebar('sidebar').visibleItems().map((item) => item.path);

      // Routes the server granted for this role must all be present, and no
      // hierarchy-only route may leak in.
      expect(visible).toContain('dashboard');
      expect(visible).not.toContain('mother-company');
      expect(visible).not.toContain('subscriptions');
      expect(visible).not.toContain('storage');

      if (role === 'agency') {
        for (const path of ['leads', 'contacts', 'organizations', 'deals', 'tasks', 'action-center', 'users', 'settings']) {
          expect(visible, `agency should retain ${path}`).toContain(path);
        }
        // Not granted to a distribution agency by the seeded role.
        for (const path of ['customer-bills', 'accounting', 'products', 'workflows', 'reports']) {
          expect(visible, `agency must not see ungranted ${path}`).not.toContain(path);
        }
      } else if (role === 'sub_agency') {
        // A sub-agency is a restricted account: the server grants it only the
        // dashboard and customer-tenant management.
        expect(visible).toEqual(['dashboard', 'profile', 'wallet', 'customer-tenants']);
      } else {
        for (const path of ['leads', 'contacts', 'organizations', 'deals', 'tasks', 'action-center',
          'customer-bills', 'accounting', 'products', 'workflows', 'reports', 'appointments', 'settings']) {
          expect(visible, `customer_tenant should retain ${path}`).toContain(path);
        }
        expect(visible).not.toContain('users');
      }
    },
  );
});
