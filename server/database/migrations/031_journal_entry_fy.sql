-- Migration 031: Add financial_year_id to journal_entries (needed for Step 6 JE management)
-- The journal_entries table already has voucher_id which links to vouchers which have financial_year_id,
-- but direct JE creation (non-voucher) needs the financial_year_id column for FY isolation.

ALTER TABLE journal_entries ADD COLUMN financial_year_id TEXT REFERENCES financial_years(id);

-- Add index for FY scoping
CREATE INDEX IF NOT EXISTS idx_je_financial_year ON journal_entries(financial_year_id);
CREATE INDEX IF NOT EXISTS idx_je_status ON journal_entries(status);
CREATE INDEX IF NOT EXISTS idx_je_entry_number ON journal_entries(entry_number);
