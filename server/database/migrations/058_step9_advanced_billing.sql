-- Migration 058: Step 9 — Advanced bill items, charges tax, line discount type
-- Adds columns needed for:
--   - Per-line discount type (percentage vs fixed) persistence
--   - Taxable additional charges with per-charge tax master
--   - Bill-level charge tax tracking
--   - Line discount amount tracking at bill level
--   - HSN/SAC and tax master persistence on bill_items
--
-- NOTE: Columns already added by migration 056 (hsn_sac, unit, tax_master_id)
-- are not re-added here to avoid duplicate column errors under exec().

-- ─── Extend bill_items ─────────────────────────────────────────────────
ALTER TABLE bill_items ADD COLUMN discount_type TEXT DEFAULT 'fixed';
ALTER TABLE bill_items ADD COLUMN cgst_amount REAL DEFAULT 0.0;
ALTER TABLE bill_items ADD COLUMN sgst_amount REAL DEFAULT 0.0;
ALTER TABLE bill_items ADD COLUMN igst_amount REAL DEFAULT 0.0;
ALTER TABLE bill_items ADD COLUMN line_total REAL DEFAULT 0.0;
ALTER TABLE bill_items ADD COLUMN line_tax REAL DEFAULT 0.0;

-- ─── Extend bills ──────────────────────────────────────────────────────
ALTER TABLE bills ADD COLUMN other_charges_taxable INTEGER DEFAULT 0;
ALTER TABLE bills ADD COLUMN other_charges_tax_amount REAL DEFAULT 0.0;
ALTER TABLE bills ADD COLUMN line_discount_amount REAL DEFAULT 0.0;

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS idx_bills_other_charges_tax ON bills(company_id, other_charges_taxable) WHERE other_charges_taxable = 1;
CREATE INDEX IF NOT EXISTS idx_bill_items_tax_master ON bill_items(tax_master_id) WHERE tax_master_id IS NOT NULL;
