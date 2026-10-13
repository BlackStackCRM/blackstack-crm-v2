-- Migration 061: Step 11 — Credit Notes, Debit Notes, Sales Returns & Reversals
-- Adds idempotency_key and overpayment_amount to vouchers table for credit/debit note handling

-- Add idempotency_key column for credit/debit note idempotency
ALTER TABLE vouchers ADD COLUMN idempotency_key TEXT;
CREATE INDEX IF NOT EXISTS idx_vouchers_idempotency_key ON vouchers(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Add idempotency_key uniqueness guard per company for credit/debit notes
CREATE UNIQUE INDEX IF NOT EXISTS uq_vouchers_idempotency_cn ON vouchers(idempotency_key, company_id) WHERE idempotency_key IS NOT NULL AND voucher_type IN ('CREDIT_NOTE', 'DEBIT_NOTE');

-- Add overpayment_amount to track credit note amounts that exceed bill balance
-- (used for fully-paid invoice credit notes that create customer credit instead of reducing bill)
ALTER TABLE vouchers ADD COLUMN overpayment_amount REAL DEFAULT 0;
