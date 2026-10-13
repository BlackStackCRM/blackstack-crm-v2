const { DatabaseConnection } = require('../database/connection');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');

/**
 * Inventory Management Repository Layer
 *
 * Follows the existing BlackStack repository pattern (BaseRepository-style)
 * but with table-specific overrides. All queries are company_id (tenant) scoped.
 *
 * Convention:
 *  - companyId is always passed explicitly from the controller (req.user.companyId)
 *  - Timestamps are UTC (datetime('now'))
 *  - Primary keys are TEXT (ULID via generateId)
 *  - Permanent deletion: all DELETE operations are physical DELETE (no soft-delete)
 *  - Records are never hidden via is_active = 0; deletion always removes the row
 */
class InventoryRepository {
  constructor(conn) {
    this.conn = conn;
  }

  // ─── Generic master CRUD ───────────────────────────────────────────

  /**
   * Generic list with pagination + filters for any master table.
   * Master tables: brands, sizes, colours, styles, stock_categories,
   *   stock_groups, price_levels, adjustment_reasons,
   *   uom_dimensions, units_of_measure, compound_units, alternate_units,
   *   godowns, locations, models
   */
  list(table, companyId, options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const orderBy = /^[a-zA-Z0-9_]+$/.test(options.orderBy || '') ? options.orderBy : 'created_at';
    const orderDir = options.orderDir === 'ASC' ? 'ASC' : 'DESC';

    let where = ['company_id = ?'];
    const params = [companyId];

    // All records are listed (permanent deletion — no is_active filtering)
    // Soft masters (brands, colours, sizes, styles, etc.): name search.
    //
    // `adjustment_reasons` is the canonical reason master and the target of
    // inventory_voucher_lines.reason_id. It was missing here while the retired
    // duplicate `stock_adjustment_reasons` was listed, so name search silently
    // did nothing on the table that actually holds the data.
    const softMasters = ['brands', 'sizes', 'colours', 'styles', 'stock_categories',
      'stock_groups', 'price_levels', 'adjustment_reasons',
      'uom_dimensions', 'units_of_measure', 'compound_units', 'alternate_units',
      'locations', 'godowns'];
    if (softMasters.includes(table) && options.query) {
      where.push('(name LIKE ?)');
      params.push(`%${options.query}%`);
    }

    // godowns: name/code search
    if (table === 'godowns' && options.query) {
      where.push('(name LIKE ? OR code LIKE ?)');
      params.push(`%${options.query}%`, `%${options.query}%`);
    }

    // locations: name/code search + godown filter
    if (table === 'locations') {
      if (options.query) {
        where.push('(name LIKE ? OR code LIKE ?)');
        params.push(`%${options.query}%`, `%${options.query}%`);
      }
      if (options.godown_id) {
        where.push('godown_id = ?');
        params.push(options.godown_id);
      }
    }

    // godowns: name/code search + location filter
    if (table === 'godowns') {
      if (options.location_id) {
        where.push('location_id = ?');
        params.push(options.location_id);
      }
    }

    // models: name search + brand filter
    if (table === 'models') {
      if (options.query) {
        where.push('name LIKE ?');
        params.push(`%${options.query}%`);
      }
      if (options.brand_id) {
        where.push('brand_id = ?');
        params.push(options.brand_id);
      }
      if (options.stock_category_id) {
        where.push('stock_category_id = ?');
        params.push(options.stock_category_id);
      }
    }

    if (options.category_id && table === 'stock_items') {
      where.push('category_id = ?');
      params.push(options.category_id);
    }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(
      `SELECT COUNT(*) as total FROM ${table} WHERE ${whereStr}`,
      params
    );
    const total = countRow?.total || 0;

    const items = this.conn.all(
      `SELECT * FROM ${table} WHERE ${whereStr} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { items, total };
  }

  /** Generic find-one by id + company */
  findOne(table, id, companyId) {
    return this.conn.get(
      `SELECT * FROM ${table} WHERE id = ? AND company_id = ? LIMIT 1`,
      [id, companyId]
    );
  }

  /** Generic create — auto-generates id, timestamps, company_id */
  create(table, data, companyId) {
    const id = data.id || generateId(table.substring(0, 4));
    const now = new Date().toISOString();
    // Filter out non-column fields: id, company_id, timestamps, and any key not in the table schema
    const columns = this.conn.all(`PRAGMA table_info(${table})`).map(c => c.name);
    const reserved = ['id', 'company_id', 'created_at', 'updated_at'];
    const keys = Object.keys(data).filter(k => !reserved.includes(k) && columns.includes(k));
    const placeholders = keys.map(() => '?').join(', ');
    const values = keys.map(k => data[k] !== undefined ? data[k] : null);

    const sql = `INSERT INTO ${table} (id, ${keys.join(', ')}, company_id, created_at, updated_at) VALUES (?, ${placeholders}, ?, ?, ?)`;
    this.conn.run(sql, [id, ...values, companyId, now, now]);
    return this.findOne(table, id, companyId);
  }

  /**
   * Create a Location record.
   * After the schema rebuild (Step 078d), locations no longer have a godown_id
   * column. The relationship is now Location → Godowns (godowns.location_id → locations.id).
   * This method handles both old DBs (with godown_id) and new DBs (without it).
   */
  createLocation(data, companyId) {
   const id = data.id || generateId('loca');
   const now = new Date().toISOString();
   const isActive = data.is_active !== undefined ? data.is_active : 1;
   // Check if godown_id column still exists (old DB before rebuild)
   const cols = this.conn.all("PRAGMA table_info(locations)").map(c => c.name);
   const hasGodownCol = cols.includes('godown_id');
   const godownId = data.godown_id || null;
   if (hasGodownCol) {
     const sql = `INSERT INTO locations (id, company_id, godown_id, name, code, address, is_active, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
     this.conn.run(sql, [id, companyId, godownId, data.name, data.code || null, data.address || null, isActive, now, now, data.created_by || null, data.updated_by || null]);
   } else {
     const sql = `INSERT INTO locations (id, company_id, name, code, address, is_active, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
     this.conn.run(sql, [id, companyId, data.name, data.code || null, data.address || null, isActive, now, now, data.created_by || null, data.updated_by || null]);
   }
   // `locations` is the single canonical location master.
   //
   // The dual-write into `inv_locations` that used to live here is removed. It
   // silently swallowed UNIQUE collisions (see the old catch block), which is
   // precisely how the two tables drifted apart in the first place: the same id
   // ended up with different names, and rows existed in one table only. Migration
   // 081 retired `inv_locations`; nothing writes to it now.
   return this.findOne('locations', id, companyId);
  }

  /** List with JOIN to parent table for hierarchical display (e.g., stock_categories → stock_groups) */
  listWithJoin(table, companyId, options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    let where = ['sc.company_id = ?'];
    const params = [companyId];
    // All records are listed (permanent deletion — no is_active filtering)
    if (options.query) {
      where.push('(sc.name LIKE ?)');
      params.push(`%${options.query}%`);
    }
    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(
      `SELECT COUNT(*) as total FROM ${table} sc WHERE ${whereStr}`,
      params
    );
    const total = countRow?.total || 0;
    const items = this.conn.all(
      `SELECT sc.*, sg.name as stock_group_name, sg.id as stock_group_id_raw 
       FROM ${table} sc 
       LEFT JOIN stock_groups sg ON sc.stock_group_id = sg.id 
       WHERE ${whereStr} 
       ORDER BY sc.created_at DESC 
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { items, total };
  }

  /** Generic update — auto-sets updated_at */
  update(table, id, data, companyId) {
    const existing = this.findOne(table, id, companyId);
    if (!existing) throw new NotFoundError('Record', id);

    // Filter out fields that aren't columns (non-updatable)
    const columns = this.conn.all(`PRAGMA table_info(${table})`).map(c => c.name);
    const updatable = Object.keys(data).filter(k => !['id', 'company_id', 'created_at'].includes(k) && columns.includes(k));
    if (updatable.length === 0) throw new ValidationError('No fields to update');

    const sets = updatable.map(k => `${k} = ?`).join(', ');
    const values = updatable.map(k => data[k] !== undefined ? data[k] : null);
    const now = new Date().toISOString();

    const sql = `UPDATE ${table} SET ${sets}, updated_at = ? WHERE id = ? AND company_id = ?`;
    this.conn.run(sql, [...values, now, id, companyId]);
    return this.findOne(table, id, companyId);
  }

  /**
   * Permanent delete a record (physical DELETE — no soft-delete).
   * Related records must be handled by the caller or via DB cascade.
   */
  softDelete(table, id, companyId) {
    const existing = this.findOne(table, id, companyId);
    if (!existing) throw new NotFoundError('Record', id);
    this.conn.run(`DELETE FROM ${table} WHERE id = ? AND company_id = ?`, [id, companyId]);
    return { id, deleted: true };
  }

  // ─── Voucher header + lines ────────────────────────────────────────

  createVoucherHeader(headerData, companyId) {
    const now = new Date().toISOString();
    const keys = Object.keys(headerData);
    const placeholders = keys.map(() => '?').join(', ');
    const values = keys.map(k => headerData[k] !== undefined ? headerData[k] : null);

    const sql = `INSERT INTO inventory_voucher_headers (id, ${keys.join(', ')}, company_id, created_at, updated_at) VALUES (?, ${placeholders}, ?, ?, ?)`;
    const id = generateId('ivh');
    this.conn.run(sql, [id, ...values, companyId, now, now]);
    return this.conn.get('SELECT * FROM inventory_voucher_headers WHERE id = ? AND company_id = ?', [id, companyId]);
  }

  createVoucherLine(lineData, companyId) {
    const now = new Date().toISOString();
    const keys = Object.keys(lineData);
    const placeholders = keys.map(() => '?').join(', ');
    const values = keys.map(k => lineData[k] !== undefined ? lineData[k] : null);

    const sql = `INSERT INTO inventory_voucher_lines (id, ${keys.join(', ')}, company_id, created_at) VALUES (?, ${placeholders}, ?, ?)`;
    const id = generateId('ivl');
    this.conn.run(sql, [id, ...values, companyId, now]);
    return id;
  }

  /** Get voucher header with its lines */
  getVoucherWithLines(voucherNumber, companyId) {
    const header = this.conn.get(
      'SELECT * FROM inventory_voucher_headers WHERE voucher_number = ? AND company_id = ? LIMIT 1',
      [voucherNumber, companyId]
    );
    if (!header) return null;
    const lines = this.conn.all(
      'SELECT * FROM inventory_voucher_lines WHERE header_id = ? AND company_id = ? ORDER BY line_number',
      [header.id, companyId]
    );
    return { ...header, lines };
  }

  /** List vouchers with filters */
  listVouchers(companyId, options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const where = ['company_id = ?'];
    const params = [companyId];

    if (options.voucher_type) {
      where.push('voucher_type = ?');
      params.push(options.voucher_type);
    }
    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.startDate) {
      where.push('voucher_date >= ?');
      params.push(options.startDate);
    }
    if (options.endDate) {
      where.push('voucher_date <= ?');
      params.push(options.endDate);
    }
    if (options.query) {
      where.push('(voucher_number LIKE ? OR reference_id LIKE ? OR narration LIKE ?)');
      params.push(`%${options.query}%`, `%${options.query}%`, `%${options.query}%`);
    }

    const whereStr = where.join(' AND ');
    const countRow = this.conn.get(
      `SELECT COUNT(*) as total FROM inventory_voucher_headers WHERE ${whereStr}`,
      params
    );
    const total = countRow?.total || 0;

    const items = this.conn.all(
      `SELECT * FROM inventory_voucher_headers WHERE ${whereStr} ORDER BY voucher_date DESC, created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { items, total };
  }

  // ─── Stock Ledger ──────────────────────────────────────────────────

  /** Get stock balance: SUM(quantity) for given filters */
  computeStockBalance(companyId, itemId, godownId, batchId, locationId) {
    const params = [companyId, itemId, godownId];
    let sql = `SELECT COALESCE(SUM(quantity), 0) as quantity,
                      COALESCE(SUM(amount), 0) as value
               FROM stock_ledger
               WHERE company_id = ? AND item_id = ? AND godown_id = ?`;

    if (batchId) {
      sql += ' AND batch_id = ?';
      params.push(batchId);
    } else {
      sql += ' AND (batch_id IS NULL OR batch_id = ?)';
      params.push(null);
    }

    if (locationId) {
      sql += ' AND location_id = ?';
      params.push(locationId);
    }

    return this.conn.get(sql, params);
  }

  // ─── Stock Balances (materialised) ─────────────────────────────────

  /** Rebuild all stock_balances for a company from stock_ledger */
  rebuildStockBalances(companyId) {
    return this.conn.transaction(() => {
      // Wipe existing balances
      this.conn.run('DELETE FROM stock_balances WHERE company_id = ?', [companyId]);

      // Rebuild from ledger
      const rows = this.conn.all(
        `SELECT item_id, batch_id, godown_id, location_id,
                SUM(quantity) as total_qty,
                SUM(amount) as total_value
         FROM stock_ledger
         WHERE company_id = ?
         GROUP BY item_id, batch_id, godown_id, location_id
         HAVING SUM(quantity) != 0`,
        [companyId]
      );

      const now = new Date().toISOString();
      for (const row of rows) {
        const avgRate = parseFloat(row.total_qty) > 0
          ? parseFloat(row.total_value) / parseFloat(row.total_qty)
          : 0;
        this.conn.run(
          `INSERT INTO stock_balances (id, company_id, item_id, batch_id, godown_id, location_id, quantity, avg_rate, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [generateId('sb'), companyId, row.item_id, row.batch_id, row.godown_id, row.location_id,
           parseFloat(row.total_qty), avgRate, now]
        );
      }
    })();
  }

  // ─── Serial Number Lifecycle ───────────────────────────────────────

  /** Get serial by number + company */
  getSerial(companyId, serialNumber) {
    return this.conn.get(
      'SELECT * FROM item_serials WHERE serial_number = ? AND company_id = ? LIMIT 1',
      [serialNumber, companyId]
    );
  }

  /** Get all serials for an item in a company */
  getSerialsByItem(companyId, itemId) {
    return this.conn.all(
      'SELECT * FROM item_serials WHERE item_id = ? AND company_id = ? ORDER BY serial_number',
      [itemId, companyId]
    );
  }

  // ─── Inventory Items (stock items) ─────────────────────────────────

  findItemBySku(companyId, sku) {
    return this.conn.get(
      'SELECT * FROM stock_items WHERE sku = ? AND company_id = ? LIMIT 1',
      [sku, companyId]
    );
  }

  findItemByProduct(companyId, productId) {
    return this.conn.get(
      'SELECT * FROM stock_items WHERE product_id = ? AND company_id = ? LIMIT 1',
      [productId, companyId]
    );
  }

  /** List stock items with inventory balance joined */
  listStockItemsWithBalance(companyId, options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    let where = ['si.company_id = ?'];
    const params = [companyId];

    if (options.query) {
      where.push('(si.name LIKE ? OR si.sku LIKE ?)');
      params.push(`%${options.query}%`, `%${options.query}%`);
    }
    // All records are listed (permanent deletion — no is_active filtering)

    const whereStr = where.join(' AND ');
    // Aggregate stock_balances per item rather than joining a single row.
    //
    // The previous join pinned `sb.batch_id IS NULL` and therefore returned one
    // row per item at best. For a BATCH-TRACKED item every balance row has a
    // batch_id, so the join never matched and the item reported on_hand_qty = 0
    // (and stock_value = 0) no matter how much stock it actually held. Summing
    // the dimensions is what the godown/location/batch reports already do, and
    // it is the correct answer for an item-level "on hand" figure.
    const items = this.conn.all(
      `SELECT si.*,
              COALESCE(sb.total_qty, 0) as on_hand_qty,
              COALESCE(sb.value, 0) as stock_value,
              CASE WHEN sb.total_qty > 0 AND sb.value > 0
                   THEN ROUND(sb.value / sb.total_qty, 4) ELSE 0 END as avg_rate
       FROM stock_items si
       LEFT JOIN (
         SELECT item_id, company_id,
                SUM(quantity) AS total_qty,
                SUM(quantity * COALESCE(avg_rate, 0)) AS value
         FROM stock_balances
         GROUP BY item_id, company_id
       ) sb ON sb.item_id = si.id AND sb.company_id = si.company_id
       WHERE ${whereStr}
       ORDER BY si.name ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const total = this.conn.get(
      `SELECT COUNT(*) as total FROM stock_items si WHERE ${whereStr}`,
      params
    ).total || 0;

    return { items, total };
  }

  // ─── Valuation ─────────────────────────────────────────────────────

  /** Weighted average valuation for an item (across all batches/locations) */
  computeWeightedAverage(companyId, itemId) {
    const row = this.conn.get(
      `SELECT SUM(quantity) as total_qty, SUM(amount) as total_value
       FROM stock_ledger
       WHERE company_id = ? AND item_id = ?`,
      [companyId, itemId]
    );
    const qty = parseFloat(row?.total_qty) || 0;
    const val = parseFloat(row?.total_value) || 0;
    return {
      quantity: qty,
      total_value: val,
      avg_rate: qty > 0 ? val / qty : 0,
    };
  }

  // ─── Inventory Hierarchy (Location → Godown → Inventory Group → Item Group) ─

  /**
   * List locations (top-level sites) for a company.
   * @param {string} companyId
   * @param {object} options - { limit, offset, is_active, query }
   */
  listLocations(companyId, options = {}) {
    return this.list("locations", companyId, options);
  }

  /**
   * Get godowns for a given location.
   * Uses the direct foreign key: godowns.location_id = locationId.
   * (Backward compatible: also checks locations.godown_id if the column exists.)
   */
  listGodownsByLocation(companyId, locationId, options = {}) {
    const limit = options.limit || 100;
    const offset = options.offset || 0;
    const where = ["g.company_id = ?"];
    const params = [companyId];

    if (locationId) {
      // Primary relationship: godowns.location_id = locationId (direct FK)
      // Also check locations.godown_id if the column still exists (backward compat)
      const locCols = this.conn.all("PRAGMA table_info(locations)").map(c => c.name);
      if (locCols.includes("godown_id")) {
        const godownWhere = `(g.location_id = ? OR g.id IN (SELECT godown_id FROM locations WHERE id = ? AND godown_id IS NOT NULL))`;
        where.push(godownWhere);
        params.push(locationId, locationId);
      } else {
        where.push("g.location_id = ?");
        params.push(locationId);
      }
    }
    if (options.query) {
      where.push("(g.name LIKE ? OR g.code LIKE ?)");
      params.push(`%${options.query}%`, `%${options.query}%`);
    }
    const whereStr = where.join(" AND ");
    const items = this.conn.all(
      `SELECT * FROM godowns g WHERE ${whereStr} ORDER BY g.name ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const countRow = this.conn.get(
      `SELECT COUNT(*) as total FROM godowns g WHERE ${whereStr}`,
      [...params]
    );
    const total = countRow?.total || 0;
    return { items, total };
  }

  /**
   * Get top-level stock_groups (Inventory Groups) for a godown.
   * Top-level groups have godown_id set and parent_group_id IS NULL.
   */
  listInventoryGroupsByGodown(companyId, godownId, options = {}) {
    const limit = options.limit || 100;
    const offset = options.offset || 0;
    const where = ["company_id = ?", "godown_id = ?", "parent_group_id IS NULL"];
    const params = [companyId, godownId];
    if (options.query) {
      where.push("(name LIKE ?)");
      params.push(`%${options.query}%`);
    }
    const whereStr = where.join(" AND ");
    const items = this.conn.all(
      `SELECT * FROM stock_groups WHERE ${whereStr} ORDER BY name ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const countRow = this.conn.get(
      `SELECT COUNT(*) as total FROM stock_groups WHERE ${whereStr}`,
      params
    );
    return { items, total: countRow?.total || 0 };
  }

  /**
   * Get child stock_groups (Item Groups) for a parent group.
   * Child groups have parent_group_id pointing to the parent.
   */
  listItemGroupsByParent(companyId, parentGroupId, options = {}) {
    const limit = options.limit || 100;
    const offset = options.offset || 0;
    const where = ["company_id = ?", "parent_group_id = ?"];
    const params = [companyId, parentGroupId];
    if (options.query) {
      where.push("(name LIKE ?)");
      params.push(`%${options.query}%`);
    }
    const whereStr = where.join(" AND ");
    const items = this.conn.all(
      `SELECT * FROM stock_groups WHERE ${whereStr} ORDER BY name ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const countRow = this.conn.get(
      `SELECT COUNT(*) as total FROM stock_groups WHERE ${whereStr}`,
      params
    );
    return { items, total: countRow?.total || 0 };
  }

  /**
   * Get the full hierarchy tree: locations → godowns → inventory groups → item groups.
   * Used by: Products page to populate dependent dropdowns.
   */
  getLocationHierarchy(companyId) {
    // 1. Get all locations
    const locations = this.conn.all(
      `SELECT * FROM locations WHERE company_id = ? ORDER BY name`,
      [companyId]
    );

    // 2. Get all godowns with their location_id
    const godowns = this.conn.all(
      `SELECT * FROM godowns WHERE company_id = ? ORDER BY name`,
      [companyId]
    );

    // 3. Get all stock_groups (both top-level with godown_id and child groups with parent_group_id)
    const groups = this.conn.all(
      `SELECT * FROM stock_groups WHERE company_id = ? ORDER BY name`,
      [companyId]
    );

    // Build maps for efficient tree construction
    const godownMap = {};
    const groupMap = {}; // id -> { ...group, item_groups: [] }

    godowns.forEach(g => { godownMap[g.id] = { ...g, inventory_groups: [] }; });
    groups.forEach(g => {
      groupMap[g.id] = { ...g, item_groups: [] };
    });

    // Attach godowns to locations
    locations.forEach(loc => {
      loc.godowns = godowns
        .filter(g => g.location_id === loc.id)
        .map(g => godownMap[g.id] || g);
    });

    // Assign groups to their parents
    groups.forEach(g => {
      if (g.godown_id && g.parent_group_id === null) {
        // Top-level group (Inventory Group) → belongs to a godown
        const godown = godownMap[g.godown_id];
        if (godown) {
          godown.inventory_groups.push(groupMap[g.id]);
        }
      } else if (g.parent_group_id) {
        // Child group (Item Group) → belongs to a parent group
        const parent = groupMap[g.parent_group_id];
        if (parent) {
          parent.item_groups.push(groupMap[g.id]);
        }
      }
    });

    return { locations: locations.map(loc => ({
      ...loc,
      godowns: loc.godowns || []
    }))};
  }

  /**
   * Get summary counts for the Inventory Management dashboard.
   * Returns counts of locations, godowns, inventory groups, and item groups.
   */
  getHierarchySummary(companyId) {
    const locCount = this.conn.get("SELECT COUNT(*) as c FROM locations WHERE company_id = ?", [companyId]).c || 0;
    const godownCount = this.conn.get("SELECT COUNT(*) as c FROM godowns WHERE company_id = ?", [companyId]).c || 0;
    const invGroupCount = this.conn.get("SELECT COUNT(*) as c FROM stock_groups WHERE company_id = ? AND parent_group_id IS NULL AND godown_id IS NOT NULL", [companyId]).c || 0;
    const itemGroupCount = this.conn.get("SELECT COUNT(*) as c FROM stock_groups WHERE company_id = ? AND parent_group_id IS NOT NULL", [companyId]).c || 0;
    return { locations: locCount, godowns: godownCount, inventory_groups: invGroupCount, item_groups: itemGroupCount };
  }

  /**
   * Count child groups (item groups) under a given parent group.
   */
  countItemGroups(parentGroupId, companyId) {
    const row = this.conn.get(
      "SELECT COUNT(*) as c FROM stock_groups WHERE parent_group_id = ? AND company_id = ?",
      [parentGroupId, companyId]
    );
    return row?.c || 0;
  }

  /**
   * Count inventory groups (top-level stock groups with godown_id) under a given godown.
   */
  countInventoryGroups(godownId, companyId) {
    const row = this.conn.get(
      "SELECT COUNT(*) as c FROM stock_groups WHERE godown_id = ? AND company_id = ? AND parent_group_id IS NULL",
      [godownId, companyId]
    );
    return row?.c || 0;
  }

  // ─── Models (with Stock Category join) ───────────────────────────────────

  /**
   * List models with a JOIN to stock_categories to include the parent
   * category name (and indirectly the stock_group name of that category).
   * Supports pagination, search, and the soft-masters query convention.
   */
  listModels(companyId, options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    let where = ['m.company_id = ?'];
    const params = [companyId];
    // All records are listed (permanent deletion — no is_active filtering)
    if (options.query) {
      where.push('(m.name LIKE ?)');
      params.push(`%${options.query}%`);
    }
    const whereStr = where.join(' AND ');
    const total = this.conn.get(
      `SELECT COUNT(*) as total FROM models m WHERE ${whereStr}`,
      params
    )?.total || 0;
    const items = this.conn.all(
      `SELECT m.*, sc.name AS stock_category_name, sc.id AS stock_category_id_raw,
              sg.name AS stock_group_name, sg.id AS stock_group_id_raw,
              b.name AS brand_name
       FROM models m
       LEFT JOIN stock_categories sc ON m.stock_category_id = sc.id AND sc.company_id = m.company_id
       LEFT JOIN stock_groups sg ON sc.stock_group_id = sg.id AND sg.company_id = m.company_id
       LEFT JOIN brands b ON m.brand_id = b.id AND b.company_id = m.company_id
       WHERE ${whereStr}
       ORDER BY m.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { items, total };
  }

  /** List godowns with location name joined in. */
  listGodowns(companyId, options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const orderBy = /^[a-zA-Z0-9_]+$/.test(options.orderBy || '') ? options.orderBy : 'created_at';
    const orderDir = options.orderDir === 'ASC' ? 'ASC' : 'DESC';
    let where = ['g.company_id = ?'];
    const params = [companyId];
    // All records are listed (permanent deletion — no is_active filtering)
    if (options.query) {
      where.push('(g.name LIKE ? OR g.code LIKE ?)');
      params.push(`%${options.query}%`, `%${options.query}%`);
    }
    if (options.location_id) {
      where.push('g.location_id = ?');
      params.push(options.location_id);
    }
    const whereStr = where.join(' AND ');
    const total = this.conn.get(
      `SELECT COUNT(*) as total FROM godowns g WHERE ${whereStr}`,
      params
    )?.total || 0;
    const items = this.conn.all(
      `SELECT g.*, l.name AS location_name, l.id AS location_id_raw
       FROM godowns g
       LEFT JOIN locations l ON g.location_id = l.id AND l.company_id = g.company_id
       WHERE ${whereStr}
       ORDER BY g.${orderBy} ${orderDir}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { items, total };
  }

  /** Get a single godown with its location name joined in. */
  findGodownWithJoin(id, companyId) {
    return this.conn.get(
      `SELECT g.*, l.name AS location_name, l.id AS location_id_raw
       FROM godowns g
       LEFT JOIN locations l ON g.location_id = l.id AND l.company_id = g.company_id
       WHERE g.id = ? AND g.company_id = ?
       LIMIT 1`,
      [id, companyId]
    );
  }

  /** Get a single model with its parent stock_category name joined in. */
  findModelWithJoin(table, id, companyId) {
  return this.conn.get(
    `SELECT m.*, sc.name AS stock_category_name, sc.id AS stock_category_id_raw,
            sg.name AS stock_group_name, sg.id AS stock_group_id_raw,
            b.name AS brand_name
     FROM models m
     LEFT JOIN stock_categories sc ON m.stock_category_id = sc.id AND sc.company_id = m.company_id
     LEFT JOIN stock_groups sg ON sc.stock_group_id = sg.id AND sg.company_id = m.company_id
     LEFT JOIN brands b ON m.brand_id = b.id AND b.company_id = m.company_id
     WHERE m.id = ? AND m.company_id = ?
     LIMIT 1`,
    [id, companyId]
  );
}

  /**
  * Resolve the complete hierarchy from a Model ID.
  * Hierarchy: Stock Group → Stock Category → Brand → Model → Product
  *
  * Returns the model record plus the full chain of parent IDs/names,
  * so the Products page can auto-populate all hierarchy fields from a
  * single Model selection.
  *
  * @param {string} id - The Model ID
  * @param {string} companyId
  * @returns {object|null} { id, name, brand_id, brand_name, stock_category_id,
  *   stock_category_name, stock_group_id, stock_group_name } or null
  */
  getModelHierarchy(id, companyId) {
  return this.conn.get(
    `SELECT m.id, m.name AS model_name,
            m.brand_id, b.name AS brand_name,
            m.stock_category_id, sc.name AS stock_category_name,
            sc.stock_group_id, sg.name AS stock_group_name
     FROM models m
     LEFT JOIN brands b ON m.brand_id = b.id AND b.company_id = m.company_id
     LEFT JOIN stock_categories sc ON m.stock_category_id = sc.id AND sc.company_id = m.company_id
     LEFT JOIN stock_groups sg ON sc.stock_group_id = sg.id AND sg.company_id = m.company_id
     WHERE m.id = ? AND m.company_id = ?
     LIMIT 1`,
    [id, companyId]
  );
  }

  /**
   * Resolve the complete hierarchy from a Brand ID.
   * Lookup a Brand by ID (independent master data).
   * Brand no longer has a direct Stock Category relationship — the hierarchy
   * is resolved through Model → Brand → Model.stock_category_id → Stock Category → Stock Group.
   *
   * @param {string} id - The Brand ID
   * @param {string} companyId
   * @returns {object|null} { id, name, description, is_active } or null
   */
  getBrandHierarchy(id, companyId) {
    return this.conn.get(
      `SELECT b.id, b.name AS brand_name, b.description
       FROM brands b
       WHERE b.id = ? AND b.company_id = ?
       LIMIT 1`,
      [id, companyId]
    );
  }
}

module.exports = { InventoryRepository };
