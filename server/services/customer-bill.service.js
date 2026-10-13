/**
 * CustomerBillService — Accounts Receivable + Sales Billing engine.
 *
 * Integrates natively with the existing accounting architecture:
 *   - TaxService (calculateTax, buildTaxJELines, getTaxLedgerAccount, saveTransactionTaxDetails)
 *   - JournalEntryRepository.createWithValidation (balanced JE posting)
 *   - ReceivableRepository (recalcFromAllocations)
 *   - CodeGenerator (invoice_number / bill_number generation)
 *   - BillRepository (CRUD)
 *   - CreditRuleRepository (credit-limit checking)
 *   - CompanyTaxConfig (company state for intra/inter-state GST)
 *
 * All posting operations are atomic via conn.transaction().
 * All monetary arithmetic uses paise-integer precision (via TaxService helpers).
 */
const { generateId } = require('../utils/generateId');
const { TaxService, toPaise, fromPaise } = require('./tax-calculation-engine');
const CodeGenerator = require('./code-generator.service');
const {
  BillRepository,
  CreditRuleRepository,
  FinancialYearRepository,
} = require('../repositories/billing-cost.repository');
const { JournalEntryRepository } = require('../repositories/journal-entry.repository');
const { ReceivableRepository } = require('../repositories/receivable.repository');
const { ReceivableSummaryRepository } = require('../repositories/receivable-summary.repository');
const { ReportingRepository } = require('../repositories/reporting.repository');
const { CollectionsService } = require('./collections.service');
const { ChartOfAccountsRepository } = require('../repositories/chart-of-accounts.repository');
const { NotFoundError, ValidationError, AppError, ConflictError } = require('../utils/errors');
// PHASE 3A FY-2 — shared financial-year lock policy. Every posting path below
// must apply the same rule, because FinancialYearRepository.getByDate() resolves
// a year by date range but never inspects `is_locked`.
const { evaluateFinancialYearLock } = require('./financial-year-policy.service');

/** Fixed amount precision for bill monetary columns (2 decimal places, INR). */
const MONEY_SCALE = 100; // rupees -> paise

function toMoney(n) {
  return Math.round((parseFloat(n) || 0) * MONEY_SCALE) / MONEY_SCALE;
}

/** Status transition table. Maps each status to the set of statuses it can transition to. */
const VALID_TRANSITIONS = {
  DRAFT: new Set(['PENDING_APPROVAL', 'APPROVED', 'CANCELLED', 'VOID']),
  PENDING_APPROVAL: new Set(['APPROVED', 'DRAFT', 'CANCELLED']),
  APPROVED: new Set(['POSTED', 'DRAFT', 'CANCELLED']),
  POSTED: new Set(['PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED']),
  PARTIALLY_PAID: new Set(['PAID', 'OVERDUE', 'CANCELLED']),
  PAID: new Set(['CANCELLED', 'VOID']),
  OVERDUE: new Set(['PAID', 'PARTIALLY_PAID', 'CANCELLED']),
  CANCELLED: new Set(),
  VOID: new Set(),
  SENT: new Set(['POSTED', 'CANCELLED']),
  PARTIAL: new Set(['PAID', 'CANCELLED']),
};

/** Reverse transitions (for unpost / un-cancel if needed). */
const REVERSIBLE_TO_DRAFT = new Set(['APPROVED']);

class CustomerBillService {
  constructor(conn) {
    this.conn = conn;
    this.billRepo = new BillRepository(conn);
    this.taxService = new TaxService(conn);
    this.journalRepo = new JournalEntryRepository(conn);
    this.receivableRepo = new ReceivableRepository(conn);
    this.summaryRepo = new ReceivableSummaryRepository(conn);
    this.reportRepo = new ReportingRepository(conn);
    this.collectionsService = new CollectionsService(conn);
    this.coaRepo = new ChartOfAccountsRepository(conn);
    this.creditRepo = new CreditRuleRepository(conn);
    this.fyRepo = new FinancialYearRepository(conn);
    // ── Inventory integration ──
    // The bridge is what makes a posted bill move stock. It is required
    // (not optional) so that a bill can never reach POSTED without its stock
    // effect being decided explicitly by the inventory engine.
    const { InventoryEngine } = require('./inventory-engine.service');
    const { BillInventoryBridge } = require('./bill-inventory-bridge.service');
    this.inventory = new InventoryEngine(conn);
    this.inventoryBridge = new BillInventoryBridge(conn, this.inventory);
  }

  // ─── Status Machine ────────────────────────────────────────────────────
  canTransition(currentStatus, newStatus) {
    const allowed = VALID_TRANSITIONS[currentStatus];
    return allowed ? allowed.has(newStatus) : false;
  }

  // ─── Invoice Number Generation ─────────────────────────────────────────
  generateInvoiceNumber(companyId) {
    return CodeGenerator.generate(this.conn, 'CUSTOMER_BILL', companyId);
  }

  previewInvoiceNumber(companyId) {
    return CodeGenerator.preview(this.conn, 'CUSTOMER_BILL', companyId);
  }

  // ─── Draft / Create ────────────────────────────────────────────────────
  createBill(data, userId) {
    const companyId = data.company_id || 'default';
    const now = new Date().toISOString();
    const billId = generateId('bill');
    const invoiceNumber = data.invoice_number || this.generateInvoiceNumber(companyId);

    // Default due date from payment terms
    const issueDate = data.issue_date || new Date().toISOString().split('T')[0];
    const dueDate = this._calculateDueDate(issueDate, data.payment_terms, data.payment_terms_days);

    const billData = {
      id: billId,
      company_id: companyId,
      bill_number: data.bill_number || invoiceNumber,
      bill_type: 'CUSTOMER',
      contact_id: data.contact_id,
      organization_id: data.organization_id || null,
      currency: data.currency || 'INR',
      status: 'DRAFT',
      issue_date: issueDate,
      due_date: dueDate,
      subtotal: toMoney(data.subtotal || 0),
      tax: toMoney(data.tax || 0),
      discount: toMoney(data.discount || 0),
      total: toMoney(data.total || 0),
      paid_amount: 0,
      balance: toMoney(data.total || 0),
      reference_number: data.reference_number || null,
      notes: data.notes || '',
      terms: data.terms || '',
      invoice_number: invoiceNumber,
      customer_gstin: data.customer_gstin || null,
      billing_address: data.billing_address || null,
      shipping_address: data.shipping_address || null,
      place_of_supply: data.place_of_supply || null,
      customer_po_number: data.customer_po_number || null,
      customer_po_date: data.customer_po_date || null,
      salesperson_id: data.salesperson_id || null,
      sales_channel: data.sales_channel || null,
      payment_terms: data.payment_terms || null,
      price_list_id: data.price_list_id || null,
      branch_id: data.branch_id || null,
      warehouse_id: data.warehouse_id || null,
      project_id: data.project_id || null,
      cost_centre_id: data.cost_centre_id || null,
      is_tax_inclusive: data.is_tax_inclusive ? 1 : 0,
      round_off: toMoney(data.round_off || 0),
      other_charges: toMoney(data.other_charges || 0),
      other_charges_taxable: data.other_charges_taxable ? 1 : 0,
      other_charges_tax_amount: toMoney(data.other_charges_tax_amount || 0),
      discount_amount: toMoney(data.discount_amount || 0),
      line_discount_amount: toMoney(data.line_discount_amount || 0),
      taxable_amount: toMoney(data.taxable_amount || 0),
      tax_master_id: data.tax_master_id || null,
      is_interstate: data.is_interstate ? 1 : 0,
      company_state: data.company_state || null,
      cgst_amount: toMoney(data.cgst_amount || 0),
      sgst_amount: toMoney(data.sgst_amount || 0),
      igst_amount: toMoney(data.igst_amount || 0),
      cgst_rate: toMoney(data.cgst_rate || 0),
      sgst_rate: toMoney(data.sgst_rate || 0),
      igst_rate: toMoney(data.igst_rate || 0),
      idempotency_key: data.idempotency_key || null,
      created_by: userId,
    };

    return this.conn.transaction(() => {
      const result = this.billRepo.createWithItems(billData, (data.lines || data.items || []).map((l) => ({
        quantity: parseFloat(l.quantity) || 1,
        unit_price: toMoney(l.unit_price || 0),
        tax_rate: toMoney(l.tax_rate || 0),
        discount: toMoney(l.discount || 0),
        discount_type: l.discount_type || 'fixed',
        discount_percent: toMoney(l.discount_percent || 0),
        discount_amount: toMoney(l.discount_amount || 0),
        taxable_amount: toMoney(l.taxable_amount || 0),
        total: toMoney(l.total || l.line_total || 0),
        cgst_rate: toMoney(l.cgst_rate || 0),
        sgst_rate: toMoney(l.sgst_rate || 0),
        igst_rate: toMoney(l.igst_rate || 0),
        cess_rate: toMoney(l.cess_rate || 0),
        cess_amount: toMoney(l.cess_amount || 0),
        other_tax: toMoney(l.other_tax || 0),
        tax_master_id: l.tax_master_id || null,
        cgst_amount: toMoney(l.cgst_amount || 0),
        sgst_amount: toMoney(l.sgst_amount || 0),
        igst_amount: toMoney(l.igst_amount || 0),
        line_tax: toMoney(l.line_tax || l.tax_amount || 0),
        line_total: toMoney(l.line_total || l.total || 0),
        warehouse_id: l.warehouse_id || null,
        batch: l.batch || null,
        // Inventory dimensions.
        //
        // These were missing from this mapper even though bill_items has the
        // columns and BillInventoryBridge reads them. Consequences:
        //   * a batch-tracked bill could never satisfy the bridge's "a batch
        //     must be selected" rule, because the chosen batch_id was dropped
        //     on the way in and the bill failed at post time;
        //   * the godown/location the user picked in the bill form was silently
        //     discarded, so every sale fell back to the stock item's own
        //     placement and stock moved out of the wrong godown.
        // Only columns that actually exist on bill_items are forwarded.
        batch_id: l.batch_id || null,
        godown_id: l.godown_id || null,
        location_id: l.location_id || null,
        serial_id: l.serial_id || null,
        serial_number: l.serial_number || null,
        expiry: l.expiry || null,
        project_id: l.project_id || null,
        cost_centre_id: l.cost_centre_id || null,
        gl_account_id: l.gl_account_id || null,
        description: l.description || '',
        product_id: l.product_id || null,
        sku: l.sku || null,
        hsn_sac: l.hsn_sac || null,
        unit: l.unit || 'PCS',
      })));

      this._logAudit(companyId, userId, 'customer_bill', result.id, 'CREATE', null, result);
      return result;
    })();
  }

  // ─── Calculations (tax, discount, totals) ───────────────────────────────
  /**
   * Calculate line items tax, discount, totals. Called by the form for live
   * preview; the backend re-validates on submit. Uses TaxService.calculateTax
   * with paise arithmetic.
   */
  calculateTotals(data) {
    const companyId = data.company_id || 'default';
    const lines = data.items || data.lines || [];
    const discountRules = data.discounts || [];
    const isTaxInclusive = data.is_tax_inclusive;
    const partyState = data.party_state || data.place_of_supply;

    // Per-line calculation
    let subtotalPaise = 0;
    let totalTaxPaise = 0;
    let totalLineDiscountPaise = 0;

    const computedLines = lines.map((line) => {
      const qty = parseFloat(line.quantity) || 1;
      const rate = parseFloat(line.unit_price) || 0;
      const lineTotalPaise = toPaise(qty * rate);
      const lineSubtotal = fromPaise(lineTotalPaise);

      // Item discount
      let itemDiscountAmount = 0;
      let discountPercent = parseFloat(line.discount_percent) || 0;
      if (line.discount_amount) {
        itemDiscountAmount = parseFloat(line.discount_amount);
        discountPercent = (itemDiscountAmount / lineSubtotal) * 100;
      } else if (discountPercent > 0) {
        itemDiscountAmount = fromPaise(Math.round(lineTotalPaise * discountPercent / 100));
      }

      const taxablePaise = toPaise(lineSubtotal - itemDiscountAmount);
      const taxable = fromPaise(taxablePaise);
      const isInclusive = line.is_tax_inclusive || isTaxInclusive;

      let taxResult = null;
      if (line.tax_master_id && taxable > 0) {
        taxResult = this.taxService.calculateTax({
          companyId,
          taxableAmount: taxable,
          taxMasterId: line.tax_master_id,
          partyState: data.party_state,
          companyState: data.company_state || this._getCompanyState(companyId),
        });
      }

      let lineTax = 0;
      let lineGrandTotal = 0;

      if (taxResult && taxResult.total_tax > 0) {
        if (isInclusive) {
          // Tax-inclusive: derive taxable + tax from the inclusive total
          // taxable = grandTotal / (1 + rate/100); tax = grandTotal - taxable
          const rate = taxResult.total_tax / taxable;
          const derivedTaxable = lineSubtotal / (1 + rate / 100);
          lineTax = lineSubtotal - derivedTaxable;
          lineGrandTotal = lineSubtotal;
          taxResult.taxable_amount = derivedTaxable;
          taxResult.grand_total = lineSubtotal;
        } else {
          lineTax = taxResult.total_tax;
          lineGrandTotal = taxResult.grand_total;
        }
      } else {
        lineGrandTotal = taxable;
      }

      subtotalPaise += lineTotalPaise;
      totalTaxPaise += toPaise(lineTax);
      totalLineDiscountPaise += toPaise(itemDiscountAmount);

      return {
        ...line,
        line_subtotal: lineSubtotal,
        discount_percent: discountPercent,
        discount_amount: itemDiscountAmount,
        taxable_amount: taxable,
        tax_result: taxResult,
        cgst_amount: taxResult?.cgst_amount || 0,
        sgst_amount: taxResult?.sgst_amount || 0,
        igst_amount: taxResult?.igst_amount || 0,
        cess_amount: taxResult?.cess_amount || 0,
        line_tax: lineTax,
        line_total: lineGrandTotal,
      };
    });

    // Invoice-level (additional) discount — applied on net of line discounts
    let invoiceDiscountPaise = 0;
    // Calculate the net subtotal (after line discounts) for bill-level discount base
    let netOfLineDiscountPaise = 0;
    for (const d of discountRules) {
      const type = d.type || 'PERCENTAGE';
      const amount = parseFloat(d.amount || 0);
      let discPaise;
      if (type === 'FIXED') {
        discPaise = toPaise(amount);
      } else {
        // Bill discount applies on net of line discounts (subtotal minus line discounts)
        // Recalculate the net base from computed lines
        netOfLineDiscountPaise = computedLines.reduce((sum, l) => {
          const gross = toPaise((parseFloat(l.quantity) || 1) * (parseFloat(l.unit_price) || 0));
          const lineDisc = toPaise(parseFloat(l.discount_amount) || 0);
          return sum + gross - lineDisc;
        }, 0);
        const base = netOfLineDiscountPaise - invoiceDiscountPaise;
        discPaise = Math.round((base * amount) / 100);
      }
      invoiceDiscountPaise += discPaise;
    }
    const invoiceDiscount = fromPaise(invoiceDiscountPaise);

    // Other charges — derive from charges array if not explicitly set
    const chargesInput = Array.isArray(data.charges) ? data.charges : null;
    let otherChargesPaise = toPaise(parseFloat(data.other_charges) || 0);
    if (otherChargesPaise === 0 && chargesInput && chargesInput.length > 0) {
      otherChargesPaise = chargesInput.reduce((sum, ch) => sum + toPaise(parseFloat(ch.amount) || 0), 0);
    }

    // Tax on other charges (if taxable) — supports per-charge tax master
    let otherChargesTax = 0;
    const chargeList = Array.isArray(data.charges) ? data.charges : null;
    if (otherChargesPaise > 0 && (data.other_charges_taxable || chargeList?.some(c => c.taxable))) {
      const companyState = data.company_state || this._getCompanyState(companyId);
      if (chargeList) {
        // Per-charge tax calculation
        for (const ch of chargeList) {
          if (!ch.taxable || !ch.tax_master_id) continue;
          const chAmt = parseFloat(ch.amount) || 0;
          if (chAmt <= 0) continue;
          const ocTax = this.taxService.calculateTax({
            companyId,
            taxableAmount: chAmt,
            taxMasterId: ch.tax_master_id,
            partyState,
            companyState,
          });
          otherChargesTax += ocTax.total_tax || 0;
        }
      } else if (data.tax_master_id) {
        // Backward-compatible single tax master for all charges
        const ocTax = this.taxService.calculateTax({
          companyId,
          taxableAmount: fromPaise(otherChargesPaise),
          taxMasterId: data.tax_master_id,
          partyState,
          companyState,
        });
        otherChargesTax = ocTax.total_tax || 0;
      }
      totalTaxPaise += toPaise(otherChargesTax);
    }

    const subtotal = fromPaise(subtotalPaise);
    const totalLineDiscount = fromPaise(totalLineDiscountPaise);
    const totalTax = fromPaise(totalTaxPaise);
    const otherCharges = fromPaise(otherChargesPaise);
    let grandTotal = subtotal - totalLineDiscount + totalTax + otherCharges - invoiceDiscount;

    // Round off
    const roundOff = Math.round(grandTotal) - grandTotal;
    const roundedTotal = Math.round(grandTotal);

    return {
      subtotal: fromPaise(subtotalPaise),
      discount_amount: invoiceDiscount,
      line_discount_amount: totalLineDiscount,
      other_charges: otherCharges,
      other_charges_tax: otherChargesTax,
      taxable_amount: subtotal - totalLineDiscount - invoiceDiscount + otherCharges,
      total_tax: totalTax,
      round_off: parseFloat(roundOff.toFixed(2)),
      grand_total: roundedTotal,
      items: computedLines,
    };
  }

  // ─── Submit for Approval ────────────────────────────────────────────────
  submitForApproval(billId, companyId, userId) {
    const bill = this.billRepo.findById(billId, companyId);
    if (!bill) throw new NotFoundError('Bill', billId);
    if (!this.canTransition(bill.status, 'PENDING_APPROVAL')) {
      throw new AppError(`Cannot transition from ${bill.status} to PENDING_APPROVAL`, 'INVALID_STATE', 400);
    }
    this._updateBillStatus(billId, companyId, 'PENDING_APPROVAL', userId, 'SUBMIT');
    return this.billRepo.findById(billId, companyId);
  }

  // ─── Approve ────────────────────────────────────────────────────────────
  approveBill(billId, companyId, userId, approvalData = {}) {
    const bill = this.billRepo.findById(billId, companyId);
    if (!bill) throw new NotFoundError('Bill', billId);
    if (!this.canTransition(bill.status, 'APPROVED')) {
      throw new AppError(`Cannot transition from ${bill.status} to APPROVED`, 'INVALID_STATE', 400);
    }
    this.conn.transaction(() => {
      this._updateBillStatus(billId, companyId, 'APPROVED', userId, 'APPROVE');
      const now = new Date().toISOString();
      this.conn.prepare(`
        INSERT INTO bill_approvals (id, company_id, bill_id, approver_id, status, comments, created_at)
        VALUES (?, ?, ?, ?, 'APPROVED', ?, ?)
      `).run(generateId('ba'), companyId, billId, userId, approvalData.comments || null, now);
    })();
    return this.billRepo.findById(billId, companyId);
  }

  // ─── Post (create JE) ───────────────────────────────────────────────────
  postBill(billId, companyId, userId, idempotencyKey = null, context = null) {
    const bill = this.billRepo.findById(billId, companyId);
    if (!bill) throw new NotFoundError('Bill', billId);

    if (bill.status === 'POSTED' || bill.status === 'PARTIALLY_PAID' || bill.status === 'PAID' || bill.status === 'OVERDUE') {
      if (bill.posted_at) throw new ConflictError('Bill is already posted');
    }

    if (!this.canTransition(bill.status, 'POSTED')) {
      throw new AppError(`Cannot post bill in status ${bill.status}`, 'INVALID_STATE', 400);
    }

    // Idempotency: if an idempotency key was provided and already used for posting, return existing
    if (idempotencyKey) {
      const existing = this.conn.get(
        'SELECT id FROM bills WHERE idempotency_key = ? AND company_id = ? AND status IN (?, ?, ?, ?)',
        [idempotencyKey, companyId, 'POSTED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE']
      );
      if (existing && existing.id !== billId) {
        throw new ConflictError(`Bill already posted with this idempotency key: ${existing.id}`);
      }
    }

    // Resolve account mappings
    const mappings = this._resolveAccountMappings(companyId);

    // -- Inventory preflight, run BEFORE the transaction opens ------------
    // Read-only, so it is safe here. Doing it up front means a stock problem is
    // reported as a clear business error instead of a constraint failure part
    // way through posting, and nothing has been written yet when it throws.
    const inventoryPlan = this.inventoryBridge.preflight(bill, companyId);

    // Build JE lines
    const jeLines = this._buildBillJELines(bill, mappings, userId);

    // PHASE 3A FY-2 — centralised financial-year lock policy.
    // getByDate() resolves the year but does not enforce is_locked, so
    // every posting path must apply the same rule. Runs BEFORE the
    // transaction opens, so a refusal writes nothing.
    const fyForLock = this.fyRepo.getByDate(bill.issue_date, companyId);
    const fyLock = evaluateFinancialYearLock({ fy: fyForLock, context: context || {} });
    if (fyLock.blocked) throw new AppError(fyLock.reason, 'FY_LOCKED', 400);

    return this.conn.transaction(() => {
      // Create the journal entry (validated for balance)
      const jeEntryNumber = `JV-${bill.invoice_number}`;
      const journalEntry = this.journalRepo.createWithValidation({
        id: generateId('je'),
        company_id: companyId,
        voucher_id: null, // bills don't use vouchers directly
        entry_number: jeEntryNumber,
        entry_date: bill.issue_date,
        description: `Customer Bill ${bill.bill_number} - ${bill.notes || ''}`.trim(),
        currency: bill.currency || 'INR',
        exchange_rate: bill.exchange_rate || 1.0,
        status: 'POSTED',
        created_by: userId,
        financial_year_id: this.fyRepo.getByDate(bill.issue_date, companyId)?.id || null,
      }, jeLines);

      // Update bill: link journal entry, mark posted
      const now = new Date().toISOString();
      this.conn.prepare(`
        UPDATE bills SET status = ?, journal_entry_id = ?, posted_by = ?, posted_at = ?
        WHERE id = ? AND company_id = ?
      `).run(
        'POSTED', journalEntry.id, userId, now,
        billId, companyId
      );

      // -- Inventory: move stock exactly once ----------------------------
      // Any failure here throws and rolls back the journal entry and the bill
      // status above, so POSTED is never observable without its stock effect.
      // Idempotency is enforced twice over: by the early return in
      // postForBill(), and by the uq_ivh_one_per_source_document unique index.
      let inventoryResult = null;
      if (inventoryPlan.entries.length > 0) {
        inventoryResult = this.inventoryBridge.postForBill(bill, {
          companyId,
          userId,
          voucherDate: bill.issue_date,
        });

        if (inventoryResult && !inventoryResult.alreadyPosted) {
          this.conn.run(
            'UPDATE bills SET inventory_voucher_header_id = ? WHERE id = ? AND company_id = ?',
            [inventoryResult.voucher.id, billId, companyId]
          );

          // COGS and the inventory-asset credit go into the SAME journal entry,
          // using the exact cost the inventory engine applied.
          const cogsLines = this._buildCogsLines(inventoryResult, mappings, companyId);
          if (cogsLines.length > 0) {
            this.journalRepo.appendLines(journalEntry.id, companyId, cogsLines);
          }
        }
      }

      // Update or create receivable record
      this._upsertReceivable(billId, companyId, 'POSTED');
      this._logAudit(companyId, userId, 'customer_bill', billId, 'POST', null, {
        journal_entry_id: journalEntry.id,
        status: 'POSTED',
        inventory_voucher_header_id: inventoryResult ? inventoryResult.voucher.id : null,
        stock_lines: inventoryResult ? inventoryResult.entries.length : 0,
        non_stock_lines: inventoryResult ? inventoryResult.skipped.length : 0,
      });

      const posted = this.billRepo.findById(billId, companyId);
      posted.balance = toMoney(bill.total) - toMoney(bill.paid_amount || 0);
      posted.journal_entry = journalEntry;
      posted.inventory = inventoryResult
        ? {
            voucher_id: inventoryResult.voucher.id,
            voucher_number: inventoryResult.voucher.voucher_number,
            stock_lines: inventoryResult.entries.length,
            skipped_lines: inventoryResult.skipped.length,
            valuation: inventoryResult.valuation,
          }
        : { stock_lines: 0, skipped_lines: inventoryPlan.skipped.length };
      return posted;
    })();
  }

  /**
   * Build the COGS half of a bill's journal entry.
   *
   *     Debit   COGS              (cost of goods sold)
   *     Credit  Inventory asset   (the stock item's asset account)
   *
   * The amount is the cost the inventory engine ACTUALLY applied when it moved
   * the stock, read from the post's valuation result rather than recomputed
   * here. That is what guarantees the accounting entry and the stock ledger can
   * never disagree.
   */
  _buildCogsLines(inventoryResult, mappings, companyId) {
    const lines = [];
    const valuation = (inventoryResult && inventoryResult.valuation) || [];

    // Group by (COGS account, asset account) so each pair yields one line pair.
    const grouped = new Map();
    for (const v of valuation) {
      const cost = Math.abs(parseFloat(v.cost_out || 0) || 0);
      if (cost === 0) continue;
      const stockItem = this.conn.get(
        'SELECT cogs_account_id, stock_asset_account_id FROM stock_items WHERE id = ? AND company_id = ?',
        [v.item_id, companyId]
      );
      const cogsAccount = (stockItem && stockItem.cogs_account_id) || mappings.cogs;
      const assetAccount = (stockItem && stockItem.stock_asset_account_id) || mappings.inventoryAsset;
      if (!cogsAccount || !assetAccount) continue;
      const key = `${cogsAccount}:${assetAccount}`;
      grouped.set(key, (grouped.get(key) || 0) + cost);
    }

    for (const [key, amount] of grouped) {
      const [cogsAccount, assetAccount] = key.split(':');
      lines.push({
        account_id: cogsAccount,
        debit_amount: amount,
        credit_amount: 0,
        description: 'Cost of goods sold - customer bill',
      });
      lines.push({
        account_id: assetAccount,
        debit_amount: 0,
        credit_amount: amount,
        description: 'Inventory reduction - customer bill',
      });
    }
    return lines;
  }
  // ─── JE Line Builder ────────────────────────────────────────────────────
  _buildBillJELines(bill, mappings, userId) {
    const lines = [];
    const narration = `Customer Bill ${bill.bill_number}`;
    const totalPaise = toPaise(bill.total);

    // Debit: Customer Receivable
    lines.push({
      account_id: mappings.receivable,
      debit_amount: bill.total,
      credit_amount: 0,
      description: narration,
      reference_id: bill.invoice_number,
    });

    // Credit: Sales Revenue (line-level or aggregate)
    const salesRevenue = this._aggregateByAccount(bill, 'sales');
    for (const [accountId, amount] of Object.entries(salesRevenue)) {
      lines.push({
        account_id: accountId,
        debit_amount: 0,
        credit_amount: amount,
        description: narration,
        reference_id: bill.invoice_number,
      });
    }

    // Credit: Tax output (CGST, SGST, IGST, CESS) — using the tax engine's JE builder
    const taxResult = this._getBillTaxResult(bill);
    if (taxResult && taxResult.total_tax > 0) {
      const taxLines = this.taxService.buildTaxJELines(taxResult, bill.company_id || 'default', narration);
      taxLines.forEach((tl) => {
        tl.reference_id = bill.invoice_number;
        lines.push(tl);
      });
    }

    // Credit: Discount (if any)
    if (parseFloat(bill.discount || 0) > 0 && mappings.discount) {
      lines.push({
        account_id: mappings.discount,
        debit_amount: 0,
        credit_amount: bill.discount,
        description: `Discount - ${narration}`,
        reference_id: bill.invoice_number,
      });
    }

    // Credit: Other charges (if any)
    if (parseFloat(bill.other_charges || 0) > 0 && mappings.otherCharges) {
      lines.push({
        account_id: mappings.otherCharges,
        debit_amount: 0,
        credit_amount: bill.other_charges,
        description: `Other charges - ${narration}`,
        reference_id: bill.invoice_number,
      });
    }

    // Round off (if non-zero)
    if (parseFloat(bill.round_off || 0) !== 0) {
      const roundAcc = mappings.roundOff || mappings.receivable;
      const roundAmount = bill.round_off;
      if (roundAmount > 0) {
        lines.push({ account_id: roundAcc, debit_amount: 0, credit_amount: roundAmount, description: 'Round off', reference_id: bill.invoice_number });
      } else {
        lines.push({ account_id: roundAcc, debit_amount: Math.abs(roundAmount), credit_amount: 0, description: 'Round off', reference_id: bill.invoice_number });
      }
    }

    return lines;
  }

  // ─── Account Mapping Resolution ─────────────────────────────────────────
  _resolveAccountMappings(companyId) {
    const company = companyId || 'default';
    const result = {};

    // Receivable: prefer the seeded acc_receivable, fall back to ASSET accounts
    result.receivable = 'acc_receivable';
    const ar = this.conn.get('SELECT id FROM accounts WHERE id = ? AND company_id = ?', [result.receivable, company]);
    if (!ar) {
      const fallback = this.conn.get('SELECT id FROM accounts WHERE company_id = ? AND type = ? LIMIT 1', [company, 'ASSET']);
      if (!fallback) throw new AppError('No Accounts Receivable ledger account found. Configure account mapping.', 'MISSING_ACCOUNT', 400);
      result.receivable = fallback.id;
    }

    // Sales revenue (default 4001/acc_sales)
    result.sales = 'acc_sales';
    const sales = this.conn.get('SELECT id FROM accounts WHERE id = ? AND company_id = ?', [result.sales, company]);
    if (!sales) {
      const fallback = this.conn.get('SELECT id FROM accounts WHERE company_id = ? AND type = ? AND name LIKE ? LIMIT 1', [company, 'INCOME', '%Sales%']);
      if (!fallback) throw new AppError('No Sales Revenue account found. Configure account mapping.', 'MISSING_ACCOUNT', 400);
      result.sales = fallback.id;
    }

    // Sales returns (contra revenue)
    const sr = this.conn.get("SELECT id FROM accounts WHERE id = 'acc_sales_returns' AND company_id = ?", [company]);
    result.salesReturns = sr ? sr.id : null;

    // ── Inventory accounts (used for COGS when a bill moves stock) ──
    // These are deliberately OPTIONAL: a bill for service-only lines, or a
    // company that has not mapped inventory accounts yet, must still be able to
    // post. _buildCogsLines emits no COGS lines when they are absent rather than
    // failing the whole posting.
    result.cogs = this.conn.get(
      "SELECT id FROM accounts WHERE id = 'acc_cogs' AND company_id = ?", [company]
    )?.id
      || this._findAccount(company, ['COGS', 'COST OF GOODS', 'cost of sales'], 'EXPENSE');
    result.inventoryAsset = this.conn.get(
      "SELECT id FROM accounts WHERE id = 'acc_inventory' AND company_id = ?", [company]
    )?.id
      || this._findAccount(company, ['INVENTORY', 'STOCK', 'CLOSING STOCK', 'CLOSING'], 'ASSET');
    result.inventoryVariance = this._findAccount(
      company, ['VARIANCE', 'SHRINKAGE', 'stock variance'], 'EXPENSE');

    // Discount
    result.discount = this._findAccount(company, ['DISCOUNT', 'disc'], 'INCOME');

    // Other charges / freight (EXPENSE) or other income (INCOME) for debit notes
    result.otherCharges = this._findAccount(company, ['FREIGHT', 'other', 'charges'], 'EXPENSE');
    result.otherIncome = this._findAccount(company, ['OTHER INCOME', 'MISCELLANEOUS', 'misc', 'other income'], 'INCOME');
    result.writeOff = this._findAccount(company, ['BAD DEBT', 'bad', 'doubtful'], 'EXPENSE');

    // Round off
    result.roundOff = this._findAccount(company, ['ROUND'], 'EXPENSE') || result.receivable;

    // Cash/Bank for receipts
    result.bank = this._findAccount(company, [], 'BANK') || this._findAccount(company, [], 'CASH');

    return result;
  }

  _findAccount(companyId, nameKeywords, type) {
    const company = companyId || 'default';
    let sql = 'SELECT id FROM accounts WHERE company_id = ? AND type = ?';
    const params = [company, type];
    if (nameKeywords.length > 0) {
      sql += ' AND (';
      const ors = [];
      for (const kw of nameKeywords) {
        ors.push('name LIKE ?');
        params.push('%' + kw + '%');
      }
      sql += ors.join(' OR ') + ')';
    }
    sql += ' LIMIT 1';
    const acc = this.conn.get(sql, params);
    return acc?.id || null;
  }

  // ─── Receivable management ──────────────────────────────────────────────
  _upsertReceivable(billId, companyId, status) {
    const bill = this.billRepo.findById(billId, companyId);
    if (!bill) return;
    const daysOverdue = this._daysOverdue(bill.due_date);
    const now = new Date().toISOString();

    const existing = this.conn.get('SELECT id FROM receivables WHERE bill_id = ? AND company_id = ?', [billId, companyId]);
    const outstanding = toMoney(bill.total) - toMoney(bill.paid_amount || 0);
    const calcStatus = outstanding <= 0 ? 'PAID' : (daysOverdue > 0 ? 'OVERDUE' : (bill.status === 'POSTED' ? 'CURRENT' : status));

    if (existing) {
      this.conn.prepare(`
        UPDATE receivables SET original_amount = ?, paid_amount = ?, outstanding_amount = ?,
          status = ?, days_overdue = ?, updated_at = ?
        WHERE id = ? AND company_id = ?
      `).run(bill.total, bill.paid_amount || 0, outstanding, calcStatus, daysOverdue, now, existing.id, companyId);
    } else {
      this.conn.prepare(`
        INSERT INTO receivables (id, company_id, bill_id, contact_id, organization_id,
          due_date, original_amount, paid_amount, outstanding_amount, currency, status,
          days_overdue, credit_limit, credit_period_days, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        generateId('rec'), companyId, billId, bill.contact_id, bill.organization_id,
        bill.due_date, bill.total, bill.paid_amount || 0, outstanding,
        bill.currency || 'INR', calcStatus, daysOverdue, 0, 30
      );
    }
  }

  // ─── Payment Recording & Allocation ─────────────────────────────────────
  recordPayment(data, userId, context = null) {
    const companyId = data.company_id || 'default';
    const now = new Date().toISOString();
    const amount = toMoney(data.amount);
    if (amount <= 0) throw new ValidationError('Payment amount must be greater than zero');

    // PHASE 3A FY-2 — centralised financial-year lock policy.
    // getByDate() resolves the year but does not enforce is_locked, so
    // every posting path must apply the same rule. Runs BEFORE the
    // transaction opens, so a refusal writes nothing.
    const fyForLock = this.fyRepo.getByDate(data.payment_date || now.split('T')[0], companyId);
    const fyLock = evaluateFinancialYearLock({ fy: fyForLock, context: context || {} });
    if (fyLock.blocked) throw new AppError(fyLock.reason, 'FY_LOCKED', 400);

    return this.conn.transaction(() => {
      // Create payment record
      const paymentId = generateId('pym');
      const paymentNumber = CodeGenerator.generate(this.conn, 'CUSTOMER_RECEIPT', companyId);
      this.conn.prepare(`
        INSERT INTO payments (id, company_id, bill_id, contact_id, amount, payment_date,
          payment_method, reference_number, notes, payment_number, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        paymentId, companyId, data.bill_id || null, data.contact_id, amount,
        data.payment_date || now.split('T')[0], data.payment_method || 'BANK',
        data.reference_number || null, data.notes || '',
        paymentNumber
      );

      // Resolve payment account (bank/cash) from request
      const bankAcc = data.payment_account_id;
      if (!bankAcc) {
        throw new AppError('Payment account (bank/cash) is required for payment recording.', 'MISSING_ACCOUNT', 400);
      }

      // Create JE: Dr Bank/Cash, Cr Receivable
      const jeLines = [];
      jeLines.push({
        account_id: bankAcc,
        debit_amount: amount,
        credit_amount: 0,
        description: `Payment received ${data.payment_method || ''}`,
        reference_id: data.reference_number || null,
      });
      jeLines.push({
        account_id: 'acc_receivable', // could be per-customer AR sub-ledger
        debit_amount: 0,
        credit_amount: amount,
        description: `Payment from ${data.contact_id || ''}`,
        reference_id: data.reference_number || null,
      });

      const journalEntry = this.journalRepo.createWithValidation({
        id: generateId('je'),
        company_id: companyId,
        voucher_id: null,
        entry_number: `JE-${paymentId}`,
        entry_date: data.payment_date || now.split('T')[0],
        description: 'Customer payment received',
        currency: data.currency || 'INR',
        exchange_rate: data.exchange_rate || 1.0,
        status: 'POSTED',
        created_by: userId,
        financial_year_id: this.fyRepo.getByDate(data.payment_date || now.split('T')[0], companyId)?.id || null,
      }, jeLines);

      // Allocate payment to bills (explicit allocations take priority)
      let allocated = 0;
      if (data.allocations && data.allocations.length > 0) {
        for (const alloc of data.allocations) {
          const allocAmount = toMoney(alloc.amount);
          if (allocAmount <= 0) continue;
          // Validate the bill exists, is posted, and belongs to the same contact
          const allocBill = this.billRepo.findById(alloc.bill_id, companyId);
          if (!allocBill) throw new NotFoundError('Bill', alloc.bill_id);
          if (allocBill.bill_type !== 'CUSTOMER') throw new ValidationError('Allocation bill must be a customer bill');
          if (['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CANCELLED', 'VOID', 'SENT'].includes(allocBill.status)) {
            throw new AppError(`Cannot allocate to bill in status ${allocBill.status}`, 'INVALID_STATE', 400);
          }
          if (allocBill.contact_id !== data.contact_id) {
            throw new ValidationError('Cannot allocate payment to a bill for a different customer');
          }
          // Validate allocation does not exceed bill outstanding
          const billOutstanding = Math.max(toMoney(allocBill.total) - toMoney(allocBill.paid_amount), 0);
          if (allocAmount > billOutstanding + 0.01) {
            throw new ValidationError(`Allocation amount (${allocAmount}) exceeds bill outstanding (${billOutstanding})`);
          }
          this._createBillAllocation(alloc.bill_id, journalEntry.id, allocAmount, now, companyId);
          allocated += allocAmount;
          this._updateBillPayment(alloc.bill_id, allocAmount, companyId);
        }
        // Validate total allocated does not exceed payment amount
        if (allocated > amount + 0.01) {
          throw new ValidationError(`Total allocated (${allocated}) exceeds payment amount (${amount})`);
        }
        // Update receivable for each allocated bill
        for (const alloc of data.allocations) {
          this.receivableRepo.recalcFromAllocations(alloc.bill_id, companyId);
        }
      } else if (data.bill_id) {
        // Auto-allocate to the specified bill — cap at bill outstanding to prevent negative balance
        const bill = this.billRepo.findById(data.bill_id, companyId);
        if (!bill) throw new NotFoundError('Bill', data.bill_id);
        if (['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CANCELLED', 'VOID', 'SENT'].includes(bill.status)) {
          throw new AppError(`Cannot allocate to bill in status ${bill.status}`, 'INVALID_STATE', 400);
        }
        if (bill.bill_type !== 'CUSTOMER') throw new ValidationError('Bill must be a customer bill');
        const billOutstanding = Math.max(toMoney(bill.total) - toMoney(bill.paid_amount), 0);
        const allocAmount = Math.min(amount, billOutstanding);
        this._createBillAllocation(data.bill_id, journalEntry.id, allocAmount, now, companyId);
        this._updateBillPayment(data.bill_id, allocAmount, companyId);
        allocated = allocAmount;
      }

      // Update receivable
      if (data.bill_id) {
        this.receivableRepo.recalcFromAllocations(data.bill_id, companyId);
      }

      this._logAudit(companyId, userId, 'customer_payment', paymentId, 'RECORD', null,
        { amount, bill_id: data.bill_id, journal_entry_id: journalEntry.id });

      return { payment_id: paymentId, payment_number: paymentNumber, allocated, journal_entry: journalEntry };
    })();
  }

  _createBillAllocation(billId, journalEntryId, amount, dateStr, companyId) {
    this.conn.prepare(`
      INSERT INTO bill_allocations (id, company_id, bill_id, journal_entry_id, amount, allocation_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(generateId('ba'), companyId, billId, journalEntryId, amount, dateStr, dateStr);
  }

  // ─── Payment Allocation ─────────────────────────────────────────────────
  /**
   * Allocate an existing payment to one or more bills. Allows re-allocation
   * of overpayments or partial payments across outstanding invoices.
   */
  allocatePayment(data, userId) {
    const companyId = data.company_id || 'default';
    const now = new Date().toISOString();
    const allocations = data.allocations || [];

    return this.conn.transaction(() => {
      let totalAllocated = 0;
      for (const alloc of allocations) {
        const amount = toMoney(alloc.amount);
        if (amount <= 0) continue;

        // Verify the bill exists and is posted
        const bill = this.billRepo.findById(alloc.bill_id, companyId);
        if (!bill) throw new NotFoundError('Bill', alloc.bill_id);
        if (bill.status !== 'POSTED' && bill.status !== 'PARTIALLY_PAID' && bill.status !== 'OVERDUE') {
          throw new AppError(`Cannot allocate to bill in status ${bill.status}`, 'INVALID_STATE', 400);
        }

        // Verify the payment exists and is unallocated
        const payment = this.conn.get(`
          SELECT id, amount, contact_id FROM payments WHERE id = ? AND company_id = ?
        `, [alloc.payment_id, companyId]);
        if (!payment) throw new NotFoundError('Payment', alloc.payment_id);
        if (payment.contact_id !== bill.contact_id) {
          throw new ValidationError('Payment contact does not match bill contact');
        }

        this._createBillAllocation(alloc.bill_id, null, amount, now.split('T')[0], companyId);
        this._updateBillPayment(alloc.bill_id, amount, companyId);
        this.receivableRepo.recalcFromAllocations(alloc.bill_id, companyId);
        totalAllocated += amount;
      }

      this._logAudit(companyId, userId, 'payment_allocation', data.payment_id || 'bulk', 'ALLOCATE', null,
        { allocations, total_allocated: totalAllocated });

      return { allocated: totalAllocated, allocations };
    })();
  }

  // ─── Reconciliation ─────────────────────────────────────────────────────
  /**
   * Reconcile a customer payment against a bank statement.
   * Marks a payment as reconciled and creates a reconciliation record.
   */
  reconcile(data, userId) {
    const companyId = data.company_id || 'default';
    const now = new Date().toISOString();

    return this.conn.transaction(() => {
      // Verify payment exists
      const payment = this.conn.get(`
        SELECT id, amount, payment_method, payment_date, contact_id
        FROM payments WHERE id = ? AND company_id = ?
      `, [data.payment_id, companyId]);
      if (!payment) throw new NotFoundError('Payment', data.payment_id);

      // Verify bill exists (optional for reconciliation)
      let bill = null;
      if (data.bill_id) {
        bill = this.billRepo.findById(data.bill_id, companyId);
        if (!bill) throw new NotFoundError('Bill', data.bill_id);
      }

      // Check if bank account exists
      const bankAcc = data.bank_account_id;
      if (!bankAcc) {
        throw new AppError('Bank account is required for reconciliation', 'VALIDATION_ERROR', 400);
      }

      // Create reconciliation record
      const reconId = generateId('rec');
      this.conn.prepare(`
        INSERT INTO payment_reconciliations (id, company_id, payment_id, bill_id, bank_account_id,
          reconciled_amount, reconciled_date, statement_reference, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(reconId, companyId, data.payment_id, data.bill_id || null, bankAcc,
        toMoney(data.amount || payment.amount), data.reconciled_date || now.split('T')[0],
        data.statement_reference || null, userId, now);

      this._logAudit(companyId, userId, 'reconciliation', data.payment_id, 'RECONCILE', null,
        { bank_account_id: bankAcc, amount: data.amount || payment.amount });

      return {
        id: reconId,
        payment_id: data.payment_id,
        bill_id: data.bill_id || null,
        reconciled_amount: toMoney(data.amount || payment.amount),
        bank_account_id: bankAcc,
        statement_reference: data.statement_reference || null,
      };
    })();
  }

  // ─── Write-off ───────────────────────────────────────────────────────────
  /**
   * Write off a customer's outstanding balance as bad debt.
   * Creates a reversing JE and marks the bill/amount as written off.
   */
  writeOff(data, userId, context = null) {
    const companyId = data.company_id || 'default';
    const billId = data.bill_id;
    const amount = toMoney(data.amount || 0);
    const now = new Date().toISOString();
    const reason = data.reason || 'Bad debt write-off';

    // PHASE 3A FY-2 — centralised financial-year lock policy.
    // getByDate() resolves the year but does not enforce is_locked, so
    // every posting path must apply the same rule. Runs BEFORE the
    // transaction opens, so a refusal writes nothing.
    const fyForLock = this.fyRepo.getByDate(now.split('T')[0], companyId);
    const fyLock = evaluateFinancialYearLock({ fy: fyForLock, context: context || {} });
    if (fyLock.blocked) throw new AppError(fyLock.reason, 'FY_LOCKED', 400);

    return this.conn.transaction(() => {
      const bill = this.billRepo.findById(billId, companyId);
      if (!bill) throw new NotFoundError('Bill', billId);
      if (bill.status !== 'POSTED' && bill.status !== 'PARTIALLY_PAID' && bill.status !== 'OVERDUE') {
        throw new AppError(`Cannot write off bill in status ${bill.status}`, 'INVALID_STATE', 400);
      }

      if (amount <= 0 || amount > toMoney(bill.balance || 0)) {
        throw new AppError(`Write-off amount must be between 0 and ${bill.balance}`, 'INVALID_AMOUNT', 400);
      }

      const mappings = this._resolveAccountMappings(companyId);
      const badDebtAcc = mappings.writeOff || this._findAccount(companyId, ['BAD DEBT', 'bad', 'doubtful'], 'EXPENSE') || mappings.receivable;

      // JE: Dr Bad Debt Expense (or Loss), Cr Receivable
      const jeLines = [
        {
          account_id: badDebtAcc,
          debit_amount: amount,
          credit_amount: 0,
          description: `Bad debt write-off - ${bill.bill_number}`,
          reference_id: bill.invoice_number,
        },
        {
          account_id: mappings.receivable,
          debit_amount: 0,
          credit_amount: amount,
          description: `Bad debt write-off - ${bill.bill_number}`,
          reference_id: bill.invoice_number,
        },
      ];

      const journalEntry = this.journalRepo.createWithValidation({
        id: generateId('je'),
        company_id: companyId,
        voucher_id: null,
        entry_number: `WO-${bill.invoice_number}`,
        entry_date: now.split('T')[0],
        description: `Bad debt write-off for ${bill.bill_number}`,
        currency: bill.currency || 'INR',
        exchange_rate: 1.0,
        status: 'POSTED',
        created_by: userId,
        financial_year_id: this.fyRepo.getByDate(now.split('T')[0], companyId)?.id || null,
      }, jeLines);

      // Update bill status
      const newBalance = toMoney(bill.balance || 0) - amount;
      let newStatus = bill.status;
      if (newBalance <= 0.01) newStatus = 'WRITTEN_OFF';
      else newStatus = 'WRITTEN_OFF'; // Mark as written off; balance still tracked

      this.conn.prepare(`
        UPDATE bills SET status = ?, balance = ?, paid_amount = ?, updated_at = datetime('now')
        WHERE id = ? AND company_id = ?
      `).run('WRITTEN_OFF', toMoney(bill.total) - newBalance, toMoney(bill.total) - newBalance, billId, companyId);

      // Record the write-off
      const writeOffId = generateId('wo');
      this.conn.prepare(`
        INSERT INTO customer_bill_writeoffs (id, company_id, bill_id, amount, reason,
          journal_entry_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(writeOffId, companyId, billId, amount, reason, journalEntry.id, userId, now, now);

      this._upsertReceivable(billId, companyId, 'WRITTEN_OFF');
      this._logAudit(companyId, userId, 'customer_bill', billId, 'WRITEOFF', null,
        { amount, journal_entry_id: journalEntry.id, status: 'WRITTEN_OFF' });

      return {
        id: writeOffId,
        bill_id: billId,
        amount: amount,
        reason: reason,
        journal_entry: journalEntry,
      };
    })();
  }

  // ─── Dispute ─────────────────────────────────────────────────────────────
  /**
   * Raise a dispute on a customer bill. The bill status changes to OVERDUE
   * (disputed) and the dispute is logged for follow-up.
   */
  dispute(billId, data, userId) {
    const companyId = data.company_id || 'default';
    const reason = data.reason || 'Disputed by customer';
    const now = new Date().toISOString();

    return this.conn.transaction(() => {
      const bill = this.billRepo.findById(billId, companyId);
      if (!bill) throw new NotFoundError('Bill', billId);
      if (bill.status !== 'POSTED' && bill.status !== 'PARTIALLY_PAID' && bill.status !== 'OVERDUE') {
        throw new AppError(`Cannot dispute bill in status ${bill.status}`, 'INVALID_STATE', 400);
      }

      this.conn.prepare(`
        UPDATE bills SET status = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?
      `).run('OVERDUE', billId, companyId);

      // Record dispute
      const disputeId = generateId('dis');
      this.conn.prepare(`
        INSERT INTO customer_bill_disputes (id, company_id, bill_id, reason, amount,
          disputed_at, resolved_at, resolution, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      `).run(disputeId, companyId, billId, reason, toMoney(bill.balance || 0),
        now, userId, now);

      this._logAudit(companyId, userId, 'customer_bill', billId, 'DISPUTE', null,
        { reason, amount: bill.balance });

      return {
        id: disputeId,
        bill_id: billId,
        reason,
        amount: toMoney(bill.balance || 0),
        status: 'DISPUTED',
      };
    })();
  }

  // ─── Write-off (existing method renamed for conflict resolution) ─────────
  // Note: writeOff method above handles individual bill write-offs.
  // The following is for resolving disputes.
  resolveDispute(disputeId, data, userId) {
    const companyId = data.company_id || 'default';
    const resolution = data.resolution || 'Resolved';
    const now = new Date().toISOString();

    return this.conn.transaction(() => {
      const dispute = this.conn.get(
        'SELECT * FROM customer_bill_disputes WHERE id = ? AND company_id = ?',
        [disputeId, companyId]
      );
      if (!dispute) throw new NotFoundError('Dispute', disputeId);

      this.conn.prepare(`
        UPDATE customer_bill_disputes SET resolved_at = ?, resolution = ?, updated_at = ?
        WHERE id = ? AND company_id = ?
      `).run(now, resolution, now, disputeId, companyId);

      // Restore bill status to POSTED/OVERDUE (from OVERDUE/disputed)
      const bill = this.billRepo.findById(dispute.bill_id, companyId);
      if (bill && bill.status === 'OVERDUE') {
        this.conn.prepare(`
          UPDATE bills SET status = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?
        `).run('POSTED', dispute.bill_id, companyId);
      }

      this._logAudit(companyId, userId, 'customer_bill', dispute.bill_id, 'RESOLVE_DISPUTE', null,
        { dispute_id: disputeId, resolution });

      return {
        id: disputeId,
        bill_id: dispute.bill_id,
        resolution,
        resolved_at: now,
      };
    })();
  }

  _updateBillPayment(billId, paymentAmount, companyId) {
    const bill = this.billRepo.findById(billId, companyId);
    if (!bill) return;
    const newPaid = toMoney(bill.paid_amount || 0) + paymentAmount;
    const billTotal = toMoney(bill.total);
    // Cap paid_amount at bill total — never exceed original invoice total
    const cappedPaid = Math.min(newPaid, billTotal);
    const newBalance = Math.max(billTotal - cappedPaid, 0);
    let newStatus;
    if (newBalance <= 0.01) newStatus = 'PAID';
    else if (cappedPaid > 0) newStatus = 'PARTIALLY_PAID';
    else newStatus = bill.status;

    this.conn.prepare(`
      UPDATE bills SET paid_amount = ?, balance = ?, status = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?
    `).run(cappedPaid, newBalance, newStatus, billId, companyId);
  }

  // ─── Credit Note ────────────────────────────────────────────────────────
  createCreditNote(data, userId, context = null) {
    const companyId = data.company_id || 'default';
    const originalBill = this.billRepo.findById(data.original_bill_id, companyId);
    if (!originalBill) throw new NotFoundError('Bill', data.original_bill_id);

    // Validation: Company isolation (bill found in same company by BillRepository)
    // Validation: Bill belongs to selected customer
    if (originalBill.contact_id !== data.contact_id) {
      throw new ValidationError(`Original bill does not belong to contact ${data.contact_id}`);
    }

    // Validation: Bill is eligible for credit note (not CANCELLED/VOID)
    if (['CANCELLED', 'VOID'].includes(originalBill.status)) {
      throw new AppError(`Cannot create credit note for bill in status ${originalBill.status}`, 'INVALID_STATE', 400);
    }

    // Validation: Idempotency — prevent duplicate credit note creation
    if (data.idempotency_key) {
      const existing = this.conn.get(
        'SELECT id, voucher_number FROM vouchers WHERE idempotency_key = ? AND company_id = ? AND voucher_type = ?',
        [data.idempotency_key, companyId, 'CREDIT_NOTE']
      );
      if (existing) {
        throw new ConflictError(`Credit note already created with this idempotency key: ${existing.voucher_number}`);
      }
    }

    const cnNumber = CodeGenerator.generate(this.conn, 'CREDIT_NOTE', companyId);

    // If line items provided, calculate from lines (line-level credit note)
    // Otherwise use flat amount (full or partial credit note)
    let cnTotal, taxableAmount, taxResult, cnItems;

    if (data.items && Array.isArray(data.items)) {
      // Line-level credit note: calculate totals from items
      const calculated = this.calculateTotals({
        company_id: companyId,
        items: data.items,
        party_state: data.party_state || originalBill.place_of_supply,
        company_state: data.company_state || this._getCompanyState(companyId),
        is_tax_inclusive: data.is_tax_inclusive || originalBill.is_tax_inclusive,
        other_charges: data.other_charges || 0,
        other_charges_taxable: data.other_charges_taxable || 0,
        discounts: data.discounts || [],
        charges: data.charges || [],
      });
      cnTotal = calculated.grand_total;
      taxableAmount = calculated.taxable_amount || calculated.subtotal;
      taxResult = calculated.items.length > 0 ? calculated.items[0].tax_result : null;
      cnItems = calculated.items;
    } else {
      // Flat amount credit note — 'amount' is the taxable amount (base, before tax)
      const cnTaxableRequested = toMoney(data.amount || data.total);
      // Use the original bill's tax result to derive tax breakdown for the credit note
      // This ensures tax rates are consistent with the original invoice
      const billTaxResult = this._getBillTaxResult(originalBill);
      if (billTaxResult && billTaxResult.total_tax > 0 && billTaxResult.grand_total > 0) {
        // Scale the tax breakdown proportionally to the credit note's taxable amount
        const scaleFactor = cnTaxableRequested / billTaxResult.taxable_amount;
        taxableAmount = cnTaxableRequested;
        // Build scaled tax result for JE line building
        taxResult = {
          ...billTaxResult,
          taxable_amount: cnTaxableRequested,
          total_tax: fromPaise(Math.round(toPaise(billTaxResult.total_tax) * scaleFactor)),
          grand_total: fromPaise(toPaise(cnTaxableRequested) + toPaise(fromPaise(Math.round(toPaise(billTaxResult.total_tax) * scaleFactor)))),
          cgst_amount: fromPaise(Math.round(toPaise(billTaxResult.cgst_amount) * scaleFactor)),
          sgst_amount: fromPaise(Math.round(toPaise(billTaxResult.sgst_amount) * scaleFactor)),
          igst_amount: fromPaise(Math.round(toPaise(billTaxResult.igst_amount) * scaleFactor)),
          cess_amount: fromPaise(Math.round(toPaise(billTaxResult.cess_amount) * scaleFactor)),
        };
        cnTotal = taxResult.grand_total;
      } else {
        // No tax on original bill — credit note has no tax
        taxableAmount = cnTaxableRequested;
        cnTotal = cnTaxableRequested;
        taxResult = {
          taxable_amount: cnTaxableRequested,
          total_tax: 0,
          grand_total: cnTaxableRequested,
          is_interstate: false,
          tax_type: 'NONE',
          cgst_amount: 0,
          sgst_amount: 0,
          igst_amount: 0,
          cess_amount: 0,
          cgst_rate: 0,
          sgst_rate: 0,
          igst_rate: 0,
          cess_rate: 0,
          breakdown: [],
          components: [],
        };
      }
      // Validation: Credit amount (grand total) does not exceed the bill's original total
      const billTotal = toMoney(originalBill.total || 0);
      if (cnTotal > billTotal + 0.01) {
        throw new ValidationError(`Credit note amount (${cnTotal}) exceeds bill total (${billTotal})`);
      }
      cnItems = null;
    }

    const now = new Date().toISOString();

    // PHASE 3A FY-2 — centralised financial-year lock policy.
    // getByDate() resolves the year but does not enforce is_locked, so
    // every posting path must apply the same rule. Runs BEFORE the
    // transaction opens, so a refusal writes nothing.
    const fyForLock = this.fyRepo.getByDate(data.credit_note_date || now.split('T')[0], companyId);
    const fyLock = evaluateFinancialYearLock({ fy: fyForLock, context: context || {} });
    if (fyLock.blocked) throw new AppError(fyLock.reason, 'FY_LOCKED', 400);

    return this.conn.transaction(() => {
      const creditNoteId = generateId('cn');
      // Insert into vouchers as CREDIT_NOTE type (existing pattern)
      this.conn.prepare(`
        INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, voucher_date, status, created_by,
          description, contact_id, reference_number, created_at, updated_at, bill_id, idempotency_key)
        VALUES (?, ?, ?, 'CREDIT_NOTE', ?, 'POSTED', ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?)
      `).run(creditNoteId, companyId, cnNumber, data.credit_note_date || now.split('T')[0],
        userId, `${data.notes || 'Credit note for bill ' + originalBill.bill_number}`,
        originalBill.contact_id, data.reference_number || originalBill.bill_number,
        data.original_bill_id || null, data.idempotency_key || null);

      // Store line items in credit_note_lines (if provided)
      if (cnItems && cnItems.length > 0) {
        for (let i = 0; i < cnItems.length; i++) {
          const line = cnItems[i];
          this.conn.prepare(`
            INSERT INTO credit_note_lines (id, company_id, credit_note_id, original_sales_invoice_id,
              product_id, service_id, description, original_quantity, credit_quantity, rate,
              discount, tax_amount, line_total, line_order, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            generateId('cnl'), companyId, creditNoteId, null,
            line.product_id || null, line.service_id || null, line.description || '',
            line.quantity || 1, line.quantity || 1, line.unit_price || 0,
            line.discount_amount || 0, line.tax_result?.total_tax || 0, line.line_total || line.total || 0,
            i, now
          );
        }
      }

      // Save transaction tax details (auditable record of tax calculation)
      if (taxResult) {
        this.taxService.saveTransactionTaxDetails({
          companyId, voucherId: creditNoteId, taxMasterId: taxResult.tax_master_id,
          taxableAmount, taxType: taxResult.tax_type || 'CGST+SGST', taxRate: taxResult.total_tax / taxableAmount * 100,
          cgstRate: taxResult.cgst_rate, sgstRate: taxResult.sgst_rate, igstRate: taxResult.igst_rate, cessRate: taxResult.cess_rate,
          cgstAmount: taxResult.cgst_amount, sgstAmount: taxResult.sgst_amount, igstAmount: taxResult.igst_amount, cessAmount: taxResult.cess_amount,
          totalTax: taxResult.total_tax, grandTotal: cnTotal, placeOfSupply: data.party_state || originalBill.place_of_supply,
          isInterstate: taxResult.is_interstate, breakdown: taxResult.breakdown, userId,
        });
      }

      // Build JE for credit note (reverses the original sale's posting):
      //   Dr Sales Returns (contra revenue)  — taxable amount
      //   Dr Output Tax (CGST/SGST/IGST)      — tax amounts (reverse output liability)
      //   Cr Customer Receivable              — grand total (reduce what customer owes)
      const mappings = this._resolveAccountMappings(companyId);
      const jeLines = [];

      // Dr: Sales Returns (or Sales if no returns account)
      jeLines.push({
        account_id: mappings.salesReturns || mappings.sales,
        debit_amount: toMoney(taxableAmount),
        credit_amount: 0,
        description: `Credit note ${cnNumber} - sales return`,
        reference_id: cnNumber,
      });

      // Dr: Reverse output tax (debit the OUTPUT tax accounts to reduce liability)
      if (taxResult && taxResult.total_tax > 0) {
        const outputLines = this.taxService.buildTaxJELines(taxResult, companyId, `Credit note ${cnNumber} tax reversal`);
        outputLines.forEach((tl) => {
          jeLines.push({
            account_id: tl.account_id,
            debit_amount: tl.credit_amount, // invert: output tax was credited on sale, so debit to reverse
            credit_amount: 0,
            description: `Output tax reversal ${cnNumber}`,
            reference_id: cnNumber,
          });
        });
      }

      // Cr: Receivable (reduce customer balance)
      jeLines.push({
        account_id: mappings.receivable,
        debit_amount: 0,
        credit_amount: toMoney(cnTotal),
        description: `Credit note ${cnNumber}`,
        reference_id: cnNumber,
      });

      const journalEntry = this.journalRepo.createWithValidation({
        id: generateId('je'),
        company_id: companyId,
        voucher_id: creditNoteId,
        entry_number: `CN-${cnNumber}`,
        entry_date: data.credit_note_date || now.split('T')[0],
        description: `Credit note for bill ${originalBill.bill_number}`,
        currency: data.currency || originalBill.currency || 'INR',
        exchange_rate: data.exchange_rate || 1.0,
        status: 'POSTED',
        created_by: userId,
        financial_year_id: this.fyRepo.getByDate(data.credit_note_date || now.split('T')[0], companyId)?.id || null,
      }, jeLines);

      // Link credit note to original bill
      this.conn.prepare(`
        UPDATE vouchers SET journal_entry_id = ? WHERE id = ?
      `).run(journalEntry.id, creditNoteId);

      // Update bill allocations: reduce bill balance
      // Phase 7: If bill is already paid, credit note should not create negative receivable
      // The reduction is capped at the bill's current balance to prevent negative outstanding
      const billCurrentBalance = toMoney(originalBill.balance || 0);
      const reduction = Math.min(toMoney(cnTotal), billCurrentBalance);
      if (billCurrentBalance > 0) {
        // Directly reduce the bill's balance (credit note reduces outstanding, not paid_amount)
        // We do NOT use bill_allocations here because that table tracks PAYMENTS,
        // not credit note reductions. Using _createBillAllocation would conflate
        // credit notes with payments in the receivable reconciliation.
        this.conn.prepare(`
          UPDATE bills SET balance = balance - ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?
        `).run(reduction, data.original_bill_id, companyId);

        // Update receivable directly (reduce outstanding_amount)
        const receivable = this.conn.get(
          'SELECT id, outstanding_amount FROM receivables WHERE bill_id = ? AND company_id = ?',
          [data.original_bill_id, companyId]
        );
        if (receivable) {
          const newOutstanding = Math.max(parseFloat(receivable.outstanding_amount || 0) - reduction, 0);
          const currentStatus = receivable.status || 'CURRENT';
          let newStatus;
          if (newOutstanding <= 0) {
            newStatus = 'PAID';
          } else if (newOutstanding < parseFloat(originalBill.total || 0)) {
            newStatus = 'PARTIALLY_PAID';
          } else {
            newStatus = currentStatus;
          }
          this.conn.prepare(`
            UPDATE receivables SET outstanding_amount = ?, status = ?, updated_at = datetime('now')
            WHERE bill_id = ? AND company_id = ?
          `).run(newOutstanding, newStatus, data.original_bill_id, companyId);
        }
      }

      // Store the actual bill reduction amount for cancel reversal
      // When the bill was already paid, reduction < cnTotal (excess is customer credit)
      this.conn.prepare(`
        UPDATE vouchers SET total_amount = ?, overpayment_amount = ? WHERE id = ?
      `).run(toMoney(cnTotal), reduction, creditNoteId);

      // ── Inventory: a sales return physically brings stock back ──
      // Only a genuine SALES_RETURN moves stock. Price, tax and discount
      // adjustments do not, so they must never create phantom inventory.
      let inventoryReturn = null;
      let returnLineCount = 0;
      // createCreditNote does not currently persist credit_note_type, so the
      // caller signals a physical return with restock_inventory (defaulting to
      // true only when a reason/type says so). Non-physical adjustments must opt out.
      const wantsRestock = data.restock_inventory !== undefined
        ? !!data.restock_inventory
        : String(data.credit_note_type || 'SALES_RETURN') === 'SALES_RETURN';
      if (wantsRestock && cnItems && cnItems.length > 0) {
        const returnEntries = [];
        for (const line of cnItems) {
          const stockItem = this.inventory.findStockItemByProduct(companyId, line.product_id);
          if (!stockItem) continue;       // service line, or not inventory-managed
          const qty = parseFloat(line.quantity || line.credit_quantity || 0) || 0;
          if (qty <= 0) continue;

          // Return to the godown the original sale went out from, else the
          // item's own placement.
          const godownId = line.godown_id || stockItem.godown_id;
          if (!godownId) continue;        // no place to put it; leave stock alone
          const locationId = line.location_id
            || stockItem.location_id
            || this.inventory.locationForGodown(companyId, godownId);

          returnEntries.push({
            stockItem,
            quantity: qty,
            godownId,
            locationId,
            batchId: line.batch_id || null,
            serial: line.serial_number || null,
          });
        }

        if (returnEntries.length > 0) {
          inventoryReturn = this.inventoryBridge.postReturn({
            companyId,
            userId,
            billId: originalBill.id,
            creditNoteId,
            entries: returnEntries,
            voucherDate: data.credit_note_date || new Date().toISOString().slice(0, 10),
          });
          returnLineCount = returnEntries.length;

          // Reverse COGS into the SAME journal entry, at the original cost.
          if (inventoryReturn && inventoryReturn.valuation) {
            const reverseValuation = inventoryReturn.valuation.map((v) => ({
              item_id: v.item_id,
              cost_out: -(parseFloat(v.total_value) || 0),
            }));
            const reverseLines = this._buildCogsLines({ valuation: reverseValuation }, mappings, companyId);
            if (reverseLines.length > 0) {
              this.journalRepo.appendLines(journalEntry.id, companyId, reverseLines);
            }
          }
        }
      }

      this._logAudit(companyId, userId, 'credit_note', creditNoteId, 'CREATE', null,
        { original_bill_id: data.original_bill_id, amount: toMoney(cnTotal), journal_entry_id: journalEntry.id,
          reason: data.reason || null, reference_number: data.reference_number || null,
          inventory_voucher_header_id: inventoryReturn ? inventoryReturn.voucher.id : null,
          stock_lines_returned: returnLineCount });

      return {
        id: creditNoteId,
        credit_note_number: cnNumber,
        original_bill_id: data.original_bill_id,
        contact_id: originalBill.contact_id,
        amount: toMoney(cnTotal),
        taxable_amount: toMoney(taxableAmount),
        tax_details: taxResult,
        journal_entry: journalEntry,
        items: cnItems || [],
        reason: data.reason || null,
        reference_number: data.reference_number || null,
        notes: data.notes || '',
        bill_balance_reduced_by: reduction,
        overpayment_amount: toMoney(cnTotal) > billCurrentBalance ? toMoney(cnTotal) - billCurrentBalance : 0,
        inventory_return: inventoryReturn
          ? {
              voucher_id: inventoryReturn.voucher.id,
              voucher_number: inventoryReturn.voucher.voucher_number,
              stock_lines: returnLineCount,
            }
          : null,
      };
    })();
  }

  // ─── Debit Note ─────────────────────────────────────────────────────────
  createDebitNote(data, userId, context = null) {
    const companyId = data.company_id || 'default';
    const now = new Date().toISOString();

    // Validation: Idempotency — prevent duplicate debit note creation
    if (data.idempotency_key) {
      const existing = this.conn.get(
        'SELECT id, voucher_number FROM vouchers WHERE idempotency_key = ? AND company_id = ? AND voucher_type = ?',
        [data.idempotency_key, companyId, 'DEBIT_NOTE']
      );
      if (existing) {
        throw new ConflictError(`Debit note already created with this idempotency key: ${existing.voucher_number}`);
      }
    }

    // Validation: If original bill referenced, verify it exists and belongs to this company
    if (data.original_bill_id) {
      const originalBill = this.billRepo.findById(data.original_bill_id, companyId);
      if (!originalBill) {
        throw new NotFoundError('Bill', data.original_bill_id);
      }
      if (data.contact_id && originalBill.contact_id !== data.contact_id) {
        throw new ValidationError(`Original bill does not belong to contact ${data.contact_id}`);
      }
    }

    const dnNumber = CodeGenerator.generate(this.conn, 'DEBIT_NOTE', companyId);

    // PHASE 3A FY-2 — centralised financial-year lock policy.
    // getByDate() resolves the year but does not enforce is_locked, so
    // every posting path must apply the same rule. Runs BEFORE the
    // transaction opens, so a refusal writes nothing.
    const fyForLock = this.fyRepo.getByDate(data.debit_note_date || now.split('T')[0], companyId);
    const fyLock = evaluateFinancialYearLock({ fy: fyForLock, context: context || {} });
    if (fyLock.blocked) throw new AppError(fyLock.reason, 'FY_LOCKED', 400);

    return this.conn.transaction(() => {
      const debitNoteId = generateId('dn');
      this.conn.prepare(`
        INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, voucher_date, status, created_by,
          description, contact_id, reference_number, created_at, updated_at, bill_id, idempotency_key)
        VALUES (?, ?, ?, 'DEBIT_NOTE', ?, 'POSTED', ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?)
      `).run(debitNoteId, companyId, dnNumber, data.debit_note_date || now.split('T')[0],
        userId, `${data.notes || 'Debit note'}`, data.contact_id, data.reference_number || null,
        data.original_bill_id || null, data.idempotency_key || null);

      const amount = toMoney(data.amount || data.total);
      const taxResult = data.tax_master_id ? this.taxService.calculateTax({
        companyId,
        taxableAmount: amount,
        taxMasterId: data.tax_master_id,
        partyState: data.party_state,
        companyState: data.company_state || this._getCompanyState(companyId),
      }) : null;

      const mappings = this._resolveAccountMappings(companyId);
      const jeLines = [];
      const dnTotal = taxResult ? taxResult.grand_total : amount;

      // Debit: Receivable (increase what customer owes)
      jeLines.push({
        account_id: mappings.receivable,
        debit_amount: dnTotal,
        credit_amount: 0,
        description: `Debit note ${dnNumber}`,
        reference_id: dnNumber,
      });

      // Credit: Additional charges / freight / other income
      // Use otherCharges account (EXPENSE for freight) or fall back to other income (INCOME)
      const otherChargesAcc = mappings.otherCharges || mappings.otherIncome || mappings.sales;
      if (otherChargesAcc) {
        jeLines.push({
          account_id: otherChargesAcc,
          debit_amount: 0,
          credit_amount: amount,
          description: `Debit note ${dnNumber} - additional charges`,
          reference_id: dnNumber,
        });
      }

      // Credit: Output tax (increase tax liability)
      if (taxResult && taxResult.total_tax > 0) {
        const outputLines = this.taxService.buildTaxJELines(taxResult, companyId, `Debit note ${dnNumber}`);
        outputLines.forEach((tl) => {
          tl.reference_id = dnNumber;
          jeLines.push(tl);
        });
      }

      const journalEntry = this.journalRepo.createWithValidation({
        id: generateId('je'),
        company_id: companyId,
        voucher_id: debitNoteId,
        entry_number: `DN-${dnNumber}`,
        entry_date: data.debit_note_date || now.split('T')[0],
        description: `Debit note for additional charges`,
        currency: data.currency || 'INR',
        exchange_rate: data.exchange_rate || 1.0,
        status: 'POSTED',
        created_by: userId,
        financial_year_id: this.fyRepo.getByDate(data.debit_note_date || now.split('T')[0], companyId)?.id || null,
      }, jeLines);

      this.conn.prepare('UPDATE vouchers SET journal_entry_id = ? WHERE id = ?').run(journalEntry.id, debitNoteId);

      // If linked to a bill, increase the bill's outstanding balance and receivable
      if (data.original_bill_id) {
        this.conn.prepare(`
          UPDATE bills SET balance = balance + ?, updated_at = datetime('now')
          WHERE id = ? AND company_id = ?
        `).run(dnTotal, data.original_bill_id, companyId);
        const receivable = this.conn.get(
          'SELECT id, outstanding_amount FROM receivables WHERE bill_id = ? AND company_id = ?',
          [data.original_bill_id, companyId]
        );
        if (receivable) {
          const newOutstanding = parseFloat(receivable.outstanding_amount || 0) + dnTotal;
          this.conn.prepare(
            "UPDATE receivables SET outstanding_amount = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?"
          ).run(newOutstanding, receivable.id, companyId);
        }
      }

      // Store total_amount and overpayment_amount (dnTotal) for cancel reversal
      this.conn.prepare(
        'UPDATE vouchers SET total_amount = ?, overpayment_amount = ? WHERE id = ?'
      ).run(dnTotal, dnTotal, debitNoteId);

      this._logAudit(companyId, userId, 'debit_note', debitNoteId, 'CREATE', null,
        { amount: dnTotal, journal_entry_id: journalEntry.id });

      return {
        id: debitNoteId,
        debit_note_number: dnNumber,
        total: dnTotal,
        amount: dnTotal,
        tax_details: taxResult,
        journal_entry: journalEntry,
      };
    })();
  }

  // ─── Credit Note Detail ─────────────────────────────────────────────────
  /**
   * Retrieve a credit note with full detail: line items, JE, receivable impact.
   */
  getCreditNote(creditNoteId, companyId) {
    const voucher = this.conn.get(
      `SELECT v.*, j.total_debit, j.total_credit, j.entry_number, j.entry_date as je_date, b.bill_number as original_bill_number
       FROM vouchers v
       LEFT JOIN journal_entries j ON j.id = v.journal_entry_id
       LEFT JOIN bills b ON b.id = v.bill_id
       WHERE v.id = ? AND v.company_id = ? AND v.voucher_type = 'CREDIT_NOTE'`,
      [creditNoteId, companyId]
    );
    if (!voucher) throw new NotFoundError('Credit Note', creditNoteId);

    const lines = this.conn.all(
      'SELECT * FROM credit_note_lines WHERE credit_note_id = ? AND company_id = ? ORDER BY line_order',
      [creditNoteId, companyId]
    );

    const jeLines = voucher.journal_entry_id ? this.conn.all(
      `SELECT jel.*, a.code as account_code, a.name as account_name, ag.type as account_type
       FROM journal_entry_lines jel
       LEFT JOIN accounts a ON a.id = jel.account_id
       LEFT JOIN account_groups ag ON ag.id = a.account_group_id
       WHERE jel.journal_entry_id = ?`,
      [voucher.journal_entry_id]
    ) : [];

    return {
      ...voucher,
      items: lines || [],
      journal_entry_lines: jeLines,
      receivable_impact: -parseFloat(voucher.total_amount || 0),
      // The stock-in voucher this credit note created, if it was a sales return.
      inventory_impact: (() => {
        const iv = this.conn.get(
          `SELECT id, voucher_number FROM inventory_voucher_headers
            WHERE company_id = ? AND source_document_type = 'CREDIT_NOTE' AND source_document_id = ?
            LIMIT 1`, [companyId, creditNoteId]);
        return iv ? { voucher_id: iv.id, voucher_number: iv.voucher_number } : null;
      })(),
    };
  }

  // ─── Debit Note Detail ──────────────────────────────────────────────────
  /**
   * Retrieve a debit note with full detail: line items, JE, receivable impact.
   */
  getDebitNote(debitNoteId, companyId) {
    const voucher = this.conn.get(
      `SELECT v.*, j.total_debit, j.total_credit, j.entry_number, j.entry_date as je_date, b.bill_number as original_bill_number
       FROM vouchers v
       LEFT JOIN journal_entries j ON j.id = v.journal_entry_id
       LEFT JOIN bills b ON b.id = v.bill_id
       WHERE v.id = ? AND v.company_id = ? AND v.voucher_type = 'DEBIT_NOTE'`,
      [debitNoteId, companyId]
    );
    if (!voucher) throw new NotFoundError('Debit Note', debitNoteId);

    const jeLines = voucher.journal_entry_id ? this.conn.all(
      `SELECT jel.*, a.code as account_code, a.name as account_name, ag.type as account_type
       FROM journal_entry_lines jel
       LEFT JOIN accounts a ON a.id = jel.account_id
       LEFT JOIN account_groups ag ON ag.id = a.account_group_id
       WHERE jel.journal_entry_id = ?`,
      [voucher.journal_entry_id]
    ) : [];

    return {
      ...voucher,
      journal_entry_lines: jeLines,
      receivable_impact: parseFloat(voucher.total_amount || 0),
    };
  }

  // ─── Cancel Credit Note ─────────────────────────────────────────────────
  /**
   * Cancel a posted credit note by creating a reversing JE and updating voucher status.
   * Does NOT modify the original bill — only reverses the credit note's accounting impact.
   */
  cancelCreditNote(creditNoteId, companyId, userId, reason) {
    const voucher = this.conn.get(
      'SELECT * FROM vouchers WHERE id = ? AND company_id = ? AND voucher_type = ?',
      [creditNoteId, companyId, 'CREDIT_NOTE']
    );
    if (!voucher) throw new NotFoundError('Credit Note', creditNoteId);
    if (voucher.status !== 'POSTED') {
      throw new AppError(`Cannot cancel credit note in status ${voucher.status}`, 'INVALID_STATE', 400);
    }

    return this.conn.transaction(() => {
      const now = new Date().toISOString();
      let reversalJournalEntryId = null;

      // Reverse the credit note's journal entry using existing JE reversal architecture
      if (voucher.journal_entry_id) {
        const reversal = this.journalRepo.reverse(voucher.journal_entry_id, companyId, userId);
        reversalJournalEntryId = reversal.reverseEntryId;
      }

      // Update credit note voucher status to CANCELLED
      this.conn.prepare(`
        UPDATE vouchers SET status = 'CANCELLED', updated_at = datetime('now')
        WHERE id = ? AND company_id = ?
      `).run(creditNoteId, companyId);

      // If this credit note was applied to a bill, restore the bill's balance
      if (voucher.bill_id) {
        // The actual bill reduction is stored in overpayment_amount during creation
        // (may be less than total_amount when the bill was already paid)
        const reduction = toMoney(voucher.overpayment_amount || 0);
        if (reduction > 0) {
          // Restore bill balance — credit note reversal adds back to balance
          this.conn.prepare(`
            UPDATE bills SET balance = balance + ?, updated_at = datetime('now')
            WHERE id = ? AND company_id = ?
          `).run(reduction, voucher.bill_id, companyId);
          // Update receivable outstanding
          const receivable = this.conn.get(
            'SELECT id, outstanding_amount FROM receivables WHERE bill_id = ? AND company_id = ?',
            [voucher.bill_id, companyId]
          );
          if (receivable) {
            const newOutstanding = parseFloat(receivable.outstanding_amount || 0) + reduction;
            const newStatus = newOutstanding <= 0.01 ? 'PAID' : 'PARTIALLY_PAID';
            this.conn.prepare(
              "UPDATE receivables SET outstanding_amount = ?, status = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?"
            ).run(newOutstanding, newStatus, receivable.id, companyId);
          }
        }
      }

      this._logAudit(companyId, userId, 'credit_note', creditNoteId, 'CANCEL', null,
        { status: 'CANCELLED', reversal_journal_entry_id: reversalJournalEntryId, reason });

      return {
        id: creditNoteId,
        voucher_number: voucher.voucher_number,
        status: 'CANCELLED',
        reversal_journal_entry_id: reversalJournalEntryId,
        reason,
      };
    })();
  }

  // ─── Cancel Debit Note ──────────────────────────────────────────────────
  /**
   * Cancel a posted debit note by creating a reversing JE and updating voucher status.
   */
  cancelDebitNote(debitNoteId, companyId, userId, reason) {
    const voucher = this.conn.get(
      'SELECT * FROM vouchers WHERE id = ? AND company_id = ? AND voucher_type = ?',
      [debitNoteId, companyId, 'DEBIT_NOTE']
    );
    if (!voucher) throw new NotFoundError('Debit Note', debitNoteId);
    if (voucher.status !== 'POSTED') {
      throw new AppError(`Cannot cancel debit note in status ${voucher.status}`, 'INVALID_STATE', 400);
    }

    return this.conn.transaction(() => {
      const now = new Date().toISOString();
      let reversalJournalEntryId = null;

      if (voucher.journal_entry_id) {
        const reversal = this.journalRepo.reverse(voucher.journal_entry_id, companyId, userId);
        reversalJournalEntryId = reversal.reverseEntryId;
      }

      // For debit notes applied to a bill, restore the bill's balance
      if (voucher.bill_id) {
        const dnTotal = toMoney(voucher.overpayment_amount || voucher.total_amount || 0);
        if (dnTotal > 0) {
          // Debit note increased the bill's balance; to reverse, subtract the dnTotal
          this.conn.prepare(`
            UPDATE bills SET balance = balance - ?, updated_at = datetime('now')
            WHERE id = ? AND company_id = ?
          `).run(dnTotal, voucher.bill_id, companyId);
          // Update receivable outstanding
          const receivable = this.conn.get(
            'SELECT id, outstanding_amount FROM receivables WHERE bill_id = ? AND company_id = ?',
            [voucher.bill_id, companyId]
          );
          if (receivable) {
            const newOutstanding = Math.max(parseFloat(receivable.outstanding_amount || 0) - dnTotal, 0);
            const newStatus = newOutstanding <= 0.01 ? 'PAID' : 'PARTIALLY_PAID';
            this.conn.prepare(
              "UPDATE receivables SET outstanding_amount = ?, status = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?"
            ).run(newOutstanding, newStatus, receivable.id, companyId);
          }
        }
      }

      this.conn.prepare(`
        UPDATE vouchers SET status = 'CANCELLED', updated_at = datetime('now')
        WHERE id = ? AND company_id = ?
      `).run(debitNoteId, companyId);

      this._logAudit(companyId, userId, 'debit_note', debitNoteId, 'CANCEL', null,
        { status: 'CANCELLED', reversal_journal_entry_id: reversalJournalEntryId, reason });

      return {
        id: debitNoteId,
        voucher_number: voucher.voucher_number,
        status: 'CANCELLED',
        reversal_journal_entry_id: reversalJournalEntryId,
        reason,
      };
    })();
  }

  // ─── List Credit Notes ──────────────────────────────────────────────────
  /**
   * List credit notes with optional filters.
   */
  listCreditNotes(companyId, options = {}) {
    const where = ['v.voucher_type = ?', 'v.company_id = ?'];
    const params = ['CREDIT_NOTE', companyId];
    if (options.contact_id) { where.push('v.contact_id = ?'); params.push(options.contact_id); }
    if (options.bill_id) { where.push('v.bill_id = ?'); params.push(options.bill_id); }
    if (options.from) { where.push('v.voucher_date >= ?'); params.push(options.from); }
    if (options.to) { where.push('v.voucher_date <= ?'); params.push(options.to); }
    if (options.status) { where.push('v.status = ?'); params.push(options.status); }

    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const whereStr = where.join(' AND ');

    const totalRow = this.conn.get(`SELECT COUNT(*) as total FROM vouchers v WHERE ${whereStr}`, params);
    const items = this.conn.all(`
      SELECT v.*, j.total_debit, j.total_credit, c.first_name, c.last_name, o.name as organization_name,
             b.bill_number as original_bill_number
      FROM vouchers v
      LEFT JOIN journal_entries j ON j.id = v.journal_entry_id
      LEFT JOIN contacts c ON c.id = v.contact_id
      LEFT JOIN organizations o ON o.id = v.organization_id
      LEFT JOIN bills b ON b.id = v.bill_id
      WHERE ${whereStr} ORDER BY v.voucher_date DESC LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return { items, total: totalRow?.total || 0 };
  }

  // ─── List Debit Notes ───────────────────────────────────────────────────
  listDebitNotes(companyId, options = {}) {
    const where = ['v.voucher_type = ?', 'v.company_id = ?'];
    const params = ['DEBIT_NOTE', companyId];
    if (options.contact_id) { where.push('v.contact_id = ?'); params.push(options.contact_id); }
    if (options.bill_id) { where.push('v.bill_id = ?'); params.push(options.bill_id); }
    if (options.from) { where.push('v.voucher_date >= ?'); params.push(options.from); }
    if (options.to) { where.push('v.voucher_date <= ?'); params.push(options.to); }
    if (options.status) { where.push('v.status = ?'); params.push(options.status); }

    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const whereStr = where.join(' AND ');

    const totalRow = this.conn.get(`SELECT COUNT(*) as total FROM vouchers v WHERE ${whereStr}`, params);
    const items = this.conn.all(`
      SELECT v.*, j.total_debit, j.total_credit, c.first_name, c.last_name, o.name as organization_name,
             b.bill_number as original_bill_number
      FROM vouchers v
      LEFT JOIN journal_entries j ON j.id = v.journal_entry_id
      LEFT JOIN contacts c ON c.id = v.contact_id
      LEFT JOIN organizations o ON o.id = v.organization_id
      LEFT JOIN bills b ON b.id = v.bill_id
      WHERE ${whereStr} ORDER BY v.voucher_date DESC LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return { items, total: totalRow?.total || 0 };
  }

  // ─── Cancellation / Reversal ───────────────────────────────────────────
  cancelBill(billId, companyId, userId, reason) {
    const bill = this.billRepo.findById(billId, companyId);
    if (!bill) throw new NotFoundError('Bill', billId);

    if (bill.status !== 'POSTED' && bill.status !== 'PARTIALLY_PAID' && bill.status !== 'OVERDUE'
        && bill.status !== 'APPROVED' && bill.status !== 'PENDING_APPROVAL' && bill.status !== 'PAID') {
      if (bill.status !== 'DRAFT') {
        throw new AppError(`Cannot cancel bill in status ${bill.status}`, 'INVALID_STATE', 400);
      }
      // DRAFT never moved stock, so there is nothing to reverse.
      this.conn.prepare(
        "UPDATE bills SET status = ?, cancelled_by = ?, cancelled_at = ?, cancellation_reason = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?")
        .run('CANCELLED', userId, new Date().toISOString(), reason || '', billId, companyId);
      this._logAudit(companyId, userId, 'customer_bill', billId, 'CANCEL', null, { status: 'CANCELLED' });
      return this.billRepo.findById(billId, companyId);
    }

    return this.conn.transaction(() => {
      const now = new Date().toISOString();

      // ── Inventory: return the stock this bill issued ──
      // Appends inverse stock_ledger rows (the original outward is NEVER
      // deleted) and a reversal voucher header. Runs before the accounting
      // reversal so that if inventory fails, nothing is reversed in accounting
      // either. reverseForBill is itself idempotent: a bill whose original
      // movements are already fully reversed produces no second reversal.
      const inventoryReversal = this.inventoryBridge.reverseForBill(bill, {
        companyId,
        userId,
        reason,
      });

      if (inventoryReversal) {
        this.conn.run(
          'UPDATE bills SET inventory_reversal_voucher_header_id = ? WHERE id = ? AND company_id = ?',
          [inventoryReversal.voucher.id, billId, companyId]);
      }

      // For posted bills, create a reversing JE
      let reversalJournalEntryId = null;
      if (bill.journal_entry_id) {
        const reversal = this.journalRepo.reverse(bill.journal_entry_id, companyId, userId);
        reversalJournalEntryId = reversal.reverseEntryId;
        this.conn.prepare(`
          UPDATE bills SET status = ?, cancellation_reason = ?, cancelled_by = ?, cancelled_at = ?,
            reversal_journal_entry_id = ?, updated_at = ? WHERE id = ? AND company_id = ?
        `).run('CANCELLED', reason || '', userId, now, reversalJournalEntryId, now, billId, companyId);
        this._logAudit(companyId, userId, 'customer_bill', billId, 'CANCEL', null, {
          status: 'CANCELLED',
          reversal_journal_entry_id: reversalJournalEntryId,
          inventory_reversal_voucher_header_id: inventoryReversal ? inventoryReversal.voucher.id : null,
        });
      } else {
        this.conn.prepare(`
          UPDATE bills SET status = ?, cancellation_reason = ?, cancelled_by = ?, cancelled_at = ?, updated_at = ?
          WHERE id = ? AND company_id = ?
        `).run('CANCELLED', reason || '', userId, now, now, billId, companyId);
        this._logAudit(companyId, userId, 'customer_bill', billId, 'CANCEL', null, {
          status: 'CANCELLED',
          inventory_reversal_voucher_header_id: inventoryReversal ? inventoryReversal.voucher.id : null,
        });
      }

      return {
        ...this.billRepo.findById(billId, companyId),
        reversal_journal_entry_id: reversalJournalEntryId,
        inventory_reversal: inventoryReversal
          ? { voucher_id: inventoryReversal.voucher.id, voucher_number: inventoryReversal.voucher.voucher_number }
          : null,
      };
    })();
  }

  // ─── Credit Control ──────────────────────────────────────────────────────
  checkCreditLimit(billId, companyId) {
    const bill = this.billRepo.findById(billId, companyId);
    if (!bill) throw new NotFoundError('Bill', billId);

    const creditRule = this.creditRepo.getByContact(bill.contact_id, companyId);
    if (!creditRule || !creditRule.credit_limit) {
      return { exceeded: false, credit_limit: 0, outstanding: 0, projected: 0 };
    }

    // Current outstanding = sum of all receivables for this contact (posted, not paid)
    const outstandingRow = this.conn.get(
      `SELECT COALESCE(SUM(outstanding_amount), 0) as total FROM receivables
       WHERE company_id = ? AND contact_id = ? AND status NOT IN ('PAID', 'WRITTEN_OFF')`,
      [companyId, bill.contact_id]
    );
    const currentOutstanding = parseFloat(outstandingRow?.total || 0);
    const projected = currentOutstanding + toMoney(bill.total);
    const limit = parseFloat(creditRule.credit_limit);

    return {
      exceeded: projected > limit,
      credit_limit: limit,
      current_outstanding: currentOutstanding,
      projected_outstanding: projected,
      credit_period_days: creditRule.credit_period_days,
      available_credit: Math.max(limit - currentOutstanding, 0),
    };
  }

  // ─── Customer Financial Summary ─────────────────────────────────────────
  getCustomerFinancialSummary(contactId, companyId) {
    const company = companyId || 'default';
    const creditRule = this.creditRepo.getByContact(contactId, company);
    const outstandingRow = this.conn.get(
      `SELECT COALESCE(SUM(outstanding_amount), 0) as outstanding,
              COALESCE(SUM(CASE WHEN days_overdue > 0 THEN outstanding_amount ELSE 0 END), 0) as overdue,
              COALESCE(SUM(CASE WHEN days_overdue > 0 THEN 1 ELSE 0 END), 0) as overdue_count
       FROM receivables WHERE company_id = ? AND contact_id = ? AND status NOT IN ('PAID', 'WRITTEN_OFF')`,
      [company, contactId]
    );
    const lastInvoice = this.conn.get(
      `SELECT issue_date, total FROM bills WHERE company_id = ? AND contact_id = ?
       ORDER BY issue_date DESC LIMIT 1`,
      [company, contactId]
    );
    const lastPayment = this.conn.get(
      `SELECT p.payment_number, p.payment_date, p.amount, p.reference_number, p.payment_method, p.status
       FROM payments p
       WHERE p.company_id = ? AND p.contact_id = ?
       ORDER BY p.payment_date DESC, p.id DESC LIMIT 1`,
      [company, contactId]
    );
    const totalSales = this.conn.get(
      `SELECT COALESCE(SUM(total), 0) as total FROM bills
       WHERE company_id = ? AND contact_id = ? AND bill_type = 'CUSTOMER' AND status NOT IN ('CANCELLED', 'VOID')`,
      [company, contactId]
    );

    // Oldest overdue invoice (if any)
    const oldestOverdue = this.conn.get(
      `SELECT b.bill_number, b.due_date, r.outstanding_amount as balance, r.days_overdue
       FROM receivables r
       JOIN bills b ON b.id = r.bill_id
       WHERE r.company_id = ? AND r.contact_id = ? AND r.days_overdue > 0 AND r.outstanding_amount > 0
       ORDER BY r.due_date ASC LIMIT 1`,
      [company, contactId]
    );

    // Recent bills (last 5, unpaid/unposted, newest first)
    const recentBills = this.conn.all(
      `SELECT bill_number, issue_date, due_date, total, balance, status, paid_amount
       FROM bills
       WHERE company_id = ? AND contact_id = ? AND bill_type = 'CUSTOMER' AND status NOT IN ('CANCELLED', 'VOID')
       ORDER BY created_at DESC LIMIT 5`,
      [company, contactId]
    );

    // Recent payments (last 5, newest first)
    const recentPayments = this.conn.all(
      `SELECT id, payment_number, payment_date, amount, reference_number, payment_method, status
       FROM payments
       WHERE company_id = ? AND contact_id = ?
       ORDER BY payment_date DESC LIMIT 5`,
      [company, contactId]
    );

    // Contact status (for credit hold detection)
    const contact = this.conn.get(
      `SELECT status, customer_status FROM contacts WHERE id = ? AND company_id = ?`,
      [contactId, company]
    );

    // Customer account (AR ledger account)
    const arAccount = this.conn.get('SELECT id, code, name FROM accounts WHERE id = ?', ['acc_receivable']);

    const outstanding = parseFloat(outstandingRow?.outstanding || 0);
    const creditLimit = creditRule ? parseFloat(creditRule.credit_limit) : 0;
    const hasCreditLimit = !!creditRule && creditLimit > 0;

    return {
      contact_id: contactId,
      outstanding_balance: outstanding,
      overdue_amount: parseFloat(outstandingRow?.overdue || 0),
      overdue_invoice_count: parseInt(outstandingRow?.overdue_count || 0),
      oldest_overdue_invoice: oldestOverdue ? {
        bill_number: oldestOverdue.bill_number,
        due_date: oldestOverdue.due_date,
        balance: parseFloat(oldestOverdue.balance || 0),
        days_overdue: parseInt(oldestOverdue.days_overdue || 0),
      } : null,
      credit_limit: creditLimit,
      has_credit_limit: hasCreditLimit,
      available_credit: hasCreditLimit ? Math.max(creditLimit - outstanding, 0) : 0,
      credit_utilization: hasCreditLimit && creditLimit > 0 ? (outstanding / creditLimit * 100) : 0,
      credit_days: creditRule ? creditRule.credit_period_days : 30,
      contact_status: contact?.status || null,
      customer_status: contact?.customer_status || null,
      last_invoice_date: lastInvoice?.issue_date || null,
      last_invoice_total: lastInvoice?.total ? parseFloat(lastInvoice.total) : null,
      last_payment_date: lastPayment?.payment_date || null,
      last_payment_number: lastPayment?.payment_number || null,
      last_payment_amount: lastPayment?.amount ? parseFloat(lastPayment.amount) : null,
      last_payment_method: lastPayment?.payment_method || null,
      total_sales: parseFloat(totalSales?.total || 0),
      customer_account: arAccount ? { id: arAccount.id, code: arAccount.code, name: arAccount.name } : null,
      recent_bills: recentBills || [],
      recent_payments: recentPayments || [],
      outstanding: outstanding, // alias for outstanding_balance
    };
  }

  // ─── Aging ──────────────────────────────────────────────────────────────
  getCustomerAging(contactId, companyId) {
    const company = companyId || 'default';
    const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '120+': 0 };
    const rows = this.conn.all(
      `SELECT due_date, outstanding_amount, days_overdue FROM receivables
       WHERE company_id = ? AND contact_id = ? AND status NOT IN ('PAID', 'WRITTEN_OFF')`,
      [company, contactId]
    );
    for (const r of rows) {
      const days = r.days_overdue || 0;
      const amt = parseFloat(r.outstanding_amount) || 0;
      if (days <= 30) buckets['0-30'] += amt;
      else if (days <= 60) buckets['31-60'] += amt;
      else if (days <= 90) buckets['61-90'] += amt;
      else if (days <= 120) buckets['91-120'] += amt;
      else buckets['120+'] += amt;
    }
    return buckets;
  }

  // ─── KPI Dashboard ──────────────────────────────────────────────────────
  getKpiSummary(companyId, filters = {}) {
    const company = companyId || 'default';
    const where = ['company_id = ?', 'bill_type = \'CUSTOMER\''];
    const params = [company];
    if (filters.from) { where.push('issue_date >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('issue_date <= ?'); params.push(filters.to); }

    const whereStr = where.join(' AND ');
    const row = this.conn.get(`
      SELECT
        COALESCE(SUM(CASE WHEN status IN ('POSTED','PARTIALLY_PAID','PAID','OVERDUE','SENT','PENDING_APPROVAL','APPROVED') THEN total ELSE 0 END), 0) as total_billing,
        COALESCE(SUM(CASE WHEN status IN ('PAID') THEN total ELSE 0 END), 0) as paid,
        COALESCE(SUM(CASE WHEN status IN ('PARTIALLY_PAID','POSTED','OVERDUE','OVERDUE') THEN balance ELSE 0 END), 0) as outstanding,
        COALESCE(SUM(CASE WHEN status = 'OVERDUE' AND balance > 0 THEN balance ELSE 0 END), 0) as overdue,
        COALESCE(SUM(CASE WHEN status IN ('DRAFT','PENDING_APPROVAL','APPROVED','SENT') THEN total ELSE 0 END), 0) as draft_bills,
        COALESCE(SUM(CASE WHEN status = 'PARTIALLY_PAID' THEN total ELSE 0 END), 0) as partially_paid,
        COALESCE(SUM(CASE WHEN due_date = date('now') AND balance > 0 THEN balance ELSE 0 END), 0) as due_today
      FROM bills WHERE ${whereStr}
    `, params);

    // Draft KPI is a COUNT of draft-stage bills, not a currency sum.
    const draftCount = this.conn.get(`
      SELECT COUNT(*) as cnt FROM bills WHERE ${whereStr}
        AND status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT')
    `, params)?.cnt || 0;

    // Average collection days = (outstanding / total_billing) * avg_credit_days — simplified
    const avgCollectionDays = parseFloat(row?.total_billing) > 0
      ? Math.round((parseFloat(row?.outstanding || 0) / parseFloat(row?.total_billing || 1)) * 30)
      : 0;

    return {
      total_billing: parseFloat(row?.total_billing || 0),
      paid: parseFloat(row?.paid || 0),
      outstanding: parseFloat(row?.outstanding || 0),
      overdue: parseFloat(row?.overdue || 0),
      due_today: parseFloat(row?.due_today || 0),
      draft_bills: draftCount,
      draft_amount: parseFloat(row?.draft_bills || 0),
      partially_paid: parseFloat(row?.partially_paid || 0),
      average_collection_days: avgCollectionDays,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────
  _calculateDueDate(issueDate, paymentTerms, days) {
    const start = issueDate ? new Date(issueDate) : new Date();
    if (paymentTerms === 'DUE_ON_RECEIPT') return issueDate;
    if (paymentTerms === 'ADVANCE') return issueDate;
    if (paymentTerms === 'SPECIFIC_DATE') return issueDate; // caller sets due_date directly
    if (paymentTerms === 'END_OF_MONTH') {
      const year = start.getFullYear();
      const month = start.getMonth();
      const lastDay = new Date(year, month + 1, 0);
      return lastDay.toISOString().split('T')[0];
    }
    const termDays = days || 30;
    const due = new Date(start);
    due.setDate(due.getDate() + termDays);
    return due.toISOString().split('T')[0];
  }

  _daysOverdue(dueDate) {
    if (!dueDate) return 0;
    const days = Math.floor((Date.now() - new Date(dueDate).getTime()) / (24 * 60 * 60 * 1000));
    return days > 0 ? days : 0;
  }

  _getCompanyState(companyId) {
    const config = this.taxService.getCompanyTaxConfig(companyId);
    return config?.state_code || '29';
  }

  _aggregateByAccount(bill, kind) {
    // For now, aggregate all sales revenue into the single configured sales account.
    // Net sales = subtotal minus line-level discounts (the amount actually earned).
    const mappings = this._resolveAccountMappings(bill.company_id);
    const lineDiscount = parseFloat(bill.line_discount_amount || 0);
    const total = parseFloat(bill.subtotal || 0) - lineDiscount;
    return { [mappings.sales]: total };
  }

  _getBillTaxResult(bill) {
    // Use the tax breakdown stored on the bill (computed during createBill).
    const taxAmount = parseFloat(bill.tax || 0);
    if (taxAmount <= 0) return null;

    // If we have tax_master_id and taxable_amount, recalculate for a full structured result
    if (bill.tax_master_id && parseFloat(bill.taxable_amount || 0) > 0) {
      try {
        return this.taxService.calculateTax({
          companyId: bill.company_id,
          taxableAmount: bill.taxable_amount,
          taxMasterId: bill.tax_master_id,
          partyState: bill.place_of_supply,
          companyState: bill.company_state || this._getCompanyState(bill.company_id),
        });
      } catch (e) { /* fall through to reconstructed result */ }
    }
    // Reconstruct from bill tax fields for JE line building
    const isInterstate = bill.is_interstate ? 1 : 0;
    const half = taxAmount / 2;
    return {
      taxable_amount: parseFloat(bill.taxable_amount || 0),
      total_tax: taxAmount,
      grand_total: parseFloat(bill.total || 0),
      is_interstate: !!isInterstate,
      tax_type: isInterstate ? 'IGST' : 'CGST+SGST',
      cgst_amount: isInterstate ? 0 : parseFloat(bill.cgst_amount || half),
      sgst_amount: isInterstate ? 0 : parseFloat(bill.sgst_amount || half),
      igst_amount: isInterstate ? taxAmount : 0,
      cess_amount: parseFloat(bill.cess_amount || 0),
      cgst_rate: parseFloat(bill.cgst_rate || 0),
      sgst_rate: parseFloat(bill.sgst_rate || 0),
      igst_rate: parseFloat(bill.igst_rate || 0),
      cess_rate: parseFloat(bill.cess_rate || 0),
      breakdown: [],
      components: [],
    };
  }

  _updateBillStatus(billId, companyId, status, userId, action) {
    const now = new Date().toISOString();
    this.conn.prepare(`
      UPDATE bills SET status = ?, updated_at = ? WHERE id = ? AND company_id = ?
    `).run(status, now, billId, companyId);
    this._logAudit(companyId, userId, 'customer_bill', billId, action, null, { status });
  }

  _logAudit(companyId, userId, entity, entityId, action, oldValues, newValues) {
    try {
      this.conn.prepare(`
        INSERT INTO accounting_audit (id, company_id, user_id, entity_type, entity_id, action,
          old_values_json, new_values_json, ip_address, user_agent, session_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        generateId('aud'), companyId, userId || 'system', entity, entityId, action,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        null, null, null, new Date().toISOString()
      );
    } catch (e) { /* audit must not break main flow */ }
  }

  // ═══ Step 12: AR Outstanding ══════════════════════════════════════════════

  /**
   * Customer Outstanding — aggregate receivables with server-side pagination.
   * Outstanding = Invoices + Debit Notes - Payments - Credit Notes
   */
  getCustomerOutstanding(companyId, options = {}) {
    return this.summaryRepo.getCustomerOutstanding(companyId, options);
  }

  /**
   * AR Aging Summary — company-level aging bucket totals.
   */
  getAgingSummary(companyId) {
    return this.summaryRepo.getAgingSummary(companyId);
  }

  /**
   * Customer-level aging with detail and buckets.
   */
  getCustomerAging(contactId, companyId) {
    const result = this.summaryRepo.getCustomerAging(contactId, companyId);
    result.outstanding = result.total;
    return result;
  }

  /**
   * Invoice-level aging for a specific bill.
   */
  getInvoiceAging(billId, companyId) {
    return this.summaryRepo.getInvoiceAging(billId, companyId);
  }

  /**
   * Customer Statement with opening balance, running balance, date range support.
   */
  getCustomerStatement(contactId, companyId, options = {}) {
    return this.summaryRepo.getCustomerStatement(contactId, companyId, options);
  }

  /**
   * Receivables summary KPIs for dashboard.
   */
  getReceivablesSummary(companyId) {
    return this.summaryRepo.getReceivablesSummary(companyId);
  }

  /**
   * Customer payment behavior metrics.
   */
  getCustomerPaymentBehavior(contactId, companyId) {
    return this.summaryRepo.getCustomerPaymentBehavior(contactId, companyId);
  }

  // ═══ Step 12: Collection Management ═══════════════════════════════════════

  /**
   * Get collection assignment for a customer.
   */
  getCollectionAssignment(contactId, companyId) {
    return this.summaryRepo.getCollectionAssignment(contactId, companyId);
  }

  /**
   * Assign or reassign collection owner for a customer.
   */
  assignCollection(contactId, ownerId, companyId, userId, options = {}) {
    // Validate owner exists if provided
    if (ownerId) {
      const user = this.conn.get('SELECT id FROM users WHERE id = ? AND company_id = ?', [ownerId, companyId]);
      if (!user) throw new NotFoundError('User', ownerId);
    }
    return this.summaryRepo.assignCollection(contactId, ownerId, companyId, userId, options);
  }

  /**
   * Update collection status for a customer.
   */
  updateCollectionStatus(contactId, companyId, userId, status, notes = null) {
    return this.summaryRepo.updateCollectionStatus(contactId, companyId, userId, status, notes);
  }

  /**
   * Create a promise-to-pay for a customer.
   */
  createPromiseToPay(contactId, promiseDate, promiseAmount, companyId, userId, options = {}) {
    if (!promiseDate) throw new ValidationError('Promise date is required');
    const amount = toMoney(promiseAmount);
    if (amount <= 0) throw new ValidationError('Promise amount must be greater than zero');
    return this.summaryRepo.createPromiseToPay(contactId, promiseDate, amount, companyId, userId, options);
  }

  /**
   * Update a promise-to-pay status.
   */
  updatePromise(promiseId, companyId, userId, status, options = {}) {
    const validStatuses = ['FULFILLED', 'PARTIAL', 'BROKEN', 'CANCELLED'];
    if (!validStatuses.includes(status)) throw new ValidationError(`Invalid promise status. Must be one of: ${validStatuses.join(', ')}`);
    return this.summaryRepo.updatePromise(promiseId, companyId, userId, status, options);
  }

  /**
   * Log a collection activity.
   */
  logCollectionActivity(contactId, activityType, companyId, userId, options = {}) {
    const validTypes = ['PHONE_CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'REMINDER', 'PROMISE', 'ESCALATION', 'NOTE'];
    if (!validTypes.includes(activityType)) throw new ValidationError(`Invalid activity type. Must be one of: ${validTypes.join(', ')}`);
    return this.summaryRepo.logCollectionActivity(contactId, activityType, companyId, userId, options);
  }

  /**
   * Get collection activities for a customer.
   */
  getCollectionActivities(contactId, companyId, options = {}) {
    return this.summaryRepo.getCollectionActivities(contactId, companyId, options);
  }

  /**
   * Get all promises to pay for a customer.
   */
  getPromisesToPay(contactId, companyId) {
    return this.summaryRepo.getPromisesToPay(contactId, companyId);
  }

  /**
   * Get collection assignments with filters (for dashboard).
   */
  getCollectionAssignments(companyId, options = {}) {
    return this.summaryRepo.getCollectionAssignments(companyId, options);
  }

  /**
   * Collection dashboard KPIs.
   */
  getCollectionDashboard(companyId) {
    return this.summaryRepo.getCollectionDashboard(companyId);
  }

  /**
   * Add a collection activity (alternative to logCollectionActivity with richer data).
   */
  addCollectionActivity(contactId, data) {
    const activityType = data.activity_type;
    const validTypes = ['PHONE_CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'REMINDER', 'PROMISE', 'ESCALATION', 'NOTE'];
    if (!validTypes.includes(activityType)) throw new ValidationError(`Invalid activity type. Must be one of: ${validTypes.join(', ')}`);

    return this.summaryRepo.logCollectionActivity(contactId, activityType, data.company_id, data.user_id, {
      invoice_id: data.invoice_id,
      direction: data.direction || 'OUTBOUND',
      result: data.result,
      notes: data.notes,
      next_action: data.next_action,
      next_action_date: data.next_action_date,
    });
  }

  /**
   * Record a payment against a promise-to-pay.
   * Updates promise status based on fulfillment but does NOT change accounting balances.
   */
  async recordPromisePayment(promiseId, data) {
    const promise = this.conn.get(
      `SELECT * FROM promises_to_pay WHERE id = ? AND company_id = ?`,
      [promiseId, data.company_id]
    );
    if (!promise) throw new NotFoundError('Promise to pay', promiseId);

    const paidAmount = toMoney(data.amount);
    const promisedAmount = parseFloat(promise.amount);

    let status;
    if (paidAmount >= promisedAmount) {
      status = 'FULFILLED';
    } else if (paidAmount > 0) {
      status = 'PARTIAL';
    } else {
      status = promise.status;
    }

    return this.summaryRepo.updatePromise(promiseId, data.company_id, data.user_id, status, {
      notes: `Payment of ${paidAmount} recorded against promise`,
    });
  }

  /**
   * Create a collection-level customer dispute (Step 12).
   */
  createCollectionDispute(data, companyId, userId) {
    return this.summaryRepo.createDispute(data, companyId, userId);
  }

  /**
   * Get collection-level disputes with filtering (Step 12).
   */
  getCollectionDisputes(companyId, options = {}) {
    return this.summaryRepo.getDisputes(companyId, options);
  }

  /**
   * Resolve a collection-level customer dispute (Step 12).
   * Does NOT change accounting balances.
   */
  resolveCollectionDispute(disputeId, data, userId) {
    return this.summaryRepo.resolveDispute(disputeId, data, userId);
  }

  // ═══ Step 13: Report Service Methods ═══════════════════════════════════════

  getBillingDashboard(companyId, startDate, endDate) {
    const result = this.reportRepo.getBillingDashboard(companyId, startDate, endDate);
    return { totals: result };
  }

  getBillingTrend(companyId, options = {}) {
    return this.reportRepo.getBillingTrend(companyId, options);
  }

  getSalesRegister(companyId, options = {}) {
    return this.reportRepo.getSalesRegister(companyId, options);
  }

  getInvoiceRegister(companyId, options = {}) {
    return this.reportRepo.getInvoiceRegister(companyId, options);
  }

  getCustomerOutstandingReport(companyId, options = {}) {
    return this.reportRepo.getCustomerOutstandingReport(companyId, options);
  }

  getTaxReport(companyId, options = {}) {
    return this.reportRepo.getTaxReport(companyId, options);
  }

  getSalespersonReport(companyId, options = {}) {
    return this.reportRepo.getSalespersonReport(companyId, options);
  }

  getProductSalesReport(companyId, options = {}) {
    return this.reportRepo.getProductSalesReport(companyId, options);
  }

  getBranchWarehouseReport(companyId, options = {}) {
    return this.reportRepo.getBranchWarehouseReport(companyId, options);
  }

  getPaymentRegister(companyId, options = {}) {
    return this.reportRepo.getPaymentRegister(companyId, options);
  }

  getCollectionPerformance(companyId, options = {}) {
    return this.reportRepo.getCollectionPerformance(companyId, options);
  }

  getCollectionReport(companyId, options = {}) {
    return this.reportRepo.getCollectionReport(companyId, options);
  }

  getOverdueAnalytics(companyId, options = {}) {
    return this.reportRepo.getOverdueAnalytics(companyId, options);
  }

  getTopCustomers(companyId, options = {}) {
    return this.reportRepo.getTopCustomers(companyId, options);
  }

  getCollectionTrend(companyId, options = {}) {
    return this.reportRepo.getCollectionTrend(companyId, options);
  }

  getPaymentMethodDistribution(companyId, options = {}) {
    return this.reportRepo.getPaymentMethodDistribution(companyId, options);
  }

  getAgingDistribution(companyId, options = {}) {
    return this.reportRepo.getAgingDistribution(companyId, options);
  }

  getCreditNoteRegister(companyId, options = {}) {
    return this.reportRepo.getCreditNoteRegister(companyId, options);
  }

  getDebitNoteRegister(companyId, options = {}) {
    return this.reportRepo.getDebitNoteRegister(companyId, options);
  }

  // ═══ Step 14: Receivables Follow-up & Collections Automation ════════════════

  // ── Collection Rules ──
  listCollectionRules(companyId, options) { const items = this.collectionsService.listCollectionRules(companyId, options); return { items, total: items.length }; }
  getCollectionRule(id, companyId) { return this.collectionsService.getCollectionRule(id, companyId); }
  createCollectionRule(companyId, data, userId) { return this.collectionsService.createCollectionRule(companyId, data, userId); }
  updateCollectionRule(id, companyId, data, userId) { return this.collectionsService.updateCollectionRule(id, companyId, data, userId); }
  deleteCollectionRule(id, companyId) { return this.collectionsService.deleteCollectionRule(id, companyId); }

  // ── Dunning ──
  runDunning(companyId, asOfDate) { return this.collectionsService.runDunning(companyId, asOfDate); }

  // ── Collection Actions ──
  listCollectionActions(companyId, options) {
    const items = this.collectionsService.listCollectionActions(companyId, options);
    return { items, total: items.length };
  }
  getCollectionAction(id, companyId) { return this.collectionsService.getCollectionAction(id, companyId); }
  createCollectionAction(companyId, data, userId) { return this.collectionsService.createCollectionAction(companyId, data, userId); }
  executeCollectionAction(id, companyId, userId, responseStatus) { return this.collectionsService.executeCollectionAction(id, companyId, userId, responseStatus); }

  // ── Templates ──
  listTemplates(companyId, options) { const items = this.collectionsService.listTemplates(companyId, options); return items; }
  getTemplate(id, companyId) { return this.collectionsService.getTemplate(id, companyId); }
  createTemplate(companyId, data, userId) { return this.collectionsService.createTemplate(companyId, data, userId); }
  renderTemplate(body, variables) { return this.collectionsService.renderTemplate(body, variables); }

  // ── Interest ──
  listInterestRules(companyId, options) { const items = this.collectionsService.listInterestRules(companyId, options); return items; }
  getInterestRule(id, companyId) { return this.collectionsService.getInterestRule(id, companyId); }
  createInterestRule(companyId, data, userId) { return this.collectionsService.createInterestRule(companyId, data, userId); }
  calculateInterest(companyId, billId, calcDate) { return this.collectionsService.calculateInterest(companyId, billId, calcDate); }
  createInterestCharge(companyId, billId, calcDate, userId) { return this.collectionsService.createInterestCharge(companyId, billId, calcDate, userId); }
  approveInterestCharge(id, companyId, amount, userId) { return this.collectionsService.approveInterestCharge(id, companyId, amount, userId); }
  postInterestCharge(id, companyId, userId) { return this.collectionsService.postInterestCharge(id, companyId, userId); }

  // ── Bad Debt ──
  listBadDebtCases(companyId, options) {
    const items = this.collectionsService.listBadDebtCases(companyId, options);
    return { items, total: items.length };
  }
  getBadDebtCase(id, companyId) { return this.collectionsService.getBadDebtCase(id, companyId); }
  createBadDebtCase(companyId, data, userId) { return this.collectionsService.createBadDebtCase(companyId, data, userId); }
  approveBadDebtCase(id, companyId, userId) { return this.collectionsService.approveBadDebtCase(id, companyId, userId); }
  writeOffBadDebt(id, companyId, userId) { return this.collectionsService.writeOffBadDebt(id, companyId, userId); }
  reverseBadDebtCase(id, companyId, userId) { return this.collectionsService.reverseBadDebtCase(id, companyId, userId); }

  // ── Payment Plans ──
  listPaymentPlans(companyId, options) {
    const items = this.collectionsService.listPaymentPlans(companyId, options);
    return { items, total: items.length };
  }
  getPaymentPlan(id, companyId) { return this.collectionsService.getPaymentPlan(id, companyId); }
  createPaymentPlan(companyId, data, userId) {
    return this.collectionsService.createPaymentPlan(companyId, data, userId);
  }
  approvePaymentPlan(id, companyId, userId) { return this.collectionsService.approvePaymentPlan(id, companyId, userId); }
  cancelPaymentPlan(id, companyId, userId) { return this.collectionsService.cancelPaymentPlan(id, companyId, userId); }
  applyPaymentToPlan(companyId, planId, paymentId, amount) { return this.collectionsService.applyPaymentToPlan(companyId, planId, paymentId, amount); }

  // ── Risk Scoring ──
  calculateRiskScore(companyId, contactId) { return this.collectionsService.calculateRiskScore(companyId, contactId); }

  // ── Forecast ──
  getCollectionForecast(companyId, options) { return this.collectionsService.getCollectionForecast(companyId, options); }

  // ── Escalation ──
  createEscalation(companyId, contactId, billId, level, reason, userId) { return this.collectionsService.createEscalation(companyId, contactId, billId, level, reason, userId); }
  listEscalations(companyId, options) {
    const items = this.collectionsService.listEscalations(companyId, options);
    return { items, total: items.length };
  }
  approveEscalation(id, companyId, userId) { return this.collectionsService.approveEscalation(id, companyId, userId); }

  // ── Dashboard ──
  getCollectionsDashboard(companyId) { return this.collectionsService.getCollectionsDashboard(companyId); }
}

module.exports = { CustomerBillService, VALID_TRANSITIONS };
