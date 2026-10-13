-- Migration 041: Accounting Steps 18-27
-- Tax/GST reporting (Step 18) reuses transaction_tax_details (040) — no new tables needed.
-- Step 19: Inventory accounting (perpetual, weighted average)
-- Step 25: Bank reconciliation
-- Step 26: Year-end closing records

-- ═══ Inventory items (per product stock position) ═══
CREATE TABLE IF NOT EXISTS inventory_items (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  product_id TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,      -- weighted average cost
  total_value REAL NOT NULL DEFAULT 0,    -- quantity * unit_cost
  valuation_method TEXT NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
  gl_account_id TEXT,                     -- Inventory ledger account for reconciliation
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  UNIQUE(company_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_items_company ON inventory_items(company_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_product ON inventory_items(product_id);

-- ═══ Inventory movements (audit trail; every movement linked to a posted voucher) ═══
CREATE TABLE IF NOT EXISTS inventory_movements (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  product_id TEXT NOT NULL,
  voucher_id TEXT,                        -- FK to vouchers(id) (nullable for opening stock)
  journal_entry_id TEXT,                  -- FK to journal_entries(id)
  movement_type TEXT NOT NULL CHECK (movement_type IN
    ('OPENING', 'PURCHASE', 'SALE', 'PURCHASE_RETURN', 'SALES_RETURN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT')),
  direction INTEGER NOT NULL,             -- +1 increase, -1 decrease
  quantity REAL NOT NULL,
  unit_cost REAL NOT NULL,                -- cost applied (weighted avg for decreases)
  total_value REAL NOT NULL,
  balance_qty REAL NOT NULL,              -- running quantity after movement
  balance_value REAL NOT NULL,            -- running value after movement
  notes TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE SET NULL,
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_inv_mov_company ON inventory_movements(company_id);
CREATE INDEX IF NOT EXISTS idx_inv_mov_product ON inventory_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_inv_mov_voucher ON inventory_movements(voucher_id);

-- ═══ Bank reconciliations (one per bank ledger + statement date) ═══
CREATE TABLE IF NOT EXISTS bank_reconciliations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  bank_account_id TEXT NOT NULL,          -- FK to bank_accounts(id)
  gl_account_id TEXT NOT NULL,            -- bank ledger account
  statement_date TEXT NOT NULL,
  statement_balance REAL NOT NULL DEFAULT 0,
  book_balance REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'RECONCILED')),
  notes TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (gl_account_id) REFERENCES accounts(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_bank_recon_company ON bank_reconciliations(company_id, bank_account_id);

-- ═══ Bank reconciliation items (unpresented cheques, deposits in transit, charges, interest) ═══
CREATE TABLE IF NOT EXISTS bank_reconciliation_items (
  id TEXT PRIMARY KEY,
  reconciliation_id TEXT NOT NULL,
  company_id TEXT NOT NULL DEFAULT 'default',
  journal_entry_id TEXT,                  -- linked posted JE (for matched ledger lines)
  item_type TEXT NOT NULL CHECK (item_type IN
    ('UNPRESENTED_CHEQUE', 'DEPOSIT_IN_TRANSIT', 'BANK_CHARGE', 'INTEREST_CREDITED', 'DIRECT_DEBIT', 'ADJUSTMENT', 'OTHER')),
  description TEXT,
  amount REAL NOT NULL,                   -- +ve increases book balance toward statement, -ve decreases
  reference TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reconciliation_id) REFERENCES bank_reconciliations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bank_recon_items_recon ON bank_reconciliation_items(reconciliation_id);

-- ═══ Year-end closing records ═══
CREATE TABLE IF NOT EXISTS year_end_closings (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  financial_year_id TEXT NOT NULL,
  next_financial_year_id TEXT,
  closing_journal_entry_id TEXT,          -- income/expense closing JE
  carry_forward_journal_entry_id TEXT,    -- B/S carry-forward JE into next FY
  total_revenue REAL NOT NULL DEFAULT 0,
  total_expense REAL NOT NULL DEFAULT 0,
  net_profit REAL NOT NULL DEFAULT 0,
  validation_report_json TEXT,
  closed_by TEXT,
  closed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (financial_year_id) REFERENCES financial_years(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_yec_company ON year_end_closings(company_id, financial_year_id);
