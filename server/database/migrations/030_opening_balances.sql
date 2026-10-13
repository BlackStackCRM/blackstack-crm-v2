-- Migration 030: Opening Balances & Accounting Initialization
-- Creates opening_balances and opening_balance_lines tables
-- for the controlled opening balance workflow introduced in Step 5.

CREATE TABLE IF NOT EXISTS opening_balances (
    id              TEXT PRIMARY KEY,
    company_id      TEXT NOT NULL,
    financial_year_id TEXT NOT NULL,
    opening_date      TEXT NOT NULL,
    reference_number  TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'DRAFT',
    total_debit       REAL DEFAULT 0,
    total_credit      REAL DEFAULT 0,
    difference        REAL DEFAULT 0,
    journal_entry_id  TEXT,
    created_by        TEXT,
    updated_by        TEXT,
    posted_by         TEXT,
    finalized_by      TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    finalized_at      DATETIME,
    posted_at         DATETIME,
    -- Ensure one active posting set per company + financial year
    UNIQUE(company_id, financial_year_id, reference_number)
);

CREATE TABLE IF NOT EXISTS opening_balance_lines (
    id                TEXT PRIMARY KEY,
    opening_balance_id TEXT NOT NULL,
    account_id         TEXT NOT NULL,
    debit              REAL DEFAULT 0,
    credit             REAL DEFAULT 0,
    description        TEXT,
    company_id         TEXT NOT NULL,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (opening_balance_id) REFERENCES opening_balances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ob_company_fy ON opening_balances(company_id, financial_year_id);
CREATE INDEX IF NOT EXISTS idx_ob_status ON opening_balances(status);
CREATE INDEX IF NOT EXISTS idx_obl_header ON opening_balance_lines(opening_balance_id);
CREATE INDEX IF NOT EXISTS idx_obl_account ON opening_balance_lines(account_id);
