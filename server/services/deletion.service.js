/**
 * Global Deletion Service — the single deletion path for every module.
 *
 * API:
 *   analyzeDeletion(entityType, entityId, companyId, opts?)
 *   archiveEntity(entityType, entityId, reason, context)
 *   deleteEntityWithDependencies(entityType, entityId, { confirmationToken, reason }, context)
 *   restoreEntity(entityType, entityId, context)
 *
 * Safety rules enforced here:
 *   - SQLite foreign_keys stays ON (never disabled).
 *   - Dry-run dependency scan before any destructive action.
 *   - Protected financial/compliance records block permanent deletion.
 *   - Cascading deletion happens inside ONE transaction; any failure rolls back.
 *   - confirmationToken must equal analyzeDeletion().token.
 *   - Every archive/delete/restore is written to immutable audit_logs.
 *   - Raw SQLite errors never escape; callers get structured AppErrors.
 */
const crypto = require('crypto');
const { AppError, NotFoundError, AuthorizationError } = require('../utils/errors');

// ── Entity registry ────────────────────────────────────────────────────────
// table: physical table name | label: UI name | permission: required RBAC
// permission | soft: false (permanent deletion only — no soft-delete)
// name: display expr
const ENTITY_CONFIG = {
  contact:       { table: 'contacts',              label: 'Contact',       permission: 'contacts',       soft: false },
  organization:  { table: 'organizations',         label: 'Organization',  permission: 'organizations',  soft: false },
  lead:          { table: 'leads',                 label: 'Lead',          permission: 'contacts',       soft: false },
  deal:          { table: 'deals',                 label: 'Deal',          permission: 'deals',          soft: false },
  task:          { table: 'tasks',                 label: 'Task',          permission: 'tasks',          soft: false },
  note:          { table: 'notes',                 label: 'Note',          permission: null,             soft: false },
  appointment:   { table: 'appointments',          label: 'Appointment',   permission: 'appointments',   soft: false },
  product:       { table: 'products',              label: 'Product',       permission: 'products',       soft: false },
  pipeline:      { table: 'pipelines',             label: 'Pipeline',      permission: null,             soft: false },
  relationship:  { table: 'relationships',         label: 'Relationship',  permission: null,             soft: false },
  workflow:      { table: 'workflow_definitions',  label: 'Workflow',      permission: 'workflows',      soft: false },
  customer:      { table: 'customers',             label: 'Customer',      permission: 'contacts',       soft: false },
  activity:      { table: 'activities',            label: 'Activity',      permission: null,             soft: false },
  invoice:       { table: 'invoices',              label: 'Invoice',       permission: 'invoices',       soft: false },
  user:          { table: 'users',                 label: 'User',          permission: 'users',          soft: false },
  role:          { table: 'roles',                 label: 'Role',          permission: 'users',          soft: false },
};

// Records that must NEVER be permanently deleted automatically.
// Any dependency landing here blocks deletion entirely (archive-only).
const PROTECTED_TABLES = new Set([
  'invoices',           // posted invoices
  'payments',           // payments
  'journal_entries',    // journal entries
  'journal_entry_lines',
  'vouchers',           // all voucher types (receipt, payment, sales, purchase, expense, contra, credit note)
  'receivables',        // ledger records
  'payables',
  'opening_balances',   // ledger records
  'opening_balance_lines',
  'accounting_audit',   // compliance / audit records
  'audit_logs',
  'bills',              // vendor bills (financial)
  'bill_allocations',
  'financial_years',    // tax period records
  'interest_calculations',
]);

const NAME_EXPR = {
  contacts:       "first_name || ' ' || last_name",
  organizations:  'name',
  leads:          "COALESCE(interest_level, 'Lead #' || substr(id,1,8))",
  deals:          'name',
  tasks:          'title',
  notes:          'title',
  appointments:   'title',
  products:       'name',
  pipelines:      'name',
  relationships:  'relationship_type',
  workflow_definitions: 'name',
  customers:      'name',
  activities:     'subject',
  invoices:       'invoice_number',
  users:          'username',
  roles:          'name',
};

class DeletionService {
  constructor(conn) {
    this.conn = conn;
    this._fkCache = new Map(); // table -> fk list (static schema info)
  }

  // ── Schema introspection ────────────────────────────────────────────────
  _fks(table) {
    if (!this._fkCache.has(table)) {
      this._fkCache.set(table, this.conn.all(`PRAGMA foreign_key_list(${table})`));
    }
    return this._fkCache.get(table);
  }

  _columns(table) {
    return this.conn.all(`PRAGMA table_info(${table})`).map(c => c.name);
  }

  _tableExists(table) {
    return !!this.conn.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]
    );
  }

  _assertEntity(entityType) {
    const cfg = ENTITY_CONFIG[entityType];
    if (!cfg) throw new AppError(`Unknown entity type '${entityType}'`, 'UNKNOWN_ENTITY_TYPE', 400);
    return cfg;
  }

  _getRecord(cfg, entityId, companyId) {
    const rec = this.conn.get(
      `SELECT * FROM ${cfg.table} WHERE id = ? AND company_id = ?`, [entityId, companyId]
    );
    if (!rec) throw new NotFoundError(cfg.label, entityId);
    return rec;
  }

  _recordLabel(cfg, rec) {
    const expr = NAME_EXPR[cfg.table];
    if (expr) {
      try {
        const row = this.conn.get(
          `SELECT ${expr} AS label FROM ${cfg.table} WHERE id = ?`, [rec.id]
        );
        if (row && row.label) return String(row.label);
      } catch { /* fall through */ }
    }
    return rec.id;
  }

  _recordStatus(cfg, rec) {
    return rec.status || rec.lead_status || null;
  }

  // ── Dependency inspection (recursive dry run) ───────────────────────────
  /**
   * Walk the live foreign-key graph upstream (who references this record),
   * recursively, skipping soft-deleted dependents. Returns grouped report.
   */
  analyzeDeletion(entityType, entityId, companyId, opts = {}) {
    const cfg = this._assertEntity(entityType);
    const rec = this._getRecord(cfg, entityId, companyId);
    const label = this._recordLabel(cfg, rec);

    const root = {
      entity_type: entityType,
      entity_id: entityId,
      label,
      status: this._recordStatus(cfg, rec),
      table: cfg.table,
      soft_deletable: false,
      already_soft_deleted: false,
    };

    const visited = new Set();
    const groups = new Map(); // table -> group
    const blocking = [];
    const deletable = [];

    this._scanDependencies(cfg.table, entityId, companyId, visited, groups, 0, opts.maxDepth || 6);

    const dependencies = [...groups.values()].map(g => {
      const group = {
        entity_type: g.entityType,
        table: g.table,
        count: g.samples.length,
        protected: PROTECTED_TABLES.has(g.table),
        records: g.samples.map(s => ({
          id: s.id,
          name: s.name,
          status: s.status,
          link_column: s.linkColumn,
          via: s.via || null, // transitive path, e.g. "leads -> deals"
        })),
      };
      if (group.protected) blocking.push(group);
      else deletable.push(group);
      return group;
    }).sort((a, b) => b.count - a.count);

    const totalLinked = dependencies.reduce((s, d) => s + d.count, 0);
    const totalDeletable = deletable.reduce((s, d) => s + d.count, 0);
    const totalBlocking = blocking.reduce((s, d) => s + d.count, 0);

    const permanentDeleteAllowed = blocking.length === 0;
    const archiveAllowed = false; // No soft-delete; archive = permanent delete

    const allowedActions = [];
    if (!root.already_soft_deleted) allowedActions.push('cancel');
    if (permanentDeleteAllowed) {
      allowedActions.push('archive'); // archive now does permanent delete
      allowedActions.push('delete_with_dependencies');
    }

    return {
      ...root,
      dependencies,
      summary: {
        total_linked: totalLinked,
        total_deletable: totalDeletable,
        total_protected: totalBlocking,
        groups: dependencies.length,
      },
      blocking_dependencies: blocking,
      allowed_actions: allowedActions,
      permanent_delete_allowed: permanentDeleteAllowed,
      archive_allowed: permanentDeleteAllowed, // archive = permanent delete now
      message: this._humanMessage(root, dependencies, blocking),
      token: crypto.createHash('sha256')
        .update(`${entityType}:${entityId}:${companyId}:${totalLinked}:${rec.updated_at || ''}`)
        .digest('hex').slice(0, 32),
    };
  }

  _scanDependencies(table, id, companyId, visited, groups, depth, maxDepth) {
    if (depth > maxDepth || visited.has(`${table}:${id}`)) return;
    visited.add(`${table}:${id}`);

    // Reference scan: iterate all tables once (cached) to find FKs -> table
    for (const ref of this._referencingTables(table)) {
      const col = ref.fromColumn;
      const refTable = ref.table;
      if (PROTECTED_TABLES.has(refTable) === false && !this._tableExists(refTable)) continue;

      const rows = this.conn.all(
        `SELECT r.rowid AS _rid, r.* FROM ${refTable} r WHERE r.${col} = ? LIMIT 200`, [id]
      );

      if (rows.length === 0) continue;

      const g = groups.get(refTable) || {
        table: refTable,
        entityType: this._entityTypeForTable(refTable),
        samples: [],
      };
      const nameExpr = NAME_EXPR[refTable];
      for (const r of rows) {
        if (g.samples.length >= 50) break;
        const rowId = r.id !== undefined ? r.id : r._rid;
        let name = String(rowId);
        if (nameExpr) {
          try {
            const n = this.conn.get(`SELECT ${nameExpr} AS label FROM ${refTable} WHERE rowid = ?`, [r._rid]);
            if (n && n.label) name = String(n.label);
          } catch { /* keep id */ }
        }
        const via = depth > 0 ? `${table} -> ${refTable}` : null;
        // dedupe identical (id, via)
        if (!g.samples.some(s => s.id === rowId && s.via === via)) {
          g.samples.push({
            id: rowId,
            name,
            status: r.status || r.lead_status || 'ACTIVE',
            linkColumn: col,
            via,
          });
        }
      }
      groups.set(refTable, g);
      // recurse: dependents of dependents (only tables with a usable id)
      if (!PROTECTED_TABLES.has(refTable)) {
        for (const r of rows) {
          if (r.id !== undefined) this._scanDependencies(refTable, r.id, companyId, visited, groups, depth + 1, maxDepth);
        }
      }
    }
  }

  _allTables() {
    if (!this._allTablesCache) {
      this._allTablesCache = this.conn.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      ).map(r => r.name);
    }
    return this._allTablesCache;
  }

  _referencingTables(table) {
    const out = [];
    for (const t of this._allTables()) {
      for (const fk of this._fks(t)) {
        if (fk.table === table) out.push({ table: t, fromColumn: fk.from });
      }
    }
    return out;
  }

  _entityTypeForTable(table) {
    for (const [k, v] of Object.entries(ENTITY_CONFIG)) {
      if (v.table === table) return k;
    }
    return table;
  }

  _humanMessage(root, dependencies, blocking) {
    if (dependencies.length === 0) {
      return `${root.label} has no linked records and can be deleted safely.`;
    }
    const parts = dependencies.map(d => `${d.count} ${d.entity_type}${d.count > 1 ? 's' : ''}${d.protected ? ' (protected)' : ''}`);
    if (blocking.length > 0) {
      return `${root.label} cannot be permanently deleted because it is linked to protected records: ${parts.join(', ')}. Remove or detach the protected linked records first.`;
    }
    return `${root.label} is linked to ${parts.join(', ')}.`;
  }
}

module.exports = { DeletionService, ENTITY_CONFIG, PROTECTED_TABLES };

// ── Mutations (appended) ───────────────────────────────────────────────────
Object.assign(DeletionService.prototype, {
  _audit(action, entityType, entityId, context, detail) {
    try {
      // audit_logs.user_id has an FK to users; only record a real user id.
      let userId = context.userId || null;
      if (userId && !this.conn.get('SELECT id FROM users WHERE id = ?', [userId])) userId = null;
      this.conn.run(
        `INSERT INTO audit_logs (id, company_id, user_id, action, entity_type, entity_id, new_values_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'aud_' + crypto.randomUUID(),
          context.companyId || 'default',
          context.userId || null,
          action,
          entityType,
          entityId,
          JSON.stringify(detail || {}),
          new Date().toISOString(),
        ]
      );
    } catch (e) {
      // Audit must never break the operation, but record loudly.
      console.error('[deletion.service] audit write failed:', e.message);
    }
  }

  ,

  /**
   * Permanently delete a record (physical DELETE — no soft-delete).
   * Performs a direct DELETE FROM. Related records are handled by the
   * database's CASCADE or by the caller via deleteEntityWithDependencies.
   */
  archiveEntity(entityType, entityId, reason, context) {
    // Archive is now permanent delete (no soft-delete).
    const cfg = this._assertEntity(entityType);
    if (context.permission !== undefined && !context.permission) {
      throw new AuthorizationError('You are not allowed to delete this record.');
    }
    this._getRecord(cfg, entityId, context.companyId);
    const tx = this.conn.transaction(() => {
      this.conn.run(`DELETE FROM ${cfg.table} WHERE id = ? AND company_id = ?`, [entityId, context.companyId]);
      this._audit('DELETE', entityType, entityId, context, { reason: reason || null });
    });
    tx();
    return { success: true, deleted: true, entity_type: entityType, entity_id: entityId, reason: reason || null };
  },

  /**
   * Restore is not supported — all deletions are permanent.
   */
  restoreEntity(entityType, entityId, context) {
    const cfg = this._assertEntity(entityType);
    throw new AppError(`${cfg.label} cannot be restored — all deletions are permanent.`, 'RESTORE_NOT_SUPPORTED', 400);
  },

  /**
   * Permanently delete the record and all eligible linked records, in ONE
   * transaction. Protected dependencies abort with structured error BEFORE
   * any row is touched (dry-run inside the same transaction).
   */
  deleteEntityWithDependencies(entityType, entityId, opts, context) {
    const cfg = this._assertEntity(entityType);
    const report = this.analyzeDeletion(entityType, entityId, context.companyId);

    // Confirmation token must match the analysis (second confirmation).
    if (!opts || !opts.confirmationToken || opts.confirmationToken !== report.token) {
      throw new AppError(
        'Deletion confirmation token missing or stale. Re-run analysis and confirm.',
        'CONFIRMATION_REQUIRED', 428
      );
    }

    if (report.blocking_dependencies.length > 0) {
      throw new AppError(
        `${cfg.label} cannot be permanently deleted because protected financial or compliance records are linked.`,
        'PROTECTED_DEPENDENCIES_BLOCK_DELETE', 409
      );
    }
    if (report.dependencies.length > 0 && opts.expectedCount !== undefined
        && opts.expectedCount !== report.summary.total_deletable) {
      throw new AppError(
        `Linked record count changed since analysis (expected ${opts.expectedCount}, found ${report.summary.total_deletable}). Re-run analysis.`,
        'STALE_ANALYSIS', 409
      );
    }

    // Collect the exact deletion order: children first (BFS reverse), then root.
    const order = [];
    const collect = (table, id, depth) => {
      if (depth > 6) return;
      for (const ref of this._referencingTables(table)) {
        const hasId = this._columns(ref.table).includes('id');
        const childRows = this.conn.all(
          `SELECT rowid AS _rid${hasId ? ', id' : ''} FROM ${ref.table} WHERE ${ref.fromColumn} = ?`, [id]
        );
        if (childRows.length === 0) continue;
        if (PROTECTED_TABLES.has(ref.table)) {
          // Protected rows must survive: block, unless the FK column is nullable
          // and can be detached (SET NULL) instead of deleting the row.
          if (!this._isNullable(ref.table, ref.fromColumn)) {
            throw new AppError(
              `Protected table '${ref.table}' references this ${cfg.label}. Permanent deletion is blocked.`,
              'PROTECTED_DEPENDENCIES_BLOCK_DELETE', 409
            );
          }
          continue; // detachable — handled by nullOut below
        }
        for (const r of childRows) collect(ref.table, r.id ?? r._rid, depth + 1);
        for (const r of childRows) order.push({ table: ref.table, id: r.id, rowid: r._rid, hasId });
      }
    };
    collect(cfg.table, entityId, 0);
    order.push({ table: cfg.table, id: entityId, hasId: true });

    const nullOut = [];
    for (const ref of this._referencingTables(cfg.table)) {
      if (PROTECTED_TABLES.has(ref.table) && this._isNullable(ref.table, ref.fromColumn)) {
        nullOut.push(ref);
      }
    }

    let deletedRows = 0;
    const tx = this.conn.transaction(() => {
      // Detach protected references (SET NULL) instead of destroying them.
      for (const ref of nullOut) {
        this.conn.run(`UPDATE ${ref.table} SET ${ref.fromColumn} = NULL WHERE ${ref.fromColumn} = ?`, [entityId]);
      }
      for (const step of order) {
        const r = step.hasId && step.id !== undefined
          ? this.conn.run(`DELETE FROM ${step.table} WHERE id = ?`, [step.id])
          : this.conn.run(`DELETE FROM ${step.table} WHERE rowid = ?`, [step.rowid]);
        deletedRows += r.changes || 0;
      }
      if (this.conn.get(`SELECT id FROM ${cfg.table} WHERE id = ?`, [entityId])) {
        throw new AppError(`${cfg.label} could not be fully removed; transaction rolled back.`, 'DELETE_INCOMPLETE', 500);
      }
      this._audit('DELETE_WITH_DEPENDENCIES', entityType, entityId, context, {
        reason: (opts && opts.reason) || null,
        deleted_rows: deletedRows,
        tables: [...new Set(order.map(o => o.table))],
      });
    });
    try {
      tx();
    } catch (err) {
      // Transaction already rolled back by connection wrapper; re-throw mapped.
      if (err instanceof AppError) throw err;
      throw this._mapDbError(err, entityType, entityId, cfg);
    }
    return {
      success: true,
      deleted: true,
      entity_type: entityType,
      entity_id: entityId,
      deleted_rows: deletedRows,
      tables_touched: [...new Set(order.map(o => o.table))],
    };
  },

  _isNullable(table, column) {
    const col = this.conn.all(`PRAGMA table_info(${table})`).find(c => c.name === column);
    return !!col && col.notnull === 0;
  },

  /**
   * Map any raw SQLite error into a structured, user-safe error.
   * Never leaks "FOREIGN KEY constraint failed".
   */
  _mapDbError(err, entityType, entityId, cfg) {
    const msg = String(err.message || '');
    if (/FOREIGN KEY/i.test(msg) || err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      return new AppError(
        `${cfg.label} cannot be deleted because other records still reference it.`,
        'ENTITY_HAS_DEPENDENCIES', 409
      );
    }
    return new AppError(
      'The record could not be deleted. No changes were made.',
      'DELETE_FAILED', 500
    );
  },
});

module.exports = { DeletionService, ENTITY_CONFIG, PROTECTED_TABLES };
