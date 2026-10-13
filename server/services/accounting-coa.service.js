const { Authorizer } = require('../auth/authorizer');
const { NotFoundError, ValidationError } = require('../utils/errors');
const CodeGenerator = require('./code-generator.service');
const { assertTenantRefs } = require('../utils/tenantScope');
const { validateCurrency } = require('../utils/currency');
const { generateId } = require('../utils/generateId');

/**
 * Service layer for Chart of Accounts management.
 */
class ChartOfAccountsService {
  constructor(conn) {
    this.conn = conn;
  }

  list(context, query = {}) {
    const repo = this._repo();
    Authorizer.assertPermission(context, 'accounting.view');
    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 50;
    const offset = (page - 1) * limit;
    const result = repo.search({
      companyId: context.companyId,
      type: query.type,
      groupId: query.groupId,
      isActive: query.isActive !== undefined ? query.isActive : undefined,
      query: query.q,
      limit, offset
    });
    return { items: result.items, total: result.total };
  }

  get(id, context) {
    const repo = this._repo();
    Authorizer.assertPermission(context, 'accounting.view');
    const item = repo.getWithGroup(id, context.companyId);
    if (!item) throw new NotFoundError('Account', id);
    return item;
  }

  create(data, context) {
    const repo = this._repo();
    Authorizer.assertPermission(context, 'coa.manage');
    if (!data.name || !data.account_group_id) {
      throw new ValidationError('Account name, and group are required');
    }
    // Account Code is system-generated; a client-supplied code is honoured
    // but must still be unique (validated below / unique index backstop).
    if (!data.code || !String(data.code).trim()) {
      data.code = CodeGenerator.generate(this.conn, 'LEDGER_ACCOUNT', context.companyId);
    }

    // Verify account group exists in this tenant
    const group = this.conn.get('SELECT id, type, debit_credit_nature FROM account_groups WHERE id = ? AND company_id = ?', [data.account_group_id, context.companyId]);
    if (!group) throw new ValidationError('Account group does not exist');

    // Verify type matches group type
    if (data.type && data.type !== group.type && group.type !== data.type) {
      // Allow type override only if consistent with group nature
      const groupNature = this.conn.get('SELECT type, debit_credit_nature FROM account_groups WHERE id = ?', [data.account_group_id]);
      if (groupNature && data.debit_credit_nature !== groupNature.debit_credit_nature) {
        throw new ValidationError('Account debit/credit nature must match its account group');
      }
    }

    const id = generateId('acc');
    const now = new Date().toISOString();
    const account = {
      id, company_id: context.companyId, code: data.code, name: data.name,
      account_group_id: data.account_group_id,
      type: data.type || group.type,
      debit_credit_nature: data.debit_credit_nature || group.debit_credit_nature,
      opening_balance: data.opening_balance || 0,
      opening_balance_type: data.opening_balance_type || group.debit_credit_nature,
      description: data.description || null,
      is_active: data.is_active !== false ? 1 : 0,
      created_at: now, updated_at: now
    };

    const cols = Object.keys(account);
    const placeholders = cols.map(() => '?').join(', ');
    this.conn.run(`INSERT INTO accounts (${cols.join(', ')}) VALUES (${placeholders})`, cols.map(k => account[k]));

    this._audit(context, 'ACCOUNT_CREATED', 'ACCOUNT', id, null, account);
    return account;
  }

  update(id, data, context) {
    const repo = this._repo();
    Authorizer.assertPermission(context, 'coa.manage');
    const existing = repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Account', id);

    const allowed = ['name', 'description', 'is_active', 'opening_balance', 'opening_balance_type'];
    const updates = {};
    for (const f of allowed) {
      if (data[f] !== undefined) updates[f] = data[f];
    }
    if (Object.keys(updates).length === 0) throw new ValidationError('No fields to update');

    repo.update(id, context.companyId, { ...updates, updated_at: new Date().toISOString() });
    this._audit(context, 'ACCOUNT_MODIFIED', 'ACCOUNT', id, existing, { ...existing, ...updates });
    return repo.findById(id, context.companyId);
  }

  remove(id, context) {
    const repo = this._repo();
    Authorizer.assertPermission(context, 'coa.manage');
    const existing = repo.findById(id, context.companyId);
    if (!existing) throw new NotFoundError('Account', id);

    // Prevent deletion if account has journal lines
    if (!repo.canDelete(id, context.companyId)) {
      throw new ValidationError('Cannot delete account: it has posted journal entries. Deactivate it instead.');
    }

    this.conn.run('DELETE FROM accounts WHERE id = ? AND company_id = ?', [id, context.companyId]);
    this._audit(context, 'ACCOUNT_DELETED', 'ACCOUNT', id, existing, null);
    return { success: true };
  }

  _repo() {
    const { ChartOfAccountsRepository } = require('../repositories/chart-of-accounts.repository');
    return new ChartOfAccountsRepository(this.conn);
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
}

module.exports = { ChartOfAccountsService };
