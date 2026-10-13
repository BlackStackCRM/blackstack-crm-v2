const { InventoryService } = require('../services/inventory.service');
const { ValidationError, NotFoundError } = require('../utils/errors');

/**
 * Inventory Management Controller
 *
 * Exposes endpoints for:
 *   - Master data CRUD (17 master types)
 *   - Voucher management (draft → post → cancel)
 *   - Reports (valuation, batch, godown, location, expiry, serial)
 *   - Physical stock management
 *
 * All operations are tenant-scoped via companyId from the authenticated context.
 */
class InventoryController {
  constructor() {
    this.service = null; // initialized per-request with connection
  }

  /** Resolve the service with a fresh DB connection scoped to the company */
  _getService(req) {
    const companyId = req.user?.companyId || 'default';
    if (!this.service || this.service.companyId !== companyId) {
      const { DatabaseConnection } = require('../database/connection');
      const db = new DatabaseConnection();
      const conn = db.connect();
      this.service = new InventoryService(conn);
      this.service.companyId = companyId;
      this.service._db = db; // keep reference for closing
    }
    return this.service;
  }

  _getCompanyId(req) {
    return req.user?.companyId || 'default';
  }

  _getUserId(req) {
    return req.user?.userId || 'system';
  }

  // ─── MASTER DATA CRUD ──────────────────────────────────────────────

  /** GET /api/inventory/masters/:table */
  listMasters(req, res, next) {
    try {
      const { table } = req.params;
      const service = this._getService(req);
      const options = {
        limit: parseInt(req.query.limit) || 100,
        offset: parseInt(req.query.offset) || 0,
        is_active: req.query.is_active !== undefined
          ? req.query.is_active === 'true'
          : true,
        search: req.query.search || req.query.query,
        query: req.query.search || req.query.query,
        search_field: req.query.search_field || req.query.query_field || 'name',
        location_id: req.query.location_id || req.query.locationId,
        godown_id: req.query.godown_id || req.query.godownId,
      };
      const result = service.listMasters(table, this._getCompanyId(req), options);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/inventory/masters/:table/:id */
  getMaster(req, res, next) {
    try {
      const { table, id } = req.params;
      const service = this._getService(req);
      const record = service.getMaster(table, id, this._getCompanyId(req));
      res.json(record);
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/inventory/masters/:table */
  createMaster(req, res, next) {
    try {
      const { table } = req.params;
      const service = this._getService(req);
      const record = service.createMaster(table, req.body, this._getCompanyId(req), this._getUserId(req));
      res.status(201).json(record);
    } catch (err) {
      next(err);
    }
  }

  /** PUT /api/inventory/masters/:table/:id */
  updateMaster(req, res, next) {
    try {
      const { table, id } = req.params;
      const service = this._getService(req);
      const record = service.updateMaster(table, id, req.body, this._getCompanyId(req), this._getUserId(req));
      res.json(record);
    } catch (err) {
      next(err);
    }
  }

  /** DELETE /api/inventory/masters/:table/:id */
  deleteMaster(req, res, next) {
    try {
      const { table, id } = req.params;
      const service = this._getService(req);
      service.deleteMaster(table, id, this._getCompanyId(req));
      res.json({ success: true, message: 'Master record deleted', id });
    } catch (err) {
      next(err);
    }
  }

  // ─── MODEL HIERARCHY RESOLUTION ─────────────────────────────────────
  // GET /api/inventory/models/:id/hierarchy
  // Resolves the full hierarchy (Stock Group → Stock Category → Brand → Model)
  // from a single Model ID, for the Products page auto-population.
  getModelHierarchy(req, res, next) {
    try {
      const { id } = req.params;
      const service = this._getService(req);
      const record = service.getModelHierarchy(id, this._getCompanyId(req));
      res.json(record);
    } catch (err) { next(err); }
  }

  /**
   * GET /api/inventory/brands/:id/hierarchy
   * Lookup a Brand by ID (independent master data).
   */
  getBrandHierarchy(req, res, next) {
    try {
      const { id } = req.params;
      const service = this._getService(req);
      const record = service.getBrandHierarchy(id, this._getCompanyId(req));
      res.json(record);
    } catch (err) { next(err); }
  }

  // ─── STOCK ITEMS ───────────────────────────────────────────────────

  /** POST /api/inventory/stocks — create a new stock item */
  createStockItem(req, res, next) {
    try {
      const service = this._getService(req);
      const item = service.createStockItem(req.body, this._getCompanyId(req), this._getUserId(req));
      // If product_id is provided, verify it exists
      if (req.body.product_id) {
        const product = service.repo.findOne('products', req.body.product_id, this._getCompanyId(req));
        if (!product) throw new NotFoundError('Product', req.body.product_id);
      }
      // Fetch the product info for the response
      let product = null;
      if (item.product_id) {
        product = service.repo.findOne('products', item.product_id, this._getCompanyId(req));
      }
      res.status(201).json({ success: true, data: { ...item, product: product || null } });
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/inventory/stocks — list all stock items with balances */
  listStockItems(req, res, next) {
    try {
      const service = this._getService(req);
      const result = service.listStockItemsWithBalance(this._getCompanyId(req), {
        query: req.query.search, // map 'search' query param to 'query' option
        limit: parseInt(req.query.limit) || 100,
        offset: parseInt(req.query.offset) || 0,
      });
      // Enrich with product data
      const items = result.items.map(item => {
        const product = item.product_id ? service.repo.findOne('products', item.product_id, this._getCompanyId(req)) : null;
        return { ...item, product: product || null };
      });
      res.json({ items, total: result.total });
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/inventory/stocks/sku/:sku */
  getItemBySku(req, res, next) {
    try {
      const { sku } = req.params;
      const service = this._getService(req);
      const item = service.findItemBySku(this._getCompanyId(req), sku);
      if (!item) {
        return res.status(404).json({ error: 'Stock item not found', sku });
      }
      res.json(item);
    } catch (err) {
      next(err);
    }
  }


  /** GET /api/inventory/stocks/product/:productId */
  getStockItemByProduct(req, res, next) {
    try {
      const { productId } = req.params;
      const service = this._getService(req);
      const item = service.findItemByProduct(this._getCompanyId(req), productId);
      if (!item) {
        return res.status(404).json({ error: 'Stock item not found for product', productId });
      }
      const product = service.repo.findOne('products', productId, this._getCompanyId(req));
      const balances = service.repo.conn.all(
        'SELECT * FROM stock_balances WHERE item_id = ? AND company_id = ?',
        [item.id, this._getCompanyId(req)]
      );
      
      // Build location-aware inventory data from stock balances
      const locations = balances.map(b => {
        const godown = b.godown_id ? service.repo.findOne('godowns', b.godown_id, this._getCompanyId(req)) : null;
        const location = b.location_id ? service.repo.findOne('locations', b.location_id, this._getCompanyId(req)) : null;
        const locationName = godown?.name || location?.name || 'Unknown';
        const onHand = b.quantity || 0;
        const reserved = 0; // No reservations tracked in current system
        const available = onHand - reserved;
        return {
          location: b.godown_id || b.location_id,
          location_name: locationName,
          quantity_on_hand: onHand,
          quantity_available: available,
          reserved: reserved
        };
      });
      
      const totalOnHand = balances.reduce((sum, b) => sum + (b.quantity || 0), 0);
      const balance = balances.find(b => (b.quantity || 0) > 0) || balances[0];
      
      res.json({
        ...item,
        product: product || null,
        on_hand_qty: totalOnHand,
        avg_rate: balance?.avg_rate || 0,
        locations: locations
      });
    } catch (err) { next(err); }
  }

  /** DELETE /api/inventory/stocks/:id — soft-delete a stock item */
  deleteStockItem(req, res, next) {
    try {
      const { id } = req.params;
      const service = this._getService(req);
      service.deleteStockItem(id, this._getCompanyId(req), this._getUserId(req));
      res.json({ success: true, message: 'Stock item deleted', id });
    } catch (err) { next(err); }
  }

  // ─── VOUCHERS ─────────────────────────────────────────────────────
  createVoucher(req, res, next) {
    try {
      const service = this._getService(req);
      const voucher = service.createDraftVoucher(req.body, this._getCompanyId(req), this._getUserId(req));
      res.status(201).json(voucher);
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/inventory/vouchers */
  listVouchers(req, res, next) {
    try {
      const service = this._getService(req);
      const options = {
        limit: parseInt(req.query.limit) || 100,
        offset: parseInt(req.query.offset) || 0,
        voucher_type: req.query.voucher_type,
        status: req.query.status,
        query: req.query.query,
      };
      const result = service.repo.listVouchers(this._getCompanyId(req), options);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/inventory/vouchers/:voucherNumber */
  getVoucher(req, res, next) {
    try {
      const { voucherNumber } = req.params;
      const service = this._getService(req);
      const voucher = service.repo.getVoucherWithLines(voucherNumber, this._getCompanyId(req));
      if (!voucher) {
        return res.status(404).json({ error: 'Voucher not found', voucher_number: voucherNumber });
      }
      res.json(voucher);
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/inventory/vouchers/:voucherNumber/post */
  postVoucher(req, res, next) {
    try {
      const { voucherNumber } = req.params;
      const service = this._getService(req);
      const result = service.postVoucher(voucherNumber, this._getCompanyId(req), this._getUserId(req));
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/inventory/vouchers/:voucherNumber/cancel */
  cancelVoucher(req, res, next) {
    try {
      const { voucherNumber } = req.params;
      const service = this._getService(req);
      const result = service.cancelVoucher(voucherNumber, this._getCompanyId(req), this._getUserId(req));
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  // ─── PHYSICAL STOCK ────────────────────────────────────────────────

  /** POST /api/inventory/physical-stock */
  createPhysicalStock(req, res, next) {
    try {
      const service = this._getService(req);
      const doc = service.repo.createPhysicalStockDocument(
        { ...req.body, created_by: this._getUserId(req) }, this._getCompanyId(req)
      );
      res.status(201).json(doc);
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/inventory/physical-stock/:id/verify */
  verifyPhysicalStock(req, res, next) {
    try {
      const { id } = req.params;
      const service = this._getService(req);
      const result = service.repo.verifyPhysicalStock(id, this._getCompanyId(req), this._getUserId(req));
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/inventory/physical-stock/:id/approve */
  approvePhysicalStock(req, res, next) {
    try {
      const { id } = req.params;
      const service = this._getService(req);
      const result = service.approvePhysicalStock(id, this._getCompanyId(req), this._getUserId(req));
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  // ─── REPORTS ───────────────────────────────────────────────────────

  /** GET /api/inventory/reports/valuation */
  getValuationReport(req, res, next) {
    try {
      const service = this._getService(req);
      const result = service.getValuationReport(this._getCompanyId(req), {
        limit: parseInt(req.query.limit) || 100,
        offset: parseInt(req.query.offset) || 0,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/inventory/reports/batch-stock */
  getBatchStockReport(req, res, next) {
    try {
      const service = this._getService(req);
      const result = service.getBatchStockReport(this._getCompanyId(req));
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/inventory/reports/godown-stock */
  getGodownStockReport(req, res, next) {
    try {
      const service = this._getService(req);
      const result = service.getGodownStockReport(this._getCompanyId(req));
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/inventory/reports/location-stock */
  getLocationStockReport(req, res, next) {
    try {
      const service = this._getService(req);
      const result = service.getLocationStockReport(this._getCompanyId(req));
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/inventory/reports/expiry */
  getExpiryReport(req, res, next) {
    try {
      const service = this._getService(req);
      const result = service.getExpiryReport(
        this._getCompanyId(req), parseInt(req.query.days) || 90
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/inventory/reports/serials */
  getSerialReport(req, res, next) {
    try {
      const service = this._getService(req);
      const result = service.getSerialReport(this._getCompanyId(req), {
        item_id: req.query.item_id,
        status: req.query.status,
        limit: parseInt(req.query.limit) || 100,
        offset: parseInt(req.query.offset) || 0,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  // ─── INVENTORY HIERARCHY ENDPOINTS ───────────────────────────────────

  /** GET /api/inventory/locations */
  listLocations(req, res, next) {
    try {
      const service = this._getService(req);
      const result = service.repo.listLocations(this._getCompanyId(req), {
        limit: parseInt(req.query.limit) || 100,
        offset: parseInt(req.query.offset) || 0,
        is_active: req.query.is_active !== undefined ? req.query.is_active === "true" : true,
        query: req.query.search || req.query.query,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/inventory/locations/:locationId/godowns */
  listGodownsByLocation(req, res, next) {
    try {
      const { locationId } = req.params;
      const service = this._getService(req);
      const result = service.repo.listGodownsByLocation(this._getCompanyId(req), locationId, {
        query: req.query.search || req.query.query,
        limit: parseInt(req.query.limit) || 100,
        offset: parseInt(req.query.offset) || 0,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/inventory/godowns/:godownId/inventory-groups */
  listInventoryGroupsByGodown(req, res, next) {
    try {
      const { godownId } = req.params;
      const service = this._getService(req);
      const result = service.repo.listInventoryGroupsByGodown(this._getCompanyId(req), godownId, {
        query: req.query.search || req.query.query,
        limit: parseInt(req.query.limit) || 100,
        offset: parseInt(req.query.offset) || 0,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/inventory/inventory-groups/:groupId/item-groups */
  listItemGroupsByParent(req, res, next) {
    try {
      const { groupId } = req.params;
      const service = this._getService(req);
      const result = service.repo.listItemGroupsByParent(this._getCompanyId(req), groupId, {
        query: req.query.search || req.query.query,
        limit: parseInt(req.query.limit) || 100,
        offset: parseInt(req.query.offset) || 0,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/inventory/hierarchy — full nested tree */
  getHierarchy(req, res, next) {
    try {
      const service = this._getService(req);
      const result = service.repo.getLocationHierarchy(this._getCompanyId(req));
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/inventory/hierarchy/summary — counts for dashboard */
  getHierarchySummary(req, res, next) {
    try {
      const service = this._getService(req);
      const result = service.repo.getHierarchySummary(this._getCompanyId(req));
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = { InventoryController: new InventoryController() };
