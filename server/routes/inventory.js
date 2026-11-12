const express = require('express');
const { InventoryController } = require('../controllers/inventory.controller');
const { requirePermission } = require('../middleware/rbac');
const { authMiddleware } = require('../middleware/auth');

/**
 * Inventory Management Routes
 *
 * All routes are protected by RBAC middleware using:
 *   inventory.view, inventory.create, inventory.edit,
 *   inventory.delete, inventory.post, inventory.cancel
 *
 * Routes follow REST conventions.
 * All operations are tenant-scoped (companyId from authenticated context).
 */
const router = express.Router();
const controller = InventoryController;

// ─── MASTER DATA CRUD ──────────────────────────────────────────────

// List all records for a master table OR create
// GET /api/inventory/masters/:table  — list
// POST /api/inventory/masters/:table — create
router.get('/masters/:table', authMiddleware, requirePermission('inventory.view'), controller.listMasters.bind(controller));
router.get('/masters/:table/:id', authMiddleware, requirePermission('inventory.view'), controller.getMaster.bind(controller));
router.post('/masters/:table', authMiddleware, requirePermission('inventory.create'), controller.createMaster.bind(controller));
router.put('/masters/:table/:id', authMiddleware, requirePermission('inventory.edit'), controller.updateMaster.bind(controller));
router.delete('/masters/:table/:id', authMiddleware, requirePermission('inventory.delete'), controller.deleteMaster.bind(controller));

// ─── MODEL HIERARCHY ─────────────────────────────────────────────────
// GET /api/inventory/models/:id/hierarchy
// Resolves complete hierarchy (Stock Group → Stock Category → Brand → Model)
router.get('/models/:id/hierarchy', authMiddleware, requirePermission('inventory.view'), controller.getModelHierarchy.bind(controller));

// GET /api/inventory/brands/:id/hierarchy
// Resolves complete hierarchy (Stock Group → Stock Category → Brand)
router.get('/brands/:id/hierarchy', authMiddleware, requirePermission('inventory.view'), controller.getBrandHierarchy.bind(controller));

// ─── STOCK ITEMS ────────────────────────────────────────────────────

// Create a new stock item
router.post('/stocks', authMiddleware, requirePermission('inventory.create'), controller.createStockItem.bind(controller));

// List all stock items with current balances
router.get('/stocks', authMiddleware, requirePermission('inventory.view'), controller.listStockItems.bind(controller));

// Get item by SKU
router.get('/stocks/sku/:sku', authMiddleware, requirePermission('inventory.view'), controller.getItemBySku.bind(controller));

// Get stock item by product_id
router.get('/stocks/product/:productId', authMiddleware, requirePermission('inventory.view'), controller.getStockItemByProduct.bind(controller));

// Delete a stock item (soft-delete)
router.delete('/stocks/:id', authMiddleware, requirePermission('inventory.delete'), controller.deleteStockItem.bind(controller));

// ─── VOUCHERS ─────────────────────────────────────────────────────

// Create draft voucher
router.post('/vouchers', authMiddleware, requirePermission('inventory.create'), controller.createVoucher.bind(controller));

// Get voucher with lines
router.get('/vouchers/:voucherNumber', authMiddleware, requirePermission('inventory.view'), controller.getVoucher.bind(controller));

// List vouchers (for transaction listing)
router.get('/vouchers', authMiddleware, requirePermission('inventory.view'), controller.listVouchers.bind(controller));

// Post a draft voucher (creates stock ledger + accounting entries)
router.post('/vouchers/:voucherNumber/post', authMiddleware, requirePermission('inventory.post'), controller.postVoucher.bind(controller));

// Cancel a posted voucher (creates reversal entries)
router.post('/vouchers/:voucherNumber/cancel', authMiddleware, requirePermission('inventory.cancel'), controller.cancelVoucher.bind(controller));

// ─── PHYSICAL STOCK ────────────────────────────────────────────────

// Create physical stock document
router.post('/physical-stock', authMiddleware, requirePermission('inventory.create'), controller.createPhysicalStock.bind(controller));

// Verify physical stock (compare to system)
router.post('/physical-stock/:id/verify', authMiddleware, requirePermission('inventory.approve'), controller.verifyPhysicalStock.bind(controller));

// Approve physical stock (generates adjustment voucher)
router.post('/physical-stock/:id/approve', authMiddleware, requirePermission('inventory.approve'), controller.approvePhysicalStock.bind(controller));

// ─── REPORTS ───────────────────────────────────────────────────────

// Valuation report (all items with WAC rates)
router.get('/reports/valuation', authMiddleware, requirePermission('inventory.view'), controller.getValuationReport.bind(controller));

// Batch-wise stock report
router.get('/reports/batch-stock', authMiddleware, requirePermission('inventory.view'), controller.getBatchStockReport.bind(controller));

// Godown-wise stock report
router.get('/reports/godown-stock', authMiddleware, requirePermission('inventory.view'), controller.getGodownStockReport.bind(controller));

// Location-wise stock report
router.get('/reports/location-stock', authMiddleware, requirePermission('inventory.view'), controller.getLocationStockReport.bind(controller));

// Expiry management report
router.get('/reports/expiry', authMiddleware, requirePermission('inventory.view'), controller.getExpiryReport.bind(controller));

// Serial number tracking report
router.get('/reports/serials', authMiddleware, requirePermission('inventory.view'), controller.getSerialReport.bind(controller));

// ─── INVENTORY HIERARCHY ROUTES ──────────────────────────────────────
// Location → Godown → Inventory Group → Item Group

// List all locations (top-level sites)
router.get('/locations', authMiddleware, requirePermission('inventory.view'), controller.listLocations.bind(controller));

// Godowns under a specific location
router.get('/locations/:locationId/godowns', authMiddleware, requirePermission('inventory.view'), controller.listGodownsByLocation.bind(controller));

// Inventory Groups under a specific godown
router.get('/godowns/:godownId/inventory-groups', authMiddleware, requirePermission('inventory.view'), controller.listInventoryGroupsByGodown.bind(controller));

// Item Groups under a specific inventory group
router.get('/inventory-groups/:groupId/item-groups', authMiddleware, requirePermission('inventory.view'), controller.listItemGroupsByParent.bind(controller));

// Full hierarchy tree
router.get('/hierarchy', authMiddleware, requirePermission('inventory.view'), controller.getHierarchy.bind(controller));

// Hierarchy summary counts
router.get('/hierarchy/summary', authMiddleware, requirePermission('inventory.view'), controller.getHierarchySummary.bind(controller));

module.exports = router;
