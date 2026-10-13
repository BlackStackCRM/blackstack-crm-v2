/**
 * Tax / GST Calculation Engine (Step 17)
 *
 * Server-side tax calculation that determines:
 *   - Place of supply (intra-state vs inter-state)
 *   - Applicable tax components (CGST + SGST vs IGST vs Cess)
 *   - Tax amounts using bank-grade integer arithmetic (paise precision)
 *
 * Architecture:
 *   Tax/GST Master → Tax Calculation Engine → Accounting Mapping → JE Engine → Ledger
 *
 * This service does NOT post accounting entries — it only calculates tax
 * breakdowns. The AccountingController integrates results into JE lines.
 *
 * All monetary calculations use integer paise arithmetic to avoid
 * floating-point errors. 1 rupee = 100 paise.
 */

const { NotFoundError, ValidationError, AppError } = require('../utils/errors');
const { generateId } = require('../utils/generateId');

/**
 * Convert rupees to paise (integer).
 * @param {number|string} rupees
 * @returns {number} paise as integer
 */
function toPaise(rupees) {
  const val = parseFloat(rupees);
  if (isNaN(val)) return 0;
  return Math.round(val * 100);
}

/**
 * Convert paise back to rupees (float, 2 decimal places).
 * @param {number} paise
 * @returns {number} rupees rounded to 2 decimal places
 */
function fromPaise(paise) {
  return Math.round(paise) / 100;
}

const TAX_TYPE_CODES = ['CGST', 'SGST', 'IGST', 'CESS', 'ZERO_RATED', 'EXEMPT', 'NIL_RATED', 'NON_TAXABLE'];

/**
 * TaxService — reusable tax/GST calculation engine.
 *
 * Usage:
 *   const taxService = new TaxService(conn);
 *   const result = taxService.calculateTax({
 *     companyId, taxableAmount, taxMasterId, partyState, ...
 *   });
 */
class TaxService {
  constructor(conn) {
    this.conn = conn;
  }

  // ─── Tax Master CRUD ───────────────────────────────────────────────

  /**
   * Create a new tax master with components.
   */
  createTaxMaster(data, userId) {
    const companyId = data.companyId || 'default';
    const { code, name, is_igst, rate, effective_from, effective_to, description, components } = data;

    if (!code || !name || !effective_from) {
      throw new ValidationError('code, name, effective_from are required for tax master');
    }
    const rateNum = parseFloat(rate);
    if (isNaN(rateNum) || rateNum < 0) {
      throw new ValidationError('rate must be a valid non-negative number');
    }

    const id = generateId('tax');
    const now = new Date().toISOString();

    this.conn.transaction(() => {
      const existing = this.conn.get('SELECT id FROM tax_masters WHERE company_id = ? AND code = ?', [companyId, code]);
      if (existing) throw new ValidationError(`Tax master with code "${code}" already exists`);

      this.conn.prepare(`
        INSERT INTO tax_masters (id, company_id, code, name, is_igst, rate, effective_from, effective_to, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, companyId, code, name, is_igst ? 1 : 0, rateNum, effective_from, effective_to || null, description || null, now, now);

      // Insert components if provided
      if (components && Array.isArray(components) && components.length > 0) {
        for (const comp of components) {
          if (!comp.tax_type_code || comp.rate === undefined) {
            throw new ValidationError('Each component requires tax_type_code and rate');
          }
          this.conn.prepare(`
            INSERT INTO tax_components (id, company_id, tax_master_id, tax_type_code, rate, is_compound, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            generateId('tcx'), companyId, id, comp.tax_type_code,
            parseFloat(comp.rate), comp.is_compound ? 1 : 0, now
          );
        }
      }
    })();

    return { id, company_id: companyId, code, name, is_igst, rate: rateNum, effective_from, effective_to, description };
  }

  /**
   * List tax masters with optional filters.
   */
  listTaxMasters(companyId, options = {}) {
    const company = companyId || 'default';
    const where = ['tm.company_id = ?'];
    const params = [company];

    if (options.isActive !== undefined) {
      where.push('tm.is_active = ?');
      params.push(options.isActive);
    }
    if (options.query) {
      where.push('(tm.code LIKE ? OR tm.name LIKE ?)');
      params.push(`%${options.query}%`, `%${options.query}%`);
    }

    return this.conn.all(`
      SELECT tm.*, 
        (SELECT COUNT(*) FROM tax_components tc WHERE tc.tax_master_id = tm.id) as component_count
      FROM tax_masters tm
      WHERE ${where.join(' AND ')}
      ORDER BY tm.rate ASC, tm.name
    `, params);
  }

  /**
   * Get a single tax master with its components.
   */
  getTaxMaster(id, companyId) {
    const company = companyId || 'default';
    const master = this.conn.get(
      'SELECT * FROM tax_masters WHERE id = ? AND company_id = ?', [id, company]
    );
    if (!master) throw new NotFoundError('TaxMaster', id);

    const components = this.conn.all(
      'SELECT * FROM tax_components WHERE tax_master_id = ? AND company_id = ? ORDER BY tax_type_code ASC',
      [id, company]
    );

    return { ...master, components };
  }

  /**
   * Update a tax master. Cannot change system-seeded tax masters' critical fields.
   */
  updateTaxMaster(id, data, companyId) {
    const company = companyId || 'default';
    const now = new Date().toISOString();
    const updates = [];
    const params = [];

    const updatable = ['name', 'is_igst', 'rate', 'effective_from', 'effective_to', 'is_active', 'description'];
    for (const key of updatable) {
      if (data[key] !== undefined) {
        updates.push(`${key} = ?`);
        params.push(key === 'is_igst' || key === 'is_active' ? (data[key] ? 1 : 0) : data[key]);
      }
    }

    // Check system flag
    const existing = this.conn.get('SELECT is_system FROM tax_masters WHERE id = ? AND company_id = ?', [id, company]);
    if (!existing) throw new NotFoundError('TaxMaster', id);
    if (existing.is_system === 1) {
      if (data.code !== undefined || data.rate !== undefined || data.is_igst !== undefined) {
        throw new ValidationError('Cannot modify critical fields of a system-seeded tax master');
      }
    }

    if (updates.length > 0) {
      params.push(now, id, company);
      this.conn.prepare(`UPDATE tax_masters SET ${updates.join(', ')}, updated_at = ? WHERE id = ? AND company_id = ?`).run(...params);
    }

    return this.getTaxMaster(id, company);
  }

  /**
   * Toggle tax master status (activate/deactivate).
   */
  toggleTaxStatus(id, isActive, companyId) {
    const company = companyId || 'default';
    const master = this.conn.get('SELECT id, is_system FROM tax_masters WHERE id = ? AND company_id = ?', [id, company]);
    if (!master) throw new NotFoundError('TaxMaster', id);

    this.conn.prepare('UPDATE tax_masters SET is_active = ?, updated_at = ? WHERE id = ? AND company_id = ?').run(
      isActive ? 1 : 0, new Date().toISOString(), id, company
    );

    return this.getTaxMaster(id, company);
  }

  // ─── Company Tax Configuration ─────────────────────────────────────

  /**
   * Get or create company-level tax configuration.
   */
  getCompanyTaxConfig(companyId) {
    const company = companyId || 'default';
    return this.conn.get(
      'SELECT * FROM company_tax_configs WHERE company_id = ?', [company]
    );
  }

  /**
   * Set company tax configuration (GSTIN, state, etc.).
   */
  setCompanyTaxConfig(data, companyId, userId) {
    const company = companyId || 'default';
    const { gst_enabled, gstin, state_name, state_code, registration_type, round_off_tax, tax_decimal_places } = data;
    const now = new Date().toISOString();

    const existing = this.conn.get('SELECT id FROM company_tax_configs WHERE company_id = ?', [company]);

    if (existing) {
      this.conn.prepare(`
        UPDATE company_tax_configs SET
          gst_enabled = ?, gstin = ?, state_name = ?, state_code = ?,
          registration_type = ?, round_off_tax = ?, tax_decimal_places = ?,
          updated_at = ?
        WHERE company_id = ?
      `).run(
        gst_enabled ? 1 : 0, gstin || null, state_name || null, state_code || null,
        registration_type || null, round_off_tax ? 1 : 0, tax_decimal_places || 2, now, company
      );
    } else {
      this.conn.prepare(`
        INSERT INTO company_tax_configs
          (id, company_id, gst_enabled, gstin, state_name, state_code, registration_type,
           round_off_tax, tax_decimal_places, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        generateId('ctc'), company, gst_enabled ? 1 : 0, gstin || null, state_name || null, state_code || null,
        registration_type || null, round_off_tax ? 1 : 0, tax_decimal_places || 2, now, now
      );
    }

    return this.getCompanyTaxConfig(company);
  }

  // ─── Tax Account Mappings ──────────────────────────────────────────

  /**
   * Create/update a tax account mapping.
   */
  upsertTaxAccountMapping(data, companyId) {
    const company = companyId || 'default';
    const { tax_type_code, tax_scope, ledger_account_id, is_active } = data;
    const now = new Date().toISOString();

    // Validate the ledger account exists and belongs to company
    const acc = this.conn.get(
      'SELECT id, is_active, allow_direct_posting FROM accounts WHERE id = ? AND company_id = ?',
      [ledger_account_id, company]
    );
    if (!acc) throw new ValidationError('Ledger account not found or not accessible');
    if (acc.is_active === 0) throw new ValidationError('Ledger account is inactive');
    if (acc.allow_direct_posting === 0) throw new ValidationError('Ledger account does not allow direct posting');

    const existing = this.conn.get(
      'SELECT id FROM tax_account_mappings WHERE company_id = ? AND tax_type_code = ? AND tax_scope = ?',
      [company, tax_type_code, tax_scope]
    );

    if (existing) {
      this.conn.prepare(`
        UPDATE tax_account_mappings SET ledger_account_id = ?, is_active = ?, updated_at = ?
        WHERE id = ? AND company_id = ?
      `).run(ledger_account_id, is_active !== undefined ? (is_active ? 1 : 0) : 1, now, existing.id, company);
    } else {
      this.conn.prepare(`
        INSERT INTO tax_account_mappings (id, company_id, tax_type_code, tax_scope, ledger_account_id, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(generateId('tam'), company, tax_type_code, tax_scope, ledger_account_id, is_active !== undefined ? (is_active ? 1 : 0) : 1, now, now);
    }

    return this.listTaxAccountMappings(company);
  }

  /**
   * List all tax account mappings for a company.
   */
  listTaxAccountMappings(companyId) {
    const company = companyId || 'default';
    return this.conn.all(`
      SELECT tam.*, a.code as ledger_code, a.name as ledger_name, a.type as ledger_type
      FROM tax_account_mappings tam
      JOIN accounts a ON a.id = tam.ledger_account_id AND a.company_id = tam.company_id
      WHERE tam.company_id = ?
      ORDER BY tam.tax_scope, tam.tax_type_code
    `, [company]);
  }

  // ─── Tax Calculation Engine ────────────────────────────────────────

  /**
   * Determine whether a transaction is intra-state or inter-state.
   *
   * @param {string} companyState - company's state code (e.g. '29' for Karnataka)
   * @param {string} partyState - party's (customer/supplier) state code
   * @returns {'INTRA_STATE'|'INTER_STATE'}
   */
  determineTaxType(companyState, partyState) {
    if (!companyState || !partyState) {
      // Default to intra-state if states are not configured
      return 'INTRA_STATE';
    }
    return String(companyState).trim() === String(partyState).trim()
      ? 'INTRA_STATE'
      : 'INTER_STATE';
  }

  /**
   * Calculate tax for a given taxable amount and tax master.
   *
   * Uses integer paise arithmetic for all calculations to avoid
   * floating-point rounding errors. Tax rounding is done per-component
   * then summed.
   *
   * @param {Object} opts
   * @param {string} opts.companyId
   * @param {number} opts.taxableAmount - the base amount to tax
   * @param {string} opts.taxMasterId
   * @param {string} opts.partyState - party state code for place-of-supply determination
   * @param {string} opts.companyState - company state code (falls back to config)
   * @returns {Object} structured tax result
   */
  calculateTax(opts) {
    const companyId = opts.companyId || 'default';
    const taxableAmount = parseFloat(opts.taxableAmount) || 0;
    const taxMasterId = opts.taxMasterId;
    const partyState = opts.partyState;
    const companyState = opts.companyState;

    if (taxableAmount <= 0) {
      return {
        taxable_amount: 0,
        tax_rate: 0,
        cgst_rate: 0, sgst_rate: 0, igst_rate: 0, cess_rate: 0,
        cgst_amount: 0, sgst_amount: 0, igst_amount: 0, cess_amount: 0,
        total_tax: 0,
        grand_total: 0,
        is_interstate: false,
        tax_type: 'NON_TAXABLE',
        components: [],
        breakdown: []
      };
    }

    // Get company tax config
    const config = this.getCompanyTaxConfig(companyId);
    const effectiveCompanyState = companyState || config?.state_code;

    // Determine intra vs inter state
    const taxType = this.determineTaxType(effectiveCompanyState, partyState);
    const isInterState = taxType === 'INTER_STATE';

    // Get tax master
    const master = taxMasterId
      ? this.getTaxMaster(taxMasterId, companyId)
      : null;

    if (!master) {
      // No tax master — return zero-tax result
      return {
        taxable_amount: taxableAmount,
        tax_rate: 0,
        cgst_rate: 0, sgst_rate: 0, igst_rate: 0, cess_rate: 0,
        cgst_amount: 0, sgst_amount: 0, igst_amount: 0, cess_amount: 0,
        total_tax: 0,
        grand_total: taxableAmount,
        is_interstate: isInterState,
        tax_type: 'NON_TAXABLE',
        components: [],
        breakdown: []
      };
    }

    if (!master.is_active || master.is_active === 0) {
      throw new ValidationError(`Tax master "${master.name}" is inactive`);
    }

    // Get tax components
    const components = master.components || [];
    if (components.length === 0) {
      // Try to auto-derive components from rate
      // For intrastate: split rate/2 CGST + rate/2 SGST
      // For interstate: full rate as IGST
      if (isInterState) {
        components.push({ tax_type_code: 'IGST', rate: master.rate });
      } else {
        components.push({ tax_type_code: 'CGST', rate: master.rate / 2 });
        components.push({ tax_type_code: 'SGST', rate: master.rate / 2 });
      }
    }

    // For intrastate: use CGST+SGST, ignore IGST components
    // For interstate: use IGST, ignore CGST+SGST components
    const applicableComponents = components.filter(comp => {
      const code = comp.tax_type_code;
      if (isInterState) {
        // For interstate, only IGST and CESS apply
        return code === 'IGST' || code === 'CESS';
      } else {
        // For intrastate, CGST, SGST, CESS apply; IGST does not
        return code === 'CGST' || code === 'SGST' || code === 'CESS';
      }
    });

    // Calculate tax amounts using paise arithmetic
    const taxablePaise = toPaise(taxableAmount);
    let totalTaxPaise = 0;
    const breakdown = [];

    let cgstAmount = 0, sgstAmount = 0, igstAmount = 0, cessAmount = 0;
    let cgstRate = 0, sgstRate = 0, igstRate = 0, cessRate = 0;

    for (const comp of applicableComponents) {
      const compRate = parseFloat(comp.rate);
      const compAmountPaise = Math.round((taxablePaise * compRate) / 100);

      const amount = fromPaise(compAmountPaise);
      totalTaxPaise += compAmountPaise;

      // Handle round-off to nearest rupee if configured
      if (config?.round_off_tax === 1) {
        // Round each component to nearest rupee
      }

      breakdown.push({
        tax_type_code: comp.tax_type_code,
        rate: compRate,
        amount: amount,
        tax_scope: comp.tax_type_code === 'IGST' ? 'OUTPUT' :
                   comp.tax_type_code === 'CESS' ? 'OUTPUT' :
                   (isInterState ? 'OUTPUT' : 'OUTPUT')
      });

      switch (comp.tax_type_code) {
        case 'CGST': cgstAmount += amount; cgstRate = compRate; break;
        case 'SGST': sgstAmount += amount; sgstRate = compRate; break;
        case 'IGST': igstAmount += amount; igstRate = compRate; break;
        case 'CESS': cessAmount += amount; cessRate = compRate; break;
      }
    }

    // Round-off adjustment: ensure sum of components equals total
    const totalTaxRounded = fromPaise(totalTaxPaise);
    const breakdownSum = fromPaise(breakdown.reduce((s, b) => s + toPaise(b.amount), 0));
    if (Math.abs(totalTaxRounded - breakdownSum) > 0.01 && breakdown.length > 0) {
      // Adjust the last component to make the sum match
      const diff = fromPaise(totalTaxPaise) - breakdownSum;
      breakdown[breakdown.length - 1].amount = parseFloat((breakdown[breakdown.length - 1].amount + diff).toFixed(2));
    }

    // Round to configured decimal places
    const decimalPlaces = config?.tax_decimal_places || 2;
    cgstAmount = parseFloat(cgstAmount.toFixed(decimalPlaces));
    sgstAmount = parseFloat(sgstAmount.toFixed(decimalPlaces));
    igstAmount = parseFloat(igstAmount.toFixed(decimalPlaces));
    cessAmount = parseFloat(cessAmount.toFixed(decimalPlaces));
    const totalTax = parseFloat(fromPaise(totalTaxPaise).toFixed(decimalPlaces));
    const grandTotal = parseFloat((taxableAmount + totalTax).toFixed(decimalPlaces));

    return {
      taxable_amount: taxableAmount,
      tax_rate: isInterState ? igstRate : (cgstRate + sgstRate),
      cgst_rate: cgstRate,
      sgst_rate: sgstRate,
      igst_rate: igstRate,
      cess_rate: cessRate,
      cgst_amount: cgstAmount,
      sgst_amount: sgstAmount,
      igst_amount: igstAmount,
      cess_amount: cessAmount,
      total_tax: totalTax,
      grand_total: grandTotal,
      is_interstate: isInterState,
      tax_type: isInterState ? 'IGST' : 'CGST+SGST',
      tax_master_id: master.id,
      tax_master_code: master.code,
      tax_master_name: master.name,
      place_of_supply: partyState ? partyState : null,
      components: applicableComponents,
      breakdown: breakdown
    };
  }

  /**
   * Get tax account mapping for a given tax type code and scope.
   * Returns the ledger_account_id for posting JE lines.
   */
  getTaxLedgerAccount(companyId, taxTypeCode, taxScope) {
    const company = companyId || 'default';
    const row = this.conn.get(
      'SELECT tam.ledger_account_id, tam.is_active, a.code, a.name, a.debit_credit_nature FROM tax_account_mappings tam ' +
      'JOIN accounts a ON a.id = tam.ledger_account_id AND a.company_id = tam.company_id ' +
      'WHERE tam.company_id = ? AND tam.tax_type_code = ? AND tam.tax_scope = ?',
      [company, taxTypeCode, taxScope]
    );
    return row;
  }

  /**
   * Save transaction tax details (auditable record of tax calculation).
   */
  saveTransactionTaxDetails(data) {
    const {
      companyId, voucherId, journalEntryId, taxMasterId, taxableAmount,
      taxType, taxRate, cgstRate, sgstRate, igstRate, cessRate,
      cgstAmount, sgstAmount, igstAmount, cessAmount, totalTax,
      grandTotal, placeOfSupply, isInterstate, breakdown, userId
    } = data;

    const id = generateId('ttd');
    const now = new Date().toISOString();

        this.conn.prepare(`
      INSERT INTO transaction_tax_details
        (id, company_id, voucher_id, journal_entry_id, tax_master_id, taxable_amount,
         tax_type, tax_rate, cgst_rate, sgst_rate, igst_rate, cess_rate,
         cgst_amount, sgst_amount, igst_amount, cess_amount, total_tax, grand_total,
         place_of_supply, is_interstate, calculation_json, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, companyId || 'default', voucherId, journalEntryId || null, taxMasterId || null,
      parseFloat(taxableAmount) || 0,
      taxType || null, parseFloat(taxRate) || 0,
      parseFloat(cgstRate) || 0, parseFloat(sgstRate) || 0, parseFloat(igstRate) || 0, parseFloat(cessRate) || 0,
      parseFloat(cgstAmount) || 0, parseFloat(sgstAmount) || 0, parseFloat(igstAmount) || 0, parseFloat(cessAmount) || 0,
      parseFloat(totalTax) || 0, parseFloat(grandTotal) || 0,
      placeOfSupply || null, isInterstate ? 1 : 0,
      JSON.stringify(breakdown || []),
      now, userId || 'system'
    );

    return id;
  }

  /**
   * Get tax details for a voucher.
   */
  getTransactionTaxDetails(voucherId, companyId) {
    const company = companyId || 'default';
    return this.conn.get(
      'SELECT * FROM transaction_tax_details WHERE voucher_id = ? AND company_id = ?',
      [voucherId, company]
    );
  }

  /**
   * Build additional JE lines for tax postings.
   *
   * For a SALES invoice with CGST+SGST:
   *   - Additional CREDIT lines: Output CGST, Output SGST
   *   - Additional DEBIT line on receiving account is already the full amount
   *
   * For a SALES invoice with IGST:
   *   - Additional CREDIT line: Output IGST
   *
   * For a PURCHASE invoice with CGST+SGST:
   *   - Additional DEBIT lines: Input CGST, Input SGST
   *
   * @param {Object} taxResult - result from calculateTax()
   * @param {string} companyId
   * @param {string} narration
   * @returns {Array} JE line objects for tax postings
   */
  buildTaxJELines(taxResult, companyId, narration) {
    const company = companyId || 'default';
    const lines = [];

    if (!taxResult || (!taxResult.cgst_amount && !taxResult.sgst_amount && !taxResult.igst_amount && !taxResult.cess_amount)) {
      return lines;
    }

    // Output tax (for sales): credit side
    if (taxResult.cgst_amount > 0) {
      const mapping = this.getTaxLedgerAccount(company, 'CGST', 'OUTPUT');
      if (mapping && mapping.is_active === 1) {
        lines.push({
          account_id: mapping.ledger_account_id,
          debit_amount: 0,
          credit_amount: taxResult.cgst_amount,
          description: `Output CGST @ ${taxResult.cgst_rate}%`,
          reference_id: null
        });
      }
    }

    if (taxResult.sgst_amount > 0) {
      const mapping = this.getTaxLedgerAccount(company, 'SGST', 'OUTPUT');
      if (mapping && mapping.is_active === 1) {
        lines.push({
          account_id: mapping.ledger_account_id,
          debit_amount: 0,
          credit_amount: taxResult.sgst_amount,
          description: `Output SGST @ ${taxResult.sgst_rate}%`,
          reference_id: null
        });
      }
    }

    if (taxResult.igst_amount > 0) {
      const mapping = this.getTaxLedgerAccount(company, 'IGST', 'OUTPUT');
      if (mapping && mapping.is_active === 1) {
        lines.push({
          account_id: mapping.ledger_account_id,
          debit_amount: 0,
          credit_amount: taxResult.igst_amount,
          description: `Output IGST @ ${taxResult.igst_rate}%`,
          reference_id: null
        });
      }
    }

    // Input tax (for purchases/expenses): debit side
    // Note: buildTaxJELines is called for sales (output). For purchases/expenses,
    // a separate call with INPUT scope is needed.
    // This method handles OUTPUT tax (sales context).

    return lines;
  }

  /**
   * Build JE lines for INPUT tax (purchases, expenses).
   * These are DEBIT lines (increasing asset/liability reduction).
   */
  buildInputTaxJELines(taxResult, companyId, narration) {
    const company = companyId || 'default';
    const lines = [];

    if (!taxResult || (!taxResult.cgst_amount && !taxResult.sgst_amount && !taxResult.igst_amount && !taxResult.cess_amount)) {
      return lines;
    }

    if (taxResult.cgst_amount > 0) {
      const mapping = this.getTaxLedgerAccount(company, 'CGST', 'INPUT');
      if (mapping && mapping.is_active === 1) {
        lines.push({
          account_id: mapping.ledger_account_id,
          debit_amount: taxResult.cgst_amount,
          credit_amount: 0,
          description: `Input CGST @ ${taxResult.cgst_rate}%`,
          reference_id: null
        });
      }
    }

    if (taxResult.sgst_amount > 0) {
      const mapping = this.getTaxLedgerAccount(company, 'SGST', 'INPUT');
      if (mapping && mapping.is_active === 1) {
        lines.push({
          account_id: mapping.ledger_account_id,
          debit_amount: taxResult.sgst_amount,
          credit_amount: 0,
          description: `Input SGST @ ${taxResult.sgst_rate}%`,
          reference_id: null
        });
      }
    }

    if (taxResult.igst_amount > 0) {
      const mapping = this.getTaxLedgerAccount(company, 'IGST', 'INPUT');
      if (mapping && mapping.is_active === 1) {
        lines.push({
          account_id: mapping.ledger_account_id,
          debit_amount: taxResult.igst_amount,
          credit_amount: 0,
          description: `Input IGST @ ${taxResult.igst_rate}%`,
          reference_id: null
        });
      }
    }

    if (taxResult.cess_amount > 0) {
      const mapping = this.getTaxLedgerAccount(company, 'CESS', 'INPUT');
      if (mapping && mapping.is_active === 1) {
        lines.push({
          account_id: mapping.ledger_account_id,
          debit_amount: taxResult.cess_amount,
          credit_amount: 0,
          description: `Input CESS @ ${taxResult.cess_rate}%`,
          reference_id: null
        });
      }
    }

    return lines;
  }

  /**
   * Log a tax audit event.
   */
  logAudit(companyId, userId, action, entityType, entityId, oldValues, newValues) {
    const { generateId } = require('../utils/generateId');
    this.conn.prepare(`
      INSERT INTO tax_audit_log (id, company_id, user_id, action, entity_type, entity_id, old_values_json, new_values_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      generateId('taud'), companyId || 'default', userId || 'system', action, entityType,
      entityId,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null
    );
  }
}

module.exports = { TaxService, toPaise, fromPaise, TAX_TYPE_CODES };
