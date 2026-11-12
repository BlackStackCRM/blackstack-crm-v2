// Central role and capability checks for role-based UI rendering.
// The server remains authoritative; these helpers only shape the interface.
(function () {
  'use strict';

  const ROLE_CAPABILITIES = {
    platform: ['createAgency', 'createSubAgency', 'createCustomer', 'manageSubAgencies', 'manageCustomers', 'viewUsers', 'viewSettings', 'viewMotherCompany', 'viewAgencyControl'],
    agency: ['createSubAgency', 'createCustomer', 'manageSubAgencies', 'manageCustomers', 'viewUsers', 'viewSettings', 'viewAgencyControl'],
    sub_agency: ['createCustomer', 'manageCustomers', 'viewCustomerTenants'],
    customer_tenant: ['viewSettings'],
  };

  function normalizeRole(user) {
    if (!user) return null;
    const explicit = String(user.hierarchyRole || user.hierarchy_role || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, explicit)) return explicit;
    const legacy = String(user.role || '').toLowerCase();
    if (legacy === 'admin' || legacy === 'platform') return 'platform';
    if (legacy === 'agency') return 'agency';
    if (legacy === 'agency_admin' || legacy === 'sub_agency') return 'sub_agency';
    if (legacy === 'customer_admin' || legacy === 'customer_tenant') return 'customer_tenant';
    return null;
  }

  function currentUser() {
    try {
      if (window.AuthAPI && typeof window.AuthAPI.getUser === 'function') {
        const user = window.AuthAPI.getUser();
        if (user) return user;
      }
      return JSON.parse(localStorage.getItem('crm_user') || 'null');
    } catch { return null; }
  }

  const RolePermissions = {
    normalizeRole,
    hasRole(...roles) {
      return roles.flat().includes(normalizeRole(currentUser()));
    },
    role() { return normalizeRole(currentUser()); },
    can(capability) {
      return (ROLE_CAPABILITIES[normalizeRole(currentUser())] || []).includes(capability);
    },
    hasPermission(permission) {
      const user = currentUser();
      const permissions = Array.isArray(user && user.permissions) ? user.permissions : [];
      return permissions.includes('*') || permissions.includes(permission);
    },
    canCreateAgency() { return this.can('createAgency'); },
    canCreateSubAgency() { return this.can('createSubAgency'); },
    canCreateCustomer() { return this.can('createCustomer'); },
    canManageSubAgencies() { return this.can('manageSubAgencies'); },
    canManageCustomers() { return this.can('manageCustomers'); },
    canViewUsers() { return this.can('viewUsers'); },
    canViewSettings() { return this.can('viewSettings'); },
    canViewMotherCompany() { return this.can('viewMotherCompany'); },
    canViewAgencyControl() { return this.can('viewAgencyControl'); },
    canViewCustomerTenants() { return this.can('viewCustomerTenants'); },
  };

  window.RolePermissions = RolePermissions;
})();
