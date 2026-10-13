const { Authorizer } = require('../auth/authorizer');
const { OrganizationRepository } = require('../repositories/organization.repository');
const { AuditRepository } = require('../repositories/audit.repository');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');

class OrganizationService {
  constructor(conn) {
    this.conn = conn;
    this.orgRepo = new OrganizationRepository(conn);
    this.auditRepo = new AuditRepository(conn);
  }

  list(options, context) {
    Authorizer.assertPermission(context, 'organizations.view');
    return this.orgRepo.search(context.companyId, options);
  }

  get(id, context) {
    Authorizer.assertPermission(context, 'organizations.view');
    const org = this.orgRepo.findById(id, context.companyId);
    if (!org) throw new NotFoundError('Organization', id);
    return org;
  }

  create(data, context) {
    Authorizer.assertPermission(context, 'organizations.create');
    if (!data.name) throw new ValidationError('Organization name is required.');
    const org = { id: generateId('org'), company_id: context.companyId, ...data, status: data.status || 'ACTIVE' };
    const created = this.orgRepo.create(org);
    this.auditRepo.log({
      id: generateId('aud'), user_id: context.userId,
      action: 'ORGANIZATION_CREATED', entity_type: 'ORGANIZATION', entity_id: created.id,
      new_values_json: JSON.stringify(data), session_id: context.sessionId
    });
    return created;
  }

  update(id, data, context) {
    Authorizer.assertPermission(context, 'organizations.edit');
    const existing = this.orgRepo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Organization', id);
    const updated = this.orgRepo.update(id, context.companyId, data);
    this.auditRepo.log({
      id: generateId('aud'), user_id: context.userId,
      action: 'ORGANIZATION_UPDATED', entity_type: 'ORGANIZATION', entity_id: id,
      old_values_json: JSON.stringify(existing), new_values_json: JSON.stringify(data),
      session_id: context.sessionId
    });
    return updated;
  }

  delete(id, context) {
    Authorizer.assertPermission(context, 'organizations.delete');
    const existing = this.orgRepo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Organization', id);
    const ok = this.orgRepo.delete(id, context.companyId);
    if (ok) {
      this.auditRepo.log({
        id: generateId('aud'), user_id: context.userId,
        action: 'ORGANIZATION_DELETED', entity_type: 'ORGANIZATION', entity_id: id,
        old_values_json: JSON.stringify(existing), session_id: context.sessionId
      });
    }
    return ok;
  }
}

module.exports = { OrganizationService };