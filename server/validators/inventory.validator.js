const { ValidationError } = require('../utils/errors');

/**
 * Inventory Management Validation Rules
 * Implements V01–V16 from the architecture spec.
 *
 * All validation is server-side. Frontend validation is supplementary only.
 */
class InventoryValidator {
  constructor(conn) {
    this.conn = conn;
  }

  // ─── V01: Required fields ──────────────────────────────────────────

  requireCompanyId(companyId) {
    if (!companyId) throw new ValidationError('Company context is required');
    return companyId;
  }

  // ─── V02: Quantity must be positive (user enters positive; direction via is_source) ──

  validateQuantity(quantity) {
    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty <= 0) {
      throw new ValidationError('Quantity must be a positive number greater than 0');
    }
    return qty;
  }

  // ─── V03: Batch expiry >= manufacturing date ───────────────────────

  validateBatchDates(mfgDate, expiryDate) {
    if (mfgDate && expiryDate) {
      const mfg = new Date(mfgDate);
      const exp = new Date(expiryDate);
      if (exp < mfg) {
        throw new ValidationError('Expiry date must be on or after manufacturing date');
      }
    }
    return { mfgDate, expiryDate };
  }

  // ─── V04: Batch only for batch-tracked items ───────────────────────

  validateBatchTracking(item, batchId) {
    if (batchId && !item.is_batch_tracked) {
      throw new ValidationError(
        `Item "${item.name}" does not have batch tracking enabled. Enable batch tracking first or remove the batch reference.`
      );
    }
  }

  // ─── V05: Serial uniqueness per item ──────────────────────────────

  validateSerialUniqueness(companyId, itemId, serialNumber) {
    if (!serialNumber) return;
    const exists = this.conn.get(
      'SELECT id FROM item_serials WHERE company_id = ? AND item_id = ? AND serial_number = ? LIMIT 1',
      [companyId, itemId, serialNumber]
    );
    if (exists) {
      throw new ValidationError(`Serial number "${serialNumber}" already exists for this item`);
    }
  }

  // ─── V05b: Serial only for serial-tracked items ────────────────────

  validateSerialTracking(item, serialNumber) {
    if (serialNumber && !item.is_serial_tracked) {
      throw new ValidationError(
        `Item "${item.name}" does not have serial tracking enabled. Enable serial tracking first or remove the serial number.`
      );
    }
  }

  // ─── V06: Transfer source/destination must differ ──────────────────

  validateTransfer(sourceGodownId, destGodownId) {
    if (!sourceGodownId) throw new ValidationError('Transfer requires a source godown');
    if (!destGodownId) throw new ValidationError('Transfer requires a destination godown');
    if (sourceGodownId === destGodownId) {
      throw new ValidationError('Source and destination godown must be different for a transfer');
    }
  }

  // ─── V07: Outward cannot exceed available stock ────────────────────

  validateOutwardQuantity(companyId, itemId, requestedQty, godownId, batchId, locationId, serialNumber) {
    const item = this.conn.get(
      'SELECT id, name, is_batch_tracked, is_serial_tracked FROM stock_items WHERE id = ? AND company_id = ? LIMIT 1',
      [itemId, companyId]
    );
    if (!item) throw new ValidationError(`Stock item ${itemId} not found`);

    const isBatchTracked = Number(item.is_batch_tracked) === 1;
    const isSerialTracked = Number(item.is_serial_tracked) === 1;

    // A batch-tracked item MUST name a batch. Validating without one would
    // silently widen the query to every batch, letting a sale pass against stock
    // that belongs to a different batch.
    if (isBatchTracked && !batchId) {
      throw new ValidationError(
        `Item "${item.name}" is batch-tracked, so a batch must be selected for an outward movement.`
      );
    }

    // Expired stock must not be issued. This is checked here (not just in the
    // bill bridge) so manual stock_outward vouchers are covered too.
    if (isBatchTracked && batchId) {
      const batch = this.conn.get(
        'SELECT id, batch_number, expiry_date FROM batches WHERE id = ? AND company_id = ? LIMIT 1',
        [batchId, companyId]
      );
      if (!batch) throw new ValidationError(`Batch ${batchId} not found`);
      if (batch.expiry_date && String(batch.expiry_date) < new Date().toISOString().slice(0, 10)) {
        throw new ValidationError(
          `Batch "${batch.batch_number}" expired on ${batch.expiry_date} and cannot be issued.`
        );
      }
    }
    // A non-batch-tracked item must not carry a batch dimension.
    const effectiveBatchId = isBatchTracked ? batchId : null;

    const params = [companyId, itemId, godownId];
    let sql = `SELECT COALESCE(SUM(quantity), 0) as available
               FROM stock_ledger
               WHERE company_id = ? AND item_id = ? AND godown_id = ?`;

    // Always apply the batch dimension explicitly (including IS NULL) so the
    // validated set is exactly the set that will be moved.
    sql += effectiveBatchId ? ' AND batch_id = ?' : ' AND (batch_id IS NULL)';
    if (effectiveBatchId) params.push(effectiveBatchId);

    if (locationId) {
      sql += ' AND location_id = ?';
      params.push(locationId);
    }

    const balance = this.conn.get(sql, params);
    const available = parseFloat(balance?.available) || 0;

    // Serial-tracked items are validated per serial, so the batch-level check
    // above is not meaningful for them.
    if (!isSerialTracked && available < requestedQty) {
      const scope = effectiveBatchId
        ? `batch ${effectiveBatchId} at that godown`
        : 'that godown';
      throw new ValidationError(
        `Insufficient stock: Requested ${requestedQty}, Available ${available} for this item in ${scope}`
      );
    }

    // Serial validation: the serial must exist, belong to this item, and be
    // available. Sold / damaged / scrapped / expired / in_transit are refused.
    if (isSerialTracked) {
      if (!serialNumber) {
        throw new ValidationError(
          `Item "${item.name}" is serial-tracked, so a serial number is required for an outward movement.`
        );
      }
      const serial = this.conn.get(
        'SELECT id, serial_number, status, godown_id FROM item_serials WHERE company_id = ? AND serial_number = ? LIMIT 1',
        [companyId, serialNumber]
      );
      if (!serial) throw new ValidationError(`Serial "${serialNumber}" not found`);
      if (serial.status !== 'available') {
        throw new ValidationError(
          `Serial "${serial.serial_number}" is ${serial.status} and cannot be issued. Only available serials may be sold.`
        );
      }
      if (godownId && serial.godown_id && serial.godown_id !== godownId) {
        throw new ValidationError(
          `Serial "${serial.serial_number}" is held in a different godown than the movement specifies.`
        );
      }
    }
  }

  // ─── V08: Adjustment reason required ───────────────────────────────

  validateAdjustmentReason(reasonId) {
    if (!reasonId) {
      throw new ValidationError('Adjustment reason is required. Please select a reason from the master.');
    }
  }

  // ─── V09: Price >= 0 ────────────────────────────────────────────────

  validatePrice(price) {
    const val = parseFloat(price);
    if (isNaN(val) || val < 0) {
      throw new ValidationError('Price must be a non-negative number');
    }
    return val;
  }

  // ─── V10: Compound conversion > 0 ───────────────────────────────────

  validateCompoundQuantity(quantity) {
    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty <= 0) {
      throw new ValidationError('Compound unit quantity must be greater than 0');
    }
    return qty;
  }

  // ─── V11: Alternate conversion > 0 ──────────────────────────────────

  validateAlternateFactor(factor) {
    const val = parseFloat(factor);
    if (isNaN(val) || val <= 0) {
      throw new ValidationError('Alternate unit conversion factor must be greater than 0');
    }
    return val;
  }

  // ─── V12: Only posted vouchers create ledger entries ──────────────

  validateVoucherStatus(status) {
    if (status !== 'posted') {
      throw new ValidationError('Only posted vouchers generate stock ledger movements');
    }
  }

  // ─── V13: UOM dimensions must match ───────────────────────────────

  validateUomDimension(uomId, baseUomId, companyId) {
    if (!uomId || !baseUomId) return;
    const uom = this.conn.get(
      'SELECT dimension_id FROM units_of_measure WHERE id = ? AND company_id = ? LIMIT 1',
      [uomId, companyId]
    );
    const base = this.conn.get(
      'SELECT dimension_id FROM units_of_measure WHERE id = ? AND company_id = ? LIMIT 1',
      [baseUomId, companyId]
    );
    if (!uom || !base) {
      throw new ValidationError('Referenced unit of measure does not exist');
    }
    if (uom.dimension_id !== base.dimension_id) {
      throw new ValidationError('Units must belong to the same measurement dimension (e.g., do not convert kg to litre)');
    }
  }

  // ─── V14: Batch tracking enforcement ──────────────────────────────

  validateBatchItem(itemId, batchId, companyId) {
    if (!batchId) return;
    const item = this.conn.get(
      'SELECT is_batch_tracked FROM stock_items WHERE id = ? AND company_id = ? LIMIT 1',
      [itemId, companyId]
    );
    if (!item) throw new ValidationError('Stock item not found');
    if (!item.is_batch_tracked) {
      throw new ValidationError('Batch can only be specified for batch-tracked items');
    }
  }

  // ─── V15: Serial lifecycle enforcement ────────────────────────────

  validateSerialStatus(serialNumber, allowedStatuses) {
    if (!serialNumber || !allowedStatuses) return;
    const serial = this.conn.get(
      'SELECT * FROM item_serials WHERE serial_number = ? LIMIT 1',
      [serialNumber]
    );
    if (!serial) {
      throw new ValidationError(`Serial number "${serialNumber}" not found`);
    }
    if (allowedStatuses && !allowedStatuses.includes(serial.status)) {
      throw new ValidationError(
        `Serial "${serialNumber}" is currently "${serial.status}" and cannot be used for this operation`
      );
    }
  }

  // ─── V16: Referenced masters cannot be deleted if posted ──────────

  validateMasterNotReferenced(table, id, companyId) {
    // Check if this master record is referenced by any posted voucher
    const postedCheck = {
      brands: 'SELECT 1 FROM stock_items WHERE brand_id = ? AND company_id = ? LIMIT 1',
      models: 'SELECT 1 FROM stock_items WHERE model_id = ? AND company_id = ? LIMIT 1',
      colours: 'SELECT 1 FROM stock_items WHERE colour_id = ? AND company_id = ? LIMIT 1',
      sizes: 'SELECT 1 FROM stock_items WHERE size_id = ? AND company_id = ? LIMIT 1',
      styles: 'SELECT 1 FROM stock_items WHERE style_id = ? AND company_id = ? LIMIT 1',
      stock_categories: 'SELECT 1 FROM (SELECT 1 FROM stock_items WHERE category_id = ? AND company_id = ? UNION SELECT 1 FROM models WHERE stock_category_id = ? AND company_id = ?) LIMIT 1',
      stock_groups: 'SELECT 1 FROM (SELECT 1 FROM stock_categories WHERE stock_group_id = ? AND company_id = ? UNION SELECT 1 FROM stock_items WHERE group_id = ? AND company_id = ?) LIMIT 1',
      units_of_measure: 'SELECT 1 FROM stock_items WHERE uom_id = ? AND company_id = ? LIMIT 1',
      godowns: 'SELECT 1 FROM stock_ledger WHERE godown_id = ? AND company_id = ? AND header_id IN (SELECT id FROM inventory_voucher_headers WHERE status = \'posted\' AND company_id = ?) LIMIT 1',
      batches: 'SELECT 1 FROM stock_ledger WHERE batch_id = ? AND company_id = ? AND header_id IN (SELECT id FROM inventory_voucher_headers WHERE status = \'posted\' AND company_id = ?) LIMIT 1',
    };

    const sql = postedCheck[table];
    if (!sql) return true; // no check defined, allow

    const exists = table === 'godowns' || table === 'batches'
      ? this.conn.get(sql, [id, companyId, companyId])
      : table === 'stock_groups' || table === 'stock_categories'
      ? this.conn.get(sql, [id, companyId, id, companyId])
      : this.conn.get(sql, [id, companyId]);

    if (exists) {
      const referencedBy = table === 'stock_groups'
        ? 'referenced by Stock Categories or Stock Items'
        : table === 'stock_categories'
        ? 'referenced by Models or Stock Items'
        : 'referenced by posted inventory transactions';
      throw new ValidationError(
        `Cannot delete this record because it is ${referencedBy}. Use "Deactivate" instead.`
      );
    }
    return true;
  }

  // ─── Full voucher validation ──────────────────────────────────────

  /**
   * Validate a complete voucher payload before posting.
   * @param {object} payload - { voucher_type, voucher_date, lines: [...], source_type, ... }
   * @param {string} companyId
   */
  validateVoucher(payload, companyId) {
    this.requireCompanyId(companyId);

    if (!payload.voucher_type) {
      throw new ValidationError('voucher_type is required');
    }
    const validTypes = ['opening_stock', 'stock_inward', 'stock_outward', 'stock_transfer',
      'stock_adjustment', 'physical_stock', 'stock_journal'];
    if (!validTypes.includes(payload.voucher_type)) {
      throw new ValidationError(`Invalid voucher type: ${payload.voucher_type}`);
    }

    if (!payload.voucher_date) {
      throw new ValidationError('voucher_date is required');
    }

    const lines = payload.lines || [];
    if (lines.length === 0) {
      throw new ValidationError('At least one line is required');
    }

    for (const [idx, line] of lines.entries()) {
      if (!line.item_id) {
        throw new ValidationError(`Line ${idx + 1}: item_id is required`);
      }
      if (!line.uom_id) {
        throw new ValidationError(`Line ${idx + 1}: uom_id is required`);
      }
      this.validateQuantity(line.quantity);
      if (line.unit_rate !== undefined) {
        const rate = parseFloat(line.unit_rate);
        if (isNaN(rate) || rate < 0) {
          throw new ValidationError(`Line ${idx + 1}: unit_rate must be non-negative`);
        }
      }
    }

    // V06: Transfer source/dest validation
    if (payload.voucher_type === 'stock_transfer') {
      for (const [idx, line] of lines.entries()) {
        this.validateTransfer(line.source_godown_id, line.dest_godown_id);
        if (line.source_godown_id === line.dest_godown_id &&
            line.source_location_id && line.dest_location_id &&
            line.source_location_id === line.dest_location_id) {
          throw new ValidationError(`Transfer line ${idx + 1}: source and destination must differ`);
        }
      }
    }

    // V07: Outward stock check — only when posting (not for drafts)
    if (payload.voucher_type === 'stock_outward' && !payload.is_draft) {
      for (const line of lines) {
        const qty = parseFloat(line.quantity);
        this.validateOutwardQuantity(
          companyId, line.item_id, qty,
          line.source_godown_id || line.dest_godown_id,
          line.batch_id, line.source_location_id || line.dest_location_id,
          line.serial_number
        );
      }
    }

    // V08: Adjustment reason
    if (payload.voucher_type === 'stock_adjustment') {
      for (const [idx, line] of lines.entries()) {
        if (!line.adjustment_reason_id) {
          throw new ValidationError(`Adjustment line ${idx + 1}: reason is required`);
        }
      }
    }

    // V03/V04: Batch validation
    for (const line of lines) {
      if (line.batch_id) {
        const item = this.conn.get(
          'SELECT is_batch_tracked, name FROM stock_items WHERE id = ? AND company_id = ? LIMIT 1',
          [line.item_id, companyId]
        );
        if (!item) throw new ValidationError(`Line: item ${line.item_id} not found`);
        if (!item.is_batch_tracked) {
          throw new ValidationError(`Line: item "${item.name}" does not have batch tracking enabled`);
        }
      }
    }

    // V05/V05b: Serial validation
    for (const line of lines) {
      if (line.serial_number) {
        const item = this.conn.get(
          'SELECT is_serial_tracked, name FROM stock_items WHERE id = ? AND company_id = ? LIMIT 1',
          [line.item_id, companyId]
        );
        if (!item) throw new ValidationError(`Line: item ${line.item_id} not found`);
        if (!item.is_serial_tracked) {
          throw new ValidationError(`Line: item "${item.name}" does not have serial tracking enabled`);
        }
      }
    }

    return true;
  }
}

module.exports = { InventoryValidator };
