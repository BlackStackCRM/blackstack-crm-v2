const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function getMigrationFiles() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort((a, b) => {
      const numA = parseInt(a.split('_')[0]);
      const numB = parseInt(b.split('_')[0]);
      return numA - numB;
    });
  return files.map(f => path.join(MIGRATIONS_DIR, f));
}

async function migrate() {
  const { DatabaseConnection } = require('./connection');
  const db = new DatabaseConnection();
  const conn = db.connect();

  conn.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const existing = conn.prepare('SELECT version, sha256 FROM schema_migrations ORDER BY version').all();
  const applied = new Map(existing.map(r => [r.version, r.sha256]));

  const files = getMigrationFiles();
  let appliedCount = 0;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const match = file.match(/(\d+)_([^/]+)\.sql$/);
    if (!match) continue;

    const version = parseInt(match[1]);
    const name = match[2];

    if (applied.has(version) && applied.get(version) === sha256) {
      continue;
    }

    if (applied.has(version) && applied.get(version) !== sha256) {
      console.warn(`Migration integrity check warning for ${name}. Updating stored checksum from ${applied.get(version)} to ${sha256} (file was modified after initial application).`);
      conn.prepare('UPDATE schema_migrations SET sha256 = ? WHERE version = ?').run(sha256, version);
      continue;
    }

    console.log(`Applying migration ${version}: ${name}`);
    const apply = conn.transaction(() => {
      // Migration 091's SQL creates indexes for hierarchy columns. They are
      // added here (inside the same transaction) because SQLite has no
      // ADD COLUMN IF NOT EXISTS and older local databases may not have gone
      // through the guarded production adapter that originally added them.
      if (version === 91 || version === 92) {
        const usersTable = conn.get("SELECT name FROM sqlite_master WHERE type='table' AND name='users'");
        if (!usersTable) throw new Error(`users table must exist before migration ${version}`);
        const userColumns = new Set(conn.all('PRAGMA table_info(users)').map((column) => column.name));
        if (version === 91) {
          if (!userColumns.has('hierarchy_role')) {
            conn.exec("ALTER TABLE users ADD COLUMN hierarchy_role TEXT CHECK (hierarchy_role IN ('agency', 'sub_agency', 'customer_tenant'))");
          }
          if (!userColumns.has('parent_user_id')) {
            conn.exec('ALTER TABLE users ADD COLUMN parent_user_id TEXT REFERENCES users(id) ON DELETE SET NULL');
          }
          if (!userColumns.has('must_change_password')) {
            conn.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
          }
        }
        if (version === 92 && !userColumns.has('supabase_user_id')) {
          conn.exec('ALTER TABLE users ADD COLUMN supabase_user_id TEXT');
        }
      }
      if (version === 97) {
        for (const table of ['subscription_plans', 'subscriptions']) {
          const columns = new Set(conn.all(`PRAGMA table_info(${table})`).map((column) => column.name));
          if (!columns.has('duration_unit')) conn.exec(`ALTER TABLE ${table} ADD COLUMN duration_unit TEXT NOT NULL DEFAULT 'day' CHECK (duration_unit IN ('day','month','year'))`);
          if (!columns.has('duration_value')) conn.exec(`ALTER TABLE ${table} ADD COLUMN duration_value INTEGER NOT NULL DEFAULT 1 CHECK (duration_value > 0)`);
        }
      }
      conn.exec(content);
      if (version === 99) {
        const violations = conn.all('PRAGMA foreign_key_check');
        if (violations.length) throw new Error(`Foreign key check failed after migration 099 (${violations.length} violation(s)).`);
      }
      conn.prepare('INSERT INTO schema_migrations (version, name, sha256) VALUES (?, ?, ?)').run(version, name, sha256);
    });
    try {
      // Migration 099 rebuilds subscriptions to permit the PENDING state.
      // Disable FK enforcement only around that atomic schema migration so
      // SQLite does not reject replacing the referenced parent table.
      if (version === 99) conn.exec('PRAGMA foreign_keys = OFF');
      apply();
      if (version === 99) conn.exec('PRAGMA foreign_keys = ON');
    } catch (err) {
      if (version === 99) conn.exec('PRAGMA foreign_keys = ON');
      throw new Error(`Migration ${version}_${name} failed: ${err.message}. Halting — partial state preserved in schema_migrations for diagnosis.`);
    }
    appliedCount++;
  }

  // Default tenant must be created AFTER migrations define the companies table.
  conn.prepare(`
    INSERT OR IGNORE INTO companies (id, name) VALUES ('default', 'BlackStack Default Company')
  `).run();

  // ── Step 7: Ensure vouchers table has receipt_mode and journal_entry_id columns ──
  // SQLite doesn't support IF NOT EXISTS on ALTER TABLE ADD COLUMN in pure SQL.
  // Use programmatic check for idempotency.
  const voucherCols = conn.all("PRAGMA table_info(vouchers)").map(c => c.name);
  if (voucherCols.indexOf('receipt_mode') === -1) {
    conn.exec("ALTER TABLE vouchers ADD COLUMN receipt_mode TEXT CHECK (receipt_mode IN ('CASH', 'BANK', 'UPI', 'CHEQUE', 'CARD', 'OTHER'))");
  }
  if (voucherCols.indexOf('journal_entry_id') === -1) {
    conn.exec("ALTER TABLE vouchers ADD COLUMN journal_entry_id TEXT REFERENCES journal_entries(id)");
  }
  const hasTotalAmount = voucherCols.includes('total_amount');
  if (!hasTotalAmount) {
    conn.exec("ALTER TABLE vouchers ADD COLUMN total_amount REAL");
  }
  conn.exec("CREATE INDEX IF NOT EXISTS idx_vouchers_receipt_type ON vouchers(voucher_type, status) WHERE voucher_type = 'RECEIPT'");
  conn.exec("CREATE INDEX IF NOT EXISTS idx_vouchers_sales_type ON vouchers(voucher_type, status) WHERE voucher_type = 'SALES'");
  // ── Step 13: Credit Note / Sales Return columns ──
  if (voucherCols.indexOf('credit_note_number') === -1) {
    conn.exec("ALTER TABLE vouchers ADD COLUMN credit_note_number TEXT");
  }
  if (voucherCols.indexOf('credit_note_type') === -1) {
    conn.exec("ALTER TABLE vouchers ADD COLUMN credit_note_type TEXT CHECK (credit_note_type IN ('SALES_RETURN','PRICE_ADJUSTMENT','QUANTITY_ADJUSTMENT','DISCOUNT_ADJUSTMENT','TAX_ADJUSTMENT','OTHER'))");
  }
  if (voucherCols.indexOf('reason') === -1) {
    conn.exec("ALTER TABLE vouchers ADD COLUMN reason TEXT");
  }
  if (voucherCols.indexOf('original_sales_invoice_id') === -1) {
    conn.exec("ALTER TABLE vouchers ADD COLUMN original_sales_invoice_id TEXT");
  }
  conn.exec("CREATE INDEX IF NOT EXISTS idx_vouchers_credit_note ON vouchers(voucher_type, status) WHERE voucher_type = 'CREDIT_NOTE'");
  conn.exec("CREATE INDEX IF NOT EXISTS idx_vouchers_original_invoice ON vouchers(original_sales_invoice_id) WHERE original_sales_invoice_id IS NOT NULL");

  // ── Step 14: Debit Note / Purchase Return columns ──
  if (voucherCols.indexOf('original_purchase_invoice_id') === -1) {
    conn.exec("ALTER TABLE vouchers ADD COLUMN original_purchase_invoice_id TEXT");
  }
  conn.exec("CREATE INDEX IF NOT EXISTS idx_vouchers_debit_note ON vouchers(voucher_type, status) WHERE voucher_type = 'DEBIT_NOTE'");
  conn.exec("CREATE INDEX IF NOT EXISTS idx_vouchers_original_purchase_invoice ON vouchers(original_purchase_invoice_id) WHERE original_purchase_invoice_id IS NOT NULL");

  // ── Step 074: Inventory Hierarchy columns (inv_locations, godowns.location_id, stock_groups.godown_id, products hierarchy, stock_items.godown_id) ──
  // These are added programmatically for idempotency since SQLite lacks IF NOT EXISTS on ALTER TABLE ADD COLUMN.

  // godowns.location_id → locations(id)  (Godown belongs to a Location)
  // Rebuild godowns table to fix the FK reference (may point to legacy inv_locations table)
  const godownCols = conn.all("PRAGMA table_info(godowns)").map(c => c.name);
  const godownFks = conn.all("PRAGMA foreign_key_list(godowns)").map(f => f.table + "." + f.from + " → " + f.to);
  const needsRebuild = godownCols.indexOf("location_id") !== -1 && godownFks.some(f => f.includes("inv_locations"));
  if (needsRebuild) {
    conn.exec("PRAGMA foreign_keys = OFF");
    conn.exec("CREATE TABLE godowns_new (id TEXT PRIMARY KEY, company_id TEXT NOT NULL DEFAULT 'default', name TEXT NOT NULL, code TEXT, address TEXT, is_active INTEGER DEFAULT 1, location_id TEXT REFERENCES locations(id) ON DELETE SET NULL, created_at DATETIME DEFAULT (datetime('now')), updated_at DATETIME DEFAULT (datetime('now')), created_by TEXT, updated_by TEXT, UNIQUE(company_id, name), UNIQUE(company_id, code))");
    conn.exec("INSERT INTO godowns_new (id, company_id, name, code, address, is_active, location_id, created_at, updated_at, created_by, updated_by) SELECT id, company_id, name, code, address, is_active, location_id, created_at, updated_at, created_by, updated_by FROM godowns");
    conn.exec("DROP TABLE godowns");
    conn.exec("ALTER TABLE godowns_new RENAME TO godowns");
    conn.exec("CREATE INDEX IF NOT EXISTS idx_godowns_company ON godowns(company_id)");
    conn.exec("CREATE INDEX IF NOT EXISTS idx_godowns_location ON godowns(location_id) WHERE location_id IS NOT NULL");
    conn.exec("PRAGMA foreign_keys = ON");
  } else if (godownCols.indexOf("location_id") === -1) {
    conn.exec("ALTER TABLE godowns ADD COLUMN location_id TEXT REFERENCES locations(id) ON DELETE SET NULL");
  }
  const groupCols = conn.all("PRAGMA table_info(stock_groups)").map(c => c.name);
  if (groupCols.indexOf("godown_id") === -1) {
    conn.exec("ALTER TABLE stock_groups ADD COLUMN godown_id TEXT REFERENCES godowns(id) ON DELETE SET NULL");
  }
  if (groupCols.indexOf("location_id") === -1) {
    conn.exec("ALTER TABLE stock_groups ADD COLUMN location_id TEXT REFERENCES locations(id) ON DELETE SET NULL");
  }
  conn.exec("CREATE INDEX IF NOT EXISTS idx_stock_groups_location ON stock_groups(location_id) WHERE location_id IS NOT NULL");

  conn.exec("CREATE INDEX IF NOT EXISTS idx_stock_groups_godown ON stock_groups(godown_id)");
  conn.exec("CREATE INDEX IF NOT EXISTS idx_stock_groups_children ON stock_groups(parent_group_id) WHERE parent_group_id IS NOT NULL");
  conn.exec("CREATE INDEX IF NOT EXISTS idx_stock_groups_toplevel ON stock_groups(godown_id) WHERE godown_id IS NOT NULL");

  // products hierarchy columns
  const productCols = conn.all("PRAGMA table_info(products)").map(c => c.name);
  if (productCols.indexOf("location_id") === -1) {
    conn.exec("ALTER TABLE products ADD COLUMN location_id TEXT REFERENCES locations(id) ON DELETE SET NULL");
  }
  if (productCols.indexOf("godown_id") === -1) {
    conn.exec("ALTER TABLE products ADD COLUMN godown_id TEXT REFERENCES godowns(id) ON DELETE SET NULL");
  }
  if (productCols.indexOf("inventory_group_id") === -1) {
    conn.exec("ALTER TABLE products ADD COLUMN inventory_group_id TEXT REFERENCES stock_groups(id) ON DELETE SET NULL");
  }
  if (productCols.indexOf("item_group_id") === -1) {
    conn.exec("ALTER TABLE products ADD COLUMN item_group_id TEXT REFERENCES stock_groups(id) ON DELETE SET NULL");
  }

  // stock_items.godown_id → godowns(id) (physical placement)
  const stockItemCols = conn.all("PRAGMA table_info(stock_items)").map(c => c.name);
  if (stockItemCols.indexOf("location_id") === -1) {
    conn.exec("ALTER TABLE stock_items ADD COLUMN location_id TEXT REFERENCES locations(id) ON DELETE SET NULL");
  }
  if (stockItemCols.indexOf("godown_id") === -1) {
    conn.exec("ALTER TABLE stock_items ADD COLUMN godown_id TEXT REFERENCES godowns(id) ON DELETE SET NULL");
  }
  if (stockItemCols.indexOf("inventory_group_id") === -1) {
    conn.exec("ALTER TABLE stock_items ADD COLUMN inventory_group_id TEXT REFERENCES stock_groups(id) ON DELETE SET NULL");
  }
  if (stockItemCols.indexOf("item_group_id") === -1) {
    conn.exec("ALTER TABLE stock_items ADD COLUMN item_group_id TEXT REFERENCES stock_groups(id) ON DELETE SET NULL");
  }

  // -- Indexes that depend on ALTERed columns (added above) --
  conn.exec("CREATE INDEX IF NOT EXISTS idx_godowns_location ON godowns(location_id)");
  conn.exec("CREATE INDEX IF NOT EXISTS idx_stock_groups_godown ON stock_groups(godown_id)");
  conn.exec("CREATE INDEX IF NOT EXISTS idx_stock_items_godown ON stock_items(godown_id)");
  conn.exec("CREATE INDEX IF NOT EXISTS idx_products_inv_hierarchy ON products(location_id, godown_id, inventory_group_id, item_group_id)");
  conn.exec("CREATE INDEX IF NOT EXISTS idx_stock_groups_children ON stock_groups(parent_group_id) WHERE parent_group_id IS NOT NULL");
  conn.exec("CREATE INDEX IF NOT EXISTS idx_stock_groups_toplevel ON stock_groups(godown_id) WHERE godown_id IS NOT NULL");

  // -- Step 078: Add description column to alternate_units (Use Case field) --
  // Migration 070 created alternate_units without a description column.
  // Migration 072 re-defined it with description via CREATE TABLE IF NOT EXISTS,
  // but since the table already existed from 070, the description column was never actually added.
  const altUnitCols = conn.all("PRAGMA table_info(alternate_units)").map(c => c.name);
  if (altUnitCols.indexOf("description") === -1) {
    conn.exec("ALTER TABLE alternate_units ADD COLUMN description TEXT");
  }

  // -- Step 078b: Product Hierarchy columns --
  // brands.id → belongs_to brands           (independent master, no stock_category)
  // models.brand_id → brands(id)            (Model belongs to a Brand)
  // models.stock_category_id → stock_categories(id) (Model's Stock Category, for hierarchy)
  // products.stock_group_id → stock_groups(id)        (auto-resolved from Model)
  // products.stock_category_id → stock_categories(id) (auto-resolved from Model)
  // products.brand_id → brands(id)                   (auto-resolved from Model)
  // products.model_id → models(id)                   (user-selected)
  // NOTE: brands.stock_category_id column removed — Brand is now independent master data.
  // Remove the column if it exists from earlier migrations (SQLite 3.35+ supports DROP COLUMN)
  const brandCols = conn.all("PRAGMA table_info(brands)").map(c => c.name);
  if (brandCols.indexOf("stock_category_id") !== -1) {
    conn.exec("PRAGMA foreign_keys = OFF");
    conn.exec("ALTER TABLE brands DROP COLUMN stock_category_id");
    conn.exec("PRAGMA foreign_keys = ON");
  }

  // -- Step 078c: Godown → Location relationship --
  // godowns.location_id → locations(id)  (Godown belongs to a Location)
  // Migrate existing data: from locations.godown_id → godowns.location_id
  // (godowns.location_id column already added in the earlier migration block)
  // NOTE: The existing FK on godowns.location_id may reference inv_locations (a
  // legacy table name). We temporarily disable FK enforcement to perform the
  // data migration, since the FK target table name may differ from the actual
  // table name (locations).
  // Only migrate if locations still has the godown_id column (not yet rebuilt).
  const locColsBefore = conn.all("PRAGMA table_info(locations)").map(c => c.name);
  if (locColsBefore.indexOf("godown_id") !== -1) {
    conn.exec("PRAGMA foreign_keys = OFF");
    conn.exec(`
      UPDATE godowns SET location_id = (
        SELECT locations.id FROM locations WHERE locations.godown_id = godowns.id AND godowns.location_id IS NULL
      )
      WHERE godowns.location_id IS NULL
      AND EXISTS (SELECT 1 FROM locations WHERE locations.godown_id = godowns.id)
    `);
    conn.exec("PRAGMA foreign_keys = ON");
  }
  // -- Step 078d: Rebuild locations table --
  // The relationship is now Location → Godowns (godowns.location_id → locations.id).
  // The old locations.godown_id column (NOT NULL, referencing godowns) is removed.
  // The locations table is rebuilt with address column for better usability.
  const locationCols = conn.all("PRAGMA table_info(locations)").map(c => c.name);
  if (locationCols.indexOf("godown_id") !== -1) {
    conn.exec("PRAGMA foreign_keys = OFF");
    // Rebuild the locations table without godown_id, add address
    conn.exec(`CREATE TABLE locations_new (
      id            TEXT    PRIMARY KEY,
      company_id    TEXT    NOT NULL DEFAULT 'default',
      name          TEXT    NOT NULL,
      code          TEXT,
      address       TEXT,
      is_active     INTEGER DEFAULT 1,
      created_at    DATETIME DEFAULT (datetime('now')),
      updated_at    DATETIME DEFAULT (datetime('now')),
      created_by    TEXT,
      updated_by    TEXT,
      UNIQUE(company_id, name)
    )`);
    conn.exec(`INSERT INTO locations_new (id, company_id, name, code, is_active, created_at, updated_at, created_by, updated_by)
               SELECT id, company_id, name, code, is_active, created_at, updated_at, created_by, updated_by FROM locations`);
    conn.exec("DROP TABLE locations");
    conn.exec("ALTER TABLE locations_new RENAME TO locations");
    conn.exec("CREATE INDEX IF NOT EXISTS idx_locations_company ON locations(company_id)");
    conn.exec("CREATE INDEX IF NOT EXISTS idx_locations_active ON locations(is_active)");
    conn.exec("PRAGMA foreign_keys = ON");
  }

  const productHierarchyCols = conn.all("PRAGMA table_info(products)").map(c => c.name);
  if (productHierarchyCols.indexOf("stock_group_id") === -1) {
    conn.exec("ALTER TABLE products ADD COLUMN stock_group_id TEXT REFERENCES stock_groups(id) ON DELETE SET NULL");
  }
  if (productHierarchyCols.indexOf("stock_category_id") === -1) {
    conn.exec("ALTER TABLE products ADD COLUMN stock_category_id TEXT REFERENCES stock_categories(id) ON DELETE SET NULL");
  }
  if (productHierarchyCols.indexOf("brand_id") === -1) {
    conn.exec("ALTER TABLE products ADD COLUMN brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL");
  }
  if (productHierarchyCols.indexOf("model_id") === -1) {
    conn.exec("ALTER TABLE products ADD COLUMN model_id TEXT REFERENCES models(id) ON DELETE SET NULL");
  }

  // ── Step 081: Location consolidation (locations is the single canonical master) ──
  //
  // The project historically carried TWO location masters:
  //     products.location_id / stock_items.location_id / stock_groups.location_id
  //         -> inv_locations(id)
  //     stock_ledger / stock_balances / item_serials / physical_stock_* /
  //     inventory_voucher_lines / godowns / ALL inventory reports
  //         -> locations(id)
  //
  // Verified live state before consolidation:
  //     locations = 1 row, inv_locations = 7 rows
  //     one id existed in BOTH with different names ("MVP" vs "MVP (3YV3JD)")
  //     six inv_locations rows had no counterpart in locations
  // so a product could sit in a location no report reads, and its stock would
  // disappear from location-wise reporting.
  //
  // `locations` becomes the single canonical master and every FK target is
  // repointed to it. All rows keep their ids and values.
  //
  // WHY THIS RUNS PROGRAMMATICALLY INSTEAD OF AS A .sql FILE:
  //   SQLite's DROP TABLE fires implicit DELETEs on all child rows, which
  //   would null SET NULL children and DELETE CASCADE children (e.g.
  //   product_specifications, inventory_items, batches, item_serials,
  //   stock_ledger) even though the parent's rows are copied first. The escape
  //   is `PRAGMA foreign_keys = OFF`, which SQLite IGNORES inside a
  //   transaction — and migrate() wraps every .sql migration in
  //   `BEGIN IMMEDIATE`. Programmatic execution runs outside that transaction,
  //   which is the same idiom already used above for the `locations` rebuild in
  //   Step 078d and the `godowns` rebuild in Step 074.
  //   Verified end-to-end by scripts/verify-fkoff-rebuild.js.

  // 081.1 — Merge legacy inv_locations rows into canonical locations (ids kept).
  //        Where a location is actually referenced by a godown (and therefore by
  //        the ledger, the balances and every report), locations is the live
  //        truth, so its name wins over a diverged inv_locations name.
  conn.exec(`
    UPDATE locations
       SET name = (SELECT il.name FROM inv_locations il WHERE il.id = locations.id)
     WHERE EXISTS (SELECT 1 FROM inv_locations il WHERE il.id = locations.id)
       AND EXISTS (SELECT 1 FROM godowns g WHERE g.location_id = locations.id)
  `);
  conn.exec(`
    UPDATE locations
       SET code = (SELECT il.code FROM inv_locations il WHERE il.id = locations.id)
     WHERE code IS NULL
       AND EXISTS (SELECT 1 FROM inv_locations il WHERE il.id = locations.id)
  `);
  conn.exec(`
    INSERT OR IGNORE INTO locations
      (id, company_id, name, code, address, is_active, created_at, updated_at, created_by, updated_by)
    SELECT id, company_id, name, code, address, is_active, created_at, updated_at, created_by, updated_by
      FROM inv_locations
  `);
  // A blank code can never be a meaningful unique business code; clearing it
  // guarantees the unique indexes below can be created on legacy data.
  conn.exec("UPDATE locations SET code = NULL WHERE code IS NOT NULL AND TRIM(code) = ''");

  // 081.2 — Only rebuild tables that still point at the legacy master.
  const fkTargetFor = (table, column) => {
    const fks = conn.all(`PRAGMA foreign_key_list(${table})`);
    const hit = fks.find((f) => f.from === column);
    return hit ? hit.table : null;
  };
  const colsOf = (table) => conn.all(`PRAGMA table_info(${table})`).map((c) => c.name);

  // Merge legacy rows into locations FIRST so every id referenced downstream
  // already resolves in the canonical table before any FK is repointed.
  const needsGroupsRebuild   = fkTargetFor("stock_groups", "location_id") === "inv_locations";
  const needsProductsRebuild = fkTargetFor("products", "location_id") === "inv_locations";
  const needsItemsRebuild    = fkTargetFor("stock_items", "location_id") === "inv_locations";

  if (needsGroupsRebuild) {
    conn.exec("PRAGMA foreign_keys = OFF");
    conn.exec(`CREATE TABLE stock_groups_081 (
      id              TEXT    PRIMARY KEY,
      company_id      TEXT    NOT NULL DEFAULT 'default',
      name            TEXT    NOT NULL,
      parent_group_id TEXT,
      description     TEXT,
      is_active       INTEGER DEFAULT 1,
      created_at      DATETIME DEFAULT (datetime('now')),
      updated_at      DATETIME DEFAULT (datetime('now')),
      created_by      TEXT,
      updated_by      TEXT,
      godown_id       TEXT REFERENCES godowns(id)   ON DELETE SET NULL,
      location_id     TEXT REFERENCES locations(id) ON DELETE SET NULL,
      FOREIGN KEY (parent_group_id) REFERENCES stock_groups(id) ON DELETE SET NULL,
      UNIQUE(company_id, name)
    )`);
    conn.exec(`INSERT INTO stock_groups_081
      SELECT id, company_id, name, parent_group_id, description, is_active,
             created_at, updated_at, created_by, updated_by, godown_id, location_id
        FROM stock_groups`);
    conn.exec("DROP TABLE stock_groups");
    conn.exec("ALTER TABLE stock_groups_081 RENAME TO stock_groups");
    conn.exec("PRAGMA foreign_keys = ON");
    console.log('  081: rebuilt stock_groups with canonical locations FK');
  }

  if (needsProductsRebuild) {
    conn.exec("PRAGMA foreign_keys = OFF");
    // Preserve every column the live table has, including any added by
    // migrations after 081 was designed, so no data is dropped.
    const pcols = colsOf("products");
    conn.exec(`CREATE TABLE products_081 (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT,
      sku TEXT UNIQUE,
      price REAL DEFAULT 0.0,
      cost REAL DEFAULT 0.0,
      tax_rate REAL DEFAULT 0.0,
      is_service INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      barcode TEXT,
      hsn_sac_code TEXT,
      min_stock_level REAL DEFAULT 0,
      max_stock_level REAL DEFAULT 0,
      image_url TEXT,
      location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
      godown_id TEXT REFERENCES godowns(id) ON DELETE SET NULL,
      inventory_group_id TEXT REFERENCES stock_groups(id) ON DELETE SET NULL,
      item_group_id TEXT REFERENCES stock_groups(id) ON DELETE SET NULL,
      stock_group_id TEXT REFERENCES stock_groups(id) ON DELETE SET NULL,
      stock_category_id TEXT REFERENCES stock_categories(id) ON DELETE SET NULL,
      brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL,
      model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
      is_inventory_managed INTEGER DEFAULT 0
    )`);
    const productTarget = [
      "id","company_id","name","description","category","sku","price","cost","tax_rate",
      "is_service","is_active","created_at","updated_at","barcode","hsn_sac_code",
      "min_stock_level","max_stock_level","image_url","location_id","godown_id",
      "inventory_group_id","item_group_id","stock_group_id","stock_category_id",
      "brand_id","model_id",
    ].filter((c) => pcols.includes(c));
    conn.exec(`INSERT INTO products_081 (${productTarget.join(", ")})
               SELECT ${productTarget.join(", ")} FROM products`);
    conn.exec("DROP TABLE products");
    conn.exec("ALTER TABLE products_081 RENAME TO products");
    conn.exec("PRAGMA foreign_keys = ON");
    console.log('  081: rebuilt products with canonical locations FK');
  }

  if (needsItemsRebuild) {
    conn.exec("PRAGMA foreign_keys = OFF");
    conn.exec(`CREATE TABLE stock_items_081 (
      id                         TEXT    PRIMARY KEY,
      company_id                 TEXT    NOT NULL DEFAULT 'default',
      name                       TEXT    NOT NULL,
      sku                        TEXT    NOT NULL,
      product_id                 TEXT,
      description                TEXT,
      brand_id                   TEXT,
      model_id                   TEXT,
      colour_id                  TEXT,
      size_id                    TEXT,
      style_id                   TEXT,
      category_id                TEXT,
      group_id                   TEXT,
      uom_id                     TEXT    NOT NULL,
      is_batch_tracked           INTEGER DEFAULT 0,
      is_serial_tracked          INTEGER DEFAULT 0,
      is_active                  INTEGER DEFAULT 1,
      cost_price                 REAL DEFAULT 0,
      mrp                        REAL,
      selling_rate               REAL,
      min_stock_level            REAL DEFAULT 0,
      max_stock_level            REAL,
      stock_asset_account_id     TEXT,
      cogs_account_id            TEXT,
      inventory_variance_account_id TEXT,
      opening_stock_account_id   TEXT,
      purchase_account_id        TEXT,
      sales_account_id           TEXT,
      created_at                 DATETIME DEFAULT (datetime('now')),
      updated_at                 DATETIME DEFAULT (datetime('now')),
      created_by                 TEXT,
      updated_by                 TEXT,
      location_id                TEXT REFERENCES locations(id) ON DELETE SET NULL,
      godown_id                  TEXT REFERENCES godowns(id) ON DELETE SET NULL,
      inventory_group_id         TEXT REFERENCES stock_groups(id) ON DELETE SET NULL,
      item_group_id              TEXT REFERENCES stock_groups(id) ON DELETE SET NULL,
      valuation_inventory_item_id TEXT REFERENCES inventory_items(id) ON DELETE SET NULL,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL,
      FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL,
      FOREIGN KEY (colour_id) REFERENCES colours(id) ON DELETE SET NULL,
      FOREIGN KEY (size_id) REFERENCES sizes(id) ON DELETE SET NULL,
      FOREIGN KEY (style_id) REFERENCES styles(id) ON DELETE SET NULL,
      FOREIGN KEY (category_id) REFERENCES stock_categories(id) ON DELETE SET NULL,
      FOREIGN KEY (group_id) REFERENCES stock_groups(id) ON DELETE SET NULL,
      FOREIGN KEY (uom_id) REFERENCES units_of_measure(id) ON DELETE RESTRICT,
      FOREIGN KEY (stock_asset_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
      FOREIGN KEY (cogs_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
      FOREIGN KEY (inventory_variance_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
      FOREIGN KEY (opening_stock_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
      FOREIGN KEY (purchase_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
      FOREIGN KEY (sales_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
      UNIQUE(company_id, sku),
      UNIQUE(company_id, name)
    )`);
    const icols = colsOf("stock_items");
    const itemTarget = [
      "id","company_id","name","sku","product_id","description","brand_id","model_id",
      "colour_id","size_id","style_id","category_id","group_id","uom_id",
      "is_batch_tracked","is_serial_tracked","is_active","cost_price","mrp","selling_rate",
      "min_stock_level","max_stock_level","stock_asset_account_id","cogs_account_id",
      "inventory_variance_account_id","opening_stock_account_id","purchase_account_id",
      "sales_account_id","created_at","updated_at","created_by","updated_by",
      "location_id","godown_id","inventory_group_id","item_group_id",
      "valuation_inventory_item_id",
    ].filter((c) => icols.includes(c));
    conn.exec(`INSERT INTO stock_items_081 (${itemTarget.join(", ")})
               SELECT ${itemTarget.join(", ")} FROM stock_items`);
    conn.exec("DROP TABLE stock_items");
    conn.exec("ALTER TABLE stock_items_081 RENAME TO stock_items");
    conn.exec("PRAGMA foreign_keys = ON");
    console.log('  081: rebuilt stock_items with canonical locations FK');
  }

  // 081.3 — Reconcile indexes dropped by the rebuilds.
  [
    "CREATE INDEX IF NOT EXISTS idx_products_company ON products(company_id)",
    "CREATE INDEX IF NOT EXISTS idx_products_stock_category ON products(stock_category_id)",
    "CREATE INDEX IF NOT EXISTS idx_products_model ON products(model_id)",
    "CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id)",
    "CREATE INDEX IF NOT EXISTS idx_products_stock_group ON products(stock_group_id)",
    "CREATE INDEX IF NOT EXISTS idx_products_location ON products(location_id)",
    "CREATE INDEX IF NOT EXISTS idx_products_inv_hierarchy ON products(location_id, godown_id, inventory_group_id, item_group_id)",
    "CREATE INDEX IF NOT EXISTS idx_stock_items_company ON stock_items(company_id)",
    "CREATE INDEX IF NOT EXISTS idx_stock_items_product ON stock_items(product_id)",
    "CREATE INDEX IF NOT EXISTS idx_stock_items_uom ON stock_items(uom_id)",
    "CREATE INDEX IF NOT EXISTS idx_stock_items_location ON stock_items(location_id)",
    "CREATE INDEX IF NOT EXISTS idx_stock_items_godown ON stock_items(godown_id)",
    "CREATE INDEX IF NOT EXISTS idx_stock_items_category ON stock_items(category_id)",
    "CREATE INDEX IF NOT EXISTS idx_stock_groups_parent ON stock_groups(parent_group_id)",
    "CREATE INDEX IF NOT EXISTS idx_stock_groups_location ON stock_groups(location_id)",
    "CREATE INDEX IF NOT EXISTS idx_stock_groups_godown ON stock_groups(godown_id)",
    "CREATE INDEX IF NOT EXISTS idx_stock_groups_children ON stock_groups(parent_group_id) WHERE parent_group_id IS NOT NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_company_name ON locations(company_id, name)",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_company_code ON locations(company_id, code)",
    "CREATE INDEX IF NOT EXISTS idx_locations_company ON locations(company_id)",
    "CREATE INDEX IF NOT EXISTS idx_locations_active ON locations(is_active)",
  ].forEach((sql) => { try { conn.exec(sql); } catch (e) { /* index may pre-exist with different definition */ } });

  // 081.4 — Retire inv_locations. Every row was copied into locations with its
  //        id intact and every FK target repointed, so the table is kept as an
  //        EMPTY legacy shell (not dropped) to keep the change reversible.
  const invLocationRows = (conn.get("SELECT COUNT(*) AS n FROM inv_locations") || {}).n || 0;
  if (invLocationRows > 0) {
    conn.exec("DELETE FROM inv_locations");
    console.log(`  081: retired inv_locations (${invLocationRows} row(s) merged into locations)`);
  }
  // The legacy_tables registry row is rewritten on EVERY startup because this
  // statement runs unconditionally, and `retired_at` carries DEFAULT
  // CURRENT_TIMESTAMP — so each boot silently changed that timestamp (and
  // SQLite's page counters) even when it reported "0 new migration(s) applied".
  // That made the live database byte-checksum unstable on a perfectly idle
  // server, which is exactly what a release-gate tripwire watches for.
  //
  // Preserve the existing retired_at so the row is only rewritten when its
  // CONTENT actually changes. COALESCE keeps the default for a first insert
  // (nothing to preserve) and keeps the statement idempotent afterwards.
  try {
    conn.prepare(`INSERT OR REPLACE INTO legacy_tables
      (table_name, status, canonical_replacement, reason, rows_at_retirement, retired_at)
      VALUES ('inv_locations','RETIRED','locations',
              'Consolidated into locations in migration 081. All rows copied with ids preserved; all FK targets repointed.',
              ?,
              COALESCE((SELECT retired_at FROM legacy_tables WHERE table_name = 'inv_locations'),
                       CURRENT_TIMESTAMP))
    `).run((conn.get("SELECT COUNT(*) AS n FROM locations") || {}).n || 0);
  } catch (e) { /* legacy_tables absent on very old databases */ }

  // ── Step 082: Re-key inventory_items onto stock_items ──
  //
  // Migration 080 created `inventory_items_v2` keyed by stock_items.id, because
  // the valuation authority has to join to the identity the ledger uses. But the
  // live `inventory_items` table still had its legacy product_id shape, so the
  // canonical engine's `WHERE item_id = ?` failed with "no such column".
  //
  // Legacy rows are carried across by mapping product_id -> stock_items.product_id.
  // A row whose product has no stock item keeps a NULL item_id rather than being
  // deleted, so no valuation history is ever lost.
  (() => {
    const invCols = conn.all('PRAGMA table_info(inventory_items)').map((c) => c.name);
    if (invCols.indexOf('item_id') !== -1) return;   // already re-keyed

    const rowCount = (conn.get('SELECT COUNT(*) AS n FROM inventory_items') || {}).n || 0;
    console.log(`  082: re-keying inventory_items (${rowCount} existing row(s))`);

    conn.exec('PRAGMA foreign_keys = OFF');
    try {
      conn.exec(`CREATE TABLE inventory_items_082 (
        id                 TEXT PRIMARY KEY,
        company_id         TEXT NOT NULL DEFAULT 'default',
        item_id            TEXT,
        quantity           REAL NOT NULL DEFAULT 0,
        unit_cost          REAL NOT NULL DEFAULT 0,
        total_value        REAL NOT NULL DEFAULT 0,
        valuation_method   TEXT NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
        gl_account_id      TEXT,
        legacy_product_id  TEXT,
        last_inward_at     TEXT,
        last_outward_at    TEXT,
        updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(company_id, item_id)
      )`);

      conn.exec(`INSERT INTO inventory_items_082
        (id, company_id, item_id, quantity, unit_cost, total_value, valuation_method,
         gl_account_id, legacy_product_id, updated_at, created_at)
        SELECT ii.id, ii.company_id,
               (SELECT si.id FROM stock_items si WHERE si.product_id = ii.product_id LIMIT 1),
               ii.quantity, ii.unit_cost, ii.total_value, ii.valuation_method,
               ii.gl_account_id, ii.product_id, ii.updated_at, ii.created_at
          FROM inventory_items ii`);

      conn.exec('DROP TABLE inventory_items');
      conn.exec('ALTER TABLE inventory_items_082 RENAME TO inventory_items');

      conn.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_items_item
                   ON inventory_items(company_id, item_id)`);
      // The old product-keyed lookups in accounting.controller.js still work
      // through legacy_product_id.
      conn.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_items_legacy_product
                   ON inventory_items(company_id, legacy_product_id)
                   WHERE legacy_product_id IS NOT NULL`);
    } finally {
      conn.exec('PRAGMA foreign_keys = ON');
    }

    const orphans = (conn.get(
      'SELECT COUNT(*) AS n FROM inventory_items WHERE item_id IS NULL') || {}).n || 0;
    if (orphans > 0) {
      console.log(`  082: ${orphans} valuation row(s) had no stock item; preserved with NULL item_id`);
    }
  })();

  // ── Step 084: restore the foreign key on inventory_items.item_id ──
  //
  // Migration 082 rebuilt inventory_items to re-key it from product_id to item_id.
  // That rebuild necessarily runs with PRAGMA foreign_keys = OFF (SQLite's DROP
  // TABLE otherwise fires implicit DELETEs on every child row), and SQLite does not
  // materialise FK clauses on a table created while enforcement is off. The live
  // table therefore ended up with item_id completely unconstrained:
  //
  //     PRAGMA foreign_key_list(inventory_items)  ->  no rows
  //
  // so the valuation table could silently accumulate rows pointing at stock items
  // that no longer exist. This step rebuilds it with enforcement ON so the
  // constraint is actually created.
  //
  // Safety: idempotent (no-ops when the FK already exists), and refuses to run if
  // any existing row would violate the constraint, so no data can be lost.
  (() => {
    const hasFk = conn.all('PRAGMA foreign_key_list(inventory_items)')
      .some((f) => f.from === 'item_id' && f.table === 'stock_items');
    if (hasFk) return;

    const orphans = conn.all(
      `SELECT ii.id, ii.item_id FROM inventory_items ii
        WHERE ii.item_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM stock_items si WHERE si.id = ii.item_id)`
    ).length;
    if (orphans > 0) {
      console.log(
        `  084: SKIPPED — ${orphans} inventory_items row(s) reference a missing stock_items; `
        + 'clean them up before re-running');
      return;
    }

    const rowCount = (conn.get('SELECT COUNT(*) AS n FROM inventory_items') || {}).n || 0;
    console.log(`  084: restoring inventory_items.item_id FK (${rowCount} existing row(s))`);

    conn.exec('PRAGMA foreign_keys = OFF');
    try {
      conn.exec(`CREATE TABLE inventory_items_084 (
        id                 TEXT PRIMARY KEY,
        company_id         TEXT NOT NULL DEFAULT 'default',
        item_id            TEXT REFERENCES stock_items(id) ON DELETE CASCADE,
        quantity           REAL NOT NULL DEFAULT 0,
        unit_cost          REAL NOT NULL DEFAULT 0,
        total_value        REAL NOT NULL DEFAULT 0,
        valuation_method   TEXT NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
        gl_account_id      TEXT,
        legacy_product_id  TEXT,
        last_inward_at     TEXT,
        last_outward_at    TEXT,
        updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(company_id, item_id)
      )`);
      conn.exec(`INSERT INTO inventory_items_084
        (id, company_id, item_id, quantity, unit_cost, total_value, valuation_method,
         gl_account_id, legacy_product_id, last_inward_at, last_outward_at, updated_at, created_at)
        SELECT id, company_id, item_id, quantity, unit_cost, total_value, valuation_method,
               gl_account_id, legacy_product_id, last_inward_at, last_outward_at, updated_at, created_at
          FROM inventory_items`);
      conn.exec('DROP TABLE inventory_items');
      conn.exec('ALTER TABLE inventory_items_084 RENAME TO inventory_items');
      conn.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_items_item
                   ON inventory_items(company_id, item_id)`);
      conn.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_items_legacy_product
                   ON inventory_items(company_id, legacy_product_id)
                   WHERE legacy_product_id IS NOT NULL`);
    } finally {
      conn.exec('PRAGMA foreign_keys = ON');
    }

    const restored = conn.all('PRAGMA foreign_key_list(inventory_items)')
      .some((f) => f.from === 'item_id' && f.table === 'stock_items');
    console.log(restored
      ? '  084: inventory_items.item_id FK restored'
      : '  084: WARNING — FK still missing after rebuild');
  })();

  conn.pragma('busy_timeout = 5000');

  console.log(`Migrations complete. ${appliedCount} new migration(s) applied.`);
  // PHASE 3A — CONNECTION OWNERSHIP.
  //
  // migrate() RETURNS an open connection. Ownership passes to the caller, which
  // must close it. Five of the six callers already do (`migrated.get(...)` then
  // `migrated.close()`), so the return value is genuinely part of the contract.
  //
  // The one caller that ignored it was safeMigrationRunner.runSafeMigrations(),
  // which did `await migrate();` and let the handle leak. A leaked handle keeps
  // the process recorded as bound to that file, which would make
  // assertDisposableDbIsActive() refuse a legitimately rebinding suite such as
  // tests/data-safety.test.js (a fresh disposable database per test) for the
  // wrong reason. That caller is fixed separately.
  return db;
}

module.exports = { migrate, getMigrationFiles };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
  });
}
