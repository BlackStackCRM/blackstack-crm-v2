/**
 * Accounting & Finance Module - End-to-End Test Script
 * Tests the complete flow: COA → Journal → Bill → Payment → Reconciliation → Reports
 */
const BASE_URL = 'http://localhost:3000/api';

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

async function run() {
  console.log('\n========================================');
  console.log('  Accounting & Finance E2E Test Suite');
  console.log('========================================\n');

  const token = await login();
  // Resolve the active financial year — the journal API requires financial_year_id.
  const fysRes = await api(token, '/accounting/financial-years');
  const fys = (fysRes.data && (fysRes.data.items || fysRes.data)) || [];
  const fyList = Array.isArray(fys) ? fys : [];
  const activeFy = fyList.find(f => f.is_active === 1 || f.is_active === true);
  const activeFyId = activeFy ? activeFy.id : null;
  let billId, paymentId, journalId, coaId, costCentreId, budgetId, bankId, fyId;

  // ─── 1. Chart of Accounts ──────────────────────────────────────
  console.log('── Chart of Accounts ──');
  await test('List COA', async () => {
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
    assert(r.success, 'Create account should succeed');
    coaId = r.data.id;
  });

  await test('Cannot delete account with transactions', async () => {
    // First create a journal entry using the account
    await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        description: 'Test entry for account deletion check',
        entry_date: '2024-09-05', currency: 'INR', financial_year_id: activeFyId,
        lines: [
          { account_id: coaId, debit_amount: 100, credit_amount: 0 },
          { account_id: 'acc_cash', debit_amount: 0, credit_amount: 100 }
        ]
      })
    });
    // Now try to delete the account
    const r = await api(token, '/accounting/accounts/' + coaId, { method: 'DELETE' });
    assert(!r.success, 'Account with transactions should not be deletable');
  });

  // ─── 2. Journal Entries ─────────────────────────────────────────
  console.log('\n── Journal Entries ──');
  await test('Create balanced journal entry', async () => {
    const r = await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        description: 'Cash sale - INR 50,000',
        entry_date: '2024-09-05', currency: 'INR', financial_year_id: activeFyId,
        lines: [
          { account_id: 'acc_cash', debit_amount: 50000, credit_amount: 0, description: 'Cash received' },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 50000, description: 'Sales revenue' }
        ]
      })
    });
    assert(r.success, 'Balanced journal entry should succeed');
    journalId = r.data.id;
  });

  await test('Reject unbalanced journal entry', async () => {
    const r = await api(token, '/accounting/journal', {
      method: 'POST', body: JSON.stringify({
        description: 'Unbalanced entry',
        entry_date: '2024-09-05', currency: 'INR',
        lines: [
          { account_id: 'acc_cash', debit_amount: 50000, credit_amount: 0 },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 10000 }
        ]
      })
    });
    assert(!r.success, 'Unbalanced entry should be rejected');
  });

  await test('List journal entries', async () => {
    const r = await api(token, '/accounting/journal');
    assert(r.success, 'List journal entries should succeed');
    assert(Array.isArray(r.data.items), 'Should have items array');
  });

  // ─── 3. Vouchers ────────────────────────────────────────────────
  console.log('\n── Vouchers ──');
  await test('Create payment voucher', async () => {
    const r = await api(token, '/accounting/vouchers', {
      method: 'POST', body: JSON.stringify({
        voucher_type: 'PAYMENT',
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

  await test('Create unbalanced voucher (should fail)', async () => {
    const r = await api(token, '/accounting/vouchers', {
      method: 'POST', body: JSON.stringify({
        voucher_type: 'PAYMENT',
        entry_date: '2024-09-05',
        description: 'Test',
        lines: [
          { account_id: 'acc_cash', debit_amount: 50000, credit_amount: 0 },
          { account_id: 'acc_sales', debit_amount: 0, credit_amount: 30000 }
        ]
      })
    });
    assert(!r.success, 'Unbalanced voucher should be rejected');
  });

  // ─── 4. Bills (Receivables/Payables) ────────────────────────────
  console.log('\n── Bills ──');
  await test('Create customer bill', async () => {
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

  await test('List receivables', async () => {
    const r = await api(token, '/accounting/receivables');
    assert(r.success, 'List receivables should succeed');
  });

  await test('Receivables summary', async () => {
    const r = await api(token, '/accounting/receivables/summary');
    assert(r.success, 'Receivables summary should succeed');
  });

  // ─── 5. Payments & Outstanding ────────────────────────────────────
  console.log('\n── Payments & Outstanding ──');
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

  await test('Verify outstanding after partial payment', async () => {
    const r = await api(token, '/accounting/receivables/summary');
    assert(r.success, 'Summary should succeed');
    const total = r.data.totalOutstanding;
    assert(total > 0, 'Should have outstanding amount after partial payment');
  });

  // ─── 6. Cost Centres, Budgets, Bank Accounts, Financial Years ───
  console.log('\n── Masters ──');
  await test('Create cost centre', async () => {
    const r = await api(token, '/accounting/cost-centres', {
      method: 'POST', body: JSON.stringify({
        code: 'CC01_' + String(Date.now()).slice(-6), name: 'Main Office', description: 'Primary office'
      })
    });
    assert(r.success, 'Create cost centre should succeed');
    costCentreId = r.data.id;
  });

  await test('Create financial year', async () => {
    const r = await api(token, '/accounting/financial-years', {
      method: 'POST', body: JSON.stringify({
        name: 'FY' + Date.now(), start_date: '2024-04-01', end_date: '2025-03-31'
      })
    });
    assert(r.success, 'Create financial year should succeed');
    fyId = r.data.id;
  });

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

  // ─── 7. Financial Reports ───────────────────────────────────────
  console.log('\n── Financial Reports ──');
  await test('Day Book', async () => {
    const r = await api(token, '/accounting/reports/day-book');
    assert(r.success, 'Day book should succeed');
    assert(Array.isArray(r.data.items), 'Should have entries');
  });

  await test('Trial Balance', async () => {
    const r = await api(token, '/accounting/reports/trial-balance');
    assert(r.success, 'Trial balance should succeed');
    assert(r.data.totalDebit === r.data.totalCredit, 'Debit should equal Credit');
  });

  await test('Ledger', async () => {
    const r = await api(token, '/accounting/reports/ledger?accountId=acc_cash');
    assert(r.success, 'Ledger should succeed');
    assert(Array.isArray(r.data.items), 'Should have entries');
  });

  await test('Profit & Loss', async () => {
    const r = await api(token, '/accounting/reports/profit-loss');
    assert(r.success, 'P&L should succeed');
  });

  await test('Balance Sheet', async () => {
    const r = await api(token, '/accounting/reports/balance-sheet');
    assert(r.success, 'Balance sheet should succeed');
  });

  await test('Cash Flow', async () => {
    const r = await api(token, '/accounting/reports/cash-flow');
    assert(r.success, 'Cash flow should succeed');
  });

  await test('Ratio Analysis', async () => {
    const r = await api(token, '/accounting/reports/ratios');
    assert(r.success, 'Ratios should succeed');
  });

  await test('Dashboard', async () => {
    const r = await api(token, '/accounting/dashboard');
    assert(r.success, 'Accounting dashboard should succeed');
  });

  // ─── 8. Outstanding / Aging ──────────────────────────────────────
  console.log('\n── Outstanding & Aging ──');
  await test('Aging report', async () => {
    const r = await api(token, '/accounting/outstanding');
    assert(r.success, 'Aging report should succeed');
    assert(r.data.receivables, 'Should have aging buckets');
  });

  // ─── 9. Voucher Cancel/Reverse ──────────────────────────────────
  console.log('\n── Voucher Actions ──');
  await test('Cancel voucher', async () => {
    const r = await api(token, '/accounting/vouchers');
    assert(r.success, 'Should list vouchers');
    if (r.data.items && r.data.items.length > 0) {
      const cancelR = await api(token, '/accounting/vouchers/' + r.data.items[0].id + '/cancel', { method: 'POST' });
      assert(cancelR.success, 'Cancel voucher should succeed');
    }
  });

  // ─── 10. Persistence ────────────────────────────────────────────
  console.log('\n── Persistence ──');
  await test('Data survives list (in-memory check)', async () => {
    const r = await api(token, '/accounting/journal');
    assert(r.success, 'Journal entries should persist');
    assert(r.data.items.length > 0, 'Should have journal entries');
  });

  // ─── Summary ─────────────────────────────────────────────────────
  console.log('\n========================================');
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
  process.exit(1);
});
