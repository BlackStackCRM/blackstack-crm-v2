const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const hierarchySource = fs.readFileSync(
  path.join(__dirname, '../public/js/pages/hierarchy.js'),
  'utf8',
);
const context = { window: { PageModules: {} } };
vm.runInNewContext(hierarchySource, context);
const hierarchy = context.window.PageModules.hierarchy;

describe('My Hierarchy creation controls', () => {
  it('shows only customer creation to sub-agencies', () => {
    hierarchy.role = 'sub_agency';
    expect(hierarchy.canCreateRole('sub_agency')).toBe(false);
    expect(hierarchy.canCreateRole('customer_tenant')).toBe(true);
  });

  it('shows both creation controls to distribution agencies', () => {
    hierarchy.role = 'agency';
    expect(hierarchy.canCreateRole('sub_agency')).toBe(true);
    expect(hierarchy.canCreateRole('customer_tenant')).toBe(true);
  });

  it('shows no creation controls to customer tenants', () => {
    hierarchy.role = 'customer_tenant';
    expect(hierarchy.canCreateRole('sub_agency')).toBe(false);
    expect(hierarchy.canCreateRole('customer_tenant')).toBe(false);
  });

  it('shows actions only for customers to sub-agencies', () => {
    hierarchy.role = 'sub_agency';
    expect(hierarchy.actionMenu('sub_agency', { id: 'sub-1', status: 'ACTIVE' })).toBe('');
    expect(hierarchy.actionMenu('customer_tenant', { id: 'customer-1', status: 'ACTIVE' })).toContain('Add Admin');
  });

  it('shows both hierarchy action menus to distribution agencies', () => {
    hierarchy.role = 'agency';
    expect(hierarchy.actionMenu('sub_agency', { id: 'sub-1', status: 'ACTIVE' })).toContain('Add Admin');
    expect(hierarchy.actionMenu('customer_tenant', { id: 'customer-1', status: 'ACTIVE' })).toContain('Add Admin');
  });

  it('redirects customer tenants away from My Hierarchy', async () => {
    const host = { innerHTML: '' };
    const user = { id: 'customer-user', role: 'USER', hierarchyRole: 'customer_tenant' };
    const values = new Map();
    const isolated = {
      window: {
        PageModules: {},
        location: { hash: '#hierarchy' },
        AuthAPI: { getProfile: async () => user },
        API: { get: async () => ({}) },
      },
      document: { getElementById: (id) => id === 'page-container' ? host : null },
      localStorage: { setItem: (key, value) => values.set(key, value) },
    };
    vm.runInNewContext(hierarchySource, isolated);
    await isolated.window.PageModules.hierarchy.init();
    expect(isolated.window.location.hash).toBe('#dashboard');
    expect(host.innerHTML).toBe('');
  });
});
