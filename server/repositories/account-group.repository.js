const { AccountingBaseRepository } = require('./accounting-base.repository');
const { ValidationError } = require('../utils/errors');
const { generateId } = require('../utils/generateId');

/**
 * Repository for Account Group (parent / grouping) records.
 *
 * Account Groups are organizational nodes — is_group = true in the `accounts`
 * table model.  They cannot receive direct journal postings and can contain
 * child groups or ledger accounts.
 */
class AccountGroupRepository extends AccountingBaseRepository {
  constructor(conn) {
    super(conn, 'account_groups');
  }

  /**
   * Search / list account groups with filtering and pagination.
   */
   search(options = {}) {
     const company = this._company(options.companyId);
     const limit = options.limit || 500;
     const offset = options.offset || 0;
     const types = [];
     const values = [company, limit, offset];
     const wheres = ['company_id = ?'];

     if (options.type) { wheres.push('type = ?'); types.push(options.type.toUpperCase()); }
     if (options.isActive !== undefined) { wheres.push('is_active = ?'); types.push(options.isActive ? 1 : 0); }
     if (options.parentId !== undefined) {
       wheres.push('parent_id ' + (options.parentId ? '= ?' : 'IS NULL'));
       if (options.parentId) types.push(options.parentId);
     }
     if (options.query) { wheres.push('(code LIKE ? OR name LIKE ?)'); types.push(`%${options.query}%`, `%${options.query}%`); }

     const whereClause = wheres.join(' AND ');
     const sql = `SELECT * FROM ${this.tableName} WHERE ${whereClause} ORDER BY type, code ASC LIMIT ? OFFSET ?`;
     const items = this.conn.all(sql, [...types, ...values.slice(1)]);
     const totalRow = this.conn.get(`SELECT COUNT(*) as total FROM ${this.tableName} WHERE ${whereClause}`, [...types, company]);

     return {
       items: items.map(g => ({ ...g, is_group: 1, allow_direct_posting: 0, allow_child_accounts: g.allow_child_accounts !== 0 })),
       total: totalRow?.total || 0
     };
   }

   findById(id, companyId) {
     const sql = `SELECT * FROM ${this.tableName} WHERE id = ? AND company_id = ? LIMIT 1`;
     const group = this.conn.get(sql, [id, this._company(companyId)]);
     if (!group) return null;
     return { ...group, is_group: 1, allow_direct_posting: 0, allow_child_accounts: group.allow_child_accounts !== 0 };
   }

   searchOne(query = {}) {
     const company = this._company(query.company_id || query.companyId);
     const conditions = [];
     const values = [];
     for (const [k, v] of Object.entries(query)) {
       if (k === 'company_id' || k === 'companyId') continue;
       conditions.push(`${k} = ?`);
       values.push(v);
     }
     conditions.push('company_id = ?');
     values.push(company);
     const sql = `SELECT * FROM ${this.tableName} WHERE ${conditions.join(' AND ')} LIMIT 1`;
     const group = this.conn.get(sql, values);
     if (!group) return null;
     return { ...group, is_group: 1, allow_direct_posting: 0, allow_child_accounts: group.allow_child_accounts !== 0 };
   }

   create(data) {
     const id = data.id || generateId('ag');
     const now = new Date().toISOString();
     const fields = ['code', 'name', 'type', 'debit_credit_nature', 'parent_id', 'description', 'is_active', 'allow_child_accounts'];
     const cols = fields.filter(f => data[f] !== undefined);
     const placeholders = cols.map(() => '?').join(', ');
     const allValues = cols.map(f => data[f] !== undefined ? data[f] : null);
     const sql = `INSERT INTO ${this.tableName} (id, ${cols.join(', ')}, created_at, updated_at) VALUES (?, ${placeholders}, ?, ?)`;
     this.conn.run(sql, [id, ...allValues, now, now]);
     return this.findById(id, data.company_id || data.companyId);
   }

   /**
    * Build the complete Chart-of-Accounts tree: account_groups
    * (with nested children + sub-accounts) merged with leaf accounts.
   *
   * Each node has a `kind` property of 'group' or 'ledger' so the
   * frontend can render GROUP / LEDGER badges.
   *
   * @param {string} companyId
   * @returns {Array} root-level nodes (groups and ledger accounts with parent_id = NULL)
   */
  getFullTree(companyId) {
    const company = this._company(companyId);

    // All groups
    const groups = this.conn.all(
      `SELECT * FROM account_groups WHERE company_id = ? ORDER BY type, code ASC`,
      [company]
    ).map(g => ({ ...g, kind: 'group', children: [], is_group: 1, allow_direct_posting: 0, code: g.code, name: g.name, type: g.type, is_active: g.is_active !== 0 }));

    // All leaf accounts (is_group = 0)
    const accounts = this.conn.all(
      `SELECT * FROM accounts WHERE company_id = ? AND (is_group = 0 OR is_group IS NULL OR is_group = '') ORDER BY code ASC`,
      [company]
    ).map(a => ({ ...a, kind: 'ledger', children: [], is_group: 0, code: a.code, name: a.name, is_active: a.is_active !== 0 }));

    const all = [...groups, ...accounts];
    const map = new Map();
    all.forEach(node => { map.set(node.id, node); });

    const roots = [];
    all.forEach(node => {
      // Ledger accounts are linked to groups via account_group_id;
      // groups are linked to parents via parent_id.
      const parentId = node.kind === 'ledger' ? (node.account_group_id || node.parent_id) : node.parent_id;
      const parent = parentId && map.has(parentId) ? map.get(parentId) : null;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    });

    this._sortRecursive(roots);
    return roots;
  }

  _sortRecursive(nodes) {
    if (!nodes) return;
    nodes.sort((a, b) => {
      const codeA = a.code || '';
      const codeB = b.code || '';
      return codeA.localeCompare(codeB);
    });
    nodes.forEach(n => this._sortRecursive(n.children));
  }

  /**
   * Build a nested tree of account_groups only (for parent dropdown, validation).
   */
  getGroupTree(companyId, parent = null) {
    const company = this._company(companyId);
    const all = this.conn.all(
      `SELECT * FROM account_groups WHERE company_id = ? ORDER BY type, code ASC`,
      [company]
    );
    const map = new Map();
    all.forEach(g => { map.set(g.id, { ...g, children: [] }); });
    const roots = [];
    all.forEach(g => {
      const node = map.get(g.id);
      if (g.parent_id && map.has(g.parent_id)) {
        map.get(g.parent_id).children.push(node);
      } else {
        roots.push(node);
      }
    });
    this._sortRecursive(roots);
    return roots;
  }

  /**
   * Get all descendant group IDs recursively (for circular-detection).
   */
  getDescendantGroupIds(companyId, groupId) {
    const company = this._company(companyId);
    return this.conn.all(
      `WITH RECURSIVE descendants(id) AS (
        SELECT id FROM account_groups WHERE id = ? AND company_id = ?
        UNION ALL
        SELECT ag.id FROM account_groups ag
        JOIN descendants d ON ag.parent_id = d.id
        WHERE ag.company_id = ?
      )
      SELECT id FROM account_groups WHERE id IN (SELECT id FROM descendants) AND company_id = ?`,
      [groupId, company, company, company]
    ).map(r => r.id);
  }

  /**
   * Check whether changing parent_id to the given value would create a cycle.
   * Returns true if circular (i.e. parentId is a descendant of accountId).
   */
  checkCircular(accountId, parentId, companyId) {
    if (!parentId || parentId === accountId) return true;
    const descendants = this.getDescendantGroupIds(companyId, accountId);
    return descendants.includes(parentId);
  }

  /**
   * Get the parent group for a given group.
   */
  getParent(groupId, companyId) {
    const company = this._company(companyId);
    return this.conn.get(
      `SELECT * FROM account_groups WHERE id = ? AND company_id = ?`,
      [groupId, company]
    );
  }

  /**
   * Count direct child groups of a group.
   */
  getChildGroupCount(groupId, companyId) {
    const company = this._company(companyId);
    const row = this.conn.get(
      `SELECT COUNT(*) as c FROM account_groups WHERE parent_id = ? AND company_id = ?`,
      [groupId, company]
    );
    return row?.c || 0;
  }

  /**
   * Count leaf accounts that belong to this group (via account_group_id)
   * or are direct children (via parent_id).
   */
  getChildAccountCount(groupId, companyId) {
    const company = this._company(companyId);
    const row = this.conn.get(
      `SELECT COUNT(*) as c FROM accounts WHERE (account_group_id = ? OR parent_id = ?) AND company_id = ?`,
      [groupId, groupId, company]
    );
    return row?.c || 0;
  }

  /**
   * Count total descendant groups recursively.
   */
  getTotalDescendantGroupCount(groupId, companyId) {
    const ids = this.getDescendantGroupIds(companyId, groupId);
    if (ids.length <= 1) return 0;
    return ids.length - 1; // exclude self
  }

  /**
   * Validate type compatibility between parent group and the new group type.
   * In standard accounting, a child group must have the same type as (or a
   * subtype of) its parent.  We enforce that the debit/credit nature matches.
   */
  validateTypeInheritance(parentId, type, debitCreditNature, companyId) {
    if (!parentId) return true; // top-level group, no parent — always OK
    const company = this._company(companyId);
    const parent = this.conn.get(
      `SELECT type, debit_credit_nature FROM account_groups WHERE id = ? AND company_id = ?`,
      [parentId, company]
    );
    if (!parent) return false;
    // Type must match OR be compatible (e.g. ASSET parent → ASSET child)
    return parent.type === type && parent.debit_credit_nature === debitCreditNature;
  }

  /**
   * Suggest the account type and debit_credit_nature based on parent.
   */
  suggestFromParent(parentId, companyId) {
    if (!parentId) return null;
    const company = this._company(companyId);
    const parent = this.conn.get(
      `SELECT type, debit_credit_nature FROM account_groups WHERE id = ? AND company_id = ?`,
      [parentId, company]
    );
    return parent || null;
  }

  /**
   * Check if any descendant groups have transactions (via their child accounts).
   * Used for soft validation messages.
   */
  hasTransactionsThroughChildren(groupId, companyId) {
    const company = this._company(companyId);
    const descendantIds = this.getDescendantGroupIds(companyId, groupId);
    if (descendantIds.length === 0) return false;
    const placeholders = descendantIds.map(() => '?').join(',');
    const row = this.conn.get(
      `SELECT COUNT(*) as c FROM journal_entry_lines jel
       JOIN journal_entries je ON jel.journal_entry_id = je.id
       WHERE je.company_id = ? AND jel.account_id IN (
         SELECT id FROM accounts WHERE (account_group_id IN (${placeholders}) OR parent_id IN (${placeholders})) AND company_id = ?
       )`,
      [company, ...descendantIds, ...descendantIds, company]
    );
    return (row?.c || 0) > 0;
  }
}

module.exports = { AccountGroupRepository };
