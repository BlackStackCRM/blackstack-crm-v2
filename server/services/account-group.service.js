const { Authorizer } = require('../auth/authorizer');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { AccountGroupRepository } = require('../repositories/account-group.repository');
const { generateId } = require('../utils/generateId');
const CodeGenerator = require('./code-generator.service');

/**
 * Service layer for Account Group (hierarchical grouping) management.
 *
 * Enforces the core accounting rule: Account Groups are NOT posting accounts.
 * They can contain child groups and ledger accounts, but cannot receive direct
 * journal postings.
 */
class AccountGroupService {
  constructor(conn) {
    this.conn = conn;
  }

  _repo() {
    return new AccountGroupRepository(this.conn);
  }

  _audit(context, action, entityType, entityId, oldValues, newValues) {
    const { AccountingAuditRepository } = require('../repositories/accounting-audit.repository');
    new AccountingAuditRepository(this.conn).log({
      id: generateId('aud'),
      company_id: context.companyId,
      user_id: context.userId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      old_values_json: oldValues ? JSON.stringify(oldValues) : null,
      new_values_json: newValues ? JSON.stringify(newValues) : null,
      session_id: context.sessionId
    });
  }

  /** ── LIST / SEARCH ──────────────────────────────────────────────── */
  list(context, query = {}) {
    Authorizer.assertPermission(context, 'accounting.manage');
    const repo = this._repo();
    const result = repo.search({
      companyId: context.companyId,
      type: query.type,
      isActive: query.isActive !== undefined ? query.isActive : true,
      parentId: query.parentId,
      query: query.q,
      limit: parseInt(query.limit) || 500,
      offset: parseInt(query.offset) || 0
    });
    return result;
  }

  /** ── TREE ───────────────────────────────────────────────────────── */
  getFullTree(context) {
    Authorizer.assertPermission(context, 'accounting.view');
    const repo = this._repo();
    return repo.getFullTree(context.companyId);
  }

  getGroupTree(context) {
    Authorizer.assertPermission(context, 'accounting.view');
    const repo = this._repo();
    return repo.getGroupTree(context.companyId);
  }

  /** ── GET ────────────────────────────────────────────────────────── */
  get(id, context) {
    Authorizer.assertPermission(context, 'accounting.manage');
    const repo = this._repo();
    const group = repo.findById(id, context.companyId);
    if (!group) throw new NotFoundError('AccountGroup', id);
    return group;
  }

  /** ── CREATE ─────────────────────────────────────────────────────── */
  create(data, context) {
    Authorizer.assertPermission(context, 'accounting.manage');
    const repo = this._repo();
    const conn = this.conn;

    const companyId = context.companyId;

    // ── Required fields ──
    // Group Code is system-generated; only Name and Account Type are required
    // from the user. A blank/absent code is auto-generated; a client-supplied
    // code is still honoured but validated for uniqueness below.
    if (!data.name || !data.type) {
      throw new ValidationError('Group Name, and Account Type are required');
    }
    if (!data.code || !String(data.code).trim()) {
      data.code = CodeGenerator.generate(conn, 'ACCOUNT_GROUP', companyId);
    }

    const validTypes = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
    const typeUpper = data.type.toUpperCase();
    if (!validTypes.includes(typeUpper)) {
      throw new ValidationError('Invalid Account Type. Must be one of: ' + validTypes.join(', '));
    }

    // ── Unique code within company ──
    const existing = conn.get(
      `SELECT id FROM account_groups WHERE code = ? AND company_id = ? LIMIT 1`,
      [data.code, companyId]
    );
    if (existing) {
      throw new ValidationError(`Group Code ${data.code} already exists in this company`);
    }

    // ── Parent validation ──
    let parentId = data.parent_id || data.parentGroupId || null;
    if (parentId === '' || parentId === 'null') parentId = null;

    if (parentId) {
      // Parent must exist and belong to this company
      const parent = repo.findById(parentId, companyId);
      if (!parent) throw new ValidationError('Parent group not found or does not belong to this company');

      // Prevent self-parent
      // (id is generated below, but we can't check against it yet — handled post-generation)
    }

    // Determine debit_credit_nature
    const nature = typeUpper === 'LIABILITY' || typeUpper === 'EQUITY' || typeUpper === 'INCOME' ? 'CREDIT' : 'DEBIT';

    // ── Type inheritance: child type must match parent type ──
    if (parentId) {
      const parent = repo.getParent(parentId, companyId);
      if (parent && parent.type !== typeUpper) {
        throw new ValidationError(
          `Account Type must match parent group "${parent.name}" (type: ${parent.type}). ` +
          `You cannot create a ${typeUpper} group under a ${parent.type} group.`
        );
      }
      if (parent && parent.debit_credit_nature !== nature) {
        throw new ValidationError(
          `Debit/Credit nature must match parent group "${parent.name}".`
        );
      }
    }

    // ── Generate ID and check self-parent (only possible if user passes the new ID as parent,
    //     which they can't — but we guard anyway) ──
    const id = generateId('ag');

    if (parentId && parentId === id) {
      throw new ValidationError('A group cannot be its own parent');
    }

    // ── Circular hierarchy detection ──
    if (parentId && repo.checkCircular(id, parentId, companyId)) {
      throw new ValidationError('Circular hierarchy detected: the selected parent is a descendant of this group');
    }

    const now = new Date().toISOString();
    const isActive = data.is_active !== undefined ? data.is_active : true;
    const allowChildAccounts = data.allow_child_accounts !== undefined ? data.allow_child_accounts : true;

    conn.prepare(`
      INSERT INTO account_groups
        (id, company_id, code, name, parent_id, type, debit_credit_nature,
         is_active, allow_child_accounts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, companyId, data.code.trim(), data.name.trim(),
      parentId, typeUpper, nature,
      isActive ? 1 : 0, allowChildAccounts ? 1 : 0,
      now, now
    );

    const created = conn.get(
      `SELECT * FROM account_groups WHERE id = ? AND company_id = ?`,
      [id, companyId]
    );

    this._audit(context, 'ACCOUNT_GROUP_CREATED', 'ACCOUNT_GROUP', id, null, created);
    return created;
  }

  /** ── UPDATE ─────────────────────────────────────────────────────── */
  update(id, data, context) {
    Authorizer.assertPermission(context, 'accounting.manage');
    const repo = this._repo();
    const conn = this.conn;
    const companyId = context.companyId;

    const existing = repo.findById(id, companyId);
    if (!existing) throw new NotFoundError('AccountGroup', id);

    // Lock: code, type, debit_credit_nature cannot change once transactions exist
    // (allowed to change for groups without children, but type changes are risky)
    const hasChildren = repo.getChildGroupCount(id, companyId) > 0 ||
                        repo.getChildAccountCount(id, companyId) > 0;

    const updates = {};
    const setFields = ['name', 'description'];

    // Code can be changed if no children
    if (data.code !== undefined) {
      if (hasChildren) {
        throw new ValidationError('Cannot change the Group Code of a group that has child accounts or sub-groups. Move children first.');
      }
      if (data.code.trim() !== existing.code) {
        const dup = conn.get(
          `SELECT id FROM account_groups WHERE code = ? AND company_id = ? AND id != ?`,
          [data.code, companyId, id]
        );
        if (dup) throw new ValidationError(`Group Code ${data.code} already exists`);
        updates.code = data.code.trim();
      }
    }

    // Type cannot change if the group has children
    if (data.type !== undefined) {
      const typeUpper = data.type.toUpperCase();
      if (!['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'].includes(typeUpper)) {
        throw new ValidationError('Invalid Account Type');
      }
      if (hasChildren) {
        throw new ValidationError('Cannot change Account Type of a group that has child accounts or sub-groups.');
      }
      updates.type = typeUpper;
      updates.debit_credit_nature = typeUpper === 'LIABILITY' || typeUpper === 'EQUITY' || typeUpper === 'INCOME' ? 'CREDIT' : 'DEBIT';
    }

    if (data.name !== undefined) updates.name = data.name.trim();
    if (data.description !== undefined) updates.description = data.description;
    if (data.is_active !== undefined) updates.is_active = data.is_active ? 1 : 0;
    if (data.allow_child_accounts !== undefined) updates.allow_child_accounts = data.allow_child_accounts ? 1 : 0;

    // Parent change
    let newParentId = data.parent_id;
    if (newParentId !== undefined) {
      if (newParentId === '' || newParentId === 'null') newParentId = null;

      if (newParentId === id) {
        throw new ValidationError('A group cannot be its own parent');
      }

      if (newParentId) {
        const parent = repo.findById(newParentId, companyId);
        if (!parent) throw new ValidationError('Parent group not found or does not belong to this company');

        // Type inheritance check
        const parentType = parent.type;
        const currentType = existing.type;
        if (parentType !== currentType) {
          throw new ValidationError(
            `Account Type must match parent group "${parent.name}" (type: ${parentType}).`
          );
        }

        // Circular detection
        if (repo.checkCircular(id, newParentId, companyId)) {
          throw new ValidationError('Circular hierarchy detected');
        }
      }
      updates.parent_id = newParentId;
    }

    if (Object.keys(updates).length > 0) {
      const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      const values = Object.values(updates);
      conn.prepare(
        `UPDATE account_groups SET ${setClause}, updated_at = datetime('now') WHERE id = ? AND company_id = ?`
      ).run(...values, id, companyId);
    }

    const updated = conn.get(`SELECT * FROM account_groups WHERE id = ? AND company_id = ?`, [id, companyId]);
    this._audit(context, 'ACCOUNT_GROUP_MODIFIED', 'ACCOUNT_GROUP', id, existing, updated);
    return updated;
  }

  /** ── DELETE ─────────────────────────────────────────────────────── */
  remove(id, context) {
    Authorizer.assertPermission(context, 'accounting.manage');
    const repo = this._repo();
    const conn = this.conn;
    const companyId = context.companyId;

    const existing = repo.findById(id, companyId);
    if (!existing) throw new NotFoundError('AccountGroup', id);

    // ── Prevent deletion if contains child groups ──
    const childGroups = repo.getChildGroupCount(id, companyId);
    if (childGroups > 0) {
      throw new ValidationError(
        'Cannot delete this account group because it contains child groups. ' +
        'Move or delete the child groups first.'
      );
    }

    // ── Prevent deletion if contains ledger accounts ──
    const childAccounts = repo.getChildAccountCount(id, companyId);
    if (childAccounts > 0) {
      throw new ValidationError(
        'Cannot delete this account group because it contains child accounts. ' +
        'Move or delete the child accounts first.'
      );
    }

    // ── Prevent deletion if any descendant accounts have transactions ──
    if (repo.hasTransactionsThroughChildren(id, companyId)) {
      throw new ValidationError(
        'Cannot delete this account group because accounts under it have posted journal entries.'
      );
    }

    conn.prepare(`DELETE FROM account_groups WHERE id = ? AND company_id = ?`).run(id, companyId);
    this._audit(context, 'ACCOUNT_GROUP_DELETED', 'ACCOUNT_GROUP', id, existing, null);
    return { success: true, id };
  }

  /** ── SUGGEST TYPE FROM PARENT ────────────────────────────────────── */
  suggestFromParent(parentId, context) {
    Authorizer.assertPermission(context, 'accounting.manage');
    const repo = this._repo();
    return repo.suggestFromParent(parentId, context.companyId);
  }
}

module.exports = { AccountGroupService };
