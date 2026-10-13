/**
 * Step 17: Tax / GST Master & Accounting Integration — Test Suite
 * 
 * Tests the tax/GST integration across Sales, Purchase, Expense, Credit Note, and Debit Note.
 * Uses the same test pattern as accounting-complete.test.js.
 */
const BASE_URL = 'http://localhost:3000/api/accounting';
const { DatabaseSync } = require('node:sqlite');
// PHASE 3 — TEST DATABASE SAFETY.
// This file previously resolved:
//     const DB_PATH = process.env.DB_PATH || 'data/blackstack-crm.db';
// so running it WITHOUT DB_PATH set pointed its destructive SQL
// (its writes) at the LIVE production database. It now clones production into
// an isolated temp directory and asserts the result through the project's
// existing allow-list, so there is no production fallback to reach.
const { createDisposableDb } = require('../scripts/assert-disposable-db');
const { dbPath: DB_PATH, cleanup: _cleanupDisposableDb } = createDisposableDb({
  suite: 'tax-gst',
  prefix: 'bscrm-taxgst-',
});

let passed = 0;
let failed = 0;
const errors = [];

async function login() {
  const res = await fetch(`http://localhost:3000/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@blackstack.local', password: 'admin123' })
  });
  const data = await res.json();
  if (!data.success) throw new Error('Login failed');
  return data.data.token;
}

async function api(token, path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  });
  return await res.json();
}

function dbGet(sql, params = []) {
  const db = new DatabaseSync(DB_PATH);
  const result = params.length > 0 ? db.prepare(sql).get(...params) : db.prepare(sql).get();
  db.close();
  return result;
}

function dbQuery(sql, params = []) {
  const db = new DatabaseSync(DB_PATH);
  const result = params.length > 0 ? db.prepare(sql).all(...params) : db.prepare(sql).all();
  db.close();
  return result;
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✅ ' + name);
  } catch (err) {
    failed++;
    errors.push({ name, error: err.message });
    console.log('  ❌ ' + name + ': ' + err.message);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function run() {
  console.log('========================================');
  console.log('  Step 17: Tax / GST Master & Accounting Integration');
  console.log('========================================');

  const token = await login();
  
  let activeFyId = null;
  let contactId = 'cnt_001';
  let salesVoucherId = null;
  let purchaseVoucherId = null;
  let creditNoteId = null;
  let debitNoteId = null;

  // Setup: Get active financial year
  const fyInit = await api(token, '/financial-years');
  const fyData = fyInit.data.items || fyInit.data;
  const activeFy = fyData.find(f => f.is_active === 1 || f.isActive === 1);
  if (activeFy) activeFyId = activeFy.id;

  // ═══ Tax Master Management ═══
  console.log('\n── Tax Master Management ──');

  await test('List tax masters (seeded defaults exist)', async () => {
    const r = await api(token, '/taxes');
    assert(r.success, 'List taxes should succeed');
    const items = r.data.items || r.data;
    assert(items.length > 0, 'Should have seeded tax masters');
    const gst18Intra = items.find(t => t.code === 'GST_18_INTRASTATE');
    assert(gst18Intra, 'Should have GST_18_INTRASTATE');
    const gst18Inter = items.find(t => t.code === 'GST_18_INTERSTATE');
    assert(gst18Inter, 'Should have GST_18_INTERSTATE');
  });

  await test('Get tax master with components', async () => {
    const allTaxes = await api(token, '/taxes');
    const items = allTaxes.data.items || allTaxes.data;
    const tax = items.find(t => t.id === 'tax_gst_18_intra');
    assert(tax, 'Should find tax_gst_18_intra');
    const r = await api(token, `/taxes/${tax.id}`);
    assert(r.success, 'Get tax should succeed');
    const components = r.data.components || r.data.componentCount > 0;
    assert(components && components.length === 2, 'Should have 2 components (CGST + SGST)');
    assert(components[0].taxTypeCode === 'CGST', 'First component should be CGST');
    assert(components[1].taxTypeCode === 'SGST', 'Second component should be SGST');
  });

  await test('Tax account mappings exist', async () => {
    const r = await api(token, '/taxes/account-mappings');
    assert(r.success, 'List mappings should succeed');
    const mappings = r.data.items || r.data;
    assert(mappings.length >= 8, 'Should have 8+ mappings (CGST/SGST/IGST/CESS x INPUT/OUTPUT)');
    const outCgst = mappings.find(m => m.taxTypeCode === 'CGST' && m.taxScope === 'OUTPUT');
    assert(outCgst, 'Should have OUTPUT CGST mapping');
    const inCgst = mappings.find(m => m.taxTypeCode === 'CGST' && m.taxScope === 'INPUT');
    assert(inCgst, 'Should have INPUT CGST mapping');
  });

  await test('Company tax config exists (GST enabled, Karnataka)', async () => {
    const r = await api(token, '/taxes/company-config');
    assert(r.success, 'Get company config should succeed');
    assert(r.data, 'Config should not be null');
    assert(r.data.gstEnabled === 1, 'GST should be enabled');
    assert(r.data.stateCode === '29', 'State code should be 29 (Karnataka)');
  });

  // ═══ Tax Calculation Preview ═══
  console.log('\n── Tax Calculation Preview ──');

  await test('Intra-state: CGST + SGST split (18%)', async () => {
    const r = await api(token, '/taxes/calculate', {
      method: 'POST', body: JSON.stringify({
        taxable_amount: 10000,
        tax_master_id: 'tax_gst_18_intra',
        party_state: '29',
        company_state: '29'
      })
    });
    assert(r.success, 'Calculate tax should succeed');
    assert(r.data.cgstAmount === 900, 'CGST should be 900, got: ' + r.data.cgstAmount);
    assert(r.data.sgstAmount === 900, 'SGST should be 900, got: ' + r.data.sgstAmount);
    assert(r.data.igstAmount === 0, 'IGST should be 0');
    assert(r.data.totalTax === 1800, 'Total tax should be 1800, got: ' + r.data.totalTax);
    assert(r.data.grandTotal === 11800, 'Grand total should be 11800, got: ' + r.data.grandTotal);
    assert(r.data.isInterstate === false, 'Should be intra-state');
  });

  await test('Inter-state: IGST (18%)', async () => {
    const r = await api(token, '/taxes/calculate', {
      method: 'POST', body: JSON.stringify({
        taxable_amount: 10000,
        tax_master_id: 'tax_gst_18_inter',
        party_state: '01',
        company_state: '29'
      })
    });
    assert(r.success, 'Calculate tax should succeed');
    assert(r.data.igstAmount === 1800, 'IGST should be 1800, got: ' + r.data.igstAmount);
    assert(r.data.cgstAmount === 0, 'CGST should be 0');
    assert(r.data.sgstAmount === 0, 'SGST should be 0');
    assert(r.data.totalTax === 1800, 'Total tax should be 1800, got: ' + r.data.totalTax);
    assert(r.data.grandTotal === 11800, 'Grand total should be 11800, got: ' + r.data.grandTotal);
    assert(r.data.isInterstate === true, 'Should be inter-state');
  });

  await test('Decimal precision: 10000 at 5% intrastate', async () => {
    const r = await api(token, '/taxes/calculate', {
      method: 'POST', body: JSON.stringify({
        taxable_amount: 10000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29',
        company_state: '29'
      })
    });
    assert(r.success, 'Calculate tax should succeed');
    assert(r.data.cgstAmount === 250, 'CGST should be 250, got: ' + r.data.cgstAmount);
    assert(r.data.sgstAmount === 250, 'SGST should be 250, got: ' + r.data.sgstAmount);
    assert(r.data.totalTax === 500, 'Total tax should be 500, got: ' + r.data.totalTax);
    assert(r.data.grandTotal === 10500, 'Grand total should be 10500, got: ' + r.data.grandTotal);
  });

  await test('No tax master = zero tax', async () => {
    const r = await api(token, '/taxes/calculate', {
      method: 'POST', body: JSON.stringify({
        taxable_amount: 10000,
        party_state: '29',
        company_state: '29'
      })
    });
    assert(r.success, 'Calculate tax should succeed');
    assert(r.data.totalTax === 0, 'Total tax should be 0');
    assert(r.data.grandTotal === 10000, 'Grand total should equal taxable amount');
  });

  // ═══ Sales Invoice with Tax (Step 10) ═══
  console.log('\n── Sales Invoice with Tax ──');

  await test('Post Sales Invoice with intra-state CGST+SGST', async () => {
    const r = await api(token, '/sales', {
      method: 'POST', body: JSON.stringify({
        sales_date: '2026-09-08', payment_mode: 'CREDIT',
        sales_ledger_id: 'acc_sales', receiving_ledger_id: 'acc_bank',
        amount: 10000, currency: 'INR',
        tax_master_id: 'tax_gst_18_intra',
        party_state: '29', company_state: '29',
        contact_id: contactId, reference_number: 'INV-TAX-001',
        narration: 'Taxable sale', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Sale with tax should succeed: ' + (r.error?.message || JSON.stringify(r.data?.errors)));
    assert(r.data.taxDetails, 'Should return tax_details');
    assert(parseFloat(r.data.taxDetails.totalTax) === 1800, 'Tax should be 1800');
    assert(parseFloat(r.data.taxDetails.grandTotal) === 11800, 'Grand total should be 11800');
    salesVoucherId = r.data.id;
  });

  await test('Sales JE balanced with tax lines (Dr 11800, Cr 11800)', async () => {
    const je = dbGet("SELECT * FROM journal_entries WHERE voucher_id = ?", [salesVoucherId]);
    assert(je, 'JE should exist');
    assert(Math.abs(parseFloat(je.total_debit) - 11800) < 0.01, 'Debit should be 11800');
    assert(Math.abs(parseFloat(je.total_credit) - 11800) < 0.01, 'Credit should be 11800');

    const lines = dbQuery("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ?", [je.id]);
    assert(lines.length === 4, 'Should have 4 JE lines (receiving, sales, CGST, SGST)');

    const bankLine = lines.find(l => l.account_id === 'acc_bank');
    assert(parseFloat(bankLine.debit_amount) === 11800, 'Bank should be debited 11800');

    const salesLine = lines.find(l => l.account_id === 'acc_sales');
    assert(parseFloat(salesLine.credit_amount) === 10000, 'Sales should be credited 10000');

    const cgstLine = lines.find(l => l.account_id === 'acc_output_cgst');
    assert(parseFloat(cgstLine.credit_amount) === 900, 'Output CGST should be credited 900');

    const sgstLine = lines.find(l => l.account_id === 'acc_output_sgst');
    assert(parseFloat(sgstLine.credit_amount) === 900, 'Output SGST should be credited 900');
  });

  await test('Transaction tax details saved', async () => {
    const ttd = dbGet("SELECT * FROM transaction_tax_details WHERE voucher_id = ?", [salesVoucherId]);
    assert(ttd, 'Tax details should be saved');
    assert(ttd.tax_master_id === 'tax_gst_18_intra', 'Tax master should be recorded');
    assert(parseFloat(ttd.total_tax) === 1800, 'Total tax should be 1800');
    assert(ttd.is_interstate === 0, 'Should be intra-state');
  });

  // ═══ Purchase Invoice with Tax (Step 11) ═══
  console.log('\n── Purchase Invoice with Tax ──');

  await test('Post Purchase Invoice with intra-state Input CGST+SGST', async () => {
    const r = await api(token, '/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'CREDIT',
        purchase_ledger_id: 'acc_purchases',
        payable_ledger_id: 'acc_payable',
        amount: 10000, currency: 'INR',
        tax_master_id: 'tax_gst_18_intra',
        party_state: '29', company_state: '29',
        contact_id: contactId, reference_number: 'PUR-TAX-001',
        narration: 'Taxable purchase', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Purchase with tax should succeed: ' + (r.error?.message || JSON.stringify(r.data?.errors)));
    assert(r.data.taxDetails, 'Should return tax_details');
    assert(parseFloat(r.data.taxDetails.totalTax) === 1800, 'Tax should be 1800');
    assert(parseFloat(r.data.taxDetails.grandTotal) === 11800, 'Grand total should be 11800');
    purchaseVoucherId = r.data.id;
  });

  await test('Purchase JE balanced with input tax (Dr 11800, Cr 11800)', async () => {
    const je = dbGet("SELECT * FROM journal_entries WHERE voucher_id = ?", [purchaseVoucherId]);
    assert(je, 'JE should exist');
    assert(Math.abs(parseFloat(je.total_debit) - 11800) < 0.01, 'Debit should be 11800, got: ' + je.total_debit);
    assert(Math.abs(parseFloat(je.total_credit) - 11800) < 0.01, 'Credit should be 11800, got: ' + je.total_credit);

    const lines = dbQuery("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ?", [je.id]);
    assert(lines.length === 4, 'Should have 4 JE lines (purchase, payable, Input CGST, Input SGST)');

    const purchaseLine = lines.find(l => l.account_id === 'acc_purchases');
    assert(parseFloat(purchaseLine.debit_amount) === 10000, 'Purchase should be debited 10000');

    const payableLine = lines.find(l => l.account_id === 'acc_payable');
    assert(parseFloat(payableLine.credit_amount) === 11800, 'Payable should be credited 11800');

    const inputCgstLine = lines.find(l => l.account_id === 'acc_input_cgst');
    assert(parseFloat(inputCgstLine.debit_amount) === 900, 'Input CGST should be debited 900');

    const inputSgstLine = lines.find(l => l.account_id === 'acc_input_sgst');
    assert(parseFloat(inputSgstLine.debit_amount) === 900, 'Input SGST should be debited 900');
  });

  await test('Purchase transaction tax details saved', async () => {
    const ttd = dbGet("SELECT * FROM transaction_tax_details WHERE voucher_id = ?", [purchaseVoucherId]);
    assert(ttd, 'Tax details should be saved');
    assert(parseFloat(ttd.total_tax) === 1800, 'Total tax should be 1800');
    assert(ttd.is_interstate === 0, 'Should be intra-state');
  });

  await test('Purchase with IGST (inter-state)', async () => {
    const r = await api(token, '/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'CREDIT',
        purchase_ledger_id: 'acc_purchases',
        payable_ledger_id: 'acc_payable',
        amount: 5000, currency: 'INR',
        tax_master_id: 'tax_gst_18_inter',
        party_state: '01', company_state: '29',
        contact_id: contactId, reference_number: 'PUR-TAX-002',
        narration: 'Inter-state purchase', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Inter-state purchase should succeed: ' + (r.error?.message || JSON.stringify(r.data?.errors)));
    assert(r.data.taxDetails.igstAmount === 900, 'IGST should be 900');
    assert(r.data.taxDetails.isInterstate === true, 'Should be inter-state');
  });

  // ═══ Expense Voucher with Tax (Step 12) ═══
  console.log('\n── Expense Voucher with Tax ──');

  await test('Post Expense with Input CGST+SGST', async () => {
    const r = await api(token, '/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CASH',
        payee_id: contactId, payment_ledger_id: 'acc_cash',
        lines: [{ expense_ledger_id: 'acc_rent', amount: 5000, description: 'Office rent' }],
        currency: 'INR', tax_master_id: 'tax_gst_18_intra',
        party_state: '29', company_state: '29',
        reference_number: 'EXP-TAX-001'
      })
    });
    assert(r.success, 'Expense with tax should succeed: ' + (r.error?.message || JSON.stringify(r.data?.errors)));
    assert(r.data.taxDetails, 'Should return tax_details');
    assert(parseFloat(r.data.taxDetails.totalTax) === 900, 'Tax should be 900, got: ' + (r.data.taxDetails ? r.data.taxDetails.totalTax : 'null'));
  });

  await test('Expense JE balanced with input tax', async () => {
    const voucher = dbGet("SELECT id FROM vouchers WHERE reference_number = 'EXP-TAX-001'");
    assert(voucher, 'Expense voucher should exist');
    const je = dbGet("SELECT * FROM journal_entries WHERE voucher_id = ?", [voucher.id]);
    assert(je, 'JE should exist for taxed expense');
    assert(Math.abs(parseFloat(je.total_debit) - parseFloat(je.total_credit)) < 0.01, 'JE must be balanced');

    const lines = dbQuery("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ?", [je.id]);
    assert(lines.length === 4, 'Should have 4 JE lines (rent, cash, Input CGST, Input SGST)');
  });

  // ═══ Credit Note with Tax Reversal (Step 13) ═══
  console.log('\n── Credit Note with Tax Reversal ──');

  await test('Validate Credit Note with tax reversal preview', async () => {
    const r = await api(token, '/credit-notes/validate', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08',
        original_sales_invoice_id: salesVoucherId,
        contact_id: contactId,
        sales_return_ledger_id: 'acc_sales_returns',
        receivable_ledger_id: 'acc_bank',
        amount: 2000,
        tax_master_id: 'tax_gst_18_intra',
        party_state: '29', company_state: '29',
        reference_number: 'CN-TAX-001',
        financial_year_id: activeFyId,
        narration: 'Partial return with tax',
        lines: [{ description: 'Returned goods', line_total: 2000 }]
      })
    });
    assert(r.success, 'Credit note validation should succeed: ' + (r.error?.message || JSON.stringify(r.data?.errors)));
    assert(r.data.tax, 'Should return tax preview');
    assert(parseFloat(r.data.tax.totalTax) === 360, 'Tax should be 360 (2000 * 18%)');
  });

  await test('Post Credit Note reversing output tax', async () => {
    const r = await api(token, '/credit-notes', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08',
        original_sales_invoice_id: salesVoucherId,
        contact_id: contactId,
        sales_return_ledger_id: 'acc_sales_returns',
        receivable_ledger_id: 'acc_bank',
        amount: 2000,
        tax_master_id: 'tax_gst_18_intra',
        party_state: '29', company_state: '29',
        reference_number: 'CN-TAX-001',
        financial_year_id: activeFyId,
        narration: 'Partial return with tax',
        lines: [{ description: 'Returned goods', line_total: 2000 }]
      })
    });
    assert(r.success, 'Credit note with tax should succeed: ' + (r.error?.message || JSON.stringify(r.data?.errors)));
    assert(r.data.taxDetails, 'Should return tax_details');
    creditNoteId = r.data.id;
  });

  await test('Credit Note JE reverses output tax (Dr Sales Return + Dr Output Tax, Cr Receivable)', async () => {
    const je = dbGet("SELECT * FROM journal_entries WHERE voucher_id = ?", [creditNoteId]);
    assert(je, 'JE should exist');
    assert(Math.abs(parseFloat(je.total_debit) - parseFloat(je.total_credit)) < 0.01, 'JE must be balanced');

    const lines = dbQuery("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ?", [je.id]);
    const salesReturnLine = lines.find(l => l.account_id === 'acc_sales_returns');
    assert(salesReturnLine && parseFloat(salesReturnLine.debit_amount) === 2000, 'Sales return should be debited 2000');

    const cgstReversal = lines.find(l => l.account_id === 'acc_output_cgst');
    assert(cgstReversal && parseFloat(cgstReversal.debit_amount) === 180, 'Output CGST should be debited (reversed) 180');

    const sgstReversal = lines.find(l => l.account_id === 'acc_output_sgst');
    assert(sgstReversal && parseFloat(sgstReversal.debit_amount) === 180, 'Output SGST should be debited (reversed) 180');

    const bankLine = lines.find(l => l.account_id === 'acc_bank');
    assert(bankLine && parseFloat(bankLine.credit_amount) === 2360, 'Bank should be credited 2360 (grand total)');
  });

  await test('Credit Note tax details saved', async () => {
    const ttd = dbGet("SELECT * FROM transaction_tax_details WHERE voucher_id = ?", [creditNoteId]);
    assert(ttd, 'Tax details should be saved');
    assert(parseFloat(ttd.total_tax) === 360, 'Total tax should be 360');
  });

  // ═══ Debit Note with Tax Reversal (Step 14) ═══
  console.log('\n── Debit Note with Tax Reversal ──');

  await test('Post Debit Note reversing input tax', async () => {
    const r = await api(token, '/debit-notes', {
      method: 'POST', body: JSON.stringify({
        debit_note_date: '2026-09-08',
        original_purchase_invoice_id: purchaseVoucherId,
        supplier_id: contactId,
        purchase_return_ledger_id: 'acc_purchase_returns',
        payable_ledger_id: 'acc_payable',
        amount: 3000,
        tax_master_id: 'tax_gst_18_intra',
        party_state: '29', company_state: '29',
        reference_number: 'DN-TAX-001',
        narration: 'Partial return with tax',
        lines: [{ description: 'Returned goods', line_total: 3000 }]
      })
    });
    assert(r.success, 'Debit note with tax should succeed: ' + (r.error?.message || JSON.stringify(r.data?.errors)));
    assert(r.data.taxDetails, 'Should return tax_details');
    debitNoteId = r.data.id;
  });

  await test('Debit Note JE reverses input tax (Dr Payable, Cr Return + Cr Input Tax)', async () => {
    const je = dbGet("SELECT * FROM journal_entries WHERE voucher_id = ?", [debitNoteId]);
    assert(je, 'JE should exist');
    assert(Math.abs(parseFloat(je.total_debit) - parseFloat(je.total_credit)) < 0.01, 'JE must be balanced');

    const lines = dbQuery("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ?", [je.id]);
    const payableLine = lines.find(l => l.account_id === 'acc_payable');
    assert(parseFloat(payableLine.debit_amount) === 3540, 'Payable should be debited 3540 (grand total)');

    const returnsLine = lines.find(l => l.account_id === 'acc_purchase_returns');
    assert(parseFloat(returnsLine.credit_amount) === 3000, 'Purchase returns should be credited 3000');

    const inputCgstReversal = lines.find(l => l.account_id === 'acc_input_cgst');
    assert(inputCgstReversal && parseFloat(inputCgstReversal.credit_amount) === 270, 'Input CGST should be credited (reversed) 270');

    const inputSgstReversal = lines.find(l => l.account_id === 'acc_input_sgst');
    assert(inputSgstReversal && parseFloat(inputSgstReversal.credit_amount) === 270, 'Input SGST should be credited (reversed) 270');
  });

  await test('Debit Note tax details saved', async () => {
    const ttd = dbGet("SELECT * FROM transaction_tax_details WHERE voucher_id = ?", [debitNoteId]);
    assert(ttd, 'Tax details should be saved');
    assert(parseFloat(ttd.total_tax) === 540, 'Total tax should be 540');
  });

  // ═══ Tax Validation & Edge Cases ═══
  console.log('\n── Tax Validation & Edge Cases ──');

  await test('Reject invalid tax_master_id', async () => {
    const r = await api(token, '/sales', {
      method: 'POST', body: JSON.stringify({
        sales_date: '2026-09-08', payment_mode: 'CREDIT',
        sales_ledger_id: 'acc_sales', receiving_ledger_id: 'acc_bank',
        amount: 1000, currency: 'INR',
        tax_master_id: 'tax_nonexistent',
        contact_id: contactId, reference_number: 'INV-BAD-TAX',
        narration: 'Bad tax', financial_year_id: activeFyId
      })
    });
    assert(!r.success || (r.data && r.data.errors), 'Should reject invalid tax master');
    if (r.data && r.data.errors) {
      assert(r.data.errors.some(e => /tax master not found/i.test(e)), 'Error should mention tax master not found');
    }
  });

  await test('Sales without tax still works (backward compatibility)', async () => {
    const r = await api(token, '/sales', {
      method: 'POST', body: JSON.stringify({
        sales_date: '2026-09-08', payment_mode: 'CREDIT',
        sales_ledger_id: 'acc_sales', receiving_ledger_id: 'acc_cash',
        amount: 5000, currency: 'INR',
        contact_id: contactId, reference_number: 'INV-NOTAX-001',
        narration: 'No tax sale', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Sale without tax should succeed: ' + (r.error?.message || JSON.stringify(r.data?.errors)));
    assert(!r.data.taxDetails, 'Should not have tax details');
  });

  await test('Purchase without tax still works (backward compatibility)', async () => {
    const r = await api(token, '/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'CREDIT',
        purchase_ledger_id: 'acc_purchases', payable_ledger_id: 'acc_payable',
        amount: 5000, currency: 'INR',
        contact_id: contactId, reference_number: 'PUR-NOTAX-001',
        narration: 'No tax purchase', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Purchase without tax should succeed: ' + (r.error?.message || JSON.stringify(r.data?.errors)));
    assert(!r.data.taxDetails, 'Should not have tax details');
  });

  // ═══ Company Tax Config ═══
  console.log('\n── Company Tax Configuration ──');

  await test('Update company tax config', async () => {
    const r = await api(token, '/taxes/company-config', {
      method: 'PUT', body: JSON.stringify({
        gst_enabled: 1,
        gstin: '29AADCM9999E1ZU',
        state_name: 'KARNATAKA',
        state_code: '29',
        registration_type: 'REGULAR'
      })
    });
    assert(r.success, 'Update config should succeed');
  });

  // ═══ Summary ═══
  console.log('\n========================================');
  console.log(`  Step 17 Results: ${passed} passed, ${failed} failed`);
  if (errors.length > 0) {
    console.log('\n  Failures:');
    errors.forEach(e => console.log('    - ' + e.name + ': ' + e.error));
  }
  console.log('========================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
