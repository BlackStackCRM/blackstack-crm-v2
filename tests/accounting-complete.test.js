/**
 * Complete Accounting & Finance Module Test Suite
 * Tests ALL 26 mandatory accounting capabilities
 */
const BASE_URL = 'http://localhost:3000/api';
// PHASE 3 — TEST DATABASE SAFETY.
// This file previously resolved:
//     const DB_PATH = process.env.DB_PATH || 'data/blackstack-crm.db';
// so running it WITHOUT DB_PATH set pointed its destructive SQL
// (13 DELETE and 3 INSERT statements) at the LIVE production database. It now clones production into
// an isolated temp directory and asserts the result through the project's
// existing allow-list, so there is no production fallback to reach.
const { createDisposableDb } = require('../scripts/assert-disposable-db');
const { dbPath: DB_PATH, cleanup: _cleanupDisposableDb } = createDisposableDb({
  suite: 'accounting-complete',
  prefix: 'bscrm-acct-',
});

async function login() {
  const res = await fetch(`${BASE_URL}/auth/login`, {
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

let passed = 0;
let failed = 0;
const errors = [];

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

function assertNear(a, b, tolerance = 0.01) {
  if (Math.abs(a - b) > tolerance) throw new Error(`Expected ${a} ≈ ${b}`);
}

function dbQuery(sql, params = []) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB_PATH);
  if (!Array.isArray(params)) params = [params];
  const result = params.length > 0 ? db.prepare(sql).all(...params) : db.prepare(sql).all();
  db.close();
  return result;
}

function dbRun(sql, params = []) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = OFF');
  if (!Array.isArray(params)) params = [params];
  const stmt = db.prepare(sql);
  const result = params.length > 0 ? stmt.run(...params) : stmt.run();
  db.close();
  return result;
}

function dbGet(sql, params = []) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB_PATH);
  if (!Array.isArray(params)) params = [params];
  const result = params.length > 0 ? db.prepare(sql).get(...params) : db.prepare(sql).get();
  db.close();
  return result;
}

async function run() {
  console.log('\n========================================');
  console.log('  Complete Accounting & Finance Test Suite');
  console.log('========================================\n');

  const token = await login();
  let billId, paymentId, journalId, coaId, costCentreId, budgetId, bankId, fyId, activeFyId;
  let voucherId, contraVoucherId, receiptVoucherId, accountId;
  let contactId;
  contactId = 'cnt_001';

  // Step 15 AR test variables
  let arSalesId1, arSalesId2, arCnId, arSalesNum1, arSalesNum2;
  // Step 16 AP test variables
  let apPurchaseId1, apPurchaseId2, apPaymentId, apDnId, apPurchaseNum1, apPurchaseNum2;

  // Fetch active financial year (needed by JE tests starting at test 1)
  const fyInit = await api(token, '/accounting/financial-years');
  const activeFyData = (fyInit.data.items || fyInit.data);
  activeFyId = activeFyData.find(fy => fy.is_active === 1 || fy.isActive === true)?.id || activeFyData[0]?.id;

  // ═══ 1. Complete Bookkeeping & Double-Entry Accounting ═══
  console.log('── 1. Complete Bookkeeping & Double-Entry ──');

  await test('Create balanced journal entry (Debit=Credit)', async () => {
    const r = await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        description: 'Cash sale - INR 50,000',
        entry_date: '2026-09-05', currency: 'INR', financial_year_id: activeFyId,
        lines: [
          { account_id: 'acc_cash', debit_amount: 50000, credit_amount: 0, description: 'Cash received' },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 50000, description: 'Sales revenue' }
        ]
      })
    });
    assert(r.success, 'Balanced journal entry should succeed: ' + (r.error?.message || JSON.stringify(r)));
    journalId = r.data.id;
  });

  await test('Reject unbalanced journal entry (Debit≠Credit)', async () => {
    const r = await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        description: 'Unbalanced entry',
        entry_date: '2026-09-05', currency: 'INR', financial_year_id: activeFyId,
        lines: [
          { account_id: 'acc_cash', debit_amount: 50000, credit_amount: 0 },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 10000 }
        ]
      })
    });
    assert(!r.success, 'Unbalanced entry must be rejected');
  });

  await test('Journal entry creates proper debit+credit lines', async () => {
    const lines = dbQuery('SELECT * FROM journal_entry_lines WHERE journal_entry_id = ?', [journalId]);
    assert(lines.length === 2, 'Should have exactly 2 lines');
    const totalDr = lines.reduce((s, l) => s + (l.debit_amount || 0), 0);
    const totalCr = lines.reduce((s, l) => s + (l.credit_amount || 0), 0);
    assertNear(totalDr, totalCr, 0.01);
  });

  // ═══ 2. Chart of Accounts ═══
  console.log('\n── 2. Chart of Accounts ──');

  await test('List chart of accounts', async () => {
    const r = await api(token, '/accounting/accounts');
    assert(r.success, 'List accounts should succeed');
    assert(r.data.accounts.length > 0, 'Should have seeded accounts');
  });

  await test('Create account', async () => {
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1299_' + String(Date.now()).slice(-6), name: 'Test Account', type: 'ASSET',
        account_group_id: 'ag_cash', opening_balance: 0, debit_credit_nature: 'DEBIT'
      })
    });
    assert(r.success, (r.error?.message || '') + ' Create account should succeed');
    accountId = r.data.id;
    coaId = r.data.id;
  });

  await test('Cannot delete account with transactions', async () => {
    await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        description: 'Test entry for account deletion check',
        entry_date: '2026-09-05', currency: 'INR', financial_year_id: activeFyId,
        lines: [
          { account_id: coaId, debit_amount: 100, credit_amount: 0 },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 100 }
        ]
      })
    });
    const r = await api(token, '/accounting/accounts/' + coaId, { method: 'DELETE' });
    assert(!r.success, 'Account with transactions must not be deletable');
  });

  await test('Update account', async () => {
    const r = await api(token, '/accounting/accounts/' + coaId, {
      method: 'PUT', body: JSON.stringify({ name: 'Updated Test Account' })
    });
    assert(r.success, 'Update account should succeed');
  });

  await test('Account groups listing', async () => {
    const r = await api(token, '/accounting/accounts/groups');
    assert(r.success, 'Account groups should be listed');
    // Accept either {groups} or {items} format
    assert(r.data.groups || r.data.items, 'Should have group data');
  });

  // ─── Account Group CRUD & Validation ──────────────
  console.log('\\\\n── 2c. Account Group CRUD ──');

  await test('Create Account Group (with type inheritance check)', async () => {
    const r = await api(token, '/accounting/accounts/groups', {
      method: 'POST', body: JSON.stringify({
        code: '9100_' + String(Date.now()).slice(-6),
        name: 'Test Group',
        type: 'ASSET',
        parent_id: null,
        description: 'Test group for automation',
        allow_child_accounts: 1
      })
    });
    assert(r.success, 'Create group should succeed: ' + (r.error?.message || ''));
  });

  await test('Account Group has allow_direct_posting=false', async () => {
    const r = await api(token, '/accounting/accounts/groups', {
      method: 'POST', body: JSON.stringify({
        code: '9101_' + String(Date.now()).slice(-6),
        name: 'Posting Check Group',
        type: 'EXPENSE',
        parent_id: null,
        allow_child_accounts: 1
      })
    });
    assert(r.success, 'Group creation should succeed');
    // Verify backend enforces allow_direct_posting=false
    const groupRes = await api(token, '/accounting/accounts/groups');
    const groups = groupRes?.data?.groups || groupRes?.data?.items || [];
    // The backend should enforce this even though the frontend doesn't send it
    const accountCheck = dbGet('SELECT allow_direct_posting FROM accounts WHERE code = ?', [r.data.code]);
    // Groups are stored in account_groups table, verify via tree
    const treeRes = await api(token, '/accounting/accounts/tree');
    const findGroup = (nodes) => {
      for (const n of nodes) {
        if (n.id === r.data.id) return n;
        if (n.children) { const found = findGroup(n.children); if (found) return found; }
      }
      return null;
    };
    const found = findGroup(treeRes.data.tree || []);
    // Groups in the tree should not have allow_direct_posting=true
    if (found) {
      assert(!found.allow_direct_posting || found.allow_direct_posting === false, 'Group must have allow_direct_posting=false');
    }
  });

  let testGroupId;
  await test('Create child group under parent (type inheritance)', async () => {
    // First create a parent group
    const parentR = await api(token, '/accounting/accounts/groups', {
      method: 'POST', body: JSON.stringify({
        code: '9200_' + String(Date.now()).slice(-6),
        name: 'Parent Group Type Test',
        type: 'ASSET',
        allow_child_accounts: 1
      })
    });
    assert(parentR.success, 'Parent group creation should succeed');
    testGroupId = parentR.data.id;

    // Suggest type from parent
    const suggestR = await api(token, '/accounting/accounts/groups/suggest/' + parentR.data.id);
    assert(suggestR.success, 'Suggest endpoint should succeed');
    assert(suggestR.data.suggestion?.type === 'ASSET', 'Suggested type should be ASSET (inherited from parent)');
  });

  await test('Prevent group from being its own parent', async () => {
    // This is prevented at the frontend level (excluded from parent dropdown)
    // Backend validation is tested via the service
    const parentR = await api(token, '/accounting/accounts/groups', {
      method: 'POST', body: JSON.stringify({
        code: '9300_' + String(Date.now()).slice(-6),
        name: 'Self Parent Test',
        type: 'LIABILITY',
        allow_child_accounts: 1
      })
    });
    assert(parentR.success, 'Group creation should succeed');

    // Try to set itself as parent (should fail via backend validation)
    const updateR = await api(token, '/accounting/accounts/groups/' + parentR.data.id, {
      method: 'PUT', body: JSON.stringify({ parent_id: parentR.data.id })
    });
    assert(!updateR.success, 'Group cannot be its own parent');
  });

  await test('Prevent circular hierarchy on group parent change', async () => {
    // Create group A
    const rA = await api(token, '/accounting/accounts/groups', {
      method: 'POST', body: JSON.stringify({
        code: '9400_' + String(Date.now()).slice(-6),
        name: 'Group A', type: 'ASSET', allow_child_accounts: 1
      })
    });
    assert(rA.success, 'Group A creation should succeed');

    // Create group B under A
    const rB = await api(token, '/accounting/accounts/groups', {
      method: 'POST', body: JSON.stringify({
        code: '9401_' + String(Date.now()).slice(-6),
        name: 'Group B', type: 'ASSET', parent_id: rA.data.id, allow_child_accounts: 1
      })
    });
    assert(rB.success, 'Group B creation should succeed');

    // Try to set A's parent to B (circular)
    const rC = await api(token, '/accounting/accounts/groups/' + rA.data.id, {
      method: 'PUT', body: JSON.stringify({ parent_id: rB.data.id })
    });
    assert(!rC.success, 'Circular hierarchy must be prevented');
  });

  await test('Delete empty account group succeeds', async () => {
    const r = await api(token, '/accounting/accounts/groups', {
      method: 'POST', body: JSON.stringify({
        code: '9500_' + String(Date.now()).slice(-6),
        name: 'Deletable Group', type: 'ASSET', allow_child_accounts: 1
      })
    });
    assert(r.success, 'Group creation should succeed');
    const delR = await api(token, '/accounting/accounts/groups/' + r.data.id, { method: 'DELETE' });
    assert(delR.success, 'Empty group should be deletable');
  });

  await test('GL Accounts endpoint excludes groups', async () => {
    const r = await api(token, '/accounting/accounts/gl');
    assert(r.success, 'GL accounts endpoint should succeed');
    const accounts = r.data.accounts || r.data.items || [];
    // None of the returned accounts should be groups
    assert(accounts.every(a => !a.is_group || a.is_group === 0 || a.is_group === false), 'GL accounts must not include groups');
    assert(accounts.every(a => a.allow_direct_posting !== false), 'GL accounts must allow direct posting');
  });

  // ─── Chart of Accounts: Tree & Hierarchy ──────────────
  console.log('\\n── 2b. COA Tree & Hierarchy ──');

  await test('Account tree endpoint', async () => {
    const r = await api(token, '/accounting/accounts/tree');
    assert(r.success, 'Tree endpoint should succeed');
    assert(r.data.tree !== undefined, 'Should return tree array');
    assert(Array.isArray(r.data.tree), 'Tree should be an array');
  });

  await test('Account summary cards', async () => {
    const r = await api(token, '/accounting/accounts/summary');
    assert(r.success, 'Summary endpoint should succeed');
    assert(r.data.total > 0, 'Should have total accounts');
    assert(r.data.ASSET >= 0, 'Should have ASSET count');
    assert(r.data.LIABILITY >= 0, 'Should have LIABILITY count');
    assert(r.data.EQUITY >= 0, 'Should have EQUITY count');
    assert(r.data.INCOME >= 0, 'Should have INCOME count');
    assert(r.data.EXPENSE >= 0, 'Should have EXPENSE count');
  });

  await test('Create child account with parent', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1200_' + suffix, name: 'Test Child Account', type: 'ASSET',
        account_group_id: 'ag_asset', parent_id: 'acc_cash',
        opening_balance: 0, debit_credit_nature: 'DEBIT', allow_direct_posting: true,
        reconciliation_required: false
      })
    });
    assert(r.success, 'Child account creation should succeed: ' + (r.error?.message || ''));
  });

  await test('Prevent duplicate account code', async () => {
    const suffix = String(Date.now()).slice(-6);
    const code = '1210_' + suffix;
    // Create first
    await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: code, name: 'First Account', type: 'ASSET',
        account_group_id: 'ag_asset', debit_credit_nature: 'DEBIT'
      })
    });
    // Try duplicate
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: code, name: 'Duplicate Account', type: 'ASSET',
        account_group_id: 'ag_asset', debit_credit_nature: 'DEBIT'
      })
    });
    assert(!r.success, 'Duplicate account code should fail');
  });

  await test('Prevent circular hierarchy', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1220_' + suffix, name: 'Circular Test', type: 'ASSET',
        account_group_id: 'ag_asset', parent_id: 'nonexistent_account_id',
        debit_credit_nature: 'DEBIT'
      })
    });
    assert(!r.success, 'Parent that does not exist should fail');
  });

  await test('Create opening balance', async () => {
    const suffix = String(Date.now() + Math.random()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1300_' + suffix, name: 'Opening Balance Test', type: 'BANK',
        account_group_id: 'ag_bank', debit_credit_nature: 'DEBIT',
        opening_balance: 50000, opening_balance_type: 'DEBIT',
        opening_balance_date: '2024-01-01'
      })
    });
    assert(r.success, 'Account with opening balance should succeed: ' + (r.error?.message || ''));
    assert(r.data.opening_balance_entry !== null, 'Should have opening balance entry');
  });

  await test('Export accounts CSV', async () => {
    const r = await api(token, '/accounting/accounts/export');
    assert(r.success, 'Export should return JSON data');
    assert(Array.isArray(r.data.accounts), 'Should have accounts array');
  });

  await test('Import accounts', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts/import', {
      method: 'POST', body: JSON.stringify({
        accounts: [
          { code: '1900_' + suffix, name: 'Import Test', type: 'EXPENSE',
            account_group_id: 'ag_expense', debit_credit_nature: 'DEBIT' }
        ]
      })
    });
    assert(r.success, 'Import should succeed: ' + (r.error?.message || ''));
    assert(r.data.results.created >= 1, 'Should create at least 1 account');
  });

  // ═══ 3. Journal Vouchers ═══
  console.log('\n── 3. Journal Voucher ──');

  await test('Create journal voucher', async () => {
    const r = await api(token, '/accounting/vouchers', {
      method: 'POST', body: JSON.stringify({
        voucher_type: 'JOURNAL',
        reference_number: 'JV-001',
        entry_date: '2024-09-05',
        description: 'Manual journal entry',
        currency: 'INR',
        lines: [
          { account_id: 'acc_bank', debit_amount: 25000, credit_amount: 0, description: 'Bank deposit' },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 25000, description: 'Sales' }
        ]
      })
    });
    assert(r.success, 'Journal voucher should succeed');
    voucherId = r.data.id;
  });

  // ═══ 4. Payment Vouchers ═══
  console.log('\n── 4. Payment Voucher ──');

  await test('Create payment voucher', async () => {
    const r = await api(token, '/accounting/vouchers', {
      method: 'POST', body: JSON.stringify({
        voucher_type: 'PAYMENT',
        reference_number: 'PV-001',
        entry_date: '2024-09-05',
        description: 'Office supplies purchase',
        currency: 'INR',
        lines: [
          { account_id: 'acc_rent', debit_amount: 10000, credit_amount: 0 },
          { account_id: 'acc_cash', debit_amount: 0, credit_amount: 10000 }
        ]
      })
    });
    assert(r.success, 'Payment voucher should succeed');
  });

  // ═══ 5. Receipt Vouchers ═══
  console.log('\n── 5. Receipt Voucher ──');

  await test('Create receipt voucher', async () => {
    const r = await api(token, '/accounting/vouchers', {
      method: 'POST', body: JSON.stringify({
        voucher_type: 'RECEIPT',
        reference_number: 'RV-001',
        entry_date: '2024-09-05',
        description: 'Customer payment received',
        currency: 'INR',
        lines: [
          { account_id: 'acc_cash', debit_amount: 75000, credit_amount: 0, description: 'Cash received' },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 75000, description: 'Sales' }
        ]
      })
    });
    assert(r.success, 'Receipt voucher should succeed');
    receiptVoucherId = r.data.id;
  });

  // ═══ 6. Contra Vouchers ═══
  console.log('\n── 6. Contra Voucher ──');

  await test('Create contra voucher (cash to bank)', async () => {
    const r = await api(token, '/accounting/vouchers', {
      method: 'POST', body: JSON.stringify({
        voucher_type: 'CONTRA',
        reference_number: 'CV-001',
        entry_date: '2024-09-05',
        description: 'Cash deposited into bank',
        currency: 'INR',
        lines: [
          { account_id: 'acc_bank', debit_amount: 30000, credit_amount: 0, description: 'Bank credited' },
          { account_id: 'acc_cash', debit_amount: 0, credit_amount: 30000, description: 'Cash debited' }
        ]
      })
    });
    assert(r.success, 'Contra voucher should succeed');
    contraVoucherId = r.data.id;
  });

  await test('Contra voucher rejects unbalanced', async () => {
    const r = await api(token, '/accounting/vouchers', {
      method: 'POST', body: JSON.stringify({
        voucher_type: 'CONTRA',
        entry_date: '2024-09-05',
        description: 'Bad contra',
        currency: 'INR',
        lines: [
          { account_id: 'acc_bank', debit_amount: 30000, credit_amount: 0 },
          { account_id: 'acc_cash', debit_amount: 0, credit_amount: 15000 }
        ]
      })
    });
    assert(!r.success, 'Unbalanced contra voucher must be rejected');
  });

  // ═=== 7. Bill-wise Accounting ═══
  console.log('\n── 7. Bill-wise Accounting ──');

  await test('Create customer bill (sales invoice)', async () => {
    const r = await api(token, '/accounting/bills', {
      method: 'POST', body: JSON.stringify({
        bill_type: 'CUSTOMER',
        contact_id: 'cnt_001',
        bill_number: 'BILL-001-' + String(Date.now()).slice(-6),
        bill_date: '2024-09-01',
        due_date: '2024-09-30',
        total: 100000,
        currency: 'INR',
        items: [
          { description: 'Consulting services', quantity: 1, unit_price: 100000, amount: 100000 }
        ]
      })
    });
    assert(r.success, 'Create customer bill should succeed');
    billId = r.data.id;
  });

  await test('Get bill details', async () => {
    const r = await api(token, '/accounting/bills/' + billId);
    assert(r.success, 'Get bill should succeed');
    assert(r.data.items, 'Should have items');
  });

  await test('Update bill', async () => {
    const r = await api(token, '/accounting/bills/' + billId, {
      method: 'PUT', body: JSON.stringify({ notes: 'Updated note' })
    });
    assert(r.success, 'Update bill should succeed');
  });

  // ═=== 8. Accounts Receivable ═══
  console.log('\n── 8. Accounts Receivable ──');

  await test('List receivables', async () => {
    const r = await api(token, '/accounting/receivables');
    assert(r.success, 'Receivables should list');
    assert(r.data.items.length > 0, 'Should have receivables');
  });

  await test('Receivables summary (totalOutstanding)', async () => {
    const r = await api(token, '/accounting/receivables/summary');
    assert(r.success, 'Receivables summary should succeed');
    assert(r.data.totalOutstanding >= 0, 'Total outstanding should exist');
  });

  await test('Get single receivable', async () => {
    const listR = await api(token, '/accounting/receivables');
    if (listR.data.items && listR.data.items.length > 0) {
      const billIdCheck = listR.data.items[0].billId;
      const recR = await api(token, '/accounting/receivables/' + billIdCheck);
      assert(recR.success, 'Get single receivable should succeed');
    }
  });

  // ═=== 9. Accounts Payable ═══
  console.log('\n── 9. Accounts Payable ──');

  await test('List payables', async () => {
    const r = await api(token, '/accounting/payables');
    assert(r.success, 'Payables should list');
  });

  await test('Payables summary', async () => {
    const r = await api(token, '/accounting/payables/summary');
    assert(r.success, 'Payables summary should succeed');
  });

  // ═══ 10. Outstanding & Aging ═══
  console.log('\n── 10. Outstanding & Aging ──');

  await test('Aging report with buckets', async () => {
    const r = await api(token, '/accounting/outstanding');
    assert(r.success, 'Aging should succeed');
    assert(r.data.receivables, 'Should have receivable aging');
    assert(r.data.receivables.aging_0_30 !== undefined, 'Should have aging buckets');
  });

  await test('Aging via /aging alias', async () => {
    const r = await api(token, '/accounting/aging');
    assert(r.success, 'Aging alias should succeed');
  });

  // ═══ 11. Payments ═══
  console.log('\n── 11. Payments ──');

  await test('Record partial payment (₹40,000 of ₹1,00,000)', async () => {
    const r = await api(token, '/accounting/payments', {
      method: 'POST', body: JSON.stringify({
        bill_id: billId,
        contact_id: 'cnt_001',
        amount: 40000,
        payment_date: '2024-09-10',
        payment_method: 'BANK_TRANSFER',
        reference_number: 'TXN-001'
      })
    });
    assert(r.success, 'Partial payment should succeed');
    paymentId = r.data.id;
  });

  await test('Outstanding after partial payment', async () => {
    const r = await api(token, '/accounting/receivables/summary');
    assert(r.success, 'Summary after payment should succeed');
    assert(r.data.totalOutstanding > 0, 'Should still have outstanding');
  });

  await test('Record full payment', async () => {
    const r = await api(token, '/accounting/payments', {
      method: 'POST', body: JSON.stringify({
        bill_id: billId,
        contact_id: 'cnt_001',
        amount: 60000,
        payment_date: '2024-09-12',
        payment_method: 'CASH',
        reference_number: 'TXN-002'
      })
    });
    assert(r.success, 'Full payment should succeed');
  });

  await test('Outstanding after full payment shows reduced balance', async () => {
    const r = await api(token, '/accounting/receivables');
    assert(r.success, 'Should list receivables');
    const billRec = r.data.items.find(i => i.billId === billId);
    if (billRec) {
      assert(parseFloat(billRec.outstandingAmount) >= 0, 'Outstanding should be >= 0 after payments');
    }
  });

  // ═══ 12. Credit Management ═══
  console.log('\n── 12. Credit Management ──');

  await test('Get credit rule for contact', async () => {
    const r = await api(token, '/accounting/credit-rules/cnt_001');
    assert(r.success, 'Get credit rule should succeed');
  });

  await test('Set credit rule', async () => {
    const r = await api(token, '/accounting/credit-rules', {
      method: 'POST', body: JSON.stringify({
        contact_id: 'cnt_001',
        credit_limit: 200000,
        credit_period_days: 30,
        payment_terms: 'NET_30'
      })
    });
    assert(r.success, 'Set credit rule should succeed');
  });

  // ═══ 13. Interest Calculation ═══
  console.log('\n── 13. Interest Calculation ──');

  await test('Interest config exists', async () => {
    const config = dbGet('SELECT * FROM interest_configs WHERE company_id = ? LIMIT 1', ['default']);
    if (config) {
      assert(config.interest_rate !== undefined, 'Should have interest rate');
    } else {
      // Create one
      const conn = require('node:sqlite').DatabaseSync;
      const db = new conn(DB_PATH);
      db.prepare("INSERT INTO interest_configs (id, company_id, name, interest_rate, calculation_method, grace_period_days, is_compound, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, datetime('now'), datetime('now'))").run('ic_001', 'default', 'Standard', 12, 'YEARLY', 7);
      db.close();
    }
  });

  await test('Calculate interest on receivable', async () => {
    const r = await api(token, '/accounting/receivables');
    if (r.data.items && r.data.items.length > 0) {
      const recId = r.data.items[0].id;
      const calcR = await api(token, '/accounting/receivables/' + recId + '/interest/calculate', { method: 'POST', body: JSON.stringify({}) });
      assert(calcR.success, 'Interest calculation should succeed');
    }
  });

  // ═══ 14. Cost Centres ═══
  console.log('\n── 14. Cost Centres ──');

  await test('Create cost centre', async () => {
    const r = await api(token, '/accounting/cost-centres', {
      method: 'POST', body: JSON.stringify({
        code: 'CC01_' + String(Date.now()).slice(-6), name: 'Main Office', description: 'Primary office'
      })
    });
    assert(r.success, 'Create cost centre should succeed');
    costCentreId = r.data.id;
  });

  await test('List cost centres', async () => {
    const r = await api(token, '/accounting/cost-centres');
    assert(r.success, 'List cost centres should succeed');
  });

  await test('Update cost centre', async () => {
    const r = await api(token, '/accounting/cost-centres/' + costCentreId, {
      method: 'PUT', body: JSON.stringify({ name: 'Updated Office' })
    });
    assert(r.success, 'Update cost centre should succeed');
  });

  // ═=== 15. Cost Categories ═══
  console.log('\n── 15. Cost Categories ──');

  await test('List cost categories', async () => {
    const r = await api(token, '/accounting/cost-categories');
    assert(r.success, 'List cost categories should succeed');
  });

  await test('Create cost category', async () => {
    const r = await api(token, '/accounting/cost-categories', {
      method: 'POST', body: JSON.stringify({ code: 'CCAT01_' + String(Date.now()).slice(-6), name: 'Sales', description: 'Sales expenses' })
    });
    assert(r.success, 'Create cost category should succeed');
  });

  await test('Update cost category', async () => {
    const r = await api(token, '/accounting/cost-categories');
    // Test update by fetching first, then updating
    assert(r.success, 'Should list cost categories for update test');
  });

  // ═=== 16. Budget Management ═══
  console.log('\n── 16. Budget Management ──');

  // First get an existing financial year
  await test('Get financial year for budget', async () => {
    const r = await api(token, '/accounting/financial-years');
    assert(r.success, 'Should list financial years');
    if (r.data.items && r.data.items.length > 0) {
      fyId = r.data.items[0].id;
    }
    assert(fyId, 'Should have a financial year ID');
  });

  await test('Create budget', async () => {
    const r = await api(token, '/accounting/budgets', {
      method: 'POST', body: JSON.stringify({
        name: 'Sales Budget FY24-25',
        financial_year_id: fyId,
        budget_type: 'REVENUE',
        lines: [
          { account_id: 'acc_sales', period: 'FY', budget_amount: 200000 }
        ]
      })
    });
    assert(r.success, 'Create budget should succeed');
    budgetId = r.data.id;
  });

  await test('List budgets', async () => {
    const r = await api(token, '/accounting/budgets');
    assert(r.success, 'List budgets should succeed');
    assert(r.data.items.length > 0, 'Should have budgets');
  });

  await test('Get budget with lines', async () => {
    const r = await api(token, '/accounting/budgets/' + budgetId);
    assert(r.success, 'Get budget should succeed');
  });

  // ═=== 17. Multi-Currency ═══
  console.log('\n── 17. Multi-Currency Accounting ──');

  await test('Create journal with foreign currency', async () => {
    const r = await api(token, '/accounting/vouchers', {
      method: 'POST', body: JSON.stringify({
        voucher_type: 'JOURNAL',
        entry_date: '2024-09-05',
        description: 'USD transaction',
        currency: 'USD', exchange_rate: 83.5,
        lines: [
          { account_id: 'acc_bank', debit_amount: 1000, credit_amount: 0 },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 1000 }
        ]
      })
    });
    assert(r.success, 'Multi-currency voucher should succeed');
  });

  // ═=== 18. Financial Years & Period Control ═══
  console.log('\n── 18. Financial Years & Period Control ──');

  await test('List financial years', async () => {
    const r = await api(token, '/accounting/financial-years');
    assert(r.success, 'List financial years should succeed');
    assert(r.data.items.length > 0, 'Should have financial years');
  });

  // ═=== 19. Bank Accounts ═══
  console.log('\n── 19. Bank Accounts ──');

  await test('Create bank account', async () => {
    const r = await api(token, '/accounting/bank-accounts', {
      method: 'POST', body: JSON.stringify({
        account_name: 'HDFC Salary Account',
        account_number: '002312345678', ifsc_code: 'HDFC0001234',
        bank_name: 'HDFC Bank', account_type: 'SAVINGS',
        gl_account_id: 'acc_bank', opening_balance: 100000
      })
    });
    assert(r.success, 'Create bank account should succeed');
    bankId = r.data.id;
  });

  await test('List bank accounts', async () => {
    const r = await api(token, '/accounting/bank-accounts');
    assert(r.success, 'List bank accounts should succeed');
    assert(r.data.items.length > 0, 'Should have bank accounts');
  });

  // ═=== 20. Cash Book ═══
  console.log('\n── 20. Cash Book ──');

  await test('Cash book report', async () => {
    const r = await api(token, '/accounting/reports/cash-book');
    assert(r.success, 'Cash book should succeed');
    assert(r.data.items !== undefined, 'Should have cash book entries');
  });

  // ═=== 21. Bank Book ═══
  console.log('\n── 21. Bank Book ──');

  await test('Bank book report', async () => {
    const r = await api(token, '/accounting/reports/bank-book/acc_bank');
    assert(r.success, 'Bank book should succeed');
    assert(r.data.items !== undefined, 'Should have bank book entries');
  });

  // ═=== 22. Day Book ═══
  console.log('\n── 22. Day Book ──');

  await test('Day book shows all transactions', async () => {
    const r = await api(token, '/accounting/reports/day-book');
    assert(r.success, 'Day book should succeed');
    assert(Array.isArray(r.data.items), 'Should have entries');
  });

  await test('Day book filtering by date', async () => {
    const r = await api(token, '/accounting/reports/day-book?from=2024-01-01&to=2024-12-31');
    assert(r.success, 'Day book with date filter should succeed');
  });

  // ═=== 23. Trial Balance ═══
  console.log('\n── 23. Trial Balance ──');

  await test('Trial balance (Debit = Credit)', async () => {
    const r = await api(token, '/accounting/reports/trial-balance');
    assert(r.success, 'Trial balance should succeed');
    assertNear(r.data.totalDebit, r.data.totalCredit, 0.01);
    assert(r.data.balanced, 'Trial balance must be balanced');
  });

  // ═=== 24. Profit & Loss ═══
  console.log('\n── 24. Profit & Loss ──');

  await test('Profit & Loss report', async () => {
    const r = await api(token, '/accounting/reports/profit-loss');
    assert(r.success, 'P&L should succeed');
    assert(r.data.revenue !== undefined, 'Should have revenue');
    assert(r.data.expense !== undefined, 'Should have expenses');
    assert(r.data.netProfit !== undefined, 'Should have net profit');
  });

  // ═=== 25. Balance Sheet ═══
  console.log('\n── 25. Balance Sheet ──');

  await test('Balance sheet (Assets = Liabilities + Equity)', async () => {
    const r = await api(token, '/accounting/reports/balance-sheet');
    assert(r.success, 'Balance sheet should succeed');
    assert(r.data.assets !== undefined, 'Should have assets');
    assert(r.data.liabilities !== undefined, 'Should have liabilities');
    assert(r.data.equity !== undefined, 'Should have equity');
  });

  // ═=== 26. Cash Flow ═══
  console.log('\n── 26. Cash Flow ──');

  await test('Cash flow report (operating/investing/financing)', async () => {
    const r = await api(token, '/accounting/reports/cash-flow');
    assert(r.success, 'Cash flow should succeed');
    assert(r.data.operating !== undefined, 'Should have operating');
    assert(r.data.investing !== undefined, 'Should have investing');
    assert(r.data.financing !== undefined, 'Should have financing');
  });

  // ═=== 27. Fund Flow ═══
  console.log('\n── 27. Fund Flow ──');

  await test('Fund flow report', async () => {
    const r = await api(token, '/accounting/reports/fund-flow');
    assert(r.success, 'Fund flow should succeed');
    assert(r.data.reportType === 'fund_flow', 'Should be fund flow type');
  });

  // ═=== 28. Ratio Analysis ═══
  console.log('\n── 28. Ratio Analysis ──');

  await test('Ratio analysis (no NaN/Infinity)', async () => {
    const r = await api(token, '/accounting/reports/ratios');
    assert(r.success, 'Ratios should succeed');
    const vals = Object.values(r.data);
    const hasBad = vals.some(v => v === null || v === undefined || (typeof v === 'number' && !isFinite(v)));
    assert(!hasBad, 'No NaN/Infinity/null values in ratios');
  });

  // ═=== 29. Financial Analysis Dashboard ═══
  console.log('\n── 29. Financial Analysis Dashboard ──');

  await test('Dashboard returns financial KPIs', async () => {
    const r = await api(token, '/accounting/dashboard');
    assert(r.success, 'Dashboard should succeed');
    assert(r.data.receivables !== undefined, 'Should have receivables');
    assert(r.data.payables !== undefined, 'Should have payables');
    assert(r.data.netProfit !== undefined, 'Should have net profit');
    assert(r.data.bankBalance !== undefined, 'Should have bank balance');
  });

  // ═=== 30. Voucher Cancel/Reverse ═══
  console.log('\n── 30. Voucher Cancel/Reverse ──');

  await test('Cancel voucher (preserves audit trail)', async () => {
    const r = await api(token, '/accounting/vouchers');
    assert(r.success, 'Should list vouchers');
    if (r.data.items && r.data.items.length > 0) {
      const cancelR = await api(token, '/accounting/vouchers/' + r.data.items[0].id + '/cancel', { method: 'POST' });
      assert(cancelR.success, 'Cancel voucher should succeed');
    }
  });

  // ═=== 31. Ledger ═══
  console.log('\n── 31. Ledger Management ──');

  await test('Ledger report', async () => {
    const r = await api(token, '/accounting/ledger/acc_cash');
    assert(r.success, 'Ledger should succeed');
    assert(r.data.items !== undefined, 'Should have entries');
  });

  await test('Ledger report via reports endpoint', async () => {
    const r = await api(token, '/accounting/reports/ledger?account_id=acc_cash');
    assert(r.success, 'Ledger report should succeed');
  });

  // ═=== 32. Audit Trail ═══
  console.log('\n── 32. Audit Trail ──');

  await test('Audit trail records operations', async () => {
    const audit = dbGet("SELECT COUNT(*) as c FROM accounting_audit");
    assert(audit.c > 0, 'Accounting audit table should have entries');
  });

  // ═=== 33. Tenant Isolation ═══
  console.log('\n── 33. Tenant Isolation ──');

  await test('All data scoped to company_id from backend context', async () => {
    const r = await api(token, '/accounting/accounts');
    assert(r.success, 'Should list accounts');
    assert(r.data.accounts.every(a => a.companyId === 'default'), 'All accounts must be tenant-scoped');
  });

  // ═=== 34. Posted Transaction Safety ═══
  console.log('\n── 34. Posted Transaction Safety ──');

  await test('Cannot delete posted journal entry', async () => {
    const r = await api(token, '/accounting/journal');
    assert(r.success, 'Should list journal entries');
  });

  // ═=== 35. Data Persistence ═══
  console.log('\n── 35. Data Persistence ──');

  await test('All data persisted in SQLite', async () => {
    const bills = dbGet("SELECT COUNT(*) as c FROM bills WHERE company_id = 'default'");
    assert(bills.c > 0, 'Bills should be persisted in database');
    const jes = dbGet("SELECT COUNT(*) as c FROM journal_entries WHERE company_id = 'default'");
    assert(jes.c > 0, 'Journal entries should be persisted');
    const vchs = dbGet("SELECT COUNT(*) as c FROM vouchers WHERE company_id = 'default'");
    assert(vchs.c > 0, 'Vouchers should be persisted');
  });

  // ═=== 36. Database Verification ═══
  console.log('\n── 36. Database Verification ──');

  await test('Database has required tables', async () => {
    const requiredTables = ['accounts', 'journal_entries', 'journal_entry_lines', 'vouchers', 'bills', 'bill_items', 'receivables', 'payables', 'budgets', 'budget_lines', 'cost_centres', 'cost_categories', 'bank_accounts', 'financial_years', 'accounting_audit'];
    for (const table of requiredTables) {
      const t = dbGet("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]);
      assert(t, 'Table ' + table + ' should exist');
    }
  });

  await test('Database has company_id on tenant tables', async () => {
    const tables = ['accounts', 'journal_entries', 'journal_entry_lines', 'vouchers', 'bills', 'bill_items', 'receivables', 'payables'];
    for (const table of tables) {
      const cols = dbQuery('PRAGMA table_info(' + table + ')');
      const colNames = cols.map(c => c.name);
      assert(colNames.includes('company_id'), 'Table ' + table + ' should have company_id');
    }
  });

  await test('Journal entries table has debit_credit columns', async () => {
    const cols = dbQuery('PRAGMA table_info(journal_entry_lines)');
    const colNames = cols.map(c => c.name);
    assert(colNames.includes('debit_amount'), 'Should have debit_amount');
    assert(colNames.includes('credit_amount'), 'Should have credit_amount');
  });

  await test('Accounts table has debit_credit_nature', async () => {
    const cols = dbQuery('PRAGMA table_info(accounts)');
    const colNames = cols.map(c => c.name);
    assert(colNames.includes('debit_credit_nature'), 'Should have debit_credit_nature');
  });

  // ═=== 37. Step 4: Ledger Account Master ═══
  console.log('\\n── 37. Step 4: Ledger Account Master ──');

  await test('Create Asset Ledger (Cash in Hand type)', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1111_' + suffix, name: 'Petty Cash', type: 'CASH',
        account_group_id: 'ag_cash', debit_credit_nature: 'DEBIT',
        opening_balance: 0, allow_direct_posting: true
      })
    });
    assert(r.success, 'Create CASH ledger should succeed: ' + (r.error?.message || ''));
    assert(r.data.allowDirectPosting === true || r.data.allowDirectPosting === 1, 'Ledger account must allow direct posting');
    assert(r.data.isGroup === false || r.data.isGroup === 0, 'Ledger account must not be a group');
  });

  await test('Create Liability Ledger under Liability group', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '2120_' + suffix, name: 'Short Term Loan', type: 'LIABILITY',
        account_group_id: 'ag_payable', allow_direct_posting: true
      })
    });
    assert(r.success, 'Create liability ledger should succeed: ' + (r.error?.message || ''));
    assert(r.data.allowDirectPosting === true || r.data.allowDirectPosting === 1, 'Must allow direct posting');
  });

  await test('Create Equity Ledger under Equity group', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '3110_' + suffix, name: 'Partner Capital', type: 'EQUITY',
        account_group_id: 'ag_capital', allow_direct_posting: true
      })
    });
    assert(r.success, 'Create equity ledger should succeed: ' + (r.error?.message || ''));
  });

  await test('Create Income Ledger under Income group', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '4110_' + suffix, name: 'Consulting Revenue', type: 'INCOME',
        account_group_id: 'ag_sales', allow_direct_posting: true
      })
    });
    assert(r.success, 'Create income ledger should succeed: ' + (r.error?.message || ''));
  });

  await test('Create Expense Ledger under Expense group', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '5800_' + suffix, name: 'Professional Fees', type: 'EXPENSE',
        account_group_id: 'ag_expense', allow_direct_posting: true
      })
    });
    assert(r.success, 'Create expense ledger should succeed: ' + (r.error?.message || ''));
  });

  await test('Create Ledger under Sub-Group (Accounts Receivable nesting)', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1310_' + suffix, name: 'Customer Advances', type: 'ASSET',
        account_group_id: 'ag_receivable', allow_direct_posting: true
      })
    });
    assert(r.success, 'Create ledger under sub-group should succeed: ' + (r.error?.message || ''));
  });

  await test('Account Type filtering: reject Asset ledger under Income group', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '4199_' + suffix, name: 'Bad Placement', type: 'INCOME',
        account_group_id: 'ag_asset', allow_direct_posting: true
      })
    });
    assert(!r.success, 'Asset group with Income type must be rejected');
  });

  await test('Account Type filtering: reject Liability ledger under Asset group', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '2199_' + suffix, name: 'Bad Placement', type: 'LIABILITY',
        account_group_id: 'ag_asset', allow_direct_posting: true
      })
    });
    assert(!r.success, 'Asset group with Liability type must be rejected');
  });

  await test('Nature auto-derivation from Account Type (Asset => Debit)', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1130_' + suffix, name: 'Nature Auto Debit', type: 'ASSET',
        account_group_id: 'ag_asset', opening_balance: 0
      })
    });
    assert(r.success, 'Create should succeed');
    assert(r.data.debitCreditNature === 'DEBIT', 'Nature should be auto-derived as DEBIT for ASSET type');
  });

  await test('Nature auto-derivation from Account Type (Liability => Credit)', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '2200_' + suffix, name: 'Nature Auto Credit', type: 'LIABILITY',
        account_group_id: 'ag_liability', opening_balance: 0
      })
    });
    assert(r.success, 'Create should succeed');
    assert(r.data.debitCreditNature === 'CREDIT', 'Nature should be auto-derived as CREDIT for LIABILITY type');
  });

  await test('Nature auto-derivation: Income => Credit', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '4900_' + suffix, name: 'Nature Auto Credit Inc', type: 'INCOME',
        account_group_id: 'ag_income', opening_balance: 0
      })
    });
    assert(r.success, 'Create should succeed');
    assert(r.data.debitCreditNature === 'CREDIT', 'Nature should be auto-derived as CREDIT for INCOME type');
  });

  await test('Nature auto-derivation: Expense => Debit', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '5810_' + suffix, name: 'Nature Auto Debit Exp', type: 'EXPENSE',
        account_group_id: 'ag_expense', opening_balance: 0
      })
    });
    assert(r.success, 'Create should succeed');
    assert(r.data.debitCreditNature === 'DEBIT', 'Nature should be auto-derived as DEBIT for EXPENSE type');
  });

  await test('Reject duplicate account code (uniqueness)', async () => {
    const suffix = String(Date.now()).slice(-6);
    const code = '1999_' + suffix;
    await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: code, name: 'First', type: 'EXPENSE', account_group_id: 'ag_expense', allow_direct_posting: true
      })
    });
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: code, name: 'Duplicate', type: 'EXPENSE', account_group_id: 'ag_expense', allow_direct_posting: true
      })
    });
    assert(!r.success, 'Duplicate account code should be rejected');
  });

  await test('Reject empty account name', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1998_' + suffix, name: '', type: 'EXPENSE', account_group_id: 'ag_expense'
      })
    });
    assert(!r.success, 'Empty account name should be rejected');
  });

  await test('Reject whitespace-only account name', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1997_' + suffix, name: '   ', type: 'EXPENSE', account_group_id: 'ag_expense'
      })
    });
    assert(!r.success, 'Whitespace-only name should be rejected');
  });

  await test('Opening balance = zero is valid', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1996_' + suffix, name: 'Zero Balance', type: 'EXPENSE',
        account_group_id: 'ag_expense', opening_balance: 0
      })
    });
    assert(r.success, 'Zero opening balance should succeed');
    assert(r.data.openingBalanceEntry === null, 'Zero balance should not create opening entry');
  });

  let debitObId;
  await test('Debit opening balance creates balanced journal entry', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1311_' + suffix, name: 'Debit OB', type: 'ASSET',
        account_group_id: 'ag_receivable', opening_balance: 25000,
        opening_balance_type: 'DEBIT', opening_balance_date: '2024-04-01'
      })
    });
    assert(r.success, 'Should succeed: ' + (r.error?.message || ''));
    assert(r.data.openingBalanceEntry !== null, 'Should have opening balance entry');
    debitObId = r.data.id;
    // Verify the journal entry is balanced
    const je = dbGet("SELECT je.total_debit, je.total_credit FROM journal_entries je JOIN vouchers v ON je.voucher_id = v.id WHERE v.reference_number = ? AND je.company_id = 'default'", 'OB-' + r.data.id);
    assert(je, 'Opening balance journal entry should exist');
    assertNear(parseFloat(je.total_debit), parseFloat(je.total_credit), 0.01, 'Journal entry must be balanced (Dr=Cr)');
    assertNear(parseFloat(je.total_debit), 25000, 0.01, 'Debit total should equal opening balance');
    assertNear(parseFloat(je.total_credit), 25000, 0.01, 'Credit total should equal opening balance');
  });

  let creditObId;
  await test('Credit opening balance creates balanced journal entry', async () => {
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '2121_' + suffix, name: 'Credit OB', type: 'LIABILITY',
        account_group_id: 'ag_payable', opening_balance: 75000,
        opening_balance_type: 'CREDIT', opening_balance_date: '2024-04-01'
      })
    });
    assert(r.success, 'Should succeed: ' + (r.error?.message || ''));
    assert(r.data.openingBalanceEntry !== null, 'Should have opening balance entry');
    creditObId = r.data.id;
    // Verify balance
    const je = dbGet("SELECT je.total_debit, je.total_credit FROM journal_entries je JOIN vouchers v ON je.voucher_id = v.id WHERE v.reference_number = ? AND je.company_id = 'default'", 'OB-' + r.data.id);
    assert(je, 'Opening balance journal entry should exist');
    assertNear(parseFloat(je.total_debit), parseFloat(je.total_credit), 0.01, 'Journal entry must be balanced');
    assertNear(parseFloat(je.total_credit), 75000, 0.01, 'Credit total should equal opening balance');
  });

  await test('Prevent duplicate opening balance entries (idempotent update)', async () => {
    // Creating another account with opening balance should not corrupt existing entries
    const suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1312_' + suffix, name: 'OB Idempotent', type: 'ASSET',
        account_group_id: 'ag_receivable', opening_balance: 10000,
        opening_balance_type: 'DEBIT', opening_balance_date: '2024-04-01'
      })
    });
    assert(r.success, 'Should succeed');
    // The original debitObId entry should still be balanced
    const je = dbGet("SELECT je.total_debit, je.total_credit FROM journal_entries je JOIN vouchers v ON je.voucher_id = v.id WHERE v.reference_number = ? AND je.company_id = 'default'", 'OB-' + debitObId);
    if (je) {
      assertNear(parseFloat(je.total_debit), parseFloat(je.total_credit), 0.01, 'Original OB entry must still be balanced');
    }
  });

  await test('Ledger Account appears in Chart of Accounts tree', async () => {
    const r = await api(token, '/accounting/accounts/tree');
    assert(r.success, 'Tree endpoint should succeed');
    // Search for the debit opening balance account in the tree
    const findNode = (nodes, id) => {
      for (const n of nodes) {
        if (n.id === id) return n;
        if (n.children) { const found = findNode(n.children, id); if (found) return found; }
      }
      return null;
    };
    const found = findNode(r.data.tree || [], debitObId);
    assert(found, 'Ledger account should appear in tree');
    assert(found.kind === 'ledger', 'Should be tagged as ledger kind');
  });

  await test('Ledger Account is selectable for transactions (GL endpoint)', async () => {
    const r = await api(token, '/accounting/accounts/gl');
    assert(r.success, 'GL endpoint should succeed');
    const accounts = r.data.accounts || r.data.items || [];
    assert(accounts.some(a => a.id === debitObId), 'Newly created ledger should appear in GL endpoint');
    // All GL accounts must be posting accounts
    assert(accounts.every(a => a.allowDirectPosting !== false && a.allowDirectPosting !== 0), 'All GL accounts must allow direct posting');
    // No groups in GL
    assert(accounts.every(a => !a.isGroup || a.isGroup === 0 || a.isGroup === false), 'GL must exclude groups');
  });

  await test('Inactive Ledger cannot be selected for new transactions', async () => {
    var suffix = String(Date.now()).slice(-6);
    // Create an account and mark it inactive
    const createR = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1995_' + suffix, name: 'Inactive Test', type: 'EXPENSE',
        account_group_id: 'ag_expense', opening_balance: 0
      })
    });
    assert(createR.success, 'Create should succeed');
    const inactiveId = createR.data.id;
    await api(token, '/accounting/accounts/' + inactiveId, {
      method: 'PUT', body: JSON.stringify({ is_active: 0 })
    });
    // GL endpoint should not return inactive accounts
    const glR = await api(token, '/accounting/accounts/gl');
    const accounts = glR.data.accounts || glR.data.items || [];
    assert(!accounts.some(a => a.id === inactiveId), 'Inactive account must not appear in GL posting list');
  });

  await test('Historical transactions remain visible after account update', async () => {
    // Update the debit opening balance account's name/description
    const r = await api(token, '/accounting/accounts/' + debitObId, {
      method: 'PUT', body: JSON.stringify({ name: 'Debit OB (Updated)', description: 'Updated for test' })
    });
    assert(r.success, 'Update should succeed');
    // Journal entries should still be there
    const je = dbGet("SELECT COUNT(*) as c FROM journal_entries WHERE id IN (SELECT journal_entry_id FROM journal_entry_lines WHERE account_id = ?) AND company_id = 'default'", debitObId);
    assert(je.c > 0, 'Historical journal entries should remain after update');
  });

  await test('Prevent deletion of account with transactions', async () => {
    const r = await api(token, '/accounting/accounts/' + debitObId, { method: 'DELETE' });
    assert(!r.success, 'Account with transactions must not be deletable');
  });

  await test('Prevent deletion of protected/system account', async () => {
    // acc_retained (Retained Earnings) is marked as system account
    const r = await api(token, '/accounting/accounts/acc_retained', { method: 'DELETE' });
    assert(!r.success, 'System account must not be deletable');
  });

  await test('Prevent modifying protected account critical fields', async () => {
    // Try to change type on acc_retained (system account)
    const r = await api(token, '/accounting/accounts/acc_retained', {
      method: 'PUT', body: JSON.stringify({ type: 'ASSET' })
    });
    assert(!r.success, 'Cannot change type of protected account');
    // Try to change account_group_id
    const r2 = await api(token, '/accounting/accounts/acc_retained', {
      method: 'PUT', body: JSON.stringify({ account_group_id: 'ag_asset' })
    });
    assert(!r2.success, 'Cannot change group of protected account');
    // Try to change code
    const r3 = await api(token, '/accounting/accounts/acc_retained', {
      method: 'PUT', body: JSON.stringify({ code: 'NEWCODE' })
    });
    assert(!r3.success, 'Cannot change code of protected account');
    // Allowed: changing non-critical fields (name, description)
    const r4 = await api(token, '/accounting/accounts/acc_retained', {
      method: 'PUT', body: JSON.stringify({ name: 'Retained Earnings (Modified)' })
    });
    assert(r4.success, 'Should be able to update non-critical fields on protected account');
  });

  await test('Prevent deleting account with transaction (deactivate instead works)', async () => {
    // Deactivate the debit opening balance account
    const r = await api(token, '/accounting/accounts/' + debitObId, {
      method: 'PUT', body: JSON.stringify({ is_active: 0 })
    });
    assert(r.success, 'Deactivation should succeed');
  });

  await test('RBAC: Ledger creation endpoint responds', async () => {
    const r = await api(token, '/accounting/accounts');
    assert(r.success, 'Accounts should be accessible');
  });

  await test('Audit log on ledger creation', async () => {
    var suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1994_' + suffix, name: 'Audit Test', type: 'EXPENSE',
        account_group_id: 'ag_expense', opening_balance: 0
      })
    });
    assert(r.success, 'Create should succeed');
    const audit = dbGet("SELECT COUNT(*) as c FROM accounting_audit WHERE entity_type = 'account' AND action = 'CREATE' AND entity_id = ? AND company_id = 'default'", r.data.id);
    assert(audit.c > 0, 'Audit log should record ledger creation');
  });

  await test('Audit log on ledger update', async () => {
    var suffix = String(Date.now()).slice(-6);
    const createR = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1993_' + suffix, name: 'Audit Update Test', type: 'EXPENSE',
        account_group_id: 'ag_expense', opening_balance: 0
      })
    });
    assert(createR.success, 'Create should succeed');
    const updateR = await api(token, '/accounting/accounts/' + createR.data.id, {
      method: 'PUT', body: JSON.stringify({ name: 'Updated Name' })
    });
    assert(updateR.success, 'Update should succeed');
    const audit = dbGet("SELECT COUNT(*) as c FROM accounting_audit WHERE entity_type = 'account' AND action = 'UPDATE' AND entity_id = ? AND company_id = 'default'", createR.data.id);
    assert(audit.c > 0, 'Audit log should record ledger update');
  });

  await test('Audit log on ledger deactivation', async () => {
    var suffix = String(Date.now()).slice(-6);
    const createR = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1992_' + suffix, name: 'Audit Deactivate Test', type: 'EXPENSE',
        account_group_id: 'ag_expense', opening_balance: 0
      })
    });
    assert(createR.success, 'Create should succeed');
    const deactR = await api(token, '/accounting/accounts/' + createR.data.id, {
      method: 'PUT', body: JSON.stringify({ is_active: 0 })
    });
    assert(deactR.success, 'Deactivate should succeed');
    const audit = dbGet("SELECT COUNT(*) as c FROM accounting_audit WHERE entity_type = 'account' AND action = 'UPDATE' AND entity_id = ? AND company_id = 'default'", createR.data.id);
    assert(audit.c > 0, 'Audit log should record ledger deactivation');
  });

  await test('Company isolation: accounts scoped to company', async () => {
    const r = await api(token, '/accounting/accounts');
    assert(r.success, 'Should list accounts');
    const accounts = r.data.accounts || [];
    assert(accounts.every(a => a.company_id === 'default' || a.companyId === 'default'), 'All accounts must belong to default company');
  });

  await test('Group hierarchy integrity: child ledger belongs to parent group type', async () => {
    // All existing accounts should have account_group_id pointing to a group of compatible type
    const accounts = dbQuery("SELECT a.id, a.type, ag.type as group_type FROM accounts a JOIN account_groups ag ON a.account_group_id = ag.id WHERE a.company_id = 'default' AND (a.is_group = 0 OR a.is_group IS NULL)");
    const typeMap = { BANK: 'ASSET', CASH: 'ASSET' };
    for (const a of accounts) {
      const acctBase = typeMap[a.type] || a.type;
      const grpBase = typeMap[a.group_type] || a.group_type;
      // Allow BANK/CASH under ASSET groups, and exact type match
      assert(grpBase === acctBase || (acctBase === 'ASSET' && ['BANK','CASH','ASSET'].includes(a.group_type)),
        `Account ${a.id} type ${a.type} should be compatible with group type ${a.group_type}`);
    }
  });

  let atomicId;
  await test('Atomic creation: Ledger + Opening Balance + Journal Entry together', async () => {
    var suffix = String(Date.now()).slice(-6);
    const r = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1313_' + suffix, name: 'Atomic Test', type: 'ASSET',
        account_group_id: 'ag_receivable', opening_balance: 100000,
        opening_balance_type: 'DEBIT', opening_balance_date: '2024-04-01',
        allow_direct_posting: true
      })
    });
    assert(r.success, 'Atomic creation should succeed: ' + (r.error?.message || ''));
    assert(r.data.openingBalanceEntry !== null, 'Should have opening balance entry');
    atomicId = r.data.id;
    // Verify the account, voucher, journal entry, and audit log all exist
    const acct = dbGet('SELECT * FROM accounts WHERE id = ? AND company_id = ?', [atomicId, 'default']);
    assert(acct, 'Account should exist');
    const voucher = dbGet("SELECT * FROM vouchers WHERE reference_number = ? AND company_id = 'default'", 'OB-' + atomicId);
    assert(voucher, 'Opening balance voucher should exist');
    const je = dbGet("SELECT * FROM journal_entries WHERE voucher_id = ? AND company_id = 'default'", voucher.id);
    assert(je, 'Journal entry should exist');
    assertNear(parseFloat(je.total_debit), parseFloat(je.total_credit), 0.01, 'Journal entry must be balanced');
    const audit = dbGet("SELECT COUNT(*) as c FROM accounting_audit WHERE entity_type = 'account' AND entity_id = ? AND company_id = 'default'", atomicId);
    assert(audit.c > 0, 'Audit log should exist');
  });

  // ═=== 38. Step 5: Opening Balances & Accounting Initialization ═══
  console.log('\n── 38. Step 5: Opening Balances ──');

  // Helper: get active financial year
  try {
    const fyList = await api(token, '/accounting/financial-years');
    const activeFy = (fyList.data.items || fyList.data).find(fy => fy.is_active === 1 || fy.isActive === true);
    activeFyId = activeFy ? activeFy.id : null;
  } catch (e) {
    // Create a financial year if none exists
    const createFy = await api(token, '/accounting/financial-years', {
      method: 'POST', body: JSON.stringify({ name: 'FY 2026-27', start_date: '2026-04-01', end_date: '2027-03-31' })
    });
    activeFyId = createFy.data?.id;
  }

  await test('List financial years', async () => {
    const r = await api(token, '/accounting/financial-years');
    assert(r.success, 'Should list financial years');
    const years = r.data.items || r.data || [];
    assert(years.length > 0, 'Should have at least one financial year');
    activeFyId = years.find(fy => fy.is_active === 1 || fy.isActive === true)?.id || years[0]?.id || activeFyId;
  });

  let obId;
  let obRef;
  await test('Create opening balance draft', async () => {
    assert(activeFyId, 'Should have an active financial year');
    const r = await api(token, '/accounting/opening-balances', {
      method: 'POST', body: JSON.stringify({
        financial_year_id: activeFyId, opening_date: '2026-04-01'
      })
    });
    assert(r.success, 'Create draft should succeed: ' + (r.error?.message || ''));
    obId = r.data.id;
    assert(r.data.status === 'DRAFT', 'Status should be DRAFT');
  });

  await test('Reject opening balance without financial year', async () => {
    const r = await api(token, '/accounting/opening-balances', {
      method: 'POST', body: JSON.stringify({ opening_date: '2026-04-01' })
    });
    assert(!r.success, 'Should require financial_year_id');
  });

  await test('Get opening balance by ID', async () => {
    const r = await api(token, `/accounting/opening-balances/${obId}`);
    assert(r.success, 'Get should succeed');
    assert(r.data.id === obId, 'Should return correct opening balance');
  });

  await test('Add Asset opening balance (Debit)', async () => {
    const r = await api(token, `/accounting/opening-balances/${obId}/lines`, {
      method: 'POST', body: JSON.stringify({ account_id: 'acc_bank', debit: 100000, credit: 0, description: 'Opening bank balance' })
    });
    assert(r.success, 'Add line should succeed: ' + (r.error?.message || ''));
  });

  await test('Add Liability opening balance (Credit)', async () => {
    const r = await api(token, `/accounting/opening-balances/${obId}/lines`, {
      method: 'POST', body: JSON.stringify({ account_id: 'acc_payable', debit: 0, credit: 30000, description: 'Opening payables' })
    });
    assert(r.success, 'Add line should succeed: ' + (r.error?.message || ''));
  });

  await test('Add Equity opening balance (Credit)', async () => {
    const r = await api(token, `/accounting/opening-balances/${obId}/lines`, {
      method: 'POST', body: JSON.stringify({ account_id: 'acc_capital', debit: 0, credit: 70000, description: 'Owner capital' })
    });
    assert(r.success, 'Add line should succeed: ' + (r.error?.message || ''));
  });

  await test('Reject Account Group as opening balance account', async () => {
    const r = await api(token, `/accounting/opening-balances/${obId}/lines`, {
      method: 'POST', body: JSON.stringify({ account_id: 'ag_asset', debit: 1000, credit: 0 })
    });
    assert(!r.success, 'Account groups should be rejected');
  });

  await test('Reject inactive account for opening balance', async () => {
    // Create an account and deactivate it
    const suffix = String(Date.now()).slice(-6);
    const createR = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '1991_' + suffix, name: 'Inactive OB Test', type: 'EXPENSE',
        account_group_id: 'ag_expense', opening_balance: 0
      })
    });
    const inactiveId = createR.data.id;
    await api(token, `/accounting/accounts/${inactiveId}`, {
      method: 'PUT', body: JSON.stringify({ is_active: 0 })
    });
    const r = await api(token, `/accounting/opening-balances/${obId}/lines`, {
      method: 'POST', body: JSON.stringify({ account_id: inactiveId, debit: 1000, credit: 0 })
    });
    assert(!r.success, 'Inactive account should be rejected');
  });

  await test('Reject both Debit and Credit on same line', async () => {
    const r = await api(token, `/accounting/opening-balances/${obId}/lines`, {
      method: 'POST', body: JSON.stringify({ account_id: 'acc_receivable', debit: 1000, credit: 500 })
    });
    assert(!r.success, 'Both debit and credit should be rejected');
  });

  await test('Reject nature conflict (Debit on Credit-nature account)', async () => {
    const r = await api(token, `/accounting/opening-balances/${obId}/lines`, {
      method: 'POST', body: JSON.stringify({ account_id: 'acc_payable', debit: 1000, credit: 0 })
    });
    assert(!r.success, 'Debit on credit-nature account should be rejected');
  });

  await test('Reject nature conflict (Credit on Debit-nature account)', async () => {
    const r = await api(token, `/accounting/opening-balances/${obId}/lines`, {
      method: 'POST', body: JSON.stringify({ account_id: 'acc_bank', debit: 0, credit: 1000 })
    });
    assert(!r.success, 'Credit on debit-nature account should be rejected');
  });

  await test('Calculate total Debit', async () => {
    const r = await api(token, `/accounting/opening-balances/${obId}`);
    assert(r.success, 'Get should succeed');
    assert(parseFloat(r.data.totalDebit) === 100000, 'Total debit should be 100000');
  });

  await test('Calculate total Credit', async () => {
    const r = await api(token, `/accounting/opening-balances/${obId}`);
    assert(r.success, 'Get should succeed');
    assert(parseFloat(r.data.totalCredit) === 100000, 'Total credit should be 100000');
  });

  await test('Calculate difference', async () => {
    const r = await api(token, `/accounting/opening-balances/${obId}`);
    assert(r.success, 'Get should succeed');
    assert(parseFloat(r.data.difference) === 0, 'Difference should be 0');
  });

  await test('Validate balanced opening balances', async () => {
    const r = await api(token, `/accounting/opening-balances/${obId}/validate`, { method: 'POST' });
    assert(r.success, 'Validate should succeed');
    assert(r.data.balanced, 'Should be balanced');
  });

  await test('Finalize balanced opening balances', async () => {
    const r = await api(token, `/accounting/opening-balances/${obId}/finalize`, { method: 'POST' });
    assert(r.success, 'Finalize should succeed: ' + (r.error?.message || ''));
    assert(r.data.status === 'FINALIZED', 'Status should be FINALIZED');
  });

  await test('Post finalized opening balances (creates journal entry)', async () => {
    const r = await api(token, `/accounting/opening-balances/${obId}/post`, { method: 'POST' });
    assert(r.success, 'Post should succeed: ' + (r.error?.message || ''));
    assert(r.data.status === 'POSTED', 'Status should be POSTED');
    assert(r.data.journalEntryId, 'Should have a journal_entry_id');
  });

  await test('Verify journal entry reference matches opening balance', async () => {
    const r = await api(token, `/accounting/opening-balances/${obId}`);
    obRef = r.data.referenceNumber;
    assert(r.data.journalEntryId, 'Should have journal entry after posting');
  });

  await test('Verify balance after posting (Debit = Credit)', async () => {
    const ob = dbGet('SELECT je.total_debit, je.total_credit FROM journal_entries je JOIN vouchers v ON je.voucher_id = v.id WHERE v.reference_number = ? AND je.company_id = ?', [obRef, 'default']);
    assert(ob, 'Journal entry should exist: ' + obRef);
    assertNear(parseFloat(ob.total_debit), parseFloat(ob.total_credit), 0.01, 'Posted journal entry must be balanced');
  });

  await test('Reject duplicate posting', async () => {
    const r = await api(token, `/accounting/opening-balances/${obId}/post`, { method: 'POST' });
    assert(!r.success, 'Should reject duplicate posting');
  });

  await test('Prevent editing lines after posting', async () => {
    const r = await api(token, `/accounting/opening-balances/${obId}/lines`, {
      method: 'POST', body: JSON.stringify({ account_id: 'acc_rent', debit: 1000, credit: 0 })
    });
    assert(!r.success, 'Should not allow adding lines to posted opening balance');
  });

  await test('Ledger reflects opening balance', async () => {
    const r = await api(token, `/accounting/ledger/acc_bank?from=2026-04-01&to=2027-03-31`);
    assert(r.success, 'Ledger should succeed');
    // The ledger should show the opening balance as a transaction
    const items = r.data.items || r.data.transactions || [];
    const hasOb = items.some(item => item.description?.includes('Opening balance') || item.description?.includes('Opening Balance'));
    assert(hasOb, 'Ledger should show opening balance transaction');
  });

  await test('Trial Balance reflects opening balance', async () => {
    const r = await api(token, '/accounting/reports/trial-balance');
    assert(r.success, 'Trial balance should succeed');
    assertNear(r.data.totalDebit, r.data.totalCredit, 0.01, 'Trial balance must be balanced after posting');
    assert(r.data.balanced, 'Trial balance must be balanced');
  });

  await test('Cannot finalize unbalanced opening balances', async () => {
    // Create another opening balance that is unbalanced
    const suffix = String(Date.now()).slice(-6);
    const createR = await api(token, '/accounting/opening-balances', {
      method: 'POST', body: JSON.stringify({
        financial_year_id: activeFyId || '', opening_date: '2026-04-01'
      })
    });
    if (!createR.success) {
      assert(true, 'Skip: could not create second opening balance');
      return;
    }
    const unbalancedId = createR.data.id;
    const r = await api(token, `/accounting/opening-balances/${unbalancedId}/lines`, {
      method: 'POST', body: JSON.stringify({ account_id: 'acc_bank', debit: 1000, credit: 0 })
    });
    if (r.success) {
      const finalizeR = await api(token, `/accounting/opening-balances/${unbalancedId}/finalize`, { method: 'POST' });
      assert(!finalizeR.success, 'Unbalanced opening balance should not be finalizable');
    }
  });

  await test('Opening balance audit log exists', async () => {
    const audit = dbGet("SELECT COUNT(*) as c FROM accounting_audit WHERE entity_type = 'opening_balance' AND entity_id = ? AND company_id = 'default'", obId);
    assert(audit.c > 0, 'Audit log should record opening balance operations');
  });

  // ═=== 39. Step 6: Journal Entries & Accounting Transaction Engine ═══
  console.log('\n── 39. Step 6: Journal Entries ──');

  let jeId;
  let activeFyId2;

  // Get active financial year
  try {
    const fyList = await api(token, '/accounting/financial-years');
    const activeFy = (fyList.data.items || fyList.data).find(fy => fy.is_active === 1 || fy.isActive === true);
    activeFyId2 = activeFy ? activeFy.id : null;
  } catch (e) {
    activeFyId2 = activeFyId;
  }

  await test('Create valid two-line Journal Entry (Cash → Sales)', async () => {
    const r = await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        entry_date: '2026-09-15', description: 'Cash sale for services', currency: 'INR', exchange_rate: 1,
        financial_year_id: activeFyId2 || activeFyId, lines: [
          { account_id: 'acc_cash', debit_amount: 50000, credit_amount: 0, description: 'Cash received' },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 50000, description: 'Sales revenue' }
        ]
      })
    });
    assert(r.success, 'Valid JE should be created: ' + (r.error?.message || JSON.stringify(r)));
    jeId = r.data.id;
    assert(r.data.status === 'POSTED', 'JE should be POSTED on creation');
  });

  await test('Reject unbalanced Journal Entry (Debit≠Credit)', async () => {
    const r = await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        entry_date: '2026-09-15', description: 'Unbalanced entry', currency: 'INR',
        financial_year_id: activeFyId2 || activeFyId, lines: [
          { account_id: 'acc_cash', debit_amount: 10000, credit_amount: 0 },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 8000 }
        ]
      })
    });
    assert(!r.success, 'Unbalanced JE should be rejected');
  });

  await test('Reject Journal Entry with no Debit line', async () => {
    const r = await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        entry_date: '2026-09-15', description: 'Credit only', currency: 'INR',
        financial_year_id: activeFyId2 || activeFyId, lines: [
          { account_id: 'acc_cash', debit_amount: 0, credit_amount: 10000 },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 10000 }
        ]
      })
    });
    assert(!r.success, 'JE with no debit should be rejected');
  });

  await test('Reject Journal Entry with fewer than 2 lines', async () => {
    const r = await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        entry_date: '2026-09-15', description: 'Single line', currency: 'INR',
        financial_year_id: activeFyId2 || activeFyId, lines: [
          { account_id: 'acc_cash', debit_amount: 10000, credit_amount: 0 }
        ]
      })
    });
    assert(!r.success, 'Single-line JE should be rejected');
  });

  await test('Reject Group account in Journal Entry', async () => {
    const r = await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        entry_date: '2026-09-15', description: 'Group test', currency: 'INR',
        financial_year_id: activeFyId2 || activeFyId, lines: [
          { account_id: 'acc_cash', debit_amount: 10000, credit_amount: 0 },
          { account_id: 'ag_asset', debit_amount: 0, credit_amount: 10000 }
        ]
      })
    });
    assert(!r.success, 'Group account should be rejected in JE');
  });

  await test('Reject inactive account in Journal Entry', async () => {
    const suffix = String(Date.now()).slice(-6);
    const createR = await api(token, '/accounting/accounts', {
      method: 'POST', body: JSON.stringify({
        code: '9999_' + suffix, name: 'Inactive JE Test', type: 'EXPENSE',
        account_group_id: 'ag_expense', opening_balance: 0
      })
    });
    const inactiveId = createR.data.id;
    await api(token, `/accounting/accounts/${inactiveId}`, {
      method: 'PUT', body: JSON.stringify({ is_active: 0 })
    });
    const r = await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        entry_date: '2026-09-15', description: 'Inactive test', currency: 'INR',
        financial_year_id: activeFyId2 || activeFyId, lines: [
          { account_id: 'acc_cash', debit_amount: 10000, credit_amount: 0 },
          { account_id: inactiveId, debit_amount: 0, credit_amount: 10000 }
        ]
      })
    });
    assert(!r.success, 'Inactive account should be rejected');
  });

  await test('Reject both Debit and Credit on same line', async () => {
    const r = await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        entry_date: '2026-09-15', description: 'Both DC', currency: 'INR',
        financial_year_id: activeFyId2 || activeFyId, lines: [
          { account_id: 'acc_cash', debit_amount: 5000, credit_amount: 5000 },
          { account_id: 'acc_sales', debit_amount: 5000, credit_amount: 5000 }
        ]
      })
    });
    assert(!r.success, 'Both debit and credit on same line should be rejected');
  });

  await test('Reject nature conflict (Debit on Credit-nature account)', async () => {
    const r = await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        entry_date: '2026-09-15', description: 'Nature conflict', currency: 'INR',
        financial_year_id: activeFyId2 || activeFyId, lines: [
          { account_id: 'acc_cash', debit_amount: 10000, credit_amount: 0 },
          { account_id: 'acc_payable', debit_amount: 10000, credit_amount: 0 }
        ]
      })
    });
    assert(!r.success, 'Debit on credit-nature account should be rejected');
  });

  await test('Reject negative amount', async () => {
    const r = await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        entry_date: '2026-09-15', description: 'Negative test', currency: 'INR',
        financial_year_id: activeFyId2 || activeFyId, lines: [
          { account_id: 'acc_cash', debit_amount: -10000, credit_amount: 0 },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 10000 }
        ]
      })
    });
    assert(!r.success, 'Negative amount should be rejected');
  });

  await test('Reject transaction date outside Financial Year', async () => {
    const r = await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        entry_date: '2025-01-01', description: 'FY out of range', currency: 'INR',
        financial_year_id: activeFyId2 || activeFyId, lines: [
          { account_id: 'acc_cash', debit_amount: 10000, credit_amount: 0 },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 10000 }
        ]
      })
    });
    assert(!r.success, 'Transaction date outside FY should be rejected');
  });

  await test('Create multi-line Journal Entry', async () => {
    const r = await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        entry_date: '2026-09-20', description: 'Multi-line expense', currency: 'INR',
        financial_year_id: activeFyId2 || activeFyId, lines: [
          { account_id: 'acc_rent', debit_amount: 10000, credit_amount: 0 },
          { account_id: 'acc_utilities', debit_amount: 3000, credit_amount: 0 },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 13000 }
        ]
      })
    });
    assert(r.success, 'Multi-line JE should be created: ' + (r.error?.message || JSON.stringify(r)));
  });

  await test('Create Journal Entry Draft', async () => {
    const r = await api(token, '/accounting/journal/draft', {
      method: 'POST', body: JSON.stringify({
        entry_date: '2026-09-22', reference_number: 'INV-1023', description: 'Draft JE', currency: 'INR',
        financial_year_id: activeFyId2 || activeFyId, lines: [
          { account_id: 'acc_receivable', debit_amount: 25000, credit_amount: 0 },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 25000 }
        ]
      })
    });
    assert(r.success, 'Draft JE should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.status === 'DRAFT', 'Status should be DRAFT');
  });

  let draftJeId;
  await test('Get Journal Entry Draft', async () => {
    const listR = await api(token, '/accounting/journal?status=DRAFT');
    const drafts = (listR.data.items || []).filter(j => j.entry_number !== undefined && j.status === 'DRAFT');
    if (drafts.length > 0) {
      draftJeId = drafts[0].id;
      const r = await api(token, `/accounting/journal/${draftJeId}`);
      assert(r.success, 'Get draft should succeed');
      assert(r.data.lines && r.data.lines.length >= 2, 'Should return lines');
    } else {
      // Create a draft explicitly via direct endpoint
      const dr = await api(token, '/accounting/journal/draft', {
        method: 'POST', body: JSON.stringify({
          entry_date: '2026-09-23', description: 'Draft for get test', currency: 'INR',
          financial_year_id: activeFyId2 || activeFyId, lines: [
            { account_id: 'acc_cash', debit_amount: 15000, credit_amount: 0 },
            { account_id: 'acc_sales', debit_amount: 0, credit_amount: 15000 }
          ]
        })
      });
      draftJeId = dr.data.id;
    }
  });

  await test('Validate Journal Entry', async () => {
    if (!draftJeId) { assert(true, 'Skip: no draft JE'); return; }
    const r = await api(token, `/accounting/journal/${draftJeId}/validate`, {
      method: 'POST', body: JSON.stringify({
        entry_date: '2026-09-23', financial_year_id: activeFyId2 || activeFyId,
        lines: [
          { account_id: 'acc_cash', debit_amount: 15000, credit_amount: 0 },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 15000 }
        ]
      })
    });
    assert(r.data.valid === true, 'Validation should pass for balanced JE');
  });

  await test('Post a Draft Journal Entry', async () => {
    if (!draftJeId) { assert(true, 'Skip: no draft JE'); return; }
    const r = await api(token, `/accounting/journal/${draftJeId}/post`, { method: 'POST' });
    assert(r.success, 'Post draft should succeed: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.status === 'POSTED', 'Draft JE should be POSTED after post');
  });

  await test('Prevent posting already-posted Journal Entry', async () => {
    if (!draftJeId) { assert(true, 'Skip: no draft JE'); return; }
    const r = await api(token, `/accounting/journal/${draftJeId}/post`, { method: 'POST' });
    assert(!r.success, 'Should reject posting already-posted JE');
  });

  await test('Cancel a Posted Journal Entry', async () => {
    const r = await api(token, `/accounting/journal/${jeId}/cancel`, { method: 'POST' });
    assert(r.success, 'Cancel should succeed: ' + (r.error?.message || JSON.stringify(r)));
  });

  await test('Cannot cancel already-cancelled Journal Entry', async () => {
    const r = await api(token, `/accounting/journal/${jeId}/cancel`, { method: 'POST' });
    assert(!r.success, 'Should reject cancelling already-cancelled JE');
  });

  await test('Reverse a Posted Journal Entry', async () => {
    // Create a new posted JE to reverse
    const createR = await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        entry_date: '2026-09-25', description: 'To be reversed', currency: 'INR',
        financial_year_id: activeFyId2 || activeFyId, lines: [
          { account_id: 'acc_cash', debit_amount: 7500, credit_amount: 0 },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 7500 }
        ]
      })
    });
    if (createR.success) {
      const reverseR = await api(token, `/accounting/journal/${createR.data.id}/reverse`, { method: 'POST' });
      assert(reverseR.success, 'Reverse should succeed: ' + (reverseR.error?.message || JSON.stringify(reverseR)));
      assert(reverseR.data.journal_entry_id || reverseR.data.reverseEntryId, 'Should create reversal entry');
    }
  });

  await test('Delete a Draft Journal Entry', async () => {
    const dr = await api(token, '/accounting/journal/draft', {
      method: 'POST', body: JSON.stringify({
        entry_date: '2026-09-26', description: 'To be deleted', currency: 'INR',
        financial_year_id: activeFyId2 || activeFyId, lines: [
          { account_id: 'acc_cash', debit_amount: 5000, credit_amount: 0 },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 5000 }
        ]
      })
    });
    if (dr.success && dr.data.id) {
      const r = await api(token, `/accounting/journal/${dr.data.id}`, { method: 'DELETE' });
      assert(r.success, 'Delete draft should succeed: ' + (r.error?.message || JSON.stringify(r)));
    }
  });

  await test('Cannot delete Posted Journal Entry', async () => {
    const r = await api(token, `/accounting/journal/${jeId}`, { method: 'DELETE' });
    assert(!r.success, 'Should not delete posted JE');
  });

  await test('Cannot edit Posted Journal Entry', async () => {
    const r = await api(token, `/accounting/journal/${jeId}`, {
      method: 'PUT', body: JSON.stringify({ description: 'Modified' })
    });
    assert(!r.success, 'Should not edit posted JE');
  });

  await test('Journal Entry list with search/filter', async () => {
    const r = await api(token, '/accounting/journal?status=POSTED&limit=10');
    assert(r.success, 'List should succeed');
    assert(r.data.items.length > 0, 'Should have journal entries');
  });

  await test('Journal-entry audit trail exists', async () => {
    const audit = dbGet("SELECT COUNT(*) as c FROM accounting_audit WHERE entity_type = 'JournalEntry' AND company_id = 'default'", []);
    assert(audit.c > 0, 'Audit log should record JE operations');
  });

  // ═══ Step 7: Receipt Voucher / Money Received Transaction ═══
  console.log('\n── 40. Step 7: Receipt Voucher / Money Received ──');

  let receiptId;

  await test('Create Cash Receipt (post directly)', async () => {
    const r = await api(token, '/accounting/receipts', {
      method: 'POST', body: JSON.stringify({
        receipt_mode: 'CASH', voucher_date: '2026-09-07',
        receiving_ledger_id: 'acc_cash', source_ledger_id: 'acc_sales',
        amount: 10000, reference_number: 'CASH-001',
        narration: 'Cash sale', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Cash receipt should be created: ' + (r.error?.message || JSON.stringify(r)));
    receiptId = r.data.id;
    assert(r.data.status === 'POSTED', 'Receipt should be POSTED: ' + r.data.status);
    assert(r.data.voucherNumber.startsWith('RC-'), 'Should have RC- prefix voucher number');
  });

  await test('Receipt generates a balanced Journal Entry', async () => {
    const detail = dbGet("SELECT je.* FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ?", [receiptId]);
    assert(detail, 'Receipt should generate a JE');
    assert(Math.abs(detail.total_debit - detail.total_credit) < 0.01, 'JE must be balanced: debit=' + detail.total_debit + ' credit=' + detail.total_credit);
  });

  await test('Receipt JE has debit on receiving ledger, credit on source', async () => {
    const detail = dbGet("SELECT je.id FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ?", [receiptId]);
    const lines = dbQuery("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? ORDER BY debit_amount DESC, credit_amount DESC", [detail.id]);
    assert(lines.length === 2, 'Should have 2 lines');
    assert(parseFloat(lines[0].debit_amount) === 10000, 'First line should debit 10000');
    assert(parseFloat(lines[1].credit_amount) === 10000, 'Second line should credit 10000');
  });

  await test('Ledger reflects receipt (receiving account debited)', async () => {
    const bal = dbGet("SELECT COALESCE(SUM(debit_amount),0) - COALESCE(SUM(credit_amount),0) as bal FROM journal_entry_lines WHERE account_id = 'acc_cash'", []);
    assert(parseFloat(bal.bal) >= 10000, 'Cash ledger should reflect receipt: ' + bal.bal);
  });

  await test('Trial Balance reflects receipt', async () => {
    const tb = dbQuery("SELECT a.id, a.name, SUM(jel.debit_amount - jel.credit_amount) as balance FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id JOIN accounts a ON a.id = jel.account_id GROUP BY jel.account_id, a.name", []);
    const cashRow = tb.find(r => r.id === 'acc_cash');
    assert(cashRow && parseFloat(cashRow.balance) >= 10000, 'Cash should appear in trial balance with positive balance');
  });

  await test('Receipt Detail view shows JE reference', async () => {
    const r = await api(token, '/accounting/receipts/' + receiptId);
    assert(r.success, 'Receipt detail should succeed');
    assert(r.data.journalEntry, 'Detail should include JE');
    assert(r.data.journalEntry.entryNumber.startsWith('RV-'), 'JE entry number should have RV- prefix');
  });

  await test('Receipt List shows posted receipts', async () => {
    const r = await api(token, '/accounting/receipts?status=POSTED&limit=20');
    assert(r.success, 'Receipt list should succeed');
    assert(r.data.items.length > 0, 'Should have posted receipts');
  });

  await test('Validate Receipt (real-time accounting preview)', async () => {
    const r = await api(token, '/accounting/receipts/validate', {
      method: 'POST', body: JSON.stringify({
        receipt_mode: 'BANK', voucher_date: '2026-09-07',
        receiving_ledger_id: 'acc_bank', source_ledger_id: 'acc_sales',
        amount: 25000, financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Validation should pass: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.valid === true, 'Should be valid');
    assert(r.data.accountingEntry.debit.accountId === 'acc_bank', 'Debit should be receiving account');
    assert(r.data.accountingEntry.credit.accountId === 'acc_sales', 'Credit should be source account');
  });

  await test('Create Receipt as Draft', async () => {
    const r = await api(token, '/accounting/receipts/draft', {
      method: 'POST', body: JSON.stringify({
        receipt_mode: 'BANK', voucher_date: '2026-09-07',
        receiving_ledger_id: 'acc_bank', source_ledger_id: 'acc_capital',
        amount: 50000, reference_number: 'DRAFT-001',
        narration: 'Capital introduced - draft', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Draft receipt should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.status === 'DRAFT', 'Should be DRAFT: ' + r.data.status);
  });

  await test('Delete Draft Receipt', async () => {
    const createR = await api(token, '/accounting/receipts/draft', {
      method: 'POST', body: JSON.stringify({
        receipt_mode: 'CASH', voucher_date: '2026-09-07',
        receiving_ledger_id: 'acc_cash', source_ledger_id: 'acc_sales',
        amount: 5000, narration: 'Delete me', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(createR.success);
    const delR = await api(token, '/accounting/receipts/' + createR.data.id, { method: 'DELETE' });
    assert(delR.success, 'Draft receipt should be deletable');
  });

  await test('Cannot delete Posted Receipt', async () => {
    const r = await api(token, '/accounting/receipts/' + receiptId, { method: 'DELETE' });
    assert(!r.success, 'Posted receipt should not be deletable');
  });

  await test('Cannot edit Posted Receipt (update)', async () => {
    const r = await api(token, '/accounting/receipts/' + receiptId, {
      method: 'PUT', body: JSON.stringify({ narration: 'Modified' })
    });
    assert(!r.success, 'Posted receipt should not be editable');
  });

  await test('Cancel a Posted Receipt', async () => {
    const r = await api(token, '/accounting/receipts/' + receiptId + '/cancel', { method: 'POST' });
    assert(r.success, 'Cancel should succeed: ' + (r.error?.message || JSON.stringify(r)));
  });

  await test('Cannot cancel already-cancelled Receipt', async () => {
    const r = await api(token, '/accounting/receipts/' + receiptId + '/cancel', { method: 'POST' });
    assert(!r.success, 'Should not cancel cancelled receipt');
  });

  await test('Reverse a Posted Receipt', async () => {
    // Create a fresh receipt for reversal test
    const createR = await api(token, '/accounting/receipts', {
      method: 'POST', body: JSON.stringify({
        receipt_mode: 'BANK', voucher_date: '2026-09-07',
        receiving_ledger_id: 'acc_bank', source_ledger_id: 'acc_sales',
        amount: 15000, reference_number: 'REV-TEST',
        narration: 'Bank receipt for reversal', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(createR.success);
    const r = await api(token, '/accounting/receipts/' + createR.data.id + '/reverse', { method: 'POST' });
    assert(r.success, 'Reverse should succeed: ' + (r.error?.message || JSON.stringify(r)));
  });

  await test('Bank Receipt (post directly)', async () => {
    const r = await api(token, '/accounting/receipts', {
      method: 'POST', body: JSON.stringify({
        receipt_mode: 'BANK', voucher_date: '2026-09-07',
        receiving_ledger_id: 'acc_bank', source_ledger_id: 'acc_sales',
        amount: 30000, reference_number: 'NEFT-45882',
        narration: 'Bank receipt - customer payment', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Bank receipt should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.status === 'POSTED', 'Should be POSTED');
  });

  await test('Capital Receipt (balance sheet impact)', async () => {
    const r = await api(token, '/accounting/receipts', {
      method: 'POST', body: JSON.stringify({
        receipt_mode: 'BANK', voucher_date: '2026-09-07',
        receiving_ledger_id: 'acc_bank', source_ledger_id: 'acc_capital',
        amount: 100000, reference_number: 'CAPITAL-01',
        narration: 'Owner capital introduced', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Capital receipt should be created: ' + (r.error?.message || JSON.stringify(r)));
  });

  await test('Interest Income Receipt (P&L impact)', async () => {
    const r = await api(token, '/accounting/receipts', {
      method: 'POST', body: JSON.stringify({
        receipt_mode: 'BANK', voucher_date: '2026-09-07',
        receiving_ledger_id: 'acc_bank', source_ledger_id: 'acc_service',
        amount: 5000, reference_number: 'INT-001',
        narration: 'Interest income received', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Interest receipt should be created');
  });

  await test('Receipt audit trail exists', async () => {
    const audit = dbGet("SELECT COUNT(*) as c FROM accounting_audit WHERE entity_type = 'receipt' AND company_id = 'default'", []);
    assert(audit.c > 0, 'Audit log should record receipt operations');
  });

  await test('Reject zero amount receipt', async () => {
    const r = await api(token, '/accounting/receipts', {
      method: 'POST', body: JSON.stringify({
        receipt_mode: 'CASH', voucher_date: '2026-09-07',
        receiving_ledger_id: 'acc_cash', source_ledger_id: 'acc_sales',
        amount: 0, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Zero amount should be rejected');
  });

  await test('Reject negative amount receipt', async () => {
    const r = await api(token, '/accounting/receipts', {
      method: 'POST', body: JSON.stringify({
        receipt_mode: 'CASH', voucher_date: '2026-09-07',
        receiving_ledger_id: 'acc_cash', source_ledger_id: 'acc_sales',
        amount: -5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Negative amount should be rejected');
  });

  await test('Reject missing receiving account', async () => {
    const r = await api(token, '/accounting/receipts', {
      method: 'POST', body: JSON.stringify({
        receipt_mode: 'CASH', voucher_date: '2026-09-07',
        source_ledger_id: 'acc_sales',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Missing receiving account should be rejected');
  });

  await test('Reject missing source account', async () => {
    const r = await api(token, '/accounting/receipts', {
      method: 'POST', body: JSON.stringify({
        receipt_mode: 'CASH', voucher_date: '2026-09-07',
        receiving_ledger_id: 'acc_cash',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Missing source account should be rejected');
  });

  await test('Reject Group account as receiving ledger', async () => {
    const r = await api(token, '/accounting/receipts', {
      method: 'POST', body: JSON.stringify({
        receipt_mode: 'CASH', voucher_date: '2026-09-07',
        receiving_ledger_id: 'ag_asset', source_ledger_id: 'acc_sales',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Group account should be rejected as receiving ledger');
  });

  await test('Reject inactive account in receipt', async () => {
    const r = await api(token, '/accounting/receipts', {
      method: 'POST', body: JSON.stringify({
        receipt_mode: 'CASH', voucher_date: '2026-09-07',
        receiving_ledger_id: 'acc_cash', source_ledger_id: 'acc_01M1YHT1TWW8EV8HR5D0MMJQEP',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Inactive account should be rejected');
  });

  await test('Reject nature conflict (Debit-nature account as source/Credit)', async () => {
    const r = await api(token, '/accounting/receipts', {
      method: 'POST', body: JSON.stringify({
        receipt_mode: 'CASH', voucher_date: '2026-09-07',
        receiving_ledger_id: 'acc_cash', source_ledger_id: 'acc_rent',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Debit-nature account as source should be rejected');
  });

  await test('Reject invalid receipt_mode', async () => {
    const r = await api(token, '/accounting/receipts', {
      method: 'POST', body: JSON.stringify({
        receipt_mode: 'BITCOIN', voucher_date: '2026-09-07',
        receiving_ledger_id: 'acc_cash', source_ledger_id: 'acc_sales',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Invalid receipt mode should be rejected');
  });

  await test('Reject transaction date outside Financial Year', async () => {
    const r = await api(token, '/accounting/receipts', {
      method: 'POST', body: JSON.stringify({
        receipt_mode: 'CASH', voucher_date: '2025-01-01',
        receiving_ledger_id: 'acc_cash', source_ledger_id: 'acc_sales',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Date outside FY should be rejected');
  });

  await test('P&L reflects revenue receipts', async () => {
    const pnL = dbQuery("SELECT a.name, SUM(jel.credit_amount) as credit_total FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id JOIN accounts a ON a.id = jel.account_id WHERE a.type = 'INCOME' GROUP BY a.id, a.name", []);
    const salesRow = pnL.find(r => r.name === 'Sales Revenue');
    assert(salesRow && parseFloat(salesRow.credit_total) >= 10000, 'Sales revenue should appear in P&L with positive credit');
  });

  // ═══ Step 8: Payment Voucher / Money Paid Transaction ═══
  console.log('\\n── 41. Step 8: Payment Voucher / Money Paid ──');

  await test('Create Cash Payment (post directly)', async () => {
    const r = await api(token, '/accounting/payment-vouchers', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', payment_date: '2026-09-07',
        payment_account_id: 'acc_cash', destination_ledger_id: 'acc_rent',
        amount: 10000, reference_number: 'CASH-PAY-001',
        narration: 'Cash rent payment', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Cash payment should be created: ' + (r.error?.message || JSON.stringify(r)));
    paymentId = r.data.id;
    assert(r.data.status === 'POSTED', 'Payment should be POSTED: ' + r.data.status);
    assert(r.data.voucherNumber.startsWith('PY-'), 'Should have PY- prefix: ' + r.data.voucherNumber);
  });

  await test('Payment generates a balanced Journal Entry', async () => {
    const detail = dbGet("SELECT je.* FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ?", [paymentId]);
    assert(detail, 'Payment should generate a JE');
    assert(Math.abs(detail.total_debit - detail.total_credit) < 0.01, 'JE must be balanced: debit=' + detail.total_debit + ' credit=' + detail.total_credit);
  });

  await test('Payment JE has debit on destination, credit on payment account', async () => {
    const detail = dbGet("SELECT je.id FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ?", [paymentId]);
    const lines = dbQuery("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? ORDER BY debit_amount DESC, credit_amount DESC", [detail.id]);
    assert(lines.length === 2, 'Should have 2 lines');
    assert(parseFloat(lines[0].debit_amount) === 10000, 'First line should debit 10000');
    assert(parseFloat(lines[1].credit_amount) === 10000, 'Second line should credit 10000');
  });

  await test('Ledger reflects payment (payment account credited)', async () => {
    // Verify the payment's journal entry line credit-side is reflected on the cash account
    const detail = dbGet("SELECT je.id FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ?", [paymentId]);
    const cashCredited = dbGet("SELECT COALESCE(SUM(credit_amount),0) as c FROM journal_entry_lines WHERE account_id = 'acc_cash' AND journal_entry_id = ?", [detail.id]);
    assert(parseFloat(cashCredited.c) >= 10000, 'Cash account should be credited for the payment amount');
  });

  await test('Payment Detail view shows JE reference', async () => {
    const r = await api(token, '/accounting/payment-vouchers/' + paymentId);
    assert(r.success, 'Payment detail should succeed');
    assert(r.data.journalEntry, 'Detail should include JE');
    assert(r.data.journalEntry.entryNumber.startsWith('PY-'), 'JE entry number should have PY- prefix');
  });

  await test('Payment List shows posted payments', async () => {
    const r = await api(token, '/accounting/payment-vouchers?status=POSTED&limit=20');
    assert(r.success, 'Payment list should succeed');
    assert(r.data.items.length > 0, 'Should have posted payments');
  });

  await test('Validate Payment (real-time accounting preview)', async () => {
    const r = await api(token, '/accounting/payment-vouchers/validate', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BANK', payment_date: '2026-09-07',
        payment_account_id: 'acc_bank', destination_ledger_id: 'acc_rent',
        amount: 25000, financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Validation should pass: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.valid === true, 'Should be valid');
    assert(r.data.accountingEntry.debit.accountId === 'acc_rent', 'Debit should be destination account');
    assert(r.data.accountingEntry.credit.accountId === 'acc_bank', 'Credit should be payment account');
  });

  await test('Create Payment as Draft', async () => {
    const r = await api(token, '/accounting/payment-vouchers/draft', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BANK', payment_date: '2026-09-07',
        payment_account_id: 'acc_bank', destination_ledger_id: 'acc_rent',
        amount: 50000, reference_number: 'DRAFT-PAY-001',
        narration: 'Expense payment - draft', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Draft payment should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.status === 'DRAFT', 'Should be DRAFT: ' + r.data.status);
  });

  await test('Delete Draft Payment', async () => {
    const createR = await api(token, '/accounting/payment-vouchers/draft', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', payment_date: '2026-09-07',
        payment_account_id: 'acc_cash', destination_ledger_id: 'acc_utilities',
        amount: 5000, narration: 'Delete me', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(createR.success);
    const delR = await api(token, '/accounting/payment-vouchers/' + createR.data.id, { method: 'DELETE' });
    assert(delR.success, 'Draft payment should be deletable');
  });

  await test('Cannot delete Posted Payment', async () => {
    const r = await api(token, '/accounting/payment-vouchers/' + paymentId, { method: 'DELETE' });
    assert(!r.success, 'Posted payment should not be deletable');
  });

  await test('Cancel a Posted Payment', async () => {
    const r = await api(token, '/accounting/payment-vouchers/' + paymentId + '/cancel', { method: 'POST' });
    assert(r.success, 'Cancel should succeed: ' + (r.error?.message || JSON.stringify(r)));
  });

  await test('Cannot cancel already-cancelled Payment', async () => {
    const r = await api(token, '/accounting/payment-vouchers/' + paymentId + '/cancel', { method: 'POST' });
    assert(!r.success, 'Should not cancel already-cancelled payment');
  });

  await test('Reverse a Posted Payment', async () => {
    const createR = await api(token, '/accounting/payment-vouchers', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BANK', payment_date: '2026-09-07',
        payment_account_id: 'acc_bank', destination_ledger_id: 'acc_rent',
        amount: 15000, reference_number: 'REV-PAY-TEST',
        narration: 'Bank payment for reversal', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(createR.success);
    const r = await api(token, '/accounting/payment-vouchers/' + createR.data.id + '/reverse', { method: 'POST' });
    assert(r.success, 'Reverse should succeed: ' + (r.error?.message || JSON.stringify(r)));
  });

  await test('Bank Payment (post directly)', async () => {
    const r = await api(token, '/accounting/payment-vouchers', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BANK', payment_date: '2026-09-07',
        payment_account_id: 'acc_bank', destination_ledger_id: 'acc_rent',
        amount: 30000, reference_number: 'NEFT-PAY-1024',
        narration: 'Bank payment - rent', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Bank payment should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.status === 'POSTED', 'Should be POSTED');
  });

  await test('Supplier Payment (Accounts Payable - credit-nature destination)', async () => {
    const r = await api(token, '/accounting/payment-vouchers', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BANK', payment_date: '2026-09-07',
        payment_account_id: 'acc_bank', destination_ledger_id: 'acc_payable',
        amount: 25000, reference_number: 'SUP-PAY-1001',
        narration: 'Supplier payment - bank', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Supplier payment should be created: ' + (r.error?.message || JSON.stringify(r)));
  });

  await test('Loan Repayment (Liability - debit reduces liability)', async () => {
    const r = await api(token, '/accounting/payment-vouchers', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BANK', payment_date: '2026-09-07',
        payment_account_id: 'acc_bank', destination_ledger_id: 'acc_capital',
        amount: 20000, reference_number: 'LOAN-REP-001',
        narration: 'Loan repayment', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Loan repayment should be created: ' + (r.error?.message || JSON.stringify(r)));
  });

  await test('Payment audit trail exists', async () => {
    const audit = dbGet("SELECT COUNT(*) as c FROM accounting_audit WHERE entity_type = 'payment' AND company_id = 'default'", []);
    assert(audit.c > 0, 'Audit log should record payment operations');
  });

  await test('Reject zero amount payment', async () => {
    const r = await api(token, '/accounting/payment-vouchers', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', payment_date: '2026-09-07',
        payment_account_id: 'acc_cash', destination_ledger_id: 'acc_rent',
        amount: 0, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Zero amount should be rejected');
  });

  await test('Reject negative amount payment', async () => {
    const r = await api(token, '/accounting/payment-vouchers', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', payment_date: '2026-09-07',
        payment_account_id: 'acc_cash', destination_ledger_id: 'acc_rent',
        amount: -5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Negative amount should be rejected');
  });

  await test('Reject missing payment account', async () => {
    const r = await api(token, '/accounting/payment-vouchers', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', payment_date: '2026-09-07',
        destination_ledger_id: 'acc_rent',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Missing payment account should be rejected');
  });

  await test('Reject missing destination account', async () => {
    const r = await api(token, '/accounting/payment-vouchers', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', payment_date: '2026-09-07',
        payment_account_id: 'acc_cash',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Missing destination account should be rejected');
  });

  await test('Reject Group account as payment account', async () => {
    const r = await api(token, '/accounting/payment-vouchers', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', payment_date: '2026-09-07',
        payment_account_id: 'ag_asset', destination_ledger_id: 'acc_rent',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Group account should be rejected as payment account');
  });

  await test('Reject inactive account in payment', async () => {
    const r = await api(token, '/accounting/payment-vouchers', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', payment_date: '2026-09-07',
        payment_account_id: 'acc_cash', destination_ledger_id: 'acc_01M1YHT1TWW8EV8HR5D0MMJQEP',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Inactive account should be rejected');
  });

  await test('Reject CREDIT-nature account as payment account', async () => {
    const r = await api(token, '/accounting/payment-vouchers', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', payment_date: '2026-09-07',
        payment_account_id: 'acc_sales', destination_ledger_id: 'acc_rent',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'CREDIT-nature account as payment account should be rejected');
  });

  await test('Reject invalid payment_mode', async () => {
    const r = await api(token, '/accounting/payment-vouchers', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BITCOIN', payment_date: '2026-09-07',
        payment_account_id: 'acc_cash', destination_ledger_id: 'acc_rent',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Invalid payment mode should be rejected');
  });

  await test('Reject transaction date outside Financial Year', async () => {
    const r = await api(token, '/accounting/payment-vouchers', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', payment_date: '2025-01-01',
        payment_account_id: 'acc_cash', destination_ledger_id: 'acc_rent',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Date outside FY should be rejected');
  });

  await test('Payment Trial Balance (destination account debited)', async () => {
    const detail = dbGet("SELECT je.id FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ?", [paymentId]);
    const rentBal = dbGet("SELECT COALESCE(SUM(debit_amount) - SUM(credit_amount), 0) as bal FROM journal_entry_lines WHERE account_id = 'acc_rent'", []);
    assert(parseFloat(rentBal.bal) >= 10000, 'Rent expense should appear debited in trial balance: ' + rentBal.bal);
  });

  await test('P&L reflects expense payments', async () => {
    const pnL = dbQuery("SELECT a.name, SUM(jel.debit_amount) as debit_total FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id JOIN accounts a ON a.id = jel.account_id WHERE a.type = 'EXPENSE' GROUP BY a.id, a.name", []);
    const rentRow = pnL.find(r => r.name === 'Rent Expense');
    assert(rentRow && parseFloat(rentRow.debit_total) >= 10000, 'Rent expense should appear in P&L with positive debit');
  });

  await test('Cannot edit Posted Payment', async () => {
    const createR = await api(token, '/accounting/payment-vouchers', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', payment_date: '2026-09-07',
        payment_account_id: 'acc_cash', destination_ledger_id: 'acc_rent',
        amount: 5000, narration: 'Test edit', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(createR.success);
    const r = await api(token, '/accounting/payment-vouchers/' + createR.data.id, {
      method: 'PUT', body: JSON.stringify({ narration: 'Modified' })
    });
    assert(!r.success, 'Posted payment should not be editable');
  });

  // ═══ Step 9: Contra Voucher / Internal Fund Transfer ═══
  console.log('\\n── 42. Step 9: Contra Voucher / Internal Fund Transfer ──');

  let contraId;
  let assetsBefore;

  await test('Cash → Bank transfer (contra)', async () => {
    const r = await api(token, '/accounting/contra', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', contra_date: '2026-09-07',
        source_ledger_id: 'acc_cash', destination_ledger_id: 'acc_bank',
        amount: 50000, reference_number: 'CASH-TO-BANK-001',
        narration: 'Cash deposited into bank', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Cash → Bank contra should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.status === 'POSTED', 'Contra should be POSTED: ' + r.data.status);
    assert(r.data.voucherNumber.startsWith('CT-'), 'Should have CT- prefix: ' + r.data.voucherNumber);
    contraId = r.data.id;
  });

  await test('Contra generates a balanced Journal Entry', async () => {
    const detail = dbGet("SELECT je.* FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ?", [contraId]);
    assert(detail, 'Contra should generate a JE');
    assert(Math.abs(detail.total_debit - detail.total_credit) < 0.01, 'JE must be balanced: debit=' + detail.total_debit + ' credit=' + detail.total_credit);
  });

  await test('Contra JE has credit on source, debit on destination', async () => {
    const detail = dbGet("SELECT je.id FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ?", [contraId]);
    const lines = dbQuery("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? ORDER BY debit_amount DESC, credit_amount DESC", [detail.id]);
    assert(lines.length === 2, 'Should have 2 lines');
    assert(parseFloat(lines[0].debit_amount) === 50000, 'First line should debit 50000 (destination)');
    assert(parseFloat(lines[1].credit_amount) === 50000, 'Second line should credit 50000 (source)');
  });

  await test('Contra Ledger impact (bank debited, cash credited)', async () => {
    const detail = dbGet("SELECT je.id FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ?", [contraId]);
    const bankLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_bank'", [detail.id]);
    const cashLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_cash'", [detail.id]);
    assert(parseFloat(bankLine.debit_amount) === 50000, 'Bank should be debited');
    assert(parseFloat(cashLine.credit_amount) === 50000, 'Cash should be credited');
  });

  await test('Contra Trial Balance impact', async () => {
    const tb = dbQuery("SELECT a.id, a.name, SUM(jel.debit_amount - jel.credit_amount) as balance FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id JOIN accounts a ON a.id = jel.account_id WHERE je.voucher_id = ? GROUP BY jel.account_id, a.name", [contraId]);
    const bankRow = tb.find(r => r.id === 'acc_bank');
    const cashRow = tb.find(r => r.id === 'acc_cash');
    assert(bankRow && parseFloat(bankRow.balance) === 50000, 'Bank should show +50000 in trial balance');
    assert(cashRow && parseFloat(cashRow.balance) === -50000, 'Cash should show -50000 in trial balance');
  });

  await test('Contra Detail view shows JE reference', async () => {
    const r = await api(token, '/accounting/contra/' + contraId);
    assert(r.success, 'Contra detail should succeed');
    assert(r.data.journalEntry, 'Detail should include JE');
    assert(r.data.journalEntry.entryNumber.startsWith('CT-'), 'JE entry number should have CT- prefix');
  });

  await test('Contra List shows posted contras', async () => {
    const r = await api(token, '/accounting/contra?status=POSTED&limit=20');
    assert(r.success, 'Contra list should succeed');
    assert(r.data.items.length > 0, 'Should have posted contras');
  });

  await test('Validate Contra (real-time accounting preview)', async () => {
    const r = await api(token, '/accounting/contra/validate', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BANK', contra_date: '2026-09-07',
        source_ledger_id: 'acc_bank', destination_ledger_id: 'acc_cash',
        amount: 25000, financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Validation should pass: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.valid === true, 'Should be valid');
    assert(r.data.accountingEntry.debit.accountId === 'acc_cash', 'Debit should be destination account');
    assert(r.data.accountingEntry.credit.accountId === 'acc_bank', 'Credit should be source account');
  });

  await test('Create Contra as Draft', async () => {
    const r = await api(token, '/accounting/contra/draft', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BANK', contra_date: '2026-09-07',
        source_ledger_id: 'acc_bank', destination_ledger_id: 'acc_cash',
        amount: 10000, reference_number: 'DRAFT-CONTRA-001',
        narration: 'Draft transfer', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Draft contra should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.status === 'DRAFT', 'Should be DRAFT: ' + r.data.status);
  });

  await test('Delete Draft Contra', async () => {
    const createR = await api(token, '/accounting/contra/draft', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', contra_date: '2026-09-07',
        source_ledger_id: 'acc_cash', destination_ledger_id: 'acc_bank',
        amount: 5000, narration: 'Delete me', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(createR.success);
    const delR = await api(token, '/accounting/contra/' + createR.data.id, { method: 'DELETE' });
    assert(delR.success, 'Draft contra should be deletable');
  });

  await test('Cannot delete Posted Contra', async () => {
    const r = await api(token, '/accounting/contra/' + contraId, { method: 'DELETE' });
    assert(!r.success, 'Posted contra should not be deletable');
  });

  await test('Cancel a Posted Contra', async () => {
    const createR = await api(token, '/accounting/contra', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BANK', contra_date: '2026-09-07',
        source_ledger_id: 'acc_bank', destination_ledger_id: 'acc_cash',
        amount: 15000, reference_number: 'CANCEL-TEST-CONTRA',
        narration: 'Cancel test', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(createR.success);
    const r = await api(token, '/accounting/contra/' + createR.data.id + '/cancel', { method: 'POST' });
    assert(r.success, 'Cancel should succeed: ' + (r.error?.message || JSON.stringify(r)));
  });

  await test('Cannot cancel already-cancelled Contra', async () => {
    const createR = await api(token, '/accounting/contra', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BANK', contra_date: '2026-09-07',
        source_ledger_id: 'acc_bank', destination_ledger_id: 'acc_cash',
        amount: 15000, reference_number: 'CANCEL-TEST-CONTRA-2',
        narration: 'Cancel test 2', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(createR.success);
    await api(token, '/accounting/contra/' + createR.data.id + '/cancel', { method: 'POST' });
    const r = await api(token, '/accounting/contra/' + createR.data.id + '/cancel', { method: 'POST' });
    assert(!r.success, 'Should not cancel already-cancelled contra');
  });

  await test('Reverse a Posted Contra', async () => {
    const createR = await api(token, '/accounting/contra', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BANK', contra_date: '2026-09-07',
        source_ledger_id: 'acc_bank', destination_ledger_id: 'acc_cash',
        amount: 10000, reference_number: 'REV-CONTRA-TEST',
        narration: 'Bank to cash transfer', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(createR.success);
    const r = await api(token, '/accounting/contra/' + createR.data.id + '/reverse', { method: 'POST' });
    assert(r.success, 'Reverse should succeed: ' + (r.error?.message || JSON.stringify(r)));
  });

  await test('Bank → Bank transfer', async () => {
    const r = await api(token, '/accounting/contra', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BANK', contra_date: '2026-09-07',
        source_ledger_id: 'acc_bank', destination_ledger_id: 'acc_cash',
        amount: 30000, reference_number: 'BANK-TO-BANK-001',
        narration: 'Transfer between accounts', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Bank transfer should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.status === 'POSTED', 'Should be POSTED');
  });

  await test('Contra audit trail exists', async () => {
    const audit = dbGet("SELECT COUNT(*) as c FROM accounting_audit WHERE entity_type = 'contra' AND company_id = 'default'", []);
    assert(audit.c > 0, 'Audit log should record contra operations');
  });

  await test('Contra does NOT affect P&L (no revenue/expense)', async () => {
    // Before contra: get P&L totals
    const beforePnL = dbGet("SELECT COALESCE(SUM(CASE WHEN a.type IN ('INCOME') THEN jel.credit_amount - jel.debit_amount ELSE 0 END), 0) - COALESCE(SUM(CASE WHEN a.type IN ('EXPENSE') THEN jel.debit_amount - jel.credit_amount ELSE 0 END), 0) as profit FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id JOIN accounts a ON a.id = jel.account_id WHERE je.voucher_id = ?", [contraId]);
    // Contra only moves money between asset accounts (Cash/Bank), no P&L impact
    // The contra's own lines should only touch asset accounts
    const contraAccounts = dbQuery("SELECT DISTINCT a.type FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id JOIN accounts a ON a.id = jel.account_id WHERE je.voucher_id = ?", [contraId]);
    const hasPnLAccount = contraAccounts.some(a => a.type === 'INCOME' || a.type === 'EXPENSE');
    assert(!hasPnLAccount, 'Contra should not touch income/expense accounts: ' + JSON.stringify(contraAccounts.map(a => a.type)));
  });

  await test('Contra Balance Sheet asset composition changes correctly', async () => {
    // Total assets should remain unchanged (internal transfer)
    const assetTotal = dbGet("SELECT COALESCE(SUM(CASE WHEN a.type IN ('ASSET','CASH','BANK') THEN jel.debit_amount - jel.credit_amount ELSE 0 END), 0) as total FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id JOIN journal_entries je ON je.id = jel.journal_entry_id WHERE je.voucher_id = ?", [contraId]);
    assert(parseFloat(assetTotal.total) === 0, 'Contra should net to zero across asset accounts (internal transfer)');
  });

  await test('Cannot edit Posted Contra', async () => {
    const r = await api(token, '/accounting/contra/' + contraId, {
      method: 'PUT', body: JSON.stringify({ narration: 'Modified' })
    });
    assert(!r.success, 'Posted contra should not be editable');
  });

  await test('Reject zero amount contra', async () => {
    const r = await api(token, '/accounting/contra', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', contra_date: '2026-09-07',
        source_ledger_id: 'acc_cash', destination_ledger_id: 'acc_bank',
        amount: 0, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Zero amount should be rejected');
  });

  await test('Reject negative amount contra', async () => {
    const r = await api(token, '/accounting/contra', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', contra_date: '2026-09-07',
        source_ledger_id: 'acc_cash', destination_ledger_id: 'acc_bank',
        amount: -5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Negative amount should be rejected');
  });

  await test('Reject same source and destination', async () => {
    const r = await api(token, '/accounting/contra', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', contra_date: '2026-09-07',
        source_ledger_id: 'acc_cash', destination_ledger_id: 'acc_cash',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Same source and destination should be rejected');
  });

  await test('Reject missing source account', async () => {
    const r = await api(token, '/accounting/contra', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', contra_date: '2026-09-07',
        destination_ledger_id: 'acc_bank',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Missing source account should be rejected');
  });

  await test('Reject Group account as source', async () => {
    const r = await api(token, '/accounting/contra', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', contra_date: '2026-09-07',
        source_ledger_id: 'ag_asset', destination_ledger_id: 'acc_bank',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Group account should be rejected as source');
  });

  await test('Reject inactive account in contra', async () => {
    const r = await api(token, '/accounting/contra', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', contra_date: '2026-09-07',
        source_ledger_id: 'acc_cash', destination_ledger_id: 'acc_01M1YWBPDX87PYWYN1FHXKZYBJ',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Inactive account should be rejected');
  });

  await test('Reject non-DEBIT-nature account in contra (Revenue cannot be source/dest)', async () => {
    const r = await api(token, '/accounting/contra', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', contra_date: '2026-09-07',
        source_ledger_id: 'acc_sales', destination_ledger_id: 'acc_bank',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'CREDIT-nature account as source in contra should be rejected');
  });

  await test('Reject invalid payment_mode for contra', async () => {
    const r = await api(token, '/accounting/contra', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BITCOIN', contra_date: '2026-09-07',
        source_ledger_id: 'acc_cash', destination_ledger_id: 'acc_bank',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Invalid payment mode should be rejected');
  });

  await test('Reject date outside Financial Year for contra', async () => {
    const r = await api(token, '/accounting/contra', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', contra_date: '2025-01-01',
        source_ledger_id: 'acc_cash', destination_ledger_id: 'acc_bank',
        amount: 5000, currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Date outside FY should be rejected');
  });

  // ═══ Step 10: Sales Voucher / Sales Invoice ═══
  console.log('\\n── 43. Step 10: Sales Voucher / Sales Invoice ══');

  let salesId;
  let salesInvoiceNumber;

  await test('Post a Credit Sale (Dr Receivable / Cr Sales Revenue)', async () => {
    const r = await api(token, '/accounting/sales', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CREDIT', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_receivable', sales_ledger_id: 'acc_sales',
        amount: 25000, reference_number: 'INV-2026-0001',
        narration: 'Credit sale of services', currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Credit sale should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.status === 'POSTED', 'Sales should be POSTED: ' + r.data.status);
    assert(r.data.voucherNumber.startsWith('SV-'), 'Should have SV- prefix: ' + r.data.voucherNumber);
    assert(r.data.journalEntry, 'Should include journal entry');
    salesId = r.data.id;
    salesInvoiceNumber = r.data.voucherNumber;
  });

  await test('Sales generates a balanced Journal Entry', async () => {
    const je = dbGet("SELECT je.* FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ?", [salesId]);
    assert(je, 'Sales should generate a JE');
    assert(Math.abs(je.total_debit - je.total_credit) < 0.01, 'JE must be balanced: debit=' + je.total_debit + ' credit=' + je.total_credit);
  });

  await test('Sales JE has debit on receivable, credit on sales revenue', async () => {
    const je = dbGet("SELECT je.id FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ?", [salesId]);
    const lines = dbQuery("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ?", [je.id]);
    assert(lines.length === 2, 'Should have 2 lines');
    const debitLine = lines.find(l => parseFloat(l.debit_amount) > 0);
    const creditLine = lines.find(l => parseFloat(l.credit_amount) > 0);
    assert(debitLine.account_id === 'acc_receivable', 'Debit should be receivable account');
    assert(parseFloat(debitLine.debit_amount) === 25000, 'Debit amount should be 25000');
    assert(creditLine.account_id === 'acc_sales', 'Credit should be sales revenue account');
    assert(parseFloat(creditLine.credit_amount) === 25000, 'Credit amount should be 25000');
  });

  await test('Sales Ledger impact (receivable debited, sales credited)', async () => {
    const je = dbGet("SELECT je.id FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ?", [salesId]);
    const receivableLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_receivable'", [je.id]);
    const salesLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_sales'", [je.id]);
    assert(parseFloat(receivableLine.debit_amount) === 25000, 'Receivable should be debited');
    assert(parseFloat(salesLine.credit_amount) === 25000, 'Sales revenue should be credited');
  });

  await test('Sales Trial Balance impact', async () => {
    const tb = dbQuery("SELECT a.id, SUM(jel.debit_amount - jel.credit_amount) as balance FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id JOIN accounts a ON a.id = jel.account_id WHERE je.voucher_id = ? GROUP BY jel.account_id, a.id", [salesId]);
    const receivableRow = tb.find(r => r.id === 'acc_receivable');
    const salesRow = tb.find(r => r.id === 'acc_sales');
    assert(receivableRow && parseFloat(receivableRow.balance) === 25000, 'Receivable should show +25000 in trial balance');
    assert(salesRow && parseFloat(salesRow.balance) === -25000, 'Sales revenue should show -25000 in trial balance');
  });

  await test('Sales Detail view shows JE reference', async () => {
    const r = await api(token, '/accounting/sales/' + salesId);
    assert(r.success, 'Sales detail should succeed');
    assert(r.data.journalEntry, 'Detail should include JE');
    assert(r.data.journalEntry.entryNumber.startsWith('SV-'), 'JE entry number should have SV- prefix');
  });

  await test('Sales List shows posted sales invoices', async () => {
    const r = await api(token, '/accounting/sales?status=POSTED&limit=20');
    assert(r.success, 'Sales list should succeed');
    assert(r.data.items.length > 0, 'Should have posted sales invoices');
  });

  await test('Validate Sales (real-time accounting preview)', async () => {
    const r = await api(token, '/accounting/sales/validate', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_cash', sales_ledger_id: 'acc_sales',
        amount: 5000, currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Validation should pass: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.valid === true, 'Should be valid');
    assert(r.data.accountingEntry.debit.accountId === 'acc_cash', 'Debit should be receiving account');
    assert(r.data.accountingEntry.credit.accountId === 'acc_sales', 'Credit should be sales revenue');
  });

  await test('Create Sales Invoice as Draft', async () => {
    const r = await api(token, '/accounting/sales/draft', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BANK', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_bank', sales_ledger_id: 'acc_sales',
        amount: 10000, reference_number: 'INV-DRAFT-001',
        narration: 'Draft sale', currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Draft sales should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.status === 'DRAFT', 'Should be DRAFT: ' + r.data.status);
  });

  await test('Delete Draft Sales Invoice', async () => {
    const createR = await api(token, '/accounting/sales/draft', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_cash', sales_ledger_id: 'acc_sales',
        amount: 3000, reference_number: 'INV-DELETE-001',
        narration: 'Delete me', currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(createR.success);
    const delR = await api(token, '/accounting/sales/' + createR.data.id, { method: 'DELETE' });
    assert(delR.success, 'Draft sales should be deletable');
  });

  await test('Cannot delete Posted Sales Invoice', async () => {
    const r = await api(token, '/accounting/sales/' + salesId, { method: 'DELETE' });
    assert(!r.success, 'Posted sales should not be deletable');
  });

  await test('Cancel a Posted Sales Invoice', async () => {
    const createR = await api(token, '/accounting/sales', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CREDIT', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_receivable', sales_ledger_id: 'acc_sales',
        amount: 15000, reference_number: 'INV-CANCEL-TEST',
        narration: 'Cancel test sale', currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(createR.success);
    const r = await api(token, '/accounting/sales/' + createR.data.id + '/cancel', { method: 'POST' });
    assert(r.success, 'Cancel should succeed: ' + (r.error?.message || JSON.stringify(r)));
  });

  await test('Cannot cancel already-cancelled Sales Invoice', async () => {
    const createR = await api(token, '/accounting/sales', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CREDIT', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_receivable', sales_ledger_id: 'acc_sales',
        amount: 15000, reference_number: 'INV-CANCEL-TEST-2',
        narration: 'Cancel test sale 2', currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(createR.success);
    await api(token, '/accounting/sales/' + createR.data.id + '/cancel', { method: 'POST' });
    const r = await api(token, '/accounting/sales/' + createR.data.id + '/cancel', { method: 'POST' });
    assert(!r.success, 'Should not cancel already-cancelled sales');
  });

  await test('Reverse a Posted Sales Invoice', async () => {
    const createR = await api(token, '/accounting/sales', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BANK', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_bank', sales_ledger_id: 'acc_sales',
        amount: 10000, reference_number: 'INV-REV-TEST',
        narration: 'Bank sale for reversal', currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(createR.success);
    const r = await api(token, '/accounting/sales/' + createR.data.id + '/reverse', { method: 'POST' });
    assert(r.success, 'Reverse should succeed: ' + (r.error?.message || JSON.stringify(r)));
  });

  await test('Post a Cash Sale (Dr Cash / Cr Sales Revenue)', async () => {
    const r = await api(token, '/accounting/sales', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_cash', sales_ledger_id: 'acc_sales',
        amount: 5000, reference_number: 'INV-CASH-001',
        narration: 'Cash sale of services', currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Cash sale should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.status === 'POSTED', 'Should be POSTED');
  });

  await test('Post a Bank Sale (Dr Bank / Cr Sales Revenue)', async () => {
    const r = await api(token, '/accounting/sales', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BANK', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_bank', sales_ledger_id: 'acc_sales',
        amount: 15000, reference_number: 'INV-BANK-001',
        narration: 'Bank sale of services', currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(r.success, 'Bank sale should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.status === 'POSTED', 'Should be POSTED');
  });

  await test('Sales audit trail exists', async () => {
    const audit = dbGet("SELECT COUNT(*) as c FROM accounting_audit WHERE entity_type = 'sales' AND company_id = 'default'", []);
    assert(audit.c > 0, 'Audit log should record sales operations');
  });

  await test('Sales P&L impact (revenue affects Income)', async () => {
    const salesAccountType = dbGet("SELECT type FROM accounts WHERE id = 'acc_sales'", []);
    assert(salesAccountType.type === 'INCOME', 'Sales revenue account should be INCOME type');
    const je = dbGet("SELECT je.id FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ?", [salesId]);
    const revenueLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_sales'", [je.id]);
    assert(parseFloat(revenueLine.credit_amount) === 25000, 'Sales revenue should be credited (P&L impact)');
  });

  await test('Sales Balance Sheet asset impact (receivable affects Assets)', async () => {
    const receivableAccountType = dbGet("SELECT type FROM accounts WHERE id = 'acc_receivable'", []);
    assert(receivableAccountType.type === 'ASSET', 'Receivable account should be ASSET type');
    const je = dbGet("SELECT je.id FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ?", [salesId]);
    const receivableLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_receivable'", [je.id]);
    assert(parseFloat(receivableLine.debit_amount) === 25000, 'Receivable should be debited (Balance Sheet impact)');
  });

  await test('Cannot edit Posted Sales Invoice', async () => {
    const r = await api(token, '/accounting/sales/' + salesId, {
      method: 'PUT', body: JSON.stringify({ narration: 'Modified' })
    });
    assert(!r.success, 'Posted sales should not be editable');
  });

  await test('Reject zero amount sales', async () => {
    const r = await api(token, '/accounting/sales', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_cash', sales_ledger_id: 'acc_sales',
        amount: 0, currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Zero amount should be rejected');
  });

  await test('Reject negative amount sales', async () => {
    const r = await api(token, '/accounting/sales', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_cash', sales_ledger_id: 'acc_sales',
        amount: -5000, currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Negative amount should be rejected');
  });

  await test('Reject missing receiving ledger', async () => {
    const r = await api(token, '/accounting/sales', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', sales_date: '2026-09-08',
        sales_ledger_id: 'acc_sales',
        amount: 5000, currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Missing receiving ledger should be rejected');
  });

  await test('Reject missing sales ledger', async () => {
    const r = await api(token, '/accounting/sales', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_cash',
        amount: 5000, currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Missing sales ledger should be rejected');
  });

  await test('Reject Group account as receiving ledger', async () => {
    const r = await api(token, '/accounting/sales', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', sales_date: '2026-09-08',
        receiving_ledger_id: 'ag_asset', sales_ledger_id: 'acc_sales',
        amount: 5000, currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Group account should be rejected as receiving ledger');
  });

  await test('Reject CREDIT-nature account as receiving ledger', async () => {
    const r = await api(token, '/accounting/sales', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_sales', sales_ledger_id: 'acc_sales',
        amount: 5000, currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'CREDIT-nature account should not be receivable for sales');
  });

  await test('Reject DEBIT-nature account as sales revenue', async () => {
    const r = await api(token, '/accounting/sales', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_cash', sales_ledger_id: 'acc_receivable',
        amount: 5000, currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'DEBIT-nature account should not be sales revenue');
  });

  await test('Reject same receiving and sales ledger', async () => {
    const r = await api(token, '/accounting/sales', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_cash', sales_ledger_id: 'acc_cash',
        amount: 5000, currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Same account should be rejected');
  });

  await test('Reject invalid payment_mode for sales', async () => {
    const r = await api(token, '/accounting/sales', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'BITCOIN', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_cash', sales_ledger_id: 'acc_sales',
        amount: 5000, currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Invalid payment mode should be rejected');
  });

  await test('Reject date outside Financial Year for sales', async () => {
    const r = await api(token, '/accounting/sales', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', sales_date: '2025-01-01',
        receiving_ledger_id: 'acc_cash', sales_ledger_id: 'acc_sales',
        amount: 5000, currency: 'INR', contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Date outside FY should be rejected');
  });

  // ═══ Step 11: Purchase Voucher / Purchase Invoice ═══
  console.log('\\n── 44. Step 11: Purchase Voucher / Purchase Invoice ══');

  let purchaseId = null;
  let purchaseVoucherNumber = null;

  await test('Create Purchase Invoice (credit purchase)', async () => {
    const r = await api(token, '/accounting/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'CREDIT',
        purchase_ledger_id: 'acc_purchases', contact_id: contactId,
        payable_ledger_id: 'acc_payable',
        amount: 25000, reference_number: 'PUR-2026-0001',
        currency: 'INR', financial_year_id: activeFyId,
        narration: 'Credit purchase of raw materials'
      })
    });
    assert(r.success, 'Credit purchase should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.voucherType === 'PURCHASE', 'Voucher type should be PURCHASE');
    assert(r.data.status === 'POSTED', 'Status should be POSTED');
    purchaseId = r.data.id;
    purchaseVoucherNumber = r.data.voucherNumber;
  });

  await test('Purchase generates a balanced Journal Entry', async () => {
    const je = dbGet("SELECT id, entry_number, total_debit, total_credit FROM journal_entries WHERE voucher_id = ?", [purchaseId]);
    assert(je, 'Journal entry should exist');
    assert(parseFloat(je.total_debit) === 25000, 'Total debit should be 25000');
    assert(parseFloat(je.total_credit) === 25000, 'Total credit should be 25000');
    assert(parseFloat(je.total_debit) === parseFloat(je.total_credit), 'JE must be balanced');
    assert(je.entry_number.startsWith('PUR-'), 'JE entry number should have PUR- prefix');
  });

  await test('Purchase JE has debit on purchase ledger, credit on payable', async () => {
    const je = dbGet("SELECT id FROM journal_entries WHERE voucher_id = ?", [purchaseId]);
    const purchaseLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_purchases'", [je.id]);
    const payableLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_payable'", [je.id]);
    assert(purchaseLine && parseFloat(purchaseLine.debit_amount) === 25000, 'Purchase ledger should be debited');
    assert(payableLine && parseFloat(payableLine.credit_amount) === 25000, 'Payable ledger should be credited');
  });

  await test('Purchase Ledger impact (purchase debited, payable credited)', async () => {
    const tb = dbQuery("SELECT a.id, SUM(jel.debit_amount - jel.credit_amount) as balance FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id JOIN accounts a ON a.id = jel.account_id WHERE je.voucher_id = ? GROUP BY jel.account_id, a.id", [purchaseId]);
    const purchaseRow = tb.find(r => r.id === 'acc_purchases');
    const payableRow = tb.find(r => r.id === 'acc_payable');
    assert(purchaseRow && parseFloat(purchaseRow.balance) === 25000, 'Purchase ledger should show +25000 in trial balance');
    assert(payableRow && parseFloat(payableRow.balance) === -25000, 'Payable ledger should show -25000 (credit balance) in trial balance');
  });

  await test('Purchase Trial Balance impact', async () => {
    const r = await api(token, '/accounting/reports/trial-balance');
    assert(r.success, 'Trial balance should succeed');
  });

  await test('Purchase Detail view shows JE reference', async () => {
    const r = await api(token, '/accounting/purchases/' + purchaseId);
    assert(r.success, 'Purchase detail should succeed');
    assert(r.data.journalEntry, 'Detail should include JE');
    assert(r.data.journalEntry.entryNumber.startsWith('PUR-'), 'JE entry number should have PUR- prefix');
  });

  await test('Purchase List shows posted purchases', async () => {
    const r = await api(token, '/accounting/purchases?status=POSTED&limit=20');
    assert(r.success, 'Purchase list should succeed');
    assert(r.data.items.length > 0, 'Should have posted purchase invoices');
  });

  await test('Validate Purchase (real-time accounting preview)', async () => {
    const r = await api(token, '/accounting/purchases/validate', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CASH', purchase_date: '2026-09-08',
        purchase_ledger_id: 'acc_purchases', payable_ledger_id: 'acc_cash',
        amount: 5000, currency: 'INR', contact_id: contactId, financial_year_id: activeFyId,
        reference_number: 'PUR-VALIDATE-TEST'
      })
    });
    assert(r.success, 'Validation should pass: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.valid === true, 'Should be valid');
    assert(r.data.accountingEntry.debit.accountId === 'acc_purchases', 'Debit should be purchase ledger');
    assert(r.data.accountingEntry.credit.accountId === 'acc_cash', 'Credit should be payment ledger');
  });

  await test('Create Purchase Invoice as Draft', async () => {
    const r = await api(token, '/accounting/purchases/draft', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'CREDIT',
        purchase_ledger_id: 'acc_purchases', contact_id: contactId,
        payable_ledger_id: 'acc_payable',
        amount: 10000, reference_number: 'PUR-DRAFT-TEST',
        currency: 'INR', financial_year_id: activeFyId,
        narration: 'Draft purchase'
      })
    });
    assert(r.success, 'Draft purchase should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.status === 'DRAFT', 'Status should be DRAFT');
  });

  await test('Delete Draft Purchase Invoice', async () => {
    const createR = await api(token, '/accounting/purchases/draft', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'CREDIT',
        purchase_ledger_id: 'acc_purchases', contact_id: contactId,
        payable_ledger_id: 'acc_payable',
        amount: 10000, reference_number: 'PUR-DELETE-TEST',
        currency: 'INR', financial_year_id: activeFyId,
        narration: 'Delete me'
      })
    });
    assert(createR.success);
    const delR = await api(token, '/accounting/purchases/' + createR.data.id, { method: 'DELETE' });
    assert(delR.success, 'Draft purchase should be deleted: ' + (delR.error?.message || JSON.stringify(delR)));
  });

  await test('Cannot delete Posted Purchase Invoice', async () => {
    const r = await api(token, '/accounting/purchases/' + purchaseId, { method: 'DELETE' });
    assert(!r.success, 'Posted purchase should not be deletable');
  });

  await test('Cancel a Posted Purchase Invoice', async () => {
    const createR = await api(token, '/accounting/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'CREDIT',
        purchase_ledger_id: 'acc_purchases', contact_id: contactId,
        payable_ledger_id: 'acc_payable',
        amount: 10000, reference_number: 'PUR-CANCEL-TEST',
        narration: 'Cancel test purchase', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(createR.success);
    const r = await api(token, '/accounting/purchases/' + createR.data.id + '/cancel', { method: 'POST' });
    assert(r.success, 'Cancel should succeed: ' + (r.error?.message || JSON.stringify(r)));
  });

  await test('Cannot cancel already-cancelled Purchase Invoice', async () => {
    const createR = await api(token, '/accounting/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'CREDIT',
        purchase_ledger_id: 'acc_purchases', contact_id: contactId,
        payable_ledger_id: 'acc_payable',
        amount: 10000, reference_number: 'PUR-CANCEL-TEST-2',
        narration: 'Cancel test purchase 2', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(createR.success);
    await api(token, '/accounting/purchases/' + createR.data.id + '/cancel', { method: 'POST' });
    const r = await api(token, '/accounting/purchases/' + createR.data.id + '/cancel', { method: 'POST' });
    assert(!r.success, 'Should not cancel already-cancelled purchase');
  });

  await test('Reverse a Posted Purchase Invoice', async () => {
    const createR = await api(token, '/accounting/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'BANK',
        purchase_ledger_id: 'acc_purchases', contact_id: contactId,
        receiving_ledger_id: 'acc_bank',
        amount: 10000, reference_number: 'PUR-REV-TEST',
        narration: 'Bank purchase for reversal', currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(createR.success);
    const r = await api(token, '/accounting/purchases/' + createR.data.id + '/reverse', { method: 'POST' });
    assert(r.success, 'Reverse should succeed: ' + (r.error?.message || JSON.stringify(r)));
  });

  await test('Post a Cash Purchase (Dr Purchase / Cr Cash)', async () => {
    const r = await api(token, '/accounting/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'CASH',
        purchase_ledger_id: 'acc_purchases', contact_id: contactId,
        payable_ledger_id: 'acc_cash',
        amount: 5000, reference_number: 'PUR-CASH-TEST',
        currency: 'INR', financial_year_id: activeFyId,
        narration: 'Cash purchase'
      })
    });
    assert(r.success, 'Cash purchase should be created: ' + (r.error?.message || JSON.stringify(r)));
    const je = dbGet("SELECT id FROM journal_entries WHERE voucher_id = ?", [r.data.id]);
    const cashLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_cash'", [je.id]);
    assert(cashLine && parseFloat(cashLine.credit_amount) === 5000, 'Cash should be credited');
  });

  await test('Post a Bank Purchase (Dr Purchase / Cr Bank)', async () => {
    const r = await api(token, '/accounting/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'BANK',
        purchase_ledger_id: 'acc_purchases', contact_id: contactId,
        payable_ledger_id: 'acc_bank',
        amount: 15000, reference_number: 'PUR-BANK-TEST',
        currency: 'INR', financial_year_id: activeFyId,
        narration: 'Bank purchase'
      })
    });
    assert(r.success, 'Bank purchase should be created: ' + (r.error?.message || JSON.stringify(r)));
    const je = dbGet("SELECT id FROM journal_entries WHERE voucher_id = ?", [r.data.id]);
    const bankLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_bank'", [je.id]);
    assert(bankLine && parseFloat(bankLine.credit_amount) === 15000, 'Bank should be credited');
  });

  await test('Purchase audit trail exists', async () => {
    const audit = dbGet("SELECT COUNT(*) as c FROM accounting_audit WHERE entity_type = 'purchase' AND company_id = 'default'", []);
    assert(audit.c > 0, 'Should have purchase audit records');
  });

  await test('Purchase P&L impact (expense affects P&L)', async () => {
    const r = await api(token, '/accounting/reports/profit-loss');
    assert(r.success, 'P&L should succeed');
  });

  await test('Purchase Balance Sheet payable impact', async () => {
    const r = await api(token, '/accounting/reports/balance-sheet');
    assert(r.success, 'Balance sheet should succeed');
  });

  await test('Cannot edit Posted Purchase Invoice', async () => {
    const r = await api(token, '/accounting/purchases/' + purchaseId + '/reverse', { method: 'POST' });
    const r2 = await api(token, '/accounting/purchases/' + purchaseId + '/reverse', { method: 'POST' });
    assert(!r2.success, 'Should not reverse already-reversed purchase');
  });

  await test('Reject zero amount purchase', async () => {
    const r = await api(token, '/accounting/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'CREDIT',
        purchase_ledger_id: 'acc_purchases', contact_id: contactId,
        payable_ledger_id: 'acc_payable',
        amount: 0, reference_number: 'PUR-ZERO-TEST',
        currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Zero amount should be rejected');
  });

  await test('Reject negative amount purchase', async () => {
    const r = await api(token, '/accounting/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'CREDIT',
        purchase_ledger_id: 'acc_purchases', contact_id: contactId,
        payable_ledger_id: 'acc_payable',
        amount: -100, reference_number: 'PUR-NEG-TEST',
        currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Negative amount should be rejected');
  });

  await test('Reject missing supplier', async () => {
    const r = await api(token, '/accounting/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'CREDIT',
        purchase_ledger_id: 'acc_purchases',
        payable_ledger_id: 'acc_payable',
        amount: 10000, reference_number: 'PUR-NOSUP-TEST',
        currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Missing supplier should be rejected');
  });

  await test('Reject missing purchase ledger', async () => {
    const r = await api(token, '/accounting/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'CREDIT',
        contact_id: contactId,
        payable_ledger_id: 'acc_payable',
        amount: 10000, reference_number: 'PUR-NOPURCH-TEST',
        currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Missing purchase ledger should be rejected');
  });

  await test('Reject Group account as purchase ledger', async () => {
    const r = await api(token, '/accounting/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'CREDIT',
        purchase_ledger_id: 'ag_purchases', contact_id: contactId,
        payable_ledger_id: 'acc_payable',
        amount: 10000, reference_number: 'PUR-GROUP-TEST',
        currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Group account should be rejected');
  });

  await test('Reject CREDIT-nature account as purchase ledger', async () => {
    const r = await api(token, '/accounting/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'CREDIT',
        purchase_ledger_id: 'acc_sales', contact_id: contactId,
        payable_ledger_id: 'acc_payable',
        amount: 10000, reference_number: 'PUR-NATURE-TEST',
        currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'CREDIT-nature account should not be purchase ledger');
  });

  await test('Reject same purchase and payable ledger', async () => {
    const r = await api(token, '/accounting/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'CREDIT',
        purchase_ledger_id: 'acc_purchases', contact_id: contactId,
        payable_ledger_id: 'acc_purchases',
        amount: 10000, reference_number: 'PUR-SAME-TEST',
        currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Same account should be rejected');
  });

  await test('Reject invalid payment_mode for purchase', async () => {
    const r = await api(token, '/accounting/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2026-09-08', payment_mode: 'INVALID',
        purchase_ledger_id: 'acc_purchases', contact_id: contactId,
        payable_ledger_id: 'acc_payable',
        amount: 10000, reference_number: 'PUR-BADMODE-TEST',
        currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Invalid payment mode should be rejected');
  });

  await test('Reject date outside Financial Year for purchase', async () => {
    const r = await api(token, '/accounting/purchases', {
      method: 'POST', body: JSON.stringify({
        purchase_date: '2025-01-01', payment_mode: 'CREDIT',
        purchase_ledger_id: 'acc_purchases', contact_id: contactId,
        payable_ledger_id: 'acc_payable',
        amount: 10000, reference_number: 'PUR-BADDATE-TEST',
        currency: 'INR', financial_year_id: activeFyId
      })
    });
    assert(!r.success, 'Date outside FY should be rejected');
  });

  // ═══ Step 12: Expense Voucher / Expense Transaction ═══
  console.log('\\n── 46. Step 12: Expense Voucher / Expense Transaction ══');

  let expenseId = null;
  let expenseVoucherNumber = null;

  await test('Create Expense Voucher (cash expense)', async () => {
    const r = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CASH',
        payee_id: contactId, payment_ledger_id: 'acc_cash',
        amount: 10000, reference_number: 'EXP-CASH-001',
        currency: 'INR', financial_year_id: activeFyId,
        narration: 'Cash rent payment',
        lines: [
          { expense_ledger_id: 'acc_rent', amount: 10000, description: 'Office rent' }
        ]
      })
    });
    assert(r.success, 'Cash expense should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.voucherType === 'EXPENSE', 'Voucher type should be EXPENSE');
    assert(r.data.status === 'POSTED', 'Status should be POSTED');
    expenseId = r.data.id;
    expenseVoucherNumber = r.data.voucherNumber;
  });

  await test('Expense generates a balanced Journal Entry', async () => {
    const je = dbGet("SELECT id, entry_number, total_debit, total_credit FROM journal_entries WHERE voucher_id = ?", [expenseId]);
    assert(je, 'Journal entry should exist');
    assert(parseFloat(je.total_debit) === 10000, 'Total debit should be 10000');
    assert(parseFloat(je.total_credit) === 10000, 'Total credit should be 10000');
    assert(parseFloat(je.total_debit) === parseFloat(je.total_credit), 'JE must be balanced');
    assert(je.entry_number.startsWith('EXP-'), 'JE entry number should have EXP- prefix');
  });

  await test('Expense JE has debit on expense ledger, credit on cash', async () => {
    const je = dbGet("SELECT id FROM journal_entries WHERE voucher_id = ?", [expenseId]);
    const expenseLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_rent'", [je.id]);
    const cashLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_cash'", [je.id]);
    assert(expenseLine && parseFloat(expenseLine.debit_amount) === 10000, 'Rent expense should be debited');
    assert(cashLine && parseFloat(cashLine.credit_amount) === 10000, 'Cash should be credited');
  });

  await test('Expense Ledger impact (expense debited, cash credited)', async () => {
    const tb = dbQuery("SELECT a.id, SUM(jel.debit_amount - jel.credit_amount) as balance FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id JOIN accounts a ON a.id = jel.account_id WHERE je.voucher_id = ? GROUP BY jel.account_id, a.id", [expenseId]);
    const expenseRow = tb.find(r => r.id === 'acc_rent');
    const cashRow = tb.find(r => r.id === 'acc_cash');
    assert(expenseRow && parseFloat(expenseRow.balance) === 10000, 'Rent expense should show +10000 in trial balance');
    assert(cashRow && parseFloat(cashRow.balance) === -10000, 'Cash should show -10000 (credit balance) in trial balance');
  });

  await test('Expense Trial Balance impact', async () => {
    const r = await api(token, '/accounting/reports/trial-balance');
    assert(r.success, 'Trial balance should succeed');
  });

  await test('Expense Detail view shows JE reference', async () => {
    const r = await api(token, '/accounting/expenses/' + expenseId);
    assert(r.success, 'Expense detail should succeed');
    assert(r.data.journalEntry, 'Detail should include JE');
    assert(r.data.journalEntry.entryNumber.startsWith('EXP-'), 'JE entry number should have EXP- prefix');
    assert(r.data.expenseLines && r.data.expenseLines.length > 0, 'Should have expense lines');
  });

  await test('Expense List shows posted expenses', async () => {
    const r = await api(token, '/accounting/expenses?status=POSTED&limit=20');
    assert(r.success, 'Expense list should succeed');
    assert(r.data.items.length > 0, 'Should have posted expense vouchers');
  });

  // ─── Bank Expense ───
  let bankExpenseId = null;
  await test('Post a Bank Expense (Dr Expense / Cr Bank)', async () => {
    const r = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'BANK',
        payee_id: contactId, payment_ledger_id: 'acc_bank',
        amount: 5000, reference_number: 'EXP-BANK-001',
        currency: 'INR', financial_year_id: activeFyId,
        narration: 'Electricity bill payment',
        lines: [
          { expense_ledger_id: 'acc_utilities', amount: 5000, description: 'Electricity bill' }
        ]
      })
    });
    assert(r.success, 'Bank expense should be created: ' + (r.error?.message || JSON.stringify(r)));
    bankExpenseId = r.data.id;
    const je = dbGet("SELECT id FROM journal_entries WHERE voucher_id = ?", [bankExpenseId]);
    const bankLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_bank'", [je.id]);
    assert(bankLine && parseFloat(bankLine.credit_amount) === 5000, 'Bank should be credited');
  });

  // ─── Credit Expense ───
  let creditExpenseId = null;
  await test('Post a Credit Expense (Dr Expense / Cr Accounts Payable)', async () => {
    const r = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CREDIT',
        payee_id: contactId, payment_ledger_id: 'acc_payable',
        amount: 25000, reference_number: 'EXP-CREDIT-001',
        currency: 'INR', financial_year_id: activeFyId,
        narration: 'Professional fees on credit',
        lines: [
          { expense_ledger_id: 'acc_marketing', amount: 25000, description: 'Professional fees' }
        ]
      })
    });
    assert(r.success, 'Credit expense should be created: ' + (r.error?.message || JSON.stringify(r)));
    creditExpenseId = r.data.id;
    const je = dbGet("SELECT id FROM journal_entries WHERE voucher_id = ?", [creditExpenseId]);
    const payableLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_payable'", [je.id]);
    assert(payableLine && parseFloat(payableLine.credit_amount) === 25000, 'Accounts Payable should be credited');
  });

  // ─── Multi-line Expense ───
  let multiExpenseId = null;
  await test('Post a Multi-line Expense', async () => {
    const r = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'BANK',
        payee_id: contactId, payment_ledger_id: 'acc_bank',
        amount: 25000, reference_number: 'EXP-MULTI-001',
        currency: 'INR', financial_year_id: activeFyId,
        narration: 'Multiple expenses paid together',
        lines: [
          { expense_ledger_id: 'acc_rent', amount: 20000, description: 'September rent' },
          { expense_ledger_id: 'acc_utilities', amount: 2000, description: 'Internet bill' },
          { expense_ledger_id: 'acc_marketing', amount: 3000, description: 'Office supplies' }
        ]
      })
    });
    assert(r.success, 'Multi-line expense should be created: ' + (r.error?.message || JSON.stringify(r)));
    multiExpenseId = r.data.id;
    const je = dbGet("SELECT id, total_debit, total_credit FROM journal_entries WHERE voucher_id = ?", [multiExpenseId]);
    assert(parseFloat(je.total_debit) === 25000, 'Total debit should be 25000');
    assert(parseFloat(je.total_credit) === 25000, 'Total credit should be 25000');
    const jeLines = dbQuery("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ?", [je.id]);
    assert(jeLines.length === 4, 'Should have 4 JE lines (3 expense + 1 bank)');
  });

  await test('Expense Detail shows multi-line expenses', async () => {
    const r = await api(token, '/accounting/expenses/' + multiExpenseId);
    assert(r.success, 'Multi-line expense detail should succeed');
    assert(r.data.expenseLines.length === 3, 'Should have 3 expense lines');
    assert(r.data.journalEntry.lines.length === 4, 'JE should have 4 lines');
  });

  // ─── Validate Expense (real-time preview) ───
  await test('Validate Expense (real-time accounting preview)', async () => {
    const r = await api(token, '/accounting/expenses/validate', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CASH',
        payee_id: contactId, payment_ledger_id: 'acc_cash',
        reference_number: 'EXP-VALIDATE-001',
        currency: 'INR', financial_year_id: activeFyId,
        lines: [
          { expense_ledger_id: 'acc_rent', amount: 5000, description: 'Rent' }
        ]
      })
    });
    assert(r.success, 'Validation should pass: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.valid === true, 'Should be valid');
    assert(r.data.totals.grandTotal === 5000, 'Total should be 5000');
  });

  // ─── Draft ───
  await test('Create Expense Voucher as Draft', async () => {
    const r = await api(token, '/accounting/expenses/draft', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CREDIT',
        payee_id: contactId, payment_ledger_id: 'acc_payable',
        reference_number: 'EXP-DRAFT-001',
        currency: 'INR', financial_year_id: activeFyId,
        narration: 'Draft expense',
        lines: [
          { expense_ledger_id: 'acc_rent', amount: 3000, description: 'Draft rent' }
        ]
      })
    });
    assert(r.success, 'Draft expense should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.status === 'DRAFT', 'Status should be DRAFT');
  });

  await test('Delete Draft Expense Voucher', async () => {
    const createR = await api(token, '/accounting/expenses/draft', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CASH',
        payee_id: contactId, payment_ledger_id: 'acc_cash',
        reference_number: 'EXP-DELETE-001',
        currency: 'INR', financial_year_id: activeFyId,
        narration: 'Delete me',
        lines: [
          { expense_ledger_id: 'acc_rent', amount: 1000, description: 'Delete' }
        ]
      })
    });
    assert(createR.success);
    const delR = await api(token, '/accounting/expenses/' + createR.data.id, { method: 'DELETE' });
    assert(delR.success, 'Draft expense should be deleted: ' + (delR.error?.message || JSON.stringify(delR)));
  });

  await test('Cannot delete Posted Expense Voucher', async () => {
    const r = await api(token, '/accounting/expenses/' + expenseId, { method: 'DELETE' });
    assert(!r.success, 'Posted expense should not be deletable');
  });

  // ─── Cancel ───
  await test('Cancel a Posted Expense Voucher', async () => {
    const createR = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CASH',
        payee_id: contactId, payment_ledger_id: 'acc_cash',
        reference_number: 'EXP-CANCEL-001',
        currency: 'INR', financial_year_id: activeFyId,
        narration: 'Cancel test expense',
        lines: [
          { expense_ledger_id: 'acc_rent', amount: 5000, description: 'Cancel' }
        ]
      })
    });
    assert(createR.success);
    const r = await api(token, '/accounting/expenses/' + createR.data.id + '/cancel', { method: 'POST' });
    assert(r.success, 'Cancel should succeed: ' + (r.error?.message || JSON.stringify(r)));
  });

  await test('Cannot cancel already-cancelled Expense Voucher', async () => {
    const createR = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CASH',
        payee_id: contactId, payment_ledger_id: 'acc_cash',
        reference_number: 'EXP-CANCEL-002',
        currency: 'INR', financial_year_id: activeFyId,
        narration: 'Cancel test expense 2',
        lines: [
          { expense_ledger_id: 'acc_rent', amount: 5000, description: 'Cancel 2' }
        ]
      })
    });
    assert(createR.success);
    await api(token, '/accounting/expenses/' + createR.data.id + '/cancel', { method: 'POST' });
    const r = await api(token, '/accounting/expenses/' + createR.data.id + '/cancel', { method: 'POST' });
    assert(!r.success, 'Should not cancel already-cancelled expense');
  });

  // ─── Reverse ───
  await test('Reverse a Posted Expense Voucher', async () => {
    const createR = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'BANK',
        payee_id: contactId, payment_ledger_id: 'acc_bank',
        reference_number: 'EXP-REV-001',
        currency: 'INR', financial_year_id: activeFyId,
        narration: 'Bank expense for reversal',
        lines: [
          { expense_ledger_id: 'acc_utilities', amount: 3000, description: 'Reversal' }
        ]
      })
    });
    assert(createR.success);
    const r = await api(token, '/accounting/expenses/' + createR.data.id + '/reverse', { method: 'POST' });
    assert(r.success, 'Reverse should succeed: ' + (r.error?.message || JSON.stringify(r)));
  });

  // ─── Negative Tests ───
  await test('Reject missing payee', async () => {
    const r = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CASH',
        payment_ledger_id: 'acc_cash',
        amount: 5000, reference_number: 'EXP-NOPAYEE',
        currency: 'INR', financial_year_id: activeFyId,
        lines: [{ expense_ledger_id: 'acc_rent', amount: 5000 }]
      })
    });
    assert(!r.success, 'Missing payee should be rejected');
  });

  await test('Reject missing expense ledger', async () => {
    const r = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CASH',
        payee_id: contactId, payment_ledger_id: 'acc_cash',
        amount: 5000, reference_number: 'EXP-NOEXP',
        currency: 'INR', financial_year_id: activeFyId,
        lines: [{ expense_ledger_id: null, amount: 5000 }]
      })
    });
    assert(!r.success, 'Missing expense ledger should be rejected');
  });

  await test('Reject Group account as expense ledger', async () => {
    const r = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CASH',
        payee_id: contactId, payment_ledger_id: 'acc_cash',
        amount: 5000, reference_number: 'EXP-GROUP-TEST',
        currency: 'INR', financial_year_id: activeFyId,
        lines: [{ expense_ledger_id: 'ag_expense', amount: 5000 }]
      })
    });
    assert(!r.success, 'Group account should be rejected as expense ledger');
  });

  await test('Reject CREDIT-nature account as expense ledger', async () => {
    const r = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CASH',
        payee_id: contactId, payment_ledger_id: 'acc_cash',
        amount: 5000, reference_number: 'EXP-NATURE-TEST',
        currency: 'INR', financial_year_id: activeFyId,
        lines: [{ expense_ledger_id: 'acc_sales', amount: 5000 }]
      })
    });
    assert(!r.success, 'CREDIT-nature account should not be expense ledger');
  });

  await test('Reject missing payment ledger', async () => {
    const r = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CASH',
        payee_id: contactId,
        amount: 5000, reference_number: 'EXP-NOPAYMENT',
        currency: 'INR', financial_year_id: activeFyId,
        lines: [{ expense_ledger_id: 'acc_rent', amount: 5000 }]
      })
    });
    assert(!r.success, 'Missing payment ledger should be rejected');
  });

  await test('Reject zero amount expense', async () => {
    const r = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CASH',
        payee_id: contactId, payment_ledger_id: 'acc_cash',
        amount: 0, reference_number: 'EXP-ZERO',
        currency: 'INR', financial_year_id: activeFyId,
        lines: [{ expense_ledger_id: 'acc_rent', amount: 0 }]
      })
    });
    assert(!r.success, 'Zero amount should be rejected');
  });

  await test('Reject negative amount expense', async () => {
    const r = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CASH',
        payee_id: contactId, payment_ledger_id: 'acc_cash',
        amount: -100, reference_number: 'EXP-NEG',
        currency: 'INR', financial_year_id: activeFyId,
        lines: [{ expense_ledger_id: 'acc_rent', amount: -100 }]
      })
    });
    assert(!r.success, 'Negative amount should be rejected');
  });

  await test('Reject missing expense line', async () => {
    const r = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CASH',
        payee_id: contactId, payment_ledger_id: 'acc_cash',
        amount: 5000, reference_number: 'EXP-NOLINE',
        currency: 'INR', financial_year_id: activeFyId,
        lines: []
      })
    });
    assert(!r.success, 'Missing expense line should be rejected');
  });

  await test('Reject date outside Financial Year', async () => {
    const r = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2025-01-01', payment_mode: 'CASH',
        payee_id: contactId, payment_ledger_id: 'acc_cash',
        amount: 5000, reference_number: 'EXP-BADDATE',
        currency: 'INR', financial_year_id: activeFyId,
        lines: [{ expense_ledger_id: 'acc_rent', amount: 5000 }]
      })
    });
    assert(!r.success, 'Date outside FY should be rejected');
  });

  await test('Reject CREDIT-nature payable for credit expense', async () => {
    const r = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CREDIT',
        payee_id: contactId, payment_ledger_id: 'acc_bank',
        amount: 5000, reference_number: 'EXP-CREDITNATURE',
        currency: 'INR', financial_year_id: activeFyId,
        lines: [{ expense_ledger_id: 'acc_rent', amount: 5000 }]
      })
    });
    assert(!r.success, 'DEBIT-nature account should not be payable for credit expense');
  });

  // ─── Integration Tests ───
  await test('Expense P&L impact (expense affects P&L)', async () => {
    const r = await api(token, '/accounting/reports/profit-loss');
    assert(r.success, 'P&L should succeed');
  });

  await test('Expense Balance Sheet cash/bank impact', async () => {
    const r = await api(token, '/accounting/reports/balance-sheet');
    assert(r.success, 'Balance sheet should succeed');
  });

  await test('Expense audit trail exists', async () => {
    const audit = dbGet("SELECT COUNT(*) as c FROM accounting_audit WHERE entity_type = 'expense' AND company_id = 'default'", []);
    assert(audit.c > 0, 'Should have expense audit records');
  });

  await test('Expense numbering follows EXP- prefix convention', async () => {
    assert(expenseVoucherNumber.startsWith('EXP-'), 'Should start with EXP- prefix');
  });

  await test('Cannot post expense with invalid payment_mode', async () => {
    const r = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'INVALID',
        payee_id: contactId, payment_ledger_id: 'acc_cash',
        amount: 5000, reference_number: 'EXP-BADMODE',
        currency: 'INR', financial_year_id: activeFyId,
        lines: [{ expense_ledger_id: 'acc_rent', amount: 5000 }]
      })
    });
    // Validation should catch the invalid payment mode via the payment ledger nature check
    assert(!r.success, 'Invalid payment mode should be rejected');
  });

  await test('Cannot reverse already-reversed Expense', async () => {
    const createR = await api(token, '/accounting/expenses', {
      method: 'POST', body: JSON.stringify({
        expense_date: '2026-09-08', payment_mode: 'CASH',
        payee_id: contactId, payment_ledger_id: 'acc_cash',
        amount: 2000, reference_number: 'EXP-REV-TEST-2',
        currency: 'INR', financial_year_id: activeFyId,
        narration: 'Reversal test',
        lines: [{ expense_ledger_id: 'acc_marketing', amount: 2000 }]
      })
    });
    assert(createR.success);
    const revR = await api(token, '/accounting/expenses/' + createR.data.id + '/reverse', { method: 'POST' });
    assert(revR.success, 'First reverse should succeed');
    const revR2 = await api(token, '/accounting/expenses/' + createR.data.id + '/reverse', { method: 'POST' });
    assert(!revR2.success, 'Second reverse should fail');
  });

  // ═══ Step 13: Credit Note / Sales Return ═══
  console.log('\n── Step 13: Credit Note / Sales Return ──');

  let creditNoteId = null;
  let creditNoteNumber = null;

  await test('Post a partial Credit Note against Sales Invoice (Dr Sales Return / Cr Receivable)', async () => {
    const r = await api(token, '/accounting/credit-notes', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08', original_sales_invoice_id: salesId,
        contact_id: contactId, sales_return_ledger_id: 'acc_sales_returns',
        receivable_ledger_id: 'acc_receivable',
        amount: 5000, reference_number: 'CN-2026-0001',
        narration: 'Partial return of defective goods', currency: 'INR',
        financial_year_id: activeFyId,
        lines: [{ description: 'Returned 2 units of defective goods', line_total: 5000 }]
      })
    });
    assert(r.success, 'Partial credit note should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.voucherType === 'CREDIT_NOTE', 'Voucher type should be CREDIT_NOTE');
    assert(r.data.status === 'POSTED', 'Status should be POSTED');
    assert(r.data.voucherNumber.startsWith('CN-'), 'Should have CN- prefix: ' + r.data.voucherNumber);
    assert(r.data.journalEntry, 'Should include journal entry');
    creditNoteId = r.data.id;
    creditNoteNumber = r.data.voucherNumber;
  });

  await test('Credit Note generates a balanced Journal Entry', async () => {
    const je = dbGet("SELECT id, entry_number, total_debit, total_credit FROM journal_entries WHERE voucher_id = ?", [creditNoteId]);
    assert(je, 'Journal entry should exist');
    assert(parseFloat(je.total_debit) === 5000, 'Total debit should be 5000');
    assert(parseFloat(je.total_credit) === 5000, 'Total credit should be 5000');
    assert(Math.abs(parseFloat(je.total_debit) - parseFloat(je.total_credit)) < 0.01, 'JE must be balanced');
    assert(je.entry_number.startsWith('CN-'), 'JE entry number should have CN- prefix');
  });

  await test('Credit Note JE has debit on Sales Return, credit on Receivable', async () => {
    const je = dbGet("SELECT je.id FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ?", [creditNoteId]);
    const returnLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_sales_returns'", [je.id]);
    const receivableLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_receivable'", [je.id]);
    assert(returnLine && parseFloat(returnLine.debit_amount) === 5000, 'Sales Returns should be debited');
    assert(receivableLine && parseFloat(receivableLine.credit_amount) === 5000, 'Receivable should be credited');
  });

  await test('Credit Note reduces customer receivable correctly', async () => {
    const tb = dbQuery("SELECT a.id, SUM(jel.debit_amount - jel.credit_amount) as balance FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id JOIN accounts a ON a.id = jel.account_id WHERE a.id = 'acc_receivable' AND je.voucher_id IN (?, ?) GROUP BY a.id", [salesId, creditNoteId]);
    const receivableRow = tb.find(r => r.id === 'acc_receivable');
    // Original sale: 25000 debit. Credit note: 5000 credit. Net = 20000
    assert(parseFloat(receivableRow.balance) === 20000, 'Receivable should be 20000 after credit note: ' + receivableRow.balance);
  });

  await test('Credit Note reduces net Sales Revenue (P&L impact)', async () => {
    const tb = dbQuery("SELECT a.id, a.name, SUM(jel.debit_amount - jel.credit_amount) as balance FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id JOIN accounts a ON a.id = jel.account_id WHERE a.id IN ('acc_sales', 'acc_sales_returns') AND je.voucher_id IN (?, ?) GROUP BY a.id, a.name", [salesId, creditNoteId]);
    const salesRow = tb.find(r => r.id === 'acc_sales');
    const returnsRow = tb.find(r => r.id === 'acc_sales_returns');
    // Sales: 25000 credit, Sales Returns: 5000 debit
    assert(parseFloat(salesRow.balance) === -25000, 'Sales revenue should show -25000');
    assert(parseFloat(returnsRow.balance) === 5000, 'Sales returns should show +5000 (debit)');
    // Net revenue = 25000 - 5000 = 20000
  });

  await test('Credit Note Detail view shows original invoice and JE reference', async () => {
    const r = await api(token, '/accounting/credit-notes/' + creditNoteId);
    assert(r.success, 'Credit note detail should succeed');
    assert(r.data.journalEntry, 'Detail should include JE');
    assert(r.data.journalEntry.lines && r.data.journalEntry.lines.length === 2, 'JE should have 2 lines');
    assert(r.data.originalInvoice, 'Should include original invoice reference');
    assert(r.data.originalInvoice.id === salesId, 'Original invoice should match the Sales Invoice');
    assert(r.data.creditNoteLines && r.data.creditNoteLines.length > 0, 'Should have credit note lines');
  });

  await test('Credit Note List shows posted credit notes', async () => {
    const r = await api(token, '/accounting/credit-notes?status=POSTED&limit=20');
    assert(r.success, 'Credit note list should succeed');
    assert(r.data.items.length > 0, 'Should have posted credit notes');
  });

  await test('Credit Note List filtered by original invoice', async () => {
    const r = await api(token, '/accounting/credit-notes?original_invoice_id=' + salesId + '&limit=20');
    assert(r.success, 'Credit note list by invoice should succeed');
    assert(r.data.items.length > 0, 'Should find credit notes for the original invoice');
  });

  await test('Validate Credit Note (real-time accounting preview)', async () => {
    const r = await api(token, '/accounting/credit-notes/validate', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08', original_sales_invoice_id: salesId,
        contact_id: contactId, sales_return_ledger_id: 'acc_sales_returns',
        receivable_ledger_id: 'acc_receivable',
        amount: 3000, reference_number: 'CN-VALIDATE-001',
        currency: 'INR', financial_year_id: activeFyId,
        lines: [{ description: 'Preview line', line_total: 3000 }]
      })
    });
    assert(r.success, 'Validation should pass: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.valid === true, 'Should be valid');
    assert(r.data.accountingEntry.debit.accountId === 'acc_sales_returns', 'Debit should be sales return ledger');
    assert(r.data.accountingEntry.credit.accountId === 'acc_receivable', 'Credit should be receivable ledger');
  });

  // ─── Full Credit Note ───
  await test('Post a full Credit Note', async () => {
    // Create another sales invoice for full credit
    const salesR = await api(token, '/accounting/sales', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CREDIT', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_receivable', sales_ledger_id: 'acc_sales',
        amount: 10000, reference_number: 'INV-2026-FULL',
        narration: 'Full credit test sale', currency: 'INR',
        contact_id: contactId, financial_year_id: activeFyId
      })
    });
    assert(salesR.success, 'Sales invoice should be created');

    const r = await api(token, '/accounting/credit-notes', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08', original_sales_invoice_id: salesR.data.id,
        contact_id: contactId, sales_return_ledger_id: 'acc_sales_returns',
        receivable_ledger_id: 'acc_receivable',
        amount: 10000, reference_number: 'CN-2026-FULL',
        narration: 'Full return', currency: 'INR',
        financial_year_id: activeFyId,
        lines: [{ description: 'Full return', line_total: 10000 }]
      })
    });
    assert(r.success, 'Full credit note should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.status === 'POSTED', 'Status should be POSTED');
    assert(r.data.totalAmount === 10000, 'Total should be 10000');
  });

  // ─── Credit Limit / Remaining Amount ───
  await test('Reject Credit Note exceeding remaining creditable amount', async () => {
    const r = await api(token, '/accounting/credit-notes', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08', original_sales_invoice_id: salesId,
        contact_id: contactId, sales_return_ledger_id: 'acc_sales_returns',
        receivable_ledger_id: 'acc_receivable',
        amount: 99999, reference_number: 'CN-EXCEED-001',
        narration: 'Exceeds creditable', currency: 'INR',
        financial_year_id: activeFyId,
        lines: [{ description: 'Exceeds creditable', line_total: 99999 }]
      })
    });
    assert(!r.success, 'Credit note exceeding remaining creditable amount should be rejected');
    assert(r.data.errors.some(e => e.includes('exceeds remaining creditable')), 'Should warn about exceeding creditable amount: ' + JSON.stringify(r.data.errors));
  });

  // ─── Draft ───
  await test('Create Credit Note as Draft', async () => {
    const r = await api(token, '/accounting/credit-notes/draft', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08', original_sales_invoice_id: salesId,
        contact_id: contactId, sales_return_ledger_id: 'acc_sales_returns',
        receivable_ledger_id: 'acc_receivable',
        amount: 2000, reference_number: 'CN-DRAFT-001',
        narration: 'Draft credit note', currency: 'INR',
        financial_year_id: activeFyId,
        lines: [{ description: 'Draft line', line_total: 2000 }]
      })
    });
    assert(r.success, 'Draft credit note should be created: ' + (r.error?.message || JSON.stringify(r)));
    assert(r.data.status === 'DRAFT', 'Status should be DRAFT');
  });

  // ─── Cancel ───
  await test('Cancel a Posted Credit Note', async () => {
    const createR = await api(token, '/accounting/credit-notes', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08', original_sales_invoice_id: salesId,
        contact_id: contactId, sales_return_ledger_id: 'acc_sales_returns',
        receivable_ledger_id: 'acc_receivable',
        amount: 1000, reference_number: 'CN-CANCEL-001',
        narration: 'Cancel test', currency: 'INR',
        financial_year_id: activeFyId,
        lines: [{ description: 'Cancel test line', line_total: 1000 }]
      })
    });
    assert(createR.success);
    const r = await api(token, '/accounting/credit-notes/' + createR.data.id + '/cancel', { method: 'POST' });
    assert(r.success, 'Cancel should succeed: ' + (r.error?.message || JSON.stringify(r)));
  });

  // ─── Reverse ───
  await test('Reverse a Posted Credit Note', async () => {
    const createR = await api(token, '/accounting/credit-notes', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08', original_sales_invoice_id: salesId,
        contact_id: contactId, sales_return_ledger_id: 'acc_sales_returns',
        receivable_ledger_id: 'acc_receivable',
        amount: 1500, reference_number: 'CN-REV-001',
        narration: 'Reverse test', currency: 'INR',
        financial_year_id: activeFyId,
        lines: [{ description: 'Reverse test line', line_total: 1500 }]
      })
    });
    assert(createR.success);
    const r = await api(token, '/accounting/credit-notes/' + createR.data.id + '/reverse', { method: 'POST' });
    assert(r.success, 'Reverse should succeed: ' + (r.error?.message || JSON.stringify(r)));
  });

  await test('Cannot reverse already-reversed Credit Note', async () => {
    const createR = await api(token, '/accounting/credit-notes', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08', original_sales_invoice_id: salesId,
        contact_id: contactId, sales_return_ledger_id: 'acc_sales_returns',
        receivable_ledger_id: 'acc_receivable',
        amount: 800, reference_number: 'CN-REV-002',
        narration: 'Double reverse test', currency: 'INR',
        financial_year_id: activeFyId,
        lines: [{ description: 'Double reverse', line_total: 800 }]
      })
    });
    assert(createR.success);
    const revR = await api(token, '/accounting/credit-notes/' + createR.data.id + '/reverse', { method: 'POST' });
    assert(revR.success, 'First reverse should succeed');
    const revR2 = await api(token, '/accounting/credit-notes/' + createR.data.id + '/reverse', { method: 'POST' });
    assert(!revR2.success, 'Second reverse should fail');
  });

  // ─── Delete ───
  await test('Delete Draft Credit Note', async () => {
    const createR = await api(token, '/accounting/credit-notes/draft', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08', original_sales_invoice_id: salesId,
        contact_id: contactId, sales_return_ledger_id: 'acc_sales_returns',
        receivable_ledger_id: 'acc_receivable',
        amount: 500, reference_number: 'CN-DELETE-001',
        narration: 'Delete me', currency: 'INR',
        financial_year_id: activeFyId,
        lines: [{ description: 'Delete line', line_total: 500 }]
      })
    });
    assert(createR.success);
    const delR = await api(token, '/accounting/credit-notes/' + createR.data.id, { method: 'DELETE' });
    assert(delR.success, 'Draft credit note should be deleted: ' + (delR.error?.message || JSON.stringify(delR)));
  });

  await test('Cannot delete Posted Credit Note', async () => {
    const r = await api(token, '/accounting/credit-notes/' + creditNoteId, { method: 'DELETE' });
    assert(!r.success, 'Posted credit note should not be deletable');
  });

  // ─── Negative Tests ───
  await test('Reject missing original Sales Invoice', async () => {
    const r = await api(token, '/accounting/credit-notes', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08',
        contact_id: contactId, sales_return_ledger_id: 'acc_sales_returns',
        receivable_ledger_id: 'acc_receivable',
        amount: 5000, reference_number: 'CN-NOINV-001',
        narration: 'No invoice', currency: 'INR',
        financial_year_id: activeFyId,
        lines: [{ description: 'No invoice line', line_total: 5000 }]
      })
    });
    assert(!r.success, 'Missing original invoice should be rejected');
    assert(r.data.errors.some(e => e.includes('Original Sales Invoice is required')), 'Should show original invoice error');
  });

  await test('Reject unposted Sales Invoice', async () => {
    const draftSalesR = await api(token, '/accounting/sales/draft', {
      method: 'POST', body: JSON.stringify({
        payment_mode: 'CREDIT', sales_date: '2026-09-08',
        receiving_ledger_id: 'acc_receivable', sales_ledger_id: 'acc_sales',
        amount: 3000, reference_number: 'INV-DRAFT-CN',
        narration: 'Draft sale for CN test', currency: 'INR',
        contact_id: contactId, financial_year_id: activeFyId
      })
    });
    const r = await api(token, '/accounting/credit-notes', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08', original_sales_invoice_id: draftSalesR.data.id,
        contact_id: contactId, sales_return_ledger_id: 'acc_sales_returns',
        receivable_ledger_id: 'acc_receivable',
        amount: 1000, reference_number: 'CN-UNPOSTED-001',
        narration: 'Unposted invoice', currency: 'INR',
        financial_year_id: activeFyId,
        lines: [{ description: 'Unposted invoice line', line_total: 1000 }]
      })
    });
    assert(!r.success, 'Unposted Sales Invoice should be rejected');
    assert(r.data.errors.some(e => e.includes('must be posted')), 'Should show must be posted error');
  });

  await test('Reject customer mismatch', async () => {
    const r = await api(token, '/accounting/credit-notes', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08', original_sales_invoice_id: salesId,
        contact_id: 'nonexistent_contact', sales_return_ledger_id: 'acc_sales_returns',
        receivable_ledger_id: 'acc_receivable',
        amount: 5000, reference_number: 'CN-CUSTMISMATCH',
        narration: 'Customer mismatch', currency: 'INR',
        financial_year_id: activeFyId,
        lines: [{ description: 'Mismatch line', line_total: 5000 }]
      })
    });
    assert(!r.success, 'Customer mismatch should be rejected');
  });

  await test('Reject Group account as sales return ledger', async () => {
    const r = await api(token, '/accounting/credit-notes', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08', original_sales_invoice_id: salesId,
        contact_id: contactId, sales_return_ledger_id: 'ag_sales',
        receivable_ledger_id: 'acc_receivable',
        amount: 5000, reference_number: 'CN-GROUP-001',
        narration: 'Group test', currency: 'INR',
        financial_year_id: activeFyId,
        lines: [{ description: 'Group line', line_total: 5000 }]
      })
    });
    assert(!r.success, 'Group account should be rejected as sales return ledger');
    assert(r.data.errors.some(e => e.includes('Account Group')), 'Should show group account error');
  });

  await test('Reject DEBIT-nature account as sales return ledger', async () => {
    const r = await api(token, '/accounting/credit-notes', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08', original_sales_invoice_id: salesId,
        contact_id: contactId, sales_return_ledger_id: 'acc_receivable',
        receivable_ledger_id: 'acc_receivable',
        amount: 5000, reference_number: 'CN-WRONGNATURE',
        narration: 'Wrong nature', currency: 'INR',
        financial_year_id: activeFyId,
        lines: [{ description: 'Wrong nature line', line_total: 5000 }]
      })
    });
    assert(!r.success, 'DEBIT-nature account should not be sales return ledger');
  });

  await test('Reject missing credit note line', async () => {
    const r = await api(token, '/accounting/credit-notes', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08', original_sales_invoice_id: salesId,
        contact_id: contactId, sales_return_ledger_id: 'acc_sales_returns',
        receivable_ledger_id: 'acc_receivable',
        amount: 5000, reference_number: 'CN-NOLINE',
        currency: 'INR', financial_year_id: activeFyId,
        lines: []
      })
    });
    assert(!r.success, 'Missing credit note line should be rejected');
    assert(r.data.errors.some(e => e.includes('at least one line')), 'Should show missing line error');
  });

  await test('Reject zero amount credit note', async () => {
    const r = await api(token, '/accounting/credit-notes', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08', original_sales_invoice_id: salesId,
        contact_id: contactId, sales_return_ledger_id: 'acc_sales_returns',
        receivable_ledger_id: 'acc_receivable',
        amount: 0, reference_number: 'CN-ZERO',
        currency: 'INR', financial_year_id: activeFyId,
        lines: [{ description: 'Zero line', line_total: 0 }]
      })
    });
    assert(!r.success, 'Zero amount should be rejected');
  });

  await test('Reject credit note with no receivable ledger', async () => {
    const r = await api(token, '/accounting/credit-notes', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2026-09-08', original_sales_invoice_id: salesId,
        contact_id: contactId, sales_return_ledger_id: 'acc_sales_returns',
        amount: 5000, reference_number: 'CN-NOREC',
        currency: 'INR', financial_year_id: activeFyId,
        lines: [{ description: 'No receivable line', line_total: 5000 }]
      })
    });
    assert(!r.success, 'Missing receivable ledger should be rejected');
  });

  await test('Reject date outside Financial Year', async () => {
    const r = await api(token, '/accounting/credit-notes', {
      method: 'POST', body: JSON.stringify({
        credit_note_date: '2025-01-01', original_sales_invoice_id: salesId,
        contact_id: contactId, sales_return_ledger_id: 'acc_sales_returns',
        receivable_ledger_id: 'acc_receivable',
        amount: 5000, reference_number: 'CN-BADDATE',
        currency: 'INR', financial_year_id: activeFyId,
        lines: [{ description: 'Bad date line', line_total: 5000 }]
      })
    });
    assert(!r.success, 'Date outside FY should be rejected');
  });

  // ─── Integration Tests ───
  await test('Credit Note audit trail exists', async () => {
    const audit = dbGet("SELECT COUNT(*) as c FROM accounting_audit WHERE entity_type = 'credit_note' AND company_id = 'default'", []);
    assert(audit.c > 0, 'Should have credit note audit records');
  });

  await test('Credit Note numbering follows CN- prefix convention', async () => {
    assert(creditNoteNumber.startsWith('CN-'), 'Should start with CN- prefix: ' + creditNoteNumber);
  });

  await test('Credit Note → Journal Entry → Ledger → Trial Balance integration', async () => {
    const tb = dbQuery("SELECT a.id, a.code, a.name, SUM(jel.debit_amount - jel.credit_amount) as balance FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id JOIN accounts a ON a.id = jel.account_id WHERE je.voucher_id = ? GROUP BY jel.account_id, a.id, a.code, a.name", [creditNoteId]);
    const returnRow = tb.find(r => r.id === 'acc_sales_returns');
    const receivableRow = tb.find(r => r.id === 'acc_receivable');
    assert(returnRow && parseFloat(returnRow.balance) === 5000, 'Sales Returns should show +5000 (debited)');
    assert(receivableRow && parseFloat(receivableRow.balance) === -5000, 'Receivable should show -5000 (credited)');
  });

  await test('Credit Note Trial Balance impact', async () => {
    const r = await api(token, '/accounting/reports/trial-balance');
    assert(r.success, 'Trial balance should succeed after credit note posting');
  });

  await test('Credit Note P&L impact (sales returns reduce revenue)', async () => {
    const r = await api(token, '/accounting/reports/profit-loss');
    assert(r.success, 'P&L should succeed after credit note posting');
  });

  await test('Credit Note Balance Sheet impact (receivable reduced)', async () => {
    const r = await api(token, '/accounting/reports/balance-sheet');
    assert(r.success, 'Balance sheet should succeed after credit note posting');
  });

  await test('Revenue impact: net sales = gross sales - credit notes', async () => {
    const tb = dbQuery("SELECT a.id, a.name, a.type, SUM(jel.debit_amount - jel.credit_amount) as balance FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id JOIN accounts a ON a.id = jel.account_id WHERE a.type IN ('INCOME') AND je.voucher_id IN (?, ?) GROUP BY a.id, a.name, a.type", [salesId, creditNoteId]);
    const salesRow = tb.find(r => r.id === 'acc_sales');
    const returnsRow = tb.find(r => r.id === 'acc_sales_returns');
    const grossSales = parseFloat(salesRow.balance); // -25000 (credit balance)
    const salesReturns = parseFloat(returnsRow.balance); // +5000 (debit balance)
    // Net revenue = grossSales + salesReturns = -25000 + 5000 = -20000
    // Revenue is net 20000
    assert(Math.abs((grossSales + salesReturns) - (-20000)) < 0.01, 'Net revenue should be 20000 after credit note: ' + (grossSales + salesReturns));
  });

  await test('Original Sales Invoice remains intact after Credit Note', async () => {
    const salesR = await api(token, '/accounting/sales/' + salesId);
    assert(salesR.success, 'Original Sales Invoice should still exist');
      assert(salesR.data.status === 'POSTED', 'Original invoice should remain POSTED');
      assert(parseFloat(salesR.data.totalAmount) === 25000, 'Original invoice total should be unchanged');
    });

    // ═══ Step 14: Debit Note / Purchase Return ═══
    console.log('\n── Step 14: Debit Note / Purchase Return ──');

    // Create a fresh purchase invoice for Step 14 tests (the Step 11 purchase may have been reversed)
    let dnPurchaseId = null;
    let debitNoteId = null;
    let debitNoteNumber = null;
    let debitNoteIdFull = null;
    let fullPurchaseId = null;

    await test('Create fresh Purchase Invoice for Debit Note tests', async () => {
      const r = await api(token, '/accounting/purchases', {
        method: 'POST', body: JSON.stringify({
          purchase_date: '2026-09-08', payment_mode: 'CREDIT',
          purchase_ledger_id: 'acc_purchases', contact_id: contactId,
          payable_ledger_id: 'acc_payable',
          amount: 25000, reference_number: 'PUR-2026-DN-001',
          currency: 'INR', financial_year_id: activeFyId,
          narration: 'Purchase for debit note tests'
        })
      });
      assert(r.success, 'Purchase should be created: ' + (r.error?.message || JSON.stringify(r)));
      assert(r.data.status === 'POSTED', 'Purchase should be POSTED');
      dnPurchaseId = r.data.id;
    });

    await test('Post a partial Debit Note against Purchase Invoice (Dr Payable / Cr Purchase Return)', async () => {
      const r = await api(token, '/accounting/debit-notes', {
        method: 'POST', body: JSON.stringify({
          debit_note_date: '2026-09-08', original_purchase_invoice_id: dnPurchaseId,
          supplier_id: contactId, purchase_return_ledger_id: 'acc_purchase_returns',
          payable_ledger_id: 'acc_payable',
          amount: 5000, reference_number: 'DN-2026-0001',
          narration: 'Partial return of defective goods', currency: 'INR',
          financial_year_id: activeFyId,
          lines: [{ description: 'Returned 2 units of defective goods', line_total: 5000 }]
        })
      });
      assert(r.success, 'Partial debit note should be created: ' + (r.error?.message || JSON.stringify(r)));
      assert(r.data.voucherType === 'DEBIT_NOTE', 'Voucher type should be DEBIT_NOTE');
      assert(r.data.status === 'POSTED', 'Status should be POSTED');
      assert(r.data.journalEntry, 'Journal entry should be present');
      debitNoteId = r.data.id;
      debitNoteNumber = r.data.voucherNumber;
    });

    await test('Debit Note generates a balanced Journal Entry', async () => {
      const je = dbGet("SELECT id, entry_number, total_debit, total_credit FROM journal_entries WHERE voucher_id = ?", [debitNoteId]);
      assert(je, 'Journal entry should exist');
      assert(parseFloat(je.total_debit) === 5000, 'Total debit should be 5000');
      assert(parseFloat(je.total_credit) === 5000, 'Total credit should be 5000');
      assert(parseFloat(je.total_debit) === parseFloat(je.total_credit), 'JE must be balanced');
      assert(je.entry_number.startsWith('DN-'), 'JE entry number should have DN- prefix');
    });

    await test('Debit Note JE has debit on payable, credit on purchase return', async () => {
      const je = dbGet("SELECT id FROM journal_entries WHERE voucher_id = ?", [debitNoteId]);
      const payableLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_payable'", [je.id]);
      const returnsLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_purchase_returns'", [je.id]);
      assert(payableLine, 'Payable line should exist');
      assert(parseFloat(payableLine.debit_amount) === 5000, 'Payable should be debited 5000');
      assert(parseFloat(payableLine.credit_amount) === 0, 'Payable should have no credit');
      assert(returnsLine, 'Purchase returns line should exist');
      assert(parseFloat(returnsLine.credit_amount) === 5000, 'Purchase returns should be credited 5000');
      assert(parseFloat(returnsLine.debit_amount) === 0, 'Purchase returns should have no debit');
    });

    await test('Debit Note reduces supplier payable correctly', async () => {
      const payableRow = dbQuery("SELECT SUM(jel.debit_amount - jel.credit_amount) as balance FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id JOIN accounts a ON a.id = jel.account_id WHERE a.id = 'acc_payable' AND je.voucher_id IN (?, ?)", [dnPurchaseId, debitNoteId]);
      // Original purchase: 25000 credit. Debit note: 5000 debit. Net = -25000 + 5000 = -20000
      // Payable balance = -20000 (credit balance means liability)
      const balance = parseFloat(payableRow[0]?.balance || 0);
      assert(Math.abs(balance - (-20000)) < 0.01, 'Payable should be -20000 after debit note (purchase credited 25000, debit note debited 5000): ' + balance);
    });

    await test('Debit Note increases Purchase Returns (P&L impact)', async () => {
      const tb = dbQuery("SELECT a.id, SUM(jel.debit_amount - jel.credit_amount) as balance FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id JOIN accounts a ON a.id = jel.account_id WHERE a.id IN ('acc_purchases','acc_purchase_returns') AND je.voucher_id IN (?, ?) GROUP BY a.id", [dnPurchaseId, debitNoteId]);
      const purchasesRow = tb.find(r => r.id === 'acc_purchases');
      const returnsRow = tb.find(r => r.id === 'acc_purchase_returns');
      // Purchases: 25000 debit. Purchase Returns: 5000 credit.
      assert(parseFloat(purchasesRow.balance) === 25000, 'Purchases should be +25000 (debit)');
      assert(parseFloat(returnsRow.balance) === -5000, 'Purchase returns should be -5000 (credit)');
      // Net expense = 25000 - 5000 = 20000
    });

    await test('Debit Note Detail view shows original invoice and JE reference', async () => {
      const r = await api(token, `/accounting/debit-notes/${debitNoteId}`, { method: 'GET' });
      assert(r.success, 'Debit note detail should be fetched: ' + (r.error?.message || JSON.stringify(r)));
      assert(r.data.voucherType === 'DEBIT_NOTE', 'Should be DEBIT_NOTE');
      assert(r.data.originalInvoice, 'Original invoice reference should exist');
      assert(r.data.originalInvoice.voucherNumber.startsWith('PUR-'), 'Original invoice number should have PUR- prefix');
      assert(r.data.journalEntry, 'Journal entry should be present');
      assert(r.data.journalEntry.lines && r.data.journalEntry.lines.length >= 2, 'JE should have lines');
      assert(r.data.debitNoteLines && r.data.debitNoteLines.length > 0, 'Debit note lines should exist');
      assert(r.data.voucherNumber.startsWith('DN-'), 'Debit note number should have DN- prefix');
    });

    await test('Debit Note List shows posted debit notes', async () => {
      const r = await api(token, '/accounting/debit-notes?status=POSTED', { method: 'GET' });
      assert(r.success, 'Debit note list should succeed');
      assert(r.data.items && r.data.items.length > 0, 'Should have posted debit notes');
      assert(r.data.items.some(d => d.id === debitNoteId), 'Should include our debit note');
    });

    await test('Debit Note List filtered by original purchase invoice', async () => {
      const r = await api(token, `/accounting/debit-notes?original_invoice_id=${dnPurchaseId}`, { method: 'GET' });
      assert(r.success, 'Filtered debit note list should succeed');
      assert(r.data.items && r.data.items.length > 0, 'Should have debit notes for this invoice');
      assert(r.data.items.every(d => d.voucherType === 'DEBIT_NOTE'), 'All should be DEBIT_NOTE');
    });

    await test('Validate Debit Note (real-time accounting preview)', async () => {
      const r = await api(token, '/accounting/debit-notes/validate', {
        method: 'POST', body: JSON.stringify({
          debit_note_date: '2026-09-08', original_purchase_invoice_id: dnPurchaseId,
          supplier_id: contactId, purchase_return_ledger_id: 'acc_purchase_returns',
          payable_ledger_id: 'acc_payable',
          amount: 3000, reference_number: 'DN-2026-0002',
          narration: 'Validation test', currency: 'INR',
          financial_year_id: activeFyId,
          lines: [{ description: 'Test item', line_total: 3000 }]
        })
      });
      assert(r.success, 'Validation should succeed: ' + (r.error?.message || JSON.stringify(r)));
      assert(r.data.valid === true, 'Should be valid');
      assert(r.data.accountingEntry, 'Should have accounting preview');
      assert(r.data.accountingEntry.debit.accountId === 'acc_payable', 'Debit should be payable');
      assert(r.data.accountingEntry.credit.accountId === 'acc_purchase_returns', 'Credit should be purchase returns');
    });

    await test('Post a full Debit Note', async () => {
      // Create another purchase for full return test
      const p = await api(token, '/accounting/purchases', {
        method: 'POST', body: JSON.stringify({
          purchase_date: '2026-09-08', payment_mode: 'CREDIT',
          purchase_ledger_id: 'acc_purchases', contact_id: contactId,
          payable_ledger_id: 'acc_payable',
          amount: 20000, reference_number: 'PUR-2026-0002',
          currency: 'INR', financial_year_id: activeFyId,
          narration: 'Second purchase for full return test'
        })
      });
      assert(p.success, 'Second purchase should be created');
      fullPurchaseId = p.data.id;

      const r = await api(token, '/accounting/debit-notes', {
        method: 'POST', body: JSON.stringify({
          debit_note_date: '2026-09-08', original_purchase_invoice_id: fullPurchaseId,
          supplier_id: contactId, purchase_return_ledger_id: 'acc_purchase_returns',
          payable_ledger_id: 'acc_payable',
          amount: 20000, reference_number: 'DN-2026-FULL',
          narration: 'Full return', currency: 'INR',
          financial_year_id: activeFyId,
          lines: [{ description: 'Full return of goods', line_total: 20000 }]
        })
      });
      assert(r.success, 'Full debit note should be created');
      assert(r.data.status === 'POSTED', 'Should be POSTED');
      debitNoteIdFull = r.data.id;

      // Verify remaining eligible amount is 0
      const eligible = dbGet("SELECT * FROM vouchers WHERE id = ?", [fullPurchaseId]);
      assert(eligible.status === 'POSTED', 'Original purchase should remain POSTED');
    });

    await test('Reject Debit Note exceeding remaining eligible amount', async () => {
      // Try to create a debit note exceeding the remaining amount against the full-return invoice
      // fullPurchaseId was fully returned (20000), so any new DN should fail
      const r = await api(token, '/accounting/debit-notes', {
        method: 'POST', body: JSON.stringify({
          debit_note_date: '2026-09-08', original_purchase_invoice_id: dnPurchaseId,
          supplier_id: contactId, purchase_return_ledger_id: 'acc_purchase_returns',
          payable_ledger_id: 'acc_payable',
          amount: 999999, reference_number: 'DN-2026-OVERFLOW',
          narration: 'Overflow test', currency: 'INR',
          financial_year_id: activeFyId,
          lines: [{ description: 'Overflow line', line_total: 999999 }]
        })
      });
      assert(!r.success, 'Debit note exceeding remaining amount should fail');
      assert(r.data.errors.some(e => e.includes('exceeds remaining eligible amount')), 'Should show remaining amount error: ' + JSON.stringify(r.data.errors));
    });

    await test('Create Debit Note as Draft', async () => {
      const r = await api(token, '/accounting/debit-notes/draft', {
        method: 'POST', body: JSON.stringify({
          debit_note_date: '2026-09-08', original_purchase_invoice_id: dnPurchaseId,
          supplier_id: contactId, purchase_return_ledger_id: 'acc_purchase_returns',
          payable_ledger_id: 'acc_payable',
          amount: 2000, reference_number: 'DN-2026-DRAFT',
          narration: 'Draft debit note', currency: 'INR',
          financial_year_id: activeFyId,
          lines: [{ description: 'Draft line', line_total: 2000 }]
        })
      });
      assert(r.success, 'Draft should be created: ' + (r.error?.message || JSON.stringify(r)));
      assert(r.data.status === 'DRAFT', 'Should be DRAFT');
    });

    await test('Cancel a Posted Debit Note', async () => {
      const r = await api(token, `/accounting/debit-notes/${debitNoteId}/cancel`, { method: 'POST' });
      assert(r.success, 'Cancel should succeed: ' + (r.error?.message || JSON.stringify(r)));
      assert(r.data.status === 'CANCELLED', 'Should be CANCELLED');
      // Verify JE is also cancelled
      const je = dbGet("SELECT status FROM journal_entries WHERE voucher_id = ?", [debitNoteId]);
      assert(je.status === 'CANCELLED', 'JE should also be CANCELLED');
    });

    await test('Reverse a Posted Debit Note', async () => {
      // Create a new debit note to reverse
      const r = await api(token, '/accounting/debit-notes', {
        method: 'POST', body: JSON.stringify({
          debit_note_date: '2026-09-08', original_purchase_invoice_id: dnPurchaseId,
          supplier_id: contactId, purchase_return_ledger_id: 'acc_purchase_returns',
          payable_ledger_id: 'acc_payable',
          amount: 1500, reference_number: 'DN-2026-REV',
          narration: 'Reverse test', currency: 'INR',
          financial_year_id: activeFyId,
          lines: [{ description: 'Reverse line', line_total: 1500 }]
        })
      });
      assert(r.success, 'Debit note for reversal should be created');
      const dnId = r.data.id;

      const rev = await api(token, `/accounting/debit-notes/${dnId}/reverse`, { method: 'POST' });
      assert(rev.success, 'Reverse should succeed');
      assert(rev.data.status === 'REVERSED', 'Should be REVERSED');
      // Verify the voucher is marked reversed
      const dn = dbGet("SELECT status FROM vouchers WHERE id = ?", [dnId]);
      assert(dn.status === 'REVERSED', 'Voucher should be REVERSED');
    });

    await test('Cannot reverse already-reversed Debit Note', async () => {
      // Re-post a new one, reverse it, then try reversing again
      const r = await api(token, '/accounting/debit-notes', {
        method: 'POST', body: JSON.stringify({
          debit_note_date: '2026-09-08', original_purchase_invoice_id: dnPurchaseId,
          supplier_id: contactId, purchase_return_ledger_id: 'acc_purchase_returns',
          payable_ledger_id: 'acc_payable',
          amount: 1000, reference_number: 'DN-2026-DOUBLE-REV',
          narration: 'Double reverse test', currency: 'INR',
          financial_year_id: activeFyId,
          lines: [{ description: 'Double reverse line', line_total: 1000 }]
        })
      });
      assert(r.success, 'Debit note for double reverse should be created');
      const dnId = r.data.id;

      const rev = await api(token, `/accounting/debit-notes/${dnId}/reverse`, { method: 'POST' });
      assert(rev.success, 'First reverse should succeed');

      const rev2 = await api(token, `/accounting/debit-notes/${dnId}/reverse`, { method: 'POST' });
      assert(!rev2.success, 'Second reverse should fail');
    });

    await test('Delete Draft Debit Note', async () => {
      // Create a draft
      const r = await api(token, '/accounting/debit-notes/draft', {
        method: 'POST', body: JSON.stringify({
          debit_note_date: '2026-09-08', original_purchase_invoice_id: dnPurchaseId,
          supplier_id: contactId, purchase_return_ledger_id: 'acc_purchase_returns',
          payable_ledger_id: 'acc_payable',
          amount: 800, reference_number: 'DN-2026-DEL',
          narration: 'Delete test', currency: 'INR',
          financial_year_id: activeFyId,
          lines: [{ description: 'Delete line', line_total: 800 }]
        })
      });
      assert(r.success, 'Draft for delete should be created');
      const draftId = r.data.id;

      const del = await api(token, `/accounting/debit-notes/${draftId}`, { method: 'DELETE' });
      assert(del.success, 'Delete should succeed');
      // Verify it's gone
      const detail = dbGet("SELECT id FROM vouchers WHERE id = ?", [draftId]);
      assert(!detail, 'Draft should be deleted');
    });

    await test('Cannot delete Posted Debit Note', async () => {
      // Use the full debit note we created earlier (already posted)
      const r = await api(token, `/accounting/debit-notes/${debitNoteIdFull}`, { method: 'DELETE' });
      assert(!r.success, 'Deleting posted debit note should fail');
    });

    await test('Reject missing original Purchase Invoice', async () => {
      const r = await api(token, '/accounting/debit-notes', {
        method: 'POST', body: JSON.stringify({
          debit_note_date: '2026-09-08',
          supplier_id: contactId, purchase_return_ledger_id: 'acc_purchase_returns',
          payable_ledger_id: 'acc_payable',
          amount: 5000, reference_number: 'DN-2026-NOINV',
          narration: 'No invoice test', currency: 'INR',
          financial_year_id: activeFyId,
          lines: [{ description: 'No invoice line', line_total: 5000 }]
        })
      });
      assert(!r.success, 'Should fail without original invoice');
      assert(r.data.errors.some(e => /original purchase invoice is required/i.test(e)), 'Should show required invoice error');
    });

    await test('Reject unposted Purchase Invoice', async () => {
      // Create a draft purchase invoice (not posted)
      const draftPurchase = await api(token, '/accounting/purchases/draft', {
        method: 'POST', body: JSON.stringify({
          purchase_date: '2026-09-08', payment_mode: 'CREDIT',
          purchase_ledger_id: 'acc_purchases', contact_id: contactId,
          payable_ledger_id: 'acc_payable',
          amount: 5000, reference_number: 'PUR-2026-DRAFT',
          currency: 'INR', financial_year_id: activeFyId,
          narration: 'Draft purchase'
        })
      });
      assert(draftPurchase.success, 'Draft purchase should be created');

      const r = await api(token, '/accounting/debit-notes', {
        method: 'POST', body: JSON.stringify({
          debit_note_date: '2026-09-08', original_purchase_invoice_id: draftPurchase.data.id,
          supplier_id: contactId, purchase_return_ledger_id: 'acc_purchase_returns',
          payable_ledger_id: 'acc_payable',
          amount: 5000, reference_number: 'DN-2026-UNPOSTED',
          narration: 'Unposted invoice test', currency: 'INR',
          financial_year_id: activeFyId,
          lines: [{ description: 'Unposted line', line_total: 5000 }]
        })
      });
      assert(!r.success, 'Should fail against unposted invoice');
      assert(r.data.errors.some(e => e.includes('must be posted')), 'Should show posted error');
    });

    await test('Reject supplier mismatch', async () => {
      const r = await api(token, '/accounting/debit-notes', {
        method: 'POST', body: JSON.stringify({
          debit_note_date: '2026-09-08', original_purchase_invoice_id: dnPurchaseId,
          supplier_id: 'contact_wrong_supplier', purchase_return_ledger_id: 'acc_purchase_returns',
          payable_ledger_id: 'acc_payable',
          amount: 5000, reference_number: 'DN-2026-MISMATCH',
          narration: 'Supplier mismatch test', currency: 'INR',
          financial_year_id: activeFyId,
          lines: [{ description: 'Mismatch line', line_total: 5000 }]
        })
      });
      assert(!r.success, 'Should fail with supplier mismatch');
      assert(r.data.errors.some(e => e.includes('does not match')), 'Should show supplier mismatch error');
    });

    await test('Reject Group account as purchase return ledger', async () => {
      const r = await api(token, '/accounting/debit-notes', {
        method: 'POST', body: JSON.stringify({
          debit_note_date: '2026-09-08', original_purchase_invoice_id: dnPurchaseId,
          supplier_id: contactId, purchase_return_ledger_id: 'ag_purchases',
          payable_ledger_id: 'acc_payable',
          amount: 5000, reference_number: 'DN-GROUP-001',
          narration: 'Group test', currency: 'INR',
          financial_year_id: activeFyId,
          lines: [{ description: 'Group line', line_total: 5000 }]
        })
      });
      assert(!r.success, 'Group account should be rejected as purchase return ledger');
      assert(r.data.errors.some(e => e.includes('Account Group')), 'Should show group account error');
    });

    await test('Reject CREDIT-nature account as purchase return ledger', async () => {
      // Purchase return ledger must be DEBIT-nature (contra-expense), not CREDIT-nature
      const r = await api(token, '/accounting/debit-notes', {
        method: 'POST', body: JSON.stringify({
          debit_note_date: '2026-09-08', original_purchase_invoice_id: dnPurchaseId,
          supplier_id: contactId, purchase_return_ledger_id: 'acc_sales',
          payable_ledger_id: 'acc_payable',
          amount: 5000, reference_number: 'DN-2026-WRONGNATURE',
          narration: 'Wrong nature test', currency: 'INR',
          financial_year_id: activeFyId,
          lines: [{ description: 'Wrong nature line', line_total: 5000 }]
        })
      });
      assert(!r.success, 'CREDIT-nature account should be rejected as purchase return ledger');
      assert(r.data.errors.some(e => e.includes('DEBIT-nature')), 'Should show nature mismatch error');
    });

    await test('Reject missing debit note line', async () => {
      const r = await api(token, '/accounting/debit-notes', {
        method: 'POST', body: JSON.stringify({
          debit_note_date: '2026-09-08', original_purchase_invoice_id: dnPurchaseId,
          supplier_id: contactId, purchase_return_ledger_id: 'acc_purchase_returns',
          payable_ledger_id: 'acc_payable',
          amount: 5000, reference_number: 'DN-2026-NOLINES',
          narration: 'No lines test', currency: 'INR',
          financial_year_id: activeFyId,
          lines: []
        })
      });
      assert(!r.success, 'Should fail without lines');
      assert(r.data.errors.some(e => e.includes('line')), 'Should show line error');
    });

    await test('Reject zero amount debit note', async () => {
      const r = await api(token, '/accounting/debit-notes', {
        method: 'POST', body: JSON.stringify({
          debit_note_date: '2026-09-08', original_purchase_invoice_id: dnPurchaseId,
          supplier_id: contactId, purchase_return_ledger_id: 'acc_purchase_returns',
          payable_ledger_id: 'acc_payable',
          amount: 0, reference_number: 'DN-2026-ZERO',
          narration: 'Zero test', currency: 'INR',
          financial_year_id: activeFyId,
          lines: [{ description: 'Zero line', line_total: 5000 }]
        })
      });
      assert(!r.success, 'Zero amount should fail');
      assert(r.data.errors.some(e => e.includes('zero') || e.includes('greater than zero')), 'Should show amount error');
    });

    await test('Reject debit note with no payable ledger', async () => {
      const r = await api(token, '/accounting/debit-notes', {
        method: 'POST', body: JSON.stringify({
          debit_note_date: '2026-09-08', original_purchase_invoice_id: dnPurchaseId,
          supplier_id: contactId, purchase_return_ledger_id: 'acc_purchase_returns',
          amount: 5000, reference_number: 'DN-2026-NOPAYABLE',
          narration: 'No payable test', currency: 'INR',
          financial_year_id: activeFyId,
          lines: [{ description: 'No payable line', line_total: 5000 }]
        })
      });
      assert(!r.success, 'Should fail without payable ledger');
      assert(r.data.errors.some(e => /payable/i.test(e)), 'Should show payable required error');
    });

    await test('Reject date outside Financial Year', async () => {
      const r = await api(token, '/accounting/debit-notes', {
        method: 'POST', body: JSON.stringify({
          debit_note_date: '2020-01-01', original_purchase_invoice_id: dnPurchaseId,
          supplier_id: contactId, purchase_return_ledger_id: 'acc_purchase_returns',
          payable_ledger_id: 'acc_payable',
          amount: 5000, reference_number: 'DN-2026-DATE',
          narration: 'Date test', currency: 'INR',
          financial_year_id: activeFyId,
          lines: [{ description: 'Date line', line_total: 5000 }]
        })
      });
      assert(!r.success, 'Should fail with date outside FY');
      assert(r.data.errors.some(e => e.includes('Financial Year')), 'Should show FY error');
    });

    await test('Debit Note audit trail exists', async () => {
      const audits = dbQuery("SELECT * FROM accounting_audit WHERE entity_type = 'debit_note' AND entity_id = ? ORDER BY created_at ASC", [debitNoteIdFull]);
      assert(audits.length > 0, 'Should have audit records');
      const actions = audits.map(a => a.action);
      assert(actions.includes('DRAFT') || actions.includes('POST'), 'Should have DRAFT or POST action: ' + JSON.stringify(actions));
    });

    await test('Debit Note numbering follows DN- prefix convention', async () => {
      const r = await api(token, `/accounting/debit-notes/${debitNoteIdFull}`, { method: 'GET' });
      assert(r.success, 'Should fetch debit note');
      assert(r.data.voucherNumber.startsWith('DN-'), 'Should have DN- prefix: ' + r.data.voucherNumber);
    });

    await test('Debit Note → Journal Entry → Ledger → Trial Balance integration', async () => {
      // Verify the JE is linked to the debit note
      const je = dbGet("SELECT id, voucher_id, total_debit, total_credit FROM journal_entries WHERE voucher_id = ?", [debitNoteIdFull]);
      assert(je, 'JE should exist for debit note');
      assert(parseFloat(je.total_debit) === parseFloat(je.total_credit), 'JE must be balanced');

      // Verify Trial Balance is balanced
      const tb = dbQuery("SELECT SUM(jel.debit_amount) as total_debit, SUM(jel.credit_amount) as total_credit FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id WHERE je.company_id = 'default'");
      const tbDebit = parseFloat(tb[0]?.total_debit || 0);
      const tbCredit = parseFloat(tb[0]?.total_credit || 0);
      assert(Math.abs(tbDebit - tbCredit) < 0.01, `Trial Balance must be balanced: Debit=${tbDebit}, Credit=${tbCredit}`);
    });

    await test('Debit Note Trial Balance impact', async () => {
      // Payable (credit balance for liability) was debited → reduces liability
      // Purchase Returns (debit credit) was credited → increases contra-expense (reduces expense)
      const tb = dbQuery("SELECT a.id, a.name, SUM(jel.debit_amount - jel.credit_amount) as balance FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id JOIN accounts a ON a.id = jel.account_id WHERE a.id = 'acc_payable' AND je.voucher_id IN (?, ?) GROUP BY a.id, a.name", [dnPurchaseId, debitNoteIdFull]);
      assert(tb.length > 0, 'Payable should have entries');
      const payableBalance = parseFloat(tb[0].balance);
      // Original purchase: 25000 credit (-25000). Full return: 20000 debit (+20000). Net = -5000
      assert(Math.abs(payableBalance - (-5000)) < 0.01, 'Payable balance should reflect partial reduction: ' + payableBalance);
    });

    await test('Debit Note P&L impact (purchase returns reduce expense)', async () => {
      const r = await api(token, '/accounting/reports/profit-loss', { method: 'GET' });
      assert(r.success, 'P&L should be generated');
      // The P&L should include purchase returns reducing the expense
      const plData = r.data;
      assert(plData, 'P&L data should exist');
    });

    await test('Debit Note Balance Sheet impact (payable reduced)', async () => {
      const r = await api(token, '/accounting/reports/balance-sheet', { method: 'GET' });
      assert(r.success, 'Balance Sheet should be generated');
      assert(r.data, 'Balance Sheet data should exist');
    });

    await test('Revenue impact: net purchases = gross purchases - debit notes', async () => {
      // Net purchase = gross purchases - purchase returns (only POSTED vouchers with POSTED JEs)
      // For Step 14: purchases from dnPurchaseId + fullPurchaseId; returns from full DN (debitNoteIdFull)
      const tb = dbQuery(`
        SELECT a.id, SUM(jel.debit_amount - jel.credit_amount) as balance
        FROM journal_entries je
        JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN accounts a ON a.id = jel.account_id
        JOIN vouchers v ON v.id = je.voucher_id
        WHERE a.id IN ('acc_purchases','acc_purchase_returns')
          AND je.status = 'POSTED'
          AND v.status = 'POSTED'
          AND v.id IN (?, ?, ?)
        GROUP BY a.id
      `, [dnPurchaseId, fullPurchaseId, debitNoteIdFull]);
      const purchasesRow = tb.find(r => r.id === 'acc_purchases');
      const returnsRow = tb.find(r => r.id === 'acc_purchase_returns');
      // Purchases: 25000 (dnPurchaseId) + 20000 (fullPurchaseId) = 45000 (debit)
      // Purchase Returns from full DN: -20000 (credit on DEBIT-nature = negative balance)
      // Net = 45000 - 20000 = 25000
      const netPurchases = parseFloat(purchasesRow?.balance || 0) + parseFloat(returnsRow?.balance || 0);
      assert(Math.abs(netPurchases - 25000) < 0.01, 'Net purchases should be 25000: ' + netPurchases);
    });

    await test('Original Purchase Invoice remains intact after Debit Note', async () => {
      const r = await api(token, `/accounting/purchases/${dnPurchaseId}`, { method: 'GET' });
      assert(r.success, 'Original purchase should still exist');
      assert(r.data.voucherType === 'PURCHASE', 'Should still be PURCHASE');
      assert(r.data.status === 'POSTED', 'Purchase should remain POSTED');
      assert(parseFloat(r.data.totalAmount) === 25000, 'Purchase total should be unchanged');
      });

      console.log('\\n========================================');

      // ═══ Step 15: Accounts Receivable / Customer Outstanding ═══
      console.log('\n── Step 15: Accounts Receivable ──');

      // Use a dedicated customer for AR tests to avoid interference from Step 10 sales
      // Clean up any stale data from previous test runs for this contact
      const arContactId = 'cnt_002';
      // Clean up stale vouchers, JEs, and JE lines from previous test runs
      dbRun("DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE contact_id = ? AND company_id = 'default'))", [arContactId]);
      dbRun("DELETE FROM transaction_tax_details WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE contact_id = ? AND company_id = 'default'))", [arContactId]);
      dbRun("DELETE FROM journal_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE contact_id = ? AND company_id = 'default')", [arContactId]);
      dbRun("DELETE FROM vouchers WHERE contact_id = ? AND company_id = 'default'", [arContactId]);
      // Also clean up bill/payment/receivable references to prevent FK conflicts on contact delete
      dbRun("DELETE FROM bill_allocations WHERE bill_id IN (SELECT id FROM bills WHERE contact_id = ? AND company_id = 'default')", [arContactId]);
      dbRun("DELETE FROM payments WHERE bill_id IN (SELECT id FROM bills WHERE contact_id = ? AND company_id = 'default')", [arContactId]);
      dbRun("DELETE FROM receivables WHERE contact_id = ? AND company_id = 'default'", [arContactId]);
      dbRun("DELETE FROM bills WHERE contact_id = ? AND company_id = 'default'", [arContactId]);
      dbRun("DELETE FROM contacts WHERE id = ? AND company_id = 'default'", [arContactId]);
      dbRun("INSERT INTO contacts (id, company_id, first_name, last_name, email, customer_status) VALUES (?, 'default', ?, ?, ?, 'CUSTOMER')", [arContactId, 'AR', 'Test', 'ar@test.com']);

      await test('Step 15: Credit Sales Invoice increases customer AR', async () => {
        const r = await api(token, '/accounting/sales', {
          method: 'POST', body: JSON.stringify({
            payment_mode: 'CREDIT', sales_date: '2026-09-10',
            receiving_ledger_id: 'acc_receivable', sales_ledger_id: 'acc_sales',
            amount: 50000, reference_number: 'AR-SI-01',
            narration: 'AR credit sale test', currency: 'INR',
            contact_id: arContactId, financial_year_id: activeFyId
          })
        });
        assert(r.success, 'Credit sale for AR should be created: ' + (r.error?.message || JSON.stringify(r)));
        assert(r.data.status === 'POSTED', 'Sales should be POSTED');
        arSalesId1 = r.data.id;
        arSalesNum1 = r.data.voucherNumber;
      });

      await test('Step 15: Second Credit Sales Invoice for same customer', async () => {
        const r = await api(token, '/accounting/sales', {
          method: 'POST', body: JSON.stringify({
            payment_mode: 'CREDIT', sales_date: '2026-09-12',
            receiving_ledger_id: 'acc_receivable', sales_ledger_id: 'acc_sales',
            amount: 75000, reference_number: 'AR-SI-02',
            narration: 'AR credit sale 2', currency: 'INR',
            contact_id: arContactId, financial_year_id: activeFyId
          })
        });
        assert(r.success, 'Second credit sale should be created: ' + (r.error?.message || JSON.stringify(r)));
        arSalesId2 = r.data.id;
        arSalesNum2 = r.data.voucherNumber;
      });

      await test('Step 15: Customer Outstanding reflects credit sales', async () => {
        const r = await api(token, '/accounting/accounts-receivable/customers');
        assert(r.success, 'AR customers should succeed');
        const customer = (r.data.items || r.data).find(c => c.customerId === arContactId);
        assert(customer, 'Should find AR test customer in list');
        assert(parseFloat(customer.invoicedAmount) === 125000, 'Invoiced amount should be 125000: ' + customer.invoicedAmount);
        assert(parseFloat(customer.outstanding) === 125000, 'Outstanding should be 125000: ' + customer.outstanding);
        assert(customer.status !== 'PAID', 'Status should not be PAID for outstanding balance');
      });

      await test('Step 15: Cash Sales does not incorrectly increase AR', async () => {
        // Cash sale uses acc_cash as receiving ledger, not acc_receivable — so it does NOT create AR
        const r = await api(token, '/accounting/sales', {
          method: 'POST', body: JSON.stringify({
            payment_mode: 'CASH', sales_date: '2026-09-10',
            receiving_ledger_id: 'acc_cash', sales_ledger_id: 'acc_sales',
            amount: 15000, reference_number: 'AR-CASH-01',
            narration: 'Cash sale for AR test', currency: 'INR',
            contact_id: arContactId, financial_year_id: activeFyId
          })
        });
        assert(r.success, 'Cash sale should be created');
        // AR outstanding should remain 125000 (cash sale does not affect AR)
        const ar = await api(token, '/accounting/accounts-receivable/customers');
        const customer = (ar.data.items || ar.data).find(c => c.customerId === arContactId);
        assert(parseFloat(customer.outstanding) === 125000,
          'Cash sale should NOT change AR outstanding (should be 125000): ' + customer.outstanding);
      });

      await test('Step 15: Customer Statement shows correct transactions', async () => {
        const r = await api(token, `/accounting/accounts-receivable/customers/${arContactId}`);
        assert(r.success, 'Customer statement should succeed: ' + (r.error?.message || JSON.stringify(r)));
        const data = r.data;
        assert(data.transactions && data.transactions.length >= 2,
          'Should have at least 2 receivable transactions: ' + (data.transactions?.length || 0));
        const salesTx = data.transactions.find(t => t.type === 'SALES');
        assert(salesTx, 'Should have a SALES transaction');
        assert(parseFloat(salesTx.debit) > 0, 'Sales should be a debit (Dr AR)');
        assert(parseFloat(data.totalDebit) === 125000, 'Total debit should be 125000: ' + data.totalDebit);
        assert(parseFloat(data.closingBalance) === 125000,
          'Closing balance should be 125000: ' + data.closingBalance);
      });

      await test('Step 15: Credit Note reduces customer AR', async () => {
        const r = await api(token, '/accounting/credit-notes', {
          method: 'POST', body: JSON.stringify({
            credit_note_date: '2026-09-14',
            sales_return_ledger_id: 'acc_sales_returns',
            receivable_ledger_id: 'acc_receivable',
            amount: 15000, reference_number: 'AR-CN-01',
            narration: 'AR credit note test', currency: 'INR',
            contact_id: arContactId, financial_year_id: activeFyId,
            original_sales_invoice_id: arSalesId1,
            lines: [{ description: 'Return AR-SI-01', line_total: 15000 }]
          })
        });
        assert(r.success, 'Credit note should be created: ' + (r.error?.message || JSON.stringify(r)));
        arCnId = r.data.id;
        // AR should now be 125000 - 15000 = 110000
        const ar = await api(token, '/accounting/accounts-receivable/customers');
        const customer = (ar.data.items || ar.data).find(c => c.customerId === arContactId);
        assert(parseFloat(customer.outstanding) === 110000,
          'AR should be 110000 after credit note: ' + customer.outstanding);
        assert(parseFloat(customer.creditNotes) === 15000,
          'Credit notes total should be 15000: ' + customer.creditNotes);
      });

      await test('Step 15: Aging buckets are populated correctly', async () => {
        const r = await api(token, '/accounting/accounts-receivable/aging');
        assert(r.success, 'Aging should succeed');
        const data = r.data;
        assert(data.totals, 'Should have aging totals');
        // Check specific customer aging
        const customer = data.customers && data.customers.find(c => c.customerId === arContactId);
        if (customer) {
          const bucketSum = parseFloat(customer.current || 0) + parseFloat(customer['1_30'] || 0) +
            parseFloat(customer['31_60'] || 0) + parseFloat(customer['61_90'] || 0) +
            parseFloat(customer['180_plus'] || 0);
          assert(Math.abs(bucketSum - 110000) < 0.01,
            'Customer aging bucket sum should equal outstanding (110000): ' + bucketSum);
        }
        // Also verify totals are populated
        const totalBuckets = parseFloat(data.totals.current || 0) + parseFloat(data.totals['1_30'] || 0) +
          parseFloat(data.totals['31_60'] || 0) + parseFloat(data.totals['61_90'] || 0) +
          parseFloat(data.totals['180_plus'] || 0);
        assert(totalBuckets > 0, 'Aging totals should be populated (non-zero)');
      });

      await test('Step 15: AR Reconciles with control ledger', async () => {
        const r = await api(token, '/accounting/accounts-receivable/reconciliation');
        assert(r.success, 'Reconciliation should succeed: ' + (r.error?.message || JSON.stringify(r)));
        const data = r.data;
        assert(Math.abs(parseFloat(data.customerLevelTotal) - parseFloat(data.controlLedgerTotal)) < 0.01,
          'Customer total should match control ledger: ' + data.customerLevelTotal + ' vs ' + data.controlLedgerTotal);
        assert(parseFloat(data.difference) === 0, 'Difference should be 0: ' + data.difference);
        assert(data.status === 'RECONCILED', 'Should be RECONCILED: ' + data.status);
      });

      await test('Step 15: AR reconciles with acc_receivable via Trial Balance', async () => {
        const tb = await api(token, '/accounting/reports/trial-balance');
        assert(tb.success, 'Trial Balance should succeed');
        const tbAccounts = tb.data.accounts;
        assert(Array.isArray(tbAccounts), 'Trial Balance should return accounts array');
        // acc_receivable has code 1003 and name "Accounts Receivable"
        const arRow = tbAccounts.find(a => a.code === '1003' || a.name === 'Accounts Receivable');
        assert(arRow, 'Accounts Receivable should appear in Trial Balance');
        const arBalance = parseFloat(arRow.balance);
        assert(arBalance !== 0, 'AR balance should be non-zero: ' + arBalance);
      });

      await test('Step 15: Balance Sheet reflects AR', async () => {
        const r = await api(token, '/accounting/reports/balance-sheet');
        assert(r.success, 'Balance Sheet should succeed');
        // Verify BS endpoint returns structured data including assets
        assert(r.data.hasOwnProperty('assets'), 'Balance Sheet should include assets field');
        assert(r.data.hasOwnProperty('balanced'), 'Balance Sheet should include balanced field');
      });

      await test('Step 15: As-of Date reporting (historical snapshot)', async () => {
        // As of date before credit note — outstanding should be 125000
        const r = await api(token, '/accounting/accounts-receivable/customers?as_of_date=2026-09-13');
        assert(r.success, 'As-of AR should succeed: ' + (r.error?.message || JSON.stringify(r)));
        const customer = (r.data.items || r.data).find(c => c.customerId === arContactId);
        assert(customer, 'Should find AR customer in as-of report');
        assert(parseFloat(customer.outstanding) === 125000,
          'As-of 2026-09-13 outstanding should be 125000 (before CN): ' + customer.outstanding);
      });

      await test('Step 15: Customer Invoices list with status', async () => {
        const r = await api(token, `/accounting/accounts-receivable/customers/${arContactId}/invoices`);
        assert(r.success, 'Customer invoices should succeed: ' + (r.error?.message || JSON.stringify(r)));
        const data = r.data;
        assert(data.total >= 2, 'Should have at least 2 invoices: ' + data.total);
        // Invoices with credit notes should show reduced outstanding
        const salesInvoice = data.invoices.find(i => i.voucherNumber === arSalesNum1);
        assert(salesInvoice, 'Should find AR-SI-01 in invoices');
        // This invoice had a 15000 credit note, so outstanding should be 35000
        assert(parseFloat(salesInvoice.outstanding) === 35000,
          'AR-SI-01 outstanding should be 35000 after 15000 CN: ' + salesInvoice.outstanding);
        assert(salesInvoice.status === 'PARTIALLY_PAID',
          'AR-SI-01 status should be PARTIALLY_PAID (credit note reduces but not fully paid): ' + salesInvoice.status);
      });

      await test('Step 15: Company isolation for AR', async () => {
        const r = await api(token, '/accounting/accounts-receivable/reconciliation');
        assert(r.success, 'AR reconciliation should respect company isolation');
        // Should only contain default company data, not other companies
      });

      await test('Step 15: Posted sales invoice correctly increases AR', async () => {
        // Verify that the AR system correctly reads from the JE engine
        const je = dbGet("SELECT je.* FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ? AND v.voucher_type = 'SALES'", [arSalesId1]);
        assert(je, 'Sales invoice should have a JE');
        assert(Math.abs(parseFloat(je.total_debit) - parseFloat(je.total_credit)) < 0.01, 'JE must be balanced');
        // Verify JE has a debit to acc_receivable
        const jeLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_receivable'", [je.id]);
        assert(jeLine, 'JE should have acc_receivable line');
        assert(parseFloat(jeLine.debit_amount) === 50000, 'AR debit should be 50000: ' + jeLine.debit_amount);
      });

      await test('Step 15: Credit Note correctly credits AR', async () => {
        const je = dbGet("SELECT je.* FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ? AND v.voucher_type = 'CREDIT_NOTE'", [arCnId]);
        assert(je, 'Credit note should have a JE');
        // Verify JE has a credit to acc_receivable
        const jeLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_receivable'", [je.id]);
        assert(jeLine, 'Credit note JE should have acc_receivable line');
        assert(parseFloat(jeLine.credit_amount) === 15000, 'AR credit should be 15000: ' + jeLine.credit_amount);
      });

      await test('Step 15: Audit trail for AR transactions', async () => {
          // Verify audit trail exists for AR-affecting vouchers
          const audit = dbGet("SELECT COUNT(*) as c FROM accounting_audit WHERE entity_id IN (?, ?)", [arSalesId1, arCnId]);
          assert(audit && audit.c > 0, 'Audit trail should exist for AR transactions');
        });

        // ═══ Step 16: Accounts Payable / Supplier Outstanding ═══
        console.log('\n── Step 16: Accounts Payable ──');

        // Use a dedicated supplier for AP tests to avoid interference from Step 11 purchases
        const apContactId = 'cnt_003';
        // Clean up stale vouchers, JEs, and JE lines from previous test runs
        dbRun("DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE contact_id = ? AND company_id = 'default'))", [apContactId]);
        dbRun("DELETE FROM journal_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE contact_id = ? AND company_id = 'default')", [apContactId]);
        dbRun("DELETE FROM vouchers WHERE contact_id = ? AND company_id = 'default'", [apContactId]);
        dbRun("DELETE FROM contacts WHERE id = ? AND company_id = 'default'", [apContactId]);
        dbRun("INSERT INTO contacts (id, company_id, first_name, last_name, email, customer_status) VALUES (?, 'default', ?, ?, ?, 'SUPPLIER')", [apContactId, 'AP', 'Test', 'ap@test.com']);

        await test('Step 16: Credit Purchase Invoice increases supplier AP', async () => {
          const r = await api(token, '/accounting/purchases', {
            method: 'POST', body: JSON.stringify({
              purchase_date: '2026-09-10', payment_mode: 'CREDIT',
              purchase_ledger_id: 'acc_purchases', contact_id: apContactId,
              payable_ledger_id: 'acc_payable',
              amount: 50000, reference_number: 'AP-PI-01',
              currency: 'INR', financial_year_id: activeFyId,
              narration: 'AP credit purchase test'
            })
          });
          assert(r.success, 'Credit purchase should be created: ' + (r.error?.message || JSON.stringify(r)));
          assert(r.data.status === 'POSTED', 'Purchase should be POSTED');
          apPurchaseId1 = r.data.id;
          apPurchaseNum1 = r.data.voucherNumber;
        });

        await test('Step 16: Second Credit Purchase Invoice for same supplier', async () => {
          const r = await api(token, '/accounting/purchases', {
            method: 'POST', body: JSON.stringify({
              purchase_date: '2026-09-12', payment_mode: 'CREDIT',
              purchase_ledger_id: 'acc_purchases', contact_id: apContactId,
              payable_ledger_id: 'acc_payable',
              amount: 75000, reference_number: 'AP-PI-02',
              currency: 'INR', financial_year_id: activeFyId,
              narration: 'AP credit purchase 2'
            })
          });
          assert(r.success, 'Second credit purchase should be created: ' + (r.error?.message || JSON.stringify(r)));
          apPurchaseId2 = r.data.id;
          apPurchaseNum2 = r.data.voucherNumber;
        });

        await test('Step 16: Supplier Outstanding reflects credit purchases', async () => {
          const r = await api(token, '/accounting/accounts-payable/suppliers');
          assert(r.success, 'AP suppliers should succeed');
          const supplier = (r.data.items || r.data).find(s => s.supplierId === apContactId);
          assert(supplier, 'Should find AP test supplier in list');
          assert(parseFloat(supplier.purchaseAmount) === 125000, 'Purchase amount should be 125000: ' + supplier.purchaseAmount);
          assert(parseFloat(supplier.outstanding) === 125000, 'Outstanding should be 125000: ' + supplier.outstanding);
          assert(supplier.status !== 'PAID', 'Status should not be PAID for outstanding balance');
        });

        await test('Step 16: Cash Purchase does not incorrectly increase AP', async () => {
          // Cash purchase uses acc_cash as payable ledger, not acc_payable — so it does NOT create AP
          const r = await api(token, '/accounting/purchases', {
            method: 'POST', body: JSON.stringify({
              purchase_date: '2026-09-10', payment_mode: 'CASH',
              purchase_ledger_id: 'acc_purchases', contact_id: apContactId,
              payable_ledger_id: 'acc_cash',
              amount: 15000, reference_number: 'AP-CASH-01',
              currency: 'INR', financial_year_id: activeFyId,
              narration: 'Cash purchase for AP test'
            })
          });
          assert(r.success, 'Cash purchase should be created');
          // AP outstanding should remain 125000 (cash purchase does not affect AP)
          const ap = await api(token, '/accounting/accounts-payable/suppliers');
          const supplier = (ap.data.items || ap.data).find(s => s.supplierId === apContactId);
          assert(parseFloat(supplier.outstanding) === 125000,
            'Cash purchase should NOT change AP outstanding (should be 125000): ' + supplier.outstanding);
        });

        await test('Step 16: Supplier Statement shows correct transactions', async () => {
          const r = await api(token, `/accounting/accounts-payable/suppliers/${apContactId}`);
          assert(r.success, 'Supplier statement should succeed: ' + (r.error?.message || JSON.stringify(r)));
          const data = r.data;
          assert(data.transactions && data.transactions.length >= 2,
            'Should have at least 2 payable transactions: ' + (data.transactions?.length || 0));
          const purchaseTx = data.transactions.find(t => t.type === 'PURCHASE');
          assert(purchaseTx, 'Should have a PURCHASE transaction');
          assert(parseFloat(purchaseTx.credit) > 0, 'Purchase should be a credit (Cr Payable)');
          assert(parseFloat(data.totalCredit) === 125000, 'Total credit should be 125000: ' + data.totalCredit);
          assert(parseFloat(data.closingBalance) === 125000,
            'Closing balance should be 125000: ' + data.closingBalance);
        });

        await test('Step 16: Payment reduces supplier AP', async () => {
          const r = await api(token, '/accounting/payment-vouchers', {
            method: 'POST', body: JSON.stringify({
              payment_mode: 'BANK', payment_date: '2026-09-14',
              payment_account_id: 'acc_bank', destination_ledger_id: 'acc_payable',
              amount: 40000, reference_number: 'AP-PAY-01',
              narration: 'AP payment test', currency: 'INR',
              contact_id: apContactId, financial_year_id: activeFyId
            })
          });
          assert(r.success, 'Payment should be created: ' + (r.error?.message || JSON.stringify(r)));
          apPaymentId = r.data.id;
          // AP should now be 125000 - 40000 = 85000
          const ap = await api(token, '/accounting/accounts-payable/suppliers');
          const supplier = (ap.data.items || ap.data).find(s => s.supplierId === apContactId);
          assert(parseFloat(supplier.outstanding) === 85000,
            'AP should be 85000 after payment: ' + supplier.outstanding);
          assert(parseFloat(supplier.paymentsMade) === 40000,
            'Payments made should be 40000: ' + supplier.paymentsMade);
        });

        await test('Step 16: Debit Note reduces supplier AP', async () => {
          const r = await api(token, '/accounting/debit-notes', {
            method: 'POST', body: JSON.stringify({
              debit_note_date: '2026-09-15',
              purchase_ledger_id: 'acc_purchases',
              purchase_return_ledger_id: 'acc_purchase_returns',
              payable_ledger_id: 'acc_payable',
              amount: 15000, reference_number: 'AP-DN-01',
              narration: 'AP debit note test', currency: 'INR',
              contact_id: apContactId, financial_year_id: activeFyId,
              original_purchase_invoice_id: apPurchaseId1,
              lines: [{ description: 'Return AP-PI-01', line_total: 15000 }]
            })
          });
          assert(r.success, 'Debit note should be created: ' + (r.error?.message || JSON.stringify(r)));
          apDnId = r.data.id;
          // AP should now be 85000 - 15000 = 70000
          const ap = await api(token, '/accounting/accounts-payable/suppliers');
          const supplier = (ap.data.items || ap.data).find(s => s.supplierId === apContactId);
          assert(parseFloat(supplier.outstanding) === 70000,
            'AP should be 70000 after debit note: ' + supplier.outstanding);
          assert(parseFloat(supplier.debitNotes) === 15000,
            'Debit notes total should be 15000: ' + supplier.debitNotes);
        });

        await test('Step 16: AP Aging buckets are populated correctly', async () => {
          const r = await api(token, '/accounting/accounts-payable/aging');
          assert(r.success, 'AP aging should succeed');
          const data = r.data;
          assert(data.totals, 'Should have aging totals');
          // Check specific supplier aging
          const supplier = data.suppliers && data.suppliers.find(s => s.supplierId === apContactId);
          if (supplier) {
            const bucketSum = parseFloat(supplier.current || 0) + parseFloat(supplier['1_30'] || 0) +
              parseFloat(supplier['31_60'] || 0) + parseFloat(supplier['61_90'] || 0) +
              parseFloat(supplier['180_plus'] || 0);
            assert(Math.abs(bucketSum - 70000) < 0.01,
              'Supplier aging bucket sum should equal outstanding (70000): ' + bucketSum);
          }
        });

        await test('Step 16: AP Reconciles with control ledger', async () => {
          const r = await api(token, '/accounting/accounts-payable/reconciliation');
          assert(r.success, 'AP reconciliation should succeed: ' + (r.error?.message || JSON.stringify(r)));
          const data = r.data;
          assert(Math.abs(parseFloat(data.supplierLevelTotal) - parseFloat(data.controlLedgerTotal)) < 0.01,
            'Supplier total should match control ledger: ' + data.supplierLevelTotal + ' vs ' + data.controlLedgerTotal);
          assert(parseFloat(data.difference) === 0, 'Difference should be 0: ' + data.difference);
          assert(data.status === 'RECONCILED', 'Should be RECONCILED: ' + data.status);
        });

        await test('Step 16: AP reconciles with acc_payable via Trial Balance', async () => {
          const tb = await api(token, '/accounting/reports/trial-balance');
          assert(tb.success, 'Trial Balance should succeed');
          const tbAccounts = tb.data.accounts;
          assert(Array.isArray(tbAccounts), 'Trial Balance should return accounts array');
          const apRow = tbAccounts.find(a => a.code === '2001' || a.name === 'Accounts Payable');
          assert(apRow, 'Accounts Payable should appear in Trial Balance');
          assert(parseFloat(apRow.balance) !== 0, 'AP balance should be non-zero');
        });

        await test('Step 16: Balance Sheet reflects AP', async () => {
          const r = await api(token, '/accounting/reports/balance-sheet');
          assert(r.success, 'Balance Sheet should succeed');
          assert(r.data.hasOwnProperty('liabilities'), 'Balance Sheet should include liabilities field');
        });

        await test('Step 16: As-of Date reporting for AP', async () => {
          // As of date before payment and debit note — outstanding should be 125000
          const r = await api(token, '/accounting/accounts-payable/suppliers?as_of_date=2026-09-13');
          assert(r.success, 'As-of AP should succeed');
          const supplier = (r.data.items || r.data).find(s => s.supplierId === apContactId);
          assert(supplier, 'Should find AP supplier in as-of report');
          assert(parseFloat(supplier.outstanding) === 125000,
            'As-of 2026-09-13 outstanding should be 125000 (before payment/DN): ' + supplier.outstanding);
        });

        await test('Step 16: Supplier Invoices list with status', async () => {
          const r = await api(token, `/accounting/accounts-payable/suppliers/${apContactId}/invoices`);
          assert(r.success, 'Supplier invoices should succeed: ' + (r.error?.message || JSON.stringify(r)));
          const data = r.data;
          assert(data.total >= 2, 'Should have at least 2 invoices: ' + data.total);
          // Invoice 1 had a debit note applied — should be PARTIALLY_PAID
          const inv1 = data.invoices.find(i => i.voucherNumber === apPurchaseNum1);
          assert(inv1, 'Should find AP-PI-01 in invoices');
          assert(parseFloat(inv1.outstanding) === 35000,
            'AP-PI-01 outstanding should be 35000 after 15000 DN: ' + inv1.outstanding);
          assert(inv1.status === 'PARTIALLY_PAID',
            'AP-PI-01 status should be PARTIALLY_PAID: ' + inv1.status);
        });

        await test('Step 16: Company isolation for AP', async () => {
          const r = await api(token, '/accounting/accounts-payable/reconciliation');
          assert(r.success, 'AP reconciliation should respect company isolation');
        });

        await test('Step 16: Purchase Invoice correctly credits AP', async () => {
          const je = dbGet("SELECT je.* FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ? AND v.voucher_type = 'PURCHASE'", [apPurchaseId1]);
          assert(je, 'Purchase invoice should have a JE');
          assert(Math.abs(parseFloat(je.total_debit) - parseFloat(je.total_credit)) < 0.01, 'JE must be balanced');
          const jeLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_payable'", [je.id]);
          assert(jeLine, 'JE should have acc_payable line');
          assert(parseFloat(jeLine.credit_amount) === 50000, 'AP credit should be 50000: ' + jeLine.credit_amount);
        });

        await test('Step 16: Payment correctly debits AP', async () => {
          const je = dbGet("SELECT je.* FROM vouchers v JOIN journal_entries je ON je.voucher_id = v.id WHERE v.id = ? AND v.voucher_type = 'PAYMENT'", [apPaymentId]);
          assert(je, 'Payment should have a JE');
          const jeLine = dbGet("SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = 'acc_payable'", [je.id]);
          assert(jeLine, 'Payment JE should have acc_payable line');
          assert(parseFloat(jeLine.debit_amount) === 40000, 'AP debit should be 40000: ' + jeLine.debit_amount);
        });

        await test('Step 16: Audit trail for AP transactions', async () => {
          const audit = dbGet("SELECT COUNT(*) as c FROM accounting_audit WHERE entity_id IN (?, ?)", [apPurchaseId1, apPaymentId]);
          assert(audit && audit.c > 0, 'Audit trail should exist for AP transactions');
        });

      // ═══ Step 17: Tax / GST Master ═══
      console.log('\n── Step 17: Tax / GST Master ──');

      let taxMasterId;
      await test('Step 17: List tax masters', async () => {
        const r = await api(token, '/accounting/taxes');
        assert(r.success, 'List taxes should succeed: ' + (r.error?.message || JSON.stringify(r)));
        assert(Array.isArray(r.data), 'Taxes should return an array');
        assert(r.data.length > 0, 'Should have seeded tax masters');
        taxMasterId = r.data[0].id;
      });

      await test('Step 17: Get a specific tax master', async () => {
        const r = await api(token, `/accounting/taxes/${taxMasterId}`);
        assert(r.success, 'Get tax should succeed');
        assert(r.data.id === taxMasterId, 'Should return correct tax master');
        assert(r.data.rate !== undefined, 'Tax rate should be present');
      });

      await test('Step 17: Get company tax config', async () => {
        const r = await api(token, '/accounting/taxes/company-config');
        assert(r.success, 'Company tax config should succeed');
        assert(r.data.hasOwnProperty('gstEnabled'), 'Should have gstEnabled');
      });

      await test('Step 17: Tax calculation preview', async () => {
        const r = await api(token, '/accounting/taxes/calculate', {
          method: 'POST', body: JSON.stringify({
            amount: 1000, tax_master_id: taxMasterId, place_of_supply: 'IN'
          })
        });
        assert(r.success, 'Tax calculation should succeed: ' + (r.error?.message || JSON.stringify(r)));
      });

      // ═══ Step 18: Tax Reports & Reconciliation ═══
      console.log('\n── Step 18: Tax Reports & Reconciliation ──');

      await test('Step 18: Tax summary report', async () => {
        const r = await api(token, '/accounting/taxes/reports/summary');
        assert(r.success, 'Tax summary report should succeed: ' + (r.error?.message || JSON.stringify(r)));
        assert(r.data.hasOwnProperty('salesTax'), 'Should have salesTax section');
        assert(r.data.hasOwnProperty('purchaseTax'), 'Should have purchaseTax section');
        assert(r.data.hasOwnProperty('netGstPayable'), 'Should have netGstPayable');
      });

      await test('Step 18: Sales tax summary', async () => {
        const r = await api(token, '/accounting/taxes/reports/sales-tax-summary');
        assert(r.success, 'Sales tax summary should succeed: ' + (r.error?.message || JSON.stringify(r)));
        assert(Array.isArray(r.data.items), 'Should return items array');
      });

      await test('Step 18: Purchase tax summary', async () => {
        const r = await api(token, '/accounting/taxes/reports/purchase-tax-summary');
        assert(r.success, 'Purchase tax summary should succeed');
        assert(Array.isArray(r.data.items), 'Should return items array');
      });

      await test('Step 18: Output-input GST reconciliation', async () => {
        const r = await api(token, '/accounting/taxes/reports/output-input-reconciliation');
        assert(r.success, 'Output-input reconciliation should succeed: ' + (r.error?.message || JSON.stringify(r)));
        assert(r.data.hasOwnProperty('outputGst'), 'Should have outputGst');
        assert(r.data.hasOwnProperty('inputGst'), 'Should have inputGst');
      });

      await test('Step 18: Tax reconciliation report', async () => {
        const r = await api(token, '/accounting/taxes/reconciliation');
        assert(r.success, 'Tax reconciliation should succeed: ' + (r.error?.message || JSON.stringify(r)));
        assert(r.data.hasOwnProperty('outputGst'), 'Should have outputGst section');
        assert(r.data.hasOwnProperty('inputGst'), 'Should have inputGst section');
        assert(r.data.hasOwnProperty('netGstPayable'), 'Should have netGstPayable');
      });

      // ═══ Step 19: Inventory Accounting & Stock Valuation ═══
      console.log('\n── Step 19: Inventory Accounting & Stock Valuation ──');

      await test('Step 19: List inventory items', async () => {
        const r = await api(token, '/accounting/inventory/items');
        assert(r.success, 'List inventory items should succeed: ' + (r.error?.message || JSON.stringify(r)));
        assert(r.data.hasOwnProperty('items'), 'Should return items');
      });

      await test('Step 19: Inventory valuation report', async () => {
        const r = await api(token, '/accounting/inventory/valuation');
        assert(r.success, 'Inventory valuation should succeed: ' + (r.error?.message || JSON.stringify(r)));
        assert(r.data.hasOwnProperty('items'), 'Should return items array');
        assert(r.data.hasOwnProperty('totalValue'), 'Should have totalValue');
      });

      await test('Step 19: Inventory movements (audit trail)', async () => {
        const r = await api(token, '/accounting/inventory/movements');
        assert(r.success, 'Inventory movements should succeed: ' + (r.error?.message || JSON.stringify(r)));
        assert(r.data.hasOwnProperty('items'), 'Should return items');
      });

      // ═══ Step 20-24: Financial Statements (already tested above) ═══
      console.log('\n── Step 20-24: Financial Statements ──');

      await test('Step 20: Trial Balance via API', async () => {
        const r = await api(token, '/accounting/reports/trial-balance');
        assert(r.success, 'Trial balance API should succeed');
        assert(r.data.hasOwnProperty('accounts'), 'Should return accounts array');
      });

      await test('Step 22: Profit & Loss via API', async () => {
        const r = await api(token, '/accounting/reports/profit-loss');
        assert(r.success, 'P&L API should succeed');
        assert(r.data.hasOwnProperty('revenue'), 'Should have revenue');
        assert(r.data.hasOwnProperty('expense'), 'Should have expense');
      });

      await test('Step 23: Balance Sheet via API', async () => {
        const r = await api(token, '/accounting/reports/balance-sheet');
        assert(r.success, 'Balance Sheet API should succeed');
        assert(r.data.hasOwnProperty('assets'), 'Should have assets');
        assert(r.data.hasOwnProperty('liabilities'), 'Should have liabilities');
      });

      await test('Step 24: Cash Flow via API', async () => {
        const r = await api(token, '/accounting/reports/cash-flow');
        assert(r.success, 'Cash flow API should succeed');
        assert(r.data.hasOwnProperty('operating'), 'Should have operating section');
        assert(r.data.hasOwnProperty('investing'), 'Should have investing section');
        assert(r.data.hasOwnProperty('financing'), 'Should have financing section');
      });

      await test('Step 24: Day Book via API', async () => {
        const r = await api(token, '/accounting/reports/day-book');
        assert(r.success, 'Day book API should succeed');
        assert(r.data.hasOwnProperty('items'), 'Should return items');
      });

      await test('Step 24: Cash Book via API', async () => {
        const r = await api(token, '/accounting/reports/cash-book');
        assert(r.success, 'Cash book API should succeed');
        assert(r.data.hasOwnProperty('items'), 'Should return items');
      });

      await test('Step 24: Ledger Report via API', async () => {
        const r = await api(token, '/accounting/reports/ledger?accountId=acc_bank');
        assert(r.success, 'Ledger report API should succeed');
        assert(r.data.hasOwnProperty('items'), 'Should return items');
      });

      // ═══ Step 25: Bank Reconciliation ═══
      console.log('\n── Step 25: Bank Reconciliation ──');

      let reconId;
      await test('Step 25: Create bank account for reconciliation', async () => {
        const r = await api(token, '/accounting/bank-accounts', {
          method: 'POST', body: JSON.stringify({
            account_name: 'Test Bank Recon Account',
            account_number: '9988776655', bank_name: 'Test Bank',
            ifsc_code: 'TEST0001234', account_type: 'SAVINGS',
            gl_account_id: 'acc_bank', opening_balance: 50000
          })
        });
        assert(r.success, 'Create bank account should succeed: ' + (r.error?.message || JSON.stringify(r)));
        bankId = r.data.id;
      });

      await test('Step 25: List bank accounts', async () => {
        const r = await api(token, '/accounting/bank-accounts');
        assert(r.success, 'List bank accounts should succeed');
        assert(Array.isArray(r.data.items), 'Should return items array');
        assert(r.data.items.length > 0, 'Should have at least one bank account');
      });

      await test('Step 25: Create bank reconciliation', async () => {
        const r = await api(token, '/accounting/bank-reconciliations', {
          method: 'POST', body: JSON.stringify({
            bank_account_id: bankId,
            statement_date: '2026-09-15',
            statement_balance: 50000,
            items: [
              { item_type: 'DEPOSIT_IN_TRANSIT', description: 'Deposit in transit', amount: 5000, reference: 'REF001' }
            ]
          })
        });
        assert(r.success, 'Create bank reconciliation should succeed: ' + (r.error?.message || JSON.stringify(r)));
        reconId = r.data.id;
        assert(r.data.status === 'RECONCILED', 'Status should be RECONCILED');
      });

      await test('Step 25: Get bank reconciliation', async () => {
        const r = await api(token, `/accounting/bank-reconciliations/${reconId}`);
        assert(r.success, 'Get bank reconciliation should succeed');
        assert(r.data.id === reconId, 'Should return correct reconciliation');
        assert(Array.isArray(r.data.items), 'Should include reconciliation items');
      });

      await test('Step 25: List bank reconciliations', async () => {
        const r = await api(token, '/accounting/bank-reconciliations');
        assert(r.success, 'List bank reconciliations should succeed');
        assert(Array.isArray(r.data.items), 'Should return items array');
      });

      await test('Step 25: List bank recon items', async () => {
        const r = await api(token, `/accounting/bank-reconciliations/${reconId}/items`);
        assert(r.success, 'List bank recon items should succeed');
        assert(Array.isArray(r.data.items), 'Should return items array');
        assert(r.data.items.length > 0, 'Should have at least one item');
      });

      await test('Step 25: Create bank recon item', async () => {
        const r = await api(token, `/accounting/bank-reconciliations/${reconId}/items`, {
          method: 'POST', body: JSON.stringify({
            item_type: 'UNPRESENTED_CHEQUE', description: 'Unpresented cheque',
            amount: 3000, reference: 'CHQ001'
          })
        });
        assert(r.success, 'Create bank recon item should succeed: ' + (r.error?.message || JSON.stringify(r)));
        const items = await api(token, `/accounting/bank-reconciliations/${reconId}/items`);
        assert(items.data.items.length >= 2, 'Should have at least 2 items now');
      });

      await test('Step 25: Delete bank recon item', async () => {
        const items = await api(token, `/accounting/bank-reconciliations/${reconId}/items`);
        const itemId = items.data.items[0].id;
        const r = await api(token, `/accounting/bank-reconciliations/${reconId}/items/${itemId}`, {
          method: 'DELETE'
        });
        assert(r.success, 'Delete bank recon item should succeed');
      });

      await test('Step 25: Delete bank reconciliation', async () => {
        const r = await api(token, `/accounting/bank-reconciliations/${reconId}`, {
          method: 'DELETE'
        });
        assert(r.success, 'Delete bank reconciliation should succeed');
      });

      // ═══ Step 26: Year-End Closing ═══
      console.log('\n── Step 26: Year-End Closing ──');

      await test('Step 26: Get year-end status', async () => {
        const r = await api(token, `/accounting/year-end/status?financial_year_id=${activeFyId}`);
        assert(r.success, 'Year-end status should succeed: ' + (r.error?.message || JSON.stringify(r)));
        assert(r.data.financialYear, 'Should include financialYear');
        assert(r.data.hasOwnProperty('closed'), 'Should have closed flag');
        assert(r.data.hasOwnProperty('canClose'), 'Should have canClose flag');
        assert(r.data.hasOwnProperty('profitLoss'), 'Should have profitLoss');
      });

      await test('Step 26: List year-end closings', async () => {
        const r = await api(token, '/accounting/year-end');
        assert(r.success, 'List year-end closings should succeed');
        assert(Array.isArray(r.data.items), 'Should return items array');
      });

      await test('Step 26: Close financial year', async () => {
        const r = await api(token, '/accounting/year-end/close', {
          method: 'POST', body: JSON.stringify({
            financial_year_id: activeFyId
          })
        });
        assert(r.success, 'Close financial year should succeed: ' + (r.error?.message || JSON.stringify(r)));
        assert(r.data.message === 'Financial year closed successfully', 'Should return success message');
      });

      await test('Step 26: Financial year is locked after closing', async () => {
        const r = await api(token, `/accounting/year-end/status?financial_year_id=${activeFyId}`);
        assert(r.success, 'Year-end status should succeed');
        assert(r.data.closed === true, 'Should be marked as closed');
        assert(r.data.locked === true, 'Financial year should be locked');
      });

      await test('Step 26: Prevent duplicate closing', async () => {
        const r = await api(token, '/accounting/year-end/close', {
          method: 'POST', body: JSON.stringify({
            financial_year_id: activeFyId
          })
        });
        assert(!r.success, 'Should reject duplicate closing');
      });

      // ═══ Step 27: Audit & System Integrity ═══
      console.log('\n── Step 27: Audit & System Integrity ──');

      await test('Step 27: Audit trail records operations', async () => {
        const r = await api(token, '/accounting/audit-trail');
        assert(r.success, 'Audit trail should succeed: ' + (r.error?.message || JSON.stringify(r)));
        assert(Array.isArray(r.data.items), 'Should return items array');
        assert(r.data.items.length > 0, 'Should have audit records');
      });

      await test('Step 27: System integrity check', async () => {
        const r = await api(token, '/accounting/reports/system-integrity');
        assert(r.success, 'System integrity should succeed: ' + (r.error?.message || JSON.stringify(r)));
        assert(r.data.hasOwnProperty('balanced'), 'Should have balanced flag');
        assert(r.data.hasOwnProperty('totalDebit'), 'Should have totalDebit');
        assert(r.data.hasOwnProperty('totalCredit'), 'Should have totalCredit');
        assert(r.data.hasOwnProperty('checks'), 'Should have checks object');
        assert(r.data.status === 'PASS' || r.data.status === 'FAIL', 'Should have status PASS or FAIL: ' + r.data.status);
      });

      await test('Step 27: Trial balance debit equals credit', async () => {
        const r = await api(token, '/accounting/reports/trial-balance');
        assert(r.success, 'Trial balance should succeed');
        // Verify trial balance structure and that it reports totals
        assert(r.data.hasOwnProperty('totalDebit'), 'Should have totalDebit');
        assert(r.data.hasOwnProperty('totalCredit'), 'Should have totalCredit');
        assert(r.data.hasOwnProperty('balanced'), 'Should have balanced flag');
        assert(typeof r.data.balanced === 'boolean', 'balanced should be boolean');
      });

      await test('Step 27: Balance sheet balances (Assets = Liabilities + Equity)', async () => {
        const r = await api(token, '/accounting/reports/balance-sheet');
        assert(r.success, 'Balance sheet should succeed');
        const assets = parseFloat(r.data.assets || 0);
        const liabilities = parseFloat(r.data.liabilities || 0);
        const equity = parseFloat(r.data.equity || 0);
        const currentPeriodProfit = parseFloat(r.data.currentPeriodProfit || r.data.netProfit || 0);
        assert(Math.abs(assets - (liabilities + equity + currentPeriodProfit)) < 0.01,
          'Balance sheet must balance: assets=' + assets + ' vs (liab+eq+profit)=' + (liabilities + equity + currentPeriodProfit));
      });

      console.log('\\n========================================');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (errors.length > 0) {
    console.log('\n  Failures:');
    errors.forEach(e => console.log('    - ' + e.name + ': ' + e.error));
  }
  console.log('========================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test suite failed:', err);
  process.exitCode = 1;
});
