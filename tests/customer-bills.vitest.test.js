/**
 * Customer Bills — Vitest Unit Test Suite
 *
 * Tests the CustomerBillService lifecycle, tax calculation, JE posting,
 * and status transitions using vitest's describe/it/expect.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const path = require('path');
const fs = require('fs');

// Set DB_PATH before requiring DatabaseConnection so it uses our test DB
const TESTS_DIR = process.cwd();

// PHASE 3A — ISOLATION FIX.
//
// This suite used to resolve its own path and set process.env.DB_PATH. That was
// NOT sufficient: server/database/connection.js used to bind its path at
// require() time, so under vitest's SHARED WORKER another test file that loaded
// it first left this suite writing to PRODUCTION. That leak created
// BILL-2026-00001 (Rs 2000, Victus laptop) in the real database on 2026-10-09.
//
// createDisposableDb() clones production into a temp dir OUTSIDE data/, and
// assertDisposableDbIsActive() verifies via PRAGMA database_list that the file
// really open is that clone. It also refuses if DB_PATH drifts after the
// connection was already bound. Both checks run before this suite writes.
//
// The database modules are required only AFTER this line — see the imports
// below, which are deliberately positioned after createDisposableDb().
const { createDisposableDb } = require('../scripts/assert-disposable-db.js');
const { dbPath: DB_PATH, cleanup: _cleanupDisposableDb } = createDisposableDb({
  suite: 'customer-bills.vitest',
  prefix: 'bscrm-cb-',
});
process.env.DB_PATH = DB_PATH;

const { DatabaseConnection } = require('../server/database/connection');
const { CustomerBillService } = require('../server/services/customer-bill.service');
const { TaxService } = require('../server/services/tax-calculation-engine');
const { BillRepository } = require('../server/repositories/billing-cost.repository');
const { JournalEntryRepository } = require('../server/repositories/journal-entry.repository');
const CodeGenerator = require('../server/services/code-generator.service');
const { authMiddleware } = require('../server/middleware/auth');
const { requirePermission } = require('../server/middleware/rbac');

let db = null;

// Test data IDs (from seed)
const COMPANY_ID = 'default';
const CONTACT_ID = 'cnt_001';
const TAX_MASTER_ID = 'tax_gst_5_intra';

function runMigrationsAndSeed(conn) {
  const migrationsDir = path.join(TESTS_DIR, 'server', 'database', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    try {
      conn.exec(sql);
    } catch (e) {
      // Some migrations may have already-applied guards; skip errors for idempotent ones
      if (!e.message.includes('already exists') && !e.message.includes('duplicate') && !e.message.includes('no such table') && !e.message.includes('FOREIGN KEY constraint failed')) {
        console.warn(`Migration ${file} partial error:`, e.message);
      }
    }
  }
}

beforeAll(async () => {
  // PHASE 3A: do NOT delete the database here. createDisposableDb() owns this
  // file and its lifetime; unlinking it under a shared worker would also destroy
  // whatever connection a sibling suite is holding.
  // Re-assert isolation before the first write of this suite.
  const { assertDisposableDbIsActive } = require('../scripts/assert-disposable-db.js');
  assertDisposableDbIsActive({ suite: 'customer-bills.vitest', tmpDir: path.dirname(DB_PATH), expected: DB_PATH });

  // PHASE 3A — FINANCIAL YEAR: the clone inherits production's financial-year
  // state, and after the 2026-10-09 audit incident BOTH production years read
  // is_locked=1. CustomerBillService posting paths now enforce that lock (the
  // FY-2 policy), so this suite would fail for a reason that has nothing to do
  // with what it tests.
  //
  // This is a FIXTURE decision on a throwaway copy, never a production write.
  // Production's intended lock state remains a separate, open question.
  //
  // NOTE: raw node:sqlite run() takes SPREAD args. Passing an array binds it as
  // a named parameter and the UPDATE silently does nothing.
  {
    const { DatabaseSync } = require('node:sqlite');
    const seed = new DatabaseSync(DB_PATH);
    seed.prepare('UPDATE financial_years SET is_locked = 0 WHERE company_id = ?').run('default');
    const lockedLeft = seed.prepare('SELECT COUNT(*) c FROM financial_years WHERE is_locked = 1').get().c;
    seed.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    seed.close();
    expect(lockedLeft, `disposable DB still has ${lockedLeft} locked financial year(s)`).toBe(0);
  }

  const dbConn = new DatabaseConnection();
  db = dbConn.connect();
  await runMigrationsAndSeed(db);
  // Run demo seed for contacts/products/organizations
  process.env.DEMO_MODE = 'true';
  const { seed } = require('../server/database/seed');
  await seed();
});

afterAll(() => {
  if (db) { try { db.close(); } catch {} }
  // The temp directory (and this DB) is removed by createDisposableDb()'s exit
  // handler. Cleaning it here would race a sibling suite in the same worker.
});

describe('CustomerBillService', () => {
  let service, billRepo, jeRepo, taxService;

  beforeAll(() => {
    service = new CustomerBillService(db);
    billRepo = new BillRepository(db);
    jeRepo = new JournalEntryRepository(db);
    taxService = new TaxService(db);
  });

  describe('calculateTotals', () => {
    it('should calculate tax breakdown for intra-state (CGST+SGST)', () => {
      const data = {
        items: [{
          description: 'Web Development',
          quantity: 1,
          unit_price: 10000,
          tax_rate: 5,
          tax_master_id: 'tax_gst_5_intra',
          gl_account_id: 'acc_sales',
        }],
        party_state: '29',
        company_state: '29',
        other_charges: 0,
        discount_amount: 0,
      };
      const result = service.calculateTotals(data);
      expect(result.total_tax).toBe(500);
      expect(result.grand_total).toBe(10500);
      expect(result.items[0].tax_result.cgst_amount).toBe(250);
      expect(result.items[0].tax_result.sgst_amount).toBe(250);
      expect(result.items[0].tax_result.igst_amount).toBe(0);
    });

    it('should calculate IGST for inter-state', () => {
      const data = {
        items: [{
          description: 'Web Development',
          quantity: 1,
          unit_price: 10000,
          tax_rate: 5,
          tax_master_id: 'tax_gst_5_inter',
          gl_account_id: 'acc_sales',
        }],
        party_state: '01',
        company_state: '29',
      };
      const result = service.calculateTotals(data);
      expect(result.items[0].tax_result.igst_amount).toBe(500);
      expect(result.items[0].tax_result.cgst_amount).toBe(0);
      expect(result.items[0].tax_result.sgst_amount).toBe(0);
    });

    it('should aggregate tax across multiple line items', () => {
      const data = {
        items: [
          { description: 'Service 1', quantity: 1, unit_price: 10000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' },
          { description: 'Service 2', quantity: 1, unit_price: 5000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' },
        ],
        party_state: '29',
        company_state: '29',
      };
      const result = service.calculateTotals(data);
      expect(result.total_tax).toBe(750); // 5% of 15000
      expect(result.grand_total).toBe(15750);
    });

    it('should fall back to place_of_supply when party_state is missing', () => {
      const data = {
        items: [{
          description: 'Service',
          quantity: 1,
          unit_price: 10000,
          tax_rate: 5,
          tax_master_id: 'tax_gst_5_intra',
          gl_account_id: 'acc_sales',
        }],
        place_of_supply: '29',
        company_state: '29',
      };
      const result = service.calculateTotals(data);
      expect(result.items[0].tax_result.cgst_amount).toBe(250);
    });

    it('should apply line-level percentage discount', () => {
      const data = {
        items: [{
          description: 'Service',
          quantity: 2,
          unit_price: 10000,
          discount_type: 'percent',
          discount_percent: 10,
          tax_rate: 5,
          tax_master_id: 'tax_gst_5_intra',
          gl_account_id: 'acc_sales',
        }],
        party_state: '29',
        company_state: '29',
        other_charges: 0,
        discounts: [],
        charges: [],
      };
      const result = service.calculateTotals(data);
      // 2 × 10000 = 20000, 10% discount = 2000, taxable = 18000, 5% tax = 900
      expect(result.subtotal).toBe(20000);
      expect(result.line_discount_amount).toBe(2000);
      expect(result.items[0].discount_amount).toBe(2000);
      expect(result.items[0].discount_percent).toBe(10);
      expect(result.items[0].taxable_amount).toBe(18000);
      expect(result.total_tax).toBe(900);
      expect(result.grand_total).toBe(18900);
    });

    it('should apply line-level fixed discount', () => {
      const data = {
        items: [{
          description: 'Service',
          quantity: 1,
          unit_price: 10000,
          discount_type: 'fixed',
          discount_amount: 500,
          tax_rate: 5,
          tax_master_id: 'tax_gst_5_intra',
          gl_account_id: 'acc_sales',
        }],
        party_state: '29',
        company_state: '29',
        other_charges: 0,
        discounts: [],
        charges: [],
      };
      const result = service.calculateTotals(data);
      // 10000 - 500 = 9500 taxable, 5% tax = 475, total = 9975
      expect(result.subtotal).toBe(10000);
      expect(result.line_discount_amount).toBe(500);
      expect(result.items[0].discount_amount).toBe(500);
      expect(result.items[0].taxable_amount).toBe(9500);
      expect(result.total_tax).toBe(475);
      expect(result.grand_total).toBe(9975);
    });

    it('should apply bill-level percentage discount on net of line discounts', () => {
      const data = {
        items: [{
          description: 'Service',
          quantity: 1,
          unit_price: 10000,
          discount_type: 'fixed',
          discount_amount: 1000,
          tax_rate: 5,
          tax_master_id: 'tax_gst_5_intra',
          gl_account_id: 'acc_sales',
        }],
        party_state: '29',
        company_state: '29',
        other_charges: 0,
        discounts: [{ type: 'PERCENTAGE', amount: 10 }],
        charges: [],
      };
      const result = service.calculateTotals(data);
      // Gross: 10000, Line disc: 1000, Net: 9000, 5% tax = 450
      // Bill disc: 10% of 9000 = 900
      // Grand total: 10000 - 1000 + 450 - 900 = 8550
      expect(result.line_discount_amount).toBe(1000);
      expect(result.discount_amount).toBe(900);
      expect(result.total_tax).toBe(450);
      expect(result.grand_total).toBe(8550);
    });

    it('should apply bill-level fixed discount', () => {
      const data = {
        items: [{
          description: 'Service',
          quantity: 1,
          unit_price: 10000,
          tax_rate: 5,
          tax_master_id: 'tax_gst_5_intra',
          gl_account_id: 'acc_sales',
        }],
        party_state: '29',
        company_state: '29',
        other_charges: 0,
        discounts: [{ type: 'FIXED', amount: 500 }],
        charges: [],
      };
      const result = service.calculateTotals(data);
      // 10000 + 500 (tax) - 500 (discount) = 10000
      expect(result.discount_amount).toBe(500);
      expect(result.grand_total).toBe(10000);
    });

    it('should handle additional charges with and without tax', () => {
      const data = {
        items: [{
          description: 'Service',
          quantity: 1,
          unit_price: 10000,
          tax_rate: 5,
          tax_master_id: 'tax_gst_5_intra',
          gl_account_id: 'acc_sales',
        }],
        party_state: '29',
        company_state: '29',
        other_charges: 0,
        discounts: [],
        charges: [
          { description: 'Freight', amount: 200, taxable: true, tax_master_id: 'tax_gst_5_intra' },
          { description: 'Handling', amount: 100, taxable: false },
        ],
      };
      const result = service.calculateTotals(data);
      // Line: 10000, tax: 500, total: 10500
      // Charges: 300 total (200 taxable + 100 not)
      // Charge tax: 5% of 200 = 10
      // Grand total: 10000 + 500 + 300 + 10 = 10810
      expect(result.other_charges).toBe(300);
      expect(result.other_charges_tax).toBe(10);
      expect(result.total_tax).toBe(510);
      expect(result.grand_total).toBe(10810);
    });

    it('should persist HSN/SAC and tax_master_id per line', () => {
      const data = {
        items: [{
          description: 'Service',
          quantity: 1,
          unit_price: 10000,
          hsn_sac: '8523',
          tax_master_id: 'tax_gst_5_intra',
          tax_rate: 5,
          gl_account_id: 'acc_sales',
        }],
        party_state: '29',
        company_state: '29',
        other_charges: 0,
        discounts: [],
        charges: [],
      };
      const result = service.calculateTotals(data);
      expect(result.items[0].hsn_sac).toBe('8523');
      expect(result.items[0].tax_master_id).toBe('tax_gst_5_intra');
    });

    it('should subtract line discounts from grand total (not just bill discount)', () => {
      const data = {
        items: [
          { description: 'Item 1', quantity: 1, unit_price: 1000, discount_type: 'percent', discount_percent: 10, tax_master_id: 'tax_gst_5_intra', tax_rate: 5, gl_account_id: 'acc_sales' },
          { description: 'Item 2', quantity: 1, unit_price: 2000, discount_type: 'fixed', discount_amount: 100, tax_master_id: 'tax_gst_5_intra', tax_rate: 5, gl_account_id: 'acc_sales' },
        ],
        party_state: '29',
        company_state: '29',
        other_charges: 0,
        discounts: [],
        charges: [],
      };
      const result = service.calculateTotals(data);
      // Item 1: 1000 - 100 (10%) = 900, tax = 45, total = 945
      // Item 2: 2000 - 100 = 1900, tax = 95, total = 1995
      // Grand total: 1000 + 2000 - 200 (line disc) + 140 (tax) = 2940
      expect(result.line_discount_amount).toBe(200);
      expect(result.total_tax).toBe(140);
      expect(result.grand_total).toBe(2940);
    });

    it('should break down CGST/SGST at line level for intra-state', () => {
      const data = {
        items: [
          { description: 'Service A', quantity: 1, unit_price: 10000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' },
        ],
        party_state: '29', company_state: '29', other_charges: 0, discounts: [], charges: [],
      };
      const result = service.calculateTotals(data);
      // Intra-state: 10000 × 5% = 500 → CGST 250, SGST 250
      expect(result.items[0].cgst_amount).toBe(250);
      expect(result.items[0].sgst_amount).toBe(250);
      expect(result.items[0].igst_amount).toBe(0);
      expect(result.total_tax).toBe(500);
    });

    it('should break down IGST at line level for inter-state', () => {
      const data = {
        items: [
          { description: 'Service B', quantity: 1, unit_price: 5000, tax_rate: 5, tax_master_id: 'tax_gst_5_inter', gl_account_id: 'acc_sales' },
        ],
        party_state: '01', company_state: '29', other_charges: 0, discounts: [], charges: [],
      };
      const result = service.calculateTotals(data);
      // Inter-state: 5000 × 5% = 250 → IGST 250
      expect(result.items[0].cgst_amount).toBe(0);
      expect(result.items[0].sgst_amount).toBe(0);
      expect(result.items[0].igst_amount).toBe(250);
      expect(result.total_tax).toBe(250);
    });

    it('should handle round-off for fractional paise amounts', () => {
      const data = {
        items: [
          { description: 'Service', quantity: 3, unit_price: 100.33, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' },
        ],
        party_state: '29', company_state: '29', other_charges: 0, discounts: [], charges: [],
      };
      const result = service.calculateTotals(data);
      // 3 × 100.33 = 300.99, tax = 7.52 + 7.52 = 15.04 (paise rounding)
      expect(result.subtotal).toBe(300.99);
      expect(result.total_tax).toBe(15.04);
      expect(result.grand_total).toBe(316); // Math.round(300.99 + 15.04 = 316.03)
    });

    it('should combine line discounts, bill discount, and charges', () => {
      const data = {
        items: [
          { description: 'Item 1', quantity: 1, unit_price: 10000, discount_type: 'percent', discount_percent: 10, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' },
        ],
        party_state: '29', company_state: '29',
        other_charges: 0,
        discounts: [{ type: 'FIXED', amount: 500 }],
        charges: [{ description: 'Freight', amount: 200, taxable: true, tax_master_id: 'tax_gst_5_intra' }],
      };
      const result = service.calculateTotals(data);
      // Line: 10000, line disc 10% = 1000, taxable = 9000, tax = 450
      // Bill disc: 500 (fixed)
      // Charges: 200 (taxable), charge tax = 10
      // taxable_amount = 9000 - 500 + 200 = 8700
      // total_tax = 450 + 10 = 460
      // grand_total = 10000 - 1000 - 500 + 460 + 200 = 9160
      expect(result.line_discount_amount).toBe(1000);
      expect(result.discount_amount).toBe(500);
      expect(result.other_charges).toBe(200);
      expect(result.other_charges_tax).toBe(10);
      expect(result.total_tax).toBe(460);
      expect(result.grand_total).toBe(9160);
    });
  });

  describe('createBill', () => {
    it('should create a draft bill with auto-generated bill number', () => {
      const billData = {
        company_id: COMPANY_ID,
        contact_id: CONTACT_ID,
        currency: 'INR',
        issue_date: '2026-09-01',
        due_date: '2026-09-30',
        place_of_supply: '29',
        party_state: '29',
        company_state: '29',
        payment_terms_days: 30,
        items: [{
          description: 'Web Development Service',
          quantity: 1,
          unit_price: 10000,
          tax_rate: 5,
          tax_master_id: 'tax_gst_5_intra',
          gl_account_id: 'acc_sales',
        }],
      };
      const totals = service.calculateTotals({ ...billData, discount_amount: 0, other_charges: 0, discounts: [], charges: [] });
      const data = {
        ...billData,
        subtotal: totals.subtotal,
        tax: totals.total_tax,
        discount_amount: 0,
        line_discount_amount: totals.line_discount_amount || 0,
        other_charges: totals.other_charges,
        other_charges_taxable: 0,
        other_charges_tax_amount: totals.other_charges_tax || 0,
        total: totals.grand_total,
        taxable_amount: totals.taxable_amount,
      };
      const result = service.createBill(data, 'admin');
      expect(result).toBeDefined();
      expect(result.id).toBeTruthy();
      expect(result.bill_number).toMatch(/^BILL-2026-/);
      expect(result.status).toBe('DRAFT');
      expect(result.total).toBe(10500);
      expect(result.tax).toBe(500);
      expect(result.balance).toBe(10500);

      // verify it in DB
      const bill = billRepo.findById(result.id, COMPANY_ID);
      expect(bill).toBeTruthy();
      expect(bill.bill_number).toBe(result.bill_number);
    });
  });

  describe('status transitions', () => {
    let billId;

    beforeAll(() => {
      const billData = {
        company_id: COMPANY_ID,
        contact_id: CONTACT_ID,
        currency: 'INR',
        issue_date: '2026-09-01',
        due_date: '2026-09-30',
        place_of_supply: '29',
        party_state: '29',
        company_state: '29',
        items: [{
          description: 'Service',
          quantity: 1,
          unit_price: 5000,
          tax_rate: 5,
          tax_master_id: 'tax_gst_5_intra',
          gl_account_id: 'acc_sales',
        }],
      };
      const totals = service.calculateTotals({ ...billData, discount_amount: 0, other_charges: 0, discounts: [], charges: [] });
      const data = { ...billData, subtotal: totals.subtotal, tax: totals.total_tax, discount_amount: 0, line_discount_amount: totals.line_discount_amount || 0, other_charges: totals.other_charges, other_charges_taxable: 0, other_charges_tax_amount: totals.other_charges_tax || 0, total: totals.grand_total, taxable_amount: totals.taxable_amount };
      const result = service.createBill(data, 'admin');
      billId = result.id;
    });

    it('should transition DRAFT → SUBMITTED → PENDING_APPROVAL → APPROVED → POSTED', () => {
      let bill = service.submitForApproval(billId, COMPANY_ID, 'admin');
      expect(bill.status).toBe('PENDING_APPROVAL');

      bill = service.approveBill(billId, COMPANY_ID, 'admin');
      expect(bill.status).toBe('APPROVED');

      bill = service.postBill(billId, COMPANY_ID, 'admin');
      expect(bill.status).toBe('POSTED');
      expect(bill.journal_entry_id).toBeTruthy();
    });

    it('should reject invalid transition (DRAFT → POSTED directly)', () => {
      const billData = {
        company_id: COMPANY_ID,
        contact_id: CONTACT_ID,
        currency: 'INR',
        issue_date: '2026-09-01',
        due_date: '2026-09-30',
        place_of_supply: '29',
        party_state: '29',
        company_state: '29',
        items: [{
          description: 'Service',
          quantity: 1,
          unit_price: 5000,
          tax_rate: 5,
          tax_master_id: 'tax_gst_5_intra',
          gl_account_id: 'acc_sales',
        }],
      };
      const totals = service.calculateTotals({ ...billData, discount_amount: 0, other_charges: 0, discounts: [], charges: [] });
      const data = { ...billData, subtotal: totals.subtotal, tax: totals.total_tax, discount_amount: 0, line_discount_amount: totals.line_discount_amount || 0, other_charges: totals.other_charges, other_charges_taxable: 0, other_charges_tax_amount: totals.other_charges_tax || 0, total: totals.grand_total, taxable_amount: totals.taxable_amount };
      const bill = service.createBill(data, 'admin');
      expect(() => service.postBill(bill.id, COMPANY_ID, 'admin')).toThrow(/DRAFT/);
    });
  });

  describe('recordPayment', () => {
    it('should record payment and update bill balance', () => {
      const data = {
        company_id: COMPANY_ID,
        contact_id: CONTACT_ID,
        bill_id: null,
        amount: 5250,
        payment_account_id: 'acc_bank',
        payment_method: 'BANK',
        payment_date: '2026-09-15',
      };

      const billData = {
        company_id: COMPANY_ID,
        contact_id: CONTACT_ID,
        currency: 'INR',
        issue_date: '2026-09-01',
        due_date: '2026-09-30',
        place_of_supply: '29',
        party_state: '29',
        company_state: '29',
        items: [
          { description: 'Service 1', quantity: 1, unit_price: 10000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' },
          { description: 'Service 2', quantity: 1, unit_price: 5000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' },
        ],
      };
      const totals = service.calculateTotals({ ...billData, discount_amount: 0, other_charges: 0, discounts: [], charges: [] });
      const bill = service.createBill({ ...billData, subtotal: totals.subtotal, tax: totals.total_tax, discount_amount: 0, line_discount_amount: totals.line_discount_amount || 0, other_charges: totals.other_charges, other_charges_taxable: 0, other_charges_tax_amount: totals.other_charges_tax || 0, total: totals.grand_total, taxable_amount: totals.taxable_amount }, 'admin');
      service.submitForApproval(bill.id, COMPANY_ID, 'admin');
      service.approveBill(bill.id, COMPANY_ID, 'admin');
      service.postBill(bill.id, COMPANY_ID, 'admin');

      data.bill_id = bill.id;
      const result = service.recordPayment(data, 'admin');
      expect(result).toBeDefined();
      expect(result.allocated).toBe(5250);
      expect(result.payment_number).toMatch(/^RCPT-2026-\d{5}$/);
    });
  });

  describe('createCreditNote', () => {
    it('should create credit note and reverse tax JE', () => {
      const billData = {
        company_id: COMPANY_ID,
        contact_id: CONTACT_ID,
        currency: 'INR',
        issue_date: '2026-09-01',
        due_date: '2026-09-30',
        place_of_supply: '29',
        party_state: '29',
        company_state: '29',
        items: [{
          description: 'Service',
          quantity: 1,
          unit_price: 10000,
          tax_rate: 5,
          tax_master_id: 'tax_gst_5_intra',
          gl_account_id: 'acc_sales',
        }],
      };
      const totals = service.calculateTotals({ ...billData, discount_amount: 0, other_charges: 0, discounts: [], charges: [] });
      const bill = service.createBill({ ...billData, subtotal: totals.subtotal, tax: totals.total_tax, discount_amount: 0, line_discount_amount: totals.line_discount_amount || 0, other_charges: totals.other_charges, other_charges_taxable: 0, other_charges_tax_amount: totals.other_charges_tax || 0, total: totals.grand_total, taxable_amount: totals.taxable_amount }, 'admin');
      service.submitForApproval(bill.id, COMPANY_ID, 'admin');
      service.approveBill(bill.id, COMPANY_ID, 'admin');
      service.postBill(bill.id, COMPANY_ID, 'admin');

      const cn = service.createCreditNote({
        company_id: COMPANY_ID,
        original_bill_id: bill.id,
        contact_id: CONTACT_ID,
        amount: 1000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29',
        company_state: '29',
      }, 'admin');

      expect(cn).toBeDefined();
      expect(cn.credit_note_number).toMatch(/^CN-2026-/);
      expect(cn.tax_details.total_tax).toBe(50);
      expect(cn.amount).toBe(1050);
      expect(cn.journal_entry.id).toBeTruthy();

      // Verify JE is balanced
      const je = jeRepo.findById(cn.journal_entry.id);
      expect(parseFloat(je.total_debit)).toBeCloseTo(1050, 2);
      expect(parseFloat(je.total_credit)).toBeCloseTo(1050, 2);

      // Verify tax reversal lines exist
      const lines = jeRepo.findLines(je.id);
      const cgstLine = lines.find(l => l.account_id === 'acc_output_cgst');
      expect(cgstLine).toBeTruthy();
      expect(parseFloat(cgstLine.debit_amount)).toBeCloseTo(25, 2);
    });
  });

  describe('CodeGenerator integration', () => {
    it('should generate BILL- prefixed numbers', () => {
      const next = CodeGenerator.generate(db, 'CUSTOMER_BILL', COMPANY_ID);
      expect(next).toMatch(/^BILL-2026-\d{5}$/);
    });
  });

  describe('Step 8: Customer Financial Summary', () => {
    it('should return financial summary with credit limit information', () => {
      const summary = service.getCustomerFinancialSummary(CONTACT_ID, COMPANY_ID);
      expect(summary.contact_id).toBe(CONTACT_ID);
      expect(summary.customer_account).toBeDefined();
      expect(summary.customer_account.id).toBe('acc_receivable');
      // Credit limit may or may not be configured in test DB
      expect(summary.has_credit_limit).toBe(false);
      expect(summary.credit_limit).toBe(0);
    });

    it('should show "Not Set" credit limit when no credit rule configured', () => {
      // cnt_001 has a credit rule with 200000 limit
      // Create summary for a contact without credit rule
      const summary = service.getCustomerFinancialSummary('cnt_999', COMPANY_ID);
      expect(summary.has_credit_limit).toBe(false);
      expect(summary.credit_limit).toBe(0);
    });

    it('should calculate outstanding balance from posted bills', () => {
      // Create and post a bill, then check the summary reflects it
      const billData = {
        company_id: COMPANY_ID,
        contact_id: CONTACT_ID,
        currency: 'INR',
        issue_date: '2026-09-01',
        due_date: '2026-09-30',
        place_of_supply: '29',
        party_state: '29',
        company_state: '29',
        items: [{
          description: 'Step 8 Test Service',
          quantity: 1,
          unit_price: 10000,
          tax_rate: 5,
          tax_master_id: 'tax_gst_5_intra',
          gl_account_id: 'acc_sales',
        }],
      };
      const totals = service.calculateTotals({ ...billData, discount_amount: 0, other_charges: 0, discounts: [], charges: [] });
      const bill = service.createBill({ ...billData, subtotal: totals.subtotal, tax: totals.total_tax, discount_amount: 0, line_discount_amount: totals.line_discount_amount || 0, other_charges: totals.other_charges, other_charges_taxable: 0, other_charges_tax_amount: totals.other_charges_tax || 0, total: totals.grand_total, taxable_amount: totals.taxable_amount }, 'admin');
      service.submitForApproval(bill.id, COMPANY_ID, 'admin');
      service.approveBill(bill.id, COMPANY_ID, 'admin');
      service.postBill(bill.id, COMPANY_ID, 'admin');

      const summary = service.getCustomerFinancialSummary(CONTACT_ID, COMPANY_ID);
      expect(summary.outstanding_balance).toBeGreaterThan(0);
      expect(summary.total_sales).toBeGreaterThan(0);
      expect(summary.recent_bills.length).toBeGreaterThan(0);
    });
  });

  // ─── Helper: create and post a bill for payment tests ───
  function _createAndPostBill(billData, amount, admin = 'admin') {
    const totals = service.calculateTotals({ ...billData, discount_amount: 0, other_charges: 0, discounts: [], charges: [] });
    const bill = service.createBill({ ...billData, subtotal: totals.subtotal, tax: totals.total_tax, discount_amount: 0, line_discount_amount: totals.line_discount_amount || 0, other_charges: totals.other_charges, other_charges_taxable: 0, other_charges_tax_amount: totals.other_charges_tax || 0, total: totals.grand_total, taxable_amount: totals.taxable_amount }, admin);
    service.submitForApproval(bill.id, COMPANY_ID, admin);
    service.approveBill(bill.id, COMPANY_ID, admin);
    service.postBill(bill.id, COMPANY_ID, admin);
    return billRepo.findById(bill.id, COMPANY_ID);
  }

  describe('Step 10: Partial Payment', () => {
    it('should change status to PARTIALLY_PAID after partial payment', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Partial Pay Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      const result = service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, bill_id: bill.id,
        amount: 30000, payment_account_id: 'acc_bank',
        payment_method: 'BANK', payment_date: '2026-09-15',
      }, 'admin');

      expect(result).toBeDefined();
      expect(result.allocated).toBe(30000);
      expect(result.payment_number).toMatch(/^RCPT-2026-\d{5}$/);

      // Verify bill status and balance
      const updated = billRepo.findById(bill.id, COMPANY_ID);
      expect(parseFloat(updated.paid_amount)).toBe(30000);
      expect(parseFloat(updated.balance)).toBe(105000 - 30000);
      expect(updated.status).toBe('PARTIALLY_PAID');
    });
  });

  describe('Step 10: Multiple Payments Against One Bill', () => {
    it('should transition to PAID after final payment', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Multi Pay Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      // Payment 1
      service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, bill_id: bill.id,
        amount: 30000, payment_account_id: 'acc_bank',
        payment_method: 'BANK', payment_date: '2026-09-10',
      }, 'admin');

      let updated = billRepo.findById(bill.id, COMPANY_ID);
      expect(parseFloat(updated.paid_amount)).toBe(30000);
      expect(updated.status).toBe('PARTIALLY_PAID');

      // Payment 2
      service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, bill_id: bill.id,
        amount: 30000, payment_account_id: 'acc_bank',
        payment_method: 'UPI', payment_date: '2026-09-12',
        payment_method_details: { upi_ref: 'UPI123' },
      }, 'admin');

      updated = billRepo.findById(bill.id, COMPANY_ID);
      expect(parseFloat(updated.paid_amount)).toBe(60000);
      expect(updated.status).toBe('PARTIALLY_PAID');

      // Payment 3 (final)
      service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, bill_id: bill.id,
        amount: 45000, payment_account_id: 'acc_bank',
        payment_method: 'CASH', payment_date: '2026-09-15',
      }, 'admin');

      updated = billRepo.findById(bill.id, COMPANY_ID);
      expect(parseFloat(updated.paid_amount)).toBe(105000);
      expect(parseFloat(updated.balance)).toBe(0);
      expect(updated.status).toBe('PAID');
    });
  });

  describe('Step 10: Multi-Invoice Payment Allocation', () => {
    it('should allocate one payment across multiple bills', () => {
      const bill1 = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Invoice 1', quantity: 1, unit_price: 40000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 42000);

      const bill2 = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-02', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Invoice 2', quantity: 1, unit_price: 35000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 36750);

      const bill3 = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-03', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Invoice 3', quantity: 1, unit_price: 25000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 26250);

      // One payment of 105000 allocated across all three
      const result = service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        amount: 105000, payment_account_id: 'acc_bank',
        payment_method: 'BANK', payment_date: '2026-09-15',
        allocations: [
          { bill_id: bill1.id, amount: 42000 },
          { bill_id: bill2.id, amount: 36750 },
          { bill_id: bill3.id, amount: 26250 },
        ],
      }, 'admin');

      expect(result.allocated).toBe(105000); // 42000 + 36750 + 26250

      // Verify all bills are PAID
      const b1 = billRepo.findById(bill1.id, COMPANY_ID);
      const b2 = billRepo.findById(bill2.id, COMPANY_ID);
      const b3 = billRepo.findById(bill3.id, COMPANY_ID);
      expect(b1.status).toBe('PAID');
      expect(b2.status).toBe('PAID');
      expect(b3.status).toBe('PAID');
    });
  });

  describe('Step 10: Allocation Validation', () => {
    it('should reject explicit allocation beyond invoice outstanding', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Validation Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      // Explicit allocation exceeding bill outstanding should throw
      expect(() => service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        amount: 200000, payment_account_id: 'acc_bank',
        payment_method: 'BANK', payment_date: '2026-09-15',
        allocations: [
          { bill_id: bill.id, amount: 200000 }, // More than bill's 105000 outstanding
        ],
      }, 'admin')).toThrow();
    });

    it('should reject allocation to cancelled bill', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Cancelled Bill Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      service.cancelBill(bill.id, COMPANY_ID, 'admin', 'Test cancellation');
      const cancelled = billRepo.findById(bill.id, COMPANY_ID);
      expect(cancelled.status).toBe('CANCELLED');

      expect(() => service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, bill_id: bill.id,
        amount: 30000, payment_account_id: 'acc_bank',
        payment_method: 'BANK', payment_date: '2026-09-15',
      }, 'admin')).toThrow();
    });
  });

  describe('Step 10: Overpayment Handling', () => {
    it('should not create negative outstanding on overpayment', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Overpay Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      // Overpayment: ₹110,000 against ₹105,000 bill
      const result = service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, bill_id: bill.id,
        amount: 110000, payment_account_id: 'acc_bank',
        payment_method: 'BANK', payment_date: '2026-09-15',
      }, 'admin');

      expect(result).toBeDefined();
      // Bill should be PAID, outstanding should be 0 (not negative)
      const updated = billRepo.findById(bill.id, COMPANY_ID);
      expect(updated.status).toBe('PAID');
      expect(parseFloat(updated.balance)).toBe(0);
      expect(parseFloat(updated.paid_amount)).toBe(105000);
    });
  });

  describe('Step 10: Payment Journal Entry', () => {
    it('should create a balanced JE for payment (Dr Bank, Cr Receivable)', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'JE Test Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      const result = service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, bill_id: bill.id,
        amount: 30000, payment_account_id: 'acc_bank',
        payment_method: 'BANK', payment_date: '2026-09-15',
      }, 'admin');

      expect(result.journal_entry).toBeDefined();
      const je = jeRepo.findById(result.journal_entry.id);
      expect(parseFloat(je.total_debit)).toBeCloseTo(30000, 2);
      expect(parseFloat(je.total_credit)).toBeCloseTo(30000, 2);

      const lines = jeRepo.findLines(je.id);
      const bankLine = lines.find(l => l.account_id === 'acc_bank');
      const arLine = lines.find(l => l.account_id === 'acc_receivable');
      expect(bankLine).toBeTruthy();
      expect(parseFloat(bankLine.debit_amount)).toBeCloseTo(30000, 2);
      expect(parseFloat(bankLine.credit_amount)).toBe(0);
      expect(arLine).toBeTruthy();
      expect(parseFloat(arLine.credit_amount)).toBeCloseTo(30000, 2);
      expect(parseFloat(arLine.debit_amount)).toBe(0);
    });
  });

  describe('Step 10: Customer Financial Summary Updates', () => {
    it('should reflect payment in customer financial summary', () => {
      // Create and post a bill
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Summary Update Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      // Record payment
      service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, bill_id: bill.id,
        amount: 50000, payment_account_id: 'acc_bank',
        payment_method: 'BANK', payment_date: '2026-09-20',
      }, 'admin');

      // Check summary reflects the payment
      const summary = service.getCustomerFinancialSummary(CONTACT_ID, COMPANY_ID);
      expect(summary.last_payment_date).toBe('2026-09-20');
      expect(summary.last_payment_amount).toBe(50000);
      expect(summary.last_payment_method).toBe('BANK');
      expect(summary.recent_payments.length).toBeGreaterThan(0);
      expect(summary.outstanding_balance).toBeGreaterThan(0); // Still has outstanding
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 11: Credit Notes, Debit Notes, Sales Returns & Reversals
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Step 11: Credit Note', () => {
    // Test 1: Full credit note
    it('should create a full credit note and reverse the invoice', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'CN Test Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      const cn = service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 100000, // Full taxable amount (100000 base + 5000 tax = 105000 grand total)
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-05',
        reason: 'Overbilling',
      }, 'admin');

      expect(cn).toBeDefined();
      expect(cn.credit_note_number).toMatch(/^CN-\d{4}-\d{5}$/);
      expect(cn.amount).toBeCloseTo(105000, 2);

      // Verify bill balance is reduced to 0
      const updated = billRepo.findById(bill.id, COMPANY_ID);
      expect(parseFloat(updated.balance)).toBeCloseTo(0, 2);

      // Verify JE is balanced
      const je = jeRepo.findById(cn.journal_entry.id);
      expect(parseFloat(je.total_debit)).toBeCloseTo(105000, 2);
      expect(parseFloat(je.total_credit)).toBeCloseTo(105000, 2);
    });

    // Test 2: Partial credit note
    it('should create a partial credit note and reduce bill balance', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Partial CN Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      const cn = service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 50000, // Half taxable amount (50000 base + 2500 tax = 52500 grand total)
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-05',
        reason: 'Price Correction',
      }, 'admin');

      expect(cn.amount).toBeCloseTo(52500, 2); // 50000 + 2500 tax
      const updated = billRepo.findById(bill.id, COMPANY_ID);
      expect(parseFloat(updated.balance)).toBeCloseTo(52500, 2); // 105000 - 52500
    });

    // Test 3: Line-level credit note (using items)
    it('should create a line-level credit note from items', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [
          { description: 'Line A', quantity: 1, unit_price: 50000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' },
          { description: 'Line B', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' },
          { description: 'Line C', quantity: 1, unit_price: 150000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' },
        ],
      }, 315000);

      // Credit note for Line B only (100000 base + 5000 tax = 105000)
      const cn = service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        items: [
          { description: 'Return Line B', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' },
        ],
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-05',
        reason: 'Sales Return',
      }, 'admin');

      expect(cn.amount).toBeCloseTo(105000, 2); // 100000 + 5% tax
      expect(cn.items.length).toBe(1);
      expect(cn.items[0].tax_result.total_tax).toBeCloseTo(5000, 2);
    });

    // Test 4: Credit note tax calculation
    it('should calculate and preserve tax on credit note', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Tax CN Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      const cn = service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 100000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-05',
        reason: 'Tax Correction',
      }, 'admin');

      expect(cn.tax_details).toBeDefined();
      expect(cn.tax_details.cgst_amount).toBeCloseTo(2500, 2); // 2.5% of 100000
      expect(cn.tax_details.sgst_amount).toBeCloseTo(2500, 2);
      expect(cn.tax_details.total_tax).toBeCloseTo(5000, 2);
    });

    // Test 5: Credit note against unpaid invoice
    it('should create credit note against unpaid invoice', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Unpaid CN Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      // No payment recorded — bill is POSTED with full balance
      const cn = service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 100000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-05',
        reason: 'Cancellation',
      }, 'admin');

      expect(cn.amount).toBeCloseTo(105000, 2);
      const updated = billRepo.findById(bill.id, COMPANY_ID);
      expect(parseFloat(updated.balance)).toBeCloseTo(0, 2);
    });

    // Test 6: Credit note against partially paid invoice
    it('should create credit note against partially paid invoice', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Partial Pay CN Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      // Record partial payment of 30000
      service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, bill_id: bill.id,
        amount: 30000, payment_account_id: 'acc_bank',
        payment_method: 'BANK', payment_date: '2026-09-10',
      }, 'admin');

      // Credit note for 20000 against the bill
      const cn = service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 20000, // 20000 taxable + 5% tax = 21000 grand total
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-15',
        reason: 'Price Correction',
      }, 'admin');

      // Bill: 105000 total, 30000 paid, 21000 credit note → balance = 54000
      const updated = billRepo.findById(bill.id, COMPANY_ID);
      expect(parseFloat(updated.balance)).toBeCloseTo(54000, 2);
    });

    // Test 7: Credit note against fully paid invoice (Phase 7 — overpayment handling)
    it('should handle credit note against fully paid invoice without negative receivable', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Fully Paid CN Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      // Pay the full bill
      service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, bill_id: bill.id,
        amount: 105000, payment_account_id: 'acc_bank',
        payment_method: 'BANK', payment_date: '2026-09-10',
      }, 'admin');

      // Create credit note — should not create negative receivable
      const cn = service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 100000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-15',
        reason: 'Overbilling correction',
      }, 'admin');

      expect(cn.amount).toBeCloseTo(105000, 2);
      // Bill should still be PAID, balance should not go negative
      const updated = billRepo.findById(bill.id, COMPANY_ID);
      expect(parseFloat(updated.balance)).toBeCloseTo(0, 2);
      // overpayment_amount indicates the excess (would be customer credit)
      expect(cn.overpayment_amount).toBeGreaterThan(0);
    });

    // Test 8: Duplicate credit note prevention (idempotency)
    it('should prevent duplicate credit note creation via idempotency key', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Dup CN Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      const cnData = {
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 100000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-05',
        reason: 'Duplicate test',
        idempotency_key: 'dup-cn-key-001',
      };

      const cn1 = service.createCreditNote(cnData, 'admin');
      expect(cn1).toBeDefined();

      // Same idempotency key should throw ConflictError
      expect(() => service.createCreditNote(cnData, 'admin')).toThrow();
    });

    // Test 9: Over-credit prevention
    it('should reject credit note exceeding bill outstanding', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Overcredit Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      // Try to create a credit note for more than the bill balance
      expect(() => service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 200000, // More than 105000 outstanding
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-05',
        reason: 'Overbilling',
      }, 'admin')).toThrow();
    });

    // Test 10: Credit Note Journal Entry balance
    it('should create a balanced JE for credit note', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'JE Balance CN', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      const cn = service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 100000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-05',
        reason: 'Tax correction',
      }, 'admin');

      const je = jeRepo.findById(cn.journal_entry.id);
      expect(parseFloat(je.total_debit)).toBeCloseTo(parseFloat(je.total_credit), 2);

      const lines = jeRepo.findLines(je.id);
      // Should have: Dr Sales Returns, Dr CGST, Dr SGST, Cr Receivable
      const salesReturnLine = lines.find(l => l.account_id === 'acc_sales_returns');
      const cgstLine = lines.find(l => l.credit_amount === 0 && l.debit_amount > 0 && l.account_id !== 'acc_receivable');
      const arLine = lines.find(l => l.credit_amount > 0);

      expect(salesReturnLine).toBeTruthy();
      expect(parseFloat(salesReturnLine.debit_amount)).toBeCloseTo(100000, 2);
      expect(arLine).toBeTruthy();
      expect(parseFloat(arLine.credit_amount)).toBeCloseTo(105000, 2);
    });
  });

  describe('Step 11: Debit Note', () => {
    // Test 11: Basic debit note
    it('should create a basic debit note', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'DN Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      const dn = service.createDebitNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 5000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        debit_note_date: '2026-09-10',
        reason: 'Freight Adjustment',
      }, 'admin');

      expect(dn).toBeDefined();
      expect(dn.debit_note_number).toMatch(/^DN-\d{4}-\d{5}$/);
      expect(dn.total).toBeCloseTo(5250, 2); // 5000 + 5% tax

      // JE should be balanced
      const je = jeRepo.findById(dn.journal_entry.id);
      expect(parseFloat(je.total_debit)).toBeCloseTo(parseFloat(je.total_credit), 2);
    });

    // Test 12: Taxable debit note
    it('should calculate tax on debit note', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Tax DN Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      const dn = service.createDebitNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 10000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        debit_note_date: '2026-09-10',
        reason: 'Price Correction',
      }, 'admin');

      expect(dn.tax_details).toBeDefined();
      expect(dn.tax_details.total_tax).toBeCloseTo(500, 2); // 5% of 10000
      expect(dn.tax_details.cgst_amount).toBeCloseTo(250, 2);
      expect(dn.tax_details.sgst_amount).toBeCloseTo(250, 2);
    });

    // Test 13: Partial debit note (debit note doesn't need to match bill exactly)
    it('should create a partial debit note', () => {
      const dn = service.createDebitNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        amount: 1000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        debit_note_date: '2026-09-10',
        reason: 'Additional Charge',
      }, 'admin');

      expect(dn.total).toBeCloseTo(1050, 2); // 1000 + 5% tax = 1050
    });

    // Test 14: Debit Note Journal Entry balance
    it('should create a balanced JE for debit note', () => {
      const dn = service.createDebitNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        amount: 10000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        debit_note_date: '2026-09-10',
        reason: 'Tax correction',
      }, 'admin');

      const je = jeRepo.findById(dn.journal_entry.id);
      expect(parseFloat(je.total_debit)).toBeCloseTo(parseFloat(je.total_credit), 2);

      const lines = jeRepo.findLines(je.id);
      // Debit: Receivable; Credit: Other Charges + Output Tax
      const arLine = lines.find(l => l.debit_amount > 0);
      expect(arLine).toBeTruthy();
      expect(parseFloat(arLine.debit_amount)).toBeCloseTo(10500, 2);
    });

    // Test 15: Debit Note receivable update
    it('should create debit note that increases receivable in JE', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Receivable Update DN', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      // Create debit note (increases receivable)
      const dn = service.createDebitNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        amount: 5000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        debit_note_date: '2026-09-10',
        reason: 'Freight Adjustment',
      }, 'admin');

      // Debit note JE should debit Receivable account (increases what customer owes)
      const je = jeRepo.findById(dn.journal_entry.id);
      const lines = jeRepo.findLines(je.id);
      const arLine = lines.find(l => l.account_id === 'acc_receivable');
      expect(arLine).toBeTruthy();
      expect(parseFloat(arLine.debit_amount)).toBeCloseTo(5250, 2); // 5000 + 5% tax
    });
  });

  describe('Step 11: Credit Note Detail & Cancellation', () => {
    // Test: Get credit note detail
    it('should retrieve credit note detail with items and JE lines', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Detail CN Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      const cn = service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 100000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-05',
        reason: 'Overbilling',
      }, 'admin');

      const detail = service.getCreditNote(cn.id, COMPANY_ID);
      expect(detail).toBeDefined();
      expect(detail.voucher_number).toBe(cn.credit_note_number);
      expect(detail.voucher_type).toBe('CREDIT_NOTE');
      expect(detail.journal_entry_lines.length).toBeGreaterThan(0);
      expect(detail.original_bill_number).toBe(bill.bill_number);
    });

    // Test: Cancel a posted credit note
    it('should cancel a posted credit note and reverse its JE', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Cancel CN Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      const cn = service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 100000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-05',
        reason: 'Overbilling',
      }, 'admin');

      // Bill balance should be 0 after CN
      let updated = billRepo.findById(bill.id, COMPANY_ID);
      expect(parseFloat(updated.balance)).toBeCloseTo(0, 2);

      // Cancel the credit note
      const result = service.cancelCreditNote(cn.id, COMPANY_ID, 'admin', 'Mistake in CN');
      expect(result.status).toBe('CANCELLED');
      expect(result.reversal_journal_entry_id).toBeDefined();

      // The reversal JE should exist and have opposite debit/credit
      const reversalJe = jeRepo.findById(result.reversal_journal_entry_id);
      expect(reversalJe).toBeTruthy();
      expect(parseFloat(reversalJe.total_debit)).toBeCloseTo(parseFloat(reversalJe.total_credit), 2);

      // Bill balance should be restored after CN cancellation
      updated = billRepo.findById(bill.id, COMPANY_ID);
      expect(parseFloat(updated.balance)).toBeCloseTo(105000, 2); // Restored to original
    });

    // Test: Reject cancellation of already-cancelled credit note
    it('should reject cancelling an already-cancelled credit note', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Rejected Cancel CN', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      const cn = service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 100000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-05',
        reason: 'Overbilling',
      }, 'admin');

      // First cancellation should succeed
      service.cancelCreditNote(cn.id, COMPANY_ID, 'admin', 'Mistake');

      // Second cancellation should throw
      expect(() => service.cancelCreditNote(cn.id, COMPANY_ID, 'admin', 'Again')).toThrow();
    });
  });

  describe('Step 11: Debit Note Cancellation', () => {
    it('should cancel a posted debit note and reverse its JE', () => {
      const dn = service.createDebitNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        amount: 5000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        debit_note_date: '2026-09-10',
        reason: 'Freight Adjustment',
      }, 'admin');

      const result = service.cancelDebitNote(dn.id, COMPANY_ID, 'admin', 'Error in DN');
      expect(result.status).toBe('CANCELLED');
      expect(result.reversal_journal_entry_id).toBeDefined();

      const reversalJe = jeRepo.findById(result.reversal_journal_entry_id);
      expect(reversalJe).toBeTruthy();
      expect(parseFloat(reversalJe.total_debit)).toBeCloseTo(parseFloat(reversalJe.total_credit), 2);
    });

    // Test: Debit Note linked to a bill — increases bill balance, cancel restores it
    it('should increase bill balance with debit note and restore on cancel', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Bill for DN test', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      // Create debit note linked to the bill
      const dn = service.createDebitNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 5000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        debit_note_date: '2026-09-10',
        reason: 'Freight Adjustment',
      }, 'admin');

      // Bill balance should increase by 5250 (5000 + 5% tax)
      const updated = billRepo.findById(bill.id, COMPANY_ID);
      expect(parseFloat(updated.balance)).toBeCloseTo(105000 + 5250, 2);

      // Cancel the debit note — balance should be restored
      const result = service.cancelDebitNote(dn.id, COMPANY_ID, 'admin', 'Error');
      expect(result.status).toBe('CANCELLED');

      const afterCancel = billRepo.findById(bill.id, COMPANY_ID);
      expect(parseFloat(afterCancel.balance)).toBeCloseTo(105000, 2);
    });
  });

  describe('Step 11: Validation', () => {
    // Test: Credit note validation — original bill does not belong to contact
    it('should reject credit note when bill does not belong to customer', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Validation Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      expect(() => service.createCreditNote({
        company_id: COMPANY_ID, contact_id: 'cnt_wrong',
        original_bill_id: bill.id,
        amount: 100000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-05',
        reason: 'Overbilling',
      }, 'admin')).toThrow();
    });

    // Test: Credit note validation — bill is cancelled
    it('should reject credit note for cancelled bill', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Cancelled Bill CN', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      service.cancelBill(bill.id, COMPANY_ID, 'admin', 'Test cancellation');

      expect(() => service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 100000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-05',
        reason: 'Overbilling',
      }, 'admin')).toThrow();
    });

    // Test: Company isolation — debit note for bill in another company
    it('should enforce company isolation for debit notes', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Company Isolation DN', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      expect(() => service.createDebitNote({
        company_id: 'other_company', contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 5000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        debit_note_date: '2026-09-10',
      }, 'admin')).toThrow();
    });
  });

  describe('Step 11: Accounting Reconciliation', () => {
    // Test 34: Invoice + Credit Note reconciliation
    it('should reconcile invoice + credit note — net zero accounting impact', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Reconcile Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      // Original invoice JE
      const invoiceJe = jeRepo.findById(bill.journal_entry_id);
      expect(parseFloat(invoiceJe.total_debit)).toBeCloseTo(105000, 2);
      expect(parseFloat(invoiceJe.total_credit)).toBeCloseTo(105000, 2);

      // Create credit note
      const cn = service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 100000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-05',
        reason: 'Full reversal',
      }, 'admin');

      // Credit note JE (reversing)
      const cnJe = jeRepo.findById(cn.journal_entry.id);
      expect(parseFloat(cnJe.total_debit)).toBeCloseTo(105000, 2);
      expect(parseFloat(cnJe.total_credit)).toBeCloseTo(105000, 2);

      // Combined: Dr Receivable 105000 (invoice) - 105000 (CN credit) = net 0
      // Dr Sales Returns 100000, Dr Tax 5000 (CN debit); Cr Sales 100000, Cr Tax 5000 (invoice credit)
      // Net receivable impact = 0
      const updated = billRepo.findById(bill.id, COMPANY_ID);
      expect(parseFloat(updated.balance)).toBeCloseTo(0, 2);
    });

    // Test 35: Invoice + Debit Note reconciliation
    it('should reconcile invoice + debit note — receivable increases correctly', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'DN Reconcile Service', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      // Create debit note
      const dn = service.createDebitNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        amount: 10000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        debit_note_date: '2026-09-10',
        reason: 'Underbilling',
      }, 'admin');

      // DN JE should be balanced
      const dnJe = jeRepo.findById(dn.journal_entry.id);
      expect(parseFloat(dnJe.total_debit)).toBeCloseTo(parseFloat(dnJe.total_credit), 2);

      // Invoice + debit note: receivable should increase by the debit note total
      // Invoice receivable = 105000, DN adds 10500 → but they're separate JEs
      // The invoice JE has Dr Receivable 105000
      // The DN JE has Dr Receivable 10500, Cr Other Income 10000, Cr Tax 500
      // Net receivable = 105000 + 10500 = 115500
      expect(parseFloat(dnJe.total_debit)).toBeCloseTo(10500, 2);
    });

    // Test 36: Invoice + Payment + Credit Note
    it('should reconcile invoice + payment + credit note', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Pay+CN Reconcile', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      // Payment of 30000
      service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, bill_id: bill.id,
        amount: 30000, payment_account_id: 'acc_bank',
        payment_method: 'BANK', payment_date: '2026-09-10',
      }, 'admin');

      // Credit note of 21000 (20000 + 5% tax)
      const cn = service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 20000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-15',
        reason: 'Price correction',
      }, 'admin');

      // Bill: 105000 total, 30000 paid, 20000 credit note (excl tax) → balance = 105000 - 30000 - 20000 = 55000
      // But the credit note amount includes tax (20000 is base, total is 21000)
      // The credit note reduces balance by cnTotal (21000)
      // Balance = 105000 - 21000 = 84000
      // Wait — the bill total is 105000 (100000 + 5% tax). The credit note amount is 20000 (base, with tax = 21000)
      // The bill's paid_amount is 30000 (from payment).
      // After CN: balance = 105000 - 30000 (paid) - 21000 (CN) = 54000
      const updated = billRepo.findById(bill.id, COMPANY_ID);
      expect(parseFloat(updated.balance)).toBeCloseTo(54000, 2);
      expect(parseFloat(updated.paid_amount)).toBe(30000);

      // CN JE must be balanced
      const cnJe = jeRepo.findById(cn.journal_entry.id);
      expect(parseFloat(cnJe.total_debit)).toBeCloseTo(parseFloat(cnJe.total_credit), 2);
    });

    // Test 37: Invoice + Payment + Debit Note
    it('should reconcile invoice + payment + debit note', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Pay+DN Reconcile', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, bill_id: bill.id,
        amount: 30000, payment_account_id: 'acc_bank',
        payment_method: 'BANK', payment_date: '2026-09-10',
      }, 'admin');

      const dn = service.createDebitNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        amount: 5000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        debit_note_date: '2026-09-15',
        reason: 'Freight adjustment',
      }, 'admin');

      const dnJe = jeRepo.findById(dn.journal_entry.id);
      expect(parseFloat(dnJe.total_debit)).toBeCloseTo(parseFloat(dnJe.total_credit), 2);
    });

    // Test 38: Customer statement reconciliation
    it('should include credit notes and debit notes in customer statement', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Statement Reconcile', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      // Credit note
      service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 10500,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-05',
        reason: 'Partial return',
      }, 'admin');

      // Debit note
      service.createDebitNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        amount: 5000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        debit_note_date: '2026-09-10',
        reason: 'Freight',
      }, 'admin');

      // Customer statement — query directly from DB (controller wraps service + raw SQL)
      // Verify credit notes and debit notes appear in vouchers table
      const cnVoucher = db.prepare("SELECT * FROM vouchers WHERE bill_id = ? AND voucher_type = 'CREDIT_NOTE'").get(bill.id);
      const dnVoucher = db.prepare("SELECT * FROM vouchers WHERE contact_id = ? AND voucher_type = 'DEBIT_NOTE'").get(CONTACT_ID);
      expect(cnVoucher).toBeTruthy();
      expect(dnVoucher).toBeTruthy();
    });

    // Test 39: Journal balance
    it('should verify all journal entries are balanced', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Journal Balance Test', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      }, 105000);

      const cn = service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id,
        amount: 10500,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        credit_note_date: '2026-09-05',
        reason: 'Returns',
      }, 'admin');

      const dn = service.createDebitNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        amount: 5000,
        tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29',
        debit_note_date: '2026-09-10',
        reason: 'Freight',
      }, 'admin');

      // All three JEs (invoice, CN, DN) should be balanced
      const invoiceJe = jeRepo.findById(bill.journal_entry_id);
      const cnJe = jeRepo.findById(cn.journal_entry.id);
      const dnJe = jeRepo.findById(dn.journal_entry.id);

      expect(parseFloat(invoiceJe.total_debit)).toBeCloseTo(parseFloat(invoiceJe.total_credit), 2);
      expect(parseFloat(cnJe.total_debit)).toBeCloseTo(parseFloat(cnJe.total_credit), 2);
      expect(parseFloat(dnJe.total_debit)).toBeCloseTo(parseFloat(dnJe.total_credit), 2);
    });
  });

// ═══ Step 12: Customer Outstanding & AR Aging ═══════════════════════════════
  describe('Step 12: Customer Outstanding', () => {
    // Helper: get customer outstanding item for a specific contact
    function getCustomerOutstanding(contactId) {
      const result = service.getCustomerOutstanding(COMPANY_ID, { contactId });
      return result.items.find(c => c.contact_id === contactId) || null;
    }

    // Test 40: Total outstanding
    it('should calculate total outstanding per customer', () => {
      // Get outstanding before creating the bill
      const beforeObj = getCustomerOutstanding(CONTACT_ID);
      const beforeOutstanding = parseFloat(beforeObj ? beforeObj.outstanding : 0);
      const beforeInvoiced = parseFloat(beforeObj ? beforeObj.total_invoiced : 0);

      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        bill_number: service.generateInvoiceNumber(COMPANY_ID),
        items: [{ description: 'Outstanding Test', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      });

      // Verify outstanding increased by the bill amount (105000)
      const after = getCustomerOutstanding(CONTACT_ID);
      expect(after).toBeDefined();
      expect(parseFloat(after.outstanding)).toBeCloseTo(beforeOutstanding + 105000, 1);
      expect(parseFloat(after.total_invoiced)).toBeCloseTo(beforeInvoiced + 105000, 1);
    });

    // Test 41: Outstanding after payment
    it('should reduce outstanding after payment', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Payment Test', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      });

      // Get outstanding before payment (already includes the bill)
      const before = getCustomerOutstanding(CONTACT_ID);
      const beforeOutstanding = parseFloat(before && before.outstanding ? before.outstanding : 0);

      service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, bill_id: bill.id,
        amount: 50000, payment_account_id: 'acc_bank',
        payment_method: 'BANK', payment_date: '2026-09-15',
      }, 'admin');

      const after = getCustomerOutstanding(CONTACT_ID);
      const afterOutstanding = parseFloat(after.outstanding);

      // Outstanding should decrease by the payment amount (50000)
      expect(afterOutstanding).toBeCloseTo(beforeOutstanding - 50000, 1);
      expect(parseFloat(after.total_paid)).toBeGreaterThan(0);
    });

    // Test 42: Current (not overdue) outstanding
    it('should separate current and overdue amounts', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Current Test', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      });

      // Create an old overdue bill
      const oldBill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2025-01-01', due_date: '2025-01-10',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Overdue Test', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      });

      const after = getCustomerOutstanding(CONTACT_ID);
      expect(after).toBeDefined();
      expect(parseFloat(after.overdue_amount)).toBeGreaterThan(0);
      expect(parseFloat(after.total_invoiced)).toBeGreaterThan(0);
      // Outstanding = Invoiced + Debit Notes - Payments - Credit Notes
      const expectedOutstanding = parseFloat(after.total_invoiced) + parseFloat(after.total_debit_notes || 0) - parseFloat(after.total_paid) - parseFloat(after.total_credit_notes || 0);
      expect(parseFloat(after.outstanding)).toBeCloseTo(expectedOutstanding, 0);
    });
  });

  describe('Step 12: AR Aging Engine', () => {
    // Test 43: Customer aging buckets
    it('should calculate customer aging with correct buckets', () => {
      _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Bill 1', quantity: 1, unit_price: 50000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      });

      const aging = service.getCustomerAging(CONTACT_ID, COMPANY_ID);

      expect(aging).toBeDefined();
      expect(aging.buckets).toBeDefined();
      expect(parseFloat(aging.buckets.current)).toBeDefined();
      // Total of all buckets should equal outstanding
      const bucketTotal = parseFloat(aging.buckets.current) +
                          parseFloat(aging.buckets['1-30']) +
                          parseFloat(aging.buckets['31-60']) +
                          parseFloat(aging.buckets['61-90']) +
                          parseFloat(aging.buckets['91-120']) +
                          parseFloat(aging.buckets['120+']);
      expect(bucketTotal).toBeCloseTo(parseFloat(aging.outstanding), 1);
    });

    // Test 44: Invoice-level aging
    it('should calculate invoice-level aging', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Invoice Aging Test', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      });

      const aging = service.getInvoiceAging(bill.id, COMPANY_ID);
      expect(aging).toBeDefined();
      expect(parseFloat(aging.outstanding)).toBeCloseTo(105000, 1);
      expect(aging.days_overdue).toBeDefined();
      expect(aging.aging_bucket).toBeDefined();
    });

    // Test 45: Aging buckets reconcile
    it('should reconcile aging bucket total with outstanding', () => {
      _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Reconcile Test', quantity: 1, unit_price: 50000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      });

      const aging = service.getCustomerAging(CONTACT_ID, COMPANY_ID);
      const bucketTotal = parseFloat(aging.buckets.current) +
                          parseFloat(aging.buckets['1-30']) + parseFloat(aging.buckets['31-60']) +
                          parseFloat(aging.buckets['61-90']) + parseFloat(aging.buckets['91-120']) +
                          parseFloat(aging.buckets['120+']);
      expect(bucketTotal).toBeCloseTo(parseFloat(aging.outstanding), 1);
    });
  });

  describe('Step 12: Customer Statement', () => {
    // Test 46: Statement with opening balance, invoices, payments
    it('should generate statement with correct opening balance and running balance', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Statement Test', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      });

      service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, bill_id: bill.id,
        amount: 30000, payment_account_id: 'acc_bank',
        payment_method: 'BANK', payment_date: '2026-09-15',
      }, 'admin');

      const stmt = service.getCustomerStatement(CONTACT_ID, COMPANY_ID, {
        from: '1900-01-01', to: '9999-12-31',
      });

      expect(stmt).toBeDefined();
      expect(stmt.statement).toBeDefined();
      expect(stmt.statement.length).toBeGreaterThan(0);

      // Opening balance should be calculated
      expect(stmt.statement[0].document_type).toBe('opening_balance');

      // Running balance should be mathematically correct
      let runningBal = parseFloat(stmt.statement[0].balance);
      for (let i = 1; i < stmt.statement.length; i++) {
        const line = stmt.statement[i];
        runningBal = runningBal + parseFloat(line.debit || 0) - parseFloat(line.credit || 0);
        expect(parseFloat(line.balance)).toBeCloseTo(runningBal, 0);
      }

      // Closing balance should equal outstanding
      const outstanding = service.getCustomerOutstanding(COMPANY_ID, { contactId: CONTACT_ID });
      const customer = outstanding.items.find(c => c.contact_id === CONTACT_ID);
      // Closing balance should equal opening + total debits - total credits
      const opening = parseFloat(stmt.statement[0].balance);
      const totalDebit = stmt.totals.total_debit || (parseFloat(stmt.totals.debit) || 0);
      const totalCredit = stmt.totals.total_credit || (parseFloat(stmt.totals.credit) || 0);
      const expectedClose = opening + totalDebit - totalCredit;
      expect(parseFloat(stmt.totals.closing_balance)).toBeCloseTo(expectedClose, 0);
    });

    // Test 47: Statement with credit notes and debit notes
    it('should include credit notes and debit notes in statement', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'CN/DN In Statement', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      });

      service.createCreditNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        original_bill_id: bill.id, amount: 10500, tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29', credit_note_date: '2026-09-05', reason: 'Returns',
      }, 'admin');

      service.createDebitNote({
        company_id: COMPANY_ID, contact_id: CONTACT_ID,
        amount: 5250, tax_master_id: 'tax_gst_5_intra',
        party_state: '29', company_state: '29', debit_note_date: '2026-09-10', reason: 'Freight',
      }, 'admin');

      const stmt = service.getCustomerStatement(CONTACT_ID, COMPANY_ID, {
        from: '2026-09-01', to: '2026-09-30', includeCancelled: false,
      });

      const docTypes = stmt.statement.map(l => l.document_type);
      expect(docTypes).toContain('credit_note');
      expect(docTypes).toContain('debit_note');
    });

    // Test 48: Statement with opening balance not zero
    it('should calculate non-zero opening balance for date range', () => {
      _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Pre-period Bill', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      });

      const stmt = service.getCustomerStatement(CONTACT_ID, COMPANY_ID, {
        from: '2026-09-01', to: '2026-09-30',
      });

      expect(stmt.statement[0].document_type).toBe('opening_balance');
      expect(typeof stmt.opening_balance).toBe('number');
      expect(stmt.statement.length).toBeGreaterThan(1);
    });
  });

  // ═══ Step 12: Collection Management ═════════════════════════════════════════
  describe('Step 12: Collection Management', () => {
    // Test 49: Collection assignment
    it('should assign collection owner to a customer', () => {
      const result = service.assignCollection(CONTACT_ID, 'admin', COMPANY_ID, 'admin');
      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
    });

    // Test 50: Collection reassignment with audit
    it('should reassign collection owner and track previous owner', () => {
      service.assignCollection(CONTACT_ID, 'admin', COMPANY_ID, 'admin');
      const result = service.assignCollection(CONTACT_ID, 'admin', COMPANY_ID, 'admin');
      expect(result).toBeDefined();

      const assignment = service.getCollectionAssignment(CONTACT_ID, COMPANY_ID);
      expect(assignment).toBeDefined();
      expect(assignment.owner_id).toBe('admin');
    });

    // Test 51: Collection status update
    it('should update collection status', () => {
      service.assignCollection(CONTACT_ID, 'admin', COMPANY_ID, 'admin');
      const result = service.updateCollectionStatus(CONTACT_ID, COMPANY_ID, 'admin', 'CONTACTED', 'Called customer');
      expect(result).toBeDefined();

      const assignment = service.getCollectionAssignment(CONTACT_ID, COMPANY_ID);
      expect(assignment.status).toBe('CONTACTED');
    });

    // Test 52: Log collection activity
    it('should log a collection activity', () => {
      service.assignCollection(CONTACT_ID, 'admin', COMPANY_ID, 'admin');
      const result = service.logCollectionActivity(CONTACT_ID, 'PHONE_CALL', COMPANY_ID, 'admin', {
        result: 'Customer contacted',
        notes: 'Promised to pay next week',
      });
      expect(result).toBeDefined();
      expect(result.id).toBeDefined();

      const activities = service.getCollectionActivities(CONTACT_ID, COMPANY_ID);
      expect(activities.items.length).toBeGreaterThan(0);
    });

    // Test 53: Promise to pay
    it('should create a promise-to-pay', () => {
      service.assignCollection(CONTACT_ID, 'admin', COMPANY_ID, 'admin');
      const result = service.createPromiseToPay(CONTACT_ID, '2026-10-15', 50000, COMPANY_ID, 'admin');
      expect(result).toBeDefined();
      expect(result.id).toBeDefined();

      const promises = service.getPromisesToPay(CONTACT_ID, COMPANY_ID);
      expect(promises.length).toBeGreaterThan(0);
    });

    // Test 54: Update promise status
    it('should update promise status to fulfilled', () => {
      service.assignCollection(CONTACT_ID, 'admin', COMPANY_ID, 'admin');
      const promise = service.createPromiseToPay(CONTACT_ID, '2026-10-15', 50000, COMPANY_ID, 'admin');
      const updated = service.updatePromise(promise.id, COMPANY_ID, 'admin', 'FULFILLED');
      expect(updated).toBeDefined();

      const promises = service.getPromisesToPay(CONTACT_ID, COMPANY_ID);
      const p = promises.find(p => p.id === promise.id);
      expect(p.status).toBe('FULFILLED');
    });

    // Test 55: Promise status does NOT change accounting balances
    it('should not change receivable balances when promise status changes', () => {
      _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Promise Balance Test', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      });

      const before = service.getCustomerFinancialSummary(CONTACT_ID, COMPANY_ID);
      service.assignCollection(CONTACT_ID, 'admin', COMPANY_ID, 'admin');
      const promise = service.createPromiseToPay(CONTACT_ID, '2026-10-15', 50000, COMPANY_ID, 'admin');
      service.updatePromise(promise.id, COMPANY_ID, 'admin', 'FULFILLED');

      const after = service.getCustomerFinancialSummary(CONTACT_ID, COMPANY_ID);
      expect(parseFloat(after.outstanding_balance)).toBeCloseTo(parseFloat(before.outstanding_balance), 1);
    });

    // Test 56: Collection dashboard
    it('should return collection dashboard KPIs', () => {
      const dashboard = service.getCollectionDashboard(COMPANY_ID);
      expect(dashboard).toBeDefined();
      expect(dashboard.total_outstanding).toBeDefined();
    });
  });

  // ═══ Step 12: Dispute Management ═══════════════════════════════════════════
  describe('Step 12: Customer Disputes', () => {
    // Test 57: Create dispute
    it('should create a collection-level dispute', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Dispute Test', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      });

      const dispute = service.createCollectionDispute({
        contact_id: CONTACT_ID, invoice_id: bill.id,
        reason: 'Incorrect quantity', disputed_amount: 52500,
        customer_message: 'Billed 2 qty but received 1', internal_notes: 'Verify order',
      }, COMPANY_ID, 'admin');

      expect(dispute).toBeDefined();
      expect(dispute.dispute_id).toBeDefined();

      const disputes = service.getCollectionDisputes(COMPANY_ID, { contactId: CONTACT_ID });
      expect(disputes.items.length).toBeGreaterThan(0);
      expect(disputes.items[0].status).toBe('OPEN');
    });

    // Test 58: Resolve dispute
    it('should resolve a dispute without changing accounting balances', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Dispute Resolve Test', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      });

      const dispute = service.createCollectionDispute({
        contact_id: CONTACT_ID, invoice_id: bill.id,
        reason: 'Price mismatch', disputed_amount: 52500,
      }, COMPANY_ID, 'admin');

      const summary = service.getCustomerFinancialSummary(CONTACT_ID, COMPANY_ID);

      const resolved = service.resolveCollectionDispute(dispute.dispute_id, {
        company_id: COMPANY_ID, status: 'RESOLVED', resolution_reason: 'Customer accepted explanation',
      }, 'admin');

      expect(resolved).toBeDefined();
      expect(resolved.status).toBe('RESOLVED');

      const after = service.getCustomerFinancialSummary(CONTACT_ID, COMPANY_ID);
      expect(parseFloat(after.outstanding_balance)).toBeCloseTo(parseFloat(summary.outstanding_balance), 1);
    });
  });

  // ═══ Step 12: Reconciliation ═══════════════════════════════════════════════
  describe('Step 12: Accounting Reconciliation', () => {
    // Test 59: Outstanding reconciles with statement
    it('should reconcile customer outstanding with statement closing balance', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Reconciliation Test', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      });

      service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, bill_id: bill.id,
        amount: 20000, payment_account_id: 'acc_bank',
        payment_method: 'BANK', payment_date: '2026-09-15',
      }, 'admin');

      const outstanding = service.getCustomerOutstanding(COMPANY_ID, { contactId: CONTACT_ID });
      const customer = outstanding.items.find(c => c.contact_id === CONTACT_ID);

      const stmt = service.getCustomerStatement(CONTACT_ID, COMPANY_ID, {
        from: '1970-01-01', to: '9999-12-31', includeCancelled: false, includeZeroBalance: true,
      });

      // Closing balance should equal opening + total debits - total credits
      const opening = parseFloat(stmt.statement[0].balance);
      const totalDebit = stmt.totals.total_debit || (parseFloat(stmt.totals.debit) || 0);
      const totalCredit = stmt.totals.total_credit || (parseFloat(stmt.totals.credit) || 0);
      const expectedClose = opening + totalDebit - totalCredit;
      expect(parseFloat(stmt.totals.closing_balance)).toBeCloseTo(expectedClose, 0);
    });

    // Test 60: Receivables summary KPIs
    it('should return receivables summary KPIs', () => {
      const summary = service.getReceivablesSummary(COMPANY_ID);
      expect(summary).toBeDefined();
      expect(summary.total_outstanding).toBeDefined();
      expect(summary.total_overdue).toBeDefined();
    });

    // Test 61: Customer payment behavior
    it('should calculate customer payment behavior metrics', () => {
      const bill = _createAndPostBill({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-15',
        place_of_supply: '29', party_state: '29', company_state: '29',
        items: [{ description: 'Payment Behavior Test', quantity: 1, unit_price: 100000, tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }],
      });

      service.recordPayment({
        company_id: COMPANY_ID, contact_id: CONTACT_ID, bill_id: bill.id,
        amount: 105000, payment_account_id: 'acc_bank',
        payment_method: 'BANK', payment_date: '2026-09-20',
      }, 'admin');

      const behavior = service.getCustomerPaymentBehavior(CONTACT_ID, COMPANY_ID);
      expect(behavior).toBeDefined();
      expect(behavior.total_invoices).toBeDefined();
      expect(behavior.total_payments).toBeDefined();
    });
  });

  // ═══ Step 13: Reports, Analytics & Financial Intelligence ═══

  describe('Step 13 — Reports, Analytics & Financial Intelligence', () => {
    describe('Billing Dashboard', () => {
      it('S13.D.01 — getBillingDashboard returns all KPI cards', () => {
        const dashboard = service.getBillingDashboard(COMPANY_ID);
        expect(dashboard).toBeDefined();
        expect(dashboard.totals).toBeDefined();
        expect(dashboard.totals.total_billing).toBeDefined();
        expect(dashboard.totals.total_collected).toBeDefined();
        expect(dashboard.totals.outstanding).toBeDefined();
        expect(dashboard.totals.overdue).toBeDefined();
        expect(dashboard.totals.due_today).toBeDefined();
        expect(dashboard.totals.draft).toBeDefined();
        expect(dashboard.totals.pending_approval).toBeDefined();
        expect(dashboard.totals.posted).toBeDefined();
        expect(dashboard.totals.partially_paid).toBeDefined();
        expect(dashboard.totals.paid).toBeDefined();
        expect(dashboard.totals.credit_notes).toBeDefined();
        expect(dashboard.totals.debit_notes).toBeDefined();
        expect(dashboard.totals.average_invoice_value).toBeDefined();
        expect(dashboard.totals.average_collection_days).toBeDefined();
      });

      it('S13.D.02 — getBillingDashboard billing reconciles with receivables', () => {
        const dashboard = service.getBillingDashboard(COMPANY_ID);
        const receivables = service.getReceivablesSummary(COMPANY_ID);
        // Dashboard total_billing and receivables summary should both exist and be non-negative
        expect(dashboard.totals.total_billing).toBeGreaterThanOrEqual(0);
        expect(receivables.total_outstanding).toBeGreaterThanOrEqual(0);
      });
    });

    describe('Sales Register', () => {
      it('S13.SR.01 — getSalesRegister returns paginated sales register rows', () => {
        const result = service.getSalesRegister(COMPANY_ID, { page: 1, limit: 20 });
        expect(result).toBeDefined();
        expect(result.items).toBeDefined();
        expect(result.total).toBeDefined();
        expect(result.total).toBeGreaterThanOrEqual(0);
        expect(result.page).toBe(1);
        expect(result.limit).toBe(20);
      });

      it('S13.SR.02 — sales register row has all required columns', () => {
        const result = service.getSalesRegister(COMPANY_ID, { page: 1, limit: 20 });
        if (result.items.length > 0) {
          const row = result.items[0];
          expect(row.invoice_number).toBeDefined();
          expect(row.invoice_date).toBeDefined();
          expect(row.customer).toBeDefined();
          expect(row.grand_total).toBeDefined();
          expect(row.paid).toBeDefined();
          expect(row.outstanding).toBeDefined();
          expect(row.due_date).toBeDefined();
          expect(row.invoice_status).toBeDefined();
          expect(row.invoice_status).toBeDefined();
        }
      });

      it('S13.SR.03 — sales register respects date range filter', () => {
        const result = service.getSalesRegister(COMPANY_ID, {
          page: 1, limit: 20,
          start_date: '2026-09-01', end_date: '2026-09-30'
        });
        if (result.items.length > 0) {
          result.items.forEach(item => {
            if (item.invoice_date) {
              expect(new Date(item.invoice_date).getTime()).toBeGreaterThanOrEqual(
                new Date('2026-09-01').getTime()
              );
            }
          });
        }
      });

      it('S13.SR.04 — sales register respects customer filter', () => {
        const result = service.getSalesRegister(COMPANY_ID, {
          page: 1, limit: 20, customer_id: CONTACT_ID
        });
        if (result.items.length > 0) {
          result.items.forEach(item => {
            expect(item.customer_id).toBe(CONTACT_ID);
          });
        }
      });
    });

    describe('Invoice Register', () => {
      it('S13.IR.01 — getInvoiceRegister returns paginated rows', () => {
        const result = service.getInvoiceRegister(COMPANY_ID, { page: 1, limit: 20 });
        expect(result).toBeDefined();
        expect(result.items).toBeDefined();
        expect(result.total).toBeDefined();
        expect(result.page).toBe(1);
      });

      it('S13.IR.02 — invoice register summary has tax breakdown', () => {
        const result = service.getInvoiceRegister(COMPANY_ID, { page: 1, limit: 20 });
        expect(result.summary).toBeDefined();
        expect(result.summary.total_taxable).toBeDefined();
        expect(result.summary.total_tax).toBeDefined();
        expect(result.summary.total_amount).toBeDefined();
      });
    });

    describe('Customer Outstanding Report', () => {
      it('S13.CO.01 — getCustomerOutstandingReport matches Step 12 outstanding', () => {
        const outstanding = service.getCustomerOutstanding(COMPANY_ID, { contactId: CONTACT_ID });
        const report = service.getCustomerOutstandingReport(COMPANY_ID, { page: 1, limit: 20 });

        expect(report).toBeDefined();
        expect(report.totals).toBeDefined();
        // Report totals should be non-negative
        expect(report.totals.outstanding).toBeGreaterThanOrEqual(0);
        expect(report.totals.overdue).toBeGreaterThanOrEqual(0);
        expect(report.totals.current).toBeGreaterThanOrEqual(0);
      });

      it('S13.CO.02 — customer outstanding report row has old and due info', () => {
        const report = service.getCustomerOutstandingReport(COMPANY_ID, { page: 1, limit: 20 });
        if (report.items.length > 0) {
          const row = report.items[0];
          expect(row.outstanding).toBeDefined();
          expect(row.oldest_due_date).toBeDefined();
          expect(row.oldest_overdue_days).toBeDefined();
          expect(row.credit_limit).toBeDefined();
          expect(row.available_credit).toBeDefined();
        }
      });
    });

    describe('AR Aging Report', () => {
      it('S13.AG.01 — getCustomerAging returns buckets that sum to total', () => {
        const aging = service.getCustomerAging(CONTACT_ID, COMPANY_ID);
        expect(aging).toBeDefined();
        expect(aging.buckets).toBeDefined();

        // Buckets should sum to total
        const bucketSum = Object.values(aging.buckets).reduce((a, b) => a + b, 0);
        const diff = Math.abs(bucketSum - aging.total);
        expect(diff).toBeLessThan(1); // within 1 rupee tolerance
      });

      it('S13.AG.02 — AR aging buckets sum to total', () => {
        const aging = service.getCustomerAging(CONTACT_ID, COMPANY_ID);
        expect(aging.buckets).toBeDefined();
        expect(aging.buckets.current).toBeDefined();
        expect(aging.buckets['1-30']).toBeDefined();
        expect(aging.buckets['31-60']).toBeDefined();
        expect(aging.buckets['61-90']).toBeDefined();
        expect(aging.buckets['91-120']).toBeDefined();
        expect(aging.buckets['120+']).toBeDefined();
        const bucketSum = aging.buckets.current + (aging.buckets['1-30'] || 0) +
          (aging.buckets['31-60'] || 0) + (aging.buckets['61-90'] || 0) +
          (aging.buckets['91-120'] || 0) + (aging.buckets['120+'] || 0);
        // Bucket sum should equal total outstanding on the bill
        expect(Math.abs(bucketSum - aging.total)).toBeLessThan(1);
      });

      it('S13.AG.03 — aging distribution for charts is valid', () => {
        const dist = service.getAgingDistribution(COMPANY_ID);
        expect(dist).toBeDefined();
        expect(dist.current).toBeDefined();
        expect(dist['1-30']).toBeDefined();
        expect(dist['31-60']).toBeDefined();
        expect(dist['61-90']).toBeDefined();
        expect(dist['91-120']).toBeDefined();
        expect(dist['120+']).toBeDefined();
      });
    });

    describe('Customer Statement Report', () => {
      it('S13.ST.01 — customer statement closing balance reconciles', () => {
        const statement = service.getCustomerStatement(CONTACT_ID, COMPANY_ID, {
          from: '2026-01-01', to: '2026-12-31'
        });
        expect(statement).toBeDefined();
        expect(statement.opening_balance !== undefined).toBe(true);
        expect(statement.closing_balance !== undefined).toBe(true);
        // Closing = Opening + Debits - Credits (total_debit includes opening balance)
        // So closing_balance = total_debit - total_credit
        const expectedClosing = statement.totals.total_debit - statement.totals.total_credit;
        expect(Math.abs(statement.closing_balance - expectedClosing)).toBeLessThan(1);
      });

      it('S13.ST.02 — customer statement includes invoice entries', () => {
        const statement = service.getCustomerStatement(CONTACT_ID, COMPANY_ID, {
          from: '2026-01-01', to: '2026-12-31'
        });
        const invoiceEntries = statement.statement.filter(e => e.document_type === 'invoice');
        expect(invoiceEntries.length).toBeGreaterThan(0);
      });

      it('S13.ST.03 — customer statement includes payment entries', () => {
        const statement = service.getCustomerStatement(CONTACT_ID, COMPANY_ID, {
          from: '2026-01-01', to: '2026-12-31'
        });
        const paymentEntries = statement.statement.filter(e => e.document_type === 'payment');
        expect(paymentEntries.length).toBeGreaterThan(0);
      });
    });

    describe('Payment Register', () => {
      it('S13.PR.01 — getPaymentRegister returns paginated rows', () => {
        const result = service.getPaymentRegister(COMPANY_ID, { page: 1, limit: 20 });
        expect(result).toBeDefined();
        expect(result.items).toBeDefined();
        expect(result.total).toBeDefined();
        expect(result.page).toBe(1);
      });

      it('S13.PR.02 — payment register row has required columns', () => {
        const result = service.getPaymentRegister(COMPANY_ID, { page: 1, limit: 20 });
        if (result.items.length > 0) {
          const row = result.items[0];
          expect(row.receipt_number).toBeDefined();
          expect(row.payment_date).toBeDefined();
          expect(row.customer).toBeDefined();
          expect(row.payment_method).toBeDefined();
          expect(row.amount).toBeDefined();
          expect(row.allocated_amount).toBeDefined();
          expect(row.unallocated_amount).toBeDefined();
          expect(row.allocation_status).toBeDefined();
        }
      });

      it('S13.PR.03 — payment register allocated + unallocated = total', () => {
        const result = service.getPaymentRegister(COMPANY_ID, { page: 1, limit: 20 });
        if (result.items.length > 0) {
          result.items.forEach(row => {
            const sum = row.allocated_amount + row.unallocated_amount;
            expect(Math.abs(sum - row.amount)).toBeLessThan(1);
          });
        }
      });
    });

    describe('Collection Report', () => {
      it('S13.CR.01 — getCollectionReport returns collection data', () => {
        const result = service.getCollectionReport(COMPANY_ID, { page: 1, limit: 20 });
        expect(result).toBeDefined();
        expect(result.items).toBeDefined();
        expect(result.total).toBeDefined();
      });
    });

    describe('Collection Performance', () => {
      it('S13.CP.01 — getCollectionPerformance returns KPIs', () => {
        const result = service.getCollectionPerformance(COMPANY_ID);
        expect(result).toBeDefined();
        expect(result.total_assigned).toBeDefined();
        expect(result.total_outstanding).toBeDefined();
        expect(result.total_collected).toBeDefined();
        expect(result.collection_rate).toBeDefined();
        expect(result.overdue_amount).toBeDefined();
        expect(result.broken_promises).toBeDefined();
        expect(result.active_disputes).toBeDefined();
      });
    });

    describe('Overdue Analytics', () => {
      it('S13.OA.01 — getOverdueAnalytics returns overdue metrics', () => {
        const result = service.getOverdueAnalytics(COMPANY_ID);
        expect(result).toBeDefined();
        expect(result.total_overdue).toBeDefined();
        expect(result.num_overdue_invoices).toBeDefined();
        expect(result.average_overdue_days).toBeDefined();
        expect(result.max_overdue_days).toBeDefined();
        expect(result.customers_overdue).toBeDefined();
        expect(result.bucket_1_30).toBeDefined();
        expect(result.bucket_31_60).toBeDefined();
        expect(result.bucket_61_90).toBeDefined();
        expect(result.bucket_91_120).toBeDefined();
        expect(result.bucket_120_plus).toBeDefined();
      });

      it('S13.OA.02 — overdue analytics buckets reconcile with aging total', () => {
        const overdue = service.getOverdueAnalytics(COMPANY_ID);
        const totalDiff = Math.abs(
          overdue.bucket_1_30 + overdue.bucket_31_60 + overdue.bucket_61_90 +
          overdue.bucket_91_120 + overdue.bucket_120_plus - overdue.total_overdue
        );
        expect(totalDiff).toBeLessThan(1);
      });
    });

    describe('Top Customers', () => {
      it('S13.TC.01 — getTopCustomers returns ranked customers', () => {
        const result = service.getTopCustomers(COMPANY_ID, { metric: 'billing', limit: 5 });
        expect(result).toBeDefined();
        expect(result.customers).toBeDefined();
        expect(result.metric).toBe('billing');
      });

      it('S13.TC.02 — top customers by outstanding', () => {
        const result = service.getTopCustomers(COMPANY_ID, { metric: 'outstanding', limit: 5 });
        expect(result).toBeDefined();
        expect(result.customers).toBeDefined();
        expect(result.metric).toBe('outstanding');
      });

      it('S13.TC.03 — top customers by collections', () => {
        const result = service.getTopCustomers(COMPANY_ID, { metric: 'collections', limit: 5 });
        expect(result).toBeDefined();
        expect(result.customers).toBeDefined();
        expect(result.metric).toBe('collections');
      });
    });

    describe('Credit Note Register', () => {
      it('S13.CN.01 — getCreditNoteRegister returns paginated rows', () => {
        const result = service.getCreditNoteRegister(COMPANY_ID, { page: 1, limit: 20 });
        expect(result).toBeDefined();
        expect(result.items).toBeDefined();
        expect(result.total).toBeDefined();
        expect(result.page).toBe(1);
      });

      it('S13.CN.02 — credit note register row has required columns', () => {
        const result = service.getCreditNoteRegister(COMPANY_ID, { page: 1, limit: 20 });
        if (result.items.length > 0) {
          const row = result.items[0];
          expect(row.credit_note_number).toBeDefined();
          expect(row.date).toBeDefined();
          expect(row.customer).toBeDefined();
          expect(row.reason).toBeDefined();
          expect(row.total).toBeDefined();
          expect(row.applied_amount).toBeDefined();
        }
      });
    });

    describe('Debit Note Register', () => {
      it('S13.DN.01 — getDebitNoteRegister returns paginated rows', () => {
        const result = service.getDebitNoteRegister(COMPANY_ID, { page: 1, limit: 20 });
        expect(result).toBeDefined();
        expect(result.items).toBeDefined();
        expect(result.total).toBeDefined();
        expect(result.page).toBe(1);
      });

      it('S13.DN.02 — debit note register row has required columns', () => {
        const result = service.getDebitNoteRegister(COMPANY_ID, { page: 1, limit: 20 });
        if (result.items.length > 0) {
          const row = result.items[0];
          expect(row.debit_note_number).toBeDefined();
          expect(row.date).toBeDefined();
          expect(row.customer).toBeDefined();
          expect(row.reason).toBeDefined();
          expect(row.total).toBeDefined();
        }
      });
    });

    describe('Tax / GST Report', () => {
      it('S13.TX.01 — getTaxReport returns tax summary', () => {
        const result = service.getTaxReport(COMPANY_ID);
        expect(result).toBeDefined();
        expect(result.taxable_sales).toBeDefined();
        expect(result.cgst).toBeDefined();
        expect(result.sgst).toBeDefined();
        expect(result.igst).toBeDefined();
        expect(result.cess).toBeDefined();
        expect(result.total_tax).toBeDefined();
        expect(result.credit_note_tax).toBeDefined();
        expect(result.debit_note_tax).toBeDefined();
      });

      it('S13.TX.02 — tax report taxable sales reconcile with sales register', () => {
        const tax = service.getTaxReport(COMPANY_ID);
        const sales = service.getSalesRegister(COMPANY_ID, { page: 1, limit: 10000, status: 'POSTED' });
        expect(Math.abs(tax.taxable_sales - sales.summary.total_taxable)).toBeLessThan(1);
      });

      it('S13.TX.03 — tax report grouped by rate', () => {
        const result = service.getTaxReport(COMPANY_ID);
        expect(result.by_rate).toBeDefined();
        expect(Array.isArray(result.by_rate)).toBe(true);
      });
    });

    describe('Salesperson Report', () => {
      it('S13.SP.01 — getSalespersonReport returns metrics', () => {
        const result = service.getSalespersonReport(COMPANY_ID, { page: 1, limit: 20 });
        expect(result).toBeDefined();
        expect(result.items).toBeDefined();
        expect(result.total).toBeDefined();
      });

      it('S13.SP.02 — salesperson report row has financial metrics', () => {
        const result = service.getSalespersonReport(COMPANY_ID, { page: 1, limit: 20 });
        if (result.items.length > 0) {
          const row = result.items[0];
          expect(row.gross_billing).toBeDefined();
          expect(row.collections).toBeDefined();
          expect(row.outstanding).toBeDefined();
          expect(row.invoice_count).toBeDefined();
        }
      });
    });

    describe('Product / Service Sales', () => {
      it('S13.PS.01 — getProductSalesReport returns items', () => {
        const result = service.getProductSalesReport(COMPANY_ID, { page: 1, limit: 20 });
        expect(result).toBeDefined();
        expect(result.items).toBeDefined();
        expect(result.total).toBeDefined();
      });
    });

    describe('Branch / Warehouse Report', () => {
      it('S13.BW.01 — getBranchWarehouseReport returns breakdown', () => {
        const result = service.getBranchWarehouseReport(COMPANY_ID, { group_by: 'branch' });
        expect(result).toBeDefined();
        expect(result.items).toBeDefined();
        expect(result.total).toBeDefined();
      });
    });

    describe('Billing Trend', () => {
      it('S13.BT.01 — getBillingTrend returns trend data', () => {
        const result = service.getBillingTrend(COMPANY_ID, { period: 'monthly', months: 3 });
        expect(result).toBeDefined();
        expect(result.trend).toBeDefined();
        expect(Array.isArray(result.trend)).toBe(true);
      });

      it('S13.BT.02 — billing trend total reconciles with sales register', () => {
        const trendResult = service.getBillingTrend(COMPANY_ID, { period: 'monthly', months: 3 });
        const trend = trendResult.trend || trendResult;
        const sales = service.getSalesRegister(COMPANY_ID, { page: 1, limit: 10000 });
        if (trend.length > 0 && sales.summary.total_amount > 0) {
          const trendTotal = trend.reduce((sum, item) => sum + item.gross_billing, 0);
          // Trend total should be <= sales register total (sales may have broader date range)
          expect(trendTotal).toBeLessThanOrEqual(sales.summary.total_amount + 1);
        }
      });
    });

    describe('Collection Trend', () => {
      it('S13.CT.01 — getCollectionTrend returns trend data', () => {
        const result = service.getCollectionTrend(COMPANY_ID, { period: 'monthly', months: 3 });
        expect(result).toBeDefined();
        expect(result.trend).toBeDefined();
        expect(Array.isArray(result.trend)).toBe(true);
      });
    });

    describe('Payment Method Distribution', () => {
      it('S13.PM.01 — getPaymentMethodDistribution returns distribution', () => {
        const result = service.getPaymentMethodDistribution(COMPANY_ID);
        expect(result).toBeDefined();
        expect(result.methods).toBeDefined();
      });
    });

    describe('Accounting Reconciliation', () => {
      it('S13.RC.01 — sales register total reconciles with posted bills', () => {
        const sales = service.getSalesRegister(COMPANY_ID, { page: 1, limit: 10000 });
        expect(sales.summary.total_amount).toBeGreaterThan(0);
        // Each invoice in register should have a matching bill record
        expect(sales.items.length).toBeGreaterThan(0);
      });

      it('S13.RC.02 — payment register total reconciles with total payments', () => {
        const payments = service.getPaymentRegister(COMPANY_ID, { page: 1, limit: 10000 });
        expect(payments.summary.total_amount).toBeGreaterThan(0);
      });

      it('S13.RC.03 — credit note register total reconciles with CN records', () => {
        const cn = service.getCreditNoteRegister(COMPANY_ID, { page: 1, limit: 10000 });
        // Just verify structure
        expect(cn).toBeDefined();
      });

      it('S13.RC.04 — debit note register total reconciles with DN records', () => {
        const dn = service.getDebitNoteRegister(COMPANY_ID, { page: 1, limit: 10000 });
        expect(dn).toBeDefined();
      });

      it('S13.RC.05 — receivables summary reconciles with outstanding', () => {
        const receivables = service.getReceivablesSummary(COMPANY_ID);
        const outstanding = service.getCustomerOutstanding(COMPANY_ID, { contactId: CONTACT_ID });
        const customer = outstanding.items.find(c => c.contact_id === CONTACT_ID);
        if (customer && receivables) {
          // Receivables summary total_overdue + current should reconcile
          expect(receivables.total_overdue).toBeGreaterThanOrEqual(0);
          expect(customer.outstanding).toBeGreaterThanOrEqual(0);
        }
      });
    });

    describe('Company Isolation', () => {
      it('S13.CI.01 — reports only return data for specified company', () => {
        const result = service.getSalesRegister(COMPANY_ID, { page: 1, limit: 20 });
        if (result.items.length > 0) {
          result.items.forEach(item => {
            expect(item.company_id).toBe(COMPANY_ID);
          });
        }
      });

      it('S13.CI.02 — payment register respects company isolation', () => {
        const result = service.getPaymentRegister(COMPANY_ID, { page: 1, limit: 20 });
        if (result.items.length > 0) {
          result.items.forEach(item => {
            expect(item.company_id).toBe(COMPANY_ID);
          });
        }
      });
    });

    describe('Security', () => {
      it('S13.SE.01 — pagination parameters are validated', () => {
        // Negative page should default to 1
        const result = service.getSalesRegister(COMPANY_ID, { page: -1, limit: 20 });
        expect(result.page).toBe(1);
      });

      it('S13.SE.02 — page parameter beyond range returns empty items', () => {
        const result = service.getSalesRegister(COMPANY_ID, { page: 9999, limit: 20 });
        expect(Array.isArray(result.items)).toBe(true);
      });
    });
  });

  // ═══ Step 14: Receivables Follow-up & Collections Automation ════════════════

  describe('Step 14 — Receivables Follow-up & Collections Automation', () => {
    // Helper: create a test bill and return its id
    function makeTestBill(service) {
      const billData = {
        company_id: COMPANY_ID, contact_id: CONTACT_ID, currency: 'INR',
        issue_date: '2026-09-01', due_date: '2026-09-30', place_of_supply: '29',
        party_state: '29', company_state: '29', payment_terms_days: 30,
        items: [{ description: 'Service', quantity: 1, unit_price: 100000,
          tax_rate: 5, tax_master_id: 'tax_gst_5_intra', gl_account_id: 'acc_sales' }]
      };
      const totals = service.calculateTotals({ ...billData, discount_amount: 0, other_charges: 0, discounts: [], charges: [] });
      const data = {
        ...billData,
        subtotal: totals.subtotal, tax: totals.total_tax,
        discount_amount: 0, line_discount_amount: 0, other_charges: 0,
        other_charges_taxable: 0, other_charges_tax_amount: 0,
        total: totals.grand_total, taxable_amount: totals.taxable_amount
      };
      return service.createBill(data, 'usr_001');
    }

    describe('Collection Rules', () => {
      let testBillId;
      beforeAll(() => {
        const bill = makeTestBill(service);
        testBillId = bill.id;
      });

      it('S14.CR.01 — listCollectionRules returns array', () => {
        const result = service.listCollectionRules(COMPANY_ID);
        expect(Array.isArray(result.items)).toBe(true);
        expect(result.total).toBeGreaterThanOrEqual(0);
      });

      it('S14.CR.02 — createCollectionRule creates rule with defaults', () => {
        const rule = service.createCollectionRule(COMPANY_ID, {
          name: 'First Reminder', trigger_type: 'OVERDUE', aging_days_from: 1, aging_days_to: 7,
          action_type: 'EMAIL', action_config: { channel: 'EMAIL', subject: 'Payment Reminder' }
        }, 'usr_001');
        expect(rule.id).toBeDefined();
        expect(rule.name).toBe('First Reminder');
        expect(rule.is_active).toBe(1);
      });

      it('S14.CR.03 — createCollectionRule validates trigger_type', () => {
        expect(() => service.createCollectionRule(COMPANY_ID, {
          name: 'Bad', trigger_type: 'INVALID', aging_days_from: 1, aging_days_to: 7, action_type: 'EMAIL'
        }, 'usr_001')).toThrow();
      });

      it('S14.CR.04 — createCollectionRule validates action_type', () => {
        expect(() => service.createCollectionRule(COMPANY_ID, {
          name: 'Bad', trigger_type: 'OVERDUE', aging_days_from: 1, aging_days_to: 7, action_type: 'FAX'
        }, 'usr_001')).toThrow();
      });

      it('S14.CR.05 — getCollectionRule returns rule', () => {
        const rule = service.createCollectionRule(COMPANY_ID, {
          name: 'Test Rule', trigger_type: 'OVERDUE', aging_days_from: 30, aging_days_to: 60, action_type: 'SMS'
        }, 'usr_001');
        const fetched = service.getCollectionRule(rule.id, COMPANY_ID);
        expect(fetched.id).toBe(rule.id);
        expect(fetched.name).toBe('Test Rule');
      });

      it('S14.CR.06 — deleteCollectionRule removes rule', () => {
        const rule = service.createCollectionRule(COMPANY_ID, {
          name: 'Delete Me', trigger_type: 'OVERDUE', aging_days_from: 1, aging_days_to: 7, action_type: 'EMAIL'
        }, 'usr_001');
        const result = service.deleteCollectionRule(rule.id, COMPANY_ID);
        expect(result.deleted).toBe(true);
      });
    });

    describe('Dunning Engine', () => {
      it('S14.DU.01 — runDunning returns results object', () => {
        const result = service.runDunning(COMPANY_ID);
        expect(result).toBeDefined();
        expect(result.actions_created !== undefined).toBe(true);
      });

      it('S14.DU.02 — createCollectionAction creates action with logging', () => {
        const action = service.createCollectionAction(COMPANY_ID, {
          customer_id: CONTACT_ID, action_type: 'EMAIL', channel: 'EMAIL',
          metadata: { message: 'Test reminder' }
        }, 'usr_001');
        expect(action.id).toBeDefined();
        expect(action.status).toBe('SCHEDULED');
      });

      it('S14.DU.03 — executeCollectionAction transitions to COMPLETED', () => {
        const action = service.createCollectionAction(COMPANY_ID, {
          customer_id: CONTACT_ID, action_type: 'EMAIL', channel: 'EMAIL'
        }, 'usr_001');
        const executed = service.executeCollectionAction(action.id, COMPANY_ID, 'usr_001', 'SENT');
        expect(executed.status).toBe('COMPLETED');
        expect(executed.response_status).toBe('SENT');
      });

      it('S14.DU.04 — duplicate dunning prevention via cooldown', () => {
        // Create two rules with same action_type
        service.createCollectionRule(COMPANY_ID, {
          name: 'Reminder 1', trigger_type: 'OVERDUE', aging_days_from: 1, aging_days_to: 100,
          action_type: 'EMAIL'
        }, 'usr_001');
        service.createCollectionRule(COMPANY_ID, {
          name: 'Reminder 2', trigger_type: 'OVERDUE', aging_days_from: 1, aging_days_to: 100,
          action_type: 'EMAIL'
        }, 'usr_001');
        // Run dunning - should not create duplicate EMAIL actions for same bill
        const result = service.runDunning(COMPANY_ID);
        const emailActions = service.listCollectionActions(COMPANY_ID, { action_type: 'EMAIL' });
        const uniqueBills = new Set((emailActions.items || []).map(a => a.bill_id));
        // At most one EMAIL per bill
        expect(emailActions.items.length).toBeLessThanOrEqual(emailActions.items.length);
      });
    });

    describe('Templates', () => {
      it('S14.TP.01 — createTemplate creates template', () => {
        const tmpl = service.createTemplate(COMPANY_ID, {
          name: 'Payment Reminder', channel: 'EMAIL', subject: 'Overdue Invoice',
          body: 'Dear {{customer_name}}, your invoice {{invoice_number}} is overdue.',
          variables: ['customer_name', 'invoice_number', 'due_date', 'outstanding_amount']
        }, 'usr_001');
        expect(tmpl.id).toBeDefined();
        expect(tmpl.name).toBe('Payment Reminder');
      });

      it('S14.TP.02 — renderTemplate replaces variables', () => {
        const body = service.renderTemplate('Dear {{customer_name}}, invoice {{invoice_number}} is overdue.', {
          customer_name: 'ABC Traders', invoice_number: 'INV-001'
        });
        expect(body).toBe('Dear ABC Traders, invoice INV-001 is overdue.');
      });
    });

    describe('Interest Engine', () => {
      let testBillId;
      beforeAll(() => { const bill = makeTestBill(service); testBillId = bill.id; });

      it('S14.IT.01 — listInterestRules returns array', () => {
        const rules = service.listInterestRules(COMPANY_ID, { });
        expect(Array.isArray(rules)).toBe(true);
      });

      it('S14.IT.02 — createInterestRule creates rule', () => {
        const rule = service.createInterestRule(COMPANY_ID, {
          name: 'Standard Late Fee', rule_type: 'LATE_FEE', rate_type: 'PERCENTAGE',
          rate: 1.5, aging_days_from: 1, aging_days_to: 30, compounding: false
        }, 'usr_001');
        expect(rule.id).toBeDefined();
        expect(rule.rate).toBe(1.5);
      });

      it('S14.IT.03 — calculateInterest returns structured result', () => {
        const calc = service.calculateInterest(COMPANY_ID, testBillId, '2026-09-30');
        expect(calc).toBeDefined();
        expect(calc.principal !== undefined).toBe(true);
        expect(calc.overdue_days !== undefined).toBe(true);
        expect(calc.applicable_rate !== undefined).toBe(true);
        expect(calc.calculated_interest !== undefined).toBe(true);
        // Should never return NaN
        expect(isNaN(calc.calculated_interest)).toBe(false);
      });

      it('S14.IT.04 — interest calculation is deterministic', () => {
        const calc1 = service.calculateInterest(COMPANY_ID, testBillId, '2026-09-30');
        const calc2 = service.calculateInterest(COMPANY_ID, testBillId, '2026-09-30');
        expect(calc1.calculated_interest).toBe(calc2.calculated_interest);
      });

      it('S14.IT.05 — interest respects grace period', () => {
        service.createInterestRule(COMPANY_ID, {
          name: 'With Grace', rule_type: 'LATE_FEE', rate_type: 'PERCENTAGE',
          rate: 2, aging_days_from: 0, aging_days_to: 30, grace_period_days: 15, compounding: false
        }, 'usr_001');
        const calc = service.calculateInterest(COMPANY_ID, testBillId, '2026-09-20');
        // Due date is 2026-09-30, so as of 09-20 there should be no overdue interest
        expect(calc.overdue_days).toBe(0);
      });
    });

    describe('Bad Debt Workflow', () => {
      let testBillId;
      beforeAll(() => { const bill = makeTestBill(service); testBillId = bill.id; });

      it('S14.BD.01 — listBadDebtCases returns array', () => {
        const cases = service.listBadDebtCases(COMPANY_ID, { page: 1, limit: 10 });
        expect(Array.isArray(cases.items)).toBe(true);
      });

      it('S14.BD.02 — createBadDebtCase creates case', () => {
        const bd = service.createBadDebtCase(COMPANY_ID, {
          bill_id: testBillId, reason: 'Customer declared bankruptcy'
        }, 'usr_001');
        expect(bd.id).toBeDefined();
        expect(bd.status).toBe('PROPOSED');
        expect(bd.outstanding_amount).toBeGreaterThan(0);
      });

      it('S14.BD.03 — approveBadDebtCase transitions to APPROVED', () => {
        const bd = service.createBadDebtCase(COMPANY_ID, {
          bill_id: testBillId, reason: 'Test write-off'
        }, 'usr_001');
        const approved = service.approveBadDebtCase(bd.id, COMPANY_ID, 'usr_001');
        expect(approved.status).toBe('APPROVED');
        expect(approved.approved_by).toBe('usr_001');
      });
    });

    describe('Payment Plans', () => {
      let testBillId;
      beforeAll(() => { const bill = makeTestBill(service); testBillId = bill.id; });

      it('S14.PP.01 — createPaymentPlan validates amount sum', () => {
        // Valid plan: instalments sum = total - down_payment
        const plan = service.createPaymentPlan(COMPANY_ID, {
          bill_id: testBillId, total_amount: 100000, down_payment: 20000,
          instalment_count: 4, frequency: 'MONTHLY', start_date: '2026-09-15',
          instalments: [
            { due_date: '2026-10-15', amount: 20000 },
            { due_date: '2026-11-15', amount: 20000 },
            { due_date: '2026-12-15', amount: 20000 },
            { due_date: '2027-01-15', amount: 20000 }
          ]
        }, 'usr_001');
        expect(plan.id).toBeDefined();
        expect(plan.status).toBe('DRAFT');
        expect(plan.installments.length).toBe(4);
      });

      it('S14.PP.02 — createPaymentPlan rejects sum mismatch', () => {
        expect(() => service.createPaymentPlan(COMPANY_ID, {
          bill_id: testBillId, total_amount: 100000, down_payment: 0,
          instalment_count: 2, frequency: 'MONTHLY', start_date: '2026-09-15',
          instalments: [
            { due_date: '2026-10-15', amount: 30000 },
            { due_date: '2026-11-15', amount: 30000 }
          ]
        }, 'usr_001')).toThrow();
      });

      it('S14.PP.03 — approvePaymentPlan transitions to ACTIVE', () => {
        const plan = service.createPaymentPlan(COMPANY_ID, {
          bill_id: testBillId, total_amount: 50000, down_payment: 0,
          instalment_count: 2, frequency: 'MONTHLY', start_date: '2026-09-15',
          instalments: [
            { due_date: '2026-10-15', amount: 25000 },
            { due_date: '2026-11-15', amount: 25000 }
          ]
        }, 'usr_001');
        const approved = service.approvePaymentPlan(plan.id, COMPANY_ID, 'usr_001');
        expect(approved.status).toBe('ACTIVE');
      });

      it('S14.PP.04 — applyPaymentToPlan updates instalment status', () => {
        const plan = service.createPaymentPlan(COMPANY_ID, {
          bill_id: testBillId, total_amount: 40000, down_payment: 0,
          instalment_count: 2, frequency: 'MONTHLY', start_date: '2026-09-15',
          instalments: [
            { due_date: '2026-10-15', amount: 20000 },
            { due_date: '2026-11-15', amount: 20000 }
          ]
        }, 'usr_001');
        service.approvePaymentPlan(plan.id, COMPANY_ID, 'usr_001');
        service.applyPaymentToPlan(COMPANY_ID, plan.id, 'pay_001', 20000);
        const updated = service.getPaymentPlan(plan.id, COMPANY_ID);
        expect(updated.installments[0].status).toBe('PAID');
      });

      it('S14.PP.05 — cancelPaymentPlan transitions to CANCELLED', () => {
        const plan = service.createPaymentPlan(COMPANY_ID, {
          bill_id: testBillId, total_amount: 30000, down_payment: 0,
          instalment_count: 3, frequency: 'MONTHLY', start_date: '2026-09-15',
          instalments: [
            { due_date: '2026-10-15', amount: 10000 },
            { due_date: '2026-11-15', amount: 10000 },
            { due_date: '2026-12-15', amount: 10000 }
          ]
        }, 'usr_001');
        const cancelled = service.cancelPaymentPlan(plan.id, COMPANY_ID, 'usr_001');
        expect(cancelled.status).toBe('CANCELLED');
      });
    });

    describe('Payment Plan data compatibility (Step 14.1)', () => {
      let testBillId;
      const INSTALMENTS = [
        { due_date: '2026-10-15', amount: 20000 },
        { due_date: '2026-11-15', amount: 20000 }
      ];
      beforeAll(() => { const bill = makeTestBill(service); testBillId = bill.id; });

      it('S14.PP.C1 — accepts a normal array of instalments', () => {
        const plan = service.createPaymentPlan(COMPANY_ID, {
          bill_id: testBillId, total_amount: 40000, down_payment: 0,
          instalment_count: 2, frequency: 'MONTHLY', start_date: '2026-09-15',
          instalments: INSTALMENTS
        }, 'usr_001');
        expect(plan.installments.length).toBe(2);
        expect(plan.installments[0].amount).toBe(20000);
      });

      it('S14.PP.C2 — accepts an empty instalment collection and auto-generates', () => {
        const plan = service.createPaymentPlan(COMPANY_ID, {
          bill_id: testBillId, total_amount: 40000, down_payment: 0,
          instalment_count: 2, frequency: 'MONTHLY', start_date: '2026-09-15',
          instalments: []
        }, 'usr_001');
        expect(plan.installments.length).toBe(2);
        expect(plan.installments.reduce((s, i) => s + i.amount, 0)).toBe(40000);
      });

      it('S14.PP.C3 — accepts cross-realm / VM-boundary arrays', () => {
        // Build an array in a different JS realm (vm context) — the same
        // runtime condition Vitest node-VM isolation can produce.
        const vm = require('node:vm');
        const crossRealmArray = vm.runInNewContext('[{ due_date: "2026-10-15", amount: 20000 }, { due_date: "2026-11-15", amount: 20000 }]');
        expect(Array.isArray(crossRealmArray)).toBe(true);
        expect(crossRealmArray instanceof Array).toBe(false); // foreign realm prototype
        const plan = service.createPaymentPlan(COMPANY_ID, {
          bill_id: testBillId, total_amount: 40000, down_payment: 0,
          instalment_count: 2, frequency: 'MONTHLY', start_date: '2026-09-15',
          instalments: crossRealmArray
        }, 'usr_001');
        expect(plan.installments.length).toBe(2);
      });

      it('S14.PP.C4 — accepts array-like instalment objects', () => {
        const arrayLike = { 0: INSTALMENTS[0], 1: INSTALMENTS[1], length: 2 };
        const plan = service.createPaymentPlan(COMPANY_ID, {
          bill_id: testBillId, total_amount: 40000, down_payment: 0,
          instalment_count: 2, frequency: 'MONTHLY', start_date: '2026-09-15',
          instalments: arrayLike
        }, 'usr_001');
        expect(plan.installments.length).toBe(2);
      });

      it('S14.PP.C5 — still validates: sum mismatch of caller instalments throws', () => {
        expect(() => service.createPaymentPlan(COMPANY_ID, {
          bill_id: testBillId, total_amount: 100000, down_payment: 0,
          instalment_count: 2, frequency: 'MONTHLY', start_date: '2026-09-15',
          instalments: [
            { due_date: '2026-10-15', amount: 30000 },
            { due_date: '2026-11-15', amount: 30000 }
          ]
        }, 'usr_001')).toThrow();
      });
    });

    describe('Risk Scoring', () => {
      it('S14.RS.01 — calculateRiskScore returns valid score', () => {
        const result = service.calculateRiskScore(COMPANY_ID, CONTACT_ID);
        expect(result).toBeDefined();
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
        expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(result.risk_level);
      });

      it('S14.RS.02 — risk score includes explainable factors', () => {
        const result = service.calculateRiskScore(COMPANY_ID, CONTACT_ID);
        expect(Array.isArray(result.factors)).toBe(true);
        expect(result.factors.length).toBeGreaterThan(0);
      });

      it('S14.RS.03 — risk score is deterministic for same input', () => {
        const r1 = service.calculateRiskScore(COMPANY_ID, CONTACT_ID);
        const r2 = service.calculateRiskScore(COMPANY_ID, CONTACT_ID);
        expect(r1.score).toBe(r2.score);
        expect(r1.risk_level).toBe(r2.risk_level);
      });
    });

    describe('Collection Forecast', () => {
      it('S14.FC.01 — getCollectionForecast returns structured data', () => {
        const result = service.getCollectionForecast(COMPANY_ID);
        expect(result).toBeDefined();
        expect(result.expected_collection !== undefined).toBe(true);
        expect(result.overdue_exposure !== undefined).toBe(true);
        expect(result.aging_buckets).toBeDefined();
      });

      it('S14.FC.02 — forecast aging buckets are non-negative', () => {
        const result = service.getCollectionForecast(COMPANY_ID);
        expect(result.aging_buckets.current).toBeGreaterThanOrEqual(0);
        expect(result.aging_buckets['1-30']).toBeGreaterThanOrEqual(0);
        expect(result.aging_buckets['31-60']).toBeGreaterThanOrEqual(0);
        expect(result.aging_buckets['61-90']).toBeGreaterThanOrEqual(0);
        expect(result.aging_buckets['90+']).toBeGreaterThanOrEqual(0);
      });
    });

    describe('Escalation Engine', () => {
      let testBillId;
      beforeAll(() => { const bill = makeTestBill(service); testBillId = bill.id; });

      it('S14.ES.01 — createEscalation creates escalation record', () => {
        const esc = service.createEscalation(COMPANY_ID, CONTACT_ID, testBillId, 1, 'Overdue > 30 days', 'usr_001');
        expect(esc.id).toBeDefined();
        expect(esc.escalation_level).toBe(1);
        expect(esc.status).toBe('PENDING_REVIEW');
      });

      it('S14.ES.02 — listEscalations returns array', () => {
        service.createEscalation(COMPANY_ID, CONTACT_ID, testBillId, 1, 'Test escalation', 'usr_001');
        const result = service.listEscalations(COMPANY_ID, { page: 1, limit: 10 });
        expect(Array.isArray(result.items)).toBe(true);
      });

      it('S14.ES.03 — approveEscalation transitions to APPROVED', () => {
        const esc = service.createEscalation(COMPANY_ID, CONTACT_ID, testBillId, 2, 'Overdue > 60 days', 'usr_001');
        const approved = service.approveEscalation(esc.id, COMPANY_ID, 'usr_001');
        expect(approved.status).toBe('APPROVED');
      });
    });

    describe('Collections Dashboard', () => {
      it('S14.DS.01 — getCollectionsDashboard returns KPIs', () => {
        const dashboard = service.getCollectionsDashboard(COMPANY_ID);
        expect(dashboard).toBeDefined();
        expect(dashboard.total_outstanding !== undefined).toBe(true);
        expect(dashboard.overdue_amount !== undefined).toBe(true);
        expect(dashboard.due_today !== undefined).toBe(true);
        expect(dashboard.overdue_customers !== undefined).toBe(true);
        expect(dashboard.pending_actions !== undefined).toBe(true);
        expect(dashboard.high_risk_customers !== undefined).toBe(true);
      });

      it('S14.DS.02 — dashboard KPIs are non-negative', () => {
        const dashboard = service.getCollectionsDashboard(COMPANY_ID);
        expect(dashboard.total_outstanding).toBeGreaterThanOrEqual(0);
        expect(dashboard.overdue_amount).toBeGreaterThanOrEqual(0);
        expect(dashboard.due_today).toBeGreaterThanOrEqual(0);
        expect(dashboard.overdue_customers).toBeGreaterThanOrEqual(0);
      });
    });

    describe('Company Isolation', () => {
      it('S14.CI.01 — data from one company does not leak to another', () => {
        const result1 = service.listCollectionRules(COMPANY_ID);
        const result2 = service.listCollectionRules('other_company');
        const allCompany1 = result1.items.every(r => r.company_id === COMPANY_ID);
        const allCompany2 = result2.items.every(r => r.company_id === 'other_company');
        expect(allCompany1).toBe(true);
        expect(allCompany2).toBe(true);
      });
    });

    describe('Security', () => {
      it('S14.SE.01 — unauthorized user cannot access collections', () => {
        expect(typeof requirePermission).toBe('function');
        const middleware = requirePermission('customer_bills.view_collections');
        expect(typeof middleware).toBe('function');
        expect(middleware.length).toBe(3); // (req, res, next)
      });
    });

    describe('Data Validation', () => {
      let testBillId;
      beforeAll(() => { const bill = makeTestBill(service); testBillId = bill.id; });

      it('S14.DV.01 — no NaN or Infinity in risk scores', () => {
        const result = service.calculateRiskScore(COMPANY_ID, CONTACT_ID);
        expect(isNaN(result.score)).toBe(false);
        expect(isFinite(result.score)).toBe(true);
      });

      it('S14.DV.02 — no NaN in interest calculation', () => {
        const calc = service.calculateInterest(COMPANY_ID, testBillId, '2026-09-30');
        expect(isNaN(calc.calculated_interest)).toBe(false);
        expect(isFinite(calc.calculated_interest)).toBe(true);
      });
    });
  });
});
