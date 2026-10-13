-- Migration 021: Add currency column to invoices and payments tables
-- Supports multi-currency feature (INR, USD, EUR, GBP)
ALTER TABLE invoices ADD COLUMN currency TEXT DEFAULT 'USD';
ALTER TABLE payments ADD COLUMN currency TEXT DEFAULT 'USD';
