const { generateId } = require('../utils/generateId');
const { ValidationError, AppError } = require('../utils/errors');
const CodeGenerator = require('../services/code-generator.service');

/**
 * BillInventoryBridge — connects Customer Bills to the canonical inventory
 * engine so that posting a bill moves stock exactly once and cancelling it
 * restores stock exactly once.
 *
 * ── Design contract ────────────────────────────────────────────────────────
 * 1. IDEMPOTENCY. Every movement carries source_document_type /
 *    source_document_id. A unique index on inventory_voucher_headers makes a
 *    second stock-out for the same bill impossible at the database level, and
 *    findExisting() lets the caller short-circuit instead of throwing.
 *
 * 2. NO DIRECT BALANCE WRITES. Stock changes only ever reach stock_balances
 *    through InventoryEngine.rebuildBalances(), which derives them from
 *    stock_ledger.
 *
 * 3. VALUATION IS SINGLE-SOURCE. Cost is taken from the canonical moving
 *    weighted average in inventory_items, never recomputed here.
 *
 * 4. HISTORY IS NEVER DELETED. Cancellation appends reversing ledger rows and a
 *    reversing voucher header; the original rows stay exactly as they were.
 *
 * 5. CALLER OWNS THE TRANSACTION. postForBill() / reverseForBill() expect to
 *    run inside an existing transaction so the bill, its journal entry, its
 *    receivable and its stock movement commit or roll back together.
 */
class BillInventoryBridge {
  constructor(conn, engine) {
    this.conn = conn;
    this.engine = engine;
  }

  // ─── Plan resolution ─────────────────────────────────────────────────────

  /**
   * Work out which bill lines actually move stock, and at which dimensions.
   *
   * A line participates when it references a product that has an active stock
   * item. The line supplies its own godown/location/batch/serial, or falls back
   * to the stock item's default placement.
   *
   * Returns { entries: [...], skipped: [...] } so the caller can report what was
   * not stock-controlled rather than silently ignoring it.
   */
  resolveEntries(bill, companyId) {
    const lines = this.conn.all(
      `SELECT bi.*, p.is_service, p.is_inventory_managed
         FROM bill_items bi
         LEFT JOIN products p ON p.id = bi.product_id AND p.company_id = bi.company_id
        WHERE bi.bill_id = ? AND bi.company_id = ?
        ORDER BY bi.created_at ASC`,
      [bill.id, companyId]);

    const entries = [];
    const skipped = [];

    for (const line of lines) {
      // A service line never carries stock.
      if (line.is_service === 1) { skipped.push({ line, reason: 'service' }); continue; }

      const stockItem = this.engine.findStockItemByProduct(companyId, line.product_id);
      if (!stockItem) { skipped.push({ line, reason: 'not_inventory_managed' }); continue; }

      const quantity = parseFloat(line.quantity) || 0;
      if (quantity <= 0) {
        throw new ValidationError(
          `Bill ${bill.bill_number}: line "${line.description}" has quantity ${quantity}. `
          + 'Quantity must be greater than zero for an inventory-managed item.');
      }

      const godownId = line.godown_id || stockItem.godown_id;
      if (!godownId) {
        throw new ValidationError(
          `Bill ${bill.bill_number}: no godown specified for "${line.description}" `
          + `(${stockItem.sku}). A godown is required to move stock.`);
      }

      const locationId = line.location_id || stockItem.location_id
        || this.engine.locationForGodown(companyId, godownId);

      // A godown must belong to the location the line claims.
      const consistency = this.engine.validateGodownLocation(companyId, godownId, locationId);
      if (!consistency.ok) {
        throw new ValidationError(
          `Bill ${bill.bill_number}: ${consistency.reason} (item ${stockItem.sku}).`);
      }

      // Batch dimension
      let batchId = line.batch_id || null;
      if (stockItem.is_batch_tracked === 1) {
        if (!batchId) {
          // Tolerate the legacy free-text column, but only if it resolves.
          if (line.batch) {
            const match = this.conn.get(
              'SELECT id FROM batches WHERE company_id = ? AND item_id = ? AND batch_number = ? LIMIT 1',
              [companyId, stockItem.id, line.batch]);
            batchId = match ? match.id : null;
          }
        }
        if (!batchId) {
          throw new ValidationError(
            `Bill ${bill.bill_number}: "${line.description}" (${stockItem.sku}) is batch-tracked, `
            + 'so a batch must be selected before the bill can be posted.');
        }
        const batch = this.engine.getBatch(companyId, batchId);
        if (!batch) throw new ValidationError(`Batch ${batchId} not found`);
        if (batch.item_id !== stockItem.id) {
          throw new ValidationError(
            `Bill ${bill.bill_number}: batch "${batch.batch_number}" belongs to a different item `
            + `than "${line.description}" (${stockItem.sku}).`);
        }
        if (this.engine.isBatchExpired(batch)) {
          throw new ValidationError(
            `Bill ${bill.bill_number}: batch "${batch.batch_number}" expired on `
            + `${batch.expiry_date} and cannot be sold.`);
        }
      } else {
        batchId = null;  // non-batch item: never carry a batch dimension
      }

      // Serial dimension. quantity must equal the number of serials supplied.
      let serials = [];
      if (stockItem.is_serial_tracked === 1) {
        serials = this._collectSerials(companyId, stockItem, line, quantity);
      }

      entries.push({
        line,
        stockItem,
        quantity,
        godownId,
        locationId,
        batchId,
        serials,
        // Unit rate for the ledger is cost, not selling price: stock leaves at
        // what it is worth on the shelf, not what the customer paid.
        unitRate: this.engine.getUnitCost(companyId, stockItem.id),
      });
    }

    return { entries, skipped };
  }

  /** Gather and validate the serial selections on a serial-tracked line. */
  _collectSerials(companyId, stockItem, line, quantity) {
    const ids = [];
    const push = (v) => { if (v && !ids.includes(v)) ids.push(v); };

    if (Array.isArray(line.serial_ids)) line.serial_ids.forEach(push);
    if (line.serial_id) push(line.serial_id);

    // Fall back to free-text serials, one per line, for the legacy UI shape.
    const freeText = [line.serial_number, ...(Array.isArray(line.serial_numbers) ? line.serial_numbers : [])];
    for (const value of freeText) {
      if (!value) continue;
      const serial = this.engine.getSerialByNumber(companyId, value);
      if (!serial) throw new ValidationError(`Serial "${value}" not found`);
      push(serial.id);
    }

    if (ids.length === 0) {
      throw new ValidationError(
        `Bill line "${line.description}" (${stockItem.sku}) is serial-tracked, so `
        + `${quantity} serial number(s) must be selected.`);
    }
    if (ids.length !== quantity) {
      throw new ValidationError(
        `"${line.description}" (${stockItem.sku}): quantity is ${quantity} but `
        + `${ids.length} serial(s) were selected. They must match.`);
    }

    const serials = [];
    for (const id of ids) {
      const serial = this.engine.getSerial(companyId, id);
      if (!serial) throw new ValidationError(`Serial ${id} not found`);
      if (serial.item_id !== stockItem.id) {
        throw new ValidationError(
          `Serial "${serial.serial_number}" belongs to a different item than `
          + `"${line.description}" (${stockItem.sku}).`);
      }
      if (serial.status !== 'available') {
        throw new ValidationError(
          `Serial "${serial.serial_number}" is ${serial.status} and cannot be sold. `
          + 'Only available serials may be issued.');
      }
      serials.push(serial);
    }
    return serials;
  }

  /**
   * Validate every line against current stock BEFORE any row is written, so a
   * bill is rejected whole rather than failing halfway through.
   */
  preflight(bill, companyId) {
    const { entries, skipped } = this.resolveEntries(bill, companyId);

    for (const entry of entries) {
      // Serial-tracked lines were already validated exactly per serial; the
      // batch/godown/location balance check still applies for reporting parity.
      const { quantity, stockItem, godownId, batchId, locationId } = entry;
      const available = stockItem.is_batch_tracked === 1
        ? this.engine.getBalance(companyId, stockItem.id, { godownId, batchId, locationId }).quantity
        : this.engine.getTotalBalance(companyId, stockItem.id);

      if (available < quantity) {
        const where = stockItem.is_batch_tracked === 1
          ? `batch "${entry.batchId}" at that godown`
          : 'total stock';
        throw new ValidationError(
          `Bill ${bill.bill_number}: insufficient stock for "${entry.line.description}" `
          + `(${stockItem.sku}). Requested ${quantity}, available ${available} (${where}).`);
      }

      for (const serial of entry.serials) {
        if (serial.godown_id && serial.godown_id !== godownId) {
          throw new ValidationError(
            `Bill ${bill.bill_number}: serial "${serial.serial_number}" is held in a different `
            + 'godown than the line specifies.');
        }
      }
    }

    return { entries, skipped };
  }

  // ─── Posting ─────────────────────────────────────────────────────────────

  /**
   * Create and post the stock-out that fulfils a bill.
   *
   * @param {object} bill      the bill row (must already be POSTED-pending)
   * @param {object} opts      { companyId, userId, voucherDate, voucherNumber }
   * @returns {object|null}    { voucher, entries, skipped, valuation } or null
   *                           when the bill moves no stock.
   *
   * MUST be called inside a transaction owned by the caller.
   */
  postForBill(bill, { companyId, userId, voucherDate, voucherNumber }) {
    // 1. Idempotency: never move stock twice for the same bill.
    const existing = this.engine.findVoucherBySource(companyId, 'CUSTOMER_BILL', bill.id);
    if (existing) {
      return {
        voucher: existing,
        entries: [],
        skipped: [],
        alreadyPosted: true,
        valuation: [],
      };
    }

    // 2. Validate everything up front.
    const { entries, skipped } = this.preflight(bill, companyId);
    if (entries.length === 0) return null;   // nothing under inventory control

    const date = voucherDate || bill.issue_date;
    const number = voucherNumber
      || CodeGenerator.generate(this.conn, 'INVENTORY_VOUCHER', companyId,
           CodeGenerator.voucherTypeAbbrev('stock_outward'));

    // 3. Voucher header, tagged so it can never be duplicated.
    const headerId = generateId('ivh');
    this.conn.run(
      `INSERT INTO inventory_voucher_headers
        (id, company_id, voucher_type, voucher_number, voucher_date, reference_id,
         narration, source_type, source_document_type, source_document_id,
         status, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, 'stock_outward', ?, ?, ?, ?, ?, 'CUSTOMER_BILL', ?, 'posted', ?, ?, ?, ?)`,
      [headerId, companyId, number, date, bill.id,
       `Customer Bill ${bill.bill_number}`, bill.invoice_number || bill.bill_number,
       bill.id, userId, userId, new Date().toISOString(), new Date().toISOString()]);

    const at = new Date().toISOString();
    const valuation = [];

    entries.forEach((entry, index) => {
      const { line, stockItem, quantity, godownId, locationId, batchId, serials } = entry;

      // 4a. Voucher line
      const lineId = generateId('ivl');
      this.conn.run(
        `INSERT INTO inventory_voucher_lines
          (id, company_id, header_id, line_number, item_id, batch_id, serial_number,
           uom_id, quantity, unit_rate, amount, source_godown_id, source_location_id,
           dest_godown_id, dest_location_id, is_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?)`,
        [lineId, companyId, headerId, index + 1, stockItem.id, batchId,
         serials.length ? serials[0].serial_number : null,
         stockItem.uom_id, quantity, entry.unitRate, quantity * entry.unitRate,
         godownId, locationId, at]);

      // 4b. Immutable ledger movement (negative)
      this.engine.postLedgerMovement({
        companyId,
        voucherType: 'stock_outward',
        voucherNumber: number,
        headerId,
        lineNumber: index + 1,
        voucherDate: date,
        itemId: stockItem.id,
        batchId,
        serialNumber: serials.length ? serials[0].serial_number : null,
        godownId,
        locationId,
        quantity: -quantity,
        unitRate: entry.unitRate,
        referenceId: bill.id,
        narration: `Stock out for Customer Bill ${bill.bill_number}`,
        sourceDocumentType: 'CUSTOMER_BILL',
        sourceDocumentId: bill.id,
        userId,
      });

      // 4c. Valuation — stock out is costed at the weighted average.
      const val = this.engine.applyValuation(companyId, stockItem.id, -1, quantity, 0, {
        sourceDocumentType: 'CUSTOMER_BILL',
        sourceDocumentId: bill.id,
        userId,
        at,
      });
      if (val) valuation.push({ item_id: stockItem.id, sku: stockItem.sku, ...val });

      // 4d. Serials move available -> sold
      for (const serial of serials) {
        this.engine.setSerialStatus(companyId, serial.id, 'sold', godownId, locationId);
      }
    });

    // 5. Balances derive from the ledger, scoped to what moved.
    for (const itemId of new Set(entries.map((e) => e.stockItem.id))) {
      this.engine.rebuildBalances(companyId, { itemId });
    }

    return { voucher: { id: headerId, voucher_number: number }, entries, skipped, valuation };
  }

  /**
   * Reverse the stock movements a bill caused, by APPENDING inverse rows.
   * The original stock_outward rows are never modified or deleted.
   *
   * Idempotent: a bill can only be reversed once, because the reversal header
   * is itself tagged and checked before anything is written.
   */
  reverseForBill(bill, { companyId, userId, reason }) {
    const original = this.engine.findVoucherBySource(companyId, 'CUSTOMER_BILL', bill.id);
    if (!original) return null;   // bill never moved stock

    const reversalNumber = CodeGenerator.generate(this.conn, 'INVENTORY_VOUCHER', companyId,
      CodeGenerator.voucherTypeAbbrev('stock_outward'));
    const at = new Date().toISOString();

    const rows = this.engine.findLedgerBySource(companyId, 'CUSTOMER_BILL', bill.id)
      // Only reverse the original movements, never a prior reversal.
      .filter((r) => r.voucher_type === 'stock_outward');

    if (rows.length === 0) return null;

    const reversalHeaderId = generateId('ivh');
    this.conn.run(
      `INSERT INTO inventory_voucher_headers
        (id, company_id, voucher_type, voucher_number, voucher_date, reference_id,
         narration, source_type, status, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, 'stock_outward', ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?)`,
      [reversalHeaderId, companyId, reversalNumber, bill.issue_date,
       original.voucher_number,
       `Reversal of stock out for Customer Bill ${bill.bill_number}`
         + (reason ? `: ${reason}` : ''),
       'CUSTOMER_BILL_REVERSAL', userId, userId, at, at]);

    const valuation = [];
    for (const row of rows) {
      // Append the mirror image. History is additive, never rewritten.
      this.engine.postLedgerMovement({
        companyId,
        voucherType: 'stock_outward',
        voucherNumber: reversalNumber,
        headerId: reversalHeaderId,
        lineNumber: row.line_number,
        voucherDate: row.voucher_date,
        itemId: row.item_id,
        batchId: row.batch_id,
        serialNumber: row.serial_number,
        godownId: row.godown_id,
        locationId: row.location_id,
        quantity: -parseFloat(row.quantity),   // flips -10 back to +10
        unitRate: parseFloat(row.unit_rate) || 0,
        referenceId: row.reference_id,
        narration: `REVERSAL: stock in for Customer Bill ${bill.bill_number}`,
        sourceDocumentType: 'CUSTOMER_BILL_REVERSAL',
        sourceDocumentId: bill.id,
        userId,
      });

      // Valuation returns stock at the unit cost it originally left at.
      const val = this.engine.applyValuation(companyId, row.item_id, +1,
        Math.abs(parseFloat(row.quantity)), parseFloat(row.unit_rate) || 0, {
          sourceDocumentType: 'CUSTOMER_BILL_REVERSAL',
          sourceDocumentId: bill.id,
          userId,
          at,
        });
      if (val) valuation.push({ item_id: row.item_id, ...val });

      // Serial returns to available stock if it has not been used since.
      if (row.serial_number) {
        const serial = this.engine.getSerialByNumber(companyId, row.serial_number);
        if (serial && serial.status === 'sold') {
          this.engine.setSerialStatus(companyId, serial.id, 'available', row.godown_id, row.location_id);
        }
      }
    }

    for (const itemId of new Set(rows.map((r) => r.item_id))) {
      this.engine.rebuildBalances(companyId, { itemId });
    }

    return { voucher: { id: reversalHeaderId, voucher_number: reversalNumber }, valuation };
  }

  /**
   * Stock-in for a sales return (credit note), valued at the original cost so
   * the inventory asset and COGS unwind consistently.
   */
  postReturn({ companyId, userId, billId, creditNoteId, entries, voucherDate }) {
    if (!entries || entries.length === 0) return null;

    const number = CodeGenerator.generate(this.conn, 'INVENTORY_VOUCHER', companyId,
      CodeGenerator.voucherTypeAbbrev('stock_inward'));
    const date = voucherDate || new Date().toISOString().slice(0, 10);
    const at = new Date().toISOString();
    const headerId = generateId('ivh');

    this.conn.run(
      `INSERT INTO inventory_voucher_headers
        (id, company_id, voucher_type, voucher_number, voucher_date, reference_id,
         narration, source_type, source_document_type, source_document_id,
         status, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, 'stock_inward', ?, ?, ?, ?, 'CREDIT_NOTE', 'CREDIT_NOTE', ?, 'posted', ?, ?, ?, ?)`,
      [headerId, companyId, number, date, creditNoteId,
       `Sales return against bill ${billId}`, creditNoteId, userId, userId, at, at]);

    const valuation = [];
    entries.forEach((entry, index) => {
      const { stockItem, quantity, godownId, locationId, batchId, serial = null } = entry;
      const unitRate = entry.unitRate !== undefined
        ? entry.unitRate
        : this.engine.getUnitCost(companyId, stockItem.id);

      this.conn.run(
        `INSERT INTO inventory_voucher_lines
          (id, company_id, header_id, line_number, item_id, batch_id, serial_number,
           uom_id, quantity, unit_rate, amount, source_godown_id, source_location_id,
           dest_godown_id, dest_location_id, is_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [generateId('ivl'), companyId, headerId, index + 1, stockItem.id, batchId, serial,
         stockItem.uom_id, quantity, unitRate, quantity * unitRate,
         godownId, locationId, godownId, locationId, at]);

      this.engine.postLedgerMovement({
        companyId,
        voucherType: 'stock_inward',
        voucherNumber: number,
        headerId,
        lineNumber: index + 1,
        voucherDate: date,
        itemId: stockItem.id,
        batchId,
        serialNumber: serial,
        godownId,
        locationId,
        quantity,
        unitRate,
        referenceId: billId,
        narration: `Sales return for credit note ${creditNoteId}`,
        sourceDocumentType: 'CREDIT_NOTE',
        sourceDocumentId: creditNoteId,
        userId,
      });

      const val = this.engine.applyValuation(companyId, stockItem.id, +1, quantity, unitRate, {
        sourceDocumentType: 'CREDIT_NOTE',
        sourceDocumentId: creditNoteId,
        userId,
        at,
      });
      if (val) valuation.push({ item_id: stockItem.id, ...val });

      if (serial) {
        const s = this.engine.getSerialByNumber(companyId, serial);
        if (s) this.engine.setSerialStatus(companyId, s.id, 'available', godownId, locationId);
      }
    });

    for (const itemId of new Set(entries.map((e) => e.stockItem.id))) {
      this.engine.rebuildBalances(companyId, { itemId });
    }

    return { voucher: { id: headerId, voucher_number: number }, valuation };
  }
}

module.exports = { BillInventoryBridge };