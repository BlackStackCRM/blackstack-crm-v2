// Bootstrap/seed script.
//
// SECURITY: the legacy hard-coded admin@blackstack.local / admin123 bootstrap
// is gated behind explicit modes. Passwords are never logged.
//
//   Development bootstrap (explicit): DEMO_MODE=true npm run seed
//   Production bootstrap (explicit):  BOOTSTRAP_ADMIN_EMAIL=... BOOTSTRAP_ADMIN_PASSWORD=... npm run seed

const { DatabaseConnection } = require('./connection');
const bcrypt = require('bcryptjs');

async function seed() {
  const db = new DatabaseConnection();
  const conn = db.connect();

  const demoMode = process.env.DEMO_MODE === 'true';
  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if (!demoMode && !(bootstrapEmail && bootstrapPassword)) {
    console.warn(
      '[seed] Refusing to seed: no bootstrap credentials provided.\n' +
      '  Development: DEMO_MODE=true npm run seed\n' +
      '  Production:  BOOTSTRAP_ADMIN_EMAIL=... BOOTSTRAP_ADMIN_PASSWORD=... npm run seed'
    );
    conn.close();
    return;
  }

  const companyId = process.env.BOOTSTRAP_COMPANY_ID || 'default';

  conn.prepare('INSERT OR IGNORE INTO companies (id, name) VALUES (?, ?)')
    .run(companyId, 'BlackStack Default Company');

  // Ensure a financial year covering the current period exists and is active
  const currentYear = new Date().getFullYear();
  const fyStart = `${currentYear}-04-01`;
  const fyEnd = `${currentYear + 1}-03-31`;
  const fyId = `fy_${currentYear}`;
  conn.prepare('INSERT OR IGNORE INTO financial_years (id, company_id, name, start_date, end_date, is_active, is_locked, created_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?)')
    .run(fyId, companyId, `FY ${currentYear}`, fyStart, fyEnd, '2024-01-01T00:00:00Z');
  // Deactivate other financial years so the seeded one is uniquely active
  conn.prepare('UPDATE financial_years SET is_active = 0 WHERE id != ? AND company_id = ?').run(fyId, companyId);

  let adminEmail = bootstrapEmail;
  if (demoMode && !adminEmail) adminEmail = 'admin@blackstack.local';
  let adminPassword = bootstrapPassword;
  if (demoMode && !adminPassword) adminPassword = 'admin123';

  // The insert below hard-codes BOTH the primary key and the username to
  // 'admin'. users enforces three independent unique constraints on
  // (id, username, email), so an existence check on email ALONE is not
  // sufficient: a database that already holds username='admin' (or id='admin')
  // under a DIFFERENT email passes this check and then aborts the insert with
  // "UNIQUE constraint failed: users.username", which — because app.js chains
  // seed().then(startServer) — prevents the server from ever starting.
  //
  // Match the constraint we are actually about to violate. This is a read-only
  // widening of the guard; it changes no schema, no identity semantics and no
  // authentication behaviour.
  const ADMIN_ID = 'admin';
  const ADMIN_USERNAME = 'admin';

  const adminExists = conn.prepare(
    'SELECT id FROM users WHERE email = ? OR username = ? COLLATE NOCASE OR id = ? LIMIT 1'
  ).get(adminEmail, ADMIN_USERNAME, ADMIN_ID);

  if (adminExists) {
    console.log('[seed] Admin user already exists. Skipping admin creation (demo/master data seeding continues).');
  } else {
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    conn.transaction(() => {
      conn.prepare(`
        INSERT INTO users (id, company_id, username, email, password_hash, full_name, role, status)
        VALUES (?, ?, ?, ?, ?, ?, 'ADMIN', 'ACTIVE')
      `).run(ADMIN_ID, companyId, ADMIN_USERNAME, adminEmail, passwordHash, 'System Administrator');
      conn.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)')
        .run(ADMIN_ID, 'role_admin');
    })();
    console.log('[seed]' + (demoMode ? ' DEMO admin created (development credentials, NOT for production).' : ' Bootstrap administrator created.'));
  }

  // PHASE-QA FIX: master/demo data seeding used to live INSIDE the `else` of
  // the admin-exists check, so a database that already had the admin user
  // never got its account_groups / accounts / models / brands seeded — which
  // left the Chart of Accounts, Journal and Products dropdowns empty in the
  // packaged app. Seeding now runs whenever demoMode is on, regardless of
  // whether the admin was created above.
  if (demoMode) {
    // PHASE-QA FIX: this whole block used to be gated on `!hasDemo` (org_001
    // missing), so a DB that already had the demo org never got its inventory
    // master data. Each insert below is now independently idempotent
    // (INSERT OR IGNORE / guarded), so the block is safe to run every time.
    {
      conn.transaction(() => {
        conn.prepare(`
          INSERT OR IGNORE INTO organizations (id, company_id, name, industry, status)
          VALUES (?, ?, 'Acme Corporation', 'Technology', 'ACTIVE')
        `).run('org_001', companyId);
        conn.prepare(`
          INSERT OR IGNORE INTO contacts (id, company_id, first_name, last_name, email, phone, job_title, organization_id, status)
          VALUES (?, ?, 'John', 'Doe', 'john@acme.com', '+1-555-0101', 'CEO', 'org_001', 'ACTIVE')
        `).run('cnt_001', companyId);
        for (const [id, name, ord, prob, color] of [
          ['stage_001', 'Discovery', 1, 0.1, '#64748b'],
          ['stage_002', 'Proposal', 2, 0.4, '#3b82f6'],
          ['stage_003', 'Negotiation', 3, 0.7, '#f59e0b'],
          ['stage_004', 'Closing', 4, 0.9, '#10b981']
        ]) {
          conn.prepare(`
            INSERT OR IGNORE INTO pipeline_stages (id, company_id, name, stage_order, probability, color)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(id, companyId, name, ord, prob, color);
        }
        conn.prepare(`
          INSERT OR IGNORE INTO products (id, company_id, name, description, category, sku, price, cost, is_active)
          VALUES (?, ?, 'Cloud Infrastructure Tier 1', 'Standard multi-tenant cloud compute', 'Software', 'SW-CLD-T1', 1200, 300, 1)
        `).run('prod_001', companyId);
      })();

      // Seed inventory master data (stock_categories, units_of_measure, stock_groups, brands)
      // Each entry: [tableName, [columnNames], [[rowValues], ...]]
      // Column count and placeholder count are derived dynamically per table
      // so tables with extra columns (e.g. units_of_measure.symbol) are handled correctly.
      const inventoryMasters = [
        ['stock_categories', ['id', 'company_id', 'name'], [
          ['cat_electronics','default','Electronics'],
          ['cat_software','default','Software'],
          ['cat_gaming','default','Gaming Computers'],
          ['cat_furniture','default','Furniture'],
          ['cat_food','default','Food'],
          ['cat_spare','default','Spare Parts'],
          ['cat_raw','default','Raw Materials'],
          ['cat_finished','default','Finished Goods'],
          ['cat_consumables','default','Consumables'],
          ['cat_machinery','default','Machinery'],
        ]],
        ['units_of_measure', ['id', 'company_id', 'name', 'symbol'], [
          ['unit_01M3BEXSZMT69RKZYY1Q0B2TQ5','default','Each','pcs'],
          ['unit_01M3BEXSZMT69RKZYY1Q0B2TQ6','default','Kilogram','kg'],
          ['unit_01M3BEXSZMT69RKZYY1Q0B2TQ7','default','Liter','L'],
        ]],
      ];
      for (const [table, columns, rows] of inventoryMasters) {
        const colList = columns.join(', ');
        const rowPlaceholders = `(${columns.map(() => '?').join(', ')})`;
        const placeholders = rows.map(() => rowPlaceholders).join(',');
        const params = rows.flat();
        conn.prepare(`INSERT OR IGNORE INTO ${table} (${colList}) VALUES ${placeholders}`).run(...params);
      }
      // Seed stock_groups and brands if those tables exist
      // (These may be absent in older migration sets — guard with try/catch)
      try {
        const stockGroupSeed = [
          ['grp_electronics','default','Electronics','Products related to electronics and technology'],
          ['grp_furniture','default','Furniture','Furniture and fixtures'],
          ['grp_grocery','default','Grocery','Food and grocery items'],
          ['grp_trading','default','Trading Goods','General trading goods'],
          ['grp_finished','default','Finished Goods','Finished manufactured products'],
        ];
        const sgInsert = conn.prepare('INSERT OR IGNORE INTO stock_groups (id, company_id, name, description, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?)');
        const ts = new Date().toISOString();
        for (const [id, cid, name, desc, active] of stockGroupSeed) {
          sgInsert.run(id, cid, name, desc, active, ts, ts);
        }
        // Legacy groups
        conn.prepare('INSERT OR IGNORE INTO stock_groups (id, company_id, name, is_active) VALUES (?,?,?,?)').run('grp_001','default','Trading Goods','Yes');
        conn.prepare('INSERT OR IGNORE INTO stock_groups (id, company_id, name, is_active) VALUES (?,?,?,?)').run('grp_002','default','Finished Goods','Yes');

        // Link existing stock_categories to stock_groups (migration safety)
        const sgColExists = conn.prepare("PRAGMA table_info(stock_categories)").all().find(c => c.name === 'stock_group_id');
        if (sgColExists) {
          const catGroupMapping = {
            'cat_electronics': 'grp_electronics',
            'cat_software': 'grp_trading',
            'cat_gaming': 'grp_electronics',
            'cat_furniture': 'grp_furniture',
            'cat_food': 'grp_grocery',
            'cat_spare': 'grp_trading',
            'cat_raw': 'grp_trading',
            'cat_finished': 'grp_finished',
            'cat_consumables': 'grp_trading',
            'cat_machinery': 'grp_trading',
          };
          for (const [catId, grpId] of Object.entries(catGroupMapping)) {
            conn.prepare('UPDATE stock_categories SET stock_group_id = ? WHERE id = ? AND (stock_group_id IS NULL OR stock_group_id = ?)')
              .run(grpId, catId, '');
          }
          console.log('[seed] Stock categories linked to stock groups');
        }
        console.log('[seed] Stock groups seeded');
      } catch (e) { /* table not present — skip */ }
      try {
        conn.prepare('INSERT OR IGNORE INTO brands (id, company_id, name, is_active) VALUES (?,?,?,?)').run('brand_001','default','Generic','Yes');
      } catch (e) { /* table not present — skip */ }
      // Seed a default godown — stock_balances.godown_id references godowns(id),
      // so a default godown must exist for opening stock to succeed.
      try {
        conn.prepare('INSERT OR IGNORE INTO godowns (id, company_id, name, code, is_active) VALUES (?,?,?,?,?)')
          .run('god_001','default','Main Warehouse','GW001',1);
      } catch (e) { /* table not present — skip */ }

      // ── Chart of Accounts seed (account groups + GL accounts) ──
      // The packaged app shares this database, and migration 023 can be
      // recorded as applied while its rows are absent (restored/older DB),
      // leaving the Chart of Accounts group dropdown and the Journal GL
      // dropdown empty. INSERT OR IGNORE makes re-runs harmless.
      try {
        const ts = '2024-01-01T00:00:00Z';
        const agInsert = conn.prepare('INSERT OR IGNORE INTO account_groups (id, company_id, code, name, parent_id, type, debit_credit_nature, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
        for (const [id, code, name, parent, type, nature] of [
          ['ag_asset','1000','Assets',null,'ASSET','DEBIT'],
          ['ag_liability','2000','Liabilities',null,'LIABILITY','CREDIT'],
          ['ag_equity','3000','Equity',null,'EQUITY','CREDIT'],
          ['ag_income','4000','Income',null,'INCOME','CREDIT'],
          ['ag_expense','5000','Expenses',null,'EXPENSE','DEBIT'],
          ['ag_cash','1100','Cash','ag_asset','ASSET','DEBIT'],
          ['ag_bank','1200','Banks','ag_asset','ASSET','DEBIT'],
          ['ag_receivable','1300','Accounts Receivable','ag_asset','ASSET','DEBIT'],
          ['ag_payable','2100','Accounts Payable','ag_liability','LIABILITY','CREDIT'],
          ['ag_loan','2200','Loans','ag_liability','LIABILITY','CREDIT'],
          ['ag_capital','3100','Capital','ag_equity','EQUITY','CREDIT'],
          ['ag_retained','3200','Retained Earnings','ag_equity','EQUITY','CREDIT'],
          ['ag_sales','4100','Sales','ag_income','INCOME','CREDIT'],
          ['ag_service','4200','Service Income','ag_income','INCOME','CREDIT'],
          ['ag_rent','5100','Rent','ag_expense','EXPENSE','DEBIT'],
          ['ag_salaries','5200','Salaries','ag_expense','EXPENSE','DEBIT'],
          ['ag_marketing','5300','Marketing','ag_expense','EXPENSE','DEBIT'],
          ['ag_utilities','5400','Utilities','ag_expense','EXPENSE','DEBIT'],
          ['ag_purchases','5500','Purchases','ag_expense','EXPENSE','DEBIT'],
          ['ag_cost_goods','5600','Cost of Goods Sold','ag_expense','EXPENSE','DEBIT'],
        ]) {
          agInsert.run(id, companyId, code, name, parent, type, nature, 1, ts, ts);
        }
        console.log('[seed] Account groups ensured');

        const accInsert = conn.prepare('INSERT OR IGNORE INTO accounts (id, company_id, code, name, account_group_id, type, debit_credit_nature, opening_balance, opening_balance_type, description, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const [id, code, name, grp, type, nature, desc] of [
          ['acc_cash','1001','Cash in Hand','ag_cash','CASH','DEBIT','Cash on hand'],
          ['acc_bank','1002','Bank Account','ag_bank','BANK','DEBIT','Primary checking account'],
          ['acc_receivable','1003','Accounts Receivable','ag_receivable','ASSET','DEBIT','Trade receivables'],
          ['acc_payable','2001','Accounts Payable','ag_payable','LIABILITY','CREDIT','Trade payables'],
          ['acc_capital','3001','Share Capital','ag_capital','EQUITY','CREDIT',"Owner's capital"],
          ['acc_retained','3002','Retained Earnings','ag_retained','EQUITY','CREDIT','Retained earnings'],
          ['acc_sales','4001','Sales Revenue','ag_sales','INCOME','CREDIT','Revenue from sales'],
          ['acc_service','4002','Service Revenue','ag_service','INCOME','CREDIT','Revenue from services'],
          ['acc_rent','5001','Rent Expense','ag_rent','EXPENSE','DEBIT','Office rent'],
          ['acc_salaries','5002','Salaries Expense','ag_salaries','EXPENSE','DEBIT','Employee salaries'],
          ['acc_marketing','5003','Marketing Expense','ag_marketing','EXPENSE','DEBIT','Advertising and marketing'],
          ['acc_utilities','5004','Utilities Expense','ag_utilities','EXPENSE','DEBIT','Utility bills'],
          ['acc_purchases','5005','Purchases','ag_purchases','EXPENSE','DEBIT','Raw materials / goods purchased'],
          ['acc_cogs','5006','Cost of Goods Sold','ag_cost_goods','EXPENSE','DEBIT','Direct cost of goods sold'],
        ]) {
          accInsert.run(id, companyId, code, name, grp, type, nature, 0.0, nature === 'CREDIT' ? 'CREDIT' : 'DEBIT', desc, 1, ts, ts);
        }
        console.log('[seed] GL accounts ensured');

        // Financial year must cover the CURRENT date or the Journal form's
        // dropdown filter excludes it.
        const fyNow = conn.prepare('SELECT id FROM financial_years WHERE id = ?').get('fy_' + currentYear);
        if (!fyNow) {
          conn.prepare('INSERT OR IGNORE INTO financial_years (id, company_id, name, start_date, end_date, is_active, is_locked, created_at) VALUES (?,?,?,?,?,1,0,?)')
            .run('fy_' + currentYear, companyId, 'FY ' + currentYear, fyStart, fyEnd, ts);
        }
        console.log('[seed] Financial year ensured');
      } catch (e) { console.warn('[seed] COA seed skipped:', e.message); }

      // ── Tax Masters seed (GST rates used by Customer Bills line items) ──
      // Migration 040 can be recorded as applied while its seed rows are
      // absent from a restored DB, so `tax_gst_5_intra` (the Customer Bills
      // default line tax) is missing and saving a bill fails with
      // "TaxMaster with ID tax_gst_5_intra not found". INSERT OR IGNORE =
      // safe to re-run.
      try {
        const tsT = '2024-01-01T00:00:00Z';
        const tmInsert = conn.prepare('INSERT OR IGNORE INTO tax_masters (id, company_id, code, name, is_igst, rate, effective_from, is_active, is_system, description, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const [id, code, name, isIgst, rate, desc] of [
          ['tax_gst_18_intra','GST_18_INTRASTATE','GST 18% (Intra-state: 9% CGST + 9% SGST)',0,18.0,'Standard rate GST for intra-state supplies'],
          ['tax_gst_18_inter','GST_18_INTERSTATE','GST 18% (Inter-state: 18% IGST)',1,18.0,'Standard rate GST for inter-state supplies'],
          ['tax_gst_5_intra','GST_5_INTRASTATE','GST 5% (Intra-state: 2.5% CGST + 2.5% SGST)',0,5.0,'Reduced rate GST for intra-state supplies'],
          ['tax_gst_5_inter','GST_5_INTERSTATE','GST 5% (Inter-state: 5% IGST)',1,5.0,'Reduced rate GST for inter-state supplies'],
          ['tax_gst_12_intra','GST_12_INTRASTATE','GST 12% (Intra-state: 6% CGST + 6% SGST)',0,12.0,'Special rate GST for intra-state supplies'],
          ['tax_gst_12_inter','GST_12_INTERSTATE','GST 12% (Inter-state: 12% IGST)',1,12.0,'Special rate GST for inter-state supplies'],
          ['tax_gst_3_intra','GST_3_INTRASTATE','GST 3% (Intra-state: 1.5% CGST + 1.5% SGST)',0,3.0,'Minor rate GST for intra-state supplies'],
          ['tax_gst_3_inter','GST_3_INTERSTATE','GST 3% (Inter-state: 3% IGST)',1,3.0,'Minor rate GST for inter-state supplies'],
          ['tax_gst_0','GST_0','GST 0% / Nil-rated',0,0.0,'Zero-rated / nil-rated supplies'],
          ['tax_exempt','TAX_EXEMPT','Exempt',0,0.0,'Supplies on which no tax is levied'],
          ['tax_non_taxable','TAX_NON_TAXABLE','Non-Taxable',0,0.0,'Supplies outside the scope of GST'],
        ]) {
          tmInsert.run(id, companyId, code, name, isIgst, rate, '2017-07-01', 1, 1, desc, tsT, tsT);
        }
        console.log('[seed] Tax masters ensured');

        // Components so the calculation engine can resolve CGST/SGST/IGST.
        const tcInsert = conn.prepare('INSERT OR IGNORE INTO tax_components (id, company_id, tax_master_id, tax_type_code, rate, is_compound, created_at) VALUES (?,?,?,?,?,?,?)');
        for (const [id, tm, code, rate] of [
          ['tcx_cgst_18','tax_gst_18_intra','CGST',9.0],['tcx_sgst_18','tax_gst_18_intra','SGST',9.0],
          ['tcx_igst_18','tax_gst_18_inter','IGST',18.0],
          ['tcx_cgst_5','tax_gst_5_intra','CGST',2.5],['tcx_sgst_5','tax_gst_5_intra','SGST',2.5],
          ['tcx_igst_5','tax_gst_5_inter','IGST',5.0],
          ['tcx_cgst_12','tax_gst_12_intra','CGST',6.0],['tcx_sgst_12','tax_gst_12_intra','SGST',6.0],
          ['tcx_igst_12','tax_gst_12_inter','IGST',12.0],
          ['tcx_cgst_3','tax_gst_3_intra','CGST',1.5],['tcx_sgst_3','tax_gst_3_intra','SGST',1.5],
          ['tcx_igst_3','tax_gst_3_inter','IGST',3.0],
        ]) {
          tcInsert.run(id, companyId, tm, code, rate, 0, tsT);
        }
        console.log('[seed] Tax components ensured');
      } catch (e) { console.warn('[seed] tax master seed skipped:', e.message); }

      // ── Subscription seed ──
      // The subscription middleware 403s EVERY /api write for a company with
      // no active subscription row — including the admin's 'default' company
      // (the "Request failed" toast on Post Entry). Seed a long-lived active
      // subscription so QA writes pass the gate. INSERT OR IGNORE = safe to
      // re-run, and never touches other companies' rows.
      try {
        const nowS = new Date();
        const endIso = new Date(nowS.getFullYear() + 10, nowS.getMonth(), nowS.getDate(), 23, 59, 59).toISOString();
        const startIso = nowS.toISOString();
        // subscriptions.plan_id FKs to subscription_plans.id, plan_name is
        // NOT NULL, duration_unit is CHECK('day'|'month'|'year'). Reuse an
        // EXISTING active plan instead of inventing IDs the FK would reject.
        const plan = conn.prepare(
          `SELECT id, name, duration_days, duration_unit, account_type FROM subscription_plans
           WHERE active = 1 ORDER BY CASE account_type WHEN 'customer_tenant' THEN 0 WHEN 'agency' THEN 1 ELSE 2 END LIMIT 1`
        ).get();
        if (!plan) throw new Error('no active subscription_plans row to reference');
        conn.prepare(`INSERT OR IGNORE INTO subscriptions
          (id, company_id, account_type, plan_id, plan_name, amount_minor, duration_days,
           starts_at, expires_at, status, payment_status, auto_renew,
           duration_unit, duration_value, end_date)
          VALUES ('sub_qa_default', ?, ?, ?, ?, 0, ?,
                  ?, ?, 'ACTIVE', 'PAID', 1,
                  ?, ?, ?)`)
              .run(companyId,
                   plan.account_type || 'customer_tenant',
                   plan.id,
                   plan.name || 'QA Plan',
                   plan.duration_days || 3650,
                   startIso, endIso,
                   plan.duration_unit || 'day',
                   plan.duration_days || 3650,
                   endIso);
        console.log('[seed] Active subscription ensured for company "' + companyId + '" (plan ' + String(plan.name || plan.id).slice(0, 20) + ', until ' + endIso.slice(0, 10) + ')');
      } catch (e) { console.warn('[seed] subscription seed skipped:', e.message); }

      // ── Product hierarchy seed (Stock Group → Category → Brand → Model) ──
      // The Products form REJECTS any model without a complete hierarchy, so
      // seed one full chain. Try/catch per table — older schemas may lack them.
      try {
        const ts2 = new Date().toISOString();
        conn.prepare('INSERT OR IGNORE INTO stock_groups (id, company_id, name, description, is_active, created_at, updated_at) VALUES (?,?,?,?,1,?,?)')
          .run('grp_qa','default','QA Electronics','QA-seeded stock group', ts2, ts2);
        conn.prepare('INSERT OR IGNORE INTO stock_categories (id, company_id, name, stock_group_id, is_active) VALUES (?,?,?,?,1)')
          .run('cat_qa','default','QA Components','grp_qa');
        conn.prepare('INSERT OR IGNORE INTO brands (id, company_id, name, is_active) VALUES (?,?,?,1)')
          .run('brand_qa','default','QA Brand');
        conn.prepare('INSERT OR IGNORE INTO models (id, company_id, name, brand_id, stock_category_id, is_active) VALUES (?,?,?,?,?,1)')
          .run('model_qa','default','QA Model X1','brand_qa','cat_qa');
        console.log('[seed] Product hierarchy ensured (grp_qa → cat_qa → brand_qa → model_qa)');
      } catch (e) { console.warn('[seed] hierarchy seed skipped:', e.message); }

      console.log('[seed] Demo data applied.');
    }
  }

  conn.close();
}

if (require.main === module) {
  seed().catch((err) => { console.error('[seed] Failed:', err.message); process.exit(1); });
}

module.exports = { seed };
