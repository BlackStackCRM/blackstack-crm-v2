const { Authorizer } = require('../auth/authorizer');
const { RelationshipRepository } = require('../repositories/relationship.repository');
const { AuditRepository } = require('../repositories/audit.repository');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');

class RelationshipService {
  constructor(conn) {
    this.conn = conn;
    this.relationshipRepo = new RelationshipRepository(conn);
    this.auditRepo = new AuditRepository(conn);
  }

  list(options, context) {
    Authorizer.assertPermission(context, 'contacts.view');
    return this.relationshipRepo.search(context.companyId, options);
  }

  get(id, context) {
    Authorizer.assertPermission(context, 'contacts.view');
    const rel = this.relationshipRepo.findById(id, context.companyId);
    if (!rel) throw new NotFoundError('Relationship', id);
    return rel;
  }

  create(data, context) {
    Authorizer.assertPermission(context, 'contacts.create');
    if (!data.relationship_type) throw new ValidationError('Relationship type is required.');
    if (!data.person_a_id) throw new ValidationError('person_a_id is required.');
    const rel = { id: generateId('rel'), company_id: context.companyId, ...data, status: data.status || 'ACTIVE' };
    const created = this.relationshipRepo.create(rel);
    this.auditRepo.log({
      id: generateId('aud'), user_id: context.userId,
      action: 'RELATIONSHIP_CREATED', entity_type: 'RELATIONSHIP', entity_id: created.id,
      new_values_json: JSON.stringify(data), session_id: context.sessionId
    });
    return created;
  }

  update(id, data, context) {
    Authorizer.assertPermission(context, 'contacts.edit');
    const existing = this.relationshipRepo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Relationship', id);
    const updated = this.relationshipRepo.update(id, context.companyId, data);
    this.auditRepo.log({
      id: generateId('aud'), user_id: context.userId,
      action: 'RELATIONSHIP_UPDATED', entity_type: 'RELATIONSHIP', entity_id: id,
      old_values_json: JSON.stringify(existing), new_values_json: JSON.stringify(data),
      session_id: context.sessionId
    });
    return updated;
  }

  delete(id, context) {
    Authorizer.assertPermission(context, 'contacts.delete');
    const existing = this.relationshipRepo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Relationship', id);
    const ok = this.relationshipRepo.delete(id, context.companyId);
    if (ok) {
      this.auditRepo.log({
        id: generateId('aud'), user_id: context.userId,
        action: 'RELATIONSHIP_DELETED', entity_type: 'RELATIONSHIP', entity_id: id,
        old_values_json: JSON.stringify(existing), session_id: context.sessionId
      });
    }
    return ok;
  }
}

module.exports = { RelationshipService };