-- Step 7: Receipt Voucher / Money Received Transaction
-- Adds receipt_mode and journal_entry_id columns to vouchers table
-- These columns support the Receipt Voucher workflow built on the Step 6 Journal Entry engine

-- receipt_mode: CASH, BANK, UPI, CHEQUE, CARD, OTHER
-- journal_entry_id: FK to journal_entries for receipt→JE linking
-- Index for efficient receipt lookup by type and status

CREATE INDEX IF NOT EXISTS idx_vouchers_receipt_type ON vouchers(voucher_type, status) WHERE voucher_type = 'RECEIPT';
