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
    console.log('[seed] Admin user already exists. Skipping.');
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

  if (demoMode) {
    const hasDemo = conn.prepare('SELECT id FROM organizations WHERE id = ?').get('org_001');
    if (!hasDemo) {
      conn.transaction(() => {
        conn.prepare(`
          INSERT INTO organizations (id, company_id, name, industry, status)
          VALUES (?, ?, 'Acme Corporation', 'Technology', 'ACTIVE')
        `).run('org_001', companyId);
        conn.prepare(`
          INSERT INTO contacts (id, company_id, first_name, last_name, email, phone, job_title, organization_id, status)
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

      console.log('[seed] Demo data applied.');
    }
  }

  conn.close();
}

if (require.main === module) {
  seed().catch((err) => { console.error('[seed] Failed:', err.message); process.exit(1); });
}

module.exports = { seed };
