const { generateId } = require('../utils/generateId');
const { ValidationError, NotFoundError, AppError } = require('../utils/errors');
const CodeGenerator = require('../services/code-generator.service');
const { Authorizer } = require('../auth/authorizer');
const { AccountingEngine } = require('../services/accounting-engine.service');
const { InventoryValidator } = require('../validators/inventory.validator');

/**
 * Inventory Management Service Layer
 *
 * Implements the core architecture:
 *   Master Data → Voucher Header → Voucher Lines →
 *   Stock Ledger (immutable) → Stock Balances (rebuildable) → Valuation →
 *   Accounting Journal
 *
 * All posting operations are atomic via database transactions.
 * Uses the existing AccountingEngine for journal creation.
 */
class InventoryService {
  constructor(conn) {
    this.conn = conn;
    const { InventoryRepository } = require('../repositories/inventory.repository');
    this.repo = new InventoryRepository(conn);
    this.validator = new InventoryValidator(conn);
    this.accounting = new AccountingEngine(conn);
    // Canonical inventory engine: owns balance rebuilds, the moving
    // weighted-average valuation, ledger writes and serial/batch state.
    // Everything here delegates to it so there is one authority, not several.
    const { InventoryEngine } = require('./inventory-engine.service');
    this.engine = new InventoryEngine(conn);
  }

  // ─── Voucher Number Generation (atomic) ───────────────────────────

  /**
   * Generate an inventory voucher number using the centralized number_sequences
   * table, scoped per company + voucher type + year.
   * Format: INV/{TYPE_ABBR}/{YYYY}/{SEQ}
   * e.g., INV/INWD/2026/00001
   */
  generateVoucherNumber(companyId, voucherType) {
    const abbrev = CodeGenerator.voucherTypeAbbrev(voucherType);
    return CodeGenerator.generate(this.conn, 'INVENTORY_VOUCHER', companyId, abbrev);
  }

  // ─── Master CRUD (delegates to repository) ─────────────────────────

  listMasters(table, companyId, options = {}) {
    if (table === 'stock_categories') {
      // Join with stock_groups to include the parent group name
      const result = this.repo.listWithJoin(table, companyId, options);
      return result;
    }
    if (table === 'models') {
      // Join with stock_categories (→ stock_groups) to include parent category name
      const result = this.repo.listModels(companyId, options);
      return result;
    }
    if (table === 'godowns') {
      // Join with locations to include the parent location name
      const result = this.repo.listGodowns(companyId, options);
      return result;
    }
    return this.repo.list(table, companyId, options);
  }

  getMaster(table, id, companyId) {
    let record;
    if (table === 'models') {
      record = this.repo.findModelWithJoin(table, id, companyId);
    } else if (table === 'godowns') {
      record = this.repo.findGodownWithJoin(id, companyId);
    } else {
      record = this.repo.findOne(table, id, companyId);
    }
    if (!record) throw new NotFoundError('Record', id);
    return record;
  }

  createMaster(table, data, companyId, userId) {
    data.created_by = userId;
    data.updated_by = userId;
    // Ensure required fields have defaults for tables with NOT NULL constraints
    if (table === 'price_levels' && !data.level_type) {
      data.level_type = 'percentage';
      if (data.markup_value === undefined) data.markup_value = 0;
    }
    // Stock categories require a stock_group_id (parent hierarchy)
    if (table === 'stock_categories' && !data.stock_group_id) {
      throw new ValidationError('stock_group_id is required — every Stock Category must belong to a Stock Group');
    }
    // Models require a brand_id (parent hierarchy: Brand → Model)
    // stock_category_id is optional — Brand is the parent, Stock Category is not required
    if (table === 'models' && !data.brand_id) {
      throw new ValidationError('brand_id is required — every Model must belong to a Brand');
    }
    // Godowns require a location_id (Location → Godowns relationship)
    if (table === 'godowns' && !data.location_id) {
      throw new ValidationError('location_id is required — every Godown must belong to a Location');
    }
    if (table === 'locations') {
      return this.repo.createLocation(data, companyId);
    }
    return this.repo.create(table, data, companyId);
  }

  updateMaster(table, id, data, companyId, userId) {
    data.updated_by = userId;
    return this.repo.update(table, id, data, companyId);
  }

  /** Permanent delete a master (physical DELETE — no soft-delete) */
  deleteMaster(table, id, companyId) {
    this.validator.validateMasterNotReferenced(table, id, companyId);
    return this.repo.softDelete(table, id, companyId);
  }

  /**
   * Resolve the complete product hierarchy from a Model ID.
   * Model → Brand → Stock Category → Stock Group
   *
   * Used by the Products page to auto-populate the full hierarchy
   * when the user selects only a Model.
   *
   * @param {string} modelId - The Model ID
   * @param {string} companyId
   * @returns {object} { id, name, brandId, brandName, stockCategoryId,
   *   stockCategoryName, stockGroupId, stockGroupName } or null if model not found
   */
  getModelHierarchy(modelId, companyId) {
    const row = this.repo.getModelHierarchy(modelId, companyId);
    if (!row) throw new NotFoundError('Model', modelId);

    // Check that the model has a complete hierarchy
    const hasBrand = row.brand_id && row.brand_name;
    const hasCategory = row.stock_category_id && row.stock_category_name;
    const hasGroup = row.stock_group_id && row.stock_group_name;

    if (!hasBrand || !hasCategory || !hasGroup) {
      // Return partial info so the UI can show a helpful error
      return {
        id: row.id,
        name: row.model_name,
        brandId: row.brand_id,
        brandName: row.brand_name,
        stockCategoryId: row.stock_category_id,
        stockCategoryName: row.stock_category_name,
        stockGroupId: row.stock_group_id,
        stockGroupName: row.stock_group_name,
        hasCompleteHierarchy: hasBrand && hasCategory && hasGroup,
      };
    }

    return {
      id: row.id,
      name: row.model_name,
      brandId: row.brand_id,
      brandName: row.brand_name,
      stockCategoryId: row.stock_category_id,
      stockCategoryName: row.stock_category_name,
      stockGroupId: row.stock_group_id,
      stockGroupName: row.stock_group_name,
      hasCompleteHierarchy: true,
    };
  }

  /**
   * Lookup a Brand by ID (independent master data).
   * Brand no longer has a direct Stock Category relationship.
   *
   * @param {string} brandId - The Brand ID
   * @param {string} companyId
   * @returns {object} { id, name, description, hasCompleteHierarchy } or throws NotFoundError
   * @throws {NotFoundError} if brand does not exist
   */
  getBrandHierarchy(brandId, companyId) {
    const row = this.repo.getBrandHierarchy(brandId, companyId);
    if (!row) throw new NotFoundError('Brand', brandId);

    return {
      id: row.id,
      name: row.brand_name,
      description: row.description,
      hasCompleteHierarchy: true,  // Brand is now independent, so it's always "complete"
    };
  }

  findItemBySku(companyId, sku) {
    return this.repo.findItemBySku(companyId, sku);
  }

  findItemByProduct(companyId, productId) {
    return this.repo.findItemByProduct(companyId, productId);
  }

  listStockItemsWithBalance(companyId, options = {}) {
    return this.repo.listStockItemsWithBalance(companyId, options);
  }

  /** Create a new stock item (SKU) */
  createStockItem(data, companyId, userId) {
    Authorizer.assertPermission({ userId, companyId, permissions: this._permissions(userId, companyId) }, 'inventory.create');
    // If no product_id provided, auto-create a product record and link it
    const { generateId } = require('../utils/generateId');
    if (!data.product_id) {
      const now = new Date().toISOString();
      const productId = generateId('prod');
      // Check for an existing stock_item with the same name for this company (UNIQUE(company_id, name))
      const existingByName = this.conn.get(
        'SELECT id FROM stock_items WHERE company_id = ? AND name = ? LIMIT 1',
        [companyId, data.name]
      );
      if (existingByName) {
        throw new ValidationError(`A stock item with name "${data.name}" already exists for this company. Link the existing stock item or use a different name.`);
      }
      // is_inventory_managed is a CACHE of "this product has an active stock_items
        // row" (migration 080). The auto-created product is being linked to a stock
        // item RIGHT NOW, so the flag must be 1 in the same INSERT.
        //
        // Omitting it left the column at its default 0, which migration 083 can
        // repair for existing rows but never for products created afterwards,
        // because migrations run once. That produced a genuine inconsistency:
        //   - the backend ignored the flag (resolveEntries -> findStockItemByProduct
        //     decides from the real stock_items row), so stock still moved;
        //   - the FRONTEND trusts it (customer-bills.js:3840 `if (!l ||
        //     l.is_inventory_managed) return '';`), so the Bill form HIDES the
        //     godown/batch/serial inputs and the post is then rejected with
        //     "no godown specified".
        // Setting it here keeps the cache truthful at write time rather than
        // depending on a one-shot backfill.
        this.conn.run(
          `INSERT INTO products (id, company_id, name, description, category, sku, price, cost, tax_rate, is_service, is_active, is_inventory_managed, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [productId, companyId, data.name, data.description || null, data.category_id ? null : null, data.sku, data.selling_rate || data.cost_price || 0, data.cost_price || 0, 0, 0, data.is_active !== undefined ? data.is_active : 1, 1, now, now]
        );
      data.product_id = productId;
    }
    return this.repo.create('stock_items', data, companyId);
  }

  /** Permanent delete a stock item (physical DELETE — no soft-delete) */
  deleteStockItem(id, companyId, userId) {
    Authorizer.assertPermission({ userId, companyId, permissions: this._permissions(userId, companyId) }, 'inventory.delete');
    // Check if any posted vouchers reference this item
    const refCheck = this.conn.get(
      'SELECT 1 FROM inventory_voucher_headers WHERE status = ? AND company_id = ? AND id IN (SELECT header_id FROM inventory_voucher_lines WHERE item_id = ? AND company_id = ?) LIMIT 1',
      ['posted', companyId, id, companyId]
    );
    if (refCheck) {
      throw new ValidationError('Cannot delete a stock item that is referenced by posted inventory vouchers. Deactivate it instead.');
    }
    return this.repo.softDelete('stock_items', id, companyId);
  }

  // ─── Voucher Creation + Posting (atomic) ────────────────────────────

  /**
   * Create a draft voucher (header + lines). Does NOT affect stock or accounting.
   */
  createDraftVoucher(payload, companyId, userId) {
    Authorizer.assertPermission({ userId, companyId, permissions: this._permissions(userId, companyId) }, 'inventory.create');

    payload = { ...payload, is_draft: true };
    this.validator.validateVoucher(payload, companyId);

    const voucherNumber = this.generateVoucherNumber(companyId, payload.voucher_type);
    const now = new Date().toISOString();

    return this.conn.transaction(() => {
      const header = this.repo.createVoucherHeader({
        voucher_type: payload.voucher_type,
        voucher_number: voucherNumber,
        voucher_date: payload.voucher_date,
        reference_id: payload.reference_id,
        narration: payload.narration,
        source_type: payload.source_type,
        status: 'draft',
        approved_by: null,
        approved_on: null,
        accounting_journal_id: null,
        created_by: userId,
        updated_by: userId,
      }, companyId);

      const lines = payload.lines.map((line, idx) => ({
        header_id: header.id,
        line_number: idx + 1,
        item_id: line.item_id,
        batch_id: line.batch_id || null,
        serial_number: line.serial_number || null,
        uom_id: line.uom_id,
        quantity: line.quantity,
        unit_rate: line.unit_rate || 0,
        amount: parseFloat(line.quantity) * parseFloat(line.unit_rate || 0),
        source_godown_id: line.source_godown_id || null,
        source_location_id: line.source_location_id || null,
        dest_godown_id: line.dest_godown_id || null,
        dest_location_id: line.dest_location_id || null,
        is_source: line.is_source !== undefined ? line.is_source : (['opening_stock', 'stock_inward'].includes(payload.voucher_type) ? 0 : 1),
        adjustment_reason_id: line.adjustment_reason_id || null,
      }));

      for (const line of lines) {
        this.repo.createVoucherLine(line, companyId);
      }

      return this.repo.getVoucherWithLines(voucherNumber, companyId);
    })();
  }

  /**
   * Post a draft voucher to the stock ledger + accounting.
   * This is the PRIMARY atomic operation. If any step fails, everything rolls back.
   */
  postVoucher(voucherNumber, companyId, userId) {
    Authorizer.assertPermission({ userId, companyId, permissions: this._permissions(userId, companyId) }, 'inventory.post');

    const voucher = this.repo.getVoucherWithLines(voucherNumber, companyId);
    if (!voucher) throw new NotFoundError('Voucher', voucherNumber);
    if (voucher.status === 'posted') throw new ValidationError('Voucher is already posted');
    if (voucher.status === 'cancelled') throw new ValidationError('Cannot post a cancelled voucher');

    // Re-validate on post (in case draft was edited)
    this.validator.validateVoucher({
      voucher_type: voucher.voucher_type,
      voucher_date: voucher.voucher_date,
      lines: voucher.lines,
      source_type: voucher.source_type,
    }, companyId);

    return this.conn.transaction(() => {
      // 1. Generate stock ledger movements from voucher lines
      const ledgerEntries = this._generateLedgerMovements(voucher, companyId);

      for (const entry of ledgerEntries) {
        this._insertStockLedger(entry, companyId, {
          sourceDocumentType: voucher.source_document_type || null,
          sourceDocumentId: voucher.source_document_id || null,
          userId,
        });
      }

      // 2. Process serial lifecycle updates
      this._processSerialLifecycle(voucher, companyId);

      // 3. Apply valuation per affected item using the canonical moving
      //    weighted average. Sign is taken from the ledger movement, so an
      //    inward credits cost and an outward releases it at the same rate.
      const affectedItems = [...new Set(ledgerEntries.map((e) => e.item_id))];
      const valuationResults = {};
      for (const itemId of affectedItems) {
        const itemLedger = ledgerEntries.filter((e) => e.item_id === itemId);
        let qty = 0;
        let value = 0;
        for (const e of itemLedger) {
          qty += parseFloat(e.quantity) || 0;
          value += (parseFloat(e.quantity) || 0) * (parseFloat(e.unit_rate) || 0);
        }
        if (qty === 0) continue;
        const avgRate = value / qty;
        const netDirection = qty > 0 ? 1 : -1;
        const result = this.engine.applyValuation(
          companyId,
          itemId,
          netDirection,
          Math.abs(qty),
          avgRate,
          {
            sourceDocumentType: voucher.source_document_type || voucher.voucher_type,
            sourceDocumentId: voucher.source_document_id || voucher.id,
            userId,
          });
        if (result) valuationResults[itemId] = result;
      }

      // 4. Rebuild balances ONLY for the items this voucher touched. The old
      //    code wiped and recomputed the entire company on every post.
      for (const itemId of affectedItems) {
        this.engine.rebuildBalances(companyId, { itemId });
      }

      // 5. Create accounting journal (if applicable)
      let journalEntryId = null;
      const journalLines = this._buildAccountingLines(voucher, companyId, valuationResults);
      if (journalLines && journalLines.length > 0) {
        const journalResult = this.accounting.postVoucher({
          voucher_type: 'JOURNAL',
          voucher_date: voucher.voucher_date,
          description: `Inventory: ${voucher.voucher_number} - ${voucher.narration || ''}`,
          reference_number: voucher.voucher_number,
          currency: 'INR',
          exchange_rate: 1.0,
          lines: journalLines,
        }, {
          userId,
          companyId,
          permissions: this._permissions(userId, companyId),
        });
        journalEntryId = journalResult.entryId;
      }

      // 6. Mark voucher as POSTED, link accounting journal
      this.conn.run(
        `UPDATE inventory_voucher_headers
         SET status = ?, accounting_journal_id = ?, approved_by = ?, approved_on = ?, updated_by = ?, updated_at = ?
         WHERE id = ? AND company_id = ?`,
        ['posted', journalEntryId, userId, new Date().toISOString(), userId, new Date().toISOString(),
         voucher.id, companyId]
      );

      return {
        voucher_number: voucher.voucher_number,
        status: 'posted',
        ledger_entries: ledgerEntries.length,
        journal_entry_id: journalEntryId,
        valuation: valuationResults,
      };
    })();
  }

  /**
   * Generate stock_ledger movements from voucher lines.
   * For transfers: one negative (source) + one positive (destination) entry.
   * For other types: sign determined by is_source flag.
   */
  _generateLedgerMovements(voucher, companyId) {
    const entries = [];

    for (const line of voucher.lines) {
      const qty = parseFloat(line.quantity);
      const rate = parseFloat(line.unit_rate || 0);
      const amount = qty * rate;

      if (voucher.voucher_type === 'stock_transfer') {
        // Two entries: source (negative) + destination (positive)
        // Source side
        entries.push({
          voucher_type: voucher.voucher_type,
          voucher_number: voucher.voucher_number,
          header_id: voucher.id,
          line_number: line.line_number,
          voucher_date: voucher.voucher_date,
          item_id: line.item_id,
          batch_id: line.batch_id || null,
          serial_number: line.serial_number || null,
          godown_id: line.source_godown_id || null,
          location_id: line.source_location_id || null,
          quantity: -qty, // negative for source
          unit_rate: rate,
          amount: -amount,
          reference_id: voucher.reference_id,
          narration: `Transfer out: ${voucher.narration || ''}`,
        });
        // Destination side
        entries.push({
          voucher_type: voucher.voucher_type,
          voucher_number: voucher.voucher_number,
          header_id: voucher.id,
          line_number: line.line_number,
          voucher_date: voucher.voucher_date,
          item_id: line.item_id,
          batch_id: line.batch_id || null,
          serial_number: line.serial_number || null,
          godown_id: line.dest_godown_id || null,
          location_id: line.dest_location_id || null,
          quantity: qty, // positive for destination
          unit_rate: rate,
          amount: amount,
          reference_id: voucher.reference_id,
          narration: `Transfer in: ${voucher.narration || ''}`,
        });
      } else {
        // Standard: is_source=1 → negative, is_source=0 → positive
        const signedQty = (line.is_source === 1) ? -qty : qty;
        const signedAmount = signedQty * rate;
        entries.push({
          voucher_type: voucher.voucher_type,
          voucher_number: voucher.voucher_number,
          header_id: voucher.id,
          line_number: line.line_number,
          voucher_date: voucher.voucher_date,
          item_id: line.item_id,
          batch_id: line.batch_id || null,
          serial_number: line.serial_number || null,
          godown_id: line.source_godown_id || line.dest_godown_id || null,
          location_id: line.source_location_id || line.dest_location_id || null,
          quantity: signedQty,
          unit_rate: rate,
          amount: signedAmount,
          reference_id: voucher.reference_id,
          narration: voucher.narration || '',
        });
      }
    }

    return entries;
  }

  /**
   * Append one immutable stock_ledger row via the canonical engine, so source
   * document, actor and posting time are recorded consistently no matter which
   * entry point created the movement.
   */
  _insertStockLedger(entry, companyId, { sourceDocumentType = null, sourceDocumentId = null, userId = null } = {}) {
    return this.engine.postLedgerMovement({
      companyId,
      voucherType: entry.voucher_type,
      voucherNumber: entry.voucher_number,
      headerId: entry.header_id,
      lineNumber: entry.line_number,
      voucherDate: entry.voucher_date,
      itemId: entry.item_id,
      batchId: entry.batch_id,
      serialNumber: entry.serial_number,
      godownId: entry.godown_id,
      locationId: entry.location_id,
      quantity: entry.quantity,
      unitRate: entry.unit_rate,
      referenceId: entry.reference_id,
      narration: entry.narration,
      sourceDocumentType,
      sourceDocumentId,
      userId,
    });
  }

  // ─── Serial Lifecycle Processing ────────────────────────────────────

  /**
   * Update serial number statuses based on voucher type:
   *  - Inward: in_transit → available (or creates new serials)
   *  - Outward: available → sold/damaged/expired (depends on source_type)
   *  - Transfer: move godown/location, status stays available
   */
  _processSerialLifecycle(voucher, companyId) {
    const vt = voucher.voucher_type;

    for (const line of voucher.lines) {
      if (!line.serial_number) continue;

      if (vt === 'stock_inward' || vt === 'opening_stock') {
        // Create or update serial to available/in_transit
        const existing = this.conn.get(
          'SELECT id FROM item_serials WHERE company_id = ? AND serial_number = ? LIMIT 1',
          [companyId, line.serial_number]
        );
        if (existing) {
          // Already exists — update location/status
          this.conn.run(
            `UPDATE item_serials
             SET godown_id = ?, location_id = ?, status = 'available', updated_at = ?
             WHERE id = ? AND company_id = ?`,
            [line.source_godown_id || line.dest_godown_id,
             line.source_location_id || line.dest_location_id,
             new Date().toISOString(), existing.id, companyId]
          );
        } else {
          const serialId = generateId('ser');
          this.conn.run(
            `INSERT INTO item_serials
             (id, company_id, item_id, batch_id, serial_number, godown_id, location_id,
              status, purchase_date, purchase_rate, mfg_date, expiry_date, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?, ?, ?, ?)`,
            [serialId, companyId, line.item_id, line.batch_id || null,
             line.serial_number, line.source_godown_id || line.dest_godown_id || null,
             line.source_location_id || line.dest_location_id,
             voucher.voucher_date, line.unit_rate, line.batch_id ? null : null,
             null, new Date().toISOString(), new Date().toISOString()]
          );
          // Fill mfg/expiry from batch if available
          if (line.batch_id) {
            const batch = this.conn.get(
              'SELECT manufacturing_date, expiry_date FROM batches WHERE id = ? AND company_id = ? LIMIT 1',
              [line.batch_id, companyId]
            );
            if (batch) {
              this.conn.run(
                'UPDATE item_serials SET mfg_date = ?, expiry_date = ? WHERE id = ?',
                [batch.manufacturing_date, batch.expiry_date, serialId]
              );
            }
          }
        }
      } else if (vt === 'stock_outward') {
        // Determine terminal status based on source_type
        let terminalStatus = 'sold';
        switch (voucher.source_type) {
          case 'damage': terminalStatus = 'damaged'; break;
          case 'expiry': terminalStatus = 'expired'; break;
          case 'returned': terminalStatus = 'returned'; break;
          case 'scrapped': terminalStatus = 'scrapped'; break;
          default: terminalStatus = 'sold';
        }
        this.conn.run(
          `UPDATE item_serials
           SET godown_id = ?, location_id = ?, status = ?, updated_at = ?
           WHERE serial_number = ? AND company_id = ?`,
          [line.source_godown_id, line.source_location_id, terminalStatus,
           new Date().toISOString(), line.serial_number, companyId]
        );
      } else if (vt === 'stock_transfer') {
        // Move the serial to the destination
        this.conn.run(
          `UPDATE item_serials
           SET godown_id = ?, location_id = ?, status = 'available', updated_at = ?
           WHERE serial_number = ? AND company_id = ?`,
          [line.dest_godown_id, line.dest_location_id,
           new Date().toISOString(), line.serial_number, companyId]
        );
      }
    }
  }

  // ─── Valuation ──────────────────────────────────────────────────────

  /**
   * Compute valuation for an item based on voucher type.
   * Uses Weighted Average costing.
   * For outward/adjustment: returns the cost that was applied.
   * For inward: returns the new average rate.
   */
  _computeValuation(voucherType, companyId, itemId) {
    const wa = this.repo.computeWeightedAverage(companyId, itemId);

    if (['stock_inward', 'opening_stock'].includes(voucherType)) {
      // Incoming increases quantity; avg rate updates
      return {
        method: 'weighted_average',
        quantity: wa.quantity,
        total_value: wa.total_value,
        avg_rate: wa.avg_rate,
      };
    }

    // For outward/adjustment/transfer: we use the existing avg_rate for COGS
    // The avg_rate doesn't change (transfer has no value impact beyond movement)
    return {
      method: 'weighted_average',
      quantity: wa.quantity,
      total_value: wa.total_value,
      avg_rate: wa.avg_rate,
      cost_applied: wa.avg_rate, // rate used for COGS calculation
    };
  }

  /**
   * Company-level fallback accounts for inventory postings.
   *
   * Resolution order per role: a well-known seeded account id, then a lookup by
   * name/type. Returns an object whose values may still be null, which callers
   * must handle (a stock item without an asset account cannot be posted).
   */
  _inventoryAccountFallbacks(companyId) {
    const company = companyId || 'default';
    const byId = (id) => {
      const row = this.conn.get('SELECT id FROM accounts WHERE id = ? AND company_id = ?', [id, company]);
      return row ? row.id : null;
    };
    const byName = (type, patterns) => {
      for (const p of patterns) {
        const row = this.conn.get(
          'SELECT id FROM accounts WHERE company_id = ? AND type = ? AND UPPER(name) LIKE ? LIMIT 1',
          [company, type, `%${p.toUpperCase()}%`]);
        if (row) return row.id;
      }
      return null;
    };

    return {
      asset:     byId('acc_inventory') || byId('acc_cash') || byName('ASSET', ['INVENTORY', 'STOCK', 'CLOSING']),
      cogs:      byId('acc_cogs')      || byName('EXPENSE', ['COGS', 'COST OF GOODS']),
      variance:  byId('acc_purchases') || byName('EXPENSE', ['VARIANCE', 'SHRINKAGE']),
      opening:   byId('acc_capital')   || byName('EQUITY', ['CAPITAL']) || byName('ASSET', ['OPENING']),
      purchase:  byId('acc_purchases') || byName('EXPENSE', ['PURCHASE']),
      sales:     byId('acc_sales')     || byName('INCOME', ['SALES']),
    };
  }

  // ─── Accounting Journal Building ───────────────────────────────────

  /**
   * Build accounting journal lines based on voucher type + source_type.
   * Uses the stock_item's configured accounts.
   * Returns array of { account_id, debit_amount, credit_amount, description, reference_id }
   * or null if no accounting entry is needed (e.g., pure transfer).
   */
  _buildAccountingLines(voucher, companyId, valuationResults) {
    const vt = voucher.voucher_type;
    let lines = [];

    // Company-level fallback accounts, used when a stock item has not mapped the
    // corresponding account itself. Without these, any item created before
    // inventory accounts were configured would emit a journal line with a NULL
    // account_id and the entire stock movement would be rejected.
    const fallback = this._inventoryAccountFallbacks(companyId);

    // Collect all unique items used in this voucher
    const itemIds = [...new Set(voucher.lines.map(l => l.item_id))];
    const items = {};
    for (const iid of itemIds) {
      const item = this.conn.get(
        'SELECT * FROM stock_items WHERE id = ? AND company_id = ? LIMIT 1',
        [iid, companyId]
      );
      if (!item) throw new NotFoundError('Stock Item', iid);
      // Overlay fallbacks so downstream switch statements can rely on
      // item.<role>_account_id always being present.
      items[iid] = {
        ...item,
        stock_asset_account_id:          item.stock_asset_account_id          || fallback.asset,
        cogs_account_id:                item.cogs_account_id                || fallback.cogs,
        inventory_variance_account_id:  item.inventory_variance_account_id  || fallback.variance,
        opening_stock_account_id:       item.opening_stock_account_id       || fallback.opening,
        purchase_account_id:            item.purchase_account_id            || fallback.purchase,
        sales_account_id:               item.sales_account_id               || fallback.sales,
      };
      if (!items[iid].stock_asset_account_id) {
        // Without an inventory asset account no balanced entry can be built for
        // this item; report it rather than writing a broken journal line.
        throw new AppError(
          `Cannot post inventory for "${item.name}": no Inventory Asset account is mapped. `
          + 'Map a stock asset account on the stock item or in the chart of accounts.',
          'MISSING_ACCOUNT', 400);
      }
    }

    for (const line of voucher.lines) {
      const item = items[line.item_id];
      const qty = parseFloat(line.quantity);
      const rate = parseFloat(line.unit_rate || 0);
      const amount = qty * rate;
      const valuation = valuationResults[line.item_id];
      const costRate = valuation?.avg_rate || item.cost_price || 0;
      const costAmount = qty * costRate;
      const adjAmount = parseFloat(line.amount) || costAmount;
      const isSource = line.is_source === 1;

      switch (vt) {
        case 'opening_stock':
          // Dr Stock Asset, Cr Opening Stock Adjustment
          lines.push(
            { account_id: item.stock_asset_account_id, debit_amount: amount, credit_amount: 0,
              description: `Opening stock: ${qty} ${item.name}`, reference_id: voucher.voucher_number },
            { account_id: item.opening_stock_account_id, debit_amount: 0, credit_amount: amount,
              description: `Opening stock credit: ${qty} ${item.name}`, reference_id: voucher.voucher_number }
          );
          break;

        case 'stock_inward':
          // Dr Stock Asset, Cr based on source_type
          lines.push({
            account_id: item.stock_asset_account_id, debit_amount: amount, credit_amount: 0,
            description: `Inward: ${qty} ${item.name} (${voucher.source_type || 'purchase'})`,
            reference_id: voucher.voucher_number
          });
          // Credit side depends on source
          switch (voucher.source_type) {
            case 'purchase':
              lines.push({
                account_id: item.purchase_account_id, debit_amount: 0, credit_amount: amount,
                description: `Purchase: ${qty} ${item.name}`, reference_id: voucher.voucher_number
              });
              break;
            case 'sales_return':
              lines.push({
                account_id: item.sales_account_id, debit_amount: 0, credit_amount: amount,
                description: `Sales return: ${qty} ${item.name}`, reference_id: voucher.voucher_number
              });
              break;
            case 'production':
              // Will need WIP account — use COGS as fallback for now
              lines.push({
                account_id: item.cogs_account_id, debit_amount: 0, credit_amount: amount,
                description: `Production receipt: ${qty} ${item.name}`, reference_id: voucher.voucher_number
              });
              break;
            case 'opening':
              lines.push({
                account_id: item.opening_stock_account_id, debit_amount: 0, credit_amount: amount,
                description: `Opening stock credit: ${qty} ${item.name}`, reference_id: voucher.voucher_number
              });
              break;
            case 'adjustment':
              lines.push({
                account_id: item.inventory_variance_account_id, debit_amount: 0, credit_amount: amount,
                description: `Adjustment inward: ${qty} ${item.name}`, reference_id: voucher.voucher_number
              });
              break;
            default:
              lines.push({
                account_id: item.purchase_account_id, debit_amount: 0, credit_amount: amount,
                description: `Inward (${voucher.source_type || 'purchase'}): ${qty} ${item.name}`, reference_id: voucher.voucher_number
              });
          }
          break;

        case 'stock_outward':
          // Dr COGS, Cr Stock Asset
          lines.push(
            { account_id: item.cogs_account_id, debit_amount: costAmount, credit_amount: 0,
              description: `COGS: ${qty} ${item.name} (${voucher.source_type || 'sale'})`,
              reference_id: voucher.voucher_number },
            { account_id: item.stock_asset_account_id, debit_amount: 0, credit_amount: costAmount,
              description: `Stock issued: ${qty} ${item.name}`, reference_id: voucher.voucher_number }
          );

          // If sale: also record revenue
          if (voucher.source_type === 'sale') {
            const saleAmount = parseFloat(line.amount);
            lines.push({
              account_id: item.sales_account_id, debit_amount: 0, credit_amount: saleAmount,
              description: `Revenue: ${qty} ${item.name}`, reference_id: voucher.voucher_number
            });
            lines.push({
              account_id: item.stock_asset_account_id, debit_amount: saleAmount, credit_amount: 0,
              description: `Sales receivable: ${qty} ${item.name}`, reference_id: voucher.voucher_number
            });
          }
          break;

        case 'stock_transfer':
          // No accounting entry (internal movement)
          break;

        case 'stock_adjustment':
        case 'physical_stock':
          // Dr/Cr Stock Asset, offset to Inventory Variance
          // adjAmount and isSource declared at loop scope
          if (isSource) {
            // Decrease → Dr Variance, Cr Asset
            lines.push(
              { account_id: item.inventory_variance_account_id, debit_amount: adjAmount, credit_amount: 0,
                description: `Adjustment out: ${qty} ${item.name}`, reference_id: voucher.voucher_number },
              { account_id: item.stock_asset_account_id, debit_amount: 0, credit_amount: adjAmount,
                description: `Adjustment asset credit: ${qty} ${item.name}`, reference_id: voucher.voucher_number }
            );
          } else {
            // Increase → Dr Asset, Cr Variance
            lines.push(
              { account_id: item.stock_asset_account_id, debit_amount: adjAmount, credit_amount: 0,
                description: `Adjustment in: ${qty} ${item.name}`, reference_id: voucher.voucher_number },
              { account_id: item.inventory_variance_account_id, debit_amount: 0, credit_amount: adjAmount,
                description: `Adjustment variance credit: ${qty} ${item.name}`, reference_id: voucher.voucher_number }
            );
          }
          break;

        case 'stock_journal':
          // Multi-line: source lines debit variance, dest lines credit variance
          // isSource declared at loop scope
          if (isSource) {
            lines.push(
              { account_id: item.cogs_account_id, debit_amount: costAmount, credit_amount: 0,
                description: `Journal out: ${qty} ${item.name}`, reference_id: voucher.voucher_number },
              { account_id: item.stock_asset_account_id, debit_amount: 0, credit_amount: costAmount,
                description: `Journal asset credit: ${qty} ${item.name}`, reference_id: voucher.voucher_number }
            );
          } else {
            lines.push(
              { account_id: item.stock_asset_account_id, debit_amount: amount, credit_amount: 0,
                description: `Journal in: ${qty} ${item.name}`, reference_id: voucher.voucher_number },
              { account_id: item.cogs_account_id, debit_amount: 0, credit_amount: amount,
                description: `Journal cost credit: ${qty} ${item.name}`, reference_id: voucher.voucher_number }
            );
          }
          break;
      }
    }

    // If we have lines, ensure they balance. If not balanced, remove the
    // accounting integration but keep inventory (non-fatal accounting error)
    // Actually — per spec, accounting MUST be atomic with inventory.
    // If lines don't balance, throw.
    if (lines.length > 0) {
      let totalDr = 0, totalCr = 0;
      for (const l of lines) {
        totalDr += parseFloat(l.debit_amount) || 0;
        totalCr += parseFloat(l.credit_amount) || 0;
      }
      // Tolerance of 0.01 for rounding
      if (Math.abs(totalDr - totalCr) > 0.01) {
        throw new AppError(
          `Accounting entries unbalanced for voucher ${voucher.voucher_number}: ` +
          `Debits ${totalDr.toFixed(2)} != Credits ${totalCr.toFixed(2)}`,
          'ACCOUNTING_UNBALANCED', 500
        );
      }
    }

    return lines.length > 0 ? lines : null;
  }

  // ─── Voucher Cancelation ───────────────────────────────────────────

  /**
   * Cancel a posted voucher. Does NOT delete ledger entries.
   * Creates reversal ledger entries + reversal accounting journal.
   * All atomic.
   */
  cancelVoucher(voucherNumber, companyId, userId) {
    Authorizer.assertPermission({ userId, companyId, permissions: this._permissions(userId, companyId) }, 'inventory.cancel');

    const voucher = this.repo.getVoucherWithLines(voucherNumber, companyId);
    if (!voucher) throw new NotFoundError('Voucher', voucherNumber);
    if (voucher.status !== 'posted') {
      throw new ValidationError('Only posted vouchers can be cancelled');
    }

    return this.conn.transaction(() => {
      // 1. Mark voucher as cancelled
      this.conn.run(
        `UPDATE inventory_voucher_headers
         SET status = 'cancelled', updated_by = ?, updated_at = ?
         WHERE id = ? AND company_id = ?`,
        [userId, new Date().toISOString(), voucher.id, companyId]
      );

      // 2. Create reversal stock_ledger entries (negative of original)
      const reversalNumber = `${voucherNumber}_REVERSAL`;
      const now = new Date().toISOString();

      // Get original ledger entries for this voucher
      const originalEntries = this.conn.all(
        `SELECT * FROM stock_ledger WHERE voucher_number = ? AND company_id = ?`,
        [voucherNumber, companyId]
      );

      const reversedItems = new Set();
      for (const orig of originalEntries) {
        this._insertStockLedger({
          voucher_type: orig.voucher_type,
          voucher_number: reversalNumber,
          header_id: orig.header_id,
          line_number: orig.line_number,
          voucher_date: orig.voucher_date,
          item_id: orig.item_id,
          batch_id: orig.batch_id,
          serial_number: orig.serial_number,
          godown_id: orig.godown_id,
          location_id: orig.location_id,
          quantity: -parseFloat(orig.quantity), // reverse the quantity
          unit_rate: parseFloat(orig.unit_rate),
          amount: -parseFloat(orig.amount),
          reference_id: orig.reference_id,
          narration: `REVERSAL: ${orig.narration || ''}`,
        }, companyId, {
          sourceDocumentType: orig.source_document_type
            ? `${orig.source_document_type}_REVERSAL` : null,
          sourceDocumentId: orig.source_document_id,
          userId,
        });
        reversedItems.add(orig.item_id);
      }

      // 3. Reverse serial lifecycle if applicable
      this._reverseSerialLifecycle(voucher, companyId);

      // 4. Unwind valuation for the reversed items, then rebuild only those
      //    balances instead of the whole company.
      for (const itemId of reversedItems) {
        const rows = originalEntries.filter((r) => r.item_id === itemId);
        let qty = 0;
        let value = 0;
        for (const r of rows) {
          qty += parseFloat(r.quantity) || 0;
          value += (parseFloat(r.quantity) || 0) * (parseFloat(r.unit_rate) || 0);
        }
        if (qty === 0) continue;
        const netDirection = qty > 0 ? 1 : -1;
        this.engine.applyValuation(
          companyId, itemId, netDirection, Math.abs(qty), value / qty,
          {
            sourceDocumentType: 'VOUCHER_REVERSAL',
            sourceDocumentId: voucher.id,
            userId,
            at: now,
          });
        this.engine.rebuildBalances(companyId, { itemId });
      }

      // 5. Reverse accounting journal
      if (voucher.accounting_journal_id) {
        try {
          this.accounting.reverseVoucher(voucher.accounting_journal_id, companyId, {
            userId, companyId, permissions: this._permissions(userId, companyId)
          });
        } catch (e) {
          // Log but don't fail — inventory reversal is the priority
          console.error(`[inventory] Failed to reverse accounting journal for ${voucherNumber}:`, e.message);
        }
      }

      // 6. Create a reversal voucher header for audit trail
      this.conn.run(
        `INSERT INTO inventory_voucher_headers
         (id, company_id, voucher_type, voucher_number, voucher_date, reference_id,
          narration, source_type, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?)`,
        [generateId('ivh'), companyId, voucher.voucher_type, reversalNumber,
         voucher.voucher_date, voucher.voucher_number,
         `Reversal of ${voucher.voucher_number}`, voucher.source_type,
         userId, now, now]
      );

      return {
        voucher_number: voucherNumber,
        status: 'cancelled',
        reversal_reference: reversalNumber,
      };
    })();
  }

  /** Reverse serial statuses on cancellation */
  _reverseSerialLifecycle(voucher, companyId) {
    const vt = voucher.voucher_type;
    for (const line of voucher.lines) {
      if (!line.serial_number) continue;
      if (vt === 'stock_inward' || vt === 'opening_stock') {
        // Was available → mark scrapped (can't undo receipt cleanly)
        this.conn.run(
          `UPDATE item_serials SET status = 'scrapped' WHERE serial_number = ? AND company_id = ?`,
          [line.serial_number, companyId]
        );
      } else if (vt === 'stock_outward') {
        // Was sold/damaged/etc → back to available
        this.conn.run(
          `UPDATE item_serials SET status = 'available',
           godown_id = ?, location_id = ?
           WHERE serial_number = ? AND company_id = ?`,
          [line.source_godown_id, line.source_location_id, line.serial_number, companyId]
        );
      } else if (vt === 'stock_transfer') {
        // Was at destination → back to source
        this.conn.run(
          `UPDATE item_serials SET godown_id = ?, location_id = ?
           WHERE serial_number = ? AND company_id = ?`,
          [line.source_godown_id, line.source_location_id, line.serial_number, companyId]
        );
      }
    }
  }

  // ─── Physical Stock Approval ───────────────────────────────────────

  /**
   * Approve a physical stock document: generate adjustment voucher.
   */
  approvePhysicalStock(documentId, companyId, userId) {
    Authorizer.assertPermission({ userId, companyId, permissions: this._permissions(userId, companyId) }, 'inventory.approve');

    return this.conn.transaction(() => {
      // Verify document is in 'verified' status
      const doc = this.conn.get(
        'SELECT * FROM physical_stock_documents WHERE id = ? AND company_id = ? LIMIT 1',
        [documentId, companyId]
      );
      if (!doc) throw new NotFoundError('Physical Stock Document', documentId);
      if (doc.status !== 'verified') {
        throw new ValidationError('Physical stock document must be verified before approval');
      }

      // Create adjustment voucher from physical stock lines
      const lines = this.conn.all(
        `SELECT psl.*, si.name as item_name
         FROM physical_stock_lines psl
         JOIN stock_items si ON si.id = psl.item_id AND si.company_id = psl.company_id
         WHERE psl.document_id = ? AND psl.company_id = ?`,
        [documentId, companyId]
      );

      const voucherLines = [];
      for (const line of lines) {
        const diff = parseFloat(line.difference) || 0;
        if (Math.abs(diff) < 0.001) continue; // skip no-difference lines

        voucherLines.push({
          item_id: line.item_id,
          uom_id: this.conn.get(
            'SELECT uom_id FROM stock_items WHERE id = ? LIMIT 1',
            [line.item_id]
          )?.uom_id,
          quantity: Math.abs(diff),
          unit_rate: 0, // physical count doesn't specify rate
          batch_id: line.batch_id || null,
          serial_number: line.serial_number || null,
          source_godown_id: doc.godown_id,
          source_location_id: line.location_id || doc.location_id,
          dest_godown_id: doc.godown_id,
          dest_location_id: line.location_id || doc.location_id,
          is_source: diff < 0 ? 1 : 0, // negative diff = decrease
          adjustment_reason_id: null, // physical stock doesn't use reasons
        });
      }

      if (voucherLines.length === 0) {
        throw new ValidationError('No quantity differences found in this physical stock document');
      }

      // Create and post the adjustment voucher
      const result = this.postVoucher(
        {
          voucher_type: 'stock_adjustment',
          voucher_date: doc.document_date,
          reference_id: doc.document_number,
          narration: `Physical stock adjustment: ${doc.narration || ''}`,
          source_type: 'adjustment',
          lines: voucherLines,
        },
        companyId,
        userId
      );

      // Mark document as approved
      this.conn.run(
        `UPDATE physical_stock_documents
         SET status = 'approved', approved_by = ?, approved_on = ?, updated_at = ?
         WHERE id = ? AND company_id = ?`,
        [userId, new Date().toISOString(), new Date().toISOString(), documentId, companyId]
      );

      return result;
    })();
  }

  // ─── Reports ────────────────────────────────────────────────────────

  /** Stock valuation report */
  getValuationReport(companyId, options = {}) {
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const rows = this.conn.all(
      // stock_balances is dimensional (one row per item/batch/godown/location),
      // so it MUST be aggregated per item. Selecting sb.quantity directly makes
      // an item split across godowns report only its first godown's quantity.
      `SELECT si.id, si.name, si.sku, si.uom_id,
              COALESCE(SUM(sb.quantity), 0) as quantity,
              COALESCE(SUM(sb.quantity * sb.avg_rate), 0) as total_value,
              CASE WHEN COALESCE(SUM(sb.quantity), 0) <> 0
                   THEN SUM(sb.quantity * sb.avg_rate) / SUM(sb.quantity)
                   ELSE COALESCE(si.cost_price, 0) END as avg_rate,
              si.cost_price, si.mrp, si.selling_rate
       FROM stock_items si
       LEFT JOIN stock_balances sb ON sb.item_id = si.id AND sb.company_id = si.company_id
       WHERE si.company_id = ? AND si.is_active = 1
       GROUP BY si.id, si.name, si.sku, si.uom_id, si.cost_price, si.mrp, si.selling_rate
       ORDER BY si.name ASC
       LIMIT ? OFFSET ?`,
      [companyId, limit, offset]
    );

    const totalValue = rows.reduce((s, r) => s + (parseFloat(r.total_value) || 0), 0);
    return { items: rows, total_value: totalValue, count: rows.length };
  }

  /** Batch-wise stock report */
  getBatchStockReport(companyId, options = {}) {
    const rows = this.conn.all(
      `SELECT b.id, b.batch_number, b.manufacturing_date, b.expiry_date,
              b.purchase_rate, b.mrp, b.selling_rate,
              si.id as item_id, si.name as item_name, si.sku,
              COALESCE(sb.quantity, 0) as quantity,
              COALESCE(sb.avg_rate, 0) as avg_rate,
              COALESCE(sb.quantity * sb.avg_rate, 0) as total_value
       FROM batches b
       JOIN stock_items si ON si.id = b.item_id AND si.company_id = b.company_id
       LEFT JOIN (
         SELECT item_id, batch_id,
                SUM(quantity) AS quantity,
                CASE WHEN SUM(quantity) <> 0
                     THEN SUM(quantity * avg_rate) / SUM(quantity) ELSE 0 END AS avg_rate
           FROM stock_balances
          WHERE company_id = ? AND batch_id IS NOT NULL
          GROUP BY item_id, batch_id
       ) sb ON sb.item_id = b.item_id AND sb.batch_id = b.id
       WHERE b.company_id = ? AND b.is_active = 1
       GROUP BY b.id, b.batch_number, b.manufacturing_date, b.expiry_date,
                b.purchase_rate, b.mrp, b.selling_rate,
                si.id, si.name, si.sku
       ORDER BY b.expiry_date ASC`,
      [companyId, companyId]
    );
    return { items: rows, total: rows.length };
  }

  /** Godown-wise stock report */
  getGodownStockReport(companyId) {
    const rows = this.conn.all(
      `SELECT g.id, g.name, g.code,
              SUM(COALESCE(sb.quantity, 0)) as total_quantity,
              SUM(COALESCE(sb.quantity * sb.avg_rate, 0)) as total_value
       FROM godowns g
       LEFT JOIN stock_balances sb ON sb.godown_id = g.id AND sb.company_id = g.company_id
       WHERE g.company_id = ? AND g.is_active = 1
       GROUP BY g.id, g.name, g.code
       ORDER BY g.name ASC`,
      [companyId]
    );
    return { items: rows, total: rows.length };
  }

  /** Location-wise stock report */
  getLocationStockReport(companyId) {
    const rows = this.conn.all(
      `SELECT l.id, l.name as location_name, l.code,
              g.name as godown_name,
              SUM(COALESCE(sb.quantity, 0)) as total_quantity,
              SUM(COALESCE(sb.quantity * sb.avg_rate, 0)) as total_value
       FROM locations l
       LEFT JOIN godowns g ON g.location_id = l.id AND g.company_id = l.company_id
       LEFT JOIN stock_balances sb ON sb.location_id = l.id AND sb.company_id = l.company_id
       WHERE l.company_id = ? AND l.is_active = 1
       GROUP BY l.id, l.name, l.code, g.name
       ORDER BY g.name, l.name ASC`,
      [companyId]
    );
    return { items: rows, total: rows.length };
  }

  /** Expiry management report (items expiring within N days, default 90) */
  getExpiryReport(companyId, days = 90) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() + days);
    const cutoff = cutoffDate.toISOString().split('T')[0];

    const rows = this.conn.all(
      `SELECT b.id, b.batch_number, b.expiry_date, b.manufacturing_date,
              si.id as item_id, si.name as item_name, si.sku,
              COALESCE(sb.quantity, 0) as quantity
       FROM batches b
       JOIN stock_items si ON si.id = b.item_id AND si.company_id = b.company_id
       LEFT JOIN (
         SELECT item_id, batch_id, SUM(quantity) AS quantity
           FROM stock_balances
          WHERE company_id = ? AND batch_id IS NOT NULL
          GROUP BY item_id, batch_id
       ) sb ON sb.item_id = b.item_id AND sb.batch_id = b.id
       WHERE b.company_id = ? AND b.is_active = 1
         AND b.expiry_date IS NOT NULL
         AND b.expiry_date <= ?
         AND b.expiry_date >= date('now')
       GROUP BY b.id, b.batch_number, b.expiry_date, b.manufacturing_date,
                si.id, si.name, si.sku
       ORDER BY b.expiry_date ASC`,
      [companyId, companyId, cutoff]
    );

    const report = rows.map(r => {
      const today = new Date();
      const expiry = new Date(r.expiry_date);
      const daysRemaining = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
      return { ...r, days_remaining: daysRemaining };
    });

    return { items: report, total: report.length };
  }

  /** Serial-wise stock report */
  getSerialReport(companyId, options = {}) {
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    let where = ['s.company_id = ?'];
    const params = [companyId];

    if (options.item_id) {
      where.push('s.item_id = ?');
      params.push(options.item_id);
    }
    if (options.status) {
      where.push('s.status = ?');
      params.push(options.status);
    }

    const whereStr = where.join(' AND ');
    const rows = this.conn.all(
      `SELECT s.id, s.serial_number, s.status, s.purchase_date, s.purchase_rate,
              s.mfg_date, s.expiry_date, s.godown_id, s.location_id,
              si.name as item_name, si.sku, b.batch_number,
              g.name as godown_name, l.name as location_name
       FROM item_serials s
       JOIN stock_items si ON si.id = s.item_id AND si.company_id = s.company_id
       LEFT JOIN batches b ON b.id = s.batch_id AND b.company_id = s.company_id
       LEFT JOIN godowns g ON g.id = s.godown_id AND g.company_id = s.company_id
       LEFT JOIN locations l ON l.id = s.location_id AND l.company_id = s.company_id
       WHERE ${whereStr}
       ORDER BY s.serial_number ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { items: rows, total: rows.length };
  }

  // ─── Helper: get user permissions ──────────────────────────────────

  _permissions(userId, companyId) {
    // Fetch permissions from the existing roles/permissions system
    const rows = this.conn.all(
      `SELECT p.code
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE ur.user_id = ?`,
      [userId]
    );
    return rows ? rows.map(r => r.code) : [];
  }
}

module.exports = { InventoryService };
