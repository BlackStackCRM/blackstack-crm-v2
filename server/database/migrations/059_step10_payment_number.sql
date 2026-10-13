-- Migration 059: Step 10 — Add payment_number column to payments table
-- Adds a sequential receipt number (RCPT-yyyy-00001) to customer bill payments

-- Add payment_number column (nullable for backward compat with existing payments)
ALTER TABLE payments ADD COLUMN payment_number TEXT;
