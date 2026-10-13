const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');

/**
 * Helper: write an audit log entry for product create/update actions.
 */
function logAudit(conn, companyId, userId, action, entityId, oldValues, newValues) {
  try {
    conn.run(
      `INSERT INTO audit_logs (id, company_id, user_id, action, entity_type, entity_id, old_values_json, new_values_json, ip_address, user_agent, session_id, created_at)
       VALUES (?, ?, ?, ?, 'PRODUCT', ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId('aud'), companyId, userId || 'system', action, entityId,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        null, null, null, new Date().toISOString()
      ]
    );
  } catch { /* audit logging should not break the main flow */ }
}

const { InventoryRepository } = require('../repositories/inventory.repository');

class ProductsController {
  constructor() {
    this.conn = getConn();
  }

  /**
   * Location a godown belongs to, used to fill in the location dimension when
   * the product form did not specify one.
   */
  _locationForGodown(companyId, godownId) {
    if (!godownId) return null;
    const row = this.conn.get(
      'SELECT location_id FROM godowns WHERE id = ? AND company_id = ?', [godownId, companyId]);
    return row ? row.location_id : null;
  }

  /**
   * Create and post an opening_stock inventory voucher for a newly created
   * stock item, so opening quantity enters the system the same way as every
   * other stock movement: through the immutable ledger.
   *
   * This deliberately goes through InventoryService rather than writing
   * stock_balances, because stock_balances is a derived cache that
   * rebuildStockBalances() wipes and recomputes on every voucher post.
   *
   * Returns { voucherId, voucherNumber } so the caller can report the link.
   */
  _postOpeningStockVoucher({ companyId, userId, stockItemId, sku, quantity, unitRate, godownId, locationId, narration }) {
    const { InventoryService } = require('../services/inventory.service');
    const service = new InventoryService(this.conn);

    const voucher = service.createDraftVoucher({
      voucher_type: 'opening_stock',
      voucher_date: new Date().toISOString().slice(0, 10),
      narration: narration || `Opening stock for ${sku}`,
      source_type: 'PRODUCT_CREATION',
      lines: [{
        item_id: stockItemId,
        uom_id: this.conn.get('SELECT uom_id FROM stock_items WHERE id = ?', [stockItemId])?.uom_id,
        quantity,
        unit_rate: unitRate || 0,
        source_godown_id: godownId,
        source_location_id: locationId,
        dest_godown_id: null,
        dest_location_id: null,
        is_source: 0,   // stock IN, so a positive ledger movement
      }],
    }, companyId, userId);

    const posted = service.postVoucher(voucher.voucher_number, companyId, userId);

    const header = this.conn.get(
      'SELECT id FROM inventory_voucher_headers WHERE company_id = ? AND voucher_number = ?',
      [companyId, voucher.voucher_number]);

    return {
      voucherId: header ? header.id : null,
      voucherNumber: voucher.voucher_number,
      ledgerEntries: posted ? posted.ledger_entries : 0,
    };
  }


  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req);
      const { search, category, is_active, is_service, brand } = req.query;

      const where = [];
      const params = [];
      where.push('p.company_id = ?');
      params.push(req.user.companyId);
      if (search) { where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.description LIKE ?)'); const s = `%${search}%`; params.push(s, s, s); }
      if (category) { where.push('p.category = ?'); params.push(category); }
      if (brand) { where.push('p.brand_id = ?'); params.push(brand); }
      if (is_active !== undefined) { where.push('p.is_active = ?'); params.push(is_active === 'true' ? 1 : 0); }
      if (is_service !== undefined) { where.push('p.is_service = ?'); params.push(is_service === 'true' ? 1 : 0); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      // Join with stock_items and stock_balances for inventory data
      // Also join models/brands/stock_categories/stock_groups for hierarchy display
      const items = this.conn.all(
        `SELECT p.*, \n                si.id as stock_item_id, si.sku as stock_item_sku, si.is_serial_tracked, si.is_batch_tracked, si.uom_id,\n                si.location_id, si.godown_id, si.inventory_group_id, si.item_group_id,\n                COALESCE(sb.quantity, 0) as on_hand_qty,\n                COALESCE(sb.avg_rate, 0) as avg_rate,\n                COALESCE(sb.quantity * sb.avg_rate, 0) as stock_value,\n                m.name as model_name, b.name as brand_name, sc.name as stock_category_name, sg.name as stock_group_name\n         FROM products p\n         LEFT JOIN stock_items si ON si.product_id = p.id AND si.company_id = p.company_id\n         LEFT JOIN stock_balances sb ON sb.item_id = si.id AND sb.company_id = p.company_id AND sb.batch_id IS NULL\n         LEFT JOIN models m ON p.model_id = m.id AND m.company_id = p.company_id\n         LEFT JOIN brands b ON p.brand_id = b.id AND b.company_id = p.company_id\n         LEFT JOIN stock_categories sc ON p.stock_category_id = sc.id AND sc.company_id = p.company_id\n         LEFT JOIN stock_groups sg ON p.stock_group_id = sg.id AND sg.company_id = p.company_id\n         ${whereSql}\n         ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      const total = this.conn.get(`SELECT COUNT(*) as total FROM products p ${whereSql}`, params).total;
      res.json(paginatedResponse(items, total, page, limit));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      const item = this.conn.get('SELECT * FROM products WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!item) throw new NotFoundError('Product', req.params.id);
      // Fetch related inventory data
      const stockItem = this.conn.get('SELECT * FROM stock_items WHERE product_id = ? AND company_id = ? LIMIT 1', [item.id, req.user.companyId]);
      const stockBalance = stockItem ? this.conn.get('SELECT * FROM stock_balances WHERE item_id = ? AND company_id = ? AND batch_id IS NULL LIMIT 1', [stockItem.id, req.user.companyId]) : null;
      // Fetch hierarchy names for the product's model → brand → stock_category → stock_group chain
      let modelName = null, brandName = null, stockCategoryName = null, stockGroupName = null;
      if (item.model_id) {
        const modelRow = this.conn.get(
          `SELECT m.name as model_name, b.name as brand_name, sc.name as stock_category_name, sg.name as stock_group_name
           FROM models m
           LEFT JOIN brands b ON b.id = m.brand_id AND b.company_id = m.company_id
           LEFT JOIN stock_categories sc ON sc.id = m.stock_category_id AND sc.company_id = m.company_id
           LEFT JOIN stock_groups sg ON sg.id = sc.stock_group_id AND sg.company_id = sc.company_id
           WHERE m.id = ? AND m.company_id = ?`,
          [item.model_id, req.user.companyId]
        );
        if (modelRow) {
          modelName = modelRow.model_name;
          brandName = modelRow.brand_name;
          stockCategoryName = modelRow.stock_category_name;
          stockGroupName = modelRow.stock_group_name;
        }
      }

      res.json(successResponse({
        ...item,
        stock_item_id: stockItem?.id || null,
        modelName, brandName, stockCategoryName, stockGroupName,
        stockItem: stockItem ? { ...stockItem, on_hand_qty: stockBalance?.quantity || 0, avg_rate: stockBalance?.avg_rate || 0, stock_value: (stockBalance?.quantity || 0) * (stockBalance?.avg_rate || 0) } : null
      }));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    let id;
    try {
      const { name, description, category, category_id, sku, price, cost, tax_rate, is_service, is_active, status, track_inventory,
              brand_id, model_id, colour_id, size_id, style_id, group_id, uom_id,
              is_batch_tracked, is_serial_tracked, min_stock_level, max_stock_level,
              location_id, godown_id, inventory_group_id, item_group_id, opening_quantity,
              stock_group_id, stock_category_id } = req.body;
      if (!name) throw new ValidationError('Name is required');

      // Map frontend 'status' (string: 'active'/'inactive') to DB 'is_active' (0/1)
      const activeValue = is_active !== undefined ? is_active : (status !== undefined ? (String(status).toLowerCase() === 'active' ? 1 : 0) : 1);

      id = req.body.id ? undefined : generateId('prod');
      if (req.body.id) throw new ValidationError('id must not be supplied by the client');
      const now = new Date().toISOString();
      const companyId = req.user.companyId;

      this.conn.run(`
        INSERT INTO products (id, company_id, name, description, category, sku, price, cost, tax_rate, is_service, is_active, created_at, updated_at, stock_group_id, stock_category_id, brand_id, model_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, companyId, name, description, category, sku, price || 0, cost || 0, tax_rate || 0, is_service ? 1 : 0, activeValue, now, now, stock_group_id || null, stock_category_id || null, brand_id || null, model_id || null]);

      const product = this.conn.get('SELECT * FROM products WHERE id = ? AND company_id = ?', [id, companyId]);

      // Validate hierarchy integrity: Location + Godown can be provided together
      // (Inventory Group and Item Group are optional sub-classifications)
      const hierarchyFields = { location_id, godown_id, inventory_group_id, item_group_id };
      const providedHierarchy = Object.values(hierarchyFields).filter(v => v !== undefined && v !== null && v !== '');
      const hasAllHierarchy = Object.values(hierarchyFields).every(v => v !== undefined && v !== null && v !== '');
      const locationGodownOnly = providedHierarchy.length === 2 && 
        location_id && godown_id && !inventory_group_id && !item_group_id;
      if (providedHierarchy.length > 0 && !hasAllHierarchy && !locationGodownOnly) {
        throw new ValidationError('If providing inventory hierarchy (location_id, godown_id, inventory_group_id, item_group_id), all four must be specified together, or just location_id + godown_id');
      }

      // If inventory tracking is requested, create a linked stock_item
      const trackInventory = track_inventory || is_serial_tracked || is_batch_tracked || uom_id || brand_id || model_id || colour_id || size_id || style_id || group_id || hasAllHierarchy || location_id || godown_id;
      if (trackInventory) {
        const stockItemId = generateId('stoc');
        const stockNow = new Date().toISOString();
        // Ensure default accounts exist if not provided
        const stockAssetAccount = 'acc_cash';
        const cogsAccount = 'acc_cogs';
        const inventoryVarianceAccount = 'acc_purchases';
        const openingStockAccount = 'acc_capital';
        const purchaseAccount = 'acc_purchases';
        const salesAccount = 'acc_sales';
        // Resolve a default UOM if not provided (uom_id is NOT NULL in stock_items).
        // If the company has no UOMs at all, create a default "Unit" so product creation
        // doesn't fail with an unexplained constraint error.
        let resolvedUomId = uom_id;
        if (!resolvedUomId) {
          const defaultUom = this.conn.get("SELECT id FROM units_of_measure WHERE company_id = ? AND is_active = 1 ORDER BY created_at LIMIT 1", [companyId]);
          resolvedUomId = defaultUom ? defaultUom.id : null;
          if (!resolvedUomId) {
            const defaultUomId = generateId('unit');
            try {
              this.conn.run(
                "INSERT INTO units_of_measure (id, company_id, name, symbol, is_active) VALUES (?, ?, ?, ?, 1)",
                [defaultUomId, companyId, 'Unit', 'unit']
              );
              resolvedUomId = defaultUomId;
            } catch (e) {
              throw new ValidationError('No unit of measure available. Please create a unit in Inventory > Units of Measure before adding a tracked product.');
            }
          }
        }

        // Resolve category to a stock_categories FK id if it's a name
        let resolvedCategoryId = category_id;
        if (!resolvedCategoryId && category) {
          const catRow = this.conn.get(
            "SELECT id FROM stock_categories WHERE company_id = ? AND (id = ? OR name = ?) LIMIT 1",
            [companyId, category, category]
          );
          resolvedCategoryId = catRow ? catRow.id : null;
        }

        // Validate foreign key references exist and are valid for this company before inserting
        if (location_id) {
          // `locations` is the single canonical location master (migration 081
          // retired `inv_locations`), so only the canonical table is consulted.
          const loc = this.conn.get(
            "SELECT id FROM locations WHERE id = ? AND company_id = ? AND is_active = 1",
            [location_id, companyId]
          );
          if (!loc) throw new ValidationError(`Invalid or inactive location_id: ${location_id}`);
        }
        if (godown_id) {
          const g = this.conn.get("SELECT id FROM godowns WHERE id = ? AND company_id = ? AND is_active = 1", [godown_id, companyId]);
          if (!g) throw new ValidationError(`Invalid or inactive godown_id: ${godown_id}`);
        }
        if (inventory_group_id) {
          const ig = this.conn.get("SELECT id FROM stock_groups WHERE id = ? AND company_id = ? AND is_active = 1 AND parent_group_id IS NULL AND godown_id IS NOT NULL", [inventory_group_id, companyId]);
          if (!ig) throw new ValidationError(`Invalid or inactive inventory_group_id (must be a top-level group): ${inventory_group_id}`);
        }
        if (item_group_id) {
          const itg = this.conn.get("SELECT id FROM stock_groups WHERE id = ? AND company_id = ? AND is_active = 1 AND parent_group_id IS NOT NULL", [item_group_id, companyId]);
          if (!itg) throw new ValidationError(`Invalid or inactive item_group_id (must be a child group): ${item_group_id}`);
        }
        // Validate product hierarchy FKs
        // Note: is_active may be NULL (legacy data) or 1 — both are accepted as "active"
        if (stock_group_id) {
          const sg = this.conn.get("SELECT id FROM stock_groups WHERE id = ? AND company_id = ? AND (is_active = 1 OR is_active IS NULL)", [stock_group_id, companyId]);
          if (!sg) throw new ValidationError(`Invalid or inactive stock_group_id: ${stock_group_id}`);
        }
        if (stock_category_id) {
          const sc = this.conn.get("SELECT id FROM stock_categories WHERE id = ? AND company_id = ? AND (is_active = 1 OR is_active IS NULL)", [stock_category_id, companyId]);
          if (!sc) throw new ValidationError(`Invalid or inactive stock_category_id: ${stock_category_id}`);
        }
        if (brand_id) {
          const b = this.conn.get("SELECT id FROM brands WHERE id = ? AND company_id = ? AND (is_active = 1 OR is_active IS NULL)", [brand_id, companyId]);
          if (!b) throw new ValidationError(`Invalid or inactive brand_id: ${brand_id}`);
        }
        if (model_id) {
          const m = this.conn.get("SELECT id FROM models WHERE id = ? AND company_id = ? AND (is_active = 1 OR is_active IS NULL)", [model_id, companyId]);
          if (!m) throw new ValidationError(`Invalid or inactive model_id: ${model_id}`);
        }

        // Check for an existing stock_item with the same name for this company (UNIQUE(company_id, name))
        const existingByName = this.conn.get(
          'SELECT id FROM stock_items WHERE company_id = ? AND name = ? LIMIT 1',
          [companyId, name]
        );
        if (existingByName) {
          throw new ValidationError(`A stock item with name "${name}" already exists for this company. Link the existing stock item or use a different name.`);
        }

        this.conn.run(`
          INSERT INTO stock_items (id, company_id, name, sku, product_id, description, brand_id, model_id, colour_id, size_id, style_id, category_id, group_id, uom_id,
            is_batch_tracked, is_serial_tracked, is_active, cost_price, mrp, selling_rate, min_stock_level, max_stock_level,
            stock_asset_account_id, cogs_account_id, inventory_variance_account_id, opening_stock_account_id, purchase_account_id, sales_account_id,
            created_at, updated_at, created_by, updated_by,
            location_id, godown_id, inventory_group_id, item_group_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?)
        `, [stockItemId, companyId, name, sku, id, description, brand_id, model_id, colour_id, size_id, style_id, resolvedCategoryId, group_id,
          resolvedUomId, is_batch_tracked ? 1 : 0, is_serial_tracked ? 1 : 0, activeValue, cost || 0, price || 0, price || 0, min_stock_level || 0, max_stock_level || null,
          stockAssetAccount, cogsAccount, inventoryVarianceAccount, openingStockAccount, purchaseAccount, salesAccount,
          stockNow, stockNow, null, null,
          location_id || null, godown_id || null, inventory_group_id || null, item_group_id || null]);

        // ── Opening stock: route through the canonical ledger ──
        // The form still accepts an opening quantity, but it must NOT be
        // written to stock_balances directly. stock_balances is derived from
        // stock_ledger and is wiped and rebuilt by rebuildStockBalances(), so a
        // direct write would be silently lost on the next voucher post.
        // Instead an opening_stock voucher is created and posted, which writes
        // an immutable ledger row and lets the engine derive the balance.
        const parsedOpeningQty = parseFloat(opening_quantity) || 0;
        if (parsedOpeningQty > 0) {
          // Resolve the godown: use the provided one, else the company's first
          // active godown. Stock cannot exist without a godown.
          let resolvedGodownId = godown_id;
          if (!resolvedGodownId) {
            const g = this.conn.get(
              "SELECT id FROM godowns WHERE company_id = ? AND is_active = 1 ORDER BY created_at LIMIT 1",
              [companyId]);
            resolvedGodownId = g ? g.id : null;
          }
          if (!resolvedGodownId) {
            throw new ValidationError(
              'Cannot record opening stock: no godown was provided and the company has no active godown.');
          }

          const resolvedLocationId = location_id || this._locationForGodown(companyId, resolvedGodownId);

          const openingResult = this._postOpeningStockVoucher({
            companyId,
            userId: req.user?.userId,
            stockItemId,
            sku,
            quantity: parsedOpeningQty,
            unitRate: parseFloat(cost) || 0,
            godownId: resolvedGodownId,
            locationId: resolvedLocationId,
            narration: `Opening stock for ${name}`,
          });

          product.opening_stock_voucher_id = openingResult.voucherId;
          product.opening_stock_voucher_number = openingResult.voucherNumber;
        } else {
          product.opening_stock_voucher_id = null;
          product.opening_stock_voucher_number = null;
        }

        // Mark the product as under inventory control now that it has a stock
        // item. Kept in sync here and in update(); read by the billing flow to
        // decide whether a bill line moves stock.
        this.conn.run(
          'UPDATE products SET is_inventory_managed = 1 WHERE id = ? AND company_id = ?',
          [id, companyId]);

        product.stock_item_id = stockItemId;
      }

      // Write audit log for product creation
      logAudit(this.conn, companyId, req.user?.userId, 'PRODUCT_CREATED', id, null, {
        name: product.name, sku: product.sku, price: product.price, cost: product.cost,
        stock_item_id: product.stock_item_id
      });

      res.status(201).json(successResponse(product, 201));
    } catch (err) {
      // Clean up product if stock_item creation failed
      if (err && id) {
        try { this.conn.run('DELETE FROM products WHERE id = ?', [id]); } catch (cleanupErr) { /* ignore */ }
      }
      next(err);
    }
  }

  async update(req, res, next) {
    try {
      const existing = this.conn.get('SELECT id FROM products WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Product', req.params.id);

      const allowed = ['name', 'description', 'category', 'sku', 'price', 'cost', 'tax_rate', 'is_service', 'is_active', 'status',
                       'location_id', 'godown_id', 'inventory_group_id', 'item_group_id',
                       'stock_group_id', 'stock_category_id', 'brand_id', 'model_id'];
      const sets = [];
      const params = [];
      for (const f of allowed) {
        if (req.body[f] !== undefined) {
          if (f === 'is_active' || f === 'status') {
            const v = (f === 'is_active') ? (req.body[f] ? 1 : 0) : (String(req.body[f]).toLowerCase() === 'active' ? 1 : 0);
            sets.push('is_active = ?'); params.push(v);
          } else {
            const v = (f === 'is_service') ? (req.body[f] ? 1 : 0) : req.body[f];
            sets.push(`${f} = ?`); params.push(v);
          }
        }
      }
      if (!sets.length) throw new ValidationError('No fields to update');

      const now = new Date().toISOString();
      this.conn.run(`UPDATE products SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND company_id = ?`, [...params, now, req.params.id, req.user.companyId]);

      const product = this.conn.get('SELECT * FROM products WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);

      // Sync name/price/cost/active to linked stock_item
      // Also sync hierarchy fields if provided
      const stockItemUpdate = [];
      const stockItemParams = [];

      // Validate hierarchy: Location + Godown can be provided together
      // (Inventory Group and Item Group are optional sub-classifications)
      const locId = req.body.location_id;
      const godownId = req.body.godown_id;
      const invGroupId = req.body.inventory_group_id;
      const itemGroupId = req.body.item_group_id;
      const locationGodownOnly = (locId !== undefined && locId !== null && locId !== '') &&
        (godownId !== undefined && godownId !== null && godownId !== '') &&
        (invGroupId === undefined || invGroupId === null || invGroupId === '') &&
        (itemGroupId === undefined || itemGroupId === null || itemGroupId === '');
      if (locationGodownOnly) {
        // Location + Godown only — OK, groups are optional
      } else if (invGroupId !== undefined || itemGroupId !== undefined || locId !== undefined || godownId !== undefined) {
        // Some hierarchy fields provided — require all four
        const hierarchyFields = ['location_id', 'godown_id', 'inventory_group_id', 'item_group_id'];
        const providedHierarchy = hierarchyFields.filter(f => req.body[f] !== undefined && req.body[f] !== null && req.body[f] !== '');
        if (providedHierarchy.length > 0 && providedHierarchy.length !== 4) {
          throw new ValidationError('If providing inventory hierarchy (location_id, godown_id, inventory_group_id, item_group_id), all four must be specified together, or just location_id + godown_id');
        }
      }

      // Validate FK references for hierarchy fields
      if (req.body.location_id !== undefined && req.body.location_id !== null && req.body.location_id !== '') {
        // `locations` is the single canonical location master (migration 081
        // retired `inv_locations`), so only the canonical table is consulted.
        const loc = this.conn.get(
          "SELECT id FROM locations WHERE id = ? AND company_id = ? AND is_active = 1",
          [req.body.location_id, req.user.companyId]
        );
        if (!loc) throw new ValidationError(`Invalid or inactive location_id: ${req.body.location_id}`);
      }
      if (req.body.godown_id !== undefined && req.body.godown_id !== null && req.body.godown_id !== '') {
        const g = this.conn.get("SELECT id FROM godowns WHERE id = ? AND company_id = ? AND is_active = 1", [req.body.godown_id, req.user.companyId]);
        if (!g) throw new ValidationError(`Invalid or inactive godown_id: ${req.body.godown_id}`);
      }
      if (req.body.inventory_group_id !== undefined && req.body.inventory_group_id !== null && req.body.inventory_group_id !== '') {
        const ig = this.conn.get("SELECT id FROM stock_groups WHERE id = ? AND company_id = ? AND is_active = 1 AND parent_group_id IS NULL AND godown_id IS NOT NULL", [req.body.inventory_group_id, req.user.companyId]);
        if (!ig) throw new ValidationError(`Invalid or inactive inventory_group_id: ${req.body.inventory_group_id}`);
      }
      if (req.body.item_group_id !== undefined && req.body.item_group_id !== null && req.body.item_group_id !== '') {
        const itg = this.conn.get("SELECT id FROM stock_groups WHERE id = ? AND company_id = ? AND is_active = 1 AND parent_group_id IS NOT NULL", [req.body.item_group_id, req.user.companyId]);
        if (!itg) throw new ValidationError(`Invalid or inactive item_group_id: ${req.body.item_group_id}`);
      }
      // Validate product hierarchy FKs
      if (req.body.stock_group_id !== undefined && req.body.stock_group_id !== null && req.body.stock_group_id !== '') {
        const sg = this.conn.get("SELECT id FROM stock_groups WHERE id = ? AND company_id = ? AND (is_active = 1 OR is_active IS NULL)", [req.body.stock_group_id, req.user.companyId]);
        if (!sg) throw new ValidationError(`Invalid or inactive stock_group_id: ${req.body.stock_group_id}`);
      }
      if (req.body.stock_category_id !== undefined && req.body.stock_category_id !== null && req.body.stock_category_id !== '') {
        const sc = this.conn.get("SELECT id FROM stock_categories WHERE id = ? AND company_id = ? AND (is_active = 1 OR is_active IS NULL)", [req.body.stock_category_id, req.user.companyId]);
        if (!sc) throw new ValidationError(`Invalid or inactive stock_category_id: ${req.body.stock_category_id}`);
      }
      if (req.body.brand_id !== undefined && req.body.brand_id !== null && req.body.brand_id !== '') {
        const b = this.conn.get("SELECT id FROM brands WHERE id = ? AND company_id = ? AND (is_active = 1 OR is_active IS NULL)", [req.body.brand_id, req.user.companyId]);
        if (!b) throw new ValidationError(`Invalid or inactive brand_id: ${req.body.brand_id}`);
      }
      if (req.body.model_id !== undefined && req.body.model_id !== null && req.body.model_id !== '') {
        const m = this.conn.get("SELECT id FROM models WHERE id = ? AND company_id = ? AND (is_active = 1 OR is_active IS NULL)", [req.body.model_id, req.user.companyId]);
        if (!m) throw new ValidationError(`Invalid or inactive model_id: ${req.body.model_id}`);
      }

      if (req.body.name !== undefined) { stockItemUpdate.push('name = ?'); stockItemParams.push(req.body.name); }
      if (req.body.sku !== undefined) { stockItemUpdate.push('sku = ?'); stockItemParams.push(req.body.sku); }
      if (req.body.price !== undefined) { stockItemUpdate.push('selling_rate = ?'); stockItemParams.push(req.body.price); }
      if (req.body.cost !== undefined) { stockItemUpdate.push('cost_price = ?'); stockItemParams.push(req.body.cost); }
      if (req.body.is_active !== undefined || req.body.status !== undefined) {
        const activeVal = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : (String(req.body.status).toLowerCase() === 'active' ? 1 : 0);
        stockItemUpdate.push('is_active = ?'); stockItemParams.push(activeVal);
      }

      // Update hierarchy fields on stock_items
      // Inventory location hierarchy — update location/godown even without groups
      const updateLocationGodown = (locId !== undefined && locId !== null && locId !== '') ||
        (godownId !== undefined && godownId !== null && godownId !== '');
      if (updateLocationGodown || (locId !== undefined && locId !== null && locId !== '')) {
        if (req.body.location_id !== undefined) { stockItemUpdate.push('location_id = ?'); stockItemParams.push(locId || null); }
        if (req.body.godown_id !== undefined) { stockItemUpdate.push('godown_id = ?'); stockItemParams.push(godownId || null); }
        if (req.body.inventory_group_id !== undefined) { stockItemUpdate.push('inventory_group_id = ?'); stockItemParams.push(invGroupId || null); }
        if (req.body.item_group_id !== undefined) { stockItemUpdate.push('item_group_id = ?'); stockItemParams.push(itemGroupId || null); }
      }
      // Product hierarchy (model → brand → stock_category → stock_group)
      if (req.body.brand_id !== undefined && req.body.brand_id !== null) {
        stockItemUpdate.push('brand_id = ?'); stockItemParams.push(req.body.brand_id);
      }
      if (req.body.model_id !== undefined && req.body.model_id !== null) {
        stockItemUpdate.push('model_id = ?'); stockItemParams.push(req.body.model_id);
      }

      if (stockItemUpdate.length > 0) {
        stockItemParams.push(new Date().toISOString(), req.params.id, req.user.companyId);
        this.conn.run(`UPDATE stock_items SET ${stockItemUpdate.join(', ')}, updated_at = ? WHERE product_id = ? AND company_id = ?`, stockItemParams);
      }

      // Fetch fresh inventory data
      const stockItem = this.conn.get('SELECT * FROM stock_items WHERE product_id = ? AND company_id = ? LIMIT 1', [product.id, req.user.companyId]);
      const stockBalance = stockItem ? this.conn.get('SELECT * FROM stock_balances WHERE item_id = ? AND company_id = ? AND batch_id IS NULL LIMIT 1', [stockItem.id, req.user.companyId]) : null;
      
      // Fetch hierarchy names
      let modelName = null, brandName = null, stockCategoryName = null, stockGroupName = null;
      const modelId = product.model_id || stockItem?.model_id;
      if (modelId) {
        const modelRow = this.conn.get(
          `SELECT m.name as model_name, b.name as brand_name, sc.name as stock_category_name, sg.name as stock_group_name
           FROM models m
           LEFT JOIN brands b ON b.id = m.brand_id AND b.company_id = m.company_id
           LEFT JOIN stock_categories sc ON sc.id = m.stock_category_id AND sc.company_id = m.company_id
           LEFT JOIN stock_groups sg ON sg.id = sc.stock_group_id AND sg.company_id = sc.company_id
           WHERE m.id = ? AND m.company_id = ?`,
          [modelId, req.user.companyId]
        );
        if (modelRow) {
          modelName = modelRow.model_name;
          brandName = modelRow.brand_name;
          stockCategoryName = modelRow.stock_category_name;
          stockGroupName = modelRow.stock_group_name;
        }
      }
      
      // Write audit log for product update
      logAudit(this.conn, req.user.companyId, req.user?.userId, 'PRODUCT_UPDATED', req.params.id, null, {
        name: product.name, sku: product.sku, price: product.price, cost: product.cost
      });
      
      res.json(successResponse({
        ...product,
        stock_item_id: stockItem?.id || null,
        modelName, brandName, stockCategoryName, stockGroupName,
        stockItem: stockItem ? { ...stockItem, on_hand_qty: stockBalance?.quantity || 0, avg_rate: stockBalance?.avg_rate || 0, stock_value: (stockBalance?.quantity || 0) * (stockBalance?.avg_rate || 0) } : null
      }));
    } catch (err) { next(err); }
  }

  async remove(req, res, next) {
    try {
      const result = this.conn.run('DELETE FROM products WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (result.changes === 0) throw new NotFoundError('Product', req.params.id);
      res.json(successResponse({ id: req.params.id, deleted: true }));
    } catch (err) { next(err); }
  }
}

module.exports = { ProductsController };