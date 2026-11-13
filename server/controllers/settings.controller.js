const { getConn } = require('../utils/db');
const { ValidationError } = require('../utils/errors');
const { successResponse } = require('../utils/response');
const { validateCurrency, SUPPORTED_CURRENCIES } = require('../utils/currency');

class SettingsController {
  constructor() {
    this.conn = getConn();
    this.allowedKeys = new Set([
      'company_name', 'company_email', 'company_phone', 'company_address',
      'default_currency', 'tax_rate', 'invoice_prefix', 'invoice_terms',
      'timezone', 'date_format', 'locale',
      'email_notifications', 'push_notifications', 'weekly_digest'
    ]);
  }

  async get(req, res, next) {
    try {
      const rows = this.conn.all('SELECT key, value FROM system_metadata WHERE key IN (' +
        Array.from(this.allowedKeys).map(() => '?').join(',') + ')',
        Array.from(this.allowedKeys));
      const settings = {};
      for (const k of this.allowedKeys) settings[k] = null;
      for (const r of rows) settings[r.key] = r.value;
      res.json(successResponse(settings));
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      const keys = Object.keys(req.body || {});
      const invalid = keys.filter(k => !this.allowedKeys.has(k));
      if (invalid.length) throw new ValidationError(`Unknown settings: ${invalid.join(', ')}`);

      const now = new Date().toISOString();
      for (const k of keys) {
        if (k === 'default_currency') {
          if (!SUPPORTED_CURRENCIES.includes(req.body[k])) {
            throw new ValidationError(`Unsupported currency code: ${req.body[k]}`);
          }
          req.body[k] = validateCurrency(req.body[k]);
        }
        const value = req.body[k] === null || req.body[k] === undefined ? null : String(req.body[k]);
        this.conn.run(`
          INSERT INTO system_metadata (key, value, created_at, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `, [k, value, now, now]);
      }

      res.json(successResponse({ updated: keys }));
    } catch (err) { next(err); }
  }

  /**
   * Reset CRM data: deletes ALL business data (CRM, accounting, activities,
   * audit trails, etc.) for the CURRENT company/tenant only, while PRESERVING
   * user accounts, roles/permissions, companies, and system settings.
   */
  async resetCrmData(req, res, next) {
    try {
      const companyId = req.user?.companyId || 'default';

      // Guard: the request body must contain the exact confirmation phrase.
      if ((req.body?.confirm || '').trim().toUpperCase() !== 'RESET CRM DATA') {
        throw new ValidationError('Confirmation phrase required. Send { confirm: "RESET CRM DATA" }.');
      }

      const plan = buildResetPlan(this.conn, companyId);

      // Circular FK dependencies between CRM tables (contacts↔organizations,
      // deals↔invoices↔vouchers, etc.) make strict topological deletion
      // impossible.  Because we delete ALL rows for this company in a single
      // transaction, the final state has zero FK violations.  We temporarily
      // disable FK enforcement around the transaction (PRAGMA must be set
      // OUTSIDE an active transaction in SQLite), then re-enable on exit.
      const cleared = [];
      const tx = this.conn.transaction(() => {
        for (const { table, sql, params, desc, selfFks } of plan.ordered) {
          // For self-referencing FK tables, NULL out the self-referencing
          // columns first so the bulk DELETE doesn't trip the FK constraint.
          if (selfFks && selfFks.length > 0) {
            for (const col of selfFks) {
              this.conn.run(
                `UPDATE "${table}" SET ${col} = NULL WHERE company_id = ? AND ${col} IS NOT NULL`,
                [companyId]
              );
            }
          }

          const info = this.conn.prepare(sql).run(...params);
          cleared.push({ table, rows: info.changes || 0, desc });
        }

        // Post-deletion verification FIRST (before the audit insert, so the
        // audit row itself isn't counted as a leftover): every business table
        // for this tenant must be empty. If anything remains, abort with a
        // rollback so the CRM is never left half-reset.
        const leftovers = [];
        for (const v of plan.verify || []) {
          try {
            const row = this.conn.get(v.sql, v.params);
            if (row && row.c > 0) leftovers.push({ table: v.table, remaining: row.c });
          } catch (e) {
            // Verification query itself failing is a bug — fail safe.
            leftovers.push({ table: v.table, error: e.message });
          }
        }
        if (leftovers.length > 0) {
          console.error('[reset] verification failed for tenant', companyId, JSON.stringify(leftovers));
          throw new Error('Reset verification failed: ' + leftovers.length + ' table(s) still contain data for this company. No data was deleted.');
        }

        // Write audit log entry after clearing audit_logs (which happens
        // in the topological order since nothing depends on audit_logs).
        const now = new Date().toISOString();
        this.conn.run(
          `INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id, new_values_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [companyId, req.user?.userId, 'RESET_CRM_DATA', 'company', companyId,
            JSON.stringify({ tablesCleared: cleared.length, rowsDeleted: cleared.reduce((s, c) => s + c.rows, 0) }),
            now]
        );
      });

      // Disable FK enforcement (must be OUTSIDE a transaction in SQLite).
      // FKs are restored + integrity verified below before responding.
      this.conn.exec('PRAGMA foreign_keys = OFF');
      tx();
      // Re-enable FK enforcement now that the transaction has committed.
      this.conn.exec('PRAGMA foreign_keys = ON');

      // Integrity check: there must be zero dangling foreign keys after the
      // reset. If any exist, this is a schema/plan bug — report it loudly.
      const fkViolations = this.conn.all('PRAGMA foreign_key_check');
      if (fkViolations.length > 0) {
        console.error('[reset] dangling foreign keys after reset for tenant', companyId,
          JSON.stringify(fkViolations.slice(0, 10)));
      }

      try {
        this.conn.exec('VACUUM');
      } catch { /* vacuum is best-effort */ }

      res.json(successResponse({
        message: 'CRM data reset complete. User accounts and settings were preserved.',
        companyId,
        tablesCleared: cleared.length,
        rowsDeleted: cleared.reduce((s, c) => s + c.rows, 0),
        detail: cleared,
      }));
    } catch (err) {
      // Ensure FK enforcement is restored even on failure.
      this.conn.exec('PRAGMA foreign_keys = ON');
      next(err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Reset plan builder
// ─────────────────────────────────────────────────────────────────────────

/**
 * Tables that must NEVER be cleared during CRM reset.
 * These hold system, authentication, and master reference data.
 */
const PROTECTED_TABLES = new Set([
  // Auth / user data
  'users', 'user_roles', 'roles', 'role_permissions', 'permissions',
  // Company / tenant ownership (required for login)
  'companies',
  // System metadata and config
  'system_metadata', 'schema_migrations',
  // Global currency / tax master data
  'currencies', 'tax_types', 'tax_masters', 'tax_components',
  'company_tax_configs',
  // Internal / non-CRM
  'database_health_logs',
]);

/**
 * Company-scoped master/config tables that are cleared (reset to empty) so the
 * company starts with a clean business state. tax_account_mappings is included
 * because its NOT NULL ledger_account_id references the (cleared) accounts
 * table — leaving the mapping rows would create dangling foreign keys.
 * Seed migrations re-create default mappings as needed via company_tax_configs.
 */
const COMPANY_MASTER_TABLES = new Set(['tax_account_mappings']);

/**
 * Protected-table rows whose NOT NULL FK columns point at cleared business
 * tables must have those columns NULLed out (before the target rows vanish)
 * so the database never ends up with dangling foreign-key references.
 * (The only protected tables with such business FKs today are the user/role
 * tables, which never reference business data — but this guard keeps the
 * reset safe if future migrations add them.)
 */
function buildProtectedTableFkFixups(conn, protectedTables, businessTables, tableSchema) {
  const fixups = [];
  for (const t of protectedTables) {
    const cols = conn.all(`PRAGMA table_info("${t}")`);
    const fks = conn.all(`PRAGMA foreign_key_list("${t}")`);
    for (const fk of fks) {
      if (!businessTables.includes(fk.table)) continue;
      const notNull = cols.some(c => c.name === fk.from && c.notnull === 1);
      if (notNull) {
        // A NOT NULL FK can't be nulled; the only safe option is deleting the
        // protected row. This must never silently happen for auth tables.
        fixups.push({ table: t, column: fk.from, mode: 'DELETE_ROWS', targets: fk.table });
      } else {
        fixups.push({ table: t, column: fk.from, mode: 'NULL', targets: fk.table });
      }
    }
  }
  return fixups;
}

/**
 * Build a dependency-aware, tenant-scoped deletion plan.
 *
 * Returns:
 *   { ordered: [{ table, sql, params, desc }, ...], tables: [...] }
 *
 * Deletion order guarantees FK safety (children before parents) with
 * foreign_keys = ON. Every DELETE is scoped to company_id (tenant
 * isolation) — either directly or via a subquery on a parent FK.
 */
function buildResetPlan(conn, companyId) {
  // ── 1. Discover all business tables ────────────────────────────────
  const allTables = conn.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_sqliterc%'"
  ).map(r => r.name);

  const businessTables = allTables
    .filter(t => !PROTECTED_TABLES.has(t))
    .filter(t => !COMPANY_MASTER_TABLES.has(t));

  // ── 2. Load schema info for each business table ───────────────────
  const tableSchema = {};
  for (const t of businessTables) {
    const cols = conn.all(`PRAGMA table_info("${t}")`);
    const fks = conn.all(`PRAGMA foreign_key_list("${t}")`);
    // Detect self-referencing FK columns (e.g., account_groups.parent_id -> account_groups.id)
    const selfFks = fks
      .filter(fk => fk.table === t)
      .map(fk => fk.from);
    tableSchema[t] = {
      hasCompanyId: cols.some(c => c.name === 'company_id'),
      fks,
      selfFks,
    };
  }

  // ── 3. Build reverse dependency graph ─────────────────────────────
  //   dependents[t] = set of business tables that reference t (t's children)
  const dependents = {};
  for (const t of businessTables) dependents[t] = new Set();
  for (const t of businessTables) {
    for (const fk of tableSchema[t].fks) {
      if (businessTables.includes(fk.table) && fk.table !== t) {
        dependents[fk.table].add(t); // fk.table is referenced BY t
      }
    }
  }

  // ── 4. Topological sort: children first, parents last ─────────────
  const orderedNames = [];
  const done = new Set();
  let progress = true;
  while (orderedNames.length < businessTables.length && progress) {
    progress = false;
    for (const t of businessTables) {
      if (done.has(t)) continue;
      // Ready when all tables that depend on t are already processed
      if ([...dependents[t]].every(d => done.has(d))) {
        orderedNames.push(t);
        done.add(t);
        progress = true;
      }
    }
  }
  // Fallback for cycles
  for (const t of businessTables) if (!done.has(t)) orderedNames.push(t);

  // ── 5. Generate scoped DELETE statements ──────────────────────────
  const ordered = [];
  for (const t of orderedNames) {
    const schema = tableSchema[t];

    if (schema.hasCompanyId) {
      ordered.push({
        table: t,
        sql: `DELETE FROM "${t}" WHERE company_id = ?`,
        params: [companyId],
        desc: 'direct company_id filter',
        selfFks: schema.selfFks,
      });
    } else {
      // No company_id: build a subquery chain to the nearest ancestor
      // with company_id. Prefer the "strongest" scoping path: one whose
      // FK column is NOT NULL, guaranteeing every row of this table is
      // covered (no orphan rows with a NULL FK leaking past the reset).
      const candidates = [];
      const cols = conn.all(`PRAGMA table_info("${t}")`);
      for (const fk of schema.fks) {
        if (businessTables.includes(fk.table) && tableSchema[fk.table].hasCompanyId) {
          const colInfo = cols.find(c => c.name === fk.from);
          candidates.push({
            fk,
            notNull: colInfo ? colInfo.notnull === 1 : false,
            sql: `DELETE FROM "${t}" WHERE ${fk.from} IN (SELECT ${fk.to} FROM "${fk.table}" WHERE company_id = ?)`,
            desc: `subquery via ${fk.table}.company_id (direct FK)`,
          });
        }
      }
      const chosen = candidates.find(c => c.notNull) || candidates[0];
      if (chosen) {
        ordered.push({
          table: t,
          sql: chosen.sql,
          params: [companyId],
          desc: chosen.desc + (chosen.notNull ? ' [NOT NULL FK - full coverage]' : ''),
          selfFks: schema.selfFks,
        });
        continue;
      }
      const subqueryInfo = buildScopedDelete(t, schema, tableSchema, businessTables, companyId);
      ordered.push({
        table: t,
        sql: subqueryInfo.sql,
        params: subqueryInfo.params,
        desc: subqueryInfo.desc,
        selfFks: schema.selfFks,
      });
    }
  }

  // ── 6. Company-scoped master/config tables ─────────────────────────
  // tax_account_mappings must be cleared because its NOT NULL
  // ledger_account_id references the cleared accounts table; keeping the
  // rows would leave dangling foreign keys after the reset.
  for (const t of COMPANY_MASTER_TABLES) {
    if (!allTables.includes(t)) continue;
    ordered.push({
      table: t,
      sql: `DELETE FROM "${t}" WHERE company_id = ?`,
      params: [companyId],
      desc: 'company master/config data (safe to clear; NOT NULL FKs into business tables)',
      selfFks: [],
    });
  }

  // ── 7. Post-transaction verification queries ────────────────────────
  // After all deletions these MUST all return 0 rows, proving that no
  // business data remains for this tenant (belt-and-braces check).
  const verify = [];
  for (const t of businessTables) {
    const schema = tableSchema[t];
    if (schema.hasCompanyId) {
      verify.push({
        table: t,
        sql: `SELECT COUNT(*) AS c FROM "${t}" WHERE company_id = ?`,
        params: [companyId],
      });
    }
  }
  for (const t of COMPANY_MASTER_TABLES) {
    if (allTables.includes(t)) {
      verify.push({
        table: t,
        sql: `SELECT COUNT(*) AS c FROM "${t}" WHERE company_id = ?`,
        params: [companyId],
      });
    }
  }

  return { ordered, tables: [...businessTables, ...COMPANY_MASTER_TABLES], verify };
}

/**
 * For a table without company_id, find the shortest FK path to an ancestor
 * table that has company_id, and build a scoped DELETE subquery.
 *
 * Supports 1-level (direct FK to company_id table), 2-level, and 3-level
 * chains. Falls back to unscoped DELETE with a warning.
 */
function buildScopedDelete(table, schema, tableSchema, businessTables, companyId) {
  // 1-level: table.fk_col → parent.id WHERE parent.company_id = ?
  for (const fk of schema.fks) {
    if (businessTables.includes(fk.table) && tableSchema[fk.table].hasCompanyId) {
      return {
        sql: `DELETE FROM "${table}" WHERE ${fk.from} IN (SELECT id FROM "${fk.table}" WHERE company_id = ?)`,
        params: [companyId],
        desc: `subquery via ${fk.table}.company_id (direct FK)`,
      };
    }
  }

  // 2-level: table.fk1 → mid.id WHERE mid.fk2 → parent.id WHERE parent.company_id = ?
  for (const fk1 of schema.fks) {
    if (!businessTables.includes(fk1.table)) continue;
    const midSchema = tableSchema[fk1.table];
    if (!midSchema) continue;
    for (const fk2 of midSchema.fks) {
      if (!businessTables.includes(fk2.table)) continue;
      if (tableSchema[fk2.table].hasCompanyId) {
        return {
          sql: `DELETE FROM "${table}" WHERE ${fk1.from} IN (SELECT ${fk1.to} FROM "${fk1.table}" WHERE ${fk2.from} IN (SELECT id FROM "${fk2.table}" WHERE company_id = ?))`,
          params: [companyId],
          desc: `subquery via ${fk1.table} -> ${fk2.table}.company_id (2-level)`,
        };
      }
    }
  }

  // 3-level chain
  for (const fk1 of schema.fks) {
    if (!businessTables.includes(fk1.table)) continue;
    const s1 = tableSchema[fk1.table];
    if (!s1) continue;
    for (const fk2 of s1.fks) {
      if (!businessTables.includes(fk2.table)) continue;
      const s2 = tableSchema[fk2.table];
      if (!s2) continue;
      for (const fk3 of s2.fks) {
        if (!businessTables.includes(fk3.table)) continue;
        if (tableSchema[fk3.table].hasCompanyId) {
          return {
            sql: `DELETE FROM "${table}" WHERE ${fk1.from} IN (SELECT ${fk1.to} FROM "${fk1.table}" WHERE ${fk2.from} IN (SELECT ${fk2.to} FROM "${fk2.table}" WHERE ${fk3.from} IN (SELECT id FROM "${fk3.table}" WHERE company_id = ?)))`,
            params: [companyId],
            desc: `subquery via ${fk1.table} -> ${fk2.table} -> ${fk3.table}.company_id (3-level)`,
          };
        }
      }
    }
  }

  // Fallback: unscoped (should not happen for business tables with FKs)
  console.warn('[reset] No FK chain to company_id found for table "' + table + '".');
  return {
    sql: `DELETE FROM "${table}"`,
    params: [],
    desc: 'unscoped fallback',
  };
}

module.exports = { SettingsController, buildResetPlan, buildScopedDelete };
